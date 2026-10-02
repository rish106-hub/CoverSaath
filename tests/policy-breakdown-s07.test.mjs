import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import section from '../src/modules/policy-breakdown/sections/s07-hospital-access.js';
import {
  BASES, EFFECTS, NOT_STATED, VALUE_TYPES, normaliseValue, sectionOutputSchema,
} from '../src/modules/policy-breakdown/contracts.js';

const fixture = name => fileURLToPath(new URL(`./fixtures/policy-breakdown/${name}`, import.meta.url));
const wording = readFileSync(fixture('s07-wording.txt'), 'utf8');
const gold = JSON.parse(readFileSync(fixture('s07-gold.json'), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  cashless_network_available: { valueType: 'boolean', critical: true, emergencyCard: true },
  cashless_non_network_available: { valueType: 'boolean' },
  network_list_reference: { valueType: 'text' },
  planned_preauth_notice_hours: { valueType: 'count', critical: true, emergencyCard: true },
  emergency_intimation_hours: { valueType: 'count', critical: true, emergencyCard: true },
  tpa_helpline: { valueType: 'text', critical: true, emergencyCard: true, visibility: 'operational' },
  insurer_helpline: { valueType: 'text', emergencyCard: true },
  cashless_process: { valueType: 'rule', emergencyCard: true },
  preauth_documents: { valueType: 'text_list' },
  excluded_hospitals_rule: { valueType: 'rule' },
  cashless_decision_hours: { valueType: 'count' },
  discharge_authorisation_hours: { valueType: 'count' },
};

test('section 7 is a valid extraction section', () => {
  assert.equal(section.number, 7);
  assert.equal(section.id, 'section-07-hospital-access');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length > 2_000 && section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  assert.ok(Object.isFrozen(section));
  for (const parameter of section.parameters) assert.ok(VALUE_TYPES.includes(parameter.valueType));
  const schema = sectionOutputSchema(section);
  assert.deepEqual(schema.properties.parameters.items.properties.key.enum, section.parameters.map(p => p.key));
});

test('section 7 declares every required key with the required type and flags', () => {
  for (const [key, expected] of Object.entries(REQUIRED)) {
    const parameter = byKey.get(key);
    assert.ok(parameter, `missing required key ${key}`);
    for (const [field, value] of Object.entries(expected)) assert.equal(parameter[field], value, `${key}.${field}`);
  }
});

test('expertise carries the non-negotiable extraction rules', () => {
  const text = section.expertise.toLowerCase();
  for (const phrase of ['verbatim', 'never infer', 'another policy', 'once', 'memberscope', 'found=false', 'never insert a number', 'do not give advice']) {
    assert.ok(text.includes(phrase), `expertise missing: ${phrase}`);
  }
});

test('validators reject impossible values', () => {
  const planned = byKey.get('planned_preauth_notice_hours');
  assert.equal(normaliseValue(planned, { valueNumber: 72 }).ok, true);
  assert.equal(normaliseValue(planned, { valueNumber: 90_000 }).ok, false);
  const helpline = byKey.get('tpa_helpline');
  assert.equal(normaliseValue(helpline, { valueText: 'call the TPA' }).ok, false);
  assert.equal(normaliseValue(helpline, { valueText: '1800-000-0000' }).ok, true);
  assert.equal(normaliseValue(byKey.get('tpa_cashless_email'), { valueText: 'not an email' }).ok, false);
});

test('gold fixture matches the section and the wording', () => {
  assert.equal(gold.section, 7);
  const goldKeys = new Set();
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `gold key ${item.key} is not a section 7 parameter`);
    assert.ok(!goldKeys.has(item.key), `duplicate gold key ${item.key}`);
    goldKeys.add(item.key);
    assert.ok([...BASES, NOT_STATED].includes(item.basis), `${item.key} basis`);
    assert.ok([...EFFECTS, NOT_STATED].includes(item.effect), `${item.key} effect`);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.equal(result.ok, true, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(wording.includes(item.quote), `quote for ${item.key} is not verbatim in the wording`);
      if (item.basis !== NOT_STATED) assert.ok(parameter.bases.includes(item.basis), `${item.key} basis outside declared subset`);
      if (item.effect !== NOT_STATED) assert.ok(parameter.effects.includes(item.effect), `${item.key} effect outside declared subset`);
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.valueText, null);
      assert.equal(item.valueNumber, null);
      assert.equal(item.valueBoolean, null);
      assert.deepEqual(item.valueList, []);
      assert.equal(item.confidence, 'high');
    }
  }
  assert.ok(gold.expected.some(item => !item.found), 'at least one found:false item');
  for (const parameter of section.parameters) {
    if (parameter.critical) assert.ok(goldKeys.has(parameter.key), `critical ${parameter.key} missing from gold`);
  }
});

test('helpline traps: grievance number is never a cashless or customer-care helpline', () => {
  const values = gold.expected.filter(item => ['tpa_helpline', 'insurer_helpline'].includes(item.key)).map(item => item.valueText);
  assert.deepEqual(values.sort(), ['1800-000-0000', '1800-000-1111']);
  assert.ok(!values.includes('1800-000-0001'));
});
