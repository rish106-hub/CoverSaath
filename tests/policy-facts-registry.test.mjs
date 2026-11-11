import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPTURE_METHODS, FACT_CLASSES, FACT_KEY_PATTERN, MEMORY_STATUSES, POLICY_FACT_KEYS, POLICY_FACT_KEY_NAMES, TIER_STATUSES,
  getPolicyFactKey, isPolicyFactKey, isTierStatus,
} from '../src/contracts/policy-facts.js';
import { FACT_TYPES, VALUE_TYPES } from '../src/features/policy-facts/fact-types.js';
import { getPolicyParameterRegistry, POLICY_PARAMETER_REGISTRY_VERSION } from '../src/features/coverage-analysis/policy-parameter-registry.js';

// Append-only: this is the v1 key list as first committed. A later change may only ADD keys after these (append them here too).
const V1_PREFIX = ['sum_insured', 'premium_total', 'premium_base', 'premium_gst', 'deductible', 'room_rent_limit', 'sub_limit', 'policy_period',
  'issue_date', 'start_date', 'end_date', 'renewal_date', 'grace_period', 'free_look_period', 'continuous_coverage_since', 'waiting_initial',
  'waiting_ped', 'waiting_maternity', 'waiting_specific', 'claim_submission_deadline', 'copay_percent', 'ncb_tier', 'ncb_max', 'ncb_current',
  'loyalty_bonus', 'payment_mode_last', 'payment_frequency', 'payment_date_last', 'payment_count', 'payment_total', 'seller_type', 'seller_name',
  'seller_code', 'seller_irdai_registration', 'member_count', 'member_age', 'clause_exclusion', 'clause_restoration', 'clause_ayush',
  'pre_hospitalisation_days', 'post_hospitalisation_days', 'day_care_covered', 'maternity_covered', 'restoration_available', 'room_category',
  'network_type', 'tpa_name', 'cashless_non_network', 'pre_authorisation_required', 'claim_intimation_window', 'zone', 'copay_zone_percent',
  'portability_allowed', 'lifelong_renewable', 'icu_limit', 'ambulance_limit', 'mental_health_covered', 'declared_ped', 'declared_prior_claims',
  'declared_other_cover', 'declared_dependents_count'];

test('registry has at least 40 well-formed unique keys and is append-only', () => {
  assert.ok(POLICY_FACT_KEYS.length >= 40);
  assert.deepEqual(POLICY_FACT_KEY_NAMES.slice(0, V1_PREFIX.length), V1_PREFIX, 'keys are never renamed, reordered or removed');
  assert.equal(new Set(POLICY_FACT_KEY_NAMES).size, POLICY_FACT_KEY_NAMES.length);
  const registry = getPolicyParameterRegistry(POLICY_PARAMETER_REGISTRY_VERSION);
  const registryKeys = new Set(registry.parameters.map(parameter => parameter.key));
  for (const entry of POLICY_FACT_KEYS) {
    assert.match(entry.key, FACT_KEY_PATTERN);
    assert.ok(VALUE_TYPES.includes(entry.type), `${entry.key} type`);
    assert.ok(entry.unit && entry.group && entry.label.endsWith('?'), `${entry.key} unit, group and question label`);
    assert.ok(FACT_CLASSES.includes(entry.factClass), `${entry.key} class`);
    if (entry.registryKey) assert.ok(registryKeys.has(entry.registryKey), `${entry.key} -> ${entry.registryKey} exists in the parameter registry`);
    assert.ok(Object.isFrozen(entry));
  }
});

test('drift: every fact type of fact-types.js is named by exactly one key with the same value type and registry key', () => {
  const byFactType = new Map();
  for (const entry of POLICY_FACT_KEYS) {
    if (entry.factType === null) continue;
    assert.ok(Object.hasOwn(FACT_TYPES, entry.factType), `${entry.key} names an unknown fact type ${entry.factType}`);
    assert.equal(entry.key, entry.factType, 'a mapped key carries the fact type name');
    assert.equal(entry.type, FACT_TYPES[entry.factType].valueType, `${entry.key} value type`);
    assert.equal(entry.registryKey, FACT_TYPES[entry.factType].registryKey, `${entry.key} registry key`);
    assert.equal(byFactType.has(entry.factType), false, `${entry.factType} mapped twice`);
    byFactType.set(entry.factType, entry.key);
  }
  assert.deepEqual([...byFactType.keys()].sort(), Object.keys(FACT_TYPES).sort(), 'a fact type with no key, or a key with no fact type');
});

test('status vocabulary: machine rows never reach a user or reference status, and there is no bare "confirmed"', () => {
  assert.deepEqual(TIER_STATUSES.own_pdf, ['extracted_unverified', 'conflicting', 'unknown']);
  assert.deepEqual(TIER_STATUSES.ida_wording, ['reviewed_reference', 'conflicting', 'unknown']);
  assert.deepEqual(TIER_STATUSES.user_declaration, ['user_confirmed']);
  assert.equal(MEMORY_STATUSES.includes('confirmed'), false);
  assert.equal(isTierStatus('own_pdf', 'user_confirmed'), false);
  assert.equal(isTierStatus('own_pdf', 'reviewed_reference'), false);
  assert.equal(isTierStatus('user_declaration', 'extracted_unverified'), false);
  assert.equal(isTierStatus('ida_wording', 'reviewed_reference'), true);
  assert.deepEqual(CAPTURE_METHODS, ['typed', 'voice_transcript', 'box_confirm', 'conflict_resolution']);
});

test('lookups', () => {
  assert.equal(isPolicyFactKey('waiting_ped'), true);
  assert.equal(isPolicyFactKey('nope'), false);
  assert.equal(getPolicyFactKey('sum_insured').type, 'money');
});
