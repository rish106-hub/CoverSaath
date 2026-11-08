import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createInsuranceDataClient, REFERENCE_ENDPOINTS } from '../src/integrations/index.js';
import { readReferenceDataConfig, readServerConfig } from '../src/server/config.js';

// Contract test against the insurance-data-api OpenAPI shape (specifications/openapi.yaml in that repository, read
// 2026-11-08). Local stubs only: no network. The pinned lists below are the spec's `required` arrays and enums; the
// fixtures are synthetic responses in the spec shape (and in the shape the local service actually returned).
// Set IDA_OPENAPI_PATH to a checkout's openapi.yaml to also check the pinned lists for drift (opt-in, not needed in CI).

const PINNED_REQUIRED = Object.freeze({
  Insurer: ['id', 'canonical_name'],
  InsurerResolution: ['status', 'insurer', 'candidates'],
  Product: ['product_id', 'insurer_id', 'product_name', 'line_of_business', 'uin_raw', 'data_coverage', 'last_observed_at'],
  ProductVersion: ['version_id', 'product_id', 'wording_version', 'version_status', 'freshness', 'source_observed_at'],
  FactEvidence: ['document_id', 'page_number', 'sha256'],
  VerifiedFact: ['fact_id', 'version_id', 'fact_type', 'value', 'verification_status', 'source_freshness', 'review_id', 'reviewer_id', 'evidence', 'taxonomy_version'],
});
const PINNED_ENUMS = Object.freeze({
  Freshness: ['current_as_observed', 'stale_review', 'superseded', 'withdrawn', 'unknown', 'access_blocked', 'test_fixture'],
  FactCoverageState: ['verified', 'partial', 'not_observed', 'conflicting_evidence', 'not_permitted', 'awaiting_review'],
});

const ENV = { REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_BASE_URL: 'http://127.0.0.1:3000', REFERENCE_DATA_API_KEY: 'test-key-not-real' };
const SHA = 'b'.repeat(64);
const insurer = { id: 'ins_example_1', canonical_name: 'Example Insurer', aliases: [] };
const product = {
  product_id: 'prod_example_01', insurer_id: 'ins_example_1', product_name: 'Example Health Plan 01', line_of_business: 'health',
  uin_raw: 'SYNTHETIC-TEST-ONLY/01', data_coverage: 'not_observed', last_observed_at: '2026-01-01T00:00:00.000Z', verification_status: 'synthetic_test',
};
// As the local service returned it: extra fields (approved_at, version_synthetic, relationship_basis) beyond the spec.
const version = {
  version_id: 'ver_example_01', product_id: 'prod_example_01', wording_version: 'ver_example_01', approved_at: null, effective_from: null,
  effective_to: null, version_status: 'active_unknown', version_synthetic: true, freshness: 'test_fixture',
  source_observed_at: '2026-01-01T00:00:00.000Z', relationship_basis: 'synthetic fixture manifest',
};
const verifiedFact = {
  fact_id: 'fact_example_1', version_id: 'ver_example_2', fact_type: 'copay', value: { kind: 'copay', percentage: 10, text: 'Ten percent' },
  conditions: ['Applies above age 60'], exceptions: [], verification_status: 'independently_verified', source_freshness: '2026-01-01T00:00:00.000Z',
  review_id: 'rev_1', reviewer_id: 'reviewer_1', taxonomy_version: 'v1', evidence: [{ document_id: 'doc_1', page_number: 2, sha256: SHA, excerpt: null }],
};
const factsHeader = (overrides = {}) => ({
  version_id: 'ver_example_2', product_id: 'prod_example_02', product_name: 'Example Health Plan 02', insurer_name: 'Example Insurer',
  uin_raw: null, wording_version: 'w1', approved_at: null, source_observed_at: '2026-01-01T00:00:00.000Z', version_synthetic: false,
  facts: [verifiedFact], coverage: { room_rent_limit: 'not_observed', copay: 'verified', waiting_periods: 'awaiting_review', exclusions: 'conflicting_evidence' },
  next_cursor: null, ...overrides,
});

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function stubClient(handler, env = ENV) {
  const calls = [];
  const client = createInsuranceDataClient({ env, fetchImpl: async (url, init) => { calls.push({ url: new URL(url), init }); return handler(new URL(url)); } });
  return { client, calls };
}

