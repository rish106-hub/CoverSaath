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
  JOB_NOT_FOUND: entry(404, 'not_found', false),
  TASK_NOT_FOUND: entry(404, 'not_found', false),
  // State conflicts.
  IDEMPOTENCY_CONFLICT: entry(409, 'conflict', false),
  CASE_NOT_READY_FOR_ANALYSIS: entry(409, 'conflict', false),
  STALE_REVISION: entry(409, 'conflict', false),
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
  EXECUTION_MODE_NOT_CONFIGURED: entry(null, 'configuration', false),
  // Document intake (Block 1): upload route, upload service, document repository and the
  // document-intake module errors those surfaces return. ADR 0005.
  DOCUMENT_NOT_FOUND: entry(404, 'not_found', false),
  DOCUMENT_DELETE_FORBIDDEN: entry(403, 'authorization', false),
  DOCUMENT_DELETE_CONFLICT: entry(409, 'conflict', false),
  DOCUMENT_STORAGE_NOT_CONFIGURED: entry(503, 'configuration', false),
  DOCUMENT_UPDATE_NOT_SUPPORTED: entry(null, 'contract', false),
  UPLOAD_CAPACITY_REACHED: entry(429, 'capacity', true),
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
  // Sandboxed PDF inspection (ADR 0005 amendment). Every one rejects the upload; none is clean.
  PDF_INSPECTION_FAILED: entry(422, 'request', false),
  PDF_INSPECTION_BUSY: entry(429, 'capacity', true),
  PDF_INSPECTION_UNAVAILABLE: entry(503, 'configuration', true),
  // Scanner and storage codes seen by the document worker (never returned to clients).
  SCANNER_UNAVAILABLE: entry(null, 'task_failure', true),
  SCANNER_ERROR: entry(null, 'task_failure', true),
  SCANNER_INPUT_INVALID: entry(null, 'contract', false),
  STORAGE_TAMPERED: entry(null, 'task_failure', false),
  STORAGE_OBJECT_MISSING: entry(null, 'task_failure', false),
  STORAGE_UNAVAILABLE: entry(null, 'task_failure', true),
  INVALID_STORAGE_KEY: entry(null, 'contract', false),
  DOCUMENT_DELETED: entry(null, 'terminal_reason', false),
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
