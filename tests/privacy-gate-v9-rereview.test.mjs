// Privacy gate v9 independent re-review: variants of the first round's probes. Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceForModel, sanitizeEvidenceTextForStorage } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { assembleAnswer } from '../src/features/policy-evidence/investigate.js';
import { createCoverageAnalysisSourceInput } from '../src/features/coverage-analysis/source-input.js';
import { TOKENIZED_PROBES } from './support/privacy-probes.mjs';

const storage = (text, options = {}) => sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [], ...options }).text;
const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: true, registryVersion: 'policy-parameters/v1' });
const modelInput = (text, upstream = []) => ({
  context: { caseId: 'case-1', subjectId: 'subject-1', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-1', version: 'v1', page: 1, text, status: 'known' }],
  upstream,
});
const toModel = (text, options = {}) => sanitizeEvidenceForModel(modelInput(text), { resolveParameterPolicy: policy, ...options });
const code = expected => error => error?.code === expected;

// RED 1: a placeholder with whitespace around it must not split a value on the model path.
for (const text of ['OTP is 12 <NAME_1> 3456', 'Card 4111 1111 <NAME_1> 1111 1111', '98765 <PHONE_1> 43210']) {
  test(`model path refuses a whitespace-split placeholder: ${text}`, () => {
    assert.throws(() => toModel(text), code('RESTRICTED_EVIDENCE'));
    assert.throws(() => toModel(text, { regated: true }), code('RESTRICTED_EVIDENCE'));
    assert.throws(() => storage(text, { regate: true }), code('RESTRICTED_EVIDENCE'));
  });
}
test('model path refuses raw placeholder syntax unless the text is marked regated', () => {
  assert.throws(() => toModel('Room rent <NAME_1> is covered'), code('RESTRICTED_EVIDENCE'));
  assert.throws(() => sanitizeEvidenceForModel(modelInput('Room limit is 5000.', [{ note: 'for <NAME_1>' }]), { resolveParameterPolicy: policy }), code('RESTRICTED_EVIDENCE'));
  assert.doesNotThrow(() => toModel('1 <NAME_1> Self 500000 <DOB_1>', { regated: true }));
});

// RED 2-3: label glued to its value, or prefixed by a word character.
for (const text of ['OTP123456', 'otp123456 please', 'UPIPIN1234', 'DB_PASSWORD=hunter22xyz', 'MY_API_KEY=abcdefgh1234', 'password=hunter22xyz']) {
  test(`restricted label variant: ${text}`, () => {
    assert.throws(() => storage(text), code('RESTRICTED_EVIDENCE'));
    assert.throws(() => toModel(text), code('RESTRICTED_EVIDENCE'));
  });
}
test('restricted-label lookarounds keep ordinary words usable', () => {
  assert.equal(storage('Hotpot 123 and potpourri 4567 are listed.'), 'Hotpot 123 and potpourri 4567 are listed.');
});

// RED 4: PIN label with no separator.
for (const text of ['Pin code 560001', 'Pincode 560001', 'PIN 560 001', 'Postal code 560001']) {
  test(`labelled PIN without separator: ${text}`, () => {
    const out = storage(text);
    assert.match(out, /<ADDRESS_1>/);
    assert.ok(!/560\s?001/.test(out), out);
  });
}

// RED 5: house number with slash/letter, at the end of the text or after leading words.
for (const text of ['12/A, Shivaji Park', 'Lives at 12/A, Shivaji Park', 'Lives at 12/A, Shivaji Park, Mumbai.', 'Resident of 7-B, Lake View Road']) {
  test(`unlabelled address: ${text}`, () => {
    const out = storage(text);
    assert.ok(!/Shivaji|Lake View|12\/A|7-B/.test(out), out);
  });
}
test('clause references that look like house numbers stay', () => {
  for (const text of ['See Clause 4/B, Gold Plan applies.', 'Annexure 2A, Table of Benefits applies.']) assert.equal(storage(text), text);
});

// YELLOW 6: structured text past the scan cap is refused, not cut.
test('upstream text past the scan cap is refused', () => {
  assert.throws(() => sanitizeEvidenceForModel(modelInput('Room limit is 5000.', [{ note: `${'word '.repeat(4000)}Aadhaar 2345 6789 0123` }]), {
    resolveParameterPolicy: policy, limits: { maxUpstreamBytes: 40_000, maxTotalBytes: 90_000 },
  }), code('EVIDENCE_SOURCE_LIMIT'));
});

// YELLOW 8: the answer takes the gated question only.
test('assembleAnswer requires the gated question', () => {
  assert.throws(() => assembleAnswer({ question: 'raw question?', findings: [], overrides: [], context: { clauses: [], path: [] }, checklist: [], rejected: 0, sweepCompleted: true, documentIds: [], completeness: {} }),
    error => /gated/i.test(error.message));
});

// YELLOW 9: upstream keys are field names from a fixed list, not data.
test('upstream keys that look like names are refused; decision fields pass', () => {
  for (const key of ['AshaExample', 'kavya_example', 'ravi.synthetic']) {
    assert.throws(() => sanitizeEvidenceForModel(modelInput('Room limit is 5000.', [{ [key]: 'x' }]), { resolveParameterPolicy: policy }), code('PRIVACY_GATE_MALFORMED'));
  }
  const decision = { kind: 'deterministic_routing_classification', route: 'ask_institution', score: 3, probabilityOfApproval: null, unknowns: [], dimensions: { immediacy: 'low', financialExposure: 'low', evidenceConfidence: 'high', coverageDeficiency: 'none', continuityRisk: 'low' } };
  assert.deepEqual(sanitizeEvidenceForModel(modelInput('Room limit is 5000.', [decision]), { resolveParameterPolicy: policy }).input.upstream[0], decision);
});

// YELLOW 10: name labels must not eat policy wording.
for (const text of ['Dependant: Spouse and children covered', 'Dependants: Not covered', 'Dependants: Spouse, children and parents are covered', 'Contact person: Not applicable']) {
  test(`policy wording after a name label survives: ${text}`, () => assert.equal(storage(text), text));
}
test('a real name after the new labels is still minimised', () => {
  assert.ok(!storage('Dependant: Asha Example').includes('Asha'));
  assert.ok(!storage('Contact person: Ravi Synthetic').includes('Ravi'));
});

// YELLOW 11: a source pack with no identifier list fails with a coded error, not as silently unusable pages.
test('source input without knownIdentifiers fails with a coded error', () => {
  const page = { document_upload_id: 'doc-1', page_number: 1, extracted_text: 'Room rent limit is 5000.' };
  assert.throws(() => createCoverageAnalysisSourceInput({ id: 'case-1', consent_grant_id: 'grant-1' }, [page]), code('PRIVACY_GATE_MALFORMED'));
});

// Question 12: gate output never puts a minted placeholder next to a digit.
test('gate-minted placeholders are never adjacent to a digit', () => {
  const corpus = [
    ...Object.values(TOKENIZED_PROBES).map(([phrase]) => `${phrase}. Room rent limit is 5000.`),
    'Mobile9876543210 and Phone9876543210 noted', 'ID234567890123 noted', 'UIDAI2345 6789 0123 noted', 'CONTACT98765 43210 end',
    '1. Kavya Placeholder Self 01/02/1990 500000\n2. Ravi Synthetic Spouse 03/04/1988 500000', 'Pincode: 560001 then 500000',
    'Address: Flat 12 Example Heights. Testville 560001 500000', '+91 9876543210 5000', 'Aadhaar 2345 6789 0123 5000', 'Room 5000 Mobile 9876543210 Day 3',
  ];
  const adjacent = /\p{N}<[A-Z_]+_\d+>|<[A-Z_]+_\d+>\p{N}/u;
  for (const text of corpus) {
    const out = storage(text);
    assert.ok(!adjacent.test(out), out);
    assert.doesNotThrow(() => storage(out, { regate: true }), out);
  }
});
