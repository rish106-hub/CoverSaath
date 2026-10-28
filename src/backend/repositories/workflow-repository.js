import { createHash, randomUUID } from 'node:crypto';
import { idempotencyLock } from '../database/postgres/locks.js';

const id = prefix => `${prefix}-${randomUUID()}`;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

const serialize = value => JSON.stringify(stable(value));
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : serialize(value)).digest('hex');

const MAX_ATTEMPTS = 5;
// A claim whose conditional UPDATE lost a race re-selects up to this many more times, so a
// worker does not report "nothing to claim" while claimable work remains (S3.2 design, section 3).
const CLAIM_RESELECTIONS = 3;
const CLAIMABLE_RUN_STATES = new Set(['queued', 'running']);

// Async PostgreSQL repository (S3.2). Lock order inside every transaction here:
// workflow_runs row FOR UPDATE -> workflow_tasks rows. enqueueTask takes its idempotency advisory
// lock first. No transaction locks more than one run, so workflow transactions cannot deadlock
// against each other, and the order matches consent revocation (grant -> runs -> tasks).
export class WorkflowRepository {
  constructor(database, { clock = () => new Date(), audit, leaseDurationMs = 60_000 } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.leaseDurationMs = leaseDurationMs;
  }

  async createRun({
    id: runId = id('run'), caseId, workflowName, workflowVersion = 'v1', executionMode = 'live',
    caseRevision = null, consentGrantId = null, input = {},
  }) {
    const at = this.clock().toISOString();
    const inputJson = serialize(input);
    await this.database.run(`INSERT INTO workflow_runs
      (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
       case_revision, consent_grant_id, input_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    [runId, caseId, workflowName, workflowVersion, executionMode, digest(inputJson), caseRevision, consentGrantId, inputJson, at]);
    return this.getRun(runId);
  }

  async createRunWithTasks({ tasks = [], ...runInput }) {
    return this.database.transaction(async () => {
      const run = await this.createRun(runInput);
      const tasksByKey = new Map();
      for (const definition of tasks) {
        const dependencyTaskIds = (definition.dependsOn ?? []).map(key => {
          const task = tasksByKey.get(key);
          if (!task) throw new Error(`Workflow dependency is not defined before use: ${key}`);
          return task.id;
        });
        const task = await this.insertTask({
          ...definition,
          runId: run.id,
          dependencyTaskIds,
          at: this.clock().toISOString(),
        });
        tasksByKey.set(definition.key, task);
      }
      return { ...(await this.getRun(run.id)), tasks: [...tasksByKey.values()] };
    });
  }

  async enqueueTask({
    id: taskId = id('task'), runId, agentName, taskKind, input = {}, parentTaskId = null,
    dependencyTaskIds = [], idempotencyKey, expiresAt,
  }) {
    if (!idempotencyKey) throw new Error('Task idempotency key is required.');
    const at = this.clock().toISOString();
    const dependencies = [...new Set([parentTaskId, ...dependencyTaskIds].filter(Boolean))];
    const requestDigest = digest({ runId, agentName, taskKind, input, dependencies });
    const expiry = expiresAt ?? new Date(this.clock().getTime() + 24 * 60 * 60 * 1000).toISOString();
    // The idempotency lock serialises concurrent requests with one key: the second waits, then
    // sees the first one's key row and replays it instead of inserting a second task.
    return this.database.transaction(async () => {
      await this.database.run(`DELETE FROM idempotency_keys
        WHERE scope = 'workflow_task' AND idempotency_key = ?
          AND julianday(expires_at) <= julianday(?)`, [idempotencyKey, at]);
      const existing = await this.database.one('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?', ['workflow_task', idempotencyKey]);
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          const error = new Error('Idempotency key was reused with a different request.');
          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return JSON.parse(existing.response_json);
      }
      const task = await this.insertTask({ taskId, runId, agentName, taskKind, input, parentTaskId, dependencyTaskIds: dependencies, at });
      await this.database.run(`INSERT INTO idempotency_keys
        (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
        VALUES ('workflow_task', ?, ?, 201, ?, ?, ?)`,
      [idempotencyKey, requestDigest, JSON.stringify(task), expiry, at]);
      return task;
    }, { locks: [idempotencyLock('workflow_task', idempotencyKey)] });
  }

  // The task row and its dependency rows commit together (a savepoint inside a caller's transaction).
  async insertTask({
    id: suppliedId, taskId: suppliedTaskId, runId, agentName, taskKind, input = {}, parentTaskId = null,
    dependencyTaskIds = [], at = this.clock().toISOString(),
  }) {
    const taskId = suppliedTaskId ?? suppliedId ?? id('task');
    const dependencies = [...new Set([parentTaskId, ...dependencyTaskIds].filter(Boolean))];
    const inputJson = serialize(input);
    return this.database.transaction(async () => {
      await this.database.run(`INSERT INTO workflow_tasks
        (id, workflow_run_id, parent_task_id, agent_name, task_kind, status, input_digest, input_json, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      [taskId, runId, parentTaskId ?? dependencies[0] ?? null, agentName, taskKind, digest(inputJson), inputJson, at]);
      for (const dependencyId of dependencies) {
        await this.database.run(`INSERT INTO workflow_task_dependencies
          (workflow_task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)`, [taskId, dependencyId, at]);
      }
      return this.getTask(taskId);
    });
  }

