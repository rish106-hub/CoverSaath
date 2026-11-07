// ADR 0017 D6 / corpus P7: an independent detector (tests/support/second-detector.mjs, written without the gate's
// patterns) must find nothing in what the gate lets through. CI only; never imported by src/. Synthetic data only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { gateText } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { CORPUS } from './support/privacy-corpus.mjs';
import { detect, skeletonText } from './support/second-detector.mjs';

// Names the detector hunts for: the row's known names plus every letters-only secret of a name row.
function knownFor(row) {
  const names = row.mustNotContain.filter(secret => /^[\p{L}\p{M}.]+(?: [\p{L}\p{M}.]+)*$/u.test(secret) && ['name_latin', 'name_devanagari', 'name_variant', 'member_table'].includes(row.category));
  return [...row.knownIdentifiers, ...names.map(value => ({ kind: 'NAME', value }))];
}

// Rows whose raw input the detector cannot be expected to flag, each with the reason.
const SELF_TEST_EXEMPT = new Map([
  ['masked_keep_last_four_is_a_leak', 'a masked number has no secret fragment to find'],
  ['duplicated_digits_redacted_fail_closed', 'eleven digits with a repeated run is no shape the detector knows'],
  ['ocr_zero_for_o', 'a PAN with a digit for a letter is outside the detector shapes'],
  ['combining_mark_after_digit', 'combining marks split the digits into separate tokens'],
]);

test('self-test: on the raw input of every redact row the detector reports a hit (it is not a no-op)', () => {
  const silent = [];
  for (const row of CORPUS.filter(candidate => candidate.expect === 'redact' && !SELF_TEST_EXEMPT.has(candidate.variant))) {
    if (detect(row.input, knownFor(row)).length === 0) silent.push(`${row.id} ${row.variant}`);
  }
  assert.deepEqual(silent, []);
});

test('self-test: the detector keeps quiet on policy wording', () => {
  for (const wording of ['Sum insured: 500000', 'Waiting period of 24 months', 'Toll free 1800 123 4567', 'Policy period 2026 to 2027', 'Room rent 1% of SI']) {
    assert.deepEqual(detect(wording), [], wording);
  }
});

test('P7: nothing the gate lets through trips the second detector', () => {
  const failures = [];
  for (const row of CORPUS.filter(candidate => candidate.expect === 'redact' && candidate.status === 'enforced')) {
    const output = gateText(row.input, { knownIdentifiers: row.knownIdentifiers }).text;
    const hits = detect(output, knownFor(row));
    if (hits.length) failures.push(`${row.id} ${row.variant}: ${[...new Set(hits.map(hit => hit.kind))].join(',')}`);
  }
  assert.deepEqual(failures, []);
});

test('skeleton: digits of other scripts fold to ASCII and format characters vanish', () => {
  assert.equal(skeletonText('आधार २३४५​ ६७८९'), 'आधार 2345 6789');
  assert.equal(skeletonText('a <PHONE_1> b'), 'a \u0001 b');
});

test('detector shapes: each identifier shape is found, with offsets only', () => {
  const cases = [
    ['Aadhaar 2345 6789 0123', 'aadhaar'], ['call 98765 43210', 'mobile'], ['call +91-9876543210', 'mobile'], ['ABHA 91-2345-6789-0123', 'abha'],
    ['VID 2345678901234567', 'vid'], ['PAN ABCPE 1234 F', 'pan'], ['IFSC SBIN0001234', 'ifsc'], ['mail meera.synthetic@example.test', 'email'],
    ['ABHA address meera.synthetic@abdm', 'email'], ['Account number 001234567890', 'account'],
  ];
  for (const [text, kind] of cases) {
    const hits = detect(text);
    assert.ok(hits.some(hit => hit.kind === kind), `${kind} in ${text}`);
    assert.ok(hits.every(hit => Object.keys(hit).sort().join() === 'at,kind'));
  }
  assert.ok(detect('Rahul Fakenam', [{ kind: 'NAME', value: 'Rahul Fakename' }]).some(hit => hit.kind === 'name'));
  assert.ok(detect('R. Fakename', [{ kind: 'NAME', value: 'Rahul Fakename' }]).some(hit => hit.kind === 'name_initial'));
  assert.ok(detect('राहुल', [{ kind: 'NAME', value: 'Rahul Fakename' }]).some(hit => hit.kind === 'name'));
  assert.ok(detect('born 14 May 1978', [{ kind: 'DOB', value: '1978-05-14' }]).some(hit => hit.kind === 'dob'));
});
