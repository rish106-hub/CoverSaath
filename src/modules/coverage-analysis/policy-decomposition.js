const criterion = (field, ...patterns) => Object.freeze({ field, patterns: Object.freeze([field, ...patterns]) });

// Canonical registry keys (policy-parameters/v1) placed under the criterion that owns them.
// Every key in sections A-J appears exactly once; section K keys are household synthesis
// inputs and are not decomposed. A test keeps this table complete against the registry.
export const CANONICAL_KEY_CRITERIA = Object.freeze({
  policy_identity: Object.freeze(['a.insurer_tpa_group_administrator', 'a.contract_and_member_identifiers', 'a.policy_type', 'a.intermediary_of_record']),
  policy_documents: Object.freeze(['a.document_set', 'a.customer_information_sheet', 'a.document_precedence', 'a.add_ons_and_riders']),
  document_version: Object.freeze(['a.product_uin_and_version', 'a.source_quality_and_date']),
  policy_period: Object.freeze(['b.policy_period', 'b.free_look_period']),
  renewal_and_grace: Object.freeze(['b.grace_period_and_lapse', 'b.renewal_version_diff', 'b.lifelong_renewability']),
  continuity_credit: Object.freeze(['b.continuity_credit', 'b.moratorium_date']),
  portability_and_migration: Object.freeze(['b.portability', 'b.group_to_individual_conversion']),
  life_event_cover_end: Object.freeze(['b.product_withdrawal', 'b.cancellation']),
  named_insured_members: Object.freeze(['c.named_insured_members', 'c.underwriting_outcome_per_member', 'c.pre_policy_medical_check_up', 'c.proposal_form_declarations', 'c.nominee_and_payout_bank_account']),
  relationship_and_eligibility: Object.freeze(['c.relationship_definitions', 'c.entry_age_and_maximum_renewal_age', 'c.age_out_rules', 'c.residency_and_occupation']),
  member_effective_dates: Object.freeze(['c.member_effective_date', 'c.newborn_adoption_marriage']),
  cover_allocation: Object.freeze(['c.sum_insured_allocation', 'c.floater_exhaustion_exposure']),
  sum_insured_and_balance: Object.freeze(['d.sum_insured', 'd.amount_already_used', 'd.corporate_buffer', 'd.inflation_protection']),
  deductible_basis: Object.freeze(['d.top_up_super_top_up', 'd.deductible', 'd.claim_order', 'd.contribution_clause', 'd.deductible_layering']),
  copay_basis: Object.freeze(['d.co_pay_general', 'd.co_pay_age', 'd.co_pay_zone', 'd.co_pay_non_network_hospital', 'd.co_pay_ped_or_named_disease']),
  room_and_icu_limits: Object.freeze(['d.room_rent_limit', 'd.proportionate_deduction', 'd.icu_charge_limit']),
  procedure_and_category_sublimits: Object.freeze(['d.procedure_and_disease_sub_limits', 'd.surgery_bill_components', 'd.package_rates_ppn']),
  restoration_rules: Object.freeze(['d.restoration_recharge']),
  no_claim_bonus_rules: Object.freeze(['d.cumulative_no_claim_bonus', 'd.guaranteed_loyalty_bonus']),
  non_medical_cost_rules: Object.freeze(['d.non_payable_items', 'd.reasonable_and_customary_charges', 'd.attendant_companion_allowance']),
  inpatient_and_daycare: Object.freeze(['e.in_patient_hospitalisation', 'e.hospital_definition', 'e.medical_necessity_active_treatment', 'e.day_care_procedures', 'e.accident_versus_illness', 'e.geography']),
  pre_and_post_hospitalisation: Object.freeze(['e.pre_and_post_hospitalisation']),
  outpatient_and_diagnostics: Object.freeze(['e.opd_teleconsultation_diagnostics', 'e.health_check_up_and_wellness', 'e.vaccination', 'e.second_medical_opinion']),
  ambulance_and_travel: Object.freeze(['d.ambulance_and_travel']),
  maternity_and_newborn: Object.freeze(['e.maternity_and_newborn']),
  organ_donor_and_high_cost_care: Object.freeze(['e.modern_treatments', 'e.high_cost_care', 'e.organ_donor', 'e.bariatric_surgery']),
  mental_rehabilitation_and_homecare: Object.freeze(['e.mental_health', 'e.rehabilitation_home_care_domiciliary']),
  ayush_dental_vision: Object.freeze(['e.ayush', 'e.dental_and_vision']),
  fixed_benefit_riders: Object.freeze(['e.critical_illness_and_fixed_benefit', 'e.hospital_daily_cash']),
  initial_waiting_period: Object.freeze(['f.initial_waiting_period']),
  ped_waiting_period: Object.freeze(['f.ped_waiting_period', 'e.pre_existing_and_chronic_care']),
  specified_condition_waits: Object.freeze(['f.specified_disease_procedure_waits', 'f.waits_on_sum_insured_increase', 'f.waiting_period_buy_down', 'f.relapse_window']),
  maternity_waiting_period: Object.freeze(['f.maternity_waiting_period']),
  permanent_and_event_exclusions: Object.freeze(['f.standard_exclusions_with_codes', 'f.permanent_exclusions', 'f.lifestyle_hazardous_self_harm_substance', 'f.cosmetic_experimental_fertility_gender_affirming']),
  disclosure_and_misrepresentation: Object.freeze(['f.disclosure_at_renewal', 'f.misrepresentation_and_fraud']),
  network_hospital_and_branch: Object.freeze(['g.preferred_excluded_hospitals', 'g.distance_to_suitable_network_hospital']),
  dated_cashless_status: Object.freeze(['g.network_status', 'g.cashless_at_non_network_hospitals']),
  admission_and_preauthorisation_flow: Object.freeze(['g.pre_authorisation', 'g.authorisation_turnaround']),
  estimate_and_deposit: Object.freeze(['g.room_category_chosen', 'g.deposit_and_estimate']),
  intimation_and_submission_deadlines: Object.freeze(['h.intimation_deadline', 'h.reimbursement_submission_deadline']),
  event_document_requirements: Object.freeze(['h.documents_per_event_type', 'h.kyc_at_claim', 'h.who_collects_records']),
  query_and_partial_settlement: Object.freeze(['h.status_by_authority', 'h.rejection_rules', 'h.settlement_turnaround_and_interest', 'h.partial_settlement_breakdown']),
  grievance_and_escalation: Object.freeze(['h.grievance_ladder_with_clocks']),
  premium_and_loading_change: Object.freeze(['i.premium_now', 'i.next_age_band_crossing', 'i.premium_revision_rules', 'i.payment_mode', 'i.tax']),
  official_service_routes: Object.freeze(['j.in_house_claims_or_tpa']),
  regulated_and_public_research: Object.freeze(['j.claim_settlement_ratio_by_count_and_amount', 'j.incurred_claim_ratio', 'j.repudiation_ratio', 'j.complaints_per_10000_claims', 'j.average_settlement_turnaround', 'j.solvency_ratio', 'j.network_density_in_household_city', 'j.public_complaint_patterns']),
});

