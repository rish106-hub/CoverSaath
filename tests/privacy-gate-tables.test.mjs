import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceTextForStorage } from '../src/modules/ai-analysis/privacy-evidence-gate.js';

// Synthetic only: fictional people, ids and conditions in the pipe-table shape OCR layout output prints.
const gate = text => sanitizeEvidenceTextForStorage(text, { maxBytes: 16_000 }).text;
const has = (text, ...values) => values.filter(value => text.includes(value));

test('header-labelled identity columns are minimised in every row', () => {
  const text = gate([
    'Insured Name | Member ID | Date Of Birth | Gender',
    'Zephyr Quillon | ZQ990000111222 | 14-03-1971 | Male',
    'Ilsa Quillon | ZQ990000111223 | 02-09-1975 | Female',
  ].join('\n'));
  assert.deepEqual(has(text, 'ZQ990000111222', 'ZQ990000111223', '14-03-1971', '02-09-1975', 'Zephyr', 'Ilsa'), []);
  assert.deepEqual(has(text, 'Male', 'Female', 'Insured Name | Member ID | Date Of Birth | Gender'), ['Male', 'Female', 'Insured Name | Member ID | Date Of Birth | Gender']);
});

test('row-label cells minimise the values after them, including pipe-separated government ids', () => {
  const text = gate([
    'Aadhaar Number | XXXXXXXX4321 | PAN | QWERT5678Z',
    'Date of Birth | 01/02/1980 | 03/04/1984',
    'Customer ID | CU-77881',
  ].join('\n'));
  assert.deepEqual(has(text, '4321', 'QWERT5678Z', '01/02/1980', '03/04/1984', 'CU-77881'), []);
  assert.match(text, /^Aadhaar Number \| <GOV_ID_1> \| PAN \| <GOV_ID_2>$/m);
});

test('health columns in member tables and every cell of an ICD table are minimised', () => {
  const member = gate([
    'Plan | Name of Insured Person | Loading Reason | Declared Pre-existing Disease',
    'PlanAlpha | Zephyr Quillon | Loading:Synthetic Syndrome | Fictional Gout',
  ].join('\n'));
  assert.deepEqual(has(member, 'Synthetic Syndrome', 'Fictional Gout', 'Zephyr'), []);
  assert.ok(member.includes('PlanAlpha'), 'non-sensitive cells are kept');

  const icd = gate(['ICD CODE | Description', 'Q99.1 | Fictional joint disorder', 'Q98.0 | Synthetic liver change'].join('\n'));
  assert.deepEqual(has(icd, 'Q99.1', 'Q98.0', 'Fictional joint', 'Synthetic liver'), []);
  assert.equal(gate('Health Condition : Synthetic Pre Existing Disease').includes('Synthetic'), false);
});

test('policy tables keep their values: wording health columns, amounts and placeholders are not labels', () => {
  const wording = gate([
    'Benefit | Pre-existing Diseases | Room Rent',
    'Plan Alpha | 36 months | 1% of SI',
    'Particulars | Premium | Gender',
    'Base Premium | 40,606 | Male',
  ].join('\n'));
  assert.deepEqual(has(wording, '36 months', '1% of SI', '40,606', 'Male'), ['36 months', '1% of SI', '40,606', 'Male']);
  // A placeholder cell left by an earlier rule must not start a label run over the cells after it.
  const known = sanitizeEvidenceTextForStorage('Zephyr Quillon | Self | Male | 56 | 15,00,000', {
    maxBytes: 16_000, knownIdentifiers: [{ kind: 'NAME', value: 'Zephyr Quillon' }],
  }).text;
  assert.equal(known, '<NAME_1> | Self | Male | 56 | 15,00,000');
});

test('a header carries over page breaks and blank lines; rows fail closed on ID and date shapes', () => {
  const text = gate(['Member ID | Date of Birth | Premium', 'AB-1 | 10-10-1990 | 5,000', 'Page 2 of 4', '', 'ZQ990000111223 | 11-11-1991 | 6,000'].join('\n'));
  assert.deepEqual(has(text, 'AB-1', '10-10-1990', 'ZQ990000111223', '11-11-1991'), []);
  assert.ok(text.includes('5,000') && text.includes('6,000'));
  // A continuation part with no header still minimises ID-shaped cells and whole-cell dates.
  const part = gate('ZQ990000111224 | 12-12-1992 | Male');
  assert.deepEqual(has(part, 'ZQ990000111224', '12-12-1992'), []);
  assert.ok(part.includes('Male'));
  // Product UINs and policy-period dates are policy facts.
  assert.ok(gate('Product UIN | ABCDEFG12345V123456').includes('ABCDEFG12345V123456'));
  assert.ok(gate('Valid from | 17-06-2026').includes('17-06-2026'));
  // One labelled cell beside a plain word is a label/value pair, not a header: the value is minimised.
  assert.equal(gate('Name | Fennimore Desk').includes('Fennimore'), false);
});

test('review probes: header variants, edge pipes, member tables without a name column, health label pairs', () => {
  const leaks = [
    ['Member ID 1 | Date of Birth 1 | Name 1\nZQ990000111222 | 14-03-1971 | Zephyr Quillon', ['ZQ990000111222', '14-03-1971', 'Zephyr']],
    ['Insd. Name | Mem. No. | D.O.B.\nZephyr Quillon | AB-77 | 14-03-1971', ['Zephyr', 'AB-77', '14-03-1971']],
    ['Insured Name │ Member ID │ Date Of Birth\nZephyr Quillon │ AB-77 │ 14-03-1971', ['Zephyr', 'AB-77', '14-03-1971']],
    ['| Insured Name | Member ID | Date Of Birth |\nZephyr Quillon | ZQ990000111222 | 14-03-1971', ['Zephyr', 'ZQ990000111222', '14-03-1971']],
    ['Insured Person | Loading Reason | Declared Pre-existing Disease\nZephyr Quillon | Synthetic Syndrome | Fictional Gout', ['Zephyr', 'Synthetic Syndrome', 'Fictional Gout']],
    ['Member ID | Loading Reason | Pre-existing Disease\nAB-77 | Synthetic Syndrome | Fictional Gout', ['AB-77', 'Synthetic Syndrome', 'Fictional Gout']],
    ['Health Condition | Fictional Gout', ['Fictional Gout']],
    ['Diagnosis | Fictional Gout | Insured | Zephyr Quillon', ['Fictional Gout', 'Zephyr']],
  ];
  for (const [input, values] of leaks) assert.deepEqual(has(gate(input), ...values), [], input);
});

test('review probes: a label run stops at the next label and policy facts survive', () => {
  const kept = [
    ['Date of Birth | 01/02/1980 | Sum Insured | 5,00,000', ['Sum Insured', '5,00,000']],
    ['Policy Number | P-1234 | Premium | 40,606 | Waiting Period | 36 months', ['40,606', '36 months']],
    ['Pan India Cover | Yes | Room Rent | 1% of SI', ['Pan India Cover | Yes', '1% of SI']],
    ['Hospital Address | Fictional Road | Waiting Period | 30 days', ['Fictional Road', '30 days']],
    ['Customer Care Phone | 1800 000 000 | Claim Intimation | within 48 hours', ['within 48 hours']],
    ['ICD CODE | Description\nQ99.1 | Fictional joint disorder\nRoom Rent | 1% of SI', ['1% of SI']],
  ];
  for (const [input, values] of kept) assert.deepEqual(has(gate(input), ...values), values, input);
  assert.equal(gate('Date of Birth | 01/02/1980 | Sum Insured | 5,00,000').includes('01/02/1980'), false);
});
