// Curated insurer products: strict shape, derived verification, UIN comparison that informs and never overrides. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCuratedProduct, loadCuratedProducts, compareToCurated, extractUins, CURATED_PRODUCT_RECORDS, buildDecisionCatalogue } from '../src/features/decision-catalogue/index.js';

const today = '2026-10-20';
const record = (over = {}) => ({
  uin: 'SYNTHHLIP26001V012526', insurer: 'Synthetic Insurer', productName: 'Synthetic Health Plan', wordingVersion: 'v1',
  sourceUrl: 'https://insurer.example/wording.pdf', contentSha256: 'a'.repeat(64), retrievedOn: '2026-10-01', checkedOn: '2026-10-05',
  curatedBy: 'curator-a', checkedBy: 'checker-b',
  facts: [{ factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months: 36 }, page: 12, quote: 'waiting period of 36 months applies' }],
  ...over,
});

test('the shipped curated list is empty: nothing is invented', () => {
  assert.deepEqual([...CURATED_PRODUCT_RECORDS], []);
});
test('a complete record validates and is verified only because a different person checked it', () => {
  const out = validateCuratedProduct(record(), { today });
  assert.equal(out.valid, true);
  assert.equal(out.verified, true);
  assert.equal(out.mayOverrideContract, false);
  assert.equal(out.freshness, 'current');
});
test('self-check, missing hash, http url, future dates, bad UIN, empty facts and household-only fact types are refused', () => {
  const bad = over => validateCuratedProduct(record(over), { today });
  assert.ok(bad({ checkedBy: 'curator-a' }).errors.includes('checkedBy_must_differ_from_curatedBy'));
  assert.ok(bad({ contentSha256: 'xyz' }).errors.includes('contentSha256'));
  assert.ok(bad({ sourceUrl: 'http://insurer.example/w.pdf' }).errors.includes('sourceUrl'));
  assert.ok(bad({ sourceUrl: 'https://user:pw@insurer.example/w.pdf' }).errors.includes('sourceUrl'));
  assert.ok(bad({ retrievedOn: '2027-01-01' }).errors.includes('retrievedOn'));
  assert.ok(bad({ checkedOn: '2026-09-01' }).errors.includes('checkedOn'));
  assert.ok(bad({ uin: 'short' }).errors.includes('uin'));
  assert.ok(bad({ facts: [] }).errors.includes('facts'));
  assert.ok(bad({ facts: [{ factType: 'sum_insured', topic: 'x', value: { amountMinor: 1, currency: 'INR' }, page: 1, quote: 'sum insured is chosen' }] }).errors.includes('facts[0]'));
  assert.ok(bad({ facts: [{ factType: 'waiting_period', topic: 'x', value: { months: -1 }, page: 1, quote: 'waiting period applies' }] }).errors.includes('facts[0]'));
  assert.ok(bad({ facts: [{ factType: 'waiting_period', topic: 'x', value: { months: 36 }, page: 0, quote: 'waiting period applies' }] }).errors.includes('facts[0]'));
  assert.ok(bad({ facts: [{ factType: 'waiting_period', topic: 'x', value: { months: 36 }, page: 1, quote: '' }] }).errors.includes('facts[0]'));
});
test('a record cannot assert its own verification', () => {
  assert.equal(validateCuratedProduct(record({ verified: true, checkedBy: '' }), { today }).valid, false);
});
test('superseded, not-yet-effective and stale records are labelled, not hidden', () => {
  assert.equal(validateCuratedProduct(record({ supersededBy: 'v2' }), { today }).freshness, 'superseded');
  assert.equal(validateCuratedProduct(record({ effectiveFrom: '2027-01-01' }), { today }).freshness, 'not_yet_effective');
  assert.equal(validateCuratedProduct(record({ retrievedOn: '2025-01-01', checkedOn: '2025-01-02' }), { today }).freshness, 'stale');
});
test('loading fails closed on an invalid or repeated record', () => {
  assert.throws(() => loadCuratedProducts([record(), record({ contentSha256: 'bad' })], { today }), /invalid/);
  assert.throws(() => loadCuratedProducts([record(), record()], { today }), /repeats/);
  assert.equal(loadCuratedProducts([record(), record({ wordingVersion: 'v2' })], { today }).length, 2);
});
test('UIN extraction needs a label, a letter and a digit', () => {
  assert.deepEqual(extractUins('UIN: SYNTHHLIP26001V012526'), ['SYNTHHLIP26001V012526']);
  assert.deepEqual(extractUins('uin SYNTHHLIP26001V012526 and UIN: SYNTHHLIP26001V012526'), ['SYNTHHLIP26001V012526']);
  assert.deepEqual(extractUins('UIN: 123456789012'), []);
  assert.deepEqual(extractUins('SYNTHHLIP26001V012526 alone'), []);
});

const products = loadCuratedProducts([record()], { today });
const row = (documentId, text) => ({ documentId, text });
const fact = (documentId, months) => ({ documentId, factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months } });

test('a matching UIN compares terms: equal matches, unequal differs, absent is not compared', () => {
  const rows = [row('d1', 'UIN: SYNTHHLIP26001V012526')];
  assert.equal(compareToCurated({ clauseRows: rows, facts: [fact('d1', 36)], products })[0].comparisons[0].result, 'matches');
  const differs = compareToCurated({ clauseRows: rows, facts: [fact('d1', 48)], products })[0];
  assert.equal(differs.comparisons[0].result, 'differs');
  assert.equal(differs.comparisons[0].source.page, 12);
  assert.equal(compareToCurated({ clauseRows: rows, facts: [], products })[0].comparisons[0].result, 'not_compared');
});
test('no UIN, several UINs, no record and an ambiguous version never compare', () => {
  const status = (rows, prods = products) => compareToCurated({ clauseRows: rows, facts: [fact('d1', 36)], products: prods })[0].status;
  assert.equal(status([row('d1', 'Room rent applies')]), 'no_uin');
  assert.equal(status([row('d1', 'UIN: SYNTHHLIP26001V012526\nUIN: OTHERHLIP26002V012526')]), 'several_uins');
  assert.equal(status([row('d1', 'UIN: OTHERHLIP26002V012526')]), 'no_curated_record');
  const two = loadCuratedProducts([record(), record({ wordingVersion: 'v2' })], { today });
  assert.equal(status([row('d1', 'UIN: SYNTHHLIP26001V012526')], two), 'version_ambiguous');
  const stale = loadCuratedProducts([record({ retrievedOn: '2025-01-01', checkedOn: '2025-01-02' })], { today });
  assert.equal(status([row('d1', 'UIN: SYNTHHLIP26001V012526')], stale), 'no_curated_record');
});
test('a curated difference informs only: the household fact and the catalogue state are unchanged', () => {
  const clauseRows = [{ id: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'x'.repeat(64), text: 'UIN: SYNTHHLIP26001V012526' }];
  const without = buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [] });
  const withCurated = buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [], curatedProducts: products });
  assert.deepEqual(withCurated.facts, without.facts);
  assert.equal(withCurated.curatedComparison[0].uin, 'SYNTHHLIP26001V012526');
  assert.equal(withCurated.curatedComparison[0].status, 'compared');
});
