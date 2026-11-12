// Holdings pipeline contract (complete.md section 3.2 as amended by section 9; ADR 0023 D3; ADR 0032). Shared by the backend, the
// worker, the BFF and its mock adapter. Identifiers and closed vocabularies only; no personal data.
//
// Job kinds run on the existing worker (src/server/worker.js, job_queue 034/037). Every job carries identifiers only:
//   household_id, document_id, consent_grant_id columns and payload { holdingId, inputSha? }.
// dedupe_key = sha256 hex of (holding_id, step, input_sha) (see holdingJobDedupeKey in src/backend/services/holding-pipeline.js).
//
//   holding.parse_own_pdf    own-PDF tier: runs the existing policy_facts.extract work for the holding's document
//   holding.fetch_reference  IDA tier: only queues collate, never waits for reference data (the import is the reference.import job)
//   holding.collate          ADR 0023 D3 resolver as a job: writes machine-tier memory rows and memory_conflicts
//   holding.memorise         settles the status (conflicts or ready), then embeds confirmed facts and own-PDF clauses through the memory service (needs MEMORY_ENABLED and the voyage grant; never blocks the status)

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
// Retry of holding creation after OCR: when creating the holding (or queuing its insurer detection) throws after the OCR pages are stored,
// a `holding.create` job re-runs it (identifiers only, dedupe per document, HOLDING_JOB_MAX_ATTEMPTS attempts). After the last attempt the job
// is dead with this code, and GET /households/{id}/holdings lists the document under `creation_issues` with state 'failed'.
export const HOLDING_CREATE_JOB_KIND = 'holding.create';
export const HOLDING_CREATE_FAILED = 'HOLDING_CREATE_FAILED';
export const HOLDING_CREATION_STATES = Object.freeze(['retrying', 'failed']);

// policy_holdings.status (migration 048). A holding status, never a fact status: the step after the owner states the insurer and
// plan is product_reported (written to policy_profiles in state reported, ADR 0024), not "confirmed".
export const HOLDING_STATUSES = Object.freeze(['uploaded', 'insurer_pending', 'product_reported', 'parsed', 'conflicts', 'ready']);

// memory_conflicts vocabulary (migration 050).
export const CONFLICT_REASONS = Object.freeze(['own_vs_insurer', 'two_pages', 'model_disagree', 'own_vs_declaration']);
export const CONFLICT_RESOLUTIONS = Object.freeze(['pending', 'user_chose', 'insurer_wins', 'own_wins', 'dismissed']);

// Resolved slot statuses a read can return. No bare "confirmed" (AI.md, ADR 0003, ADR 0009).
export const RESOLVED_STATUSES = Object.freeze(['extracted_unverified', 'conflicting', 'unknown', 'reviewed_reference', 'user_confirmed']);

// `summary` of a holding in GET /api/v1/households/{id}/holdings and /holdings/{holdingId} (deterministic, stored data only):
//   { insurerName: string | null, productName: string | null, sumInsured: Headline | null, policyPeriod: Headline | null, premium: Headline | null }
//   Headline = { factKey, value, status }, status from RESOLVED_STATUSES. Names are null until the owner confirmed the product (policy_profiles
//   state 'reported'); never a candidate, never the UIN. Field -> existing fact key of src/contracts/policy-facts.js:
export const HOLDING_SUMMARY_HEADLINES = Object.freeze({ sumInsured: 'sum_insured', policyPeriod: 'policy_period', premium: 'premium_total' });
// GET /api/v1/holdings/{id}/facts: each source `page` is { pageId, blockIndex, documentKind } where documentKind is the document_kind of the
// page's document (policy_schedule, policy_wording, ...), or null.

// Coded, client-safe errors of the holdings routes are registered in src/contracts/error-codes.js (HOLDING_*, MEMORY_CONFLICT_*).

// HOLDINGS_ENABLED (off unless exactly "true") lives in src/backend/services/holdings-flag.js.
