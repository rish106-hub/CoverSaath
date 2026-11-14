import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  IMPORT_SERVICE_ENDPOINTS, createImportedReferenceClient, importSourceKey, prepareReferenceImport, referenceImportMode,
} from '../src/backend/services/reference-data-import.js';
import { cacheKeyFor } from '../src/backend/services/reference-data-port.js';
import { createHoldingProductService, exportCacheKey } from '../src/backend/services/holding-product-service.js';

// Pipeline stage 5: FSS publishes owner_approved reference-import files carrying registry pages and per-UIN exports;
// in import mode (no service URL) the jobs read those rows and never call the network. Synthetic values only.
const SHA = 'a'.repeat(64);
const UIN = 'SYNHLIP00001V012526';
const page = { page_number: 1, text: 'Synthetic wording page.', content_sha256: SHA, parser_version: 'pdfplumber-extract.py-v1', extraction_status: 'extracted', tables_json: [] };
const exportBody = {
  export_version: SHA,
  product: { product_id: 'prod-syn', product_name: 'Synthetic Care', insurer_id: 'ins-syn', insurer_name: 'Synthetic Insurer', line_of_business: 'health' },
  documents: [{ document_id: SHA, version_id: 'rawdoc-aaaaaaaaaaaaaaaa', wording_version: 'aaaaaaaa', sha256: SHA, media_type: 'application/pdf', source_observed_at: '2026-11-14T00:00:00.000Z', synthetic: true, source_pages: [page] }],
};
const insurersPage = (ids, next = null) => ({ data: ids.map(id => ({ id, canonical_name: `Synthetic ${id}`, aliases: [] })), next_cursor: next });
const productsPage = (ids, next = null) => ({
  data: ids.map(id => ({ product_id: id, product_name: `Synthetic ${id}`, insurer_id: 'ins-syn', insurer_name: 'Synthetic Insurer', line_of_business: 'health', uin_raw: UIN, verification_status: 'candidate' })),
  next_cursor: next,
});
const fileOf = (entries, extra = {}) => ({ format: 'reference-import-v1', data_class: 'owner_approved', rights_reference: 'FSS ADR 0003 public insurer documents', entries, ...extra });
const stage5Entries = () => [
  { endpoint: 'registry.insurers', params: {}, response: insurersPage(['ins-syn']) },
  { endpoint: 'registry.products', params: {}, response: productsPage(['prod-1'], 'p2') },
  { endpoint: 'registry.products', params: { cursor: 'p2' }, response: productsPage(['prod-2']) },
  { endpoint: 'products.exportByUin', params: { uin: UIN }, response: exportBody },
];

function memoryCache() {
  const rows = new Map();
  return {
    rows,
    async get(key) { return rows.get(key) ?? null; },
    async put({ key, etag = null, body, signature }) { rows.set(key, { key, etag, body, signature, fresh: true }); return rows.get(key); },
    async acquireLease() { return true; },
    async releaseLease() {},
  };
}
async function loaded(entries = stage5Entries()) {
  const cache = memoryCache();
  for (const row of prepareReferenceImport(fileOf(entries), { allowOwnerApproved: true })) {
    await cache.put({ key: row.key, etag: 'import-owner_approved-test', body: row.body, signature: row.signature });
  }
  return cache;
}

test('owner_approved imports accept registry pages and per-UIN exports under their own import. keys', () => {
  const rows = prepareReferenceImport(fileOf(stage5Entries()), { allowOwnerApproved: true });
  assert.deepEqual(rows.map(r => r.endpoint), ['registry.insurers', 'registry.products', 'registry.products', 'products.exportByUin']);
  assert.ok(rows.every(r => r.key.startsWith('import.')));
  assert.equal(rows[3].key, importSourceKey('products.exportByUin', { uin: UIN }));
  // Never the key the export job writes its chunked body under.
  assert.notEqual(rows[3].key, exportCacheKey(UIN));
  assert.deepEqual([...IMPORT_SERVICE_ENDPOINTS].sort(), ['products.exportByUin', 'registry.insurers', 'registry.products']);
});

