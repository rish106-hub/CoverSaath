// Privacy gate v9 third review: over-masking of clause references, credential/OTP/card variants, separators, digest key.
// Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceForModel, sanitizeEvidenceTextForStorage } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { createPolicyEvidenceService } from '../src/backend/services/policy-evidence-service.js';

const storage = text => sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [] }).text;
const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: true, registryVersion: 'policy-parameters/v1' });
const toModel = text => sanitizeEvidenceForModel({
  context: { caseId: 'case-1', subjectId: 'subject-1', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-1', version: 'v1', page: 1, text, status: 'known' }], upstream: [],
}, { resolveParameterPolicy: policy });
const restricted = error => error?.code === 'RESTRICTED_EVIDENCE';

// 1: clause references with a house-number shape stay.
for (const text of [
  'Exclusion 7-B, Cosmetic Surgery is not covered', 'Room Category 2A, Single Private room', 'Ward 4A, Ground Floor',
  'Policy wording version 4A, Annexure 7-B, Table 3', 'Benefit 3C, Day Care Procedures apply', 'Cover 2B, Maternity Expenses apply', 'Class 1A, Standard Room', 'Type 5B, Deluxe Room',
]) test(`clause reference survives: ${text}`, () => assert.equal(storage(text), text));
test('a house address with a locality suffix still goes', () => assert.ok(!storage('Lives at 12/A, Shivaji Park').includes('Shivaji')));

// 2: camel-case and snake-case credential keys.
for (const text of ['dbPassword=hunter22xyz', 'apiKeyValue=abcdefghij', 'my_secret_value=abcdefghijkl', '"dbPassword": "hunter22xyz"', 'user.access_token=abcdefghijkl', 'authToken: abcdefghijkl']) {
  test(`credential key variant: ${text}`, () => {
    assert.throws(() => storage(text), restricted);
    assert.throws(() => toModel(text), restricted);
  });
}
test('ordinary words that contain a credential word stay', () => {
  assert.equal(storage('Secretary: Rakesh Kumar is listed'.replace('Rakesh Kumar', 'covered')), 'Secretary: covered is listed');
  assert.equal(storage('Tokenisation: supported everywhere'), 'Tokenisation: supported everywhere');
});

// 3: OTP prose, hyphen and grouped forms.
for (const text of ['OTP is: 123456', 'OTP code is 123456', 'your OTP for login is 123456', 'OTP code 123456', 'otp-123456', 'CVC-123', 'OTP is 1 2 3 4 5 6', 'OTP is 12 3456', 'verification code 123456', 'CVV: 123']) {
  test(`OTP form: ${text}`, () => {
    assert.throws(() => storage(text), restricted);
    assert.throws(() => toModel(text), restricted);
  });
}
for (const text of ['Do not share your OTP, CVV or PIN', 'OTP verification for claims above 5000 is required', 'Cashless OTP service available 24 hours']) {
  test(`OTP wording survives: ${text}`, () => assert.equal(storage(text), text));
}

// 4: other separators between digit groups.
test('card number split by newlines is refused', () => assert.throws(() => storage('Card\n4111\n1111\n1111\n1111'), restricted));
for (const text of ['98765\n43210', '98765_43210', 'tel 98765/43210', 'call 98765·43210']) {
  test(`phone separator: ${JSON.stringify(text)}`, () => {
    assert.ok(!/98765|43210/.test(storage(text)), storage(text));
    assert.ok(!/98765|43210/.test(toModel(text).input.sources[0].text));
  });
}
test('dates and amounts with slashes stay', () => assert.equal(storage('Premium 12/10/2024 and 5000/6000 per year'), 'Premium 12/10/2024 and 5000/6000 per year'));

// 5: the request-digest key must be a real key.
test('a short document key is refused with a coded error', () => {
  for (const key of ['c2hvcnQ=', Buffer.alloc(31, 7).toString('base64')]) {
    assert.throws(() => createPolicyEvidenceService({ services: { clauses: {} }, loadKnownIdentifiers() {}, createModelCall() {}, env: { DOCUMENT_ENCRYPTION_KEY_BASE64: key } }),
      error => error?.code === 'POLICY_EVIDENCE_CONFIG_INVALID');
  }
  assert.doesNotThrow(() => createPolicyEvidenceService({ services: { clauses: {} }, loadKnownIdentifiers() {}, createModelCall() {}, env: { DOCUMENT_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64') } }));
});
