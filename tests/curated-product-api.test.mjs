// API-level test moved out of curated-product-workflow.test.mjs (S3.2 WP2c). Runs on PostgreSQL (S3.2).
// Synthetic documents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
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

async function world(t) {
  const { db: database } = await freshDatabase(t);
  let now = new Date('2026-10-20T10:00:00.000Z');
  const clock = () => now;
  const services = createBackendServices(database, { clock, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, CURATED_SOURCE_HOSTS: 'insurer.example' }, pdfText: inProcessPdfText });
  const adult = async name => (await services.households.createAdult({ displayName: `Synthetic ${name}` })).id;
  const people = { curator: await adult('curator'), checker: await adult('checker'), second: await adult('second checker'), nobody: await adult('nobody') };
  const repo = services.curatedProducts;
  const expiry = (days = 30) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const keys = checkerKeyring();
  const grantChecker = adultUserId => repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt: expiry(), publicKey: keys.publicKey(adultUserId) });
  const grants = {
    curator: await repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt: expiry() }),
    checker: await grantChecker(people.checker),
    second: await grantChecker(people.second),
  };
  const signed = (action, adultId, fields, options = {}) => keys.sign(action, adultId, fields, { now, ...options });
  return { database, services, repo, people, grants, expiry, keys, grantChecker, signed, now: () => now };
}
const registered = w => w.repo.register({ curatorId: w.people.curator, ...base() });
const candidate = async w => { const r = await registered(w); await w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: r.submissionId, facts: [FACT] }); return r.submissionId; };
const factsHash = async (w, id) => sha256Hex((await w.database.prepare('SELECT facts_json FROM curated_product_submissions WHERE id = ?').get(id)).facts_json);

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

test('api: reads need a live role from the session; there is no check or publish route, whatever the session or body', postgresTestOptions(), async t => {
  const w = await world(t);
  const api = await startApi(w);
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  // The server runs on the real clock, so its sessions are issued by a service on the real clock too.
  const realAuth = createBackendServices(w.database, { env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } }).auth;
  const token = async adultId => (await realAuth.issueSession({ adultUserId: adultId })).token;
  const id = await candidate(w);
  const path = `/api/v1/curated-products/${id}`;
  assert.equal((await api.call(path)).status, 401);
  assert.equal((await api.call(path, { token: await token(w.people.nobody) })).status, 403);
  const checkerToken = await token(w.people.checker);
  const view = await api.call(path, { token: checkerToken });
  assert.equal(view.status, 200);
  assert.ok(!('content' in view.data) && !JSON.stringify(view.data).includes('%PDF'), 'bytes are never returned');
  // Approval is operator tooling with a signed action (ADR 0010). Even a valid signed action sent over the API is not applied.
  const signedAction = w.signed('check', w.people.checker, { submissionId: id, decision: 'accept', reasonCode: 'quote_matches_source', observedSha256: sha256Hex(BYTES), factsSha256: await factsHash(w, id), quotesReviewed: true });
  for (const suffix of ['check', 'publish']) {
    for (const body of [{}, { signedAction }, { decision: 'accept', reasonCode: 'quote_matches_source', checkerId: w.people.checker }]) {
      const response = await api.call(`${path}/${suffix}`, { method: 'POST', body, token: checkerToken });
      assert.equal(response.status, 404, `${suffix} must not exist`);
      assert.equal(response.data.error.code, 'ROUTE_NOT_FOUND');
    }
  }
  assert.equal((await w.repo.get({ adultId: w.people.checker, submissionId: id })).state, 'candidate', 'nothing was approved');
});
