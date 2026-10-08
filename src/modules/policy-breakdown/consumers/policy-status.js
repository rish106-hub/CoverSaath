import { countOf, dateOf, enumOf, fieldView } from './record-values.js';

// Policy overview: the documents that govern it, who services it, who can join, benefits outside a hospital
// stay, and keeping it alive (sections 1–4 and 9). Deterministic: whether the record shows the policy in force on
// a date, what the grace period means, and dated reminders for renewal, portability and conversion. It never
// says a renewal or port will be accepted.

const DAY_MS = 86_400_000;
const toIso = date => date.toISOString().slice(0, 10);
const addDays = (iso, days) => toIso(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS));
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

export const POLICY_STATUS_GROUPS = Object.freeze({
  documents: ['product_uin', 'product_version', 'insurer_registration_number', 'policyholder_name', 'proposer_name', 'previous_policy_number', 'document_set', 'documents_present_in_pack', 'document_issue_date', 'cis_present', 'cis_precedence_statement', 'document_precedence', 'endorsement_list', 'add_on_covers', 'add_on_terms'],
  servicing: ['intermediary_name', 'intermediary_type', 'intermediary_code', 'group_administrator_name', 'grievance_officer_contact', 'insurer_helpline'],
  membership: ['eligible_relationships', 'relationship_definitions', 'min_entry_age_adult_years', 'max_entry_age_years', 'dependent_child_min_entry_age_days', 'max_family_members', 'residency_condition', 'occupation_condition', 'nominee_required', 'nominee_name', 'member_premium_loading_percent', 'pre_policy_checkup_status'],
  otherBenefits: ['opd_covered', 'teleconsultation_covered', 'health_checkup_covered', 'health_checkup_conditions', 'wellness_benefit_rule', 'vaccination_covered', 'second_opinion_covered', 'home_care_covered', 'home_care_conditions', 'rehabilitation_covered', 'dental_vision_rule', 'critical_illness_benefit_covered', 'critical_illness_conditions'],
  insurer: ['claim_settlement_ratio_count', 'claim_settlement_ratio_amount', 'incurred_claim_ratio', 'repudiation_ratio', 'complaints_per_10k_claims', 'solvency_ratio', 'average_settlement_days', 'claims_handling_model', 'network_hospitals_in_city', 'public_complaint_patterns'],
  household: ['members_with_evidenced_cover', 'members_without_evidenced_cover', 'floater_concentration_risk', 'eldest_member_age_years', 'members_attracting_age_copay', 'next_cover_change_date', 'next_cover_change_reason', 'employer_cover_dependence_percent', 'sum_insured_adequacy', 'layering_gap'],
  regulation: ['regulatory_floor_version', 'ped_wait_within_floor', 'specified_wait_within_floor', 'moratorium_within_floor', 'free_look_within_floor', 'initial_wait_within_floor', 'cashless_timeline_within_floor', 'proportionate_deduction_exemptions_within_floor', 'regulatory_deviations'],
  renewal: ['lifelong_renewal', 'renewal_refusal_grounds', 'renewal_notice_rule', 'max_renewal_age_rule', 'grace_period_days', 'grace_period_cover', 'lapse_consequence_rule'],
  premium: ['premium_total_amount', 'premium_base_amount', 'premium_tax_amount', 'premium_loading_rule', 'premium_discounts', 'premium_age_band_rule', 'premium_revision_rule', 'premium_payment_frequency', 'premium_payment_modes', 'multi_year_discount_percent', 'instalment_lapse_consequence', 'tax_benefit_statement'],
  changes: ['policy_terms_revision_rule', 'renewal_sum_insured_change_rule', 'waiting_reset_on_si_enhancement', 'mid_term_addition_rule', 'product_withdrawal_rule', 'product_withdrawal_notice_days'],
  moving: ['portability_window_days', 'portability_carryover_rule', 'migration_option', 'group_to_individual_conversion', 'group_conversion_window_days', 'continuity_credit_rule'],
  leaving: ['free_look_period_days', 'cancellation_refund_basis', 'cancellation_short_period_scale', 'insurer_cancellation_grounds'],
});

export function buildPolicyStatus({ parameters, asOf }) {
  const start = dateOf(parameters, 'policy_start_date');
  const end = dateOf(parameters, 'policy_end_date');
  const grace = countOf(parameters, 'grace_period_days');
  const graceCover = enumOf(parameters, 'grace_period_cover');
  let state = 'unknown';
  let message = 'The policy period is not established in this record.';
  if (start && end) {
    if (asOf < start) { state = 'not_started'; message = `Cover starts on ${start}.`; }
    else if (asOf <= end) { state = 'in_force'; message = `In force until ${end} (${daysBetween(asOf, end)} days left).`; }
    else if (grace != null && asOf <= addDays(end, grace)) {
      state = 'grace_period';
      message = `The period ended on ${end}. Renew by ${addDays(end, grace)}. ${graceCover === 'covered' ? 'The wording says claims in the grace period are covered once the premium is paid.' : graceCover === 'not_covered' ? 'The wording says there is no cover during the grace period.' : 'Whether the grace period is covered is not established.'}`;
    } else { state = 'lapsed'; message = `The period ended on ${end}${grace != null ? ` and the ${grace}-day grace period has passed` : ''}.`; }
  }
  const reminders = [];
  if (end) {
    reminders.push({ id: 'renew', dueBy: end, text: `Renew on or before ${end}${grace != null ? ` (grace until ${addDays(end, grace)})` : ''}.`, parameterKeys: ['policy_end_date', 'grace_period_days'] });
    const portWindow = countOf(parameters, 'portability_window_days');
    if (portWindow != null) reminders.push({ id: 'port', dueBy: addDays(end, -portWindow), text: `To move to another insurer, apply at least ${portWindow} days before renewal (by ${addDays(end, -portWindow)}).`, parameterKeys: ['portability_window_days', 'policy_end_date'] });
    const withdrawal = countOf(parameters, 'product_withdrawal_notice_days');
    if (withdrawal != null) reminders.push({ id: 'withdrawal_notice', dueBy: null, text: `If the product is withdrawn the insurer must give ${withdrawal} days' notice and offer a migration option.`, parameterKeys: ['product_withdrawal_notice_days', 'migration_option'] });
  }
  const conversion = countOf(parameters, 'group_conversion_window_days');
  if (conversion != null) reminders.push({ id: 'group_conversion', dueBy: null, text: `On leaving the group, apply to convert to an individual policy within ${conversion} days.`, parameterKeys: ['group_conversion_window_days', 'group_to_individual_conversion'] });
  return {
    asOf,
    state,
    message,
    policyStartDate: start,
    policyEndDate: end,
    groups: Object.fromEntries(Object.entries(POLICY_STATUS_GROUPS).map(([group, keys]) => [group, keys.filter(key => parameters[key]).map(key => fieldView(parameters, key))])),
    reminders,
    boundary: 'Renewal, portability and conversion decisions rest with the insurer. These dates come from the policy record and should be confirmed with the insurer.',
  };
}
