import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import section, { ageInYears, normaliseName, formatInr } from '../src/modules/policy-breakdown/sections/s11-household.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/policy-breakdown/s11-cases.json', import.meta.url), 'utf8'));

const REQUIRED = {
  members_without_evidenced_cover: 'text_list',
  floater_concentration_risk: 'boolean',
  eldest_member_age_years: 'years',
  members_attracting_age_copay: 'text_list',
  next_cover_change_date: 'date',
  next_cover_change_reason: 'text',
  employer_cover_dependence_percent: 'percent',
  sum_insured_adequacy: 'rule',
  layering_gap: 'rule',
};
const ALLOWED_STATES = new Set(['Calculated', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted']);

test('section 11 is a valid analysis section with the required keys', () => {
  assert.equal(section.number, 11);
  assert.equal(section.id, 'section-11-household');
  assert.equal(section.kind, 'analysis');
  assert.equal(typeof section.analyze, 'function');
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));
  for (const [key, valueType] of Object.entries(REQUIRED)) {
    assert.ok(byKey.has(key), `missing ${key}`);
    assert.equal(byKey.get(key).valueType, valueType, `${key} valueType`);
  }
});

test('fixture has at least four cases', () => {
  assert.equal(fixture.section, 11);
  assert.ok(fixture.cases.length >= 4);
});

for (const testCase of fixture.cases) {
  test(`analyze: ${testCase.name}`, () => {
    const results = section.analyze(testCase.context);
    const byKey = new Map(results.map(entry => [entry.key, entry]));
    assert.deepEqual([...byKey.keys()].sort(), section.parameters.map(parameter => parameter.key).sort(), 'returns every parameter once');
    for (const entry of results) {
      assert.ok(ALLOWED_STATES.has(entry.evidenceState), `${entry.key} state ${entry.evidenceState}`);
      assert.notEqual(entry.evidenceState, 'Proven');
      assert.equal(typeof entry.stateReason, 'string');
      assert.ok(entry.stateReason.length > 0, `${entry.key} has a stateReason`);
      assert.ok(Array.isArray(entry.derivedFrom));
      if (entry.evidenceState !== 'Calculated' && entry.evidenceState !== 'Dynamic') assert.equal(entry.value, null, `${entry.key} must not guess a value`);
    }
    for (const [key, expected] of Object.entries(testCase.expected)) {
      const actual = byKey.get(key);
      assert.equal(actual.evidenceState, expected.evidenceState, `${key}: ${actual.stateReason}`);
      assert.deepEqual(actual.value, expected.value, key);
    }
  });
}

test('missing inputs yield Unknown, never a value', () => {
  const missing = fixture.cases.find(testCase => testCase.name.startsWith('missing input'));
  for (const entry of section.analyze(missing.context)) {
    assert.equal(entry.evidenceState, 'Unknown', entry.key);
    assert.equal(entry.value, null, entry.key);
  }
});

test('adequacy says the procedure-cost reference is absent', () => {
  const normal = fixture.cases[0];
  const adequacy = section.analyze(normal.context).find(entry => entry.key === 'sum_insured_adequacy');
  assert.match(adequacy.stateReason, /procedureCostReference is null/);
});

test('empty context does not throw and returns all Unknown', () => {
  for (const entry of section.analyze({})) {
    assert.equal(entry.evidenceState, 'Unknown', entry.key);
    assert.equal(entry.value, null);
  }
});

test('helpers', () => {
  assert.equal(ageInYears('1962-07-21', '2026-07-20'), 63);
  assert.equal(ageInYears('1962-07-21', '2026-07-21'), 64);
  assert.equal(ageInYears(null, '2026-07-21'), null);
  assert.equal(normaliseName('Smt. Kaushalya  Devi — Mother'), 'kaushalya devi');
  assert.equal(normaliseName('Mr. Ram Kumar (Self)'), 'ram kumar');
  assert.equal(formatInr(10_00_000_00), '₹10,00,000');
  assert.equal(formatInr(1_50_00_000_00), '₹1,50,00,000');
});
