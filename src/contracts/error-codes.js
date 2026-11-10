// Stable error codes of the analysis-run surface: the v1 backend routes, the persistent
// coverage-analysis service and port, the workflow repository and the task contracts.
// A code is a stable identifier; messages may change. tests/p1a-error-codes.test.mjs fails
// when one of the covered source files throws or stores a code that is not listed here.
//
// Out of scope (separate families with their own owners): live model runtime and gateway
// codes (LIVE_AI_*, lowercase gateway codes), integration provider codes, privacy gate
// reason codes, and task-output blocker/finding codes. A live-runtime code that reaches
// failTask is stored verbatim as last_error_code.
//
// httpStatus: status returned by the v1 route error mapper, or null when the code is only
// stored on a task/run (last_error_code / terminal_reason) and never returned as an HTTP error.
// retryable: whether repeating the same request later can succeed without a change.
//
// ADR: docs/adr/0001-workflow-v6-contracts.md

const entry = (httpStatus, category, retryable) => Object.freeze({ httpStatus, category, retryable });

export const ANALYSIS_ERROR_CODES = Object.freeze({
  // Request validation (v1 routes).
  INVALID_REQUEST: entry(400, 'request', false),
  POLICY_TYPE_INVALID: entry(400, 'request', false),
  IDEMPOTENCY_KEY_REQUIRED: entry(400, 'request', false),
  INVALID_EXECUTION_MODE: entry(400, 'request', false),
  BACKEND_REQUEST_FAILED: entry(400, 'request', false),
  ROUTE_NOT_FOUND: entry(404, 'request', false),
  // Authentication, tenancy and consent.
  AUTHENTICATION_REQUIRED: entry(401, 'authorization', false),
  CONSENT_REQUIRED: entry(403, 'authorization', false),
  CONSENT_SCOPE_REQUIRED: entry(403, 'authorization', false),
  CONSENT_SUBJECT_REQUIRED: entry(403, 'authorization', false),
  FIELD_ACCESS_REQUIRED: entry(403, 'authorization', false),
  MODEL_PERMISSION_REQUIRED: entry(403, 'authorization', false),
  CASE_NOT_FOUND: entry(404, 'not_found', false),
  HOUSEHOLD_NOT_FOUND: entry(404, 'not_found', false),
  CONSENT_NOT_FOUND: entry(404, 'not_found', false),
  NOTICE_NOT_FOUND: entry(404, 'not_found', false),
  MEMBER_NOT_FOUND: entry(404, 'not_found', false),
  POLICY_NOT_FOUND: entry(404, 'not_found', false),
  HOUSEHOLD_WRITE_FORBIDDEN: entry(403, 'authorization', false),
  JOB_NOT_FOUND: entry(404, 'not_found', false),
  TASK_NOT_FOUND: entry(404, 'not_found', false),
  // State conflicts.
  IDEMPOTENCY_CONFLICT: entry(409, 'conflict', false),
  CASE_NOT_READY_FOR_ANALYSIS: entry(409, 'conflict', false),
  STALE_REVISION: entry(409, 'conflict', false),
  MEMBER_PROTECTED: entry(409, 'conflict', false),
  MEMBER_HAS_RECORDS: entry(409, 'conflict', false),
  MEMBER_CAPACITY_REACHED: entry(429, 'capacity', false),
  INVALID_CASE_TRANSITION: entry(409, 'conflict', false),
  INVALID_PARAMETER_STATES: entry(409, 'conflict', false),
  PARAMETER_SUBJECT_UNRESOLVED: entry(409, 'conflict', false),
  SOURCE_PACK_REQUIRED: entry(409, 'conflict', false),
  // Capacity.
  ANALYSIS_CAPACITY_REACHED: entry(429, 'capacity', true),
  CASE_CAPACITY_REACHED: entry(429, 'capacity', true),
  // Configuration (fail closed).
  AUTH_NOT_CONFIGURED: entry(503, 'configuration', false),
  LIVE_ANALYSIS_NOT_CONFIGURED: entry(503, 'configuration', false),
  PARAMETER_RECORDS_NOT_CONFIGURED: entry(503, 'configuration', false),
  KNOWN_IDENTIFIERS_UNAVAILABLE: entry(503, 'configuration', false),
  ERASURE_NOT_CONFIGURED: entry(503, 'configuration', false),
  // Erasure and export (S3).
  ERASURE_CONFIRMATION_REQUIRED: entry(400, 'request', false),
  ERASURE_FORBIDDEN: entry(403, 'authorization', false),
  ERASURE_REASON_INVALID: entry(400, 'request', false),
  ERASURE_ACTOR_INVALID: entry(500, 'contract', false),
  ERASURE_TOO_LARGE: entry(409, 'request', false),
  EXECUTION_MODE_NOT_CONFIGURED: entry(null, 'configuration', false),
  READBACK_DISABLED: entry(503, 'configuration', false),
  // Reference data route (ADR 0021): registered here because the routes file names them (main had left them out).
  REFERENCE_DATA_NOT_CONFIGURED: entry(503, 'configuration', false),
  REFERENCE_DATA_DISABLED: entry(503, 'configuration', false),
  REFERENCE_DATA_REQUEST_INVALID: entry(400, 'request', false),
  // Chat v0 (P7a): deterministic cited lookup, no model.
  CHAT_REQUEST_INVALID: entry(400, 'request', false),
  CHAT_NOT_CONFIGURED: entry(503, 'configuration', false),
  // Policy profile (policy facts slice 1, ADR 0024): identity of a policy read from a document and confirmed by its owner.
  // Already thrown by policy-structuring-service.js (409) and named in the route file; it was missing from this registry (found by p1a-error-codes).
  STRUCTURING_RESTART_REQUIRED: entry(409, 'conflict', false),
  POLICY_FACTS_DISABLED: entry(503, 'configuration', false),
  POLICY_PROFILE_NOT_FOUND: entry(404, 'not_found', false),
  POLICY_PROFILE_VERSION_CONFLICT: entry(409, 'conflict', false),
  POLICY_PROFILE_CONFLICTING_FACTS: entry(409, 'conflict', false),
  POLICY_PROFILE_NOT_READY: entry(409, 'conflict', true),
  POLICY_PROFILE_INVALID_UIN: entry(422, 'request', false),
  POLICY_PROFILE_INVALID: entry(400, 'request', false),
  PAGE_COUNT_INVALID: entry(400, 'request', false),
  // Policy facts (slice 2, ADR 0025): datapoints read from a document, each with verified evidence.
  POLICY_FACTS_NOT_FOUND: entry(404, 'not_found', false),
  POLICY_FACTS_NOT_READY: entry(409, 'conflict', true),
  POLICY_FACT_NOT_READY: entry(409, 'conflict', true),
  POLICY_FACT_INVALID: entry(400, 'request', false),
  // Document intake (Block 1): upload route, upload service, document repository and the
  // document-intake module errors those surfaces return. ADR 0005.
  DOCUMENT_NOT_FOUND: entry(404, 'not_found', false),
  DOCUMENT_DELETE_FORBIDDEN: entry(403, 'authorization', false),
  DOCUMENT_DELETE_CONFLICT: entry(409, 'conflict', false),
  DOCUMENT_STORAGE_NOT_CONFIGURED: entry(503, 'configuration', false),
  DOCUMENT_UPDATE_NOT_SUPPORTED: entry(null, 'contract', false),
  UPLOAD_CAPACITY_REACHED: entry(429, 'capacity', true),
  // Pending uploads cannot clear because no malware scanner is configured on this server (DOCUMENT_SCAN_MODE=disabled).
  DOCUMENT_SCANNER_NOT_CONFIGURED: entry(503, 'configuration', false),
  UNSUPPORTED_MEDIA_TYPE: entry(415, 'request', false),
  REQUEST_TOO_LARGE: entry(413, 'request', false),
  UNSUPPORTED_DOCUMENT_KIND: entry(400, 'request', false),
  INVALID_FILENAME: entry(400, 'request', false),
  INVALID_INPUT: entry(400, 'request', false),
  INVALID_VERSION: entry(400, 'request', false),
  INVALID_BYTES: entry(400, 'request', false),
  EMPTY_FILE: entry(400, 'request', false),
  FILE_TOO_LARGE: entry(413, 'request', false),
  MIME_MISMATCH: entry(400, 'request', false),
  EXTENSION_MISMATCH: entry(400, 'request', false),
  ACTIVE_CONSENT_REQUIRED: entry(403, 'authorization', false),
  DUPLICATE_DOCUMENT: entry(409, 'conflict', false),
  DOCUMENT_VERSION_EXISTS: entry(409, 'conflict', false),
  PDF_STRUCTURE_INVALID: entry(422, 'request', false),
  PDF_PASSWORD_REQUIRED: entry(422, 'request', false),
  PDF_ACTIVE_CONTENT: entry(422, 'request', false),
  PDF_PAGE_LIMIT: entry(422, 'request', false),
  PDF_RESOURCE_LIMIT: entry(422, 'request', false),
  PDF_UNSUPPORTED_ENCODING: entry(422, 'request', false),
  PDF_SANITIZE_FAILED: entry(422, 'request', false),
  PDF_SANITIZE_UNAVAILABLE: entry(503, 'configuration', true),
  // Sandboxed PDF inspection (ADR 0005 amendment). Every one rejects the upload; none is clean.
  PDF_INSPECTION_FAILED: entry(422, 'request', false),
  PDF_INSPECTION_BUSY: entry(429, 'capacity', true),
  PDF_INSPECTION_UNAVAILABLE: entry(503, 'configuration', true),
  // Document OCR (Block 2). Provider payloads remain behind this stable application family.
  DOCUMENT_NOT_OCR_READY: entry(409, 'conflict', false),
  OCR_AUTHORIZATION_REQUIRED: entry(403, 'authorization', false),
  OCR_JOB_NOT_FOUND: entry(404, 'not_found', false),
  OCR_RECONCILIATION_REQUIRED: entry(409, 'conflict', false),
  OCR_LANGUAGE_UNSUPPORTED: entry(400, 'request', false),
  OCR_CONTENT_TYPE_UNSUPPORTED: entry(400, 'request', false),
  OCR_UNSUPPORTED_MEDIA_TYPE: entry(415, 'request', false),
  OCR_PAGE_LIMIT: entry(422, 'request', false),
  OCR_PROVIDER_DISABLED: entry(503, 'configuration', false),
  OCR_PROVIDER_AUTHENTICATION_FAILED: entry(503, 'configuration', false),
  OCR_PROVIDER_FORBIDDEN: entry(403, 'provider', false),
  OCR_PROVIDER_MODE_MISMATCH: entry(503, 'configuration', false),
  OCR_SEGMENTATION_UNAVAILABLE: entry(503, 'configuration', true),
  OCR_SEGMENTATION_FAILED: entry(422, 'request', false),
  OCR_PROVIDER_RATE_LIMITED: entry(429, 'provider', true),
  OCR_PROVIDER_UNAVAILABLE: entry(503, 'provider', true),
  OCR_PROVIDER_ENTITLEMENT_REQUIRED: entry(403, 'provider', false),
  OCR_PROVIDER_FILE_TOO_LARGE: entry(413, 'provider', false),
  OCR_PROVIDER_INPUT_REJECTED: entry(422, 'provider', false),
  OCR_PROVIDER_JOB_NOT_FOUND: entry(502, 'provider', false),
  OCR_PROVIDER_NOT_READY: entry(409, 'provider', true),
  OCR_PROVIDER_DEADLINE_EXCEEDED: entry(504, 'provider', false),
  OCR_PROVIDER_FAILED: entry(502, 'provider', false),
  OCR_PROVIDER_NETWORK_UNCERTAIN: entry(503, 'provider', false),
  OCR_PROVIDER_RESPONSE_TOO_LARGE: entry(502, 'provider', false),
  OCR_PROVIDER_RESPONSE_INVALID: entry(502, 'provider', false),
  OCR_PROVIDER_PAGE_MISMATCH: entry(502, 'provider', false),
  OCR_PROVIDER_PARTIAL: entry(502, 'provider', false),
  OCR_PROVIDER_CANCELLATION_UNSUPPORTED: entry(null, 'terminal_reason', false),
  OCR_SCHEMA_INVALID: entry(502, 'contract', false),
  OCR_SOURCE_MISMATCH: entry(502, 'contract', false),
  OCR_SUBMISSION_FAILED: entry(502, 'provider', false),
  OCR_JOB_ALREADY_COMPLETED: entry(409, 'conflict', false),
  OCR_PAGES_ALREADY_EXIST: entry(409, 'conflict', false),
  OCR_PERSISTENCE_FAILED: entry(500, 'storage', false),
  OCR_MODE_INVALID: entry(400, 'request', false),
  OCR_UPGRADE_NOT_NEEDED: entry(409, 'conflict', false),
  OCR_UPGRADE_CHARGE_UNACKNOWLEDGED: entry(409, 'conflict', false),
  OCR_UPGRADE_UNSUPPORTED: entry(409, 'conflict', false),
  OCR_UPGRADE_TEXT_CHANGED: entry(409, 'conflict', false),
  // Scanner and storage codes seen by the document worker (never returned to clients).
  SCANNER_UNAVAILABLE: entry(null, 'task_failure', true),
  SCANNER_ERROR: entry(null, 'task_failure', true),
  SCANNER_INPUT_INVALID: entry(null, 'contract', false),
  STORAGE_TAMPERED: entry(null, 'task_failure', false),
  STORAGE_OBJECT_MISSING: entry(null, 'task_failure', false),
  STORAGE_UNAVAILABLE: entry(null, 'task_failure', true),
  INVALID_STORAGE_KEY: entry(null, 'contract', false),
  DOCUMENT_DELETED: entry(null, 'terminal_reason', false),
  DATA_ERASED: entry(null, 'terminal_reason', false),
  // Audit reason codes written when the scan worker rejects a stored document.
  MALWARE_DETECTED: entry(null, 'terminal_reason', false),
  STORAGE_INTEGRITY_FAILED: entry(null, 'terminal_reason', false),
  SCAN_FAILED_REPEATEDLY: entry(null, 'terminal_reason', false),
  // Task and contract failures, stored as last_error_code / terminal_reason.
  AGENT_CONTRACT_INVALID: entry(null, 'contract', false),
  WORKFLOW_VERSION_MISMATCH: entry(null, 'contract', false),
  WORKFLOW_GRAPH_INVALID: entry(null, 'contract', false),
  TASK_SCHEMA_MISMATCH: entry(null, 'contract', false),
  TASK_TRANSITION_INVALID: entry(null, 'contract', false),
  PORT_CONTRACT_INVALID: entry(null, 'contract', false),
  API_CONTRACT_INVALID: entry(400, 'contract', false),
  UNSUPPORTED_WORKFLOW: entry(null, 'contract', false),
  ANALYSIS_TASK_FAILED: entry(null, 'task_failure', false),
  TASK_FAILED: entry(null, 'task_failure', false),
  PARAMETER_OBSERVATION_FAILED: entry(null, 'task_failure', false),
  RUN_NOT_FOUND: entry(null, 'task_failure', false),
  // TASK_LEASE_LOST is raised by the parameter repository and swallowed by the worker:
  // the stale result is dropped and the current lease holder owns the task.
  TASK_LEASE_LOST: entry(null, 'lease', false),
  // Terminal reasons written by the workflow repository and the port.
  ATTEMPT_LIMIT: entry(null, 'terminal_reason', false),
  LEASE_EXPIRED: entry(null, 'terminal_reason', true),
  CONSENT_REVOKED: entry(null, 'terminal_reason', false),
  RELEASE_BLOCKED: entry(null, 'terminal_reason', false),
});

/** Descendants of a failed task are blocked with UPSTREAM_<code of the failed task>. */
export const UPSTREAM_TERMINAL_REASON = /^UPSTREAM_[A-Z][A-Z0-9_]*$/;

export const STABLE_ERROR_CODE_FORMAT = /^[A-Z][A-Z0-9_]*$/;

export function isStableErrorCode(code) {
  return typeof code === 'string'
    && (Object.prototype.hasOwnProperty.call(ANALYSIS_ERROR_CODES, code) || UPSTREAM_TERMINAL_REASON.test(code));
}

export function assertStableErrorCode(code) {
  if (!isStableErrorCode(code)) throw Object.assign(new TypeError(`Unregistered analysis error code: ${String(code)}.`), { code: 'AGENT_CONTRACT_INVALID' });
  return code;
}