  async claimNext({
    workerId = 'local-worker',
    leaseDurationMs = this.leaseDurationMs,
    runId = null,
    workflowName = null,
  } = {}) {
    const now = this.clock();
    const at = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    await this.#failExhaustedTasks({ runId, workflowName, at });
    for (let selection = 0; selection <= CLAIM_RESELECTIONS; selection += 1) {
      const outcome = await this.database.transaction(async () => {
        const first = await this.#selectCandidate({ at, runId, workflowName });
        if (!first) return { settled: true, task: null };
        // Lock the run before the task. Every task transition on this run takes the same lock, so
        // selecting again under it sees the run's current state: a sibling claimed meanwhile is
        // skipped, and a revocation or expiry that committed while this transaction waited makes
        // the run or its consent unclaimable.
        const run = await this.#lockRun(first.workflow_run_id);
        if (!run || !CLAIMABLE_RUN_STATES.has(run.status)) return { settled: false };
        const candidate = await this.#selectCandidate({ at, runId: run.id, workflowName });
        if (!candidate) return { settled: false };
        const claimed = await this.database.run(`UPDATE workflow_tasks
          SET status = 'running', attempt_count = attempt_count + 1,
              started_at = COALESCE(started_at, ?), lease_owner = ?, lease_expires_at = ?,
              retry_available_at = NULL, last_error_code = NULL, last_error_message = NULL
          WHERE id = ? AND status = 'pending' AND attempt_count < 5
            AND (retry_available_at IS NULL OR julianday(retry_available_at) <= julianday(?))`,
        [at, workerId, leaseExpiresAt, candidate.id, at]);
        if (claimed.changes !== 1) return { settled: false };
        await this.database.run(`UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, ?)
          WHERE id = ? AND status IN ('queued', 'running')`, [at, candidate.workflow_run_id]);
        await this.database.run(`INSERT INTO workflow_events
          (workflow_run_id, workflow_task_id, event_type, event_payload_json, occurred_at)
          VALUES (?, ?, 'task.claimed', ?, ?)`,
        [candidate.workflow_run_id, candidate.id, JSON.stringify({ workerId, leaseExpiresAt }), at]);
        return { settled: true, task: await this.getTask(candidate.id) };
      });
      if (outcome.settled) return outcome.task;
    }
    return null;
  }

