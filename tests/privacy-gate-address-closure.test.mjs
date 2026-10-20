// Block 2 delta close-out, task 1: address cases the v6 tail rule did not cover.
// Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRIVACY_EVIDENCE_GATE_VERSION } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { sanitizeEvidenceTextForStorage } from './support/storage-gate.mjs';
import { buildClauses, investigate } from '../src/features/policy-evidence/index.js';

const storage = text => sanitizeEvidenceTextForStorage(text).text;

test('gate version is v8', () => assert.equal(PRIVACY_EVIDENCE_GATE_VERSION, 'knowvia-privacy-evidence-v9'));

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

// Block 2 delta, residuals R1-R3 (gate v8). Synthetic values only.
const R_LEAKS = ['Testville', 'Sample Nagar', 'Example Heights', 'Example Temple', 'Old Example Road', '560001', 'Karnataka'];
const R_CASES = [
  ['R1 locality and PIN, one comma, no dash', 'Sample Nagar, Testville 560001'],
  ['R1 city and PIN only', 'Testville 560001'],
  ['R1 inside a sentence', 'Insured lives at Sample Nagar Testville 560001 per proposal'],
  ['R1 in a table cell', '| Proposer | Sample Nagar, Testville 560001 |'],
  ['R2 house number, no PIN', 'Flat 12, Example Heights, Sample Nagar, Testville'],
  ['R2 bare number start, no PIN', '12, Example Heights, Sample Nagar'],
  ['R2 plot number, no PIN', 'Plot No 5, Example Heights'],
  ['R2 no PIN, state after the run', 'Flat 12, Example Heights, Sample Nagar, Testville, Karnataka'],
  ['R3 landmark and road fragment', 'Near Example Temple, Old Example Road'],
  ['R3 locality fragment alone', 'Example Heights, Sample Nagar'],
  ['R3 state line after a fragment', 'Example Heights, Sample Nagar\nKarnataka'],
];
for (const [label, text] of R_CASES) {
  test(`residual: ${label}`, () => {
    const out = storage(text);
    for (const leak of R_LEAKS) assert.ok(!out.includes(leak), `"${leak}" survived in ${JSON.stringify(out)}`);
  });
}

// Deliberate decision: a state or city name on its own is not an address and territorial wording needs it.
test('residual: standalone state and city names and policy wording stay', () => {
  const out = storage([
    'Territorial limit: India. Zone 1: Karnataka, Delhi NCR',
    'Testville, Karnataka',
    'Road traffic accident, Hernia, Piles',
    'Behind the ear hearing aids are excluded.',
    'Plan 1, Plan 2, Plan 3 500000',
    'Registered Office: Example Insurance Ltd, Sample Nagar, Testville - 400001',
  ].join('\n'));
  assert.match(out, /Zone 1: Karnataka, Delhi NCR/);
  assert.match(out, /^Testville, Karnataka$/m);
  assert.match(out, /Road traffic accident, Hernia, Piles/);
  assert.match(out, /Behind the ear hearing aids are excluded\./);
  assert.match(out, /Plan 1, Plan 2, Plan 3 500000/);
  assert.match(out, /Example Insurance Ltd, Sample Nagar, Testville - 400001/);
});

test('residual: new rules stay linear on adversarial input', () => {
  const inputs = ['A'.repeat(15000), 'Aa '.repeat(5000), '1 Aa '.repeat(3000), 'Aa Bb, '.repeat(2000), 'Near Aa '.repeat(1800), 'Aa Nagar, '.repeat(1500), 'Aa Bb Cc Dd Ee '.repeat(900), ('Flat 1, ' + 'Aa Bb, '.repeat(200) + '\n').repeat(60)];
  for (const text of inputs) {
    const started = performance.now();
    try { sanitizeEvidenceTextForStorage(text.slice(0, 15_000), { maxBytes: 16_000 }); } catch (error) { assert.equal(error.code, 'PRIVACY_ADDRESS_UNCERTAIN'); }
    assert.ok(performance.now() - started < 1000, `slow: ${text.slice(0, 20)}`);
  }
});

// Review-driven: benefit wording that only looks like a fragment stays.
test('residual: landmark and plot wording false positives stay', () => {
  const out = storage('Day Care Procedures, Opposite Eye Surgery, Behind Ear Procedures\nSub-limits: Cataract, Plot 3, Lane Surgery');
  assert.match(out, /Opposite Eye Surgery, Behind Ear Procedures/);
  assert.match(out, /Plot 3, Lane Surgery/);
});

// Review residuals closed in v9.
test('residual: prose, hospital-line, semicolon, sector and split-line addresses go', () => {
  const cases = [
    ['Insured resides at Sample Nagar, Testville and wants a claim.', /Sample Nagar|Testville/],
    ['Admitted at Sample Hospital, Sample Nagar, Testville', /Sample Nagar|Testville/],
    ['Flat 3; Example Heights; Sample Nagar', /Example Heights|Sample Nagar/],
    ['Sector 5, Testville', /Sector 5/],
    ['Sample Gali, Testville', /Sample Gali/],
    ['12\nSample Nagar, Testville 560001', /^12$/m],
  ];
  for (const [text, leak] of cases) {
    const out = storage(text);
    assert.doesNotMatch(out, leak, text);
    assert.match(out, /<ADDRESS_\d+>/u, text);
  }
});

test('residual: hospital name and benefit wording stay beside redacted locality', () => {
  const out = storage('Admitted at Sample Hospital, Sample Nagar, Testville\nWaiting Extension applies');
  assert.match(out, /Admitted at Sample Hospital, <ADDRESS_\d+>/);
  assert.match(out, /Waiting Extension applies/);
});

// v9 second pass: lowercase, Devanagari, spaced PIN, comma-less house lines, glued locality suffix.
test('residual: lowercase, Devanagari, spaced-PIN and comma-less addresses go', () => {
  const cases = [
    ['Testville 560 001', /560/],
    ['flat 12, example heights, sample nagar, testville', /example heights|sample nagar/],
    ['insured lives at sample nagar, testville and agrees', /sample nagar/],
    ['मकान 12, सैंपल नगर, टेस्टविल', /सैंपल|मकान/],
    ['बीमित सैंपल नगर में रहता है', /सैंपल/],
    ['Flat 12 Example Apartments Testville', /Example Apartments/],
    ['Sample Pur, Block 5, Samplepur, 12', /Samplepur/],
  ];
  for (const [text, leak] of cases) {
    const out = storage(text);
    assert.doesNotMatch(out, leak, text);
    assert.match(out, /<ADDRESS_\d+>/u, text);
  }
});

test('residual: amounts, zone lists and benefit wording stay after the second pass', () => {
  const text = ['Copay 100 110', 'Zone 1: Mumbai, Hyderabad, Ahmedabad', 'the waiting period colony of disease', 'Door 5 Benefit Rider Applies', 'sum insured 100 200 waiting 300 400'].join('\n');
  assert.equal(storage(text), text);
});

test('residual: second-pass rules stay linear', () => {
  const inputs = ['a'.repeat(15000), 'a '.repeat(7000), 'नगर '.repeat(3000), 'स'.repeat(15000), 'Flat 1 '.repeat(2000), 'flat 1, a'.repeat(1500)];
  for (const text of inputs) {
    const started = performance.now();
    try { sanitizeEvidenceTextForStorage(text.slice(0, 15_000), { maxBytes: 16_000 }); } catch (error) { assert.equal(error.code, 'PRIVACY_ADDRESS_UNCERTAIN'); }
    assert.ok(performance.now() - started < 1000, `slow: ${text.slice(0, 20)}`);
  }
});
