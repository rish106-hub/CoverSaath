import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import section, { REGULATORY_FLOOR, validateFloorTable } from '../src/modules/policy-breakdown/sections/s12-regulatory.js';
import { defineSection, EVIDENCE_STATES } from '../src/modules/policy-breakdown/contracts.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/policy-breakdown/s12-cases.json', import.meta.url), 'utf8'));

const REQUIRED = {
  regulatory_floor_version: 'text',
  ped_wait_within_floor: 'boolean',
  specified_wait_within_floor: 'boolean',
  moratorium_within_floor: 'boolean',
  free_look_within_floor: 'boolean',
  initial_wait_within_floor: 'boolean',
  cashless_timeline_within_floor: 'boolean',
  proportionate_deduction_exemptions_within_floor: 'boolean',
  regulatory_deviations: 'text_list',
};
const ALLOWED_STATES = new Set(['Calculated', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted']);

test('section 12 is a valid analysis section with the required keys', () => {
  assert.equal(section.number, 12);
  assert.equal(section.id, 'section-12-regulatory');
  assert.equal(section.kind, 'analysis');
  assert.equal(typeof section.analyze, 'function');
  assert.ok(Object.isFrozen(section));
  assert.ok(section.expertise.length <= 12_000);
  // Re-defining from the frozen result must succeed (shape is contract-valid).
  assert.doesNotThrow(() => defineSection({
    number: section.number, id: section.id, title: section.title, question: section.question, kind: section.kind,
    expertise: section.expertise, reviewGuidance: section.reviewGuidance, analyze: section.analyze,
    parameters: section.parameters.map(({ section: _s, validate, enumValues, ...rest }) => ({
      ...rest,
      ...(rest.valueType === 'enum' ? { enumValues: [...enumValues] } : {}),
      ...(validate ? { validate } : {}),
    })),
  }));
  const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));
  for (const [key, valueType] of Object.entries(REQUIRED)) {
    assert.ok(byKey.has(key), `missing ${key}`);
    assert.equal(byKey.get(key).valueType, valueType, `${key} valueType`);
  }
});

test('floor table is frozen, dated, versioned and marked verify-before-use', () => {
  assert.ok(Object.isFrozen(REGULATORY_FLOOR));
  assert.ok(Object.isFrozen(REGULATORY_FLOOR.items.ped_waiting_max_months));
  assert.equal(REGULATORY_FLOOR.verifyBeforeUse, true);
  assert.match(REGULATORY_FLOOR.asOf, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(REGULATORY_FLOOR.source, /not verified/);
  assert.equal(validateFloorTable(REGULATORY_FLOOR), null);
  const items = REGULATORY_FLOOR.items;
  assert.equal(items.ped_waiting_max_months.limit, 36);
  assert.equal(items.specified_disease_waiting_max_months.limit, 36);
  assert.equal(items.moratorium_max_months.limit, 60);
  assert.equal(items.free_look_min_days.limit, 30);
  assert.equal(items.initial_waiting_max_days.limit, 30);
  assert.equal(items.cashless_decision_max_hours.limit, 1);
  assert.equal(items.discharge_authorisation_max_hours.limit, 3);
  assert.equal(items.proportionate_deduction_exempt_heads.heads.length, 5);
});

test('fixture has at least four cases', () => {
  assert.equal(fixture.section, 12);
  assert.ok(fixture.cases.length >= 4);
});

for (const testCase of fixture.cases) {
  test(`analyze: ${testCase.name}`, () => {
    const output = section.analyze(structuredClone(testCase.context));
    const byKey = new Map(output.map(entry => [entry.key, entry]));
    // Every parameter returned exactly once, with allowed states, never Proven.
    assert.equal(output.length, section.parameters.length);
    for (const parameter of section.parameters) assert.ok(byKey.has(parameter.key), `missing output ${parameter.key}`);
    for (const entry of output) {
      assert.ok(EVIDENCE_STATES.includes(entry.evidenceState));
      assert.ok(ALLOWED_STATES.has(entry.evidenceState), `${entry.key} state ${entry.evidenceState}`);
      assert.notEqual(entry.evidenceState, 'Proven');
      assert.equal(typeof entry.stateReason, 'string');
      assert.ok(Array.isArray(entry.derivedFrom));
      if (entry.evidenceState !== 'Dynamic' && entry.evidenceState !== 'Calculated') assert.equal(entry.value, null, `${entry.key} must not guess`);
      if (entry.evidenceState === 'Dynamic') assert.ok(entry.value !== null, `${entry.key} Dynamic without value`);
    }
    for (const [key, expected] of Object.entries(testCase.expected)) {
      const actual = byKey.get(key);
      assert.equal(actual.evidenceState, expected.evidenceState, `${key} state (${actual.stateReason})`);
      assert.deepEqual(actual.value, expected.value, `${key} value`);
    }
    // Deviations are phrased as items to verify, never as illegality.
    const deviations = byKey.get('regulatory_deviations').value?.items ?? [];
    for (const item of deviations) {
      assert.match(item, /— verify$/);
      assert.doesNotMatch(item, /illegal|unlawful|void|non-compliant/i);
    }
  });
}

test('missing input never yields a guessed value', () => {
  const output = section.analyze({ asOf: '2026-10-02', parameters: new Map(), household: { members: [], city: null }, otherRecords: [], references: {} });
  for (const entry of output) {
    if (entry.key === 'regulatory_floor_version') continue;
    assert.equal(entry.evidenceState, 'Unknown');
    assert.equal(entry.value, null);
  }
});

test('Dynamic comparisons carry the floor date and version in stateReason', () => {
  const output = section.analyze({
    asOf: '2026-10-02',
    parameters: { ped_waiting_period_months: { evidenceState: 'Proven', value: { kind: 'months', count: 36 } } },
    references: {},
  });
  const ped = output.find(entry => entry.key === 'ped_wait_within_floor');
  assert.equal(ped.evidenceState, 'Dynamic');
  assert.ok(ped.stateReason.includes(REGULATORY_FLOOR.asOf));
  assert.ok(ped.stateReason.includes(REGULATORY_FLOOR.version));
});
