// Retry, timeout, lease and idempotency contracts as they behave TODAY in
// src/backend/repositories/workflow-repository.js, src/backend/services/coverage-analysis-port.js,
// src/features/coverage-analysis/persistent-service.js, src/features/coverage-analysis/runtime.js,
// src/features/ai-analysis/live-coverage-runtime.js and src/server/routes/v1-backend-routes.js.
// These constants document behaviour; they do not drive it yet. tests/p1a-execution-policy.test.mjs
// proves each one against the running code, so a PostgreSQL adapter can be held to the same rules.
//
// ADR: docs/adr/0001-workflow-v6-contracts.md, docs/adr/0002-persistence-port.md

export const EXECUTION_POLICY_VERSION = 'knowvia-execution-policy-v1';

/** Lease length granted by WorkflowRepository.claimNext (constructor default leaseDurationMs). */
export const TASK_LEASE_DURATION_MS = 60_000;
/** Claim is refused once attempt_count reaches this; the task fails with ATTEMPT_LIMIT. */
export const TASK_MAX_ATTEMPTS = 5;

/**
 * Per-task retry policy carried by every workflow task definition.
 * - A task is retried only when its lease expires (recoverExpiredLeases): it returns to
 *   `pending` immediately (retry_available_at = recovery time), until attempts reach the cap.
 * - A thrown task error is terminal: the persistent service calls failTask without retryAt,
 *   so the task becomes `failed` and its pending descendants `blocked` (UPSTREAM_<code>).
 *   failTask(retryAt) is supported by the repository but has no caller in the runtime.
 */
export const TASK_RETRY_POLICY = Object.freeze({
  maxAttempts: TASK_MAX_ATTEMPTS,
  leaseDurationMs: TASK_LEASE_DURATION_MS,
  retryOn: Object.freeze(['LEASE_EXPIRED']),
  retryDelayMs: 0,
  thrownErrorIsTerminal: true,
});

/** Persisted states (CHECK constraints in migration 001). */
export const PERSISTED_RUN_STATES = Object.freeze([
  'queued', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted',
]);
export const PERSISTED_TASK_STATES = Object.freeze([
  'pending', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted',
]);
/** Run states the persistent worker treats as settled. */
export const PERSISTED_TERMINAL_RUN_STATES = Object.freeze([
  'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted',
]);
/** Runs whose tasks can still be claimed. */
export const CLAIMABLE_RUN_STATES = Object.freeze(['queued', 'running']);

/**
 * Every task state change the persistent runtime performs. `operation` names the
 * repository/port method; `terminalReason` is what is written to terminal_reason
 * (null = left NULL). UPSTREAM_<code> is the failing upstream task's code.
 */
export const TASK_STATE_TRANSITIONS = Object.freeze([
  Object.freeze({ operation: 'claimNext', from: 'pending', to: 'running', terminalReason: null }),
  Object.freeze({ operation: 'claimNext.attemptLimit', from: 'pending', to: 'failed', terminalReason: 'ATTEMPT_LIMIT' }),
  Object.freeze({ operation: 'completeTask', from: 'running', to: 'completed', terminalReason: 'completed' }),
  Object.freeze({ operation: 'failTask.retry', from: 'running', to: 'pending', terminalReason: null }),
  Object.freeze({ operation: 'failTask', from: 'running', to: 'failed', terminalReason: '<code>' }),
  Object.freeze({ operation: 'recoverExpiredLeases', from: 'running', to: 'pending', terminalReason: null }),
  Object.freeze({ operation: 'recoverExpiredLeases.attemptLimit', from: 'running', to: 'failed', terminalReason: 'LEASE_EXPIRED' }),
  Object.freeze({ operation: 'blockDescendants', from: 'pending', to: 'blocked', terminalReason: 'UPSTREAM_<code>' }),
  Object.freeze({ operation: 'stopForRevocation', from: 'pending', to: 'revoked', terminalReason: 'CONSENT_REVOKED' }),
  Object.freeze({ operation: 'stopForRevocation', from: 'running', to: 'revoked', terminalReason: 'CONSENT_REVOKED' }),
]);

