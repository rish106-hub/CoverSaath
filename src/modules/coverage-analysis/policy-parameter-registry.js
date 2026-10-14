export const POLICY_PARAMETER_REGISTRY_VERSION = 'policy-parameters/v1';

export const POLICY_PARAMETER_SECTIONS = Object.freeze(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']);
export const POLICY_PARAMETER_DATA_CLASSES = Object.freeze(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']);
export const POLICY_PARAMETER_VALUE_TYPES = Object.freeze([
  'boolean', 'date', 'date_range', 'duration', 'enum', 'identifier', 'list', 'metric',
  'money', 'number', 'object', 'percentage', 'recommendation', 'rule', 'string',
]);
export const POLICY_PARAMETER_SOURCE_CLASSES = Object.freeze([
  'claim_record', 'customer_information_sheet', 'endorsement', 'employer_record',
  'household_record', 'insurer_service_record', 'official_public_source',
  'policy_certificate', 'policy_schedule', 'policy_wording', 'proposal_form',
  'provider_record', 'renewal_notice', 'reviewer_record',
]);
export const POLICY_PARAMETER_APPLICABILITY_KINDS = Object.freeze([
  'always', 'when_policy_feature_exists', 'when_person_feature_applies',
  'when_event_feature_applies', 'when_external_research_requested',
  'when_household_portfolio_reviewed',
]);
export const POLICY_PARAMETER_AUTHORITY_OWNERS = Object.freeze([
  'deterministic_calculation', 'employer_or_group_administrator', 'household_records',
  'human_household_decision', 'insurer_contract', 'insurer_or_tpa',
  'official_public_authority',
]);

const POLICY_SOURCES = ['policy_wording', 'policy_schedule', 'policy_certificate', 'endorsement'];
const SERVICE_SOURCES = [...POLICY_SOURCES, 'insurer_service_record'];
const CLAIM_SOURCES = [...POLICY_SOURCES, 'claim_record', 'provider_record'];
const RENEWAL_SOURCES = [...POLICY_SOURCES, 'renewal_notice'];
const PUBLIC_SOURCES = ['official_public_source'];
const HOUSEHOLD_SOURCES = ['household_record', 'reviewer_record'];

const allowedResolutionStates = Object.freeze([
  'unknown', 'reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic',
  'conflicting', 'not_permitted',
]);

const sectionDefaults = Object.freeze({
  A: { sources: POLICY_SOURCES, applicability: 'always', authorityOwner: 'insurer_contract' },
  B: { sources: RENEWAL_SOURCES, applicability: 'always', authorityOwner: 'insurer_contract' },
  C: { sources: [...POLICY_SOURCES, 'employer_record'], applicability: 'when_person_feature_applies', authorityOwner: 'insurer_contract' },
  D: { sources: CLAIM_SOURCES, applicability: 'when_policy_feature_exists', authorityOwner: 'insurer_contract' },
  E: { sources: POLICY_SOURCES, applicability: 'when_policy_feature_exists', authorityOwner: 'insurer_contract' },
  F: { sources: [...POLICY_SOURCES, 'proposal_form'], applicability: 'when_event_feature_applies', authorityOwner: 'insurer_contract' },
  G: { sources: SERVICE_SOURCES, applicability: 'when_event_feature_applies', authorityOwner: 'insurer_or_tpa' },
  H: { sources: CLAIM_SOURCES, applicability: 'when_event_feature_applies', authorityOwner: 'insurer_or_tpa' },
  I: { sources: RENEWAL_SOURCES, applicability: 'when_policy_feature_exists', authorityOwner: 'insurer_contract' },
  J: { sources: PUBLIC_SOURCES, applicability: 'when_external_research_requested', authorityOwner: 'official_public_authority' },
  K: { sources: [...POLICY_SOURCES, ...HOUSEHOLD_SOURCES], applicability: 'when_household_portfolio_reviewed', authorityOwner: 'human_household_decision' },
});

const row = (key, label, valueType = 'rule', overrides = {}) => ({ key, label, valueType, ...overrides });

const catalogue = Object.freeze({
  A: [
    row('a.insurer_tpa_group_administrator', 'Insurer, TPA, group administrator', 'object'),
    row('a.contract_and_member_identifiers', 'Policy, certificate, member and e-card numbers', 'identifier', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('a.policy_type', 'Policy type', 'enum'),
    row('a.document_set', 'Document set', 'list'),
    row('a.customer_information_sheet', 'Customer Information Sheet (CIS)', 'object', { expectedSources: ['customer_information_sheet'] }),
    row('a.product_uin_and_version', 'Product UIN and version', 'identifier'),
    row('a.document_precedence', 'Document precedence'),
    row('a.add_ons_and_riders', 'Add-ons and riders', 'list'),
    row('a.intermediary_of_record', 'Intermediary of record', 'object'),
    row('a.source_quality_and_date', 'Source quality and date', 'object'),
  ],
  B: [
    row('b.policy_period', 'Policy period', 'date_range'),
    row('b.grace_period_and_lapse', 'Grace period and lapse'),
    row('b.continuity_credit', 'Continuity credit', 'duration'),
    row('b.moratorium_date', 'Moratorium date', 'date', { expectedSources: PUBLIC_SOURCES, authorityOwner: 'official_public_authority', modelExtraction: false }),
    row('b.free_look_period', 'Free-look period', 'duration', { expectedSources: [...POLICY_SOURCES, ...PUBLIC_SOURCES] }),
    row('b.renewal_version_diff', 'Renewal version diff', 'object'),
    row('b.lifelong_renewability', 'Lifelong renewability'),
    row('b.portability', 'Portability'),
    row('b.group_to_individual_conversion', 'Group-to-individual conversion'),
    row('b.product_withdrawal', 'Product withdrawal'),
    row('b.cancellation', 'Cancellation'),
  ],
  C: [
    row('c.named_insured_members', 'Named insured members', 'list', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('c.relationship_definitions', 'Relationship definitions'),
    row('c.member_effective_date', 'Member effective date', 'date', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('c.entry_age_and_maximum_renewal_age', 'Entry age and maximum renewal age', 'object'),
    row('c.age_out_rules', 'Age-out rules'),
    row('c.sum_insured_allocation', 'Sum-insured allocation', 'object'),
    row('c.floater_exhaustion_exposure', 'Floater exhaustion exposure', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('c.underwriting_outcome_per_member', 'Underwriting outcome per member', 'object', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('c.pre_policy_medical_check_up', 'Pre-policy medical check-up', 'boolean', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('c.proposal_form_declarations', 'Proposal-form declarations', 'object', { dataClass: 'RESTRICTED', expectedSources: ['proposal_form'], modelExtraction: false }),
    row('c.residency_and_occupation', 'Residency and occupation', 'object', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('c.newborn_adoption_marriage', 'Newborn, adoption, marriage'),
    row('c.nominee_and_payout_bank_account', 'Nominee and payout bank account', 'object', { dataClass: 'RESTRICTED', modelExtraction: false }),
  ],
  D: [
    row('d.sum_insured', 'Sum insured', 'money'),
    row('d.amount_already_used', 'Amount already used', 'money', { expectedSources: ['claim_record'], authorityOwner: 'insurer_or_tpa', modelExtraction: false }),
    row('d.corporate_buffer', 'Corporate buffer', 'money', { expectedSources: ['employer_record'], authorityOwner: 'employer_or_group_administrator', modelExtraction: false }),
    row('d.cumulative_no_claim_bonus', 'Cumulative / no-claim bonus', 'object'),
    row('d.guaranteed_loyalty_bonus', 'Guaranteed / loyalty bonus', 'percentage'),
    row('d.inflation_protection', 'Inflation protection', 'percentage'),
    row('d.restoration_recharge', 'Restoration / recharge'),
    row('d.top_up_super_top_up', 'Top-up / super top-up'),
    row('d.non_payable_items', 'Non-payable items', 'list'),
    row('d.room_rent_limit', 'Room rent limit'),
    row('d.proportionate_deduction', 'Proportionate deduction'),
    row('d.icu_charge_limit', 'ICU charge limit'),
    row('d.procedure_and_disease_sub_limits', 'Procedure and disease sub-limits', 'list'),
    row('d.surgery_bill_components', 'Surgery bill components', 'list'),
    row('d.reasonable_and_customary_charges', 'Reasonable and customary charges'),
    row('d.package_rates_ppn', 'Package rates / PPN'),
    row('d.ambulance_and_travel', 'Ambulance and travel'),
    row('d.attendant_companion_allowance', 'Attendant / companion allowance'),
    row('d.deductible', 'Deductible'),
    row('d.co_pay_general', 'Co-pay — general'),
    row('d.co_pay_age', 'Co-pay — age'),
    row('d.co_pay_zone', 'Co-pay — zone'),
    row('d.co_pay_non_network_hospital', 'Co-pay — non-network hospital'),
    row('d.co_pay_ped_or_named_disease', 'Co-pay — PED or named disease'),
    row('d.claim_order', 'Claim order'),
    row('d.contribution_clause', 'Contribution clause'),
    row('d.deductible_layering', 'Deductible layering'),
  ],
  E: [
    row('e.in_patient_hospitalisation', 'In-patient hospitalisation'),
    row('e.hospital_definition', 'Definition of hospital'),
    row('e.medical_necessity_active_treatment', 'Medical necessity / active treatment'),
    row('e.day_care_procedures', 'Day-care procedures', 'list'),
    row('e.pre_and_post_hospitalisation', 'Pre- and post-hospitalisation'),
    row('e.accident_versus_illness', 'Accident versus illness'),
    row('e.maternity_and_newborn', 'Maternity and newborn'),
    row('e.pre_existing_and_chronic_care', 'Pre-existing and chronic care'),
    row('e.modern_treatments', 'Modern treatments', 'list'),
    row('e.high_cost_care', 'High-cost care', 'list'),
    row('e.organ_donor', 'Organ donor'),
    row('e.bariatric_surgery', 'Bariatric surgery'),
    row('e.mental_health', 'Mental health'),
    row('e.rehabilitation_home_care_domiciliary', 'Rehabilitation, home care, domiciliary'),
    row('e.ayush', 'AYUSH'),
    row('e.dental_and_vision', 'Dental and vision'),
    row('e.opd_teleconsultation_diagnostics', 'OPD, teleconsultation, diagnostics'),
    row('e.health_check_up_and_wellness', 'Health check-up and wellness'),
    row('e.vaccination', 'Vaccination'),
    row('e.second_medical_opinion', 'Second medical opinion'),
    row('e.critical_illness_and_fixed_benefit', 'Critical illness and fixed benefit'),
    row('e.hospital_daily_cash', 'Hospital daily cash'),
    row('e.geography', 'Geography'),
  ],
  F: [
    row('f.initial_waiting_period', 'Initial waiting period', 'duration'),
    row('f.ped_waiting_period', 'PED waiting period', 'duration'),
    row('f.specified_disease_procedure_waits', 'Specified-disease / procedure waits', 'list'),
    row('f.maternity_waiting_period', 'Maternity waiting period', 'duration'),
    row('f.waits_on_sum_insured_increase', 'Waits on a sum-insured increase'),
    row('f.waiting_period_buy_down', 'Waiting-period buy-down', 'duration'),
    row('f.relapse_window', 'Relapse window', 'duration'),
    row('f.standard_exclusions_with_codes', 'Standard exclusions with codes', 'list'),
    row('f.permanent_exclusions', 'Permanent exclusions', 'list'),
    row('f.lifestyle_hazardous_self_harm_substance', 'Lifestyle, hazardous, self-harm, substance', 'list'),
    row('f.cosmetic_experimental_fertility_gender_affirming', 'Cosmetic, experimental, fertility, gender-affirming', 'list'),
    row('f.disclosure_at_renewal', 'Disclosure at renewal'),
    row('f.misrepresentation_and_fraud', 'Misrepresentation and fraud'),
  ],
  G: [
    row('g.network_status', 'Network status', 'object', { expectedSources: ['official_public_source', 'insurer_service_record'], authorityOwner: 'insurer_or_tpa', modelExtraction: false }),
    row('g.preferred_excluded_hospitals', 'Preferred / excluded hospitals', 'list', { expectedSources: ['official_public_source', 'insurer_service_record'], modelExtraction: false }),
    row('g.cashless_at_non_network_hospitals', 'Cashless at non-network hospitals'),
    row('g.pre_authorisation', 'Pre-authorisation'),
    row('g.authorisation_turnaround', 'Authorisation turnaround', 'duration', { expectedSources: [...SERVICE_SOURCES, ...PUBLIC_SOURCES] }),
    row('g.room_category_chosen', 'Room category chosen', 'string', { expectedSources: ['provider_record'], dataClass: 'CONFIDENTIAL' }),
    row('g.deposit_and_estimate', 'Deposit and estimate', 'object', { expectedSources: ['provider_record'], dataClass: 'CONFIDENTIAL' }),
    row('g.distance_to_suitable_network_hospital', 'Distance to suitable network hospital', 'number', { expectedSources: ['official_public_source', 'household_record'], authorityOwner: 'deterministic_calculation', modelExtraction: false }),
  ],
  H: [
    row('h.intimation_deadline', 'Intimation deadline', 'duration'),
    row('h.reimbursement_submission_deadline', 'Reimbursement submission deadline', 'duration'),
    row('h.documents_per_event_type', 'Documents per event type', 'list'),
    row('h.kyc_at_claim', 'KYC at claim', 'rule', { dataClass: 'RESTRICTED', modelExtraction: false }),
    row('h.who_collects_records', 'Who collects records', 'enum'),
    row('h.status_by_authority', 'Status by authority', 'object'),
    row('h.rejection_rules', 'Rejection rules'),
    row('h.settlement_turnaround_and_interest', 'Settlement turnaround and interest'),
    row('h.partial_settlement_breakdown', 'Partial settlement breakdown', 'object'),
    row('h.grievance_ladder_with_clocks', 'Grievance ladder with clocks', 'list'),
  ],
  I: [
    row('i.premium_now', 'Premium now', 'money', { dataClass: 'CONFIDENTIAL' }),
    row('i.next_age_band_crossing', 'Next age-band crossing', 'date'),
    row('i.premium_revision_rules', 'Premium revision rules'),
    row('i.payment_mode', 'Payment mode', 'enum'),
    row('i.tax', 'Tax', 'rule', { expectedSources: [...RENEWAL_SOURCES, ...PUBLIC_SOURCES], authorityOwner: 'official_public_authority', modelExtraction: false }),
  ],
  J: [
    row('j.claim_settlement_ratio_by_count_and_amount', 'Claim settlement ratio by count and by amount', 'metric'),
    row('j.incurred_claim_ratio', 'Incurred claim ratio', 'metric'),
    row('j.repudiation_ratio', 'Repudiation ratio', 'metric'),
    row('j.complaints_per_10000_claims', 'Complaints per 10,000 claims', 'metric'),
    row('j.average_settlement_turnaround', 'Average settlement turnaround', 'metric'),
    row('j.solvency_ratio', 'Solvency ratio', 'metric'),
    row('j.in_house_claims_or_tpa', 'In-house claims or TPA', 'enum'),
    row('j.network_density_in_household_city', 'Network density in the household city', 'metric'),
    row('j.public_complaint_patterns', 'Public complaint patterns', 'list'),
  ],
  K: [
    row('k.who_has_no_evidenced_cover', 'Who has no evidenced cover', 'list', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.adequacy', 'Adequacy', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.employer_dependence', 'Employer dependence', 'percentage', { expectedSources: ['employer_record', ...HOUSEHOLD_SOURCES], authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.floater_concentration', 'Floater concentration', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.layering_fit', 'Layering fit', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.premium_path', 'Premium path', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.inflation_erosion', 'Inflation erosion', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.next_cover_ending_event', 'Next cover-ending event', 'object', { authorityOwner: 'deterministic_calculation', modelExtraction: false }),
    row('k.recommendation', 'Recommendation', 'recommendation', { authorityOwner: 'human_household_decision', modelExtraction: false }),
  ],
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function buildEntry(section, definition) {
  const defaults = sectionDefaults[section];
  return {
    key: definition.key,
    section,
    label: definition.label,
    dataClass: definition.dataClass ?? (section === 'J' ? 'PUBLIC' : 'CONFIDENTIAL'),
    valueType: definition.valueType,
    expectedSources: [...(definition.expectedSources ?? defaults.sources)],
    applicability: { kind: definition.applicability ?? defaults.applicability },
    authorityOwner: definition.authorityOwner ?? defaults.authorityOwner,
    modelExtraction: {
      allowed: definition.modelExtraction ?? section !== 'J',
      maximumResolutionState: 'extracted_unverified',
    },
    permittedResolutionStates: [...allowedResolutionStates],
    calculationOwner: (definition.authorityOwner ?? defaults.authorityOwner) === 'deterministic_calculation'
      ? 'coverage_analysis_runtime'
      : null,
  };
}

export function validatePolicyParameterRegistry(registry) {
  if (!registry || typeof registry !== 'object') throw new TypeError('Policy parameter registry is required.');
  if (registry.version !== POLICY_PARAMETER_REGISTRY_VERSION) throw new TypeError(`Unknown policy parameter registry version: ${registry.version}.`);
  if (!Array.isArray(registry.parameters) || registry.parameters.length === 0) throw new TypeError('Policy parameter registry must contain parameters.');
  const keys = new Set();
  for (const entry of registry.parameters) {
    if (!entry || typeof entry !== 'object') throw new TypeError('Policy parameter entries must be objects.');
    if (!/^[a-k]\.[a-z0-9_]+$/.test(entry.key)) throw new TypeError(`Invalid policy parameter key: ${entry.key}.`);
    if (keys.has(entry.key)) throw new TypeError(`Duplicate policy parameter key: ${entry.key}.`);
    keys.add(entry.key);
    if (!POLICY_PARAMETER_SECTIONS.includes(entry.section) || entry.key[0].toUpperCase() !== entry.section) throw new TypeError(`Invalid section for policy parameter: ${entry.key}.`);
    if (typeof entry.label !== 'string' || !entry.label.trim()) throw new TypeError(`Policy parameter label is required: ${entry.key}.`);
    if (!POLICY_PARAMETER_DATA_CLASSES.includes(entry.dataClass)) throw new TypeError(`Invalid data class for policy parameter: ${entry.key}.`);
    if (!POLICY_PARAMETER_VALUE_TYPES.includes(entry.valueType)) throw new TypeError(`Invalid value type for policy parameter: ${entry.key}.`);
    if (!Array.isArray(entry.expectedSources) || entry.expectedSources.length === 0 || entry.expectedSources.some(source => !POLICY_PARAMETER_SOURCE_CLASSES.includes(source))) throw new TypeError(`Invalid expected sources for policy parameter: ${entry.key}.`);
    if (!entry.applicability || !POLICY_PARAMETER_APPLICABILITY_KINDS.includes(entry.applicability.kind)) throw new TypeError(`Invalid applicability for policy parameter: ${entry.key}.`);
    if (!POLICY_PARAMETER_AUTHORITY_OWNERS.includes(entry.authorityOwner)) throw new TypeError(`Invalid authority owner for policy parameter: ${entry.key}.`);
    if (!entry.modelExtraction || typeof entry.modelExtraction.allowed !== 'boolean' || entry.modelExtraction.maximumResolutionState !== 'extracted_unverified') throw new TypeError(`Invalid model extraction contract for policy parameter: ${entry.key}.`);
    if (!Array.isArray(entry.permittedResolutionStates) || entry.permittedResolutionStates.some(state => !allowedResolutionStates.includes(state))) throw new TypeError(`Invalid resolution states for policy parameter: ${entry.key}.`);
    if (entry.authorityOwner === 'deterministic_calculation' && entry.calculationOwner !== 'coverage_analysis_runtime') throw new TypeError(`Calculation owner is required for policy parameter: ${entry.key}.`);
  }
  return registry;
}

const registryV1 = {
  version: POLICY_PARAMETER_REGISTRY_VERSION,
  source: 'building/policy-parameters.md',
  parameters: Object.entries(catalogue).flatMap(([section, definitions]) => definitions.map(definition => buildEntry(section, definition))),
};

validatePolicyParameterRegistry(registryV1);
deepFreeze(registryV1);

const registries = new Map([[POLICY_PARAMETER_REGISTRY_VERSION, registryV1]]);

export const POLICY_PARAMETER_REGISTRY = registryV1;

export function getPolicyParameterRegistry(version) {
  const registry = registries.get(version);
  if (!registry) throw new TypeError(`Unknown policy parameter registry version: ${version}.`);
  return registry;
}

export function getPolicyParameterDefinition(version, parameterKey) {
  const registry = getPolicyParameterRegistry(version);
  const parameter = registry.parameters.find(candidate => candidate.key === parameterKey);
  if (!parameter) throw new TypeError(`Unknown policy parameter key: ${parameterKey}.`);
  return parameter;
}
