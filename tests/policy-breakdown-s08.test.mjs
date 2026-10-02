import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import section from '../src/modules/policy-breakdown/sections/s08-claims.js';
import { defineSection, normaliseValue, sectionOutputSchema, LIMITS } from '../src/modules/policy-breakdown/contracts.js';

const fixture = name => new URL(`./fixtures/policy-breakdown/${name}`, import.meta.url);
const wording = readFileSync(fixture('s08-wording.txt'), 'utf8');
const gold = JSON.parse(readFileSync(fixture('s08-gold.json'), 'utf8'));
const byKey = new Map(section.parameters.map(parameter => [parameter.key, parameter]));

const REQUIRED = {
  reimbursement_submission_days: { valueType: 'days', critical: true },
  reimbursement_documents: { valueType: 'text_list' },
  claim_settlement_days: { valueType: 'days' },
  interest_on_delayed_settlement: { valueType: 'rule' },
  grievance_officer_contact: { valueType: 'text' },
  grievance_escalation_path: { valueType: 'text_list' },
  ombudsman_available: { valueType: 'boolean' },
  claim_rejection_process: { valueType: 'rule' },
};

test('section 8 is a valid defineSection result', () => {
  assert.equal(section.number, 8);
  assert.equal(section.id, 'section-08-claims');
  assert.equal(section.kind, 'extraction');
  assert.equal(section.analyze, null);
  assert.ok(Object.isFrozen(section));
  assert.ok(section.expertise.length <= 12_000);
  assert.ok(section.reviewGuidance.length > 0);
  assert.ok(section.parameters.length <= LIMITS.maxParametersPerSection);
  // Round-trips through the contract (re-validates every parameter).
  const { analyze: _analyze, ...definition } = section;
  assert.doesNotThrow(() => defineSection({ ...definition, parameters: section.parameters.map(({ section: _s, enumValues, ...rest }) => ({ ...rest, ...(rest.valueType === "enum" ? { enumValues } : {}), validate: rest.validate ?? undefined })) }));
  const schema = sectionOutputSchema(section);
  assert.deepEqual(schema.properties.parameters.items.properties.key.enum, section.parameters.map(parameter => parameter.key));
});

test('section 8 declares every required key with the exact valueType', () => {
  for (const [key, spec] of Object.entries(REQUIRED)) {
    const parameter = byKey.get(key);
    assert.ok(parameter, `missing required key ${key}`);
    assert.equal(parameter.valueType, spec.valueType, `${key} valueType`);
    if (spec.critical) assert.equal(parameter.critical, true, `${key} must be critical`);
  }
});

test('section 8 does not claim Section 7 cashless keys', () => {
  for (const key of ['planned_preauth_notice_hours', 'emergency_intimation_hours', 'tpa_helpline', 'cashless_process', 'preauth_documents']) {
    assert.equal(byKey.has(key), false, `${key} belongs to Section 7`);
  }
});

test('section 8 validators reject impossible values', () => {
  const days = byKey.get('reimbursement_submission_days');
  assert.equal(normaliseValue(days, { valueNumber: 900 }).ok, false);
  assert.equal(normaliseValue(days, { valueNumber: 0 }).ok, false);
  assert.equal(normaliseValue(days, { valueNumber: 30 }).ok, true);
  const hours = byKey.get('reimbursement_intimation_emergency_hours');
  assert.equal(normaliseValue(hours, { valueNumber: 10_000 }).ok, false);
});

test('section 8 gold fixture is consistent with the section and wording', () => {
  assert.equal(gold.section, 8);
  assert.ok(wording.includes('=== PAGE BREAK ==='));
  const outputFields = Object.keys(sectionOutputSchema(section).properties.parameters.items.properties).filter(field => field !== 'citations');
  for (const item of gold.expected) {
    const parameter = byKey.get(item.key);
    assert.ok(parameter, `gold key ${item.key} is not a section 8 parameter`);
    for (const field of outputFields) assert.ok(field in item, `${item.key} missing field ${field}`);
    assert.ok('quote' in item, `${item.key} missing quote`);
    if (item.found) {
      const result = normaliseValue(parameter, item);
      assert.equal(result.ok, true, `${item.key}: ${result.reason}`);
      assert.equal(typeof item.quote, 'string');
      assert.ok(item.quote.length <= LIMITS.maxQuoteCharacters);
      assert.ok(wording.includes(item.quote), `${item.key} quote is not verbatim: ${item.quote}`);
    } else {
      for (const field of ['valueText', 'valueNumber', 'valueBoolean', 'unit', 'basis', 'effect', 'memberScope', 'notes']) assert.equal(item[field], null, `${item.key}.${field}`);
      for (const field of ['valueList', 'conditions', 'exceptions']) assert.deepEqual(item[field], [], `${item.key}.${field}`);
      assert.equal(item.quote, null);
      assert.equal(item.confidence, 'high');
    }
  }
  assert.ok(gold.expected.some(item => item.found === false), 'at least one found:false item');
  const goldKeys = new Set(gold.expected.map(item => item.key));
  for (const parameter of section.parameters.filter(p => p.critical)) assert.ok(goldKeys.has(parameter.key), `critical ${parameter.key} missing from gold`);
  for (const key of Object.keys(REQUIRED)) assert.ok(goldKeys.has(key), `required ${key} missing from gold`);
});

test('section 8 gold encodes the traps: separate post-hospitalisation clock and no regulatory Ombudsman figures', () => {
  const find = key => gold.expected.find(item => item.key === key);
  assert.equal(find('reimbursement_submission_days').valueNumber, 30);
  assert.equal(find('post_hospitalisation_claim_submission_days').valueNumber, 15);
  assert.equal(find('claim_settlement_days').valueNumber, 30);
  assert.equal(find('claim_investigation_settlement_days').valueNumber, 45);
  assert.equal(find('ombudsman_value_limit').found, false);
  assert.equal(find('ombudsman_complaint_window_days').found, false);
});
