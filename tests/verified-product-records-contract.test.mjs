import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVerifiedProductRecords, assertVerifiedProductRecordsContract, VERIFIED_RECORDS_VERSION, VERIFIED_RECORD_STATES,
} from '../src/features/decision-catalogue/index.js';

const TODAY = '2026-10-21';
const UIN = 'SYNTHHLIP26009V012526';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const QUOTE = 'Room rent is limited to one percent of the sum insured.';
const fact = (over = {}) => ({ factType: 'room_rent_limit', topic: 'room', value: { kind: 'percent_of_sum_insured', basisPoints: 100 }, page: 4, quote: QUOTE, ...over });

const product = (over = {}) => ({
  uin: UIN, insurer: 'Insurer Example', productName: 'Synthetic Health Plan', wordingVersion: 'v1', sourceUrl: 'https://insurer.example/wording.pdf',
  contentSha256: SHA_A, retrievedOn: '2026-09-01', checkedOn: '2026-09-02', effectiveFrom: null, curatedBy: 'adult-collector', checkedBy: 'adult-checker',
  facts: [fact()], ...over,
});
const verifiedEntry = (over = {}, extra = {}) => ({
  valid: true, freshness: 'current', verified: true, mayOverrideContract: false, product: product(over),
  verification: { submissionId: 'cps-1', sourceVersionId: 'src-v1', checkedAt: '2026-09-02T10:00:00.000Z' }, ...extra,
});
const submission = (over = {}) => ({
  submissionId: 'cps-9', uin: UIN, insurer: 'Insurer Example', productName: 'Synthetic Health Plan', wordingVersion: 'v1', sourceUrl: 'https://insurer.example/wording.pdf',
  sourceVersionId: 'src-s1', contentSha256: SHA_A, retrievedOn: '2026-09-01', effectiveFrom: null, state: 'candidate', facts: [fact()], checkedAt: null,
  collectedBy: 'adult-collector', checkedBy: null, pageTexts: ['secret page text'], ...over,
});
const build = input => buildVerifiedProductRecords({ today: TODAY, ...input });
const only = built => { assert.equal(built.records.length, 1); return built.records[0]; };

test('contract id and state vocabulary', () => {
  assert.equal(VERIFIED_RECORDS_VERSION, 'verified-product-records/v1');
  for (const s of ['verified', 'unverified', 'stale', 'superseded', 'conflicting', 'unknown']) assert.ok(VERIFIED_RECORD_STATES.includes(s));
});

test('verified: value, exact citation and independence flag', () => {
  const built = build({ verified: [verifiedEntry()] });
  assert.equal(assertVerifiedProductRecordsContract(built), true);
  const record = only(built);
  assert.equal(record.state, 'verified');
  assert.equal(record.independentlyChecked, true);
  const [f] = record.facts;
  assert.deepEqual(f.value, { kind: 'percent_of_sum_insured', basisPoints: 100 });
  assert.equal(f.candidateValue, null);
  assert.deepEqual(f.citation, {
    uin: UIN, wordingVersion: 'v1', page: 4, quote: QUOTE, contentSha256: SHA_A, sourceVersionId: 'src-v1', retrievedOn: '2026-09-01', checkedAt: '2026-09-02T10:00:00.000Z',
  });
  assert.equal(built.counts.verified, 1);
});

test('unverified: candidate value only, never a value; the record flag and published state do not prove', () => {
  for (const state of ['collected', 'candidate', 'checked', 'published']) {
    const record = only(build({ submissions: [submission({ state, verified: true, checkedBy: 'adult-checker', checkedAt: '2026-09-02T10:00:00.000Z' })] }));
    assert.equal(record.state, 'unverified', state);
    assert.equal(record.independentlyChecked, false);
    assert.equal(record.facts[0].value, null);
    assert.deepEqual(record.facts[0].candidateValue, { kind: 'percent_of_sum_insured', basisPoints: 100 });
  }
  const bare = only(build({ submissions: [submission({ state: 'collected', facts: [] })] }));
  assert.equal(bare.state, 'unverified');
  assert.deepEqual(bare.facts, []);
});

test('a verified-channel record checked by its own collector is downgraded to unverified', () => {
  const same = only(build({ verified: [verifiedEntry({ checkedBy: 'adult-collector' })] }));
  assert.equal(same.state, 'unverified');
  assert.equal(same.facts[0].value, null);
  const flagless = only(build({ verified: [verifiedEntry({}, { verified: false })] }));
  assert.equal(flagless.state, 'unverified');
});

