// Persistence port interfaces the coverage-analysis runtime needs. A PostgreSQL adapter
// must satisfy these with the same semantics as the SQLite implementation
// (src/backend/services/coverage-analysis-port.js and src/backend/repositories/*).
// No database code here: method lists, JSDoc signatures and runtime shape checks only.
//
// Async compatibility: every method may return a value or a Promise of it. The persistent
// coverage-analysis service awaits every port call, and the live runtime awaits
// authorizeModelDispatch. Each method is one atomic unit of work: the adapter owns its
// transaction, and callers never hold a transaction open across two port calls.
//
// ADR: docs/adr/0002-persistence-port.md

export const PORT_CONTRACT_ERROR_CODE = 'PORT_CONTRACT_INVALID';

/**
 * Persistent coverage-analysis port, as required by createPersistentCoverageAnalysisService.
 * @typedef {object} CoverageAnalysisPort
 * @property {(caseId: string) => Awaitable<CaseRecord|null>} getCase
 *   Case row plus analysis_subject_adult_id and analysis_subject_member_id, or null.
 * @property {(input: { caseRecord: CaseRecord, consentGrantId: string }) => Awaitable<object>} requireCoverageConsent
 *   Throws CONSENT_REQUIRED unless the grant is active for the case's analysis subject.
 * @property {(input: { scope: string, key: string, at: string }) => Awaitable<IdempotencyRow|null>} findIdempotency
 *   Deletes the key first if expired at `at`; returns { request_digest, response_json, ... } or null.
 * @property {(input: { scope: string, key: string, requestDigest: string, responseStatus: number, response: object, expiresAt: string }) => Awaitable<void>} recordIdempotency
 * @property {(input: RunCreation) => Awaitable<RunRow & { tasks: TaskRow[] }>} createRunWithParameters
 *   Run, tasks (in declaration order), registry pin and one parameter record per registry
 *   key, created atomically. Any failure leaves nothing behind.
 * @property {(runId: string) => Awaitable<{ allowed: boolean, reasonCode?: string }>} verifyRunSourcesCurrent
 *   Commit-time consent re-check of every source the run was built from. Errors deny.
 * @property {(caseId: string) => Awaitable<object[]>} getCoverageSourcePages
 * @property {(caseId: string) => Awaitable<{ kind: string, value: string }[]>} loadKnownIdentifiers
 *   Throws KNOWN_IDENTIFIERS_UNAVAILABLE (fail closed). Never persisted by callers.
 * @property {(runId: string) => Awaitable<(RunRow & { tasks: TaskRow[] })|null>} getJob
 * @property {(taskId: string) => Awaitable<TaskRow|null>} getTask
 * @property {(input: { workerId: string, runId?: string|null, workflowName?: string|null, leaseDurationMs?: number }) => Awaitable<TaskRow|null>} claimNext
 * @property {(taskId: string) => Awaitable<Record<string, object|null>>} dependencyOutputs
 *   Output envelopes of the task's prerequisites keyed by task key.
 * @property {(taskId: string, input: { output: object, workerId?: string|null }) => Awaitable<TaskRow>} completeTask
 * @property {(taskId: string, input: { workerId?: string|null, code?: string, message?: string, retryAt?: string|null }) => Awaitable<TaskRow>} failTask
 * @property {() => Awaitable<number>} recoverExpiredLeases
 * @property {(grantId: string|null, at: string) => Awaitable<boolean>} isConsentActive
 * @property {(runId: string, options?: { reason?: string, reasonCode?: string|null }) => Awaitable<object|null>} stopForRevocation
 * @property {(input: { task?: string, runId?: string, caseId?: string, subjectId?: string, modelRecipient?: string, authorizedSourceIds?: string[], authorizedSources?: object[] }) => Awaitable<{ allowed: boolean, reasonCode?: string }>} [authorizeModelDispatch]
 * @property {(input: { run: RunRow, task: TaskRow, taskKey: string, output: object }) => Awaitable<void>} persistTaskArtifact
 * @property {(input: { runId: string, taskKey: string, payload: unknown, taskId: string, workerId: string }) => Awaitable<{ observations: number, parameters: number, conflicting: number, skipped: number }>} recordModelObservations
 *   Throws TASK_LEASE_LOST when the lease moved, PARAMETER_RECORDS_NOT_CONFIGURED when unwired.
 */
