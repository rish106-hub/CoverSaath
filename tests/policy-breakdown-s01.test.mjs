import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import section from '../src/modules/policy-breakdown/sections/s01-document-authority.js';
import { defineSection, normaliseValue, sectionOutputSchema, LIMITS } from '../src/modules/policy-breakdown/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const wording = readFileSync(join(here, 'fixtures/policy-breakdown/s01-wording.txt'), 'utf8');
const gold = JSON.parse(readFileSync(join(here, 'fixtures/policy-breakdown/s01-gold.json'), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  insurer_name: { valueType: 'text', critical: true, emergencyCard: true },
  product_name: { valueType: 'text' },
  product_uin: { valueType: 'text' },
  policy_type: { valueType: 'enum', critical: true },
  policy_number: { valueType: 'text', critical: true, emergencyCard: true, visibility: 'operational' },
  tpa_name: { valueType: 'text', emergencyCard: true },
  document_precedence: { valueType: 'rule' },
  add_on_covers: { valueType: 'text_list' },
  intermediary_name: { valueType: 'text' },
};

test('section 1 is a valid extraction section', () => {
  assert.equal(section.number, 1);
  assert.equal(section.id, 'section-01-document-authority');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  assert.ok(Object.isFrozen(section));
  // Re-defining from the frozen result must succeed (it is a defineSection result).
  const { number, id, title, question, kind, expertise, reviewGuidance } = section;
  const parameters = section.parameters.map(({ section: _s, validate, enumValues, ...rest }) => ({
    ...rest,
    ...(rest.valueType === 'enum' ? { enumValues: [...enumValues] } : {}),
    ...(validate ? { validate } : {}),
  }));
  assert.doesNotThrow(() => defineSection({ number, id, title, question, kind, expertise, reviewGuidance, parameters }));
  assert.ok(sectionOutputSchema(section).properties.parameters.items.properties.key.enum.includes('policy_type'));
});

test('section 1 expertise states the mandatory extraction rules', () => {
  const text = section.expertise.toLowerCase();
  for (const phrase of ['verbatim', 'never infer', 'another policy', 'each distinct value once', 'memberscope', 'found=false']) {
    assert.ok(text.includes(phrase), `expertise missing: ${phrase}`);
  }
});

test('section 1 declares every required key with the required type and flags', () => {
  for (const [key, spec] of Object.entries(REQUIRED)) {
    const parameter = byKey.get(key);
    assert.ok(parameter, `missing required key ${key}`);
    for (const [field, expected] of Object.entries(spec)) assert.equal(parameter[field], expected, `${key}.${field}`);
  }
  assert.deepEqual([...byKey.get('policy_type').enumValues], ['individual', 'family_floater', 'group', 'top_up', 'super_top_up', 'critical_illness', 'fixed_benefit', 'other']);
});

test('section 1 gold answers are consistent with the wording and definitions', () => {
  assert.equal(gold.section, 1);
  assert.ok(gold.expected.some(item => item.found === false), 'at least one found:false item');
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `gold key ${item.key} not declared`);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.ok(result.ok, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(item.quote.length <= LIMITS.maxQuoteCharacters);
      assert.ok(wording.includes(item.quote), `quote for ${item.key} is not verbatim: ${item.quote}`);
      if (item.memberScope) assert.ok(parameter.memberScoped, `${item.key} is not memberScoped`);
      if (item.basis) assert.ok(parameter.bases.includes(item.basis), `${item.key} basis ${item.basis}`);
      if (item.effect) assert.ok(parameter.effects.includes(item.effect), `${item.key} effect ${item.effect}`);
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.confidence, 'high');
      assert.equal(item.valueText, null);
      assert.equal(item.valueNumber, null);
      assert.equal(item.valueBoolean, null);
      assert.deepEqual(item.valueList, []);
    }
  }
  const goldKeys = new Set(gold.expected.map(item => item.key));
  for (const parameter of section.parameters) {
    if (parameter.critical) assert.ok(goldKeys.has(parameter.key), `critical ${parameter.key} missing from gold`);
  }
  for (const key of Object.keys(REQUIRED)) assert.ok(goldKeys.has(key), `required ${key} missing from gold`);
});

test('section 1 traps: add-on UIN is not the base UIN; members carry their own IDs', () => {
  const uin = gold.expected.find(item => item.key === 'product_uin');
  assert.equal(uin.valueText, 'EXAHLIP26001V012526');
  const ids = gold.expected.filter(item => item.key === 'member_id_numbers');
  assert.equal(new Set(ids.map(item => item.memberScope)).size, 4);
  const uinParameter = byKey.get('product_uin');
  assert.equal(normaliseValue(uinParameter, { valueText: 'EXA HLIP 26001' }).ok, false);
  assert.equal(normaliseValue(byKey.get('policy_type'), { valueText: 'floater' }).ok, false);
});
