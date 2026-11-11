export const AI_TASKS = Object.freeze([
  'profile_extraction',
  'group_cover_extraction',
  'personal_cover_extraction',
  'evidence_synthesis',
  'question_drafting',
  'policy_structuring_extract',
  'policy_structuring_reconcile',
  'policy_evidence_investigate',
  'policy_evidence_override_sweep',
  'chat_answer',
  'intent_classify',
  'fact_extract',
  'embed',
]);

// Tasks that run through the provider-routing gateway (ADR 0030), behind CHAT_MODEL_ENABLED. Not workflow tasks.
export const GATEWAY_TASKS = Object.freeze(['chat_answer', 'intent_classify', 'fact_extract', 'embed']);

export const DETERMINISTIC_TASKS = Object.freeze([
  'consent_check',
  'source_authorization',
  'coverage_graph',
  'deterministic_classification',
  'policy_arithmetic',
  'evidence_review',
  'privacy_review',
  'safety_review',
  'state_transition',
  'external_action_authorization',
  'deterministic_release_gate',
]);

export const AI_CONTRACT_VERSION = 'knowvia-ai-contract-v1';

export const RUNTIME_RESPONSIBILITIES = Object.freeze({
  profile: Object.freeze({ owner: 'model_assist', modelTask: 'profile_extraction' }),
  group: Object.freeze({ owner: 'model_assist', modelTask: 'group_cover_extraction' }),
  personal: Object.freeze({ owner: 'model_assist', modelTask: 'personal_cover_extraction' }),
  coverage: Object.freeze({ owner: 'deterministic', modelTask: null }),
  documentIdentity: Object.freeze({ owner: 'deterministic', modelTask: null }),
  continuity: Object.freeze({ owner: 'deterministic', modelTask: null }),
  enrolment: Object.freeze({ owner: 'deterministic', modelTask: null }),
  financialRules: Object.freeze({ owner: 'deterministic', modelTask: null }),
  benefits: Object.freeze({ owner: 'deterministic', modelTask: null }),
  exclusions: Object.freeze({ owner: 'deterministic', modelTask: null }),
  hospitalAccess: Object.freeze({ owner: 'deterministic', modelTask: null }),
  claimsProcess: Object.freeze({ owner: 'deterministic', modelTask: null }),
  renewalChange: Object.freeze({ owner: 'deterministic', modelTask: null }),
  serviceResearch: Object.freeze({ owner: 'deterministic', modelTask: null }),
  decision: Object.freeze({ owner: 'deterministic', modelTask: null }),
  householdAction: Object.freeze({ owner: 'deterministic', modelTask: null }),
  evidence: Object.freeze({ owner: 'deterministic', modelTask: null }),
  privacy: Object.freeze({ owner: 'deterministic', modelTask: null }),
  safety: Object.freeze({ owner: 'deterministic', modelTask: null }),
  questions: Object.freeze({ owner: 'model_assist', modelTask: 'question_drafting' }),
  primary: Object.freeze({ owner: 'model_assist', modelTask: 'evidence_synthesis' }),
  release: Object.freeze({ owner: 'deterministic', modelTask: null }),
});

export const RUNTIME_AI_TASK_KEYS = Object.freeze(Object.entries(RUNTIME_RESPONSIBILITIES)
  .filter(([, responsibility]) => responsibility.owner === 'model_assist')
  .map(([key]) => key));

export function assertModelTask(task) {
  if (!AI_TASKS.includes(task)) {
    const error = new Error(`Task ${task} is not allowed to use a model.`);
    error.code = DETERMINISTIC_TASKS.includes(task) ? 'deterministic_task_protected' : 'unsupported_ai_task';
    throw error;
  }
  return task;
}

export const AI_RESPONSIBILITY_MATRIX = Object.freeze({
  profile_extraction: 'Extract only requested profile fields from authorised source excerpts.',
  group_cover_extraction: 'Extract group policy wording and preserve applicability as unknown unless the source states it.',
  personal_cover_extraction: 'Extract personal policy wording and preserve conflicts and missing facts.',
  evidence_synthesis: 'Summarise already extracted evidence without making a decision or changing a fact.',
  question_drafting: 'Draft questions for the named authority. Never send them.',
  policy_structuring_extract: 'Propose registry readings from privacy-gated policy chunks, each with a verbatim quote. Code validates and decides.',
  policy_structuring_reconcile: 'Flag disagreeing readings and propose which quoted reading applies. Code accepts only grounded selections of real contradictions.',
  policy_evidence_investigate: 'Find cited findings in privacy-gated policy clauses for one question. Code validates ids and quotes; the model decides nothing.',
  policy_evidence_override_sweep: 'Find clauses that limit, exclude, waive or override first-pass findings. Code validates ids and quotes.',
  chat_answer: 'Draft a short answer to the household question using only the supplied facts, citing fact ids. Code owns every number, eligibility and decision; unknown stays unknown.',
  intent_classify: 'Label the question with one allowed intent. The label is an unverified hint; code decides routing and never acts on it alone.',
  fact_extract: 'Propose values for the requested fact keys from the supplied text, each with a verbatim quote. Code validates the quote; the output is never confirmed.',
  embed: 'Embed already gated text for retrieval. The vector is derived data and is erased with the household.',
  deterministic: 'Code owns consent, authorization, graph construction, arithmetic, classification, review, state, external actions and release.',
});
