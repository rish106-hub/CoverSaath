// Block 2 delta close-out, task 1: address cases the v6 tail rule did not cover.
// Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_EVIDENCE_GATE_VERSION, sanitizeEvidenceTextForStorage } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { buildClauses, investigate } from '../src/features/policy-evidence/index.js';

const storage = text => sanitizeEvidenceTextForStorage(text).text;

test('gate version is v7', () => assert.equal(PRIVACY_EVIDENCE_GATE_VERSION, 'knowvia-privacy-evidence-v7'));

const LEAKS = ['Testville', 'Sample Nagar', 'Example Heights', '560001', '560 001', 'Karnataka', 'टेस्टविले', '560-001', '5 6 0 0 0 1', '56 0001'];
const CASES = [
  ['tail with no PIN or phone', 'Communication Address: Flat 12 Example Heights. Sample Nagar, Testville, Karnataka\nPolicy No: ABC123456'],
  ['wrapped lines with no anchor', 'Address: Flat 12 Example Heights\nSample Nagar\nTestville\nKarnataka\nSum insured: 500000'],
  ['more than four continuation lines', 'Address: Flat 12\nExample Heights\nSample Nagar\nNear Example Temple\nOld Example Road\nTestville 560001'],
  ['PIN split 56 0001', 'Address: Flat 12 Example Heights. Testville 56 0001'],
  ['PIN split in single digits', 'Address: Flat 12 Example Heights. Testville 5 6 0 0 0 1'],
  ['PIN hyphenated', 'Address: Flat 12 Example Heights. Testville - 560-001'],
  ['PIN label with colon', 'Address: Flat 12 Example Heights. Testville PIN: 560001'],
  ['long tail', 'Address: Flat 12 Example Heights. Sample Nagar Extension Phase Two Behind Example Mall Opposite Example Park Lane Seven Cross Eight Main Road Area Testville 560001'],
  ['Devanagari with full stop', 'पता: मकान 12 उदाहरण नगर. टेस्टविले - 560001'],
  ['Devanagari tail on the next line', 'पता: मकान 12 उदाहरण नगर\nटेस्टविले, कर्नाटक 560001'],
  ['table cell with no address header', '| Proposer | Flat 12, Example Heights, Sample Nagar, Testville - 560001 |'],
  ['table cell under an address header', '| Insured Person | Address | Sum Insured |\n|---|---|---|\n| Asha Example | Flat 12 Example Heights, Testville-560001 | 500000 |'],
  ['unlabelled single line', 'Insured name below\nFlat 12, Example Heights, Sample Nagar, Testville - 560001, Karnataka'],
  ['house number "Plot No" in a labelled tail', 'Address: Flat 12. Plot No 5, Testville - 560001'],
  ['house number "Plot No" unlabelled', 'Plot No 5, Example Heights, Testville - 560001'],
  ['lone locality line after a labelled address', 'Address: Flat 12.\nTestville\nSum insured: 500000'],
  ['unlabelled, PIN split 56 0001', 'Flat 12, Example Heights, Testville - 56 0001'],
  ['unlabelled, PIN in single digits', 'Flat 12, Example Heights, Testville - 5 6 0 0 0 1'],
  ['address word "Bank" in the street', 'Flat 5, Bank Colony, Testville - 560001'],
  ['address after a long OCR run-on line', `Note ${'word '.repeat(150)}Flat 12, Example Heights, Sample Nagar, Testville - 560001`],
  ['colon inside the address', 'Flat 12, Example Heights, Ward: 4, Testville - 560001'],
  ['unlabelled OCR block', 'Correspondence\nFlat 12 Example Heights\nSample Nagar, Testville 560001'],
];
for (const [label, text] of CASES) {
  test(`closure: ${label}`, () => {
    const out = storage(text);
    for (const leak of LEAKS) assert.ok(!out.includes(leak), `"${leak}" survived in ${JSON.stringify(out)}`);
  });
}

test('closure: address-shaped text past the scan limit is refused, not sent', () => {
  assert.throws(() => storage(`Address: Flat 12. ${'Sample Nagar Extension '.repeat(15)}Testville 560001`), { code: 'PRIVACY_ADDRESS_UNCERTAIN' });
});

