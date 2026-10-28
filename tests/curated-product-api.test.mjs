// API-level test moved verbatim out of curated-product-workflow.test.mjs (S3.2 WP2c). It still runs the SQLite server and
// fails until WP3 ports create-server and v1-backend-routes to the async PostgreSQL repositories; WP3 owns its port.
// Synthetic documents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createApiServer } from '../src/server/server.js';
import { sha256Hex } from '../src/features/decision-catalogue/index.js';
import { checkerKeyring } from './support/curated-keys.mjs';
import { inProcessPdfText, sourcePdf } from './support/curated-text.mjs';

const bootstrapToken = 'coversaath-curated-test-bootstrap-token-01';
const UIN = 'SYNTHHLIP26001V012526';
const PAGES = [
  `Synthetic Health Plan\nUIN: ${UIN}\nWording version v1`,
  'Pre-existing diseases are covered after a waiting period of 36 months of continuous coverage.',
];
const BYTES = await sourcePdf(PAGES);
const FACT = { factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months: 36 }, page: 2, quote: 'waiting period of 36 months of continuous coverage' };
const base = (over = {}) => ({
  uin: UIN, insurer: 'Synthetic Insurer', productName: 'Synthetic Health Plan', wordingVersion: 'v1', sourceUrl: 'https://insurer.example/wording-v1.pdf',
  sourceVersionId: 'rev-1', retrievedOn: '2026-10-15', bytes: BYTES, pageTexts: PAGES, ...over,
});

function world(t) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-curated-'));
  const database = openDatabase({ path: join(directory, 'app.sqlite') });
  let now = new Date('2026-10-20T10:00:00.000Z');
  const clock = () => now;
  const services = createBackendServices(database, { clock, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, CURATED_SOURCE_HOSTS: 'insurer.example' }, pdfText: inProcessPdfText });
  const adult = name => services.households.createAdult({ displayName: `Synthetic ${name}` }).id;
  const people = { curator: adult('curator'), checker: adult('checker'), second: adult('second checker'), nobody: adult('nobody') };
  const repo = services.curatedProducts;
  const expiry = (days = 30) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const keys = checkerKeyring();
  const grantChecker = adultUserId => repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt: expiry(), publicKey: keys.publicKey(adultUserId) });
  const grants = {
    curator: repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt: expiry() }),
    checker: grantChecker(people.checker),
    second: grantChecker(people.second),
  };
  const signed = (action, adultId, fields, options = {}) => keys.sign(action, adultId, fields, { now, ...options });
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { database, services, repo, people, grants, expiry, keys, grantChecker, signed, now: () => now };
}
const registered = w => w.repo.register({ curatorId: w.people.curator, ...base() });
const candidate = async w => { const r = await registered(w); w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: r.submissionId, facts: [FACT] }); return r.submissionId; };
const factsHash = (w, id) => sha256Hex(w.database.prepare('SELECT facts_json FROM curated_product_submissions WHERE id = ?').get(id).facts_json);

async function startApi(w) {
  const server = createApiServer({ database: w.database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, call };
}

test('api: reads need a live role from the session; there is no check or publish route, whatever the session or body', async t => {
  const w = world(t);
  const api = await startApi(w);
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  // The server runs on the real clock, so its sessions are issued by a service on the real clock too.
  const realAuth = createBackendServices(w.database, { env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } }).auth;
  const token = adultId => realAuth.issueSession({ adultUserId: adultId }).token;
  const id = await candidate(w);
  const path = `/api/v1/curated-products/${id}`;
  assert.equal((await api.call(path)).status, 401);
  assert.equal((await api.call(path, { token: token(w.people.nobody) })).status, 403);
  const checkerToken = token(w.people.checker);
  const view = await api.call(path, { token: checkerToken });
  assert.equal(view.status, 200);
  assert.ok(!('content' in view.data) && !JSON.stringify(view.data).includes('%PDF'), 'bytes are never returned');
  // Approval is operator tooling with a signed action (ADR 0010). Even a valid signed action sent over the API is not applied.
  const signedAction = w.signed('check', w.people.checker, { submissionId: id, decision: 'accept', reasonCode: 'quote_matches_source', observedSha256: sha256Hex(BYTES), factsSha256: factsHash(w, id), quotesReviewed: true });
  for (const suffix of ['check', 'publish']) {
    for (const body of [{}, { signedAction }, { decision: 'accept', reasonCode: 'quote_matches_source', checkerId: w.people.checker }]) {
      const response = await api.call(`${path}/${suffix}`, { method: 'POST', body, token: checkerToken });
      assert.equal(response.status, 404, `${suffix} must not exist`);
      assert.equal(response.data.error.code, 'ROUTE_NOT_FOUND');
    }
  }
  assert.equal(w.repo.get({ adultId: w.people.checker, submissionId: id }).state, 'candidate', 'nothing was approved');
});
