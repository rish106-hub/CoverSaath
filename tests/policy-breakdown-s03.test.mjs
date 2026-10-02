import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import section from '../src/modules/policy-breakdown/sections/s03-time.js';
import { normaliseValue, sectionOutputSchema } from '../src/modules/policy-breakdown/contracts.js';

const wording = readFileSync(new URL('./fixtures/policy-breakdown/s03-wording.txt', import.meta.url), 'utf8');
const gold = JSON.parse(readFileSync(new URL('./fixtures/policy-breakdown/s03-gold.json', import.meta.url), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  policy_start_date: { valueType: 'date', critical: true, emergencyCard: true },
  policy_end_date: { valueType: 'date', critical: true, emergencyCard: true },
  first_inception_date: { valueType: 'date' },
  grace_period_days: { valueType: 'days' },
  initial_waiting_period_days: { valueType: 'days', critical: true, emergencyCard: true },
  ped_waiting_period_months: { valueType: 'months', critical: true, emergencyCard: true },
  specified_disease_waiting_months: { valueType: 'months', critical: true },
  specified_disease_list: { valueType: 'text_list' },
  maternity_waiting_period_months: { valueType: 'months' },
  accident_exempt_from_initial_wait: { valueType: 'boolean' },
  moratorium_period_months: { valueType: 'months' },
  free_look_period_days: { valueType: 'days' },
  continuity_credit_rule: { valueType: 'rule' },
  relapse_window_days: { valueType: 'days' },
};

const OUTPUT_FIELDS = ['key', 'found', 'valueText', 'valueNumber', 'valueBoolean', 'valueList', 'unit', 'basis', 'effect', 'memberScope', 'conditions', 'exceptions', 'confidence', 'notes'];

test('section 3 is a valid extraction section with the required keys', () => {
  assert.equal(section.number, 3);
  assert.equal(section.id, 'section-03-time');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  assert.ok(Object.isFrozen(section) && Object.isFrozen(section.parameters));
  for (const parameter of section.parameters) {
    assert.equal(parameter.section, 3);
    assert.ok(['cover', 'operational', 'protected'].includes(parameter.visibility));
    if (parameter.valueType === 'enum') assert.ok(parameter.enumValues.length > 0);
  }
  for (const [key, expected] of Object.entries(REQUIRED)) {
    const parameter = byKey.get(key);
    assert.ok(parameter, `missing required key ${key}`);
    assert.equal(parameter.valueType, expected.valueType, `${key} valueType`);
    if (expected.critical) assert.equal(parameter.critical, true, `${key} critical`);
    if (expected.emergencyCard) assert.equal(parameter.emergencyCard, true, `${key} emergencyCard`);
  }
  assert.ok(sectionOutputSchema(section).properties.parameters.items.properties.key.enum.includes('relapse_window_days'));
});

test('validators reject impossible values', () => {
  const ped = byKey.get('ped_waiting_period_months');
  assert.equal(normaliseValue(ped, { valueNumber: 900 }).ok, false);
  const start = byKey.get('policy_start_date');
  assert.equal(normaliseValue(start, { valueText: '2026-02-30' }).ok, false);
  assert.equal(normaliseValue(start, { valueText: '2026-04-01' }).ok, true);
});

test('section 3 gold fixture matches the wording and contract', () => {
  assert.equal(gold.section, 3);
  assert.ok(wording.includes('=== PAGE BREAK ==='));
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `gold key ${item.key} not declared`);
    for (const field of OUTPUT_FIELDS) assert.ok(field in item, `${item.key} missing ${field}`);
    assert.ok(!('citations' in item));
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.ok(result.ok, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(wording.includes(item.quote), `${item.key} quote is not verbatim`);
      assert.ok(item.quote.length <= 600);
      if (item.effect !== null) assert.ok(parameter.effects.includes(item.effect), `${item.key} effect`);
      if (item.basis !== null) assert.ok(parameter.bases.includes(item.basis), `${item.key} basis`);
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.confidence, 'high');
      assert.equal(item.valueText, null);
      assert.equal(item.valueNumber, null);
      assert.equal(item.valueBoolean, null);
    }
  }
  assert.ok(gold.expected.some(item => item.found === false));
  for (const parameter of section.parameters.filter(p => p.critical)) {
    assert.ok(gold.expected.some(item => item.key === parameter.key), `critical ${parameter.key} missing from gold`);
  }
});

test('section 3 gold encodes the unit and date traps correctly', () => {
  const get = key => gold.expected.find(item => item.key === key);
  assert.equal(get('policy_start_date').valueText, '2026-04-01');
  assert.equal(get('policy_end_date').valueText, '2027-03-31');
  assert.equal(get('first_inception_date').valueText, '2023-04-01');
  assert.equal(get('ped_waiting_period_months').valueNumber, 36); // not the 48 of an earlier version
  assert.equal(get('moratorium_period_months').valueNumber, 60); // "sixty continuous months"
  assert.equal(get('free_look_period_days').valueNumber, 30); // "thirty days"
  assert.equal(get('relapse_window_days').found, false);
});
