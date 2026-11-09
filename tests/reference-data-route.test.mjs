import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { ReferenceCacheRepository } from '../src/backend/repositories/index.js';
import { importReferenceData } from '../src/backend/services/reference-data-import.js';

// GET /api/v1/reference/products: public reference context, import-only mode. Synthetic data only, no network.
const bootstrapToken = 'coversaath-test-bootstrap-token-0021';
const fixture = new URL('../scripts/fixtures/reference-import-synthetic.json', import.meta.url);

async function start(t, { enabled, imported = true }) {
  const { db } = await freshDatabase(t);
  if (imported) {
    await importReferenceData({ database: db, repository: new ReferenceCacheRepository(db), document: JSON.parse(await readFile(fixture, 'utf8')) });
  }
  const env = { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, ...(enabled ? { REFERENCE_DATA_ENABLED: 'true' } : {}) };
  const server = createApiServer({ database: db, env });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const created = await call('/api/v1/households', {
    method: 'POST', token: bootstrapToken,
    body: { displayName: 'Synthetic household', owner: { displayName: 'Synthetic owner', contactEmail: 'synthetic@example.test' } },
  });
  assert.equal(created.status, 201);
  return { db, call, token: created.data.session.token, household: created.data };
}

const PATH = '/api/v1/reference/products';

test('flag off: coded 503 REFERENCE_DATA_NOT_CONFIGURED even with rows imported', postgresTestOptions(), async t => {
  const { call, token } = await start(t, { enabled: false });
  const result = await call(`${PATH}?uin=SYNTHETIC-TEST-ONLY/01`, { token });
  assert.equal(result.status, 503);
  assert.equal(result.data.error.code, 'REFERENCE_DATA_NOT_CONFIGURED');
});

test('enabled with imported synthetic fixture: 200, validated shape, context only, no household data', postgresTestOptions(), async t => {
  const { call, token, household } = await start(t, { enabled: true });
  const result = await call(`${PATH}?uin=synthetic-test-only/01`, { token });
  assert.equal(result.status, 200);
  assert.equal(result.data.referenceContextOnly, true);
  assert.equal(result.data.source, 'cache');
  assert.equal(result.data.ambiguous, false);
  assert.equal(result.data.products.length, 1);
  assert.equal(result.data.products[0].productId, 'prod_example_01');
  assert.equal(result.data.products[0].verificationStatus, 'synthetic_test');
  const text = JSON.stringify(result.data);
  for (const value of [household.household.id, household.owner.id, 'synthetic@example.test', 'Synthetic owner']) assert.ok(!text.includes(value));
});

test('cache miss fails closed with REFERENCE_DATA_NOT_CONFIGURED', postgresTestOptions(), async t => {
  const { call, token } = await start(t, { enabled: true });
  const miss = await call(`${PATH}?uin=SYNTHETIC-NOT-IMPORTED/99`, { token });
  assert.equal(miss.status, 503);
  assert.equal(miss.data.error.code, 'REFERENCE_DATA_NOT_CONFIGURED');
  const empty = await start(t, { enabled: true, imported: false });
  const none = await empty.call(`${PATH}?uin=SYNTHETIC-TEST-ONLY/01`, { token: empty.token });
  assert.equal(none.status, 503);
  assert.equal(none.data.error.code, 'REFERENCE_DATA_NOT_CONFIGURED');
});

test('stale imported row fails closed instead of being served', postgresTestOptions(), async t => {
  const { db, call, token } = await start(t, { enabled: true });
  await db.run("update reference_cache set stale_after = now() - interval '1 hour'", []);
  const result = await call(`${PATH}?uin=SYNTHETIC-TEST-ONLY/01`, { token });
  assert.equal(result.status, 503);
  assert.equal(result.data.error.code, 'REFERENCE_DATA_NOT_CONFIGURED');
});

test('unauthenticated or wrong token is 401', postgresTestOptions(), async t => {
  const { call } = await start(t, { enabled: true });
  assert.equal((await call(`${PATH}?uin=SYNTHETIC-TEST-ONLY/01`)).status, 401);
  assert.equal((await call(`${PATH}?uin=SYNTHETIC-TEST-ONLY/01`, { token: 'not-a-real-token-0000000000' })).status, 401);
});

test('invalid query is 400 REFERENCE_DATA_REQUEST_INVALID', postgresTestOptions(), async t => {
  const { call, token, household } = await start(t, { enabled: true });
  for (const query of ['', '?q=', `?householdId=${household.household.id}`, '?uin=SYNTHETIC-TEST-ONLY/01&limit=500', '?q=a&q=b', '?q=bad%00text', '?insurerId=has%20space']) {
    const result = await call(PATH + query, { token });
    assert.equal(result.status, 400, query);
    assert.equal(result.data.error.code, 'REFERENCE_DATA_REQUEST_INVALID', query);
  }
});

test('write methods are not served', postgresTestOptions(), async t => {
  const { call, token } = await start(t, { enabled: true });
  const result = await call(PATH, { method: 'POST', token, body: { q: 'x' } });
  assert.equal(result.status, 404);
});
