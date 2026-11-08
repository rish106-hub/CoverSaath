import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { ReferenceCacheRepository } from '../src/backend/repositories/reference-cache-repository.js';
import { createReferenceDataPort, cacheKeyFor, signatureFor } from '../src/backend/services/reference-data-port.js';
import { createInsuranceDataClient, REFERENCE_ENDPOINTS } from '../src/integrations/index.js';

// B3: ReferenceDataPort over a local stub. No live call, synthetic data only.
const ENV = { REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_BASE_URL: 'https://reference.example.invalid/api', REFERENCE_DATA_API_KEY: 'test-key-not-real' };
const SHA = 'a'.repeat(64);
const insurer = { id: 'ins_1', canonical_name: 'Example Insurer', aliases: ['Example'], extra: 'dropped' };
const product = { product_id: 'p1', insurer_id: 'ins_1', product_name: 'Example Plan', line_of_business: 'health', uin_raw: 'SYNTHETIC-TEST-ONLY/01', verification_status: 'synthetic_test', data_coverage: null, last_observed_at: null };

const jsonResponse = (body, { status = 200, headers = {} } = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function stub(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: new URL(url), init }); return handler(calls.length, url, init); };
  return { fetchImpl, calls };
}
const clientFor = (fetchImpl, env = ENV) => createInsuranceDataClient({ env, fetchImpl });

test('flag is off unless exactly "true"; no network call is made', async () => {
  for (const value of [undefined, 'TRUE', '1', 'yes', ' true']) {
    const { fetchImpl, calls } = stub(() => jsonResponse({ data: [] }));
    const client = clientFor(fetchImpl, { ...ENV, REFERENCE_DATA_ENABLED: value });
    await assert.rejects(client.read('insurers.search', { q: 'Example' }), { code: 'REFERENCE_DATA_DISABLED' });
    assert.equal(calls.length, 0);
  }
});

test('enabled without a usable https base url or key fails closed', async () => {
  for (const env of [{ ...ENV, REFERENCE_DATA_API_KEY: '' }, { ...ENV, REFERENCE_DATA_BASE_URL: 'http://reference.example.invalid' }, { ...ENV, REFERENCE_DATA_BASE_URL: 'not a url' }]) {
    const { fetchImpl, calls } = stub(() => jsonResponse({ data: [] }));
    await assert.rejects(clientFor(fetchImpl, env).read('insurers.search', { q: 'x' }), { code: 'REFERENCE_DATA_NOT_CONFIGURED' });
    assert.equal(calls.length, 0);
  }
});

test('allow-list excludes customer-mappings and any unknown endpoint', async () => {
  assert.deepEqual(Object.keys(REFERENCE_ENDPOINTS).sort(), ['insurers.resolve', 'insurers.search', 'products.get', 'products.search', 'products.versions', 'versions.facts']);
  const { fetchImpl, calls } = stub(() => jsonResponse({}));
  const client = clientFor(fetchImpl);
  for (const name of ['customer-mappings.resolve', '/v1/customer-mappings/resolve', 'constructor', '__proto__', 'toString']) {
    await assert.rejects(client.read(name, {}), { code: 'REFERENCE_DATA_ENDPOINT_NOT_ALLOWED' });
  }
  assert.equal(calls.length, 0);
});

