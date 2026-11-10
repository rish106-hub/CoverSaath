// The closed list of policy fact types (ADR 0025). The database column is plain text with a shape CHECK; this list is the real
// vocabulary and is validated in the application. A new type is added here, with a test, and needs no migration.
//
//   valueType    how the value is stored (matches policy_facts.value_type and the shape CHECK of migration 044)
//   parse        the normaliser that turns printed text into a value (normalisers.js); the evidence verifier runs it on the quote
//   registryKey  the policy-parameter registry key this fact informs, or null. A model may propose a fact only when it maps to a
//                registry key whose modelExtraction.allowed is true: an unmapped type is model-forbidden (deterministic only)
//   scoped       true when a scope_key (a disease, a year, a member) is part of the fact's identity
//   policyTypes  the case policy types (service_cases.policy_type, migration 041) the fact applies to

import { getPolicyParameterRegistry, POLICY_PARAMETER_REGISTRY_VERSION } from '../coverage-analysis/policy-parameter-registry.js';

const HEALTH = Object.freeze(['personal_health', 'group_health', 'other']);
const ALL = Object.freeze(['personal_health', 'group_health', 'term_life', 'other']);
const type = (valueType, parse, registryKey, { scoped = false, policyTypes = ALL } = {}) => Object.freeze({ valueType, parse, registryKey, scoped, policyTypes });

export const FACT_TYPES = Object.freeze({
  // Money
  sum_insured: type('money', 'money', 'd.sum_insured'),
  premium_total: type('money', 'money', 'i.premium_now'),
  premium_base: type('money', 'money', null),
  premium_gst: type('money', 'money', null),
  deductible: type('money', 'money', 'd.deductible', { policyTypes: HEALTH }),
  room_rent_limit: type('money', 'money', 'd.room_rent_limit', { policyTypes: HEALTH }),
  sub_limit: type('money', 'money', 'd.procedure_and_disease_sub_limits', { scoped: true, policyTypes: HEALTH }),
  // Dates and periods
  policy_period: type('date_range', 'date_range', 'b.policy_period'),
  issue_date: type('date', 'date', null),
  start_date: type('date', 'date', 'b.policy_period'),
  end_date: type('date', 'date', 'b.policy_period'),
  renewal_date: type('date', 'date', null),
  grace_period: type('duration', 'duration', 'b.grace_period_and_lapse'),
  free_look_period: type('duration', 'duration', 'b.free_look_period'),
  continuous_coverage_since: type('date', 'date', null, { policyTypes: HEALTH }),
  // Waiting periods (days; the printed unit is kept sealed)
  waiting_initial: type('duration', 'duration', 'f.initial_waiting_period', { policyTypes: HEALTH }),
  waiting_ped: type('duration', 'duration', 'f.ped_waiting_period', { policyTypes: HEALTH }),
  waiting_maternity: type('duration', 'duration', 'f.maternity_waiting_period', { policyTypes: HEALTH }),
  waiting_specific: type('duration', 'duration', null, { scoped: true, policyTypes: HEALTH }),
  claim_submission_deadline: type('duration', 'duration', 'h.reimbursement_submission_deadline', { policyTypes: HEALTH }),
  // Co-payment and no-claim bonus (basis points)
  copay_percent: type('percent', 'percent', 'd.co_pay_general', { policyTypes: HEALTH }),
  ncb_tier: type('percent', 'percent', 'd.cumulative_no_claim_bonus', { scoped: true, policyTypes: HEALTH }),
  ncb_max: type('percent', 'percent', 'd.cumulative_no_claim_bonus', { policyTypes: HEALTH }),
  ncb_current: type('percent', 'percent', 'd.cumulative_no_claim_bonus', { policyTypes: HEALTH }),
  loyalty_bonus: type('percent', 'percent', 'd.guaranteed_loyalty_bonus', { policyTypes: HEALTH }),
  // Payments
  payment_mode_last: type('enum', 'payment_mode', 'i.payment_mode'),
  payment_frequency: type('enum', 'payment_frequency', null),
  payment_date_last: type('date', 'date', null),
  payment_count: type('number', 'number', null),
  payment_total: type('money', 'money', null),
  // Seller (never inferred: absent means the type is unknown)
  seller_type: type('enum', 'seller_type', null),
  seller_name: type('text', 'text', null),
  seller_code: type('text', 'text', null),
  seller_irdai_registration: type('text', 'text', null),
  // Members (ages, never dates of birth)
  member_count: type('number', 'number', null),
  member_age: type('number', 'age', null, { scoped: true }),
  // Clauses a reader may propose (free text, sealed)
  clause_exclusion: type('text', 'text', 'f.permanent_exclusions', { scoped: true, policyTypes: HEALTH }),
  clause_restoration: type('text', 'text', 'd.restoration_recharge', { policyTypes: HEALTH }),
  clause_ayush: type('text', 'text', 'e.ayush', { policyTypes: HEALTH }),
});

export const FACT_TYPE_TO_REGISTRY_KEY = Object.freeze(Object.fromEntries(
  Object.entries(FACT_TYPES).map(([name, spec]) => [name, spec.registryKey])));

export const FACT_TYPE_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;
export const SCOPE_KEY_PATTERN = /^[a-z0-9_.:-]{0,64}$/;
export const VALUE_TYPES = Object.freeze(['money', 'date', 'date_range', 'duration', 'percent', 'number', 'enum', 'bool', 'text']);

export const isFactType = name => typeof name === 'string' && Object.hasOwn(FACT_TYPES, name);

/** Fact types that apply to a case policy type (a term-life case has no waiting periods, copay or no-claim bonus). */
export function applicableFactTypes(policyType) {
  return Object.entries(FACT_TYPES).filter(([, spec]) => spec.policyTypes.includes(policyType)).map(([name]) => name);
}

/**
 * May a model propose this fact type? Only when it maps to a registry parameter whose modelExtraction.allowed is true. An unmapped
 * type, or one mapped to a forbidden or unknown key, is model-forbidden (fail closed).
 */
export function modelMayProposeFact(factType, registryVersion = POLICY_PARAMETER_REGISTRY_VERSION) {
  const key = FACT_TYPES[factType]?.registryKey;
  if (!key) return false;
  try {
    const definition = getPolicyParameterRegistry(registryVersion).parameters.find(entry => entry.key === key);
    return definition?.modelExtraction?.allowed === true;
  } catch {
    return false;
  }
}
