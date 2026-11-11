// Holdings pipeline contract (complete.md section 3.2 as amended by section 9; ADR 0023 D3; ADR 0032). Shared by the backend, the
// worker, the BFF and its mock adapter. Identifiers and closed vocabularies only; no personal data.
//
// Job kinds run on the existing worker (src/server/worker.js, job_queue 034/037). Every job carries identifiers only:
//   household_id, document_id, consent_grant_id columns and payload { holdingId, inputSha? }.
// dedupe_key = sha256 hex of (holding_id, step, input_sha) (see holdingJobDedupeKey in src/backend/services/holding-pipeline.js).
//
//   holding.parse_own_pdf    own-PDF tier: runs the existing policy_facts.extract work for the holding's document
//   holding.fetch_reference  IDA tier: the reference import (job body owned by the IDA reference agent; a stub here)
//   holding.collate          ADR 0023 D3 resolver as a job: writes machine-tier memory rows and memory_conflicts
//   holding.memorise         STUB until Wave B: no embedding and no provider call; moves the status to conflicts or ready

export const HOLDING_JOB_KINDS = Object.freeze({
  parseOwnPdf: 'holding.parse_own_pdf',
  fetchReference: 'holding.fetch_reference',
  collate: 'holding.collate',
  memorise: 'holding.memorise',
});
export const HOLDING_JOB_KIND_LIST = Object.freeze(Object.values(HOLDING_JOB_KINDS));
export const HOLDING_JOB_STEPS = Object.freeze({
  [HOLDING_JOB_KINDS.parseOwnPdf]: 'parse_own_pdf',
  [HOLDING_JOB_KINDS.fetchReference]: 'fetch_reference',
  [HOLDING_JOB_KINDS.collate]: 'collate',
  [HOLDING_JOB_KINDS.memorise]: 'memorise',
});
export const HOLDING_JOB_MAX_ATTEMPTS = 3;

// policy_holdings.status (migration 048). A holding status, never a fact status: the step after the owner states the insurer and
// plan is product_reported (written to policy_profiles in state reported, ADR 0024), not "confirmed".
export const HOLDING_STATUSES = Object.freeze(['uploaded', 'insurer_pending', 'product_reported', 'parsed', 'conflicts', 'ready']);

// memory_conflicts vocabulary (migration 050).
export const CONFLICT_REASONS = Object.freeze(['own_vs_insurer', 'two_pages', 'model_disagree', 'own_vs_declaration']);
export const CONFLICT_RESOLUTIONS = Object.freeze(['pending', 'user_chose', 'insurer_wins', 'own_wins', 'dismissed']);

// Resolved slot statuses a read can return. No bare "confirmed" (AI.md, ADR 0003, ADR 0009).
export const RESOLVED_STATUSES = Object.freeze(['extracted_unverified', 'conflicting', 'unknown', 'reviewed_reference', 'user_confirmed']);

// Coded, client-safe errors of the holdings routes are registered in src/contracts/error-codes.js (HOLDING_*, MEMORY_CONFLICT_*).

// HOLDINGS_ENABLED (off unless exactly "true") lives in src/backend/services/holdings-flag.js.
