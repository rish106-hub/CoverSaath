import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import section, { normaliseInsurerName, periodEndDate } from '../src/modules/policy-breakdown/sections/s10-insurer-quality.js';
import { EVIDENCE_STATES } from '../src/modules/policy-breakdown/contracts.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/policy-breakdown/s10-cases.json', import.meta.url), 'utf8'));

const REQUIRED = {
  claim_settlement_ratio_count: 'percent',
  claim_settlement_ratio_amount: 'percent',
  incurred_claim_ratio: 'percent',
  repudiation_ratio: 'percent',
  complaints_per_10k_claims: 'count',
  solvency_ratio: 'percent',
  average_settlement_days: 'days',
  claims_handling_model: 'enum',
  network_hospitals_in_city: 'count',
};
const ALLOWED_STATES = new Set(['Calculated', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted']);

test('section 10 is a valid analysis defineSection result with every required key', () => {
  assert.equal(section.number, 10);
  assert.equal(section.id, 'section-10-insurer-quality');
  assert.equal(section.kind, 'analysis');
  assert.equal(typeof section.analyze, 'function');
  assert.ok(Object.isFrozen(section));
  assert.ok(section.expertise.length > 0 && section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  const byKey = new Map(section.parameters.map(p => [p.key, p]));
  for (const [key, valueType] of Object.entries(REQUIRED)) {
    assert.ok(byKey.has(key), `missing ${key}`);
    assert.equal(byKey.get(key).valueType, valueType, `${key} valueType`);
  }
  assert.deepEqual([...byKey.get('claims_handling_model').enumValues], ['in_house', 'tpa', 'unknown']);
});

test('fixture has at least four cases and covers every parameter in every case', () => {
  assert.equal(fixture.section, 10);
  assert.ok(fixture.cases.length >= 4);
  const keys = section.parameters.map(p => p.key).sort();
  for (const testCase of fixture.cases) assert.deepEqual(Object.keys(testCase.expected).sort(), keys, testCase.name);
});

for (const testCase of fixture.cases) {
  test(`analyze: ${testCase.name}`, () => {
    const outputs = section.analyze(testCase.context);
    const keys = section.parameters.map(p => p.key);
    assert.deepEqual(outputs.map(o => o.key), keys, 'returns every parameter once, in declared order');
    for (const output of outputs) {
      assert.ok(EVIDENCE_STATES.includes(output.evidenceState));
      assert.ok(ALLOWED_STATES.has(output.evidenceState), `${output.key} must never be ${output.evidenceState}`);
      assert.notEqual(output.evidenceState, 'Proven');
      assert.equal(typeof output.stateReason, 'string');
      assert.ok(Array.isArray(output.derivedFrom) && output.derivedFrom.length > 0);
      if (output.evidenceState !== 'Dynamic' && output.evidenceState !== 'Calculated') {
        assert.equal(output.value, null, `${output.key}: ${output.evidenceState} must not carry a guessed value`);
      }
      if (output.evidenceState === 'Dynamic') {
        assert.match(output.stateReason, /period .+, published \d{4}-\d{2}-\d{2}/, `${output.key} Dynamic reason carries period and date`);
      }
      const expected = testCase.expected[output.key];
      assert.equal(output.evidenceState, expected.evidenceState, `${output.key} state`);
      assert.deepEqual(output.value, expected.value, `${output.key} value`);
    }
  });
}

test('conflicting values are preserved in notes', () => {
  const conflicting = fixture.cases.find(c => c.name.startsWith('conflicting'));
  const output = section.analyze(conflicting.context).find(o => o.key === 'claim_settlement_ratio_amount');
  assert.match(output.notes, /81\.5%/);
  assert.match(output.notes, /79%/);
});

test('missing context entirely yields Unknown for every parameter', () => {
  for (const output of section.analyze({})) {
    assert.equal(output.evidenceState, 'Unknown');
    assert.equal(output.value, null);
  }
});

test('Map-like parameter stores are accepted', () => {
  const normal = fixture.cases[0].context;
  const outputs = section.analyze({ ...normal, parameters: new Map(Object.entries(normal.parameters)) });
  assert.equal(outputs.find(o => o.key === 'claim_settlement_ratio_count').value.percent, 91.25);
});

test('name and period normalisation', () => {
  assert.equal(normaliseInsurerName('Example General Insurance Co. Ltd.'), normaliseInsurerName('EXAMPLE GENERAL INSURANCE COMPANY LIMITED'));
  assert.notEqual(normaliseInsurerName('Example General Life Insurance Company Limited'), normaliseInsurerName('Example General Insurance Company Limited'));
  assert.equal(periodEndDate('FY2025-26'), '2026-03-31');
  assert.equal(periodEndDate('FY 2025-2026'), '2026-03-31');
  assert.equal(periodEndDate('2025'), '2025-12-31');
  assert.equal(periodEndDate('2026-02'), '2026-02-28');
  assert.equal(periodEndDate('2025-27'), null);
  assert.equal(periodEndDate('recent'), null);
});

test('a disclosure with no source is Unknown, never Dynamic, and the section does not promise a prediction', () => {
  const parameters = { insurer_name: { key: 'insurer_name', value: { kind: 'text', text: 'Example General Insurance Company Limited' }, evidenceState: 'Proven', memberScope: null } };
  const entry = { insurerName: 'Example General Insurance Co. Ltd.', metric: 'claim_settlement_ratio_count', value: 90, period: 'FY2024-25', publishedOn: '2025-08-15' };
  for (const source of [undefined, '', '   ']) {
    const out = section.analyze({ asOf: '2026-10-02', parameters, references: { insurerDisclosures: [{ ...entry, source }] } });
    const ratio = out.find(o => o.key === 'claim_settlement_ratio_count');
    assert.equal(ratio.evidenceState, 'Unknown');
    assert.equal(ratio.value, null);
    assert.match(ratio.notes, /source_not_labelled/);
  }
  const labelled = section.analyze({ asOf: '2026-10-02', parameters, references: { insurerDisclosures: [{ ...entry, source: 'Synthetic table' }] } });
  assert.equal(labelled.find(o => o.key === 'claim_settlement_ratio_count').evidenceState, 'Dynamic');
  assert.doesNotMatch(section.question, /will they|actually pay/i);
});
