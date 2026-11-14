import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture, bootstrapToken } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { exportCacheKey, referenceImportDedupeKey, chunkExport, REGISTRY_CACHE_KEY } from '../src/backend/services/holding-product-service.js';
import { createReferenceImportHandler, createDetectInsurerHandler } from '../src/backend/jobs/holding-product-handlers.js';
import { buildJobHandlers } from '../src/server/worker.js';
import { createInsuranceDataClient, REFERENCE_ENDPOINTS, SERVICE_ENDPOINTS } from '../src/integrations/index.js';
import { detectInsurerCandidates } from '../src/features/insurer-detection/index.js';

// S-A3: detection, confirm-product, reference import. Everything is invented ("Acme Health"); no real insurer text, no live call.
const opts = postgresTestOptions();
const UIN = 'ACMHLIP25001V012526';
const SHA = 'b'.repeat(64);

const registry = {
  insurers: [{ id: 'ins-acme', canonicalName: 'Acme Health Insurance Company Limited', aliases: ['Acme Health'] }, { id: 'ins-zen', canonicalName: 'Zenith General Insurance', aliases: [] }],
  products: [
    { productId: 'prod-shield', insurerId: 'ins-acme', productName: 'Acme Health Shield Plus', uinRaw: UIN },
    { productId: 'prod-basic', insurerId: 'ins-acme', productName: 'Acme Health Basic Care', uinRaw: 'ACMHLIP25002V012526' },
    { productId: 'prod-zen', insurerId: 'ins-zen', productName: 'Zenith Family Cover', uinRaw: 'ZENHLIP25003V012526' },
  ],
};
const BROCHURE = 'ACME HEALTH INSURANCE COMPANY LIMITED\nShield Plus Policy Schedule\nRoom rent limit applies as per the policy wording.';

// ---- detection (pure) ---------------------------------------------------------------------------------------------------------

test('detection: the seeded product is top-1 for its own brochure; at most three; no UIN in a result', () => {
  const found = detectInsurerCandidates({ text: BROCHURE, registry });
  assert.equal(found[0].candidateId, 'prod-shield');
  assert.equal(found[0].rank, 1);
  assert.ok(found.length <= 3);
  for (const item of found) {
    assert.deepEqual(Object.keys(item).sort(), ['candidateId', 'insurerName', 'productName', 'rank']);
    assert.equal(JSON.stringify(item).includes('ACMHLIP'), false);
  }
});

test('detection: tolerates an OCR slip, uses a printed UIN, and finds nothing in unrelated text', () => {
  assert.equal(detectInsurerCandidates({ text: 'Acme Helth Insurance   Sheild Plus', registry })[0]?.candidateId, 'prod-shield');
  assert.equal(detectInsurerCandidates({ text: `Product UIN: ${UIN}`, registry })[0]?.candidateId, 'prod-shield');
  assert.deepEqual(detectInsurerCandidates({ text: 'Quarterly gardening newsletter about tomatoes', registry }), []);
  assert.deepEqual(detectInsurerCandidates({ text: '', registry }), []);
  assert.deepEqual(detectInsurerCandidates({ text: BROCHURE, registry: { insurers: [], products: [] } }), []);
});

// ---- client ---------------------------------------------------------------------------------------------------------------------

const ENV = { REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_BASE_URL: 'https://reference.example.invalid', REFERENCE_DATA_API_KEY: 'test-key-not-real' };
const json = (body, init = {}) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...init.headers } });