export const COVERAGE_ANALYSIS_PORT_METHODS = Object.freeze([
  'getCase', 'requireCoverageConsent', 'findIdempotency', 'recordIdempotency',
  'createRunWithParameters', 'verifyRunSourcesCurrent', 'getCoverageSourcePages', 'loadKnownIdentifiers', 'getJob', 'getTask', 'claimNext', 'dependencyOutputs',
  'completeTask', 'failTask', 'recoverExpiredLeases', 'isConsentActive',
  'stopForRevocation', 'persistTaskArtifact', 'recordModelObservations',
]);

/** Required in addition when live model dispatch is wired (create-server pre-dispatch validator). */
export const MODEL_DISPATCH_PORT_METHODS = Object.freeze(['authorizeModelDispatch']);

/**
 * Workflow run/task store (WorkflowRepository). Methods the port and runtime call.
 * @typedef {object} WorkflowRepositoryPort
 * @property {(input: { id?: string, caseId: string, workflowName: string, workflowVersion: string, executionMode: string, caseRevision?: string|null, consentGrantId?: string|null, input?: object }) => Awaitable<RunRow>} createRun
 * @property {(input: { taskId?: string, runId: string, agentName: string, taskKind: string, input?: object, parentTaskId?: string|null, dependencyTaskIds?: string[], at?: string }) => Awaitable<TaskRow>} insertTask
 * @property {(input: object) => Awaitable<RunRow & { tasks: TaskRow[] }>} createRunWithTasks
 * @property {(input: object & { idempotencyKey: string }) => Awaitable<TaskRow>} enqueueTask
 *   Idempotent per (workflow_task, key) for 24 h; a different request digest throws IDEMPOTENCY_CONFLICT.
 * @property {(runId: string) => Awaitable<RunRow|null>} getRun
 * @property {(taskId: string) => Awaitable<TaskRow|null>} getTask
 * @property {(input?: { workerId?: string, leaseDurationMs?: number, runId?: string|null, workflowName?: string|null }) => Awaitable<TaskRow|null>} claimNext
 * @property {(taskId: string, input?: { output?: object, workerId?: string|null }) => Awaitable<TaskRow>} completeTask
 * @property {(taskId: string, input?: { workerId?: string|null, code?: string, message?: string, retryAt?: string|null }) => Awaitable<TaskRow>} failTask
 * @property {(input?: { at?: string }) => Awaitable<number>} recoverExpiredLeases
 */
export const WORKFLOW_REPOSITORY_PORT_METHODS = Object.freeze([
  'createRun', 'insertTask', 'createRunWithTasks', 'enqueueTask', 'getRun', 'getTask',
  'claimNext', 'completeTask', 'failTask', 'recoverExpiredLeases',
]);

/**
 * Coverage parameter store (CoverageParameterRepository). Methods the port and the
 * consent erasure path call.
 * @typedef {object} CoverageParameterRepositoryPort
 * @property {(input: { workflowRunId: string, registryVersion: string, householdId: string, caseId: string, subjectId: string, policyId: string, updatedBy: string }) => Awaitable<{ total: number }>} initializeRunParameters
 * @property {(input: { workflowRunId: string, parameterKeys: string[], state: string, reasonCode?: string|null, updatedBy: string, at?: string }) => Awaitable<object>} setAcquisitionStateForRun
 * @property {(input: { workflowRunId: string, entries: object[], recordedBy: string, lease?: { taskId: string, workerId: string }|null, taskKey?: string|null, at?: string }) => Awaitable<object>} recordModelExtraction
 * @property {(input: object) => Awaitable<object>} redactObservationsForRun
 * @property {(input: object) => Awaitable<object>} redactObservationsForDocument
 */
export const COVERAGE_PARAMETER_REPOSITORY_PORT_METHODS = Object.freeze([
  'initializeRunParameters', 'setAcquisitionStateForRun', 'recordModelExtraction',
  'redactObservationsForRun', 'redactObservationsForDocument',
]);