/**
 * Claim, complete and fail rules (WorkflowRepository):
 * - claim: oldest pending task (created_at, id) whose attempts < cap, retry time reached,
 *   run queued|running, run consent grant (if any) unrevoked and unexpired, and every
 *   prerequisite completed. Claim increments attempt_count and sets a lease.
 * - complete/fail: only while running, and only by the lease owner when a workerId is given.
 * - run settlement: once no task is pending or running, the run takes the first present
 *   state of RUN_SETTLEMENT_PRECEDENCE; otherwise `blocked` (RELEASE_BLOCKED) when the
 *   release gate output says blocked or cannot be parsed; otherwise `completed`.
 */
export const RUN_SETTLEMENT_PRECEDENCE = Object.freeze(['failed', 'blocked', 'revoked', 'cancelled', 'interrupted']);

export function assertTaskTransition(operation, from, to) {
  const allowed = TASK_STATE_TRANSITIONS.some(rule => rule.operation === operation && rule.from === from && rule.to === to);
  if (!allowed) throw Object.assign(new TypeError(`Task transition is not part of the contract: ${operation} ${from} -> ${to}.`), { code: 'TASK_TRANSITION_INVALID' });
  return to;
}

/** Bounds enforced by createPersistentCoverageAnalysisService. */
export const PERSISTENT_WORKER_LIMITS = Object.freeze({
  maxConcurrency: Object.freeze({ default: 4, min: 1, max: 8 }),
  maxTasksPerSettle: Object.freeze({ default: 30, min: 1, max: 100 }),
});

/** Bounds enforced by the in-memory fixture runtime (createCoverageAnalysisRuntime). */
export const FIXTURE_RUNTIME_LIMITS = Object.freeze({
  // An interrupted (still running) fixture task is retried while attempts < 2, then blocked.
  maxAttempts: 2,
  maxTicks: Object.freeze({ default: 20, min: 1, max: 100 }),
});

/** Live model call limits (live-coverage-runtime config; env LLM_TIMEOUT_MS). No in-call retries. */
export const MODEL_CALL_POLICY = Object.freeze({
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 60_000,
  maxRetries: 0,
});

/**
 * Idempotency. Keys live in idempotency_keys(scope, idempotency_key) for 24 hours; an
 * expired key is deleted lazily when it is next looked up. Same key and same request
 * digest replays the stored response; same key and a different digest is
 * IDEMPOTENCY_CONFLICT (HTTP 409).
 */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_KEY_LENGTH = Object.freeze({ min: 8, max: 200 });
export const IDEMPOTENCY_SCOPES = Object.freeze({
  // POST /api/v1/cases/:caseId/analysis-runs (persistent-service createAnalysisRun).
  // The digest covers these request fields; workflowVersion is one of them, so a key
  // first used against workflow v5 conflicts (409) when replayed against v6.
  analysis_run: Object.freeze({
    ttlMs: IDEMPOTENCY_TTL_MS,
    replayStatus: 200,
    createdStatus: 202,
    digestFields: Object.freeze([
      'caseId', 'caseRevision', 'consentGrantId', 'executionMode', 'fixtureVariant',
      'modelPermission', 'parameterRegistryVersion', 'workflowVersion',
    ]),
  }),
  // WorkflowRepository.enqueueTask.
  workflow_task: Object.freeze({
    ttlMs: IDEMPOTENCY_TTL_MS,
    replayStatus: null,
    createdStatus: 201,
    digestFields: Object.freeze(['agentName', 'dependencies', 'input', 'runId', 'taskKind']),
  }),
});

export function validateIdempotencyKey(key) {
  if (typeof key !== 'string' || key.length < IDEMPOTENCY_KEY_LENGTH.min || key.length > IDEMPOTENCY_KEY_LENGTH.max) {
    throw Object.assign(new TypeError('A stable Idempotency-Key header between 8 and 200 characters is required.'), { code: 'IDEMPOTENCY_KEY_REQUIRED', statusCode: 400 });
  }
  return key;
}
