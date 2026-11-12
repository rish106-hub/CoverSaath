import assert from 'node:assert/strict';
import test from 'node:test';
import { createInsuranceDataClient, collectFactPages, familyForFactType, referenceFailureState, ReferenceDataError } from '../src/integrations/index.js';
import { createReferenceDataPort } from '../src/backend/services/reference-data-port.js';
import { createFssStub, FSS_STUB_ENV, FSS_STUB_UIN } from './support/fss-stub.mjs';

// 1a: FSS family coverage, pagination, peek and error mapping. Local stub only, synthetic data.
const clientFor = (stub, env = FSS_STUB_ENV) => createInsuranceDataClient({ env, fetchImpl: stub.fetchImpl });
const facts = async (stub, params = { versionId: 'ver_synth_1' }) => (await clientFor(stub).read('versions.facts', params)).data;
const byType = (data, type) => data.facts.find(fact => fact.factType === type);

test('family map covers waiting periods and exclusions; unknown types have no family', () => {
  assert.equal(familyForFactType('initial_waiting_period'), 'waiting_periods');
  assert.equal(familyForFactType('specific_disease_waiting_period'), 'waiting_periods');
  assert.equal(familyForFactType('excluded_conditions'), 'exclusions');
  assert.equal(familyForFactType('copay'), 'copay');
  assert.equal(familyForFactType('icu_limit'), null);
  assert.equal(familyForFactType('__proto__'), null);
});

test('verified and partial families are usable and keep structured value, reviewer and page hash', async () => {
  const data = await facts(createFssStub());
  const copay = byType(data, 'copay');
  assert.equal(copay.outcome, 'verified');
  assert.equal(copay.family, 'copay');
  assert.equal(copay.value.percentage, 10);
  assert.equal(copay.reviewerId, 'reviewer_synth_1');
  assert.equal(copay.evidence[0].pageSha256, 'b'.repeat(64));
  const waiting = byType(data, 'pre_existing_disease_waiting_period');
  assert.equal(data.coverage.waiting_periods, 'partial');
  assert.equal(waiting.outcome, 'verified');
  assert.deepEqual(waiting.value.duration, { value: 36, unit: 'month' });
  assert.equal(data.nextCursor, 'cur_2');
});

test('conflicted family gives conflicting with no value; withheld family has no facts and unknown coverage', async () => {
  const conflicted = await facts(createFssStub({ facts: ['facts-conflicting'] }));
  const room = byType(conflicted, 'room_rent_limit');
  assert.equal(room.outcome, 'conflicting');
  assert.equal(room.value, null);
  assert.equal(room.valueText, null);
  const withheld = await facts(createFssStub({ facts: ['facts-withheld'] }));
  assert.deepEqual(withheld.facts, []);
  assert.equal(withheld.coverage.copay, 'not_permitted');
});

test('a fact whose family is not usable stays unknown', async () => {
  // exclusions family is awaiting_review in page 1: an excluded_conditions fact would not be usable.
  const stub = createFssStub();
  const data = await facts(stub);
  assert.equal(data.coverage.exclusions, 'awaiting_review');
  assert.equal(data.facts.some(fact => fact.family === 'exclusions' && fact.outcome === 'verified'), false);
});

test('pagination follows cursors and merges, and stops at 5 pages', async () => {
  const stub = createFssStub();
  const client = clientFor(stub);
  const two = await collectFactPages(async cursor => (await client.read('versions.facts', { versionId: 'ver_synth_1', ...(cursor ? { cursor } : {}) })).data);
  assert.equal(two.pages, 2);
  assert.equal(two.truncated, false);
  assert.equal(two.facts.length, 3);

  const endless = createFssStub({ endless: true });
  const eClient = clientFor(endless);
  const capped = await collectFactPages(async cursor => (await eClient.read('versions.facts', { versionId: 'ver_synth_1', ...(cursor ? { cursor } : {}) })).data, { maxPages: 50 });
  assert.equal(capped.pages, 5);
  assert.equal(capped.truncated, true);
  assert.equal(endless.calls.filter(call => call.path.endsWith('/facts')).length, 5);
  await assert.rejects(client.read('versions.facts', { versionId: 'ver_synth_1', cursor: 'bad cursor!' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
});

function memoryRepository() {
  const rows = new Map();
  return {
    rows,
    get: async key => rows.get(key) ?? null,
    put: async ({ key, etag, body, signature }) => { const row = { key, etag, body, signature, fresh: true, fetchedAt: new Date().toISOString() }; rows.set(key, row); return row; },
    remove: async key => { rows.delete(key); },
    markStale: async key => { const row = rows.get(key); if (row) row.fresh = false; },
    acquireLease: async () => true,
    releaseLease: async () => {},
  };
}

test('peek reads the cache only and never calls fetch', async () => {
  const stub = createFssStub();
  const repository = memoryRepository();
  const port = createReferenceDataPort({ repository, client: clientFor(stub), env: FSS_STUB_ENV });
  assert.equal(await port.peekFacts({ versionId: 'ver_synth_1' }), null);
  assert.equal(await port.peek('products.get', { productId: 'prod_synth_1' }), null);
  assert.equal(stub.calls.length, 0);
  await port.getFacts({ versionId: 'ver_synth_1' });
  assert.equal(stub.calls.length, 1);
  const hit = await port.peekFacts({ versionId: 'ver_synth_1' });
  assert.equal(hit.source, 'cache');
  assert.equal(hit.stale, false);
  assert.equal(stub.calls.length, 1);
  // Disabled port: peek is null, still no fetch.
  const off = createReferenceDataPort({ repository, client: clientFor(stub), env: { ...FSS_STUB_ENV, REFERENCE_DATA_ENABLED: 'false' } });
  assert.equal(await off.peekFacts({ versionId: 'ver_synth_1' }), null);
  assert.equal(stub.calls.length, 1);
  // Port getAllFacts pages through the cache.
  const all = await port.getAllFacts({ versionId: 'ver_synth_1' });
  assert.equal(all.data.facts.length, 3);
});

test('each HTTP failure maps to its coded error and leaks neither key nor UIN', async () => {
  const cases = [
    [401, 'REFERENCE_DATA_AUTH_FAILED', 'unauthorized'],
    [403, 'REFERENCE_DATA_AUTH_FAILED', 'unauthorized'],
    [404, 'REFERENCE_DATA_NOT_FOUND', 'no_match'],
    [429, 'REFERENCE_DATA_RATE_LIMITED', 'rate_limited'],
    [500, 'REFERENCE_DATA_UNAVAILABLE', 'unavailable'],
    ['timeout', 'REFERENCE_DATA_UNAVAILABLE', 'unavailable'],
  ];
  for (const [fail, code, state] of cases) {
    const stub = createFssStub({ fail });
    const client = clientFor(stub, { ...FSS_STUB_ENV, REFERENCE_DATA_TIMEOUT_MS: '50' });
    const error = await client.read('products.search', { uin: FSS_STUB_UIN }).then(() => null, e => e);
    assert.ok(error instanceof ReferenceDataError, String(fail));
    assert.equal(error.code, code, String(fail));
    assert.equal(referenceFailureState(error), state);
    const serialised = `${error.message}${error.stack?.split('\n')[0]}${JSON.stringify(error)}`;
    assert.equal(serialised.includes(FSS_STUB_ENV.REFERENCE_DATA_API_KEY), false);
    assert.equal(serialised.includes(FSS_STUB_UIN), false);
    assert.equal(serialised.includes('upstream detail'), false);
  }
});