test('stale: freshness not current withholds the value but keeps the citation', () => {
  const old = only(build({ verified: [verifiedEntry({ retrievedOn: '2025-01-01', checkedOn: '2025-01-02' })] }));
  assert.equal(old.state, 'stale');
  assert.equal(old.freshness, 'stale');
  assert.equal(old.facts[0].value, null);
  assert.equal(old.facts[0].candidateValue, null);
  assert.equal(old.facts[0].citation.quote, QUOTE);
  const future = only(build({ verified: [verifiedEntry({ effectiveFrom: '2027-01-01' })] }));
  assert.equal(future.state, 'stale');
  assert.deepEqual(future.reasons, ['freshness_not_yet_effective']);
  const revalidate = only(build({ submissions: [submission({ state: 'needs_revalidation' })] }));
  assert.equal(revalidate.state, 'stale');
  assert.deepEqual(revalidate.reasons, ['needs_revalidation']);
  assert.equal(revalidate.facts.length, 0);
});

test('superseded chain: old wording history, successor decides, and a lone superseded stays superseded', () => {
  const chain = only(build({
    verified: [verifiedEntry({ contentSha256: SHA_B })],
    submissions: [submission({ state: 'superseded', contentSha256: SHA_A, sourceVersionId: 'src-old' })],
  }));
  assert.equal(chain.state, 'verified');
  assert.deepEqual(chain.history, [{ state: 'superseded', contentSha256: SHA_A, sourceVersionId: 'src-old' }]);
  const lone = only(build({ submissions: [submission({ state: 'superseded' })] }));
  assert.equal(lone.state, 'superseded');
  assert.equal(lone.facts.length, 0);
  assert.equal(lone.independentlyChecked, false);
  const flagged = only(build({ verified: [verifiedEntry()] .map(e => ({ ...e, freshness: 'superseded' })) }));
  assert.equal(flagged.state, 'superseded');
  assert.equal(flagged.freshness, 'superseded');
  assert.equal(flagged.facts[0].value, null);
});

test('rejected is its own state and never usable', () => {
  const record = only(build({ submissions: [submission({ state: 'rejected' })] }));
  assert.equal(record.state, 'rejected');
  assert.equal(record.facts.length, 0);
});

test('conflict: two distinct source digests for the same UIN and version', () => {
  const built = build({ verified: [verifiedEntry()], submissions: [submission({ contentSha256: SHA_B })] });
  assertVerifiedProductRecordsContract(built);
  const record = only(built);
  assert.equal(record.state, 'conflicting');
  assert.deepEqual(record.conflicts, [{ kind: 'source_digest', factType: null, topic: null, digests: [SHA_A, SHA_B] }]);
  assert.ok(record.facts.length >= 1);
  assert.ok(record.facts.every(f => f.value === null && f.candidateValue === null));
  assert.equal(record.contentSha256, null);
  assert.equal(record.independentlyChecked, false);
});

test('conflict: same digest but two values for one factType and topic', () => {
  const record = only(build({ verified: [verifiedEntry({ facts: [fact(), fact({ value: { kind: 'percent_of_sum_insured', basisPoints: 200 }, page: 5 })] })] }));
  assert.equal(record.state, 'conflicting');
  assert.equal(record.conflicts[0].kind, 'fact_value');
  assert.equal(record.conflicts[0].factType, 'room_rent_limit');
  assert.equal(record.conflicts[0].digests.length, 2);
  assert.ok(record.facts.every(f => f.value === null));
  // Different topics for one factType are not a conflict.
  const fine = only(build({ verified: [verifiedEntry({ facts: [fact(), fact({ topic: 'icu', value: { kind: 'actuals' } })] })] }));
  assert.equal(fine.state, 'verified');
});

test('same version, identical digest in both channels is not a conflict and stays verified', () => {
  const record = only(build({ verified: [verifiedEntry()], submissions: [submission({ state: 'published' })] }));
  assert.equal(record.state, 'verified');
  assert.equal(record.facts.length, 1);
});

test('unknown: a requested key with no record; and no value is invented', () => {
  const built = build({ requested: [{ uin: 'SYNTHHLIP26010V012526', wordingVersion: 'v1' }, { uin: UIN, wordingVersion: 'v1' }], verified: [verifiedEntry()] });
  assertVerifiedProductRecordsContract(built);
  assert.equal(built.records.length, 2);
  const unknown = built.records.find(r => r.state === 'unknown');
  assert.equal(unknown.uin, 'SYNTHHLIP26010V012526');
  assert.deepEqual(unknown.facts, []);
  assert.equal(unknown.independentlyChecked, false);
  assert.equal(built.counts.unknown, 1);
  assert.equal(build({}).records.length, 0);
});

