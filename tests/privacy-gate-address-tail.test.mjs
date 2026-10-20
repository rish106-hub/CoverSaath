// Privacy finding P1 (block 2 close-out audit): the locality, PIN and partially
// masked phone that follow a labelled address must not survive the gate.
// Every value below is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceForModel } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { sanitizeEvidenceTextForStorage } from './support/storage-gate.mjs';

const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: { allowed: true }, registryVersion: 'policy-parameters/v1' });
const toModelText = text => sanitizeEvidenceForModel({
  context: { caseId: 'case-p1', subjectId: 'subject-p1', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-p1', version: 'v1', page: 1, text, status: 'known' }],
  upstream: [],
}, { resolveParameterPolicy: policy }).input.sources[0].text;
const storageText = text => sanitizeEvidenceTextForStorage(text).text;
const both = [['storage', storageText], ['model', toModelText]];

const LEAKS = ['Testville', 'Sample Nagar', 'Example Heights', '560001', '560 001', 'Karnataka', 'XXX-XXX-1234', '1234'];

const ADDRESS_LEAK_CASES = [
  ['tail after a full stop', 'Communication Address: Flat 12 Example Heights. Sample Nagar, Testville-560001, Karnataka\nPolicy No: ABC123456'],
  ['tail glued CITY-PIN after semicolon', 'Address: 12 Example Road; Testville-560001 Karnataka'],
  ['wrapped over two lines', 'Communication Address: Flat 12, Example Heights\nSample Nagar, Testville-560001 Karnataka\nPolicy No: ABC123456'],
  ['wrapped over three lines', 'Address: Flat 12.\nExample Heights, Sample Nagar\nTestville 560 001\nKarnataka'],
  ['partially masked phone after PIN', 'Communication Address: Flat 12 Example Heights. Testville-560001 Mobile XXX-XXX-1234'],
  ['masked phone on its own continuation line', 'Address: Flat 12 Example Heights\nTestville-560001\nMobile: XXX-XXX-1234'],
  ['PIN alone after address token', 'Address: Flat 12 Example Heights. 560001'],
];

for (const [label, text] of ADDRESS_LEAK_CASES) {
  for (const [path, run] of both) {
    test(`P1 ${path}: ${label}`, () => {
      const out = run(text);
      assert.match(out, /<ADDRESS_[1-9][0-9]*>/, out);
      for (const leak of LEAKS) assert.ok(!out.includes(leak), `"${leak}" survived in ${JSON.stringify(out)}`);
    });
  }
}

test('P1: following field labels and values stay usable', () => {
  const out = storageText('Communication Address: Flat 12 Example Heights. Sample Nagar, Testville-560001\nPolicy No: ABC123456\nSum insured: 500000');
  assert.match(out, /Sum insured: 500000/);
  assert.match(out, /Policy No: <IDENTIFIER_[1-9][0-9]*>/);
});

test('P1: public insurer numbers near an address are not masked', () => {
  const text = [
    'Communication Address: Flat 12 Example Heights. Testville-560001',
    'UIN: EXAMPLEHLIP20001V012021',
    'Toll-free helpline 1800 123 4567',
    'Stamp duty reference 100500 paid by endorsement',
    'Sum insured is 500000 for the family',
  ].join('\n');
  const out = storageText(text);
  assert.ok(!out.includes('560001') && !out.includes('Testville'), out);
  assert.match(out, /UIN: EXAMPLEHLIP20001V012021/);
  assert.match(out, /helpline 1800 123 4567/);
  assert.match(out, /Stamp duty reference 100500 paid/);
  assert.match(out, /Sum insured is 500000 for the family/);
});

test('P1: same-line public numbers after an address stop at the sentence', () => {
  const out = storageText('Address: Flat 12 Example Heights. UIN: EXAMPLEHLIP20001V012021. Helpline 1800 123 4567.');
  assert.match(out, /UIN: EXAMPLEHLIP20001V012021/);
  assert.match(out, /Helpline 1800 123 4567/);
});

test('P1: address token followed by plain prose is untouched', () => {
  const out = storageText('Address: Flat 12 Example Heights.\nRoom rent is limited to 5000 per day.');
  assert.match(out, /Room rent is limited to 5000 per day\./);
});

test('P1: many address labels stay linear', () => {
  const text = `${'Address: Flat 12 Example Heights\nSample Nagar\n'.repeat(1200)}`;
  const started = performance.now();
  sanitizeEvidenceTextForStorage(text.slice(0, 15_000), { maxBytes: 16_000 });
  assert.ok(performance.now() - started < 1500);
});

test('P1: long mask runs after an address do not backtrack', () => {
  for (const mask of ['X', '*', '•', 'X-', 'X ']) {
    const text = `${`Address: A. Xx ${mask.repeat(200)}\n`.repeat(70)}`.slice(0, 15_000);
    const started = performance.now();
    // Since gate v7 a mask run the gate cannot judge is refused; the timing bound still applies to either outcome.
    try { sanitizeEvidenceTextForStorage(text, { maxBytes: 16_000 }); } catch (error) { assert.equal(error.code, 'PRIVACY_ADDRESS_UNCERTAIN'); }
    assert.ok(performance.now() - started < 1000, `mask ${JSON.stringify(mask)} too slow`);
  }
});

test('P1: lowercase locality with a PIN is absorbed', () => {
  const out = storageText('Address: Flat 12 Example Heights. sample nagar, testville-560001 karnataka');
  assert.ok(!out.includes('testville') && !out.includes('560001') && !out.includes('karnataka'), out);
});

test('P1: customer care number after an address stays', () => {
  const out = storageText('Address: Flat 12 Example Heights. Testville-560001\nCustomer Care 1800 120 123456');
  assert.match(out, /Customer Care 1800 120 123456/);
});
