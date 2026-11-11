// Fact-key registry for the personal memory layer (ADR 0023, ADR 0032). One key names one question about a policy or a household
// ("what is the sum insured?", "how long is the PED waiting period?"). It is APPEND-ONLY: never rename, reorder or remove a key;
// add new keys at the end and bump nothing (the version only changes for a breaking reading rule).
//
// This registry does not replace src/features/policy-facts/fact-types.js (the closed list of facts read from ONE document, ADR 0025).
// It maps onto it: every fact type there is named by exactly one key here (`factType`), with the same value type, and a key that has
// no fact type is a memory-only key (insurer wording, user declarations). tests/policy-facts-registry.test.mjs fails on drift.
//
//   key        stable id, [a-z][a-z0-9_]{2,63}; equals the fact type name when `factType` is set
//   type       value type (VALUE_TYPES of fact-types.js): money date date_range duration percent number enum bool text
//   unit       unit of the sealed value: paise (INR minor units) iso_date iso_date_range days basis_points count years none
//   group      screen / chat grouping
//   label      the question as asked of a person
//   factClass  personal_value | product_term | household_declaration (ADR 0023 D3: which tier is primary)
//   factType   fact-types.js name, or null
//   registryKey policy parameter registry key (a.. to k..) the key informs, or null
//
// Values live only sealed in household_memory_facts.value_enc. This file holds no personal data.

export const POLICY_FACT_REGISTRY_VERSION = 'policy-facts/v1';
export const DECLARATION_KEY_SCHEMA = 'declarations/v1';

export const FACT_CLASSES = Object.freeze(['personal_value', 'product_term', 'household_declaration']);
export const MEMBER_SCOPES = Object.freeze(['policy', 'policyholder', 'dependent', 'household']);
export const SOURCE_TIERS = Object.freeze(['own_pdf', 'ida_wording', 'user_declaration']);
export const CAPTURE_METHODS = Object.freeze(['typed', 'voice_transcript', 'box_confirm', 'conflict_resolution']);
export const KEY_SCHEMAS = Object.freeze([POLICY_FACT_REGISTRY_VERSION, DECLARATION_KEY_SCHEMA]);
export const FACT_KEY_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

// Status vocabulary per tier. Machine rows never reach user_confirmed or reviewed_reference by model output: reviewed_reference is
// written by deterministic code from the IDA reference, user_confirmed only from a household adult's own statement. The word
// "confirmed" alone is never a status (AI.md, ADR 0003, ADR 0009).
export const TIER_STATUSES = Object.freeze({
  own_pdf: Object.freeze(['extracted_unverified', 'conflicting', 'unknown']),
  ida_wording: Object.freeze(['reviewed_reference', 'conflicting', 'unknown']),
  user_declaration: Object.freeze(['user_confirmed']),
});
export const MEMORY_STATUSES = Object.freeze([...new Set(Object.values(TIER_STATUSES).flat())]);

const key = (name, type, unit, group, label, factClass, factType, registryKey) =>
  Object.freeze({ key: name, type, unit, group, label, factClass, factType, registryKey });
const mapped = (name, type, unit, group, label, factClass, registryKey = null) => key(name, type, unit, group, label, factClass, name, registryKey);
const memory = (name, type, unit, group, label, factClass, registryKey = null) => key(name, type, unit, group, label, factClass, null, registryKey);

