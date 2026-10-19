import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeEvidenceForModel, sanitizeEvidenceTextForStorage } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { N1_WHITESPACE_PROBES, N2_VARIANT_PROBES } from './support/privacy-probes.mjs';

// W2 close-out: the two known gate gaps. Tab-separated tables fail closed (refused as restricted, never
// sent); a table header printed over two rows is read as one header. Synthetic people, ids and conditions.
const gate = text => sanitizeEvidenceTextForStorage(text, { maxBytes: 16_000 }).text;
const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: { allowed: true }, registryVersion: 'policy-parameters/v1' });
const toModel = text => sanitizeEvidenceForModel({
  context: { caseId: 'case-w2', subjectId: 'subject-w2', purpose: 'Extract requested policy facts.', requestedFields: ['d.room_rent_limit'] },
  sources: [{ id: 'page-w2', version: 'v1', page: 1, text, status: 'known' }],
  upstream: [],
}, { resolveParameterPolicy: policy });
const has = (text, ...values) => values.filter(value => text.includes(value));

const TAB_TABLES = Object.freeze([
  ['member table', ['Member ID\tDate Of Birth\tGender', 'QZ8812345678\t14/03/1971\tMale']],
  ['condition table', ['Name\tPre-existing Disease', 'Anaya Testperson\tSynthetic Gout']],
  ['identity pairs', ['Aadhaar Number\tXXXX XXXX 9101', 'PAN\tQWERT5678Z']],
  ['ICD table split by a blank line', ['ICD Code\tDescription', '', 'Q99.1\tFictional joint disorder']],
  ['tabs padded with spaces', ['Insured Name \t Loading Reason', 'Anaya Testperson \t Fictional Obesity']],
  ['CRLF line ends', ['Member ID\tDOB\r\nQZ8812345678\t14/03/1971']],
  ['headerless member rows', ['Anaya Testperson\tQZ8812345680\tSelf', 'Ishaan Testperson\t21/11/2001\tSon']],
]);

test('a tab-separated table is refused as restricted at both entry points, without echo', () => {
  for (const [label, lines] of TAB_TABLES) {
    const text = `Schedule of insured persons\n${lines.join('\n')}`;
    for (const run of [() => sanitizeEvidenceTextForStorage(text, { maxBytes: 16_000 }), () => toModel(text)]) {
      assert.throws(run, error => {
        assert.equal(error.code, 'RESTRICTED_EVIDENCE', label);
        assert.deepEqual(has(String(error.message), 'QZ88', '1971', 'Anaya', 'Gout', '9101', 'QWERT', 'Q99'), [], label);
        return true;
      }, label);
    }
  }
});

test('a single tab row keeps the line rules, so the N1 and N2 probes are unchanged', () => {
  for (const [label, text, fragments] of [...N1_WHITESPACE_PROBES, ...N2_VARIANT_PROBES].filter(([, text]) => text.includes('\t'))) {
    const out = gate(text);
    assert.deepEqual(has(out, ...fragments), [], label);
  }
  assert.equal(gate('Room rent\t1% of SI'), 'Room rent 1% of SI', 'one tab row in policy wording passes');
  // Tabs used as spacing in policy prose, with no header-like, ID-shaped or date cell, are not a table.
  const prose = 'Room rent limit:\t₹5,000 per day.\nAmbulance cover\tup to ₹2,000 per event.\nCo-pay\t10% for every claim.';
  assert.equal(gate(prose), 'Room rent limit: ₹5,000 per day.\nAmbulance cover up to ₹2,000 per event.\nCo-pay 10% for every claim.');
});

test('a header printed over two rows is read as one header', () => {
  const member = gate([
    '| Insured | Member | Date of | Pre-existing |',
    '| Person Name | ID | Birth | Condition |',
    '| Anaya Testperson | QZ8812345678 | 14/03/1971 | Synthetic Gout |',
    '| Ishaan Testperson | QZ8812345679 | 02/09/1975 | Fictional Asthma |',
  ].join('\n'));
  assert.deepEqual(has(member, 'Anaya', 'Ishaan', 'Testperson', 'QZ88', '1971', '1975', 'Gout', 'Asthma'), []);

  const loading = gate(['Name of | Date of | Loading', 'Insured | Birth | Reason', 'Anaya Testperson | 14/03/1971 | Fictional Obesity'].join('\n'));
  assert.deepEqual(has(loading, 'Anaya', '1971', 'Obesity'), []);

  const icd = gate(['ICD | Condition', 'Code | Description', 'Q99.1 | Fictional joint disorder'].join('\n'));
  assert.deepEqual(has(icd, 'Q99.1', 'Fictional joint'), []);
});

test('a split header only adds columns; policy tables over two header rows keep their values', () => {
  // The joined header never drops a column the active header already minimises.
  const kept = gate(['Insured Name | Plan | Member ID', 'Policy | Room | Sum', 'Anaya Testperson | Gold | QZ8812345678'].join('\n'));
  assert.deepEqual(has(kept, 'Anaya', 'QZ88'), []);
  // A second label row whose joined first cell is no longer a name label must not unmask the name column.
  const widened = gate([
    'Insured Name | Member ID | Plan',
    'Policy holder details as printed in the schedule | Card | Date of Birth',
    'Anaya Trenholm | QZ8812345680 | 21/11/2001',
  ].join('\n'));
  assert.deepEqual(has(widened, 'Anaya', 'Trenholm', 'QZ88', '2001'), []);
  const wording = gate(['Benefit | Waiting', 'Name | Period', 'Pre-existing diseases | 36 months', 'Room rent | 1% of SI'].join('\n'));
  assert.deepEqual(has(wording, '36 months', '1% of SI', 'Pre-existing diseases'), ['36 months', '1% of SI', 'Pre-existing diseases']);
});