export const POLICY_DECOMPOSITION = Object.freeze({
  documentIdentity: Object.freeze({ section: 'A', responsibility: 'Document identity and authority', criteria: Object.freeze([
    criterion('policy_identity', 'policy_number', 'certificate', 'insurer', 'tpa'),
    criterion('policy_documents', 'wording', 'schedule', 'endorsement', 'e_card'),
    criterion('document_version', 'document_version', 'issue_date', 'source_quality'),
  ]) }),
  continuity: Object.freeze({ section: 'B', responsibility: 'Policy lifecycle and continuity', criteria: Object.freeze([
    criterion('policy_period', 'effective_date', 'expiry_date', 'coverage_period'),
    criterion('renewal_and_grace', 'renewal', 'grace_period', 'lapse', 'revival'),
    criterion('continuity_credit', 'continuity', 'waiting_period_credit', 'moratorium'),
    criterion('portability_and_migration', 'portability', 'migration', 'porting_deadline'),
    criterion('life_event_cover_end', 'employer_exit', 'retirement', 'dependent_aging', 'status_change'),
  ]) }),
  enrolment: Object.freeze({ section: 'C', responsibility: 'People, eligibility and enrolment', criteria: Object.freeze([
    criterion('named_insured_members', 'covered_member', 'covered_members', 'insured_member', 'enrolment'),
    criterion('relationship_and_eligibility', 'relationship', 'dependent', 'eligibility', 'age_rule'),
    criterion('member_effective_dates', 'member_effective', 'addition_date', 'newborn', 'adoption', 'marriage'),
    criterion('cover_allocation', 'floater', 'family_pool', 'corporate_pool', 'individual_limit'),
  ]) }),
  financialRules: Object.freeze({ section: 'D', responsibility: 'Coverage structure and financial limits', criteria: Object.freeze([
    criterion('sum_insured_and_balance', 'sum_insured', 'benefit_limit', 'remaining_balance', 'aggregate_limit'),
    criterion('deductible_basis', 'deductible', 'threshold', 'topup', 'super_topup'),
    criterion('copay_basis', 'copay', 'co_pay', 'co-pay', 'cost_share'),
    criterion('room_and_icu_limits', 'room_rent', 'room_rent_limit', 'icu_limit', 'proportionate_deduction'),
    criterion('procedure_and_category_sublimits', 'sublimit', 'sub_limit', 'procedure_limit', 'procedure_sublimit', 'cataract', 'implant', 'modern_therapy'),
    criterion('restoration_rules', 'restoration', 'recharge', 'reinstatement'),
    criterion('no_claim_bonus_rules', 'no_claim_bonus', 'cumulative_bonus', 'ncb'),
    criterion('non_medical_cost_rules', 'consumable', 'administrative_charge', 'medical_device'),
  ]) }),
  benefits: Object.freeze({ section: 'E', responsibility: 'Medical benefits and treatment rules', criteria: Object.freeze([
    criterion('inpatient_and_daycare', 'hospitalisation', 'hospitalisation_benefit', 'inpatient', 'daycare', 'day_care'),
    criterion('pre_and_post_hospitalisation', 'pre_hospitalisation', 'post_hospitalisation'),
    criterion('outpatient_and_diagnostics', 'opd', 'outpatient', 'diagnostic'),
    criterion('ambulance_and_travel', 'ambulance', 'air_ambulance', 'travel', 'evacuation'),
    criterion('maternity_and_newborn', 'maternity', 'delivery', 'c_section', 'newborn'),
    criterion('organ_donor_and_high_cost_care', 'organ_donor', 'transplant', 'dialysis', 'cancer', 'cardiac'),
    criterion('mental_rehabilitation_and_homecare', 'mental_health', 'rehabilitation', 'home_care', 'domiciliary'),
    criterion('ayush_dental_vision', 'ayush', 'dental', 'vision'),
    criterion('fixed_benefit_riders', 'critical_illness', 'survival_period', 'fixed_benefit'),
  ]) }),
  exclusions: Object.freeze({ section: 'F', responsibility: 'Exclusions, waiting periods and disclosures', criteria: Object.freeze([
    criterion('initial_waiting_period', 'initial_wait', 'initial_waiting'),
    criterion('ped_waiting_period', 'ped', 'pre_existing', 'preexisting'),
    criterion('specified_condition_waits', 'specified_disease', 'procedure_wait', 'condition_wait'),
    criterion('maternity_waiting_period', 'maternity_wait'),
    criterion('permanent_and_event_exclusions', 'permanent_exclusion', 'exclusion', 'cosmetic', 'experimental', 'fertility'),
    criterion('disclosure_and_misrepresentation', 'disclosure', 'non_disclosure', 'misrepresentation', 'fraud'),
  ]) }),
  hospitalAccess: Object.freeze({ section: 'G', responsibility: 'Hospital access and cashless process', criteria: Object.freeze([
    criterion('network_hospital_and_branch', 'network', 'network_requirement', 'hospital', 'branch'),
    criterion('dated_cashless_status', 'cashless', 'network_status', 'dated_network', 'dated_network_status'),
    criterion('hospital_desk_and_tpa_route', 'hospital_desk', 'tpa_route', 'insurer_route'),
    criterion('admission_and_preauthorisation_flow', 'preauthor', 'pre_author', 'preauthorisation_status', 'planned_admission', 'emergency_admission'),
    criterion('estimate_and_deposit', 'estimate', 'deposit', 'cost_breakdown'),
  ]) }),
  claimsProcess: Object.freeze({ section: 'H', responsibility: 'Claim, pre-authorisation and reimbursement process', criteria: Object.freeze([
    criterion('intimation_and_submission_deadlines', 'intimation', 'submission_deadline', 'reimbursement'),
    criterion('event_document_requirements', 'claim_document', 'discharge_summary', 'invoice', 'mlc', 'fir'),
    criterion('query_and_partial_settlement', 'query', 'partial_settlement', 'denial_reason'),
    criterion('grievance_and_escalation', 'grievance', 'ombudsman', 'escalation'),
  ]) }),
  renewalChange: Object.freeze({ section: 'I', responsibility: 'Renewal, portability and change control', criteria: Object.freeze([
    criterion('policy_version_diff', 'policy_version', 'clause_change', 'renewal'),
    criterion('premium_and_loading_change', 'premium', 'loading', 'age_band'),
    criterion('member_and_eligibility_change', 'member_change', 'aged_out', 'employer_cover_loss'),
    criterion('continuity_effect_of_change', 'waiting_period_credit', 'continuity', 'portability'),
  ]) }),
  serviceResearch: Object.freeze({ section: 'J', responsibility: 'Service quality and external research', criteria: Object.freeze([
    criterion('official_service_routes', 'service', 'complaint', 'grievance'),
    criterion('regulated_and_public_research', 'research', 'settlement_ratio', 'regulatory_disclosure'),
  ]) }),
  householdAction: Object.freeze({ section: 'K', responsibility: 'Household recommendation and action plan', patterns: [] }),
});