test('one record per UIN and version; different versions stay separate', () => {
  const built = build({ verified: [verifiedEntry(), verifiedEntry({ wordingVersion: 'v2', contentSha256: SHA_C })] });
  assert.deepEqual(built.records.map(r => r.wordingVersion), ['v1', 'v2']);
  assert.ok(built.records.every(r => r.state === 'verified'));
});

test('citations are preserved exactly, including whitespace and unusual characters', () => {
  const quote = '  Co-payment of 10% applies\tto claims for age >= 60; see "Annex 2".  ';
  const record = only(build({ verified: [verifiedEntry({ facts: [fact({ factType: 'copay', topic: 'senior', value: { basisPoints: 1000 }, quote, page: 12 })] })] }));
  assert.equal(record.facts[0].citation.quote, quote);
  assert.equal(record.facts[0].citation.page, 12);
});

test('output is deterministic, sorted and independent of input order', () => {
  const a = verifiedEntry({ uin: 'SYNTHHLIP26011V012526', facts: [fact({ factType: 'copay', value: { basisPoints: 500 }, topic: 'x' }), fact()] });
  const b = verifiedEntry({ wordingVersion: 'v2', contentSha256: SHA_B });
  const c = verifiedEntry();
  const one = build({ verified: [a, b, c] });
  const two = build({ verified: [c, a, b] });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(one), JSON.stringify(two));
  assert.deepEqual(one.records.map(r => `${r.uin}/${r.wordingVersion}`), [`${UIN}/v1`, `${UIN}/v2`, 'SYNTHHLIP26011V012526/v1']);
  assert.deepEqual(one.records[2].facts.map(f => f.factType), ['copay', 'room_rent_limit']);
});

test('output is deeply frozen and inputs are neither mutated nor shared', () => {
  const entry = verifiedEntry();
  const before = JSON.stringify(entry);
  const built = build({ verified: [entry] });
  assert.equal(JSON.stringify(entry), before);
  assert.ok(Object.isFrozen(built) && Object.isFrozen(built.records[0]) && Object.isFrozen(built.records[0].facts[0].value));
  assert.ok(!Object.isFrozen(entry.product.facts[0].value));
  assert.throws(() => { 'use strict'; built.records[0].state = 'unverified'; }, TypeError);
});

test('no household, adult, page-text or byte fields reach the output', () => {
  const dirty = verifiedEntry({}, { householdId: 'hh-1', policyNumber: 'POL-123' });
  dirty.product.householdId = 'hh-1';
  dirty.product.pageTexts = ['full page text'];
  const built = build({ verified: [dirty], submissions: [submission({ state: 'rejected', bytes: 'x', householdId: 'hh-2' })] });
  const json = JSON.stringify(built);
  for (const leak of ['hh-1', 'hh-2', 'POL-123', 'full page text', 'secret page text', 'adult-collector', 'adult-checker', 'pageTexts', 'collectedBy', 'checkedBy']) assert.ok(!json.includes(leak), leak);
  assertVerifiedProductRecordsContract(built);
});

test('assertion refuses foreign versions, unknown states and non-read-only contracts', () => {
  const clone = () => structuredClone(build({ verified: [verifiedEntry()] }));
  assert.throws(() => assertVerifiedProductRecordsContract({ ...clone(), contractVersion: 'verified-product-records/v2' }), /version/);
  assert.throws(() => assertVerifiedProductRecordsContract(null), /version/);
  const unknownState = clone(); unknownState.records[0].state = 'approved';
  assert.throws(() => assertVerifiedProductRecordsContract(unknownState), /state approved/);
  const writable = clone(); writable.readOnly = false;
  assert.throws(() => assertVerifiedProductRecordsContract(writable), /read-only/);
});

test('assertion refuses a value on a non-verified record and a candidate value outside unverified', () => {
  const stale = structuredClone(build({ verified: [verifiedEntry({ retrievedOn: '2025-01-01', checkedOn: '2025-01-02' })] }));
  stale.records[0].facts[0].value = { kind: 'actuals' };
  assert.throws(() => assertVerifiedProductRecordsContract(stale), /value only on a verified record/);
  const unverified = structuredClone(build({ submissions: [submission()] }));
  unverified.records[0].facts[0].value = { kind: 'actuals' };
  assert.throws(() => assertVerifiedProductRecordsContract(unverified), /value only on a verified record/);
  const candidate = structuredClone(build({ verified: [verifiedEntry()] }));
  candidate.records[0].facts[0].candidateValue = { kind: 'actuals' };
  assert.throws(() => assertVerifiedProductRecordsContract(candidate), /candidate value leaked/);
  const forged = structuredClone(build({ submissions: [submission()] }));
  forged.records[0].state = 'verified';
  assert.throws(() => assertVerifiedProductRecordsContract(forged), /independentlyChecked|state must equal/);
});

