import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import section from '../src/modules/policy-breakdown/sections/s02-people.js';
import { defineSection, normaliseValue, sectionOutputSchema, BASES, EFFECTS, NOT_STATED } from '../src/modules/policy-breakdown/contracts.js';

const wording = readFileSync(new URL('./fixtures/policy-breakdown/s02-wording.txt', import.meta.url), 'utf8');
const gold = JSON.parse(readFileSync(new URL('./fixtures/policy-breakdown/s02-gold.json', import.meta.url), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  insured_members: { valueType: 'text_list', critical: true, emergencyCard: true },
  sum_insured_structure: { valueType: 'enum', critical: true, enumValues: ['individual', 'family_floater', 'individual_per_member', 'group_pool'] },
  eligible_relationships: { valueType: 'text_list' },
  max_entry_age_years: { valueType: 'years' },
  dependent_child_max_age_years: { valueType: 'years', critical: true },
  newborn_cover: { valueType: 'rule' },
  nominee_required: { valueType: 'boolean' },
  member_specific_conditions: { valueType: 'rule', visibility: 'protected', memberScoped: true },
};

// Keys the brief assigns to other sections; Section 2 must not reuse them.
const OTHER_SECTION_KEYS = [
  'insurer_name', 'product_name', 'product_uin', 'policy_type', 'policy_number', 'tpa_name', 'document_precedence',
  'add_on_covers', 'intermediary_name', 'policy_start_date', 'policy_end_date', 'first_inception_date',
  'grace_period_days', 'initial_waiting_period_days', 'ped_waiting_period_months', 'continuity_credit_rule',
  'maternity_covered', 'ped_definition', 'disclosure_at_renewal_required', 'sum_insured_amount',
  'copay_age_percent', 'copay_age_threshold_years', 'restoration_conditions', 'lifelong_renewal',
  'migration_option', 'group_to_individual_conversion', 'members_without_evidenced_cover',
  'floater_concentration_risk', 'eldest_member_age_years', 'members_attracting_age_copay',
];

test('section 2 is a valid defineSection result', () => {
  assert.equal(section.number, 2);
  assert.equal(section.id, 'section-02-people');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  // The module calls defineSection at import; its output is frozen and stamped with section 2.
  assert.ok(Object.isFrozen(section) && Object.isFrozen(section.parameters));
  assert.ok(section.parameters.every(parameter => parameter.section === 2));
  assert.throws(() => defineSection({ ...section, number: 3 }), /Section id must match its number/);
  const schema = sectionOutputSchema(section);
  assert.deepEqual(schema.properties.parameters.items.properties.key.enum, section.parameters.map(p => p.key));
});

test('section 2 declares every required key with the required type and flags', () => {
  for (const [key, expected] of Object.entries(REQUIRED)) {
    const parameter = byKey.get(key);
    assert.ok(parameter, `missing ${key}`);
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(field === 'enumValues' ? [...parameter[field]] : parameter[field], value, `${key}.${field}`);
    }
  }
  for (const key of OTHER_SECTION_KEYS) assert.ok(!byKey.has(key), `${key} belongs to another section`);
  for (const parameter of section.parameters) {
    if (['member_specific_conditions', 'member_premium_loading_percent', 'declared_conditions', 'underwriting_outcome'].includes(parameter.key)) {
      assert.equal(parameter.visibility, 'protected', `${parameter.key} must be protected`);
    }
  }
});

test('gold items are valid, verbatim and cover every critical parameter', () => {
  assert.equal(gold.section, 2);
  const outputFields = ['key', 'found', 'valueText', 'valueNumber', 'valueBoolean', 'valueList', 'unit', 'basis', 'effect', 'memberScope', 'conditions', 'exceptions', 'confidence', 'notes'];
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `gold key ${item.key} not declared`);
    for (const field of outputFields) assert.ok(field in item, `${item.key} missing ${field}`);
    assert.ok([...BASES, NOT_STATED].includes(item.basis), `${item.key} basis`);
    assert.ok([...EFFECTS, NOT_STATED].includes(item.effect), `${item.key} effect`);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.ok(result.ok, `${item.key} (${item.memberScope}) failed normalisation: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(item.quote.length <= 600, `${item.key} quote too long`);
      assert.ok(wording.includes(item.quote), `${item.key} quote is not verbatim: ${item.quote}`);
      if (parameter.memberScoped && parameter.visibility === 'protected') assert.ok(item.memberScope, `${item.key} needs memberScope`);
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.confidence, 'high');
      for (const field of ['valueText', 'valueNumber', 'valueBoolean', 'valueList', 'unit', 'memberScope']) assert.equal(item[field], null, `${item.key}.${field}`);
      assert.deepEqual(item.conditions, []);
      assert.deepEqual(item.exceptions, []);
    }
  }
  assert.ok(gold.expected.some(item => !item.found), 'at least one found:false item');
  for (const parameter of section.parameters.filter(p => p.critical)) {
    assert.ok(gold.expected.some(item => item.key === parameter.key), `critical ${parameter.key} missing from gold`);
  }
});

test('eligibility is not enrolment and member-specific terms stay scoped', () => {
  const members = gold.expected.find(item => item.key === 'insured_members');
  assert.equal(members.valueList.length, 4);
  assert.ok(!members.valueList.some(entry => /in-law/i.test(entry)), 'parents-in-law are eligible, not insured');
  const eligible = gold.expected.find(item => item.key === 'eligible_relationships');
  assert.ok(eligible.valueList.includes('Parents-in-law'));
  const conditions = gold.expected.filter(item => item.key === 'member_specific_conditions');
  assert.deepEqual(conditions.map(item => item.memberScope), ['Kaushalya Devi']);
  const effective = gold.expected.filter(item => item.key === 'member_effective_date');
  assert.equal(effective.length, 4);
});

test('validators reject impossible values', () => {
  const check = (key, item) => normaliseValue(byKey.get(key), { valueText: null, valueNumber: null, valueBoolean: null, valueList: null, ...item });
  assert.equal(check('dependent_child_max_age_years', { valueNumber: 300 }).ok, false);
  assert.equal(check('max_entry_age_years', { valueNumber: 0 }).ok, false);
  assert.equal(check('member_date_of_birth', { valueText: '1800-01-01' }).ok, false);
  assert.equal(check('insured_members', { valueList: ['Ram Kumar'] }).ok, false);
  assert.equal(check('member_premium_loading_percent', { valueNumber: 0 }).ok, false);
  assert.equal(check('sum_insured_structure', { valueText: 'floater' }).ok, false);
});