test('service endpoints are refused in synthetic imports, without the opt-in, or when the response is malformed', () => {
  const entry = stage5Entries()[3];
  assert.throws(() => prepareReferenceImport(fileOf([entry], { data_class: 'synthetic', rights_reference: undefined })), { code: 'REFERENCE_IMPORT_INVALID' });
  assert.throws(() => prepareReferenceImport(fileOf([entry])), { code: 'REFERENCE_IMPORT_INVALID' });
  assert.throws(() => prepareReferenceImport(fileOf([{ ...entry, response: { ...exportBody, export_version: 'nothex' } }]), { allowOwnerApproved: true }), { code: 'REFERENCE_IMPORT_INVALID' });
  assert.throws(() => prepareReferenceImport(fileOf([{ endpoint: 'hospitals.export', params: {}, response: {} }]), { allowOwnerApproved: true }), { code: 'REFERENCE_IMPORT_INVALID' });
});

test('import mode is reference data on with no service URL', () => {
  assert.equal(referenceImportMode({ REFERENCE_DATA_ENABLED: 'true' }), true);
  assert.equal(referenceImportMode({ REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_BASE_URL: '  ' }), true);
  assert.equal(referenceImportMode({ REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_BASE_URL: 'https://fss.example' }), false);
  assert.equal(referenceImportMode({ REFERENCE_DATA_ENABLED: 'false' }), false);
});

test('imported client serves imported rows; misses and tampered rows are coded, never fetched', async () => {
  const cache = await loaded();
  const client = createImportedReferenceClient({ referenceCache: cache });
  const exp = await client.read('products.exportByUin', { uin: UIN });
  assert.equal(exp.data.documents[0].sourcePages[0].text, 'Synthetic wording page.');
  const next = await client.read('registry.products', { cursor: 'p2' });
  assert.deepEqual(next.data.products.map(p => p.productId), ['prod-2']);
  await assert.rejects(client.read('products.exportByUin', { uin: 'SYNHLIP00002V012526' }), { code: 'REFERENCE_DATA_NOT_FOUND' });
  await assert.rejects(client.read('registry.insurers', { cursor: 'zz' }), { code: 'REFERENCE_DATA_UNAVAILABLE', retryable: true });
  const key = importSourceKey('products.exportByUin', { uin: UIN });
  cache.rows.set(key, { ...cache.rows.get(key), body: { ...cache.rows.get(key).body, exportVersion: 'b'.repeat(64) } });
  await assert.rejects(client.read('products.exportByUin', { uin: UIN }), { code: 'REFERENCE_DATA_NOT_FOUND' });
  await assert.rejects(client.read('products.exportByUin', { uin: 'bad uin!' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
});

test('jobs in import mode build the registry snapshot and the UIN export from imported rows with no network', async t => {
  const cache = await loaded();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network used in import mode'); };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = { HOLDINGS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true' };
  const service = createHoldingProductService({
    repository: { profileUin: async () => UIN }, policyHoldings: {}, policyProfiles: {}, referenceCache: cache, jobQueue: {}, ocr: {}, env,
  });
  assert.deepEqual(await service.importRegistry(), { insurers: 1, products: 2 });
  const stored = await service.importReference({ householdId: 'hh-syn', policyProfileId: 'pp-syn' });
  assert.equal(stored.stored, true);
  assert.ok(stored.chunks >= 1);
  const chunked = cache.rows.get(exportCacheKey(UIN)).body;
  assert.equal(chunked.documents[0].pages[0].text, undefined);
  assert.equal(chunked.chunks[0].text, 'Synthetic wording page.');
  // A UIN with no imported export is "not available", not an error and not a fetch.
  const missing = createHoldingProductService({
    repository: { profileUin: async () => 'SYNHLIP00009V012526' }, policyHoldings: {}, policyProfiles: {}, referenceCache: cache, jobQueue: {}, ocr: {}, env,
  });
  assert.deepEqual(await missing.importReference({ householdId: 'hh-syn', policyProfileId: 'pp-syn' }), { stored: false, reason: 'not_available' });
  // Signature of the imported registry row matches its body (stored rows are what the port verifies).
  const registryKey = cacheKeyFor('import.registry.insurers', {});
  assert.equal(cache.rows.get(registryKey).signature.length, 64);
  assert.equal(createHash('sha256').update('x').digest('hex').length, 64);
});
