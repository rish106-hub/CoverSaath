import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { ReferenceCacheRepository } from '../src/backend/repositories/reference-cache-repository.js';
import { createReferenceDataPort } from '../src/backend/services/reference-data-port.js';
import { importReferenceData, prepareReferenceImport } from '../src/backend/services/reference-data-import.js';
import { createInsuranceDataClient } from '../src/integrations/index.js';

// ADR 0021 option d: reference rows imported from a local file into the reference cache, served by the port with no
// service. Synthetic data only; no network (the client's fetch throws and is counted).
const fixture = () => JSON.parse(readFileSync(new URL('../scripts/fixtures/reference-import-synthetic.json', import.meta.url), 'utf8'));
const IMPORT_ENV = { REFERENCE_DATA_ENABLED: 'true' };

function noNetworkClient(env = IMPORT_ENV) {
  const calls = [];
  const client = createInsuranceDataClient({ env, fetchImpl: async url => { calls.push(String(url)); throw new Error('no network in tests'); } });
  return { client, calls };
}

test('the shipped synthetic fixture validates and every fact stays unknown', () => {
  const rows = prepareReferenceImport(fixture());
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => /^[a-z0-9.-]+\/[a-f0-9]{40}$/.test(row.key)));
});

test('invalid import files are refused before anything is written, with an entry index and no value', () => {
  const cases = [
    [{ ...fixture(), format: 'other' }, /format/],
    [{ ...fixture(), data_class: 'real' }, /data_class/],
    [{ ...fixture(), entries: [] }, /entries/],
    [{ ...fixture(), entries: [{ endpoint: 'customer-mappings.resolve', params: {}, response: {} }] }, /entry 0/],
    [{ ...fixture(), entries: [{ endpoint: 'products.get', params: { productId: 'p1', household: 'h1' }, response: {} }] }, /Params/],
    [{ ...fixture(), entries: [{ endpoint: 'insurers.search', params: { q: 'x' }, response: { data: 'nope' } }] }, /pinned shape/],
    [{ ...fixture(), entries: [...fixture().entries, fixture().entries[0]] }, /Duplicate.*entry 4/],
    [{ ...fixture(), entries: [{ ...fixture().entries[0], extra: 1 }] }, /only endpoint/],
  ];
  for (const [document, pattern] of cases) {
    assert.throws(() => prepareReferenceImport(document), error => error.code === 'REFERENCE_IMPORT_INVALID' && pattern.test(error.message));
  }
  // A synthetic file cannot carry verified-looking data.
  const entries = fixture().entries;
  const facts = entries.find(entry => entry.endpoint === 'versions.facts');
  const search = entries.find(entry => entry.endpoint === 'products.search');
  assert.throws(() => prepareReferenceImport({ ...fixture(), entries: [{ ...facts, response: { ...facts.response, version_synthetic: false } }] }), /version_synthetic/);
  assert.throws(() => prepareReferenceImport({ ...fixture(), entries: [{ ...search, response: { ...search.response, data: [{ ...search.response.data[0], verification_status: 'independently_verified' }] } }] }), /synthetic_test/);
  // owner_approved needs the explicit option and a rights reference.
  assert.throws(() => prepareReferenceImport({ ...fixture(), data_class: 'owner_approved', rights_reference: 'RR-1' }), /explicit/);
  assert.throws(() => prepareReferenceImport({ ...fixture(), data_class: 'owner_approved' }, { allowOwnerApproved: true }), /rights_reference/);
  assert.equal(prepareReferenceImport({ ...fixture(), data_class: 'owner_approved', rights_reference: 'RR-1' }, { allowOwnerApproved: true }).length, 4);
});

test('import writes the cache in one go and the port serves it with no service call', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db);
  const dry = await importReferenceData({ database: db, repository, document: fixture(), dryRun: true });
  assert.equal(dry.entries, 4);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM reference_cache')).n, 0, 'dry run writes nothing');

  const summary = await importReferenceData({ database: db, repository, document: fixture(), ttlDays: 30 });
  assert.deepEqual(summary.byEndpoint, { 'insurers.resolve': 1, 'products.search': 1, 'products.versions': 1, 'versions.facts': 1 });
  assert.match(summary.marker, /^import-[a-f0-9]{16}$/);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM reference_cache')).n, 4);
  // Re-import is idempotent: same keys, same count.
  await importReferenceData({ database: db, repository, document: fixture() });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM reference_cache')).n, 4);

  const { client, calls } = noNetworkClient();
  const port = createReferenceDataPort({ repository, client, env: IMPORT_ENV });
  const resolved = await port.resolveInsurer({ q: '  Example   Insurer ' });
  assert.equal(resolved.source, 'cache');
  assert.equal(resolved.stale, false);
  assert.equal(resolved.referenceContextOnly, true);
  assert.equal(resolved.data.insurer.id, 'ins_example_1');
  const products = await port.searchProducts({ uin: 'synthetic-test-only/01' });
  assert.equal(products.data.products[0].verificationStatus, 'synthetic_test');
  const facts = await port.getFacts({ versionId: 'ver_example_01' });
  assert.equal(facts.data.versionSynthetic, true);
  assert.equal(calls.length, 0, 'import mode never calls a service');

  // A miss in import mode fails closed with a coded error and still makes no network call.
  await assert.rejects(port.getProduct({ productId: 'prod_missing' }), { code: 'REFERENCE_DATA_NOT_CONFIGURED' });
  assert.equal(calls.length, 0);

  // Flag off: the port refuses even though rows are cached.
  const off = createReferenceDataPort({ repository, client, env: {} });
  await assert.rejects(off.resolveInsurer({ q: 'Example Insurer' }), { code: 'REFERENCE_DATA_DISABLED' });

  // Past its TTL an imported row is served labelled stale, never refreshed from nowhere.
  await db.run("UPDATE reference_cache SET stale_after = now() - interval '1 second'");
  const stale = await port.resolveInsurer({ q: 'Example Insurer' });
  assert.equal(stale.stale, true);
  assert.equal(calls.length, 0);
});

test('a bad entry anywhere in the file writes nothing', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repository = new ReferenceCacheRepository(db);
  const document = fixture();
  document.entries.push({ endpoint: 'products.get', params: { productId: 'p9' }, response: { product_id: 'p9' } });
  await assert.rejects(importReferenceData({ database: db, repository, document }), { code: 'REFERENCE_IMPORT_INVALID' });
  assert.equal((await db.one('SELECT count(*)::int AS n FROM reference_cache')).n, 0);
  await assert.rejects(importReferenceData({ database: db, repository, document: fixture(), ttlDays: 0 }), { code: 'REFERENCE_IMPORT_INVALID' });
});