test('client: service endpoints are separate from the import allow-list, and reject OCR-sized or malformed input', async () => {
  for (const name of Object.keys(SERVICE_ENDPOINTS)) assert.equal(Object.hasOwn(REFERENCE_ENDPOINTS, name), false);
  const calls = [];
  const client = createInsuranceDataClient({ env: ENV, fetchImpl: async url => { calls.push(new URL(url)); return json({ data: [] }); } });
  await assert.rejects(client.read('products.nameSearch', { q: 'x'.repeat(81) }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  await assert.rejects(client.read('products.nameSearch', { q: 'one two three four five six seven eight nine' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  await assert.rejects(client.read('registry.products', { cursor: '../x' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  await assert.rejects(client.read('products.exportByUin', { uin: 'bad uin!' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  assert.equal(calls.length, 0);
  await client.read('products.nameSearch', { q: 'Shield Plus', insurer: 'Acme' });
  assert.equal(calls[0].pathname, '/v1/products/search');
  assert.deepEqual([...calls[0].searchParams.keys()].sort(), ['insurer', 'limit', 'q']);
});

test('client: export is validated strictly (bad hash, too many pages) and keeps the ETag', async () => {
  const page = { page_number: 1, text: 'Wording', content_sha256: SHA, parser_version: 'p1', extraction_status: 'extracted', tables_json: [] };
  const good = { export_version: SHA, product: { product_id: 'p', product_name: 'Acme Plan', insurer_id: 'i', insurer_name: 'Acme', line_of_business: 'health' }, documents: [{ document_id: 'd', version_id: 'v', wording_version: 'w', sha256: SHA, media_type: 'application/pdf', source_observed_at: '2026-01-01T00:00:00.000Z', synthetic: true, source_pages: [page] }] };
  const read = body => createInsuranceDataClient({ env: ENV, fetchImpl: async () => json(body, { headers: { etag: '"abc"' } }) }).read('products.exportByUin', { uin: UIN });
  const ok = await read(good);
  assert.equal(ok.etag, '"abc"');
  assert.equal(ok.data.documents[0].sourcePages[0].pageNumber, 1);
  await assert.rejects(read({ ...good, export_version: 'nothex' }), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  await assert.rejects(read({ ...good, documents: [{ ...good.documents[0], source_pages: [{ ...page, page_number: 0 }] }] }), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

test('queue keys: dedupe key is sha256 hex within 128 chars; chunks are deterministic', () => {
  const key = referenceImportDedupeKey({ scope: 'product', identifier: 'ppro-1', version: '1' });
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, referenceImportDedupeKey({ scope: 'product', identifier: 'ppro-1', version: '1' }));
  assert.notEqual(key, referenceImportDedupeKey({ scope: 'product', identifier: 'ppro-1', version: '2' }));
  assert.match(exportCacheKey(UIN), /^products\.exportbyuin\/[a-f0-9]{40}$/);
  const pages = [{ documentId: 'd', sourcePages: [{ pageNumber: 1, text: `${'a'.repeat(1000)}\n\n${'b'.repeat(1000)}` }] }];
  assert.deepEqual(chunkExport(pages), chunkExport(pages));
  assert.equal(chunkExport(pages).length, 2);
});

// ---- end to end over a local reference stub ----------------------------------------------------------------------------------

function referenceStub() {
  const requests = [];
  const exportBody = {
    export_version: SHA,
    product: { product_id: 'prod-shield', product_name: 'Acme Health Shield Plus', insurer_id: 'ins-acme', insurer_name: 'Acme Health Insurance Company Limited', line_of_business: 'health' },
    documents: [{ document_id: 'doc-1', version_id: 'ver-1', wording_version: 'SYN-v1', sha256: SHA, media_type: 'application/pdf', source_observed_at: '2026-01-01T00:00:00.000Z', synthetic: true,
      source_pages: [{ page_number: 1, text: 'Room rent is limited to one percent of the sum insured.\n\nWaiting period is 24 months.', content_sha256: SHA, parser_version: 'p1', extraction_status: 'extracted', tables_json: [[['Benefit', 'Limit']]] }] }],
  };
  const productRow = p => ({ product_id: p.productId, insurer_id: p.insurerId, product_name: p.productName, line_of_business: 'health', uin_raw: p.uinRaw, verification_status: 'synthetic_test' });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', etag: '"stub-etag"' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/v1/insurers') return send({ data: registry.insurers.map(i => ({ id: i.id, canonical_name: i.canonicalName, aliases: i.aliases })), next_cursor: null });
    if (url.pathname === '/v1/products' && url.searchParams.get('cursor') === null) return send({ data: registry.products.slice(0, 2).map(productRow), next_cursor: 'cGFnZTI' });
    if (url.pathname === '/v1/products') return send({ data: registry.products.slice(2).map(productRow), next_cursor: null });
    if (url.pathname === '/v1/products/search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      return send({ data: registry.products.filter(p => p.productName.toLowerCase().includes(q)).map(p => ({ product_id: p.productId, product_name: p.productName, insurer_id: p.insurerId, insurer_name: registry.insurers.find(i => i.id === p.insurerId).canonicalName, line_of_business: 'health', uin_raw: p.uinRaw })) });
    }
    const byId = /^\/v1\/products\/([^/]+)$/.exec(url.pathname);
    if (byId) { const p = registry.products.find(item => item.productId === byId[1]); return p ? send(productRow(p)) : send({ error: { code: 'not_found' } }, 404); }
    if (url.pathname === `/v1/products/by-uin/${UIN}/export`) return send(exportBody);
    return send({ error: { code: 'not_found' } }, 404);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

async function world(t, extraEnv = {}) {
  const stub = await referenceStub();
  t.after(() => new Promise(resolve => stub.server.close(resolve)));
  fixture.pages = [BROCHURE.split('\n').map(text => ({ text, tag: 'paragraph' })), [{ text: 'Schedule of benefits', tag: 'paragraph' }]];
  const env = {
    HOLDINGS_ENABLED: 'true', POLICY_FACTS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true',
    REFERENCE_DATA_BASE_URL: `http://127.0.0.1:${stub.port}`, REFERENCE_DATA_API_KEY: 'test-key-not-real', ...extraEnv,
  };
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'Holding' });
  const holdingId = `hold-${randomUUID()}`;
  const at = new Date().toISOString();
  // OCR completion already made this document's holding and detect job (HOLDINGS_ENABLED); the test seeds its own.
  await app.database.run("DELETE FROM job_queue WHERE kind = 'holding.detect_insurer'");
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run('INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [holdingId, s.householdId, s.documentId, 'retail_health', 'uploaded', at, at]);
  const services = createBackendServices(app.database, { env });
  return { app, s, holdingId, stub, services, env };
}
const noUin = body => { const text = JSON.stringify(body); return !/"uin/i.test(text) && !text.includes('ACMHLIP'); };

test('flow: registry import, candidates, confirm-product, reference import (UIN never in a response)', opts, async t => {
  const { app, s, holdingId, stub, services, env } = await world(t);
  const url = tail => `/api/v1/holdings/${holdingId}/${tail}`;

  // Before the registry exists the candidates read asks again later and queues the refresh.
  const early = await app.call(url('product-candidates'), { token: s.token });
  assert.equal(early.status, 503);
  assert.equal(early.data.error.code, 'HOLDING_REGISTRY_UNAVAILABLE');
  const queued = await app.database.one("SELECT kind, payload_json, dedupe_key, household_id FROM job_queue WHERE kind = 'reference.import'");
  assert.equal(queued.payload_json, '{"scope":"registry"}');
  assert.match(queued.dedupe_key, /^[a-f0-9]{64}$/);

  // The queued job runs through the registered handler: registry paged (two product pages), stored once, idempotent.
  const handlers = buildJobHandlers(services, env);
  assert.deepEqual(Object.keys(handlers).sort(), ['holding.collate', 'holding.create', 'holding.detect_insurer', 'holding.fetch_reference', 'holding.memorise', 'holding.parse_own_pdf', 'policy_facts.extract', 'reference.import']);
  await handlers['reference.import']({ job: { kind: 'reference.import', householdId: s.householdId, payload: { scope: 'registry' } } });
  await handlers['reference.import']({ job: { kind: 'reference.import', householdId: s.householdId, payload: { scope: 'registry' } } });
  const registryRow = await app.database.one('SELECT body FROM reference_cache WHERE key = ?', [REGISTRY_CACHE_KEY]);
  assert.equal(registryRow.body.products.length, 3);
  assert.ok(stub.requests.some(line => line.includes('cursor=cGFnZTI')));

  const read = await app.call(url('product-candidates'), { token: s.token });
  assert.equal(read.status, 200);
  assert.equal(read.data.candidates[0].candidateId, 'prod-shield');
  assert.ok(read.data.candidates.length <= 3);
  assert.equal(noUin(read.data), true);
  assert.equal((await app.database.one('SELECT status FROM policy_holdings WHERE id = ?', [holdingId])).status, 'insurer_pending');

  // Confirm: needs a key and a body of exactly candidateId + expectedVersion.
  const body = { candidateId: 'prod-shield', expectedVersion: read.data.profileVersion };
  const key = `confirm-${randomUUID()}`;
  assert.equal((await app.call(url('confirm-product'), { method: 'POST', token: s.token, body })).data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  for (const bad of [{ ...body, uin: UIN }, { candidateId: 'prod-shield' }, { candidateId: '../x', expectedVersion: 0 }, []]) {
    const refused = await app.call(url('confirm-product'), { method: 'POST', token: s.token, body: bad, headers: { 'Idempotency-Key': key } });
    assert.equal(refused.status, 400, JSON.stringify(bad));
  }
  assert.equal((await app.call(url('confirm-product'), { method: 'POST', token: s.token, body: { candidateId: 'no-such-product', expectedVersion: 0 }, headers: { 'Idempotency-Key': key } })).data.error.code, 'HOLDING_PRODUCT_NOT_FOUND');
  const confirmed = await app.call(url('confirm-product'), { method: 'POST', token: s.token, body, headers: { 'Idempotency-Key': key } });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(confirmed.data, { holdingId, status: 'product_reported', profileVersion: 1, replay: false });
  assert.equal(noUin(confirmed.data), true);
  // A retry with the same key and body replays and queues nothing new.
  const replay = await app.call(url('confirm-product'), { method: 'POST', token: s.token, body, headers: { 'Idempotency-Key': key } });
  assert.equal(replay.data.replay, true);
  assert.equal(noUin(replay.data), true);

  // The statement is the owner's own: reported, in policy_profiles only (names sealed), and the holding is linked.
  const profile = await app.database.one('SELECT * FROM policy_profiles WHERE household_id = ?', [s.householdId]);
  assert.equal(profile.uin, UIN);
  assert.deepEqual([profile.uin_state, profile.insurer_state, profile.policy_name_state, profile.confirmation_source], ['reported', 'reported', 'reported', 'user_statement']);
  assert.match(profile.policy_name_enc, /^enc2\./);
  const holding = await app.database.one('SELECT status, policy_profile_id FROM policy_holdings WHERE id = ?', [holdingId]);
  assert.deepEqual({ ...holding }, { status: 'product_reported', policy_profile_id: profile.id });
  const holdingColumns = (await app.database.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'policy_holdings'")).map(row => row.column_name);
  assert.equal(holdingColumns.some(name => /uin|insurer|plan|policy_number/.test(name)), false);

  // The queued reference import carries identifiers only, once.
  const jobs = await app.database.many("SELECT payload_json, dedupe_key, document_id FROM job_queue WHERE kind = 'reference.import' AND payload_json LIKE '%product%'");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].payload_json, JSON.stringify({ policyProfileId: profile.id, scope: 'product' }));
  assert.equal(jobs[0].payload_json.includes('ACMHLIP'), false);
  assert.match(jobs[0].dedupe_key, /^[a-f0-9]{64}$/);

  const importJob = { kind: 'reference.import', householdId: s.householdId, payload: { scope: 'product', policyProfileId: profile.id } };
  await handlers['reference.import']({ job: importJob });
  const cached = await app.database.one('SELECT * FROM reference_cache WHERE key = ?', [exportCacheKey(UIN)]);
  assert.equal(cached.etag, '"stub-etag"');
  assert.equal(cached.body.exportVersion, SHA);
  assert.ok(cached.body.chunks.length >= 1);
  assert.equal(cached.body.chunks[0].documentId, 'doc-1');
  assert.deepEqual(Object.keys(cached.body.documents[0].pages[0]).includes('text'), false);
  const cacheColumns = (await app.database.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'reference_cache'")).map(row => row.column_name);
  assert.equal(cacheColumns.some(name => /household|case|member|adult/.test(name)), false);
  // Running it again is a no-op while the copy is fresh: no second export fetch.
  const fetchesBefore = stub.requests.filter(line => line.includes('/export')).length;
  await handlers['reference.import']({ job: importJob });
  assert.equal(stub.requests.filter(line => line.includes('/export')).length, fetchesBefore);
  // A job for a profile of another household finds no UIN and writes nothing.
  await handlers['reference.import']({ job: { ...importJob, householdId: 'hh-other' } });
  assert.equal(Number((await app.database.one('SELECT count(*) AS n FROM reference_cache')).n), 2);
});

test('product search: name fragment against the cached registry, candidate shape, no UIN, no outbound call, validated', opts, async t => {
  const { app, s, holdingId, stub, services, env } = await world(t);
  const url = q => `/api/v1/holdings/${holdingId}/product-search?q=${encodeURIComponent(q)}`;
  const early = await app.call(url('shield'), { token: s.token });
  assert.equal(early.data.error.code, 'HOLDING_REGISTRY_UNAVAILABLE');
  await buildJobHandlers(services, env)['reference.import']({ job: { kind: 'reference.import', householdId: s.householdId, payload: { scope: 'registry' } } });
  const before = stub.requests.length;
  const hit = await app.call(url('  Shield   PLUS '), { token: s.token });
  assert.equal(hit.status, 200, hit.text);
  assert.equal(hit.data.candidates[0].candidateId, 'prod-shield');
  assert.deepEqual(Object.keys(hit.data.candidates[0]).sort(), ['candidateId', 'insurerName', 'productName', 'rank']);
  assert.equal(noUin(hit.data), true);
  assert.equal(stub.requests.length, before, 'search reads the cache only');
  // Insurer name words narrow too; a word in neither name finds nothing.
  assert.ok((await app.call(url('acme shield'), { token: s.token })).data.candidates.length >= 1);
  assert.deepEqual((await app.call(url('zebra'), { token: s.token })).data.candidates, []);
  for (const bad of ['a', 'x'.repeat(81), 'one two three four five six seven eight nine']) {
    const refused = await app.call(url(bad), { token: s.token });
    assert.deepEqual([refused.status, refused.data.error.code], [400, 'HOLDING_PRODUCT_SEARCH_INVALID']);
  }
  // A search hit is a valid pick for confirm-product.
  const confirmed = await app.call(`/api/v1/holdings/${holdingId}/confirm-product`, { method: 'POST', token: s.token, body: { candidateId: hit.data.candidates[0].candidateId, expectedVersion: 0 }, headers: { 'Idempotency-Key': `confirm-${randomUUID()}` } });
  assert.equal(confirmed.status, 200, confirmed.text);
  // Ownership: another household gets the same 404.
  const foreign = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Foreign household', owner: { displayName: 'Other Synthetic' } } });
  const other = await app.call(url('shield'), { token: foreign.data.session.token });
  assert.deepEqual([other.status, other.data.error.code], [404, 'HOLDING_NOT_FOUND']);
});

test('detect-insurer job: moves the status only, stores no candidate, ends quietly when the text is unreadable', opts, async t => {
  const { app, s, holdingId, services } = await world(t);
  await services.holdingProducts.importRegistry();
  const handler = createDetectInsurerHandler({ service: services.holdingProducts });
  await handler({ job: { kind: 'holding.detect_insurer', householdId: s.householdId, documentId: s.documentId, payload: { holdingId } } });
  assert.equal((await app.database.one('SELECT status FROM policy_holdings WHERE id = ?', [holdingId])).status, 'insurer_pending');
  await assert.rejects(handler({ job: { kind: 'holding.detect_insurer', householdId: s.householdId, payload: {} } }), { code: 'JOB_PAYLOAD_INVALID', retryable: false });
  await assert.rejects(createReferenceImportHandler({ service: services.holdingProducts })({ job: { kind: 'reference.import', householdId: s.householdId, payload: { scope: 'other' } } }), { code: 'JOB_PAYLOAD_INVALID' });
});

test('holdings routes: foreign household and non-owner get the same 404; flag off is 503; no session is 401', opts, async t => {
  const { app, s, holdingId } = await world(t);
  const call = (path, init) => app.call(path, init);
  assert.equal((await call(`/api/v1/holdings/${holdingId}/product-candidates`)).status, 401);
  const foreign = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Foreign household', owner: { displayName: 'Other Synthetic' } } });
  for (const token of [foreign.data.session.token]) {
    const a = await call(`/api/v1/holdings/${holdingId}/product-candidates`, { token });
    const b = await call('/api/v1/holdings/hold-missing/product-candidates', { token: s.token });
    const c = await call(`/api/v1/holdings/${holdingId}/confirm-product`, { method: 'POST', token, body: { candidateId: 'prod-shield', expectedVersion: 0 }, headers: { 'Idempotency-Key': 'confirm-foreign-1' } });
    assert.deepEqual([a.status, b.status, c.status], [404, 404, 404]);
    assert.deepEqual([a.data.error.code, b.data.error.code, c.data.error.code], ['HOLDING_NOT_FOUND', 'HOLDING_NOT_FOUND', 'HOLDING_NOT_FOUND']);
  }
  assert.equal(Number((await app.database.one('SELECT count(*) AS n FROM policy_profiles')).n), 0);
});

test('holdings routes are off unless HOLDINGS_ENABLED is exactly "true"', opts, async t => {
  const { app, s, holdingId } = await world(t, { HOLDINGS_ENABLED: 'TRUE' });
  const off = await app.call(`/api/v1/holdings/${holdingId}/product-candidates`, { token: s.token });
  assert.equal(off.status, 503);
  assert.equal(off.data.error.code, 'HOLDINGS_DISABLED');
  assert.deepEqual(Object.keys(buildJobHandlers(createBackendServices(app.database, { env: { HOLDINGS_ENABLED: 'yes' } }), { HOLDINGS_ENABLED: 'yes' })), []);
});

// Integration (A3 + A4): a confirmed product starts the collate pipeline, behind HOLDINGS_ENABLED.
async function confirmWithRegistry(t, extraEnv) {
  const w = await world(t, extraEnv);
  const handlers = buildJobHandlers(createBackendServices(w.app.database, { env: { ...w.env, HOLDINGS_ENABLED: 'true' } }), { ...w.env, HOLDINGS_ENABLED: 'true' });
  await handlers['reference.import']({ job: { kind: 'reference.import', householdId: w.s.householdId, payload: { scope: 'registry' } } });
  const url = `/api/v1/holdings/${w.holdingId}/confirm-product`;
  const confirmed = await w.app.call(url, { method: 'POST', token: w.s.token, body: { candidateId: 'prod-shield', expectedVersion: 0 }, headers: { 'Idempotency-Key': `confirm-${randomUUID()}` } });
  const jobs = await w.app.database.many("SELECT kind, dedupe_key FROM job_queue WHERE kind LIKE 'holding.%' AND kind <> 'holding.detect_insurer' ORDER BY kind");
  return { confirmed, jobs };
}

test('confirm-product starts the pipeline: parse_own_pdf and fetch_reference queued once', opts, async t => {
  const { confirmed, jobs } = await confirmWithRegistry(t, {});
  assert.equal(confirmed.status, 200);
  assert.deepEqual(jobs.map(job => job.kind), ['holding.fetch_reference', 'holding.parse_own_pdf']);
  for (const job of jobs) assert.match(job.dedupe_key, /^[a-f0-9]{64}$/);
});

test('confirm-product with HOLDINGS_ENABLED off queues no pipeline jobs', opts, async t => {
  const stub = await referenceStub();
  t.after(() => new Promise(resolve => stub.server.close(resolve)));
  fixture.pages = [BROCHURE.split('\n').map(text => ({ text, tag: 'paragraph' })), [{ text: 'Schedule of benefits', tag: 'paragraph' }]];
  const env = { HOLDINGS_ENABLED: 'false', REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_BASE_URL: `http://127.0.0.1:${stub.port}`, REFERENCE_DATA_API_KEY: 'test-key-not-real' };
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'Holding' });
  const holdingId = `hold-${randomUUID()}`;
  const at = new Date().toISOString();
  // OCR completion already made this document's holding and detect job (HOLDINGS_ENABLED); the test seeds its own.
  await app.database.run("DELETE FROM job_queue WHERE kind = 'holding.detect_insurer'");
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run('INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [holdingId, s.householdId, s.documentId, 'retail_health', 'uploaded', at, at]);
  const refused = await app.call(`/api/v1/holdings/${holdingId}/confirm-product`, { method: 'POST', token: s.token, body: { candidateId: 'prod-shield', expectedVersion: 0 }, headers: { 'Idempotency-Key': `confirm-${randomUUID()}` } });
  assert.notEqual(refused.status, 200);
  assert.equal((await app.database.many("SELECT id FROM job_queue WHERE kind LIKE 'holding.%'")).length, 0);
});
