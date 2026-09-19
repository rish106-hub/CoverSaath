export const AI_TASKS = Object.freeze([
  'profile_extraction',
  'group_cover_extraction',
  'personal_cover_extraction',
  'evidence_synthesis',
  'question_drafting',
]);

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

export const RUNTIME_AI_TASK_KEYS = Object.freeze(['profile', 'group', 'personal', 'primary']);

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
  deterministic: 'Code owns consent, authorization, graph construction, arithmetic, classification, review, state, external actions and release.',
});