const clone = value => structuredClone(value);
const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function sourceReference(source = null) {
  return {
    sourceId: source?.id ?? source?.sourceId ?? null,
    document: source?.document ?? source?.id ?? source?.sourceId ?? null,
    version: source?.version ?? null,
    page: source?.page ?? source?.location ?? null,
    clause: source?.clause ?? null,
    confidence: Number.isFinite(source?.confidence) ? source.confidence : null,
    effectiveDate: source?.effectiveDate ?? null,
    humanCorrected: source?.humanCorrected === true,
  };
}

// Explicit positive markers only. Deterministic code sets these on evidence it
// admitted from a source document; everything unrecognised (including the
// 'model_extracted_unverified' marker for model output) fails closed to Unknown.
const PROVEN_STATUS = /^(?:document[-_ ]?backed|proven|human[-_ ]?reviewed|verified)$/;

function evidenceState(status) {
  const value = String(status ?? '').trim().toLowerCase();
  if (/withheld|not.permitted/.test(value)) {
    throw new TypeError('Permission-restricted facts must not enter coverage decomposition. Access state is enforced before analysis.');
  }
  if (value.includes('conflict')) return 'Conflicting';
  if (/unknown|unresolved|unverified|missing/.test(value)) return 'Unknown';
  if (/institution|dynamic|dated/.test(value)) return 'Dynamic';
  if (/reported|user.stated|proxy|manual/.test(value)) return 'Reported';
  if (/calculated|derived/.test(value)) return 'Calculated';
  if (PROVEN_STATUS.test(value)) return 'Proven';
  return 'Unknown';
}