test('assertion refuses a verified fact with a missing or incomplete citation', () => {
  for (const [field, bad] of [['quote', ''], ['page', 0], ['contentSha256', 'nope'], ['sourceVersionId', ''], ['checkedAt', null], ['retrievedOn', '2026-13-01']]) {
    const built = structuredClone(build({ verified: [verifiedEntry()] }));
    built.records[0].facts[0].citation[field] = bad;
    assert.throws(() => assertVerifiedProductRecordsContract(built), /citation incomplete|checkedAt/, field);
  }
  const noCitation = structuredClone(build({ verified: [verifiedEntry()] }));
  delete noCitation.records[0].facts[0].citation;
  assert.throws(() => assertVerifiedProductRecordsContract(noCitation));
});

test('assertion refuses any field outside the allowlist, so household data cannot leak in', () => {
  const inject = (path, key, value) => {
    const built = structuredClone(build({ verified: [verifiedEntry()] }));
    const target = path(built);
    target[key] = value;
    return built;
  };
  const levels = { top: b => b, record: b => b.records[0], fact: b => b.records[0].facts[0], citation: b => b.records[0].facts[0].citation };
  for (const [level, path] of Object.entries(levels)) {
    for (const key of ['householdId', 'adultUserId', 'policyNumber', 'collectedBy', 'checkedBy', 'pageTexts', 'note']) {
      assert.throws(() => assertVerifiedProductRecordsContract(inject(path, key, 'x')), /forbidden field|not allowed/, `${level}.${key}`);
    }
  }
  // Even inside a typed value.
  const inValue = structuredClone(build({ verified: [verifiedEntry()] }));
  inValue.records[0].facts[0].value.householdId = 'hh-1';
  assert.throws(() => assertVerifiedProductRecordsContract(inValue), /forbidden field/);
  const missing = structuredClone(build({ verified: [verifiedEntry()] }));
  delete missing.records[0].facts[0].candidateValue;
  assert.throws(() => assertVerifiedProductRecordsContract(missing), /missing/);
});

test('assertion refuses unsorted, duplicate or miscounted output', () => {
  const built = structuredClone(build({ verified: [verifiedEntry(), verifiedEntry({ wordingVersion: 'v2', contentSha256: SHA_B })] }));
  const reversed = { ...built, records: [...built.records].reverse() };
  assert.throws(() => assertVerifiedProductRecordsContract(reversed), /sorted/);
  const duplicate = { ...built, records: [built.records[0], built.records[0]] };
  assert.throws(() => assertVerifiedProductRecordsContract(duplicate), /sorted and unique/);
  const miscount = structuredClone(built); miscount.counts.verified = 5;
  assert.throws(() => assertVerifiedProductRecordsContract(miscount), /counts/);
});

test('builder fails closed on malformed, unknown-state or household-typed input', () => {
  assert.throws(() => buildVerifiedProductRecords({ verified: [] }), /today/);
  assert.throws(() => build({ submissions: [submission({ state: 'approved' })] }), /state is unknown/);
  assert.throws(() => build({ submissions: [submission({ uin: 'bad' })] }), /uin/);
  assert.throws(() => build({ submissions: [submission({ contentSha256: 'xyz' })] }), /contentSha256/);
  assert.throws(() => build({ submissions: [submission({ facts: [fact({ factType: 'sum_insured', value: { amountMinor: 1, currency: 'INR' } })] })] }), /unsupported factType/);
  assert.throws(() => build({ verified: [verifiedEntry({ facts: [fact({ quote: 'short' })] })] }), /quote/);
  assert.throws(() => build({ verified: [{ product: null }] }), /listVerified/);
  assert.throws(() => build({ requested: [{ uin: 'x' }] }), /requested/);
});

test('no clock: the same input on a different today changes only freshness-derived output', () => {
  const entry = verifiedEntry();
  assert.equal(only(buildVerifiedProductRecords({ verified: [entry], today: '2026-10-21' })).state, 'verified');
  assert.equal(only(buildVerifiedProductRecords({ verified: [entry], today: '2028-10-21' })).state, 'stale');
});
