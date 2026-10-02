const criterion = (field, ...patterns) => Object.freeze({ field, patterns: Object.freeze([field, ...patterns]) });

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

function evidenceState(status) {
  const value = String(status ?? '').toLowerCase();
  if (/withheld|not.permitted/.test(value)) {
    throw new TypeError('Permission-restricted facts must not enter coverage decomposition. Access state is enforced before analysis.');
  }
  if (value.includes('conflict')) return 'Conflicting';
  if (/unknown|unresolved|unverified|missing/.test(value)) return 'Unknown';
  if (/institution|dynamic|dated/.test(value)) return 'Dynamic';
  if (/reported|user.stated|proxy|manual/.test(value)) return 'Reported';
  if (/calculated|derived/.test(value)) return 'Calculated';
  return 'Proven';
}

function normalizedField(value) {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
    : null;
}

function matchesCriterion(fact, definition) {
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