  #selectCandidate({ at, runId, workflowName }) {
    return this.database.one(`SELECT wt.id, wt.workflow_run_id FROM workflow_tasks wt
      JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
      WHERE wt.status = 'pending'
        AND wt.attempt_count < 5
        AND (wt.retry_available_at IS NULL OR julianday(wt.retry_available_at) <= julianday(?))
        AND wr.status IN ('queued', 'running')
        AND (CAST(? AS text) IS NULL OR wt.workflow_run_id = ?)
        AND (CAST(? AS text) IS NULL OR wr.workflow_name = ?)
        AND (wr.consent_grant_id IS NULL OR EXISTS (
          SELECT 1 FROM consent_grants cg
          WHERE cg.id = wr.consent_grant_id
            AND cg.revoked_at IS NULL
            AND (cg.expires_at IS NULL OR julianday(cg.expires_at) > julianday(?))
        ))
        AND NOT EXISTS (
          SELECT 1 FROM workflow_task_dependencies dependency
          JOIN workflow_tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
          WHERE dependency.workflow_task_id = wt.id AND prerequisite.status <> 'completed'
        )
      ORDER BY wt.created_at, wt.id LIMIT 1`, [at, runId, runId, workflowName, workflowName, at]);
  }

  // Pending tasks at the attempt cap fail with ATTEMPT_LIMIT, one run per transaction.
  async #failExhaustedTasks({ runId, workflowName, at }) {
    const exhausted = await this.database.many(`SELECT wt.id, wt.workflow_run_id FROM workflow_tasks wt
      JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
      WHERE wt.status = 'pending' AND wt.attempt_count >= 5
        AND wr.status IN ('queued', 'running')
        AND (CAST(? AS text) IS NULL OR wt.workflow_run_id = ?)
        AND (CAST(? AS text) IS NULL OR wr.workflow_name = ?)
      ORDER BY wt.workflow_run_id, wt.id`, [runId, runId, workflowName, workflowName]);
    for (const [taskRunId, taskIds] of groupByRun(exhausted)) {
      await this.database.transaction(async () => {
        const run = await this.#lockRun(taskRunId);
        if (!run || !CLAIMABLE_RUN_STATES.has(run.status)) return;
        let changed = false;
        for (const taskId of taskIds) {
          const failed = await this.database.run(`UPDATE workflow_tasks
            SET status = 'failed', finished_at = ?, terminal_reason = 'ATTEMPT_LIMIT',
                last_error_code = 'ATTEMPT_LIMIT', last_error_message = 'Task attempt limit reached.'
            WHERE id = ? AND status = 'pending' AND attempt_count >= 5`, [at, taskId]);
          if (failed.changes !== 1) continue;
          changed = true;
          await this.blockDescendants(taskId, at, 'UPSTREAM_ATTEMPT_LIMIT');
        }
        if (changed) await this.#refreshRunStatus(taskRunId, at);
      });
    }
  }

  async completeTask(taskId, { output = {}, workerId = null } = {}) {
    const at = this.clock().toISOString();
    const outputJson = serialize(output);
    return this.database.transaction(async () => {
      const task = await this.#lockRunThenTask(taskId);
      if (!task || task.status !== 'running' || (workerId && task.lease_owner !== workerId)) {
        throw new Error('Only the worker holding a running task lease can complete it.');
      }
      const updated = await this.database.run(`UPDATE workflow_tasks
        SET status = 'completed', output_digest = ?, output_json = ?, finished_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, terminal_reason = 'completed'
        WHERE id = ? AND status = 'running' AND (CAST(? AS text) IS NULL OR lease_owner = ?)`,
      [digest(outputJson), outputJson, at, taskId, workerId, workerId]);
      if (updated.changes !== 1) throw new Error('Task lease changed before completion.');
      await this.#refreshRunStatus(task.workflow_run_id, at);
      return this.getTask(taskId);
    });
  }

  async failTask(taskId, { workerId = null, code = 'TASK_FAILED', message = 'Task failed.', retryAt = null } = {}) {
    const at = this.clock().toISOString();
    return this.database.transaction(async () => {
      const task = await this.#lockRunThenTask(taskId);
      if (!task || task.status !== 'running' || (workerId && task.lease_owner !== workerId)) {
        throw new Error('Only the worker holding a running task lease can fail it.');
      }
      const willRetry = task.attempt_count < MAX_ATTEMPTS && retryAt;
      const status = willRetry ? 'pending' : 'failed';
      await this.database.run(`UPDATE workflow_tasks
        SET status = ?, retry_available_at = ?, last_error_code = ?, last_error_message = ?,
            lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, terminal_reason = ?
        WHERE id = ?`, [status, willRetry ? retryAt : null, code, message, willRetry ? null : at, willRetry ? null : code, taskId]);
      if (!willRetry) await this.blockDescendants(taskId, at, `UPSTREAM_${code}`);
      await this.#refreshRunStatus(task.workflow_run_id, at);
      return this.getTask(taskId);
    });
  }

  // Returns the number of leases recovered. Each run is recovered in its own transaction: run lock,
  // then each task re-read FOR UPDATE, so a task completed or re-claimed meanwhile is left alone.
  async recoverExpiredLeases({ at = this.clock().toISOString() } = {}) {
    const expired = await this.database.many(`SELECT id, workflow_run_id FROM workflow_tasks
      WHERE status = 'running' AND julianday(lease_expires_at) <= julianday(?)
      ORDER BY workflow_run_id, id`, [at]);
    let recovered = 0;
    for (const [taskRunId, taskIds] of groupByRun(expired)) {
      recovered += await this.database.transaction(async () => {
        await this.#lockRun(taskRunId);
        let count = 0;
        for (const taskId of taskIds) {
          const task = await this.database.one(`SELECT id, attempt_count FROM workflow_tasks
            WHERE id = ? AND status = 'running' AND julianday(lease_expires_at) <= julianday(?)
            FOR UPDATE`, [taskId, at]);
          if (!task) continue;
          const exhausted = task.attempt_count >= MAX_ATTEMPTS;
          await this.database.run(`UPDATE workflow_tasks
            SET status = ?, lease_owner = NULL, lease_expires_at = NULL, retry_available_at = ?,
                last_error_code = 'LEASE_EXPIRED', last_error_message = 'Worker lease expired.',
                finished_at = ?, terminal_reason = ?
            WHERE id = ? AND status = 'running'`,
          [exhausted ? 'failed' : 'pending', exhausted ? null : at, exhausted ? at : null, exhausted ? 'LEASE_EXPIRED' : null, taskId]);
          if (exhausted) await this.blockDescendants(taskId, at, 'UPSTREAM_LEASE_EXPIRED');
          count += 1;
        }
        if (count > 0) await this.#refreshRunStatus(taskRunId, at);
        return count;
      });
    }
    return recovered;
  }

  /** Settles the run when no task is pending or running. Locks the run (a savepoint when nested). */
  async refreshRunStatus(runId, at = this.clock().toISOString()) {
    await this.database.transaction(async () => {
      await this.#lockRun(runId);
      await this.#refreshRunStatus(runId, at);
    });
  }

  // Caller holds the run lock, so sibling task transitions on this run are serialised and the
  // last one sees every other sibling's committed state.
  async #refreshRunStatus(runId, at) {
    const states = await this.database.many(`SELECT status, count(*) AS count FROM workflow_tasks
      WHERE workflow_run_id = ? GROUP BY status`, [runId]);
    const counts = Object.fromEntries(states.map(row => [row.status, row.count]));
    if ((counts.pending ?? 0) + (counts.running ?? 0) > 0) return;
    const terminal = ['failed', 'blocked', 'revoked', 'cancelled', 'interrupted'].find(status => counts[status]);
    const releaseTask = await this.database.one(`SELECT output_json FROM workflow_tasks
      WHERE workflow_run_id = ? AND task_kind = 'deterministic_release_gate' AND status = 'completed'
      ORDER BY created_at DESC LIMIT 1`, [runId]);
    let releaseBlocked = false;
    if (releaseTask?.output_json) {
      try {
        const output = JSON.parse(releaseTask.output_json);
        releaseBlocked = (output?.payload ?? output)?.status === 'blocked';
      } catch {
        releaseBlocked = true;
      }
    }
    const status = terminal ?? (releaseBlocked ? 'blocked' : 'completed');
    await this.database.run('UPDATE workflow_runs SET status = ?, finished_at = ?, terminal_reason = ? WHERE id = ?',
      [status, at, terminal ?? (releaseBlocked ? 'RELEASE_BLOCKED' : 'completed'), runId]);
  }

  /** Blocks pending descendants of a task. Call inside a transaction that holds the run lock. */
  async blockDescendants(taskId, at, reason) {
    await this.database.run(`WITH RECURSIVE descendants(id) AS (
        SELECT workflow_task_id FROM workflow_task_dependencies WHERE depends_on_task_id = ?
        UNION
        SELECT dependency.workflow_task_id
        FROM workflow_task_dependencies dependency
        JOIN descendants parent ON parent.id = dependency.depends_on_task_id
      )
      UPDATE workflow_tasks
      SET status = 'blocked', finished_at = ?, terminal_reason = ?,
          last_error_code = ?, last_error_message = 'A required upstream task did not complete.'
      WHERE id IN (SELECT id FROM descendants) AND status = 'pending'`, [taskId, at, reason, reason]);
  }

  async getRun(runId) {
    return this.database.one('SELECT * FROM workflow_runs WHERE id = ?', [runId]);
  }

  async getTask(taskId) {
    return this.database.one('SELECT * FROM workflow_tasks WHERE id = ?', [taskId]);
  }

  #lockRun(runId) {
    return this.database.one('SELECT id, status FROM workflow_runs WHERE id = ? FOR UPDATE', [runId]);
  }

  // Lock order: the task's run, then the task. A task never moves between runs.
  async #lockRunThenTask(taskId) {
    const located = await this.database.one('SELECT workflow_run_id FROM workflow_tasks WHERE id = ?', [taskId]);
    if (!located) return null;
    await this.#lockRun(located.workflow_run_id);
    return this.database.one('SELECT * FROM workflow_tasks WHERE id = ? FOR UPDATE', [taskId]);
  }
}

function groupByRun(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.workflow_run_id)) groups.set(row.workflow_run_id, []);
    groups.get(row.workflow_run_id).push(row.id);
  }
  return groups;
}
