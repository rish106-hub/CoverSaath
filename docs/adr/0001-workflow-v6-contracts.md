# ADR 0001: Coverage-analysis workflow v6 and frozen task contracts

- Status: Proposed (P1-A, branch `claude/p1-contracts`)
- Date: 2026-10-15
- Scope: `src/modules/coverage-analysis/{workflow-definition,agent-contracts,contracts}.js`, `src/contracts/{task-contracts,workflow-graph,execution-policy,error-codes,analysis-run-api}.js`

## Context

PostgreSQL work (Phase 1) needs fixed interfaces. Before this change the workflow (version 5) had no graph checksum, task definitions had no retry policy, the three task contracts accepted unknown fields, and nothing stopped output from one workflow version being consumed by a run of another.

## Decision

1. **Workflow version 6.** The task graph is the same as v5: 22 tasks, the same keys, kinds, owners, model tasks, dependencies and `/v1` schema ids. v6 adds:
   - `retryPolicy` on every task. It is the shared, frozen `TASK_RETRY_POLICY`.
   - `graphChecksum`, a sha256 over the canonical graph: tasks sorted by key, with key, kind, owner, model task, sorted dependencies and the input/output schema ids, plus the workflow name. The v6 value is `39384121ec4e1002c1dc9820ffd0ee49143fecf8566307b1e2c421812e0e9fa1`, pinned in `tests/p1a-workflow-contracts.test.mjs`. The retry policy is not part of the checksum because it is versioned by `EXECUTION_POLICY_VERSION`.
   - Validation at module load (`validateCoverageWorkflowDefinition`). The module refuses to load on any of these:
     - unknown or missing TaskDefinition fields
     - a cycle
     - a missing, duplicate or self dependency
     - a dependency declared after the task that uses it (persistence inserts tasks in declaration order)
     - schema ids that do not match the task key
     - a deterministic task with a model task
     - a model task outside `AI_TASKS`
     - a protected kind (`DETERMINISTIC_TASKS`) that is not deterministic
     - ownership that differs from `RUNTIME_RESPONSIBILITIES`
2. **Frozen contracts** (`src/contracts/task-contracts.js`). Each validator rejects unknown and missing fields.
   - `TaskDefinition`: `key, kind, owner, modelTask, dependsOn, inputSchema, outputSchema, retryPolicy`.
   - `TaskInvocation`: `input, upstream, run`. `upstream` must hold exactly the task's dependencies.
   - `TaskResultEnvelope`: `contractVersion, taskKey, taskKind, schemas{input,output}, producer{owner,modelTask,execution}, provenance{runId,caseId,workflowName,workflowVersion,inputDigest,sourceRefs}, evidenceState, payload`. The envelope shape and `AGENT_CONTRACT_VERSION` (`knowvia-agent-contract-v1`) do not change, because `read-response-policy.js` matches on that string.
   - The envelope is now validated when it is written as well as when it is read. A result that could never be consumed, such as model metadata on the deterministic release gate, is refused before it is stored.
3. **Evidence states.** These are reused, not new: `EVIDENCE_STATES` (Proven, Calculated, Reported, Dynamic, Unknown, Conflicting) and `PARAMETER_RESOLUTION_STATES`.
4. **Execution contracts** (`src/contracts/execution-policy.js`) record what the code does today; they do not change behaviour:
   - Lease: 60 s.
   - Attempts: capped at 5.
   - Retries happen only when a lease expires, and immediately.
   - A thrown task error is terminal. `failTask(retryAt)` exists but has no caller.
   - Claim, complete and fail rules, including that only the lease holder may complete or fail.
   - Run settlement precedence.
   - Persisted states (migration 001 CHECKs).
   - Worker bounds: concurrency 1–8 (default 4) and 1–100 tasks per settle (default 30).
   - Fixture runtime: 2 attempts, 1–100 ticks.
   - Model calls: 30 s default, 60 s maximum, 0 retries.
   - Idempotency: 24 h TTL, key length 8–200, and per scope the digest fields and the created and replay statuses.
   - Each item is proven against the running code by `tests/p1a-execution-policy.test.mjs`.
5. **Stable error codes** (`src/contracts/error-codes.js`). One registry covers the analysis-run path, with HTTP status, category and whether a retry can help. A drift test fails if a covered file raises or stores an unregistered code. One code is new: `WORKFLOW_VERSION_MISMATCH`.
6. **API schemas** (`src/contracts/analysis-run-api.js`) cover the three existing routes:
   - `POST /api/v1/cases/:caseId/analysis-runs`
   - `GET /api/v1/jobs/:jobId`
   - `GET /api/v1/tasks/:taskId`

   The routes do not use these validators yet. Wiring them in is a separate decision, because the request validator rejects unknown body fields, which the route ignores today.

## Compatibility and the version gate

- **Runs pinned to an older version stay readable.** No migration and no persisted row changes. `GET /api/v1/jobs/:id` and `GET /api/v1/tasks/:id` read rows without contract validation, and the fixture runtime's `getRun` still validates task records (the graph is unchanged).
- **Older output never silently enters v6.**
  - `validateTaskInvocation` and `createTaskOutputEnvelope` reject a run pinned to another version with `WORKFLOW_VERSION_MISMATCH`.
  - `validateTaskOutputEnvelope` rejects any envelope whose `provenance.workflowVersion` is not `6`, including a missing version. This is the strict read side.
  - In the persistent worker, a v5 task fails with `last_error_code = WORKFLOW_VERSION_MISMATCH`, and its descendants are blocked with `UPSTREAM_WORKFLOW_VERSION_MISMATCH`. Nothing is completed and no parameter observation is recorded.
- **Idempotency.** `workflowVersion` is part of the `analysis_run` request digest. A key first used against v5 and replayed within 24 h is therefore `IDEMPOTENCY_CONFLICT`, never a replay of the v5 run and never a new v6 run.
- **Run objects with no version.** The write side is strict: `validateTaskInvocation` and `createTaskOutputEnvelope` reject a run object with no version with `WORKFLOW_VERSION_MISMATCH`, like any other version. The hand-built stub in `tests/mvp-closeout.test.mjs` (F1) now carries `workflow_version`. Persisted rows always have a version (`workflow_version NOT NULL`).

## Finding F-API-1 (fixed during Phase 1 integration)

`handleV1BackendRoute` returned the promise from `createAnalysisRun` without awaiting it inside its `try`, so errors raised asynchronously by the analysis service skipped `errorResponse` and reached the server's `publicError` handler as `{ error: <string> }` with no code (for example `IDEMPOTENCY_CONFLICT` as 400 instead of 409). The route now uses `return await createAnalysisRun(...)`, so these errors get the coded `{ error: { code, message } }` body and their registered status. `errorResponse` also hides driver and runtime messages (`ERR_*` codes, SQLite errors) behind `BACKEND_REQUEST_FAILED`. `tests/p1a-analysis-run-api.test.mjs` and `tests/p1-error-redaction.test.mjs` pin this.

## Rollback

Revert the P1-A commit. No schema, data or dependency changes are involved. Runs created under v6 are rows with `workflow_version = '6'`. After a rollback the v5 code does not check versions, so it would execute them. That is safe because the graph is identical.

## Risks

- A model call can take up to 60 s (`LLM_TIMEOUT_MS`), the same as the task lease. A call near the limit can outlive its lease and be re-claimed. The stale result is then dropped (`TASK_LEASE_LOST`), but the cost is spent twice.
- The policy constants document behaviour. The repositories do not import them yet, so the tests are what keep them in step.
