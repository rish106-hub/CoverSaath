import test from 'node:test';
import assert from 'node:assert/strict';
import { matchFssVersion, pickVersion } from '../src/features/insurance-rules/fss-version-match.js';
import { mapFssFacts, fssEvidence } from '../src/features/policy-facts/fss-fact-map.js';

// Pure decision tests: version match (design note section 2) and the four-family map (section 3). Synthetic ids only; no network.

const product = (over = {}) => ({ productId: 'p1', insurerId: 'i1', productName: 'Synthetic Test Health Plan', lineOfBusiness: 'health', uinRaw: 'SYNTHHLT0001', verificationStatus: 'independently_verified', ...over });
const version = (over = {}) => ({ versionId: 'v1', productId: 'p1', freshness: 'current_as_observed', effectiveFrom: '2026-01-01', effectiveTo: null, ...over });

function lookupOf({ products = [product()], versions = [version()], resolved = { status: 'resolved', insurer: { id: 'i1' } } } = {}) {
  const calls = [];
  const lookup = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === 'products.search') return { products, ambiguous: products.length > 1 };
    if (endpoint === 'products.versions') return { data: versions };
    if (endpoint === 'insurers.resolve') return resolved;
    throw new Error(`unexpected ${endpoint}`);
  };
  return { lookup, calls };
}

test('version precedence: the UIN wins over names; names are not looked up when a UIN is present', async () => {
  const { lookup, calls } = lookupOf();
  const matched = await matchFssVersion({ lookup, uin: 'SYNTHHLT0001', insurerName: 'Other Insurer', productName: 'Other Plan', startDate: '2026-03-01' });
  assert.deepEqual(matched, { outcome: 'matched', productId: 'p1', versionId: 'v1' });
  assert.deepEqual(calls.map(call => call.endpoint), ['products.search', 'products.versions']);
  assert.deepEqual(calls[0].params, { uin: 'SYNTHHLT0001' });
});

test('name path: insurer resolves, then exactly one exact (case-folded, space-collapsed) name', async () => {
  const { lookup, calls } = lookupOf({ products: [product({ productName: 'Synthetic Test Health Plan' }), product({ productId: 'p2', productName: 'Synthetic Test Health Plan Plus' })] });
  const matched = await matchFssVersion({ lookup, insurerName: 'Synthetic Insurer', productName: '  synthetic  TEST health plan ' });
  assert.equal(matched.outcome, 'matched');
  assert.deepEqual(calls.map(call => call.endpoint), ['insurers.resolve', 'products.search', 'products.versions']);
});

test('name path: unresolved or ambiguous insurer, no name, or a duplicate exact name is no match', async () => {
  for (const resolved of [{ status: 'ambiguous', insurer: null }, { status: 'unmatched', insurer: null }]) {
    assert.equal((await matchFssVersion({ lookup: lookupOf({ resolved }).lookup, insurerName: 'X', productName: 'Y' })).outcome, 'no_match');
  }
  assert.equal((await matchFssVersion({ lookup: lookupOf().lookup, insurerName: null, productName: null })).outcome, 'no_match');
  const twins = [product(), product({ productId: 'p2' })];
  assert.equal((await matchFssVersion({ lookup: lookupOf({ products: twins }).lookup, insurerName: 'X', productName: 'Synthetic Test Health Plan' })).outcome, 'no_match');
});

test('UIN path: zero, two, non-health or a different UIN is no match; synthetic only is synthetic_only', async () => {
  const run = products => matchFssVersion({ lookup: lookupOf({ products }).lookup, uin: 'SYNTHHLT0001' });
  assert.equal((await run([])).outcome, 'no_match');
  assert.equal((await run([product(), product({ productId: 'p2' })])).outcome, 'no_match');
  assert.equal((await run([product({ lineOfBusiness: 'motor' })])).outcome, 'no_match');
  assert.equal((await run([product({ uinRaw: 'SYNTHHLT9999' })])).outcome, 'no_match');
  assert.equal((await run([product({ verificationStatus: 'synthetic_test' })])).outcome, 'synthetic_only');
});

test('version precedence: the window that contains the start date wins; boundaries are inclusive', () => {
  const versions = [
    version({ versionId: 'old', effectiveFrom: '2024-01-01', effectiveTo: '2025-12-31' }),
    version({ versionId: 'new', effectiveFrom: '2026-01-01', effectiveTo: null }),
  ];
  assert.equal(pickVersion({ versions, startDate: '2025-06-15' }).versionId, 'old');
  assert.equal(pickVersion({ versions, startDate: '2025-12-31' }).versionId, 'old');
  assert.equal(pickVersion({ versions, startDate: '2026-01-01' }).versionId, 'new');
  assert.equal(pickVersion({ versions, startDate: '2023-01-01' }).outcome, 'version_unresolved');
});