/**
 * Consent store methods the analysis runtime depends on (ConsentRepository).
 * @typedef {object} ConsentRepositoryPort
 * @property {(grantId: string, scope: { subjectAdultId: string, purpose: string, resourceType: string, resourceId?: string|null, action: string, dataCategory: string, recipient?: string|null, at?: string }) => Awaitable<object>} requireActive
 *   Throws CONSENT_REQUIRED / CONSENT_SCOPE_REQUIRED unless the grant is active and covers the scope.
 * @property {(input: { householdId: string|null, documentIds: string[], runIds: string[], caseId: string, reason: string, resourceType: string, resourceId: string, at: string }) => Awaitable<object>} eraseDerivedRunData
 */
export const CONSENT_REPOSITORY_PORT_METHODS = Object.freeze(['requireActive', 'eraseDerivedRunData']);

/**
 * Case and audit methods the analysis runtime depends on (CaseRepository, AuditRepository).
 * @typedef {object} CaseRepositoryPort
 * @property {(caseId: string) => Awaitable<CaseRecord|null>} get
 * @typedef {object} AuditRepositoryPort
 * @property {(event: { householdId?: string|null, caseId?: string|null, actorType?: string, actorId?: string, action: string, resourceType: string, resourceId: string, payload?: object }) => Awaitable<object>} append
 *   Append-only; payloads carry counts, codes and digests, never personal values.
 */
export const CASE_REPOSITORY_PORT_METHODS = Object.freeze(['get']);
export const AUDIT_REPOSITORY_PORT_METHODS = Object.freeze(['append']);

/**
 * In-memory/fixture run store used by createCoverageAnalysisRuntime
 * (same list as assertCoverageAnalysisPort in src/modules/coverage-analysis/contracts.js).
 * @typedef {object} FixtureRunStorePort
 * @property {(run: object) => Awaitable<object>} createRun
 * @property {(runId: string) => Awaitable<object|null>} loadRun
 * @property {(run: object, options: { expectedRevision: number }) => Awaitable<object>} replaceRun
 */
export const FIXTURE_RUN_STORE_PORT_METHODS = Object.freeze(['createRun', 'loadRun', 'replaceRun']);

/** @template T @typedef {T|Promise<T>} Awaitable */
/** @typedef {Record<string, unknown>} CaseRecord */
/** @typedef {Record<string, unknown>} RunRow */
/** @typedef {Record<string, unknown>} TaskRow */
/** @typedef {Record<string, unknown>} IdempotencyRow */
/** @typedef {Record<string, unknown>} RunCreation */

function assertPort(port, methods, label) {
  const missing = !port || (typeof port !== 'object' && typeof port !== 'function')
    ? [...methods]
    : methods.filter(method => typeof port[method] !== 'function');
  if (missing.length > 0) {
    throw Object.assign(new TypeError(`${label} is missing method(s): ${missing.join(', ')}.`), { code: PORT_CONTRACT_ERROR_CODE });
  }
  return port;
}

export function assertCoverageAnalysisPort(port, { modelDispatch = false } = {}) {
  return assertPort(port, modelDispatch ? [...COVERAGE_ANALYSIS_PORT_METHODS, ...MODEL_DISPATCH_PORT_METHODS] : COVERAGE_ANALYSIS_PORT_METHODS, 'Coverage analysis port');
}

export function assertWorkflowRepositoryPort(port) {
  return assertPort(port, WORKFLOW_REPOSITORY_PORT_METHODS, 'Workflow repository port');
}

export function assertCoverageParameterRepositoryPort(port) {
  return assertPort(port, COVERAGE_PARAMETER_REPOSITORY_PORT_METHODS, 'Coverage parameter repository port');
}

export function assertConsentRepositoryPort(port) {
  return assertPort(port, CONSENT_REPOSITORY_PORT_METHODS, 'Consent repository port');
}

export function assertCaseRepositoryPort(port) {
  return assertPort(port, CASE_REPOSITORY_PORT_METHODS, 'Case repository port');
}

export function assertAuditRepositoryPort(port) {
  return assertPort(port, AUDIT_REPOSITORY_PORT_METHODS, 'Audit repository port');
}

export function assertFixtureRunStorePort(port) {
  return assertPort(port, FIXTURE_RUN_STORE_PORT_METHODS, 'Fixture run store port');
}
