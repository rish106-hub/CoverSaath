import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import section from '../src/modules/policy-breakdown/sections/s09-renewal.js';
import { defineSection, normaliseValue, sectionOutputSchema } from '../src/modules/policy-breakdown/contracts.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/policy-breakdown/${name}`, import.meta.url));
const wording = readFileSync(fixture('s09-wording.txt'), 'utf8');
const gold = JSON.parse(readFileSync(fixture('s09-gold.json'), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  lifelong_renewal: 'boolean',
  renewal_refusal_grounds: 'rule',
  portability_window_days: 'days',
  migration_option: 'rule',
  group_to_individual_conversion: 'rule',
  premium_revision_rule: 'rule',
  cancellation_refund_basis: 'enum',
  premium_payment_modes: 'text_list',
  instalment_lapse_consequence: 'rule',
  grace_period_cover: 'enum',
  product_withdrawal_rule: 'rule',
};

const OTHER_SECTION_KEYS = ['grace_period_days', 'free_look_period_days', 'sum_insured_amount', 'fraud_clause'];

test('section 9 is a valid defineSection result', () => {
  assert.equal(section.number, 9);
  assert.equal(section.id, 'section-09-renewal');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  assert.ok(Object.isFrozen(section));
  // Round-trips through the contract validator.
  assert.doesNotThrow(() => defineSection({
    number: section.number, id: section.id, title: section.title, question: section.question, kind: section.kind,
    expertise: section.expertise, reviewGuidance: section.reviewGuidance,
    parameters: section.parameters.map(({ section: _s, validate, enumValues, derivedFrom, ...rest }) => ({
      ...rest,
      ...(rest.valueType === 'enum' ? { enumValues: [...enumValues] } : {}),
      ...(validate ? { validate } : {}),
    })),
  }));
  assert.ok(sectionOutputSchema(section).properties.parameters.items.properties.key.enum.includes('lifelong_renewal'));
});

test('section 9 declares every required key with the exact valueType', () => {
  for (const [key, valueType] of Object.entries(REQUIRED)) {
    assert.ok(byKey.has(key), `missing ${key}`);
    assert.equal(byKey.get(key).valueType, valueType, `${key} valueType`);
  }
  assert.equal(byKey.get('lifelong_renewal').critical, true);
  assert.deepEqual([...byKey.get('cancellation_refund_basis').enumValues], ['pro_rata', 'short_period_scale', 'no_refund', 'not_stated']);
  assert.deepEqual([...byKey.get('grace_period_cover').enumValues], ['covered', 'not_covered', 'not_stated']);
  for (const key of OTHER_SECTION_KEYS) assert.ok(!byKey.has(key), `${key} belongs to another section`);
  assert.equal(byKey.get('premium_loading_rule').visibility, 'protected');
  assert.equal(byKey.get('premium_loading_rule').memberScoped, true);
});

test('validators reject impossible values', () => {
  const window = byKey.get('portability_window_days');
  assert.equal(normaliseValue(window, { valueNumber: 900 }).ok, false);
  assert.equal(normaliseValue(window, { valueNumber: 45 }).ok, true);
  assert.equal(normaliseValue(byKey.get('premium_total_amount'), { valueNumber: 0 }).ok, false);
});

test('section 9 gold fixture is consistent with wording and contract', () => {
  assert.equal(gold.section, 9);
  const pages = wording.split('\n=== PAGE BREAK ===\n');
  assert.ok(pages.length >= 2 && pages.length <= 3);
  const goldKeys = new Set();
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `unknown gold key ${item.key}`);
    goldKeys.add(item.key);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.equal(result.ok, true, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(wording.includes(item.quote), `quote for ${item.key} is not verbatim`);
      assert.ok(pages.some(page => page.includes(item.quote)), `quote for ${item.key} crosses a page break`);
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.valueText, null);
      assert.equal(item.valueNumber, null);
      assert.equal(item.valueBoolean, null);
      assert.equal(item.confidence, 'high');
    }
  }
  assert.ok(gold.expected.some(item => !item.found), 'at least one found:false item');
  for (const parameter of section.parameters.filter(p => p.critical)) assert.ok(goldKeys.has(parameter.key), `critical ${parameter.key} missing from gold`);
  for (const key of Object.keys(REQUIRED)) assert.ok(goldKeys.has(key), `required ${key} missing from gold`);
});

test('section 9 traps resolve as expected', () => {
  const get = key => gold.expected.find(item => item.key === key);
  assert.equal(get('grace_period_cover').valueText, 'not_covered');
  assert.equal(get('group_to_individual_conversion').found, false);
  assert.equal(get('portability_window_days').valueNumber, 45);
  assert.equal(get('premium_loading_rule').memberScope, 'Kaushalya Devi');
  assert.equal(get('cancellation_refund_basis').valueText, 'pro_rata');
});
