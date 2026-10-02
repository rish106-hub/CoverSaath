import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import section from '../src/modules/policy-breakdown/sections/s05-exclusions.js';
import { defineSection, normaliseValue, sectionOutputSchema, LIMITS } from '../src/modules/policy-breakdown/contracts.js';

const fixture = name => new URL(`./fixtures/policy-breakdown/${name}`, import.meta.url);
const wording = readFileSync(fixture('s05-wording.txt'), 'utf8');
const gold = JSON.parse(readFileSync(fixture('s05-gold.json'), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  standard_exclusions: 'text_list',
  permanent_exclusions: 'text_list',
  ped_definition: 'rule',
  disclosure_at_renewal_required: 'boolean',
  non_disclosure_consequence: 'rule',
  fraud_clause: 'rule',
  investigation_only_admission_excluded: 'boolean',
};

test('section 5 is a valid frozen defineSection result', () => {
  assert.equal(section.number, 5);
  assert.equal(section.id, 'section-05-exclusions');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(Object.isFrozen(section));
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  // Re-defining from the frozen output must still pass the contract.
  assert.doesNotThrow(() => defineSection({
    number: section.number, id: section.id, title: section.title, question: section.question, kind: section.kind,
    expertise: section.expertise, reviewGuidance: section.reviewGuidance,
    parameters: section.parameters.map(({ section: _s, validate, enumValues, ...rest }) => ({
      ...rest,
      ...(rest.valueType === 'enum' ? { enumValues: [...enumValues] } : {}),
      ...(validate ? { validate } : {}),
    })),
  }));
  assert.ok(sectionOutputSchema(section).properties.parameters.items.properties.key.enum.includes('standard_exclusions'));
});

test('section 5 declares every required key with the exact valueType', () => {
  for (const [key, valueType] of Object.entries(REQUIRED)) {
    assert.ok(byKey.has(key), `missing ${key}`);
    assert.equal(byKey.get(key).valueType, valueType, key);
  }
  assert.equal(byKey.get('standard_exclusions').critical, true);
  assert.equal(byKey.get('permanent_exclusions').visibility, 'protected');
  assert.equal(byKey.get('permanent_exclusions').memberScoped, true);
});

test('expertise carries the mandatory instructions and no advice', () => {
  const text = section.expertise.toLowerCase();
  for (const phrase of ['verbatim', 'general knowledge', 'another policy', 'each distinct value once', 'memberscope', 'found=false']) {
    assert.ok(text.includes(phrase), `expertise missing: ${phrase}`);
  }
  assert.ok(text.includes('never suggest omitting'));
});

test('gold items match the section and normalise', () => {
  assert.equal(gold.section, 5);
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `unknown gold key ${item.key}`);
    if (item.basis !== null) assert.ok(parameter.bases.includes(item.basis), `${item.key} basis ${item.basis}`);
    if (item.effect !== null) assert.ok(parameter.effects.includes(item.effect), `${item.key} effect ${item.effect}`);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.ok(result.ok, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(item.quote.length <= LIMITS.maxQuoteCharacters, `${item.key} quote too long`);
      assert.ok(wording.includes(item.quote), `${item.key} quote is not verbatim`);
    } else {
      assert.equal(item.quote, null);
      assert.equal(item.valueText, null);
      assert.equal(item.valueNumber, null);
      assert.equal(item.valueBoolean, null);
      assert.equal(item.valueList, null);
      assert.deepEqual(item.conditions, []);
      assert.deepEqual(item.exceptions, []);
      assert.equal(item.confidence, 'high');
    }
  }
});

test('gold covers absent values, critical parameters and trap cases', () => {
  const gk = new Map(gold.expected.map(item => [item.key, item]));
  assert.ok(gold.expected.some(item => item.found === false));
  for (const parameter of section.parameters.filter(p => p.critical)) assert.ok(gk.has(parameter.key), `critical ${parameter.key} missing from gold`);
  // Self-harm must not be inferred from breach-of-law; permanent exclusions not invented from a declared PED.
  assert.equal(gk.get('exclusion_self_harm').found, false);
  assert.equal(gk.get('permanent_exclusions').found, false);
  // Maternity exclusion carries its benefit override; renewal disclosure is health=false with an occupation condition.
  assert.ok(gk.get('exclusion_maternity').exceptions.some(e => e.includes('Maternity Benefit')));
  assert.equal(gk.get('disclosure_at_renewal_required').valueBoolean, false);
  assert.ok(gk.get('disclosure_at_renewal_required').conditions.some(c => c.includes('occupation')));
  // Codes only those printed.
  for (const code of gk.get('standard_exclusion_codes').valueList) assert.ok(wording.includes(code), code);
});

test('validators reject impossible values', () => {
  const codes = byKey.get('standard_exclusion_codes');
  assert.equal(normaliseValue(codes, { valueList: ['Excl04', 'Exclusion 4'] }).ok, false);
  assert.equal(normaliseValue(codes, { valueList: ['Excl04'] }).ok, true);
});