test('every allow-listed endpoint parses a response in the spec shape (local stub, no network)', async () => {
  const bodies = {
    '/v1/insurers': { data: [insurer], next_cursor: null },
    '/v1/insurers/resolve': { status: 'resolved', insurer, candidates: [insurer] },
    '/v1/products': { data: [product], next_cursor: null, dataset_snapshot: 'registry-v1' },
    '/v1/products/prod_example_01': product,
    '/v1/products/prod_example_01/versions': { data: [version], next_cursor: null },
    '/v1/versions/ver_example_2/facts': factsHeader(),
  };
  const { client, calls } = stubClient(url => jsonResponse(bodies[url.pathname] ?? { error: { code: 'not_found', message: 'x', request_id: 'r' } }, bodies[url.pathname] ? 200 : 404));
  const params = {
    'insurers.search': { q: 'Example' }, 'insurers.resolve': { q: 'Example Insurer' }, 'products.search': { uin: 'SYNTHETIC-TEST-ONLY/01' },
    'products.get': { productId: 'prod_example_01' }, 'products.versions': { productId: 'prod_example_01' }, 'versions.facts': { versionId: 'ver_example_2' },
  };
  assert.deepEqual(Object.keys(params).sort(), Object.keys(REFERENCE_ENDPOINTS).sort());
  for (const [endpoint, p] of Object.entries(params)) await client.read(endpoint, p);
  assert.equal(calls.length, 6);
  assert.ok(calls.every(call => call.init.method === 'GET' && call.url.origin === 'http://127.0.0.1:3000'));

  const resolved = (await client.read('insurers.resolve', params['insurers.resolve'])).data;
  assert.deepEqual(resolved, { status: 'resolved', insurer: { id: 'ins_example_1', canonicalName: 'Example Insurer', aliases: [] } });
  const versions = (await client.read('products.versions', params['products.versions'])).data;
  assert.equal(versions.data[0].freshness, 'test_fixture');
  assert.equal('relationshipBasis' in versions.data[0], false, 'extra fields are dropped');
});

test('spec nullable and list fields parse: uin_raw null, conditions and exceptions as string arrays', async () => {
  const { client } = stubClient(url => (url.pathname.endsWith('/facts') ? jsonResponse(factsHeader()) : jsonResponse({ ...product, uin_raw: null })));
  const facts = (await client.read('versions.facts', { versionId: 'ver_example_2' })).data;
  assert.equal(facts.uinRaw, null);
  assert.deepEqual(facts.facts[0].conditions, ['Applies above age 60']);
  assert.deepEqual(facts.facts[0].exceptions, []);
  assert.equal(facts.facts[0].outcome, 'verified');
  assert.equal(facts.facts[0].valueText, 'Ten percent');
  assert.equal((await client.read('products.get', { productId: 'prod_example_01' })).data.uinRaw, null);
});

test('coverage family states map fail closed: only verified carries a value', async () => {
  const fact = type => ({ ...verifiedFact, fact_id: `f_${type}`, fact_type: type });
  const body = factsHeader({ facts: [fact('copay'), fact('waiting_periods'), fact('exclusions'), fact('room_rent_limit')] });
  const { client } = stubClient(() => jsonResponse(body));
  const out = Object.fromEntries((await client.read('versions.facts', { versionId: 'ver_example_2' })).data.facts.map(f => [f.factType, f]));
  assert.equal(out.copay.outcome, 'verified');
  assert.equal(out.waiting_periods.outcome, 'unknown');
  assert.equal(out.waiting_periods.valueText, null);
  assert.deepEqual(out.waiting_periods.conditions, []);
  assert.equal(out.exclusions.outcome, 'conflicting');
  assert.equal(out.exclusions.valueText, null);
  assert.equal(out.room_rent_limit.outcome, 'unknown');
  // A synthetic version never yields a verified fact, whatever the fact claims.
  const { client: synthetic } = stubClient(() => jsonResponse(factsHeader({ version_synthetic: true })));
  assert.equal((await synthetic.read('versions.facts', { versionId: 'ver_example_2' })).data.facts[0].outcome, 'unknown');
});

test('responses outside the pinned shape fail closed with a coded error', async () => {
  const bad = [
    ['products.versions', { productId: 'prod_example_01' }, { data: [{ ...version, freshness: 'fresh_new_value' }], next_cursor: null }],
    ['insurers.resolve', { q: 'Example' }, { status: 'maybe', insurer: null, candidates: [] }],
    ['products.get', { productId: 'prod_example_01' }, { ...product, product_id: undefined }],
    ['versions.facts', { versionId: 'ver_example_2' }, factsHeader({ coverage: { copay: 'kind_of' } })],
    ['versions.facts', { versionId: 'ver_example_2' }, factsHeader({ facts: [{ ...verifiedFact, conditions: [42] }] })],
    ['versions.facts', { versionId: 'ver_example_2' }, factsHeader({ facts: [{ ...verifiedFact, evidence: [{ document_id: 'd', page_number: 1, sha256: 'nothex' }] }] })],
  ];
  for (const [endpoint, params, body] of bad) {
    const { client } = stubClient(() => jsonResponse(body));
    await assert.rejects(client.read(endpoint, params), { code: 'REFERENCE_DATA_RESPONSE_INVALID' }, endpoint);
  }
});