export const POLICY_FACT_KEYS = Object.freeze([
  // ---- Cover and money (one per fact type of fact-types.js, in its order) ----
  mapped('sum_insured', 'money', 'paise', 'cover', 'What is the sum insured?', 'personal_value', 'd.sum_insured'),
  mapped('premium_total', 'money', 'paise', 'premium', 'What is the total premium you pay?', 'personal_value', 'i.premium_now'),
  mapped('premium_base', 'money', 'paise', 'premium', 'What is the premium before tax?', 'personal_value'),
  mapped('premium_gst', 'money', 'paise', 'premium', 'How much GST is in the premium?', 'personal_value'),
  mapped('deductible', 'money', 'paise', 'limits', 'What deductible applies before the policy pays?', 'personal_value', 'd.deductible'),
  mapped('room_rent_limit', 'money', 'paise', 'limits', 'What is the room rent limit per day?', 'product_term', 'd.room_rent_limit'),
  mapped('sub_limit', 'money', 'paise', 'limits', 'What is the sub-limit for this treatment or disease?', 'product_term', 'd.procedure_and_disease_sub_limits'),
  // ---- Dates and periods ----
  mapped('policy_period', 'date_range', 'iso_date_range', 'dates', 'From when to when does the policy run?', 'personal_value', 'b.policy_period'),
  mapped('issue_date', 'date', 'iso_date', 'dates', 'When was the policy issued?', 'personal_value'),
  mapped('start_date', 'date', 'iso_date', 'dates', 'When did the cover start?', 'personal_value', 'b.policy_period'),
  mapped('end_date', 'date', 'iso_date', 'dates', 'When does the cover end?', 'personal_value', 'b.policy_period'),
  mapped('renewal_date', 'date', 'iso_date', 'dates', 'When is the policy due for renewal?', 'personal_value'),
  mapped('grace_period', 'duration', 'days', 'dates', 'How many days of grace are allowed to pay the renewal?', 'product_term', 'b.grace_period_and_lapse'),
  mapped('free_look_period', 'duration', 'days', 'dates', 'How many days do you have to cancel after buying?', 'product_term', 'b.free_look_period'),
  mapped('continuous_coverage_since', 'date', 'iso_date', 'dates', 'Since when have you had cover without a break?', 'personal_value'),
  // ---- Waiting periods ----
  mapped('waiting_initial', 'duration', 'days', 'waiting', 'How long is the initial waiting period?', 'product_term', 'f.initial_waiting_period'),
  mapped('waiting_ped', 'duration', 'days', 'waiting', 'How long is the waiting period for pre-existing diseases?', 'product_term', 'f.ped_waiting_period'),
  mapped('waiting_maternity', 'duration', 'days', 'waiting', 'How long is the waiting period for maternity?', 'product_term', 'f.maternity_waiting_period'),
  mapped('waiting_specific', 'duration', 'days', 'waiting', 'How long is the waiting period for this named disease or procedure?', 'product_term'),
  mapped('claim_submission_deadline', 'duration', 'days', 'claims', 'By how many days must a reimbursement claim be filed?', 'product_term', 'h.reimbursement_submission_deadline'),
  // ---- Co-payment and bonus ----
  mapped('copay_percent', 'percent', 'basis_points', 'limits', 'What share of each claim do you pay as co-payment?', 'product_term', 'd.co_pay_general'),
  mapped('ncb_tier', 'percent', 'basis_points', 'bonus', 'What no-claim bonus is added for this year of no claims?', 'product_term', 'd.cumulative_no_claim_bonus'),
  mapped('ncb_max', 'percent', 'basis_points', 'bonus', 'What is the most no-claim bonus the policy can add?', 'product_term', 'd.cumulative_no_claim_bonus'),
  mapped('ncb_current', 'percent', 'basis_points', 'bonus', 'How much no-claim bonus have you built up now?', 'personal_value', 'd.cumulative_no_claim_bonus'),
  mapped('loyalty_bonus', 'percent', 'basis_points', 'bonus', 'Is there a loyalty bonus, and how much?', 'product_term', 'd.guaranteed_loyalty_bonus'),
  // ---- Payments ----
  mapped('payment_mode_last', 'enum', 'none', 'payment', 'How did you pay the last premium?', 'personal_value', 'i.payment_mode'),
  mapped('payment_frequency', 'enum', 'none', 'payment', 'How often do you pay the premium?', 'personal_value'),
  mapped('payment_date_last', 'date', 'iso_date', 'payment', 'When did you last pay the premium?', 'personal_value'),
  mapped('payment_count', 'number', 'count', 'payment', 'How many premium payments have you made?', 'personal_value'),
  mapped('payment_total', 'money', 'paise', 'payment', 'How much premium have you paid in total?', 'personal_value'),
  // ---- Seller (never inferred) ----
  mapped('seller_type', 'enum', 'none', 'seller', 'Who sold you this policy: the insurer, an agent, a broker or a bank?', 'personal_value'),
  mapped('seller_name', 'text', 'none', 'seller', 'What is the name of the person or firm who sold it?', 'personal_value'),
  mapped('seller_code', 'text', 'none', 'seller', 'What is the seller code on the policy?', 'personal_value'),
  mapped('seller_irdai_registration', 'text', 'none', 'seller', 'What is the seller IRDAI registration number?', 'personal_value'),
  // ---- Members ----
  mapped('member_count', 'number', 'count', 'members', 'How many people are covered?', 'personal_value'),
  mapped('member_age', 'number', 'years', 'members', 'How old is this covered person?', 'personal_value'),
  // ---- Clauses read as text ----
  mapped('clause_exclusion', 'text', 'none', 'exclusions', 'What does the policy not cover?', 'product_term', 'f.permanent_exclusions'),
  mapped('clause_restoration', 'text', 'none', 'cover', 'How does the sum insured get restored after a claim?', 'product_term', 'd.restoration_recharge'),
  mapped('clause_ayush', 'text', 'none', 'cover', 'Is AYUSH treatment covered, and how?', 'product_term', 'e.ayush'),
  // ---- Memory-only keys: product terms (insurer wording first, own PDF corroborates) ----
  memory('pre_hospitalisation_days', 'duration', 'days', 'cover', 'How many days before admission are costs covered?', 'product_term', 'e.pre_and_post_hospitalisation'),
  memory('post_hospitalisation_days', 'duration', 'days', 'cover', 'How many days after discharge are costs covered?', 'product_term', 'e.pre_and_post_hospitalisation'),
  memory('day_care_covered', 'bool', 'none', 'cover', 'Are day-care procedures covered?', 'product_term', 'e.day_care_procedures'),
  memory('maternity_covered', 'bool', 'none', 'cover', 'Is maternity covered?', 'product_term', 'e.maternity_and_newborn'),
  memory('restoration_available', 'bool', 'none', 'cover', 'Is the sum insured restored after it is used up?', 'product_term', 'd.restoration_recharge'),
  memory('room_category', 'enum', 'none', 'limits', 'Which room category is covered?', 'product_term', 'g.room_category_chosen'),
  memory('network_type', 'enum', 'none', 'network', 'Is it a wide, preferred or restricted hospital network?', 'product_term', 'g.network_status'),
  memory('tpa_name', 'text', 'none', 'network', 'Which TPA or administrator handles claims?', 'product_term', 'a.insurer_tpa_group_administrator'),
  memory('cashless_non_network', 'bool', 'none', 'network', 'Is cashless allowed at hospitals outside the network?', 'product_term', 'g.cashless_at_non_network_hospitals'),
  memory('pre_authorisation_required', 'bool', 'none', 'claims', 'Is approval needed before a planned admission?', 'product_term', 'g.pre_authorisation'),
  memory('claim_intimation_window', 'duration', 'days', 'claims', 'Within how many days must the insurer be told of a claim?', 'product_term', 'h.intimation_deadline'),
  memory('zone', 'enum', 'none', 'limits', 'Which pricing or co-payment zone applies?', 'product_term', 'd.co_pay_zone'),
  memory('copay_zone_percent', 'percent', 'basis_points', 'limits', 'What co-payment applies for this zone?', 'product_term', 'd.co_pay_zone'),
  memory('portability_allowed', 'bool', 'none', 'renewal', 'Can the policy be ported to another insurer?', 'product_term', 'b.portability'),
  memory('lifelong_renewable', 'bool', 'none', 'renewal', 'Can the policy be renewed for life?', 'product_term', 'b.lifelong_renewability'),
  memory('icu_limit', 'money', 'paise', 'limits', 'What is the ICU charge limit per day?', 'product_term', 'd.icu_charge_limit'),
  memory('ambulance_limit', 'money', 'paise', 'limits', 'What is the ambulance cover limit?', 'product_term', 'd.ambulance_and_travel'),
  memory('mental_health_covered', 'bool', 'none', 'cover', 'Is mental health treatment covered?', 'product_term', 'e.mental_health'),
  // ---- Memory-only keys: household declarations (what the household says; the user tier is primary) ----
  memory('declared_ped', 'text', 'none', 'declarations', 'Which pre-existing conditions have you declared?', 'household_declaration', 'c.proposal_form_declarations'),
  memory('declared_prior_claims', 'text', 'none', 'declarations', 'Have you made claims on other policies before?', 'household_declaration'),
  memory('declared_other_cover', 'bool', 'none', 'declarations', 'Do you have other health cover, such as from an employer?', 'household_declaration', 'k.who_has_no_evidenced_cover'),
  memory('declared_dependents_count', 'number', 'count', 'declarations', 'How many people depend on you for health costs?', 'household_declaration'),
]);

export const POLICY_FACT_KEY_NAMES = Object.freeze(POLICY_FACT_KEYS.map(entry => entry.key));
const BY_KEY = new Map(POLICY_FACT_KEYS.map(entry => [entry.key, entry]));

export const isPolicyFactKey = name => typeof name === 'string' && BY_KEY.has(name);
export const getPolicyFactKey = name => BY_KEY.get(name) ?? null;

/** Is this (tier, status) pair allowed? Mirrors the household_memory_facts CHECK. */
export const isTierStatus = (tier, status) => TIER_STATUSES[tier]?.includes(status) === true;
