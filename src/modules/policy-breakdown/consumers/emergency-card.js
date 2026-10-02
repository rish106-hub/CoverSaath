import { ageOn, fieldView, listOf, normalisePersonName, percentOf, countOf, resolveForMember } from './record-values.js';
import { buildPolicyStatus } from './policy-status.js';

// Read-only emergency card for a human operator and the family. Built from the stored record only.
// It is never gated on readiness: an unconfirmed card is shown with its states rather than withheld,
// because care must not wait for paperwork. Protected fields are never included.

export const EMERGENCY_INSTRUCTION = Object.freeze({
  first: 'Get treatment first. Do not delay admission for insurance steps.',
  route: 'Call a person directly. No AI or voice agent sits in front of this call.',
  scope: 'This card supports insurance coordination only. It is not medical advice and not a claim decision.',
});

export const CARD_FIELDS = Object.freeze({
  policy: ['insurer_name', 'product_name', 'policy_type', 'policy_number', 'insured_members', 'certificate_number', 'member_id_numbers', 'tpa_name', 'tpa_helpline', 'tpa_cashless_email', 'insurer_helpline', 'policy_start_date', 'policy_end_date', 'geographic_scope'],
  cover: ['sum_insured_amount', 'sum_insured_structure', 'floater_shared_exhaustion', 'room_rent_limit_kind', 'room_rent_eligible_category', 'room_rent_limit_percent', 'room_rent_limit_amount', 'icu_limit_kind', 'icu_limit_amount', 'icu_limit_percent', 'proportionate_deduction_applies', 'copay_general_percent', 'copay_age_percent', 'copay_age_threshold_years', 'copay_zone_percent', 'copay_non_network_percent', 'deductible_amount', 'topup_deductible_amount', 'road_ambulance_limit', 'air_ambulance_limit', 'hospital_definition', 'inpatient_minimum_hours', 'daycare_covered', 'accident_cover_rule'],
  cashlessProcess: ['cashless_network_available', 'cashless_non_network_available', 'non_network_cashless_notice_hours', 'emergency_intimation_hours', 'planned_preauth_notice_hours', 'cashless_process', 'preauth_documents', 'preauth_form_and_channel', 'deposit_and_estimate_rule', 'enhancement_request_rule', 'cashless_denial_rule', 'excluded_hospitals_rule', 'excluded_hospitals_list_reference', 'network_list_reference', 'network_hospital_locator'],
  ifPaidFirst: ['reimbursement_intimation_emergency_hours', 'reimbursement_submission_days', 'reimbursement_documents', 'accident_claim_documents', 'claim_kyc_requirement', 'records_collection_rule', 'delay_condonation_rule'],
  household: ['members_without_evidenced_cover', 'members_attracting_age_copay', 'next_cover_change_date', 'next_cover_change_reason'],
  waiting: ['first_inception_date', 'initial_waiting_period_days', 'accident_exempt_from_initial_wait', 'ped_waiting_period_months', 'specified_disease_waiting_months', 'specified_disease_list'],
});
const { policy: POLICY_FIELDS, cover: COVER_FIELDS, cashlessProcess: PROCESS_FIELDS, ifPaidFirst: CLAIM_FIELDS, waiting: WAITING_FIELDS } = CARD_FIELDS;

const nameKey = normalisePersonName;

function present(parameters, keys) {
  return keys.filter(key => parameters[key] && parameters[key].visibility !== 'protected').map(key => fieldView(parameters, key));
}

export function buildEmergencyCard({ record, parameters, members = [], asOf }) {
  const insured = listOf(parameters, 'insured_members') ?? [];
  const insuredNames = new Set(insured.map(nameKey));
  const ageThreshold = countOf(parameters, 'copay_age_threshold_years');
  const ageCopay = percentOf(parameters, 'copay_age_percent');
  const memberCards = members.map(member => {
    const named = insuredNames.has(nameKey(member.displayName));
    const age = ageOn(member.dateOfBirth, asOf);
    const resolved = resolveForMember(parameters, member);
    const memberSpecific = Object.keys(parameters)
      .filter(key => parameters[key].visibility !== 'protected' && resolved[key] !== parameters[key])
      .map(key => fieldView(resolved, key));
    return {
      memberSpecific,
      memberId: member.id,
      displayName: member.displayName,
      relationship: member.relationship ?? null,
      namedOnPolicy: insured.length ? named : null,
      namedOnPolicyState: insured.length ? 'Calculated' : 'Unknown',
      ageCopayLikely: age == null || ageThreshold == null || ageCopay == null ? null : age >= ageThreshold,
      ageCopayPercent: age != null && ageThreshold != null && age >= ageThreshold ? ageCopay : null,
      note: named ? null : insured.length ? 'Not named in the insured members list of this record. Confirm with the insurer or TPA.' : 'Insured members are not established in this record.',
    };
  });
  const allFields = Object.values(CARD_FIELDS).flat();
  const status = buildPolicyStatus({ parameters, asOf });
  const unknowns = allFields.filter(key => parameters[key] && !['Proven', 'Calculated', 'Reported', 'Dynamic'].includes(parameters[key].evidenceState)).map(key => ({ key, label: parameters[key].label, evidenceState: parameters[key].evidenceState }));
  const protectedWithheld = Object.values(parameters).filter(result => result.visibility === 'protected').length;
  return {
    recordId: record.id,
    recordStatus: record.status,
    confirmedByPerson: record.status === 'ready',
    banner: record.status === 'ready' ? null : 'This card is built from an unconfirmed breakdown. Every value shows its evidence state.',
    instruction: EMERGENCY_INSTRUCTION,
    asOf,
    policyStatus: { state: status.state, message: status.message },
    policy: present(parameters, POLICY_FIELDS),
    cover: present(parameters, COVER_FIELDS),
    cashlessProcess: present(parameters, PROCESS_FIELDS),
    ifPaidFirst: present(parameters, CLAIM_FIELDS),
    waiting: present(parameters, WAITING_FIELDS),
    household: present(parameters, CARD_FIELDS.household),
    members: memberCards,
    unknowns,
    protectedFieldsWithheld: protectedWithheld,
    networkNote: 'Network status of a specific hospital branch is Dynamic. Confirm it with the hospital insurance desk or TPA on the day.',
  };
}