test('the spec error envelope and statuses map to coded, client-safe errors', async () => {
  const envelope = code => ({ error: { code, message: 'upstream text must not leak', request_id: 'req-1' } });
  for (const [status, code] of [[401, 'REFERENCE_DATA_AUTH_FAILED'], [403, 'REFERENCE_DATA_AUTH_FAILED'], [404, 'REFERENCE_DATA_NOT_FOUND'], [400, 'REFERENCE_DATA_REQUEST_REJECTED'], [500, 'REFERENCE_DATA_UNAVAILABLE']]) {
    const { client } = stubClient(() => jsonResponse(envelope('x'), status));
    await assert.rejects(client.read('products.get', { productId: 'prod_example_01' }), error => {
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /upstream|req-1/);
      return true;
    });
  }
  // Service down: fetch throws. Fail closed, retryable, no data.
  const down = createInsuranceDataClient({ env: ENV, fetchImpl: async () => { throw new Error('ECONNREFUSED 127.0.0.1:3000'); } });
  await assert.rejects(down.read('insurers.search', { q: 'Example' }), error => error.code === 'REFERENCE_DATA_UNAVAILABLE' && error.retryable === true && !/ECONNREFUSED/.test(error.message));
});

test('readReferenceDataConfig: off unless exactly "true"; import mode without a base URL; half-configured service fails startup', () => {
  for (const value of [undefined, 'TRUE', '1', 'yes', ' true', 'false']) {
    assert.deepEqual(readReferenceDataConfig({ REFERENCE_DATA_ENABLED: value, REFERENCE_DATA_BASE_URL: 'not a url' }), { enabled: false, mode: 'off' });
  }
  assert.deepEqual(readReferenceDataConfig({ REFERENCE_DATA_ENABLED: 'true' }), { enabled: true, mode: 'import' });
  assert.deepEqual(readReferenceDataConfig(ENV), { enabled: true, mode: 'service' });
  assert.deepEqual(readReferenceDataConfig({ ...ENV, REFERENCE_DATA_BASE_URL: 'https://reference.example.invalid/api' }), { enabled: true, mode: 'service' });
  for (const url of ['http://reference.example.invalid', 'not a url', 'https://user:pw@reference.example.invalid', 'https://reference.example.invalid/?k=v', 'ftp://127.0.0.1']) {
    assert.throws(() => readReferenceDataConfig({ ...ENV, REFERENCE_DATA_BASE_URL: url }), /REFERENCE_DATA_BASE_URL/);
  }
  assert.throws(() => readReferenceDataConfig({ ...ENV, REFERENCE_DATA_API_KEY: '' }), /REFERENCE_DATA_API_KEY/);
  assert.throws(() => readServerConfig({ ...ENV, REFERENCE_DATA_API_KEY: '' }), /REFERENCE_DATA_API_KEY/);
  assert.doesNotThrow(() => readServerConfig({}));
});

// Minimal reader for the pinned parts of openapi.yaml: a schema's `required: [...]` list or `enum: [...]` list, flow style,
// possibly spread over lines. Only used when IDA_OPENAPI_PATH is set.
function specList(yaml, schema, keyword) {
  const lines = yaml.split('\n');
  const start = lines.findIndex(line => line === `    ${schema}:`);
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && /^ {4}\S/.test(line));
  const block = lines.slice(start + 1, end < 0 ? undefined : end).join('\n');
  const match = block.match(new RegExp(`\\n?\\s{6}${keyword}:\\s*\\[([^\\]]*)\\]`));
  return match ? match[1].split(',').map(item => item.trim()).filter(Boolean) : null;
}

test('pinned required fields and enums match the insurance-data-api openapi.yaml (opt-in drift check)', { skip: process.env.IDA_OPENAPI_PATH ? false : 'IDA_OPENAPI_PATH not set' }, () => {
  const yaml = readFileSync(process.env.IDA_OPENAPI_PATH, 'utf8');
  for (const [schema, fields] of Object.entries(PINNED_REQUIRED)) assert.deepEqual(specList(yaml, schema, 'required'), fields, schema);
  for (const [schema, values] of Object.entries(PINNED_ENUMS)) assert.deepEqual(specList(yaml, schema, 'enum'), values, schema);
});