test('outbound request carries only an alias, UIN or opaque id, GET, bearer, no body', async () => {
  const { fetchImpl, calls } = stub(() => jsonResponse({ data: [product] }));
  const client = clientFor(fetchImpl);
  await client.read('products.search', { uin: '  synthetic-test-only/01 ' });
  const [{ url, init }] = calls;
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
  assert.equal(url.origin, 'https://reference.example.invalid');
  assert.equal(url.pathname, '/api/v1/products');
  assert.equal(url.searchParams.get('uin'), 'SYNTHETIC-TEST-ONLY/01');
  assert.deepEqual([...url.searchParams.keys()].sort(), ['limit', 'uin']);
  assert.equal(init.redirect, 'error');
  // Household-shaped or unknown parameters are rejected before any request.
  for (const params of [{ uin: 'SYNTHETIC-TEST-ONLY/01', householdId: 'hh_1' }, { policyNumber: 'P123' }, { uin: 'x\u0000y' }, {}, { insurerId: '../etc' }]) {
    await assert.rejects(client.read('products.search', params), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  }
  await assert.rejects(client.read('versions.facts', { versionId: 'v1', factType: 'Bad Type' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  assert.equal(calls.length, 1);
});

test('responses are validated strictly: extras dropped, unknown enum or missing field fails closed', async () => {
  const ok = await clientFor(stub(() => jsonResponse({ data: [insurer] })).fetchImpl).read('insurers.search', { q: 'Example' });
  assert.deepEqual(ok.data.data[0], { id: 'ins_1', canonicalName: 'Example Insurer', aliases: ['Example'] });
  const cases = [
    ['products.get', { productId: 'p1' }, { ...product, verification_status: 'totally_verified' }],
    ['products.get', { productId: 'p1' }, { ...product, uin_raw: undefined }],
    ['products.get', { productId: 'p1' }, { ...product, product_name: 'x'.repeat(501) }],
    ['insurers.search', { q: 'a' }, { data: 'nope' }],
    ['insurers.search', { q: 'a' }, [1]],
    ['products.versions', { productId: 'p1' }, { data: [{ version_id: 'v', product_id: 'p1', wording_version: 'w', version_status: 's', freshness: 'fresh-ish' }] }],
  ];
  for (const [endpoint, params, body] of cases) {
    await assert.rejects(clientFor(stub(() => jsonResponse(body)).fetchImpl).read(endpoint, params), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  }
  await assert.rejects(clientFor(stub(() => new Response('<html>', { status: 200 })).fetchImpl).read('insurers.search', { q: 'a' }), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

test('insurer resolve never picks between ambiguous or unmatched; multi-match product search is ambiguous', async () => {
  const resolve = body => clientFor(stub(() => jsonResponse(body)).fetchImpl).read('insurers.resolve', { q: 'Example' });
  assert.deepEqual((await resolve({ status: 'ambiguous', insurer: insurer, candidates: [insurer, insurer] })).data, { status: 'ambiguous', insurer: null });
  assert.deepEqual((await resolve({ status: 'unmatched', insurer: null, candidates: [] })).data, { status: 'unmatched', insurer: null });
  assert.equal((await resolve({ status: 'resolved', insurer })).data.insurer.id, 'ins_1');
  const search = await clientFor(stub(() => jsonResponse({ data: [product, { ...product, product_id: 'p2' }] })).fetchImpl).read('products.search', { uin: 'SYNTHETIC-TEST-ONLY/01' });
  assert.equal(search.data.ambiguous, true);
});

test('facts: only independently verified, non-synthetic, evidenced, verified-family facts keep a value', async () => {
  const fact = (id, over = {}) => ({ fact_id: id, fact_type: 'copay', value: { text: 'ten percent' }, verification_status: 'independently_verified', evidence: [{ document_id: 'd1', page_number: 2, sha256: SHA }], ...over });
  const body = (over = {}, coverage = { copay: 'verified' }, facts = [fact('f1')]) => ({ version_id: 'v1', uin_raw: 'U', wording_version: 'w1', version_synthetic: false, coverage, facts, ...over });
  const run = payload => clientFor(stub(() => jsonResponse(payload)).fetchImpl).read('versions.facts', { versionId: 'v1' }).then(r => r.data.facts[0]);
  assert.deepEqual(await run(body()), { ...(await run(body())), outcome: 'verified', valueText: 'ten percent' });
  assert.equal((await run(body({ version_synthetic: true }))).outcome, 'unknown');
  assert.equal((await run(body({}, { copay: 'partial' }))).outcome, 'unknown');
  assert.equal((await run(body({}, { copay: 'conflicting_evidence' }))).outcome, 'conflicting');
  assert.equal((await run(body({}, { copay: 'verified' }, [fact('f1', { verification_status: 'candidate' })]))).outcome, 'unknown');
  assert.equal((await run(body({}, { copay: 'verified' }, [fact('f1', { evidence: [] })]))).outcome, 'unknown');
  const unusable = await run(body({}, { copay: 'awaiting_review' }));
  assert.equal(unusable.valueText, null);
  await assert.rejects(run(body({}, { copay: 'verified' }, [fact('f1', { evidence: [{ document_id: 'd', page_number: 1, sha256: 'zz' }] })])), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  await assert.rejects(run(body({}, { copay: 'maybe' })), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

test('status codes map to coded client-safe errors; no upstream text leaks', async () => {
  const run = (status, headers) => clientFor(stub(() => new Response('upstream secret detail', { status, headers })).fetchImpl).read('insurers.search', { q: 'a' });
  await assert.rejects(run(401), error => error.code === 'REFERENCE_DATA_AUTH_FAILED' && !error.message.includes('secret'));
  await assert.rejects(run(403), { code: 'REFERENCE_DATA_AUTH_FAILED' });
  await assert.rejects(run(404), { code: 'REFERENCE_DATA_NOT_FOUND' });
  await assert.rejects(run(429, { 'retry-after': '7' }), error => error.code === 'REFERENCE_DATA_RATE_LIMITED' && error.retryAfterMs === 7000);
  await assert.rejects(run(503), { code: 'REFERENCE_DATA_UNAVAILABLE' });
});

test('oversized response and timeout are bounded', async () => {
  const big = clientFor(stub(() => new Response(JSON.stringify({ data: [], pad: 'x'.repeat(5000) }))).fetchImpl, { ...ENV, REFERENCE_DATA_MAX_RESPONSE_BYTES: '1024' });
  await assert.rejects(big.read('insurers.search', { q: 'a' }), { code: 'REFERENCE_DATA_RESPONSE_TOO_LARGE' });
  const hang = clientFor((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))), { ...ENV, REFERENCE_DATA_TIMEOUT_MS: '100' });
  await assert.rejects(hang.read('insurers.search', { q: 'a' }), { code: 'REFERENCE_DATA_UNAVAILABLE' });
});

test('circuit opens after repeated outages and stops calling the service', async () => {
  let clock = 1_000_000;
  const { fetchImpl, calls } = stub(() => new Response('', { status: 503 }));
  const client = createInsuranceDataClient({ env: ENV, fetchImpl, now: () => clock });
  for (let i = 0; i < 3; i += 1) await assert.rejects(client.read('insurers.search', { q: 'a' }), { code: 'REFERENCE_DATA_UNAVAILABLE' });
  await assert.rejects(client.read('insurers.search', { q: 'a' }), { code: 'REFERENCE_DATA_UNAVAILABLE' });
  assert.equal(calls.length, 3);
  clock += 31_000;
  await assert.rejects(client.read('insurers.search', { q: 'a' }), { code: 'REFERENCE_DATA_UNAVAILABLE' });
  assert.equal(calls.length, 4);
});

test('port: disabled flag short-circuits before cache and client', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const { fetchImpl, calls } = stub(() => jsonResponse({ data: [] }));
  const port = createReferenceDataPort({ repository: new ReferenceCacheRepository(db), client: clientFor(fetchImpl), env: { ...ENV, REFERENCE_DATA_ENABLED: 'false' } });
  await assert.rejects(port.searchInsurers({ q: 'a' }), { code: 'REFERENCE_DATA_DISABLED' });
  assert.equal(calls.length, 0);
});

test('port: miss fetches and caches, fresh hit does not call the service, params are hashed in the key', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db);
  const { fetchImpl, calls } = stub(() => jsonResponse({ data: [insurer] }, { headers: { etag: '"e1"' } }));
  const port = createReferenceDataPort({ repository, client: clientFor(fetchImpl), env: ENV });
  const first = await port.searchInsurers({ q: 'Example' });
  assert.equal(first.source, 'service');
  assert.equal(first.stale, false);
  assert.equal(first.referenceContextOnly, true);
  const second = await port.searchInsurers({ q: 'Example' });
  assert.equal(second.source, 'cache');
  assert.equal(second.stale, false);
  assert.deepEqual(second.data, first.data);
  assert.equal(calls.length, 1);
  const key = cacheKeyFor('insurers.search', { q: 'Example' });
  const row = await repository.get(key);
  assert.equal(row.etag, '"e1"');
  assert.ok(!key.includes('example'), 'cache key must not carry the query text');
  assert.equal(await db.one('SELECT count(*)::int AS n FROM reference_cache_leases').then(r => r.n), 0);
});

test('port: service down serves cached body labelled stale; no cache means a coded error, never fabricated data', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db, { ttlMs: 1 });
  let down = false;
  const { fetchImpl } = stub(() => (down ? new Response('', { status: 503 }) : jsonResponse({ data: [insurer] })));
  const port = createReferenceDataPort({ repository, client: clientFor(fetchImpl), env: ENV });
  await port.searchInsurers({ q: 'Example' });
  await new Promise(resolve => setTimeout(resolve, 20));
  down = true;
  const stale = await port.searchInsurers({ q: 'Example' });
  assert.equal(stale.stale, true);
  assert.equal(stale.source, 'cache');
  assert.equal(stale.data.data[0].id, 'ins_1');
  assert.equal((await repository.get(cacheKeyFor('insurers.search', { q: 'Example' }))).status, 'stale');
  await assert.rejects(port.searchInsurers({ q: 'Other' }), { code: 'REFERENCE_DATA_UNAVAILABLE' });
});

test('port: lease prevents a stampede and a concurrent caller gets stale cache or an error', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db);
  const { fetchImpl, calls } = stub(() => jsonResponse({ data: [insurer] }));
  const port = createReferenceDataPort({ repository, client: clientFor(fetchImpl), env: ENV });
  const key = cacheKeyFor('insurers.search', { q: 'Example' });
  assert.equal(await repository.acquireLease({ key, owner: 'other-process-aaaaaaaa' }), true);
  await assert.rejects(port.searchInsurers({ q: 'Example' }), { code: 'REFERENCE_DATA_UNAVAILABLE' });
  assert.equal(calls.length, 0);
  const body = { data: [{ id: 'old', canonicalName: 'Old', aliases: [] }] };
  await repository.put({ key, body, signature: signatureFor(body), ttlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  const result = await port.searchInsurers({ q: 'Example' });
  assert.equal(result.stale, true);
  assert.equal(calls.length, 0);
});

test('port: a cached row with a bad signature is dropped and refetched', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db);
  const { fetchImpl, calls } = stub(() => jsonResponse({ data: [insurer] }));
  const port = createReferenceDataPort({ repository, client: clientFor(fetchImpl), env: ENV });
  await repository.put({ key: cacheKeyFor('insurers.search', { q: 'Example' }), body: { data: [{ id: 'forged' }] }, signature: 'not-the-digest' });
  const result = await port.searchInsurers({ q: 'Example' });
  assert.equal(result.source, 'service');
  assert.equal(result.data.data[0].id, 'ins_1');
  assert.equal(calls.length, 1);
});

test('port: not found drops the cache entry and surfaces REFERENCE_DATA_NOT_FOUND', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db);
  const port = createReferenceDataPort({ repository, client: clientFor(stub(() => new Response('', { status: 404 })).fetchImpl), env: ENV });
  await assert.rejects(port.getProduct({ productId: 'p9' }), { code: 'REFERENCE_DATA_NOT_FOUND' });
  assert.equal(await repository.get(cacheKeyFor('products.get', { productId: 'p9' })), null);
});

test('port exposes no customer-mapping method and rejects household-shaped input', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const { fetchImpl, calls } = stub(() => jsonResponse({ data: [] }));
  const port = createReferenceDataPort({ repository: new ReferenceCacheRepository(db), client: clientFor(fetchImpl), env: ENV });
  assert.equal(Object.keys(port).some(name => /mapping|schedule|customer|household/i.test(name)), false);
  await assert.rejects(port.searchProducts({ uin: 'SYNTHETIC-TEST-ONLY/01', householdId: 'hh_1' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  assert.equal(calls.length, 0);
});
