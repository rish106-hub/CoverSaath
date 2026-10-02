import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import section from '../src/modules/policy-breakdown/sections/s06-money.js';
import { normaliseValue, sectionOutputSchema, BASES, EFFECTS } from '../src/modules/policy-breakdown/contracts.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/policy-breakdown/${name}`, import.meta.url));
const wording = readFileSync(fixture('s06-wording.txt'), 'utf8');
const gold = JSON.parse(readFileSync(fixture('s06-gold.json'), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  sum_insured_amount: ['money', { critical: true, emergencyCard: true, estimateInput: true }],
  room_rent_limit_kind: ['enum', { critical: true, emergencyCard: true, estimateInput: true }, ['no_limit', 'fixed_amount_per_day', 'percent_of_si_per_day', 'room_category', 'category_or_percent']],
  room_rent_eligible_category: ['enum', { estimateInput: true }, ['general_ward', 'shared_room', 'single_private_room', 'single_private_ac_room', 'any_room', 'not_stated']],
  room_rent_limit_amount: ['money', { estimateInput: true }],
  room_rent_limit_percent: ['percent', { estimateInput: true }],
  icu_limit_kind: ['enum', { critical: true, emergencyCard: true, estimateInput: true }, ['no_limit', 'actuals', 'fixed_amount_per_day', 'percent_of_si_per_day']],
  icu_limit_amount: ['money', {}],
  icu_limit_percent: ['percent', {}],
  proportionate_deduction_applies: ['boolean', { critical: true, estimateInput: true }],
  proportionate_deduction_exempt_heads: ['text_list', { estimateInput: true }],
  copay_general_percent: ['percent', { estimateInput: true }],
  copay_age_percent: ['percent', { critical: true, emergencyCard: true, estimateInput: true }],
  copay_age_threshold_years: ['years', { critical: true, estimateInput: true }],
  copay_zone_percent: ['percent', { estimateInput: true }],
  policy_zone: ['enum', {}, ['zone_a', 'zone_b', 'zone_c', 'not_zoned']],
  copay_non_network_percent: ['percent', { estimateInput: true }],
  deductible_amount: ['money', { estimateInput: true }],
  cumulative_bonus_percent_per_year: ['percent', {}],
  cumulative_bonus_max_percent: ['percent', {}],
  restoration_available: ['boolean', {}],
  restoration_percent: ['percent', {}],
  restoration_conditions: ['rule', {}],
  cataract_limit_per_eye: ['money', { estimateInput: true }],
  maternity_normal_limit: ['money', { estimateInput: true }],
  maternity_csection_limit: ['money', { estimateInput: true }],
  road_ambulance_limit: ['money', { estimateInput: true }],
  modern_treatment_limit_percent: ['percent', { estimateInput: true }],
  reasonable_customary_clause: ['boolean', {}],
  consumables_payable: ['boolean', { estimateInput: true }],
  reducer_order: ['rule', { estimateInput: true }],
};

test('section 6 is a valid defineSection result', () => {
  assert.equal(section.number, 6);
  assert.equal(section.id, 'section-06-money');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length > 2_000 && section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  assert.ok(Object.isFrozen(section) && Object.isFrozen(section.parameters));
  assert.doesNotThrow(() => sectionOutputSchema(section));
  for (const parameter of section.parameters) {
    assert.ok(parameter.description.length > 10, parameter.key);
    assert.ok(parameter.effects.every(effect => EFFECTS.includes(effect)), parameter.key);
    assert.ok(parameter.bases.every(basis => BASES.includes(basis)), parameter.key);
    assert.ok(parameter.bases.length < BASES.length, `${parameter.key} must restrict bases`);
  }
});

test('section 6 declares every required key with the exact type and flags', () => {
  for (const [key, [valueType, flags, enumValues]] of Object.entries(REQUIRED)) {
    const parameter = byKey.get(key);
    assert.ok(parameter, `missing ${key}`);
    assert.equal(parameter.valueType, valueType, key);
    for (const [flag, expected] of Object.entries(flags)) assert.equal(parameter[flag], expected, `${key}.${flag}`);
    if (enumValues) assert.deepEqual([...parameter.enumValues], enumValues, key);
  }
  const critical = section.parameters.filter(parameter => parameter.critical).map(parameter => parameter.key).sort();
  assert.deepEqual(critical, ['copay_age_percent', 'copay_age_threshold_years', 'icu_limit_kind', 'proportionate_deduction_applies', 'room_rent_limit_kind', 'sum_insured_amount']);
});

test('every money and percent parameter has a plausibility validator', () => {
  for (const parameter of section.parameters) {
    if (parameter.valueType === 'money' || parameter.valueType === 'percent') {
      assert.equal(typeof parameter.validate, 'function', `${parameter.key} needs validate()`);
    }
  }
  const si = byKey.get('sum_insured_amount');
  const item = valueNumber => ({ valueNumber });
  assert.equal(normaliseValue(si, item(1_000_000)).ok, true);
  assert.equal(normaliseValue(si, item(5_000)).ok, false, 'below ₹10,000');
  assert.equal(normaliseValue(si, item(200_000_000)).ok, false, 'above ₹10 crore');
  assert.equal(normaliseValue(byKey.get('room_rent_limit_percent'), item(25)).ok, false, '25% of SI per day is implausible');
  assert.equal(normaliseValue(byKey.get('copay_age_percent'), item(120)).ok, false);
  assert.equal(normaliseValue(byKey.get('copay_age_threshold_years'), item(900)).ok, false);
  assert.equal(normaliseValue(byKey.get('cataract_limit_per_eye'), item(40_000)).ok, true);
  assert.equal(normaliseValue(byKey.get('deductible_amount'), item(0)).ok, true, 'Nil deductible is valid');
  const { value } = normaliseValue(si, item(1_000_000));
  assert.deepEqual(value, { kind: 'money', amountMinor: 100_000_000, currency: 'INR' });
});

test('gold answers match the section, normalise and quote the wording verbatim', () => {
  assert.equal(gold.section, 6);
  const outputFields = Object.keys(sectionOutputSchema(section).properties.parameters.items.properties).filter(field => field !== 'citations');
  const goldKeys = new Set();
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `unknown gold key ${item.key}`);
    goldKeys.add(item.key);
    assert.deepEqual(Object.keys(item).sort(), [...outputFields, 'quote'].sort(), item.key);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.equal(result.ok, true, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string', item.key);
      assert.ok(wording.includes(item.quote), `quote for ${item.key} is not verbatim`);
      if (item.basis !== null) assert.ok(parameter.bases.includes(item.basis), `${item.key} basis ${item.basis}`);
      if (item.effect !== null) assert.ok(parameter.effects.includes(item.effect), `${item.key} effect ${item.effect}`);
    } else {
      assert.equal(item.quote, null, item.key);
      assert.equal(item.confidence, 'high', item.key);
      for (const field of ['valueText', 'valueNumber', 'valueBoolean', 'valueList', 'unit', 'basis', 'effect', 'memberScope']) assert.equal(item[field], null, `${item.key}.${field}`);
      assert.deepEqual(item.conditions, []);
      assert.deepEqual(item.exceptions, []);
    }
  }
  assert.ok(gold.expected.some(item => !item.found), 'at least one found=false');
  for (const parameter of section.parameters) assert.ok(goldKeys.has(parameter.key), `gold missing ${parameter.key}`);
});

test('gold encodes the section 6 traps', () => {
  const get = key => gold.expected.find(item => item.key === key);
  assert.equal(get('sum_insured_amount').valueNumber, 1_000_000, '₹10,00,000 is ten lakh rupees');
  assert.equal(get('room_rent_limit_kind').valueText, 'category_or_percent');
  assert.equal(get('room_rent_limit_amount').found, false, 'no rupee figure may be computed from 1% of SI');
  assert.equal(get('icu_limit_kind').valueText, 'actuals');
  assert.equal(get('copay_age_percent').memberScope, null, 'age trigger is not a named member');
  assert.equal(get('copay_general_percent').found, false, '"As per Section 3.4" is a pointer, not a general co-pay');
  assert.equal(get('reducer_order').found, false, 'order not stated');
  assert.equal(get('cataract_limit_per_eye').basis, 'per_eye');
  assert.equal(get('deductible_amount').valueNumber, 0);
  assert.deepEqual(get('proportionate_deduction_exempt_heads').valueList, ['pharmacy and consumables', 'cost of implants', 'diagnostics']);
});
