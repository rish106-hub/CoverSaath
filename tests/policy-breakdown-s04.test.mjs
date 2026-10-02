import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import section from '../src/modules/policy-breakdown/sections/s04-treatment.js';
import { normaliseValue, sectionOutputSchema, BASES, EFFECTS } from '../src/modules/policy-breakdown/contracts.js';

const fixtureDir = new URL('./fixtures/policy-breakdown/', import.meta.url);
const wording = readFileSync(new URL('s04-wording.txt', fixtureDir), 'utf8');
const gold = JSON.parse(readFileSync(new URL('s04-gold.json', fixtureDir), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  inpatient_minimum_hours: 'count',
  daycare_covered: 'boolean',
  pre_hospitalisation_days: 'days',
  post_hospitalisation_days: 'days',
  hospital_definition: 'rule',
  maternity_covered: 'boolean',
  modern_treatments_covered: 'boolean',
  modern_treatment_list: 'text_list',
  ayush_covered: 'boolean',
  domiciliary_covered: 'boolean',
  organ_donor_covered: 'boolean',
  mental_illness_covered: 'boolean',
  opd_covered: 'boolean',
  treatment_abroad_covered: 'boolean',
};

// Keys owned by other sections in the specialist brief; Section 4 must not reuse them.
const OTHER_SECTION_KEYS = [
  'newborn_cover', 'maternity_waiting_period_months', 'accident_exempt_from_initial_wait',
  'investigation_only_admission_excluded', 'maternity_normal_limit', 'maternity_csection_limit',
  'modern_treatment_limit_percent', 'road_ambulance_limit', 'cataract_limit_per_eye', 'specified_disease_list',
];

test('section 4 is a valid extraction section with the required keys and types', () => {
  assert.equal(section.number, 4);
  assert.equal(section.id, 'section-04-treatment');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  for (const [key, valueType] of Object.entries(REQUIRED)) {
    assert.ok(byKey.has(key), `missing required key ${key}`);
    assert.equal(byKey.get(key).valueType, valueType, `${key} valueType`);
  }
  for (const key of ['pre_hospitalisation_days', 'post_hospitalisation_days']) assert.equal(byKey.get(key).critical, true);
  for (const key of OTHER_SECTION_KEYS) assert.ok(!byKey.has(key), `${key} belongs to another section`);
  assert.ok(section.parameters.every(parameter => parameter.valueType !== 'money'), 'Section 4 must not declare money parameters');
  assert.deepEqual(sectionOutputSchema(section).properties.parameters.items.properties.key.enum, [...byKey.keys()]);
});

test('validators reject impossible values', () => {
  assert.equal(normaliseValue(byKey.get('pre_hospitalisation_days'), { valueNumber: 900 }).ok, false);
  assert.equal(normaliseValue(byKey.get('inpatient_minimum_hours'), { valueNumber: 0 }).ok, false);
  assert.equal(normaliseValue(byKey.get('maternity_delivery_count_limit'), { valueNumber: 40 }).ok, false);
  assert.equal(normaliseValue(byKey.get('post_hospitalisation_days'), { valueNumber: 180 }).ok, true);
});

test('gold items match parameters, normalise, and quote the wording verbatim', () => {
  assert.equal(gold.section, 4);
  assert.ok(wording.includes('=== PAGE BREAK ==='));
  const seen = new Set();
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `gold key ${item.key} is not a Section 4 parameter`);
    assert.ok(!seen.has(item.key), `duplicate gold key ${item.key}`);
    seen.add(item.key);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.ok(result.ok, `${item.key} failed normalisation: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(wording.includes(item.quote), `${item.key} quote is not verbatim: ${item.quote}`);
      if (item.effect !== null) {
        assert.ok(EFFECTS.includes(item.effect));
        assert.ok(parameter.effects.includes(item.effect), `${item.key} effect ${item.effect} not allowed`);
      }
      if (item.basis !== null) {
        assert.ok(BASES.includes(item.basis));
        assert.ok(parameter.bases.includes(item.basis), `${item.key} basis ${item.basis} not allowed`);
      }
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.valueText, null);
      assert.equal(item.valueNumber, null);
      assert.equal(item.valueBoolean, null);
      assert.deepEqual(item.valueList, []);
      assert.equal(item.confidence, 'high');
    }
  }
  assert.ok(gold.expected.some(item => item.found === false), 'at least one parameter must be absent');
  for (const parameter of section.parameters.filter(p => p.critical)) {
    assert.ok(seen.has(parameter.key), `critical parameter ${parameter.key} missing from gold`);
  }
});

test('fixture traps are captured: member-scoped maternity and pre/post day counts not swapped', () => {
  const get = key => gold.expected.find(item => item.key === key);
  assert.equal(get('maternity_covered').memberScope, 'Sita Kumar');
  assert.equal(get('pre_hospitalisation_days').valueNumber, 60);
  assert.equal(get('post_hospitalisation_days').valueNumber, 180);
  assert.equal(get('opd_covered').found, true);
  assert.equal(get('opd_covered').valueBoolean, false);
  assert.equal(get('vaccination_covered').found, false);
});