test('version precedence: ambiguous windows, or several versions without a start date, give no match', () => {
  const overlapping = [version({ versionId: 'a' }), version({ versionId: 'b' })];
  assert.equal(pickVersion({ versions: overlapping, startDate: '2026-02-01' }).outcome, 'version_unresolved');
  assert.equal(pickVersion({ versions: overlapping, startDate: null }).outcome, 'version_unresolved');
  assert.equal(pickVersion({ versions: [version()], startDate: null }).versionId, 'v1');
});

test('version filter: synthetic, test_fixture, withdrawn and access_blocked versions are dropped', () => {
  const versions = [version({ versionId: 't', freshness: 'test_fixture' }), version({ versionId: 'w', freshness: 'withdrawn' }), version({ versionId: 'b', freshness: 'access_blocked' }), version({ versionId: 'ok' })];
  assert.equal(pickVersion({ versions, startDate: '2026-02-01' }).versionId, 'ok');
  assert.equal(pickVersion({ versions: versions.slice(0, 1), startDate: null }).outcome, 'synthetic_only');
  assert.equal(pickVersion({ versions: versions.slice(1, 3), startDate: null }).outcome, 'version_unresolved');
  assert.equal(pickVersion({ versions: [], startDate: null }).outcome, 'version_unresolved');
});

const fact = (factType, value, over = {}) => ({
  factId: `f_${factType}`, factType, value, conditions: [], exceptions: [], outcome: 'verified', verificationStatus: 'independently_verified',
  taxonomyVersion: 'synth-1', reviewId: 'rev1', reviewerId: 'rvr1', evidence: [{ documentId: 'doc1', pageNumber: 7, sha256: 'a'.repeat(64), pageSha256: 'b'.repeat(64) }], ...over,
});

test('fact map: four families only, with the design transforms', () => {
  const mapped = mapFssFacts([
    fact('room_rent_limit', { limitType: 'fixed_amount_per_day', amount: 5000 }),
    fact('copay', { percentage: 10 }),
    fact('initial_waiting_period', { duration: { value: 30, unit: 'day' } }),
    fact('pre_existing_disease_waiting_period', { duration: { value: 36, unit: 'month' } }),
    fact('specific_disease_waiting_period', { duration: { value: 24, unit: 'month' } }),
    fact('excluded_conditions', { text: 'x' }),
  ]);
  assert.deepEqual(mapped.map(item => [item.factKey, item.value]), [
    ['room_rent_limit', { amountMinor: 500_000, currency: 'INR' }],
    ['copay_percent', { bp: 1000 }],
    ['waiting_initial', { days: 30, original: [{ amount: 30, unit: 'day' }] }],
    ['waiting_ped', { days: 1095, original: [{ amount: 36, unit: 'month' }] }],
  ]);
  assert.equal(mapFssFacts([fact('pre_existing_disease_waiting_period', { duration: { value: 3, unit: 'year' } })])[0].value.days, 1095);
});

test('fact map: unusable, conditional, withheld and ill-fitting facts stay absent', () => {
  assert.deepEqual(mapFssFacts([
    fact('copay', { percentage: 10 }, { outcome: 'unknown' }),
    fact('copay', { percentage: 10 }, { outcome: 'conflicting' }),
    fact('copay', { percentage: 10 }, { conditions: ['age above 60'] }),
    fact('copay', { percentage: 10 }, { exceptions: ['accident'] }),
    fact('copay', { percentage: 140 }),
    fact('room_rent_limit', { limitType: 'percent_of_sum_insured', percentage: 1 }),
    fact('initial_waiting_period', { duration: { value: 3, unit: 'fortnight' } }),
    fact('initial_waiting_period', null),
  ]), []);
  assert.deepEqual(mapFssFacts(undefined), []);
});

test('evidence: opaque ids, page and hashes only; no UIN, no quote', () => {
  const evidence = fssEvidence({ fact: fact('copay', { percentage: 10 }), versionId: 'ver1', cacheKey: 'versions.facts/abc' });
  assert.equal(evidence.source, 'fss');
  assert.equal(evidence.refId, 'fss:f_copay');
  assert.equal(evidence.quote, null);
  assert.deepEqual(evidence.evidence, [{ documentId: 'doc1', pageNumber: 7, sha256: 'a'.repeat(64) }]);
  assert.ok(!JSON.stringify(evidence).includes('SYNTHHLT'));
});