function normalizedField(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : null;
}

function matchesCriterion(fact, definition) {
  const canonicalKeys = CANONICAL_KEY_CRITERIA[definition.field] ?? [];
  if ([fact.field, fact.fact].some(field => canonicalKeys.includes(field))) return true;
  const fields = new Set([fact.field, fact.fact]
    .map(normalizedField)
    .filter(Boolean));
  return definition.patterns.some(pattern => fields.has(normalizedField(pattern)));
}

function normalizeFact(section, fact, index) {
  const source = fact.sources?.[0] ?? fact.source ?? null;
  return {
    id: `${section.toLowerCase()}:${fact.id ?? index + 1}`,
    field: fact.field ?? fact.fact ?? fact.type ?? 'unclassified',
    value: hasOwn(fact, 'value') ? clone(fact.value) : null,
    evidenceState: evidenceState(fact.status),
    provenance: sourceReference(source),
  };
}

export function decomposePolicySection(key, coverage) {
  const definition = POLICY_DECOMPOSITION[key];
  if (!definition || key === 'householdAction') throw new TypeError(`Unsupported policy decomposition worker: ${key}.`);
  const facts = definition.criteria.flatMap((criterionDefinition, criterionIndex) => {
    const matched = coverage.facts.filter(fact => matchesCriterion(fact, criterionDefinition));
    if (matched.length > 0) return matched.map((fact, index) => normalizeFact(definition.section, fact, `${criterionIndex + 1}-${index + 1}`));
    return [{
      id: `${definition.section.toLowerCase()}:gap-${criterionIndex + 1}`,
      field: criterionDefinition.field,
      value: null,
      evidenceState: 'Unknown',
      provenance: sourceReference(),
    }];
  });
  return {
    section: definition.section,
    responsibility: definition.responsibility,
    facts,
    boundaries: ['This worker structures evidence only. It does not decide payment, approval, treatment or purchase.'],
  };
}

export function buildHouseholdAction({ decision, sections }) {
  const unresolved = sections.flatMap(section => section.facts
    .filter(fact => ['Unknown', 'Conflicting', 'Dynamic'].includes(fact.evidenceState))
    .map(fact => `${section.section}.${fact.field}`));
  return {
    section: POLICY_DECOMPOSITION.householdAction.section,
    responsibility: POLICY_DECOMPOSITION.householdAction.responsibility,
    facts: [{
      id: 'k:bounded-action-route',
      field: 'candidate_route',
      value: { route: decision.route, humanApprovalRequired: true },
      evidenceState: 'Calculated',
      provenance: sourceReference(),
    }],
    recommendation: {
      authority: 'human_household_decision_required',
      route: decision.route,
      unresolved,
      externalActionsAuthorized: false,
    },
    boundaries: ['No purchase, renewal, port, payment or claim action is authorised by this output.'],
  };
}
