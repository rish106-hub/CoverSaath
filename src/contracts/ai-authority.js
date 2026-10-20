// AI authority matrix: one frozen table of what a model may and may not decide in the
// coverage-analysis workflow. It is a literal on purpose: tests/p1a-ai-authority.test.mjs
// proves it agrees with src/features/ai-analysis/responsibility-matrix.js (task ownership),
// src/features/coverage-analysis/parameter-records.js (OBSERVATION_RESOLUTION_RULES and the
// model resolution guards) and src/features/coverage-analysis/agent-contracts.js (envelope
// evidence states). If any of those change, this table and the test must change together.
//
// Principle: a model may propose. Deterministic code (or a human reviewer through
// deterministic code) authorises, calculates, transitions state and releases.
//
// ADR: docs/adr/0003-ai-authority.md

export const AI_AUTHORITY_MATRIX_VERSION = 'knowvia-ai-authority-v1';

const freezeAll = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeAll(child);
    Object.freeze(value);
  }
  return value;
};

export const AI_AUTHORITY_MATRIX = freezeAll({
  version: AI_AUTHORITY_MATRIX_VERSION,

  // Decisions no model may make. Keys are the protected task names in
  // responsibility-matrix.js DETERMINISTIC_TASKS.
  protectedDecisions: {
    consent_check: { category: 'authorization', authority: 'deterministic' },
    source_authorization: { category: 'authorization', authority: 'deterministic' },
    external_action_authorization: { category: 'authorization', authority: 'deterministic' },
    policy_arithmetic: { category: 'arithmetic', authority: 'deterministic' },
    state_transition: { category: 'state_transition', authority: 'deterministic' },
    deterministic_release_gate: { category: 'release', authority: 'deterministic' },
    coverage_graph: { category: 'graph_construction', authority: 'deterministic' },
    deterministic_classification: { category: 'classification', authority: 'deterministic' },
    evidence_review: { category: 'review', authority: 'deterministic' },
    privacy_review: { category: 'review', authority: 'deterministic' },
    safety_review: { category: 'review', authority: 'deterministic' },
  },

  // The only tasks a model may run (responsibility-matrix.js AI_TASKS). All are advisory:
  // their output is a proposal that deterministic code validates.
  modelTasks: {
    profile_extraction: { authority: 'propose', workflowTaskKeys: ['profile'], recordsParameterObservations: true },
    group_cover_extraction: { authority: 'propose', workflowTaskKeys: ['group'], recordsParameterObservations: true },
    personal_cover_extraction: { authority: 'propose', workflowTaskKeys: ['personal'], recordsParameterObservations: true },
    evidence_synthesis: { authority: 'propose', workflowTaskKeys: ['primary'], recordsParameterObservations: false },
    question_drafting: { authority: 'propose', workflowTaskKeys: ['questions'], recordsParameterObservations: false },
    // Document pipeline tasks (ADR 0006): not workflow tasks. Their readings are stored by
    // PolicyStructuringRepository.commitStructuring, never above extracted_unverified or conflicting.
    policy_structuring_extract: { authority: 'propose', workflowTaskKeys: [], pipeline: 'policy-structuring', recordsParameterObservations: true },
    policy_structuring_reconcile: { authority: 'propose', workflowTaskKeys: [], pipeline: 'policy-structuring', recordsParameterObservations: false },
  },

  // Owner of every coverage-analysis workflow task (responsibility-matrix.js RUNTIME_RESPONSIBILITIES).
  workflowTasks: {
    profile: { owner: 'model_assist', modelTask: 'profile_extraction' },
    group: { owner: 'model_assist', modelTask: 'group_cover_extraction' },
    personal: { owner: 'model_assist', modelTask: 'personal_cover_extraction' },
    coverage: { owner: 'deterministic', modelTask: null },
    documentIdentity: { owner: 'deterministic', modelTask: null },
    continuity: { owner: 'deterministic', modelTask: null },
    enrolment: { owner: 'deterministic', modelTask: null },
    financialRules: { owner: 'deterministic', modelTask: null },
    benefits: { owner: 'deterministic', modelTask: null },
    exclusions: { owner: 'deterministic', modelTask: null },
    hospitalAccess: { owner: 'deterministic', modelTask: null },
    claimsProcess: { owner: 'deterministic', modelTask: null },
    renewalChange: { owner: 'deterministic', modelTask: null },
    serviceResearch: { owner: 'deterministic', modelTask: null },
    decision: { owner: 'deterministic', modelTask: null },
    householdAction: { owner: 'deterministic', modelTask: null },
    evidence: { owner: 'deterministic', modelTask: null },
    privacy: { owner: 'deterministic', modelTask: null },
    safety: { owner: 'deterministic', modelTask: null },
    questions: { owner: 'model_assist', modelTask: 'question_drafting' },
    primary: { owner: 'model_assist', modelTask: 'evidence_synthesis' },
    release: { owner: 'deterministic', modelTask: null },
  },

  // What model output can become.
  modelOutput: {
    // Task result envelope evidence states (agent-contracts.js EVIDENCE_STATES).
    envelopeEvidenceStates: ['Unknown', 'Conflicting'],
    forbiddenEnvelopeEvidenceStates: ['Proven', 'Calculated', 'Reported', 'Dynamic'],
    // Parameter resolution states reachable under model authority (parameter-records.js).
    parameterResolutionStates: ['unknown', 'extracted_unverified', 'conflicting'],
    forbiddenParameterResolutionStates: ['reported', 'proven', 'calculated', 'dynamic', 'not_permitted'],
    // Established resolutions a model may never replace.
    protectedResolutionStates: ['proven', 'calculated', 'dynamic', 'not_permitted'],
    // The only observation rule with model authority.
    observationRules: [
      { extractionMethod: 'document_extraction', state: 'extracted_unverified', requiresAccepted: false },
    ],
    // A model never sets a release status; 'released' comes only from the deterministic release gate.
    releaseStatuses: [],
    externalActionsAuthorized: false,
  },

  // Who can establish each value-carrying resolution state (parameter-records.js
  // OBSERVATION_RESOLUTION_RULES). `accepted` = needs an accepted review of the observation.
  resolutionAuthorities: {
    reported: [
      { extractionMethod: 'human_report', authority: 'deterministic', requiresAccepted: false },
      { extractionMethod: 'human_review', authority: 'human_reviewer', requiresAccepted: false },
    ],
    extracted_unverified: [
      { extractionMethod: 'document_extraction', authority: 'model', requiresAccepted: false },
    ],
    proven: [
      { extractionMethod: 'human_review', authority: 'human_reviewer', requiresAccepted: true },
      { extractionMethod: 'official_source_lookup', authority: 'official_source', requiresAccepted: true },
    ],
    calculated: [
      { extractionMethod: 'deterministic_calculation', authority: 'deterministic', requiresAccepted: false },
    ],
    dynamic: [
      { extractionMethod: 'official_source_lookup', authority: 'official_source', requiresAccepted: false },
      { extractionMethod: 'deterministic_calculation', authority: 'deterministic', requiresAccepted: false },
    ],
  },
});

export function modelMayProduceEvidenceState(state) {
  return AI_AUTHORITY_MATRIX.modelOutput.envelopeEvidenceStates.includes(state);
}

export function modelMayProduceResolutionState(state) {
  return AI_AUTHORITY_MATRIX.modelOutput.parameterResolutionStates.includes(state);
}
