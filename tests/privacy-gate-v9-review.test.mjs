// Privacy gate v9 independent-review findings (RED 1-2, YELLOW 3-10). Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sanitizeEvidenceForModel, sanitizeEvidenceTextForStorage } from '../src/features/ai-analysis/privacy-evidence-gate.js';

const storage = (text, options = {}) => sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [], ...options }).text;
const regate = (text, options = {}) => storage(text, { regate: true, ...options });
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: true, registryVersion: 'policy-parameters/v1' });
const modelInput = (text, extra = {}) => ({
  context: { caseId: 'case-1', subjectId: 'subject-1', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-1', version: 'v1', page: 1, text, status: 'known' }],
  upstream: [],
  ...extra,
});
const toModel = (text, options = {}) => sanitizeEvidenceForModel(modelInput(text), { resolveParameterPolicy: policy, ...options });
const restricted = error => error?.code === 'RESTRICTED_EVIDENCE';

// RED 1: digit runs glued to a letter.
for (const [text, leak] of [
  ['Mobile9876543210', '9876543210'],
  ['Phone9876543210 noted', '9876543210'],
  ['ID234567890123 noted', '234567890123'],
  ['UIDAI2345 6789 0123 noted', '6789 0123'],
  ['CONTACT98765 43210 end', '43210'],
]) {
  test(`glued digits: ${text}`, () => {
    assert.ok(!storage(text).includes(leak), storage(text));
    assert.ok(!toModel(text).input.sources[0].text.includes(leak));
  });
}

// RED 2: restricted material split by a literal placeholder.
for (const text of ['password=abc<NAME_1>xyz123456', 'Bearer abcdefgh<NAME_1>ijklmnopqrstuvwx', 'OTP is 12<NAME_1>3456']) {
  test(`placeholder-split credential refused: ${text}`, () => {
    assert.throws(() => regate(text), restricted);
    assert.throws(() => toModel(text), restricted);
    assert.throws(() => storage(text), restricted);
  });
}
test('placeholder-split phone is refused, not left raw', () => {
  assert.throws(() => regate('Mobile: 98765<PHONE_1>43210'), restricted);
  assert.throws(() => toModel('Mobile: 98765<PHONE_1>43210'), restricted);
});
test('raw input with placeholder or legacy-token syntax is refused on first storage pass', () => {
  assert.throws(() => storage('Room rent <NAME_1> is covered'), restricted);
  assert.throws(() => storage(`Room rent <ID:${'a'.repeat(16)}> is covered`), restricted);
});
test('gate-minted tokens may be re-sanitised', () => {
  const first = storage('Patient name: Asha Example. Room limit is 5000.');
  assert.match(first, /<NAME_1>/);
  assert.equal(regate(first), first);
  assert.equal(toModel(first, { regated: true }).input.sources[0].text, first);
});

// YELLOW 3: labels.
for (const [text, leak] of [['Dependant: Asha Example', 'Asha'], ['Dependants: Asha Example', 'Asha'], ['Contact person: Ravi Synthetic', 'Ravi']]) {
  test(`name label: ${text}`, () => assert.ok(!storage(text).includes(leak), storage(text)));
}

// YELLOW 4: labelled PIN.
for (const text of ['Pincode: 560001', 'Pin code - 560 001', 'PIN code: 560001', 'Pin: 560001']) {
  test(`labelled PIN: ${text}`, () => {
    const out = storage(text);
    assert.match(out, /<ADDRESS_1>/);
    assert.ok(!/560\s?001/.test(out), out);
  });
}

// YELLOW 5: unlabelled address with no PIN or locality suffix.
test('unlabelled house/lane/city address followed by prose', () => {
  const out = storage('12/A, Shivaji Park, Mumbai is listed.');
  assert.ok(!out.includes('Shivaji'), out);
  assert.ok(!out.includes('12/A'), out);
});
test('plain amounts in a comma list are not masked', () => {
  assert.equal(storage('Room 5, Gold Plan, Silver Plan are listed.'), 'Room 5, Gold Plan, Silver Plan are listed.');
});

// YELLOW 6: storage callers must say which identifiers to minimise.
test('storage gate fails when knownIdentifiers is omitted', () => {
  assert.throws(() => sanitizeEvidenceTextForStorage('Room limit is 5000.'), error => error?.code === 'PRIVACY_GATE_MALFORMED');
  assert.doesNotThrow(() => sanitizeEvidenceTextForStorage('Room limit is 5000.', { knownIdentifiers: [] }));
});

// YELLOW 7: structured key normalisation.
const upstream = value => toModel('Room limit is 5000.', {}).input && sanitizeEvidenceForModel(modelInput('Room limit is 5000.', { upstream: [value] }), { resolveParameterPolicy: policy }).input.upstream[0];
for (const [key, value] of [
  ['patient_name', 'Asha Example'], ['member_name', 'Asha Example'], ['names', ['Asha Example', 'Ravi Synthetic']], ['date_of_birth', '1990-02-01'],
  ['birthDate', '1990-02-01'], ['pincode', '560001'], ['Patient-Name', 'Asha Example'], ['contact_person', 'Ravi Synthetic'],
]) {
  test(`structured key ${key}`, () => {
    const out = JSON.stringify(upstream({ [key]: value }));
    for (const leak of ['Asha', 'Ravi', '1990', '560001']) assert.ok(!out.includes(leak), out);
  });
}
test('nested name object under a sensitive key', () => {
  const out = JSON.stringify(upstream({ name: { first: 'Asha', last: 'Example' } }));
  assert.ok(!out.includes('Asha') && !out.includes('Example'), out);
});

// YELLOW 8: object keys.
test('object keys that carry personal data are refused', () => {
  assert.throws(() => upstream({ 'Asha Example': 'x' }), error => error?.code === 'PRIVACY_GATE_MALFORMED');
  assert.throws(() => upstream({ 9876543210: 'x' }), error => error?.code === 'PRIVACY_GATE_MALFORMED');
  assert.throws(() => sanitizeEvidenceForModel(modelInput('Room limit is 5000.', { upstream: [{ AshaExample: 'x' }] }), {
    resolveParameterPolicy: policy, knownIdentifiers: [{ kind: 'NAME', value: 'AshaExample' }],
  }), error => error?.code === 'PRIVACY_GATE_MALFORMED');
});

// YELLOW 9: model path must not send a truncated source.
test('model path refuses a source that was truncated', () => {
  assert.throws(() => toModel(`${'Room limit is 5000. '.repeat(400)}Aadhaar 2345 6789 0123`), error => error?.code === 'EVIDENCE_SOURCE_LIMIT');
  assert.throws(() => toModel(`${'Room limit is 5000. '.repeat(900)}`), error => error?.code === 'EVIDENCE_SOURCE_LIMIT');
});

// YELLOW 10: no digest of unredacted text.
test('audit and storage digests are of redacted text only', () => {
  const raw = 'Patient name: Asha Example. Room limit is 5000.';
  const stored = sanitizeEvidenceTextForStorage(raw, { knownIdentifiers: [] });
  assert.notEqual(stored.digest, sha(raw));
  assert.equal(stored.digest, sha(stored.text));
  const result = toModel(raw);
  assert.notEqual(result.audit.sources[0].digest, sha(raw));
  assert.equal(result.audit.sources[0].digest, sha(result.input.sources[0].text));
});