test('closure: public insurer details and useful policy text are kept', () => {
  const out = storage([
    'Registered Office: Example Insurance Ltd, 1 Example Tower, Testville - 400001. UIN: EXAMPLEHLIP20001V012021. Toll free 1800 123 4567',
    'Room Rent: At Actuals. Room rent limited to 1% of sum insured per day up to 500000.',
    'Room Rent, ICU Charges 500000',
    'Plan 1, Plan 2, Plan 3 500000',
    '| Cataract | Rs 40000, 1 Eye | 100000 |',
  ].join('\n'));
  assert.match(out, /Example Insurance Ltd, 1 Example Tower, Testville - 400001/);
  assert.match(out, /UIN: EXAMPLEHLIP20001V012021/);
  assert.match(out, /At Actuals\. Room rent limited to 1% of sum insured per day up to 500000\./);
  assert.match(out, /Room Rent, ICU Charges 500000/);
  assert.match(out, /Plan 1, Plan 2, Plan 3 500000/);
  assert.match(out, /Rs 40000, 1 Eye \| 100000/);
});

test('closure: a policy line above an unlabelled address is not swallowed', () => {
  assert.match(storage('Sum Insured Plan 500000\nFlat 12, Example Heights, Testville - 560001'), /^Sum Insured Plan 500000\n<ADDRESS_/);
});

test('closure: adversarial address-like inputs stay linear', () => {
  const inputs = ['560001 '.repeat(2200), 'Aa, 560001 '.repeat(1400), '5 '.repeat(7500), `Flat 12, ${'Alpha, '.repeat(2000)}Testville 560001`, 'Flat 1, Aa Bb, Cc - 560001\n'.repeat(550)];
  for (const text of inputs) {
    const started = performance.now();
    try { sanitizeEvidenceTextForStorage(text.slice(0, 15_000), { maxBytes: 16_000 }); } catch (error) { assert.equal(error.code, 'PRIVACY_ADDRESS_UNCERTAIN'); }
    assert.ok(performance.now() - started < 1000);
  }
});

test('closure: headings and wording after an address stay', () => {
  const out = storage('Address: Flat 12 Example Heights.\nWaiting Periods\nThe waiting period is 30 days.');
  assert.match(out, /Waiting Periods\nThe waiting period is 30 days\./);
});

// Exact outgoing payloads: first pass and override sweep, built through the real investigate() path.
test('closure: no address text reaches either outgoing model payload', async () => {
  const blocks = [
    { tag: 'paragraph', text: 'Communication Address: Flat 12 Example Heights. Sample Nagar, Testville, Karnataka\nCataract surgery is a covered hospitalisation benefit.' },
    { tag: 'paragraph', text: 'Address: Flat 12 Example Heights. Testville 56 0001 and cataract surgery is capped at Rs. 40,000 per eye.' },
    { tag: 'paragraph', text: `Address: Flat 12. ${'Sample Nagar Extension '.repeat(15)}Testville 560001` },
    { tag: 'paragraph', text: 'Registered Office: Example Insurance Ltd, 1 Example Tower, Testville - 400001. Cataract has a waiting period of 24 months.' },
  ];
  const { clauses } = buildClauses({ pages: blocks.map((block, index) => ({ page: index + 1, status: 'stored', blocks: [block] })) }, { documentId: 'doc-1', sourceVersion: 'v1' });
  const payloads = [];
  const first = clauses.find(clause => /covered hospitalisation/.test(clause.text));
  const call = async ({ task, payload }) => {
    payloads.push(payload);
    if (task === 'policy_evidence_investigate') return { json: { findings: [{ clause_ids: [first.clauseId], quote: 'Cataract surgery is a covered hospitalisation benefit', subject: 'cataract surgery', effect: 'covers', conditions: [], exceptions: [] }] }, usage: {} };
    return { json: { overrides: [] }, usage: {} };
  };
  await investigate({ question: 'Is cataract surgery covered?', clauses, consentCheck: async () => {}, call });
  assert.equal(payloads.length, 2, 'first pass and sweep both ran');
  const wire = JSON.stringify(payloads);
  for (const leak of ['Sample Nagar', 'Example Heights', '560001', 'Karnataka', '56 0001']) assert.ok(!wire.includes(leak), `"${leak}" reached a payload`);
  assert.ok(wire.includes('Example Insurance Ltd'), 'public insurer detail kept');
  assert.ok(wire.includes('capped at Rs. 40,000 per eye'), 'policy wording kept');
  assert.ok(!wire.includes('Extension Sample Nagar'), 'refused clause was withheld');
});
