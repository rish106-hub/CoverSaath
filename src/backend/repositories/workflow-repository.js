import { createHash, randomUUID } from 'node:crypto';
import { jsonParam } from '../database/value-codec.js';

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

// Concurrency contract (Postgres, many workers):
//   - Lock order is always: workflow_runs row first, then workflow_tasks rows. Claims take both with
//     FOR UPDATE ... SKIP LOCKED, so a claim never waits on a run that another worker is settling.
//   - Run status is derived from its tasks while the run row is locked, so two tasks finishing together
//     cannot both observe the other as still running.
//   - Same-key task enqueues are serialised by a transaction-scoped advisory lock; the primary key backs it up.
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
    await this.database.query(`INSERT INTO workflow_runs
      (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
       case_revision, consent_grant_id, input_json, created_at)
      VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, $8, $9, $10)`,
    [runId, caseId, workflowName, workflowVersion, executionMode, digest(inputJson), caseRevision, consentGrantId, inputJson, at]);
    return this.getRun(runId);
  }

  async createRunWithTasks({ tasks = [], ...runInput }) {
    const runId = await this.database.transaction(async () => {
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
      return { id: run.id, tasks: [...tasksByKey.values()] };
    });
    return { ...(await this.getRun(runId.id)), tasks: runId.tasks };
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
    return this.database.transaction(async tx => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`idempotency:workflow_task:${idempotencyKey}`]);
      await tx.query(`DELETE FROM idempotency_keys
        WHERE scope = 'workflow_task' AND idempotency_key = $1 AND expires_at <= $2`, [idempotencyKey, at]);
      const existing = await tx.one('SELECT * FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2', ['workflow_task', idempotencyKey]);
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          const error = new Error('Idempotency key was reused with a different request.');
          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return JSON.parse(existing.response_json);
      }
      const task = await this.insertTask({ taskId, runId, agentName, taskKind, input, parentTaskId, dependencyTaskIds: dependencies, at });
      await tx.query(`INSERT INTO idempotency_keys
        (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
        VALUES ('workflow_task', $1, $2, 201, $3, $4, $5)`,
      [idempotencyKey, requestDigest, jsonParam(task), expiry, at]);
      return task;
    });
  }

  async insertTask({
    id: suppliedId, taskId: suppliedTaskId, runId, agentName, taskKind, input = {}, parentTaskId = null,
    dependencyTaskIds = [], at = this.clock().toISOString(),
  }) {
    const taskId = suppliedTaskId ?? suppliedId ?? id('task');
    const dependencies = [...new Set([parentTaskId, ...dependencyTaskIds].filter(Boolean))];
    const inputJson = serialize(input);
    await this.database.transaction(async tx => {
      await tx.query(`INSERT INTO workflow_tasks
        (id, workflow_run_id, parent_task_id, agent_name, task_kind, status, input_digest, input_json, created_at)
        VALUES ($1, $2, $3, $4, $5, 'pending', $6, $7, $8)`,
      [taskId, runId, parentTaskId ?? dependencies[0] ?? null, agentName, taskKind, digest(inputJson), inputJson, at]);
      for (const dependencyId of dependencies) {
        await tx.query(`INSERT INTO workflow_task_dependencies
          (workflow_task_id, depends_on_task_id, created_at) VALUES ($1, $2, $3)`, [taskId, dependencyId, at]);
      }
    });
    return this.getTask(taskId);
  }

  /** Claims one runnable task. Safe for any number of concurrent workers and instances. */
  async claimNext({
    workerId = 'local-worker',
    leaseDurationMs = this.leaseDurationMs,
    runId = null,
    workflowName = null,
  } = {}) {
    const now = this.clock();
    const at = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    const taskId = await this.database.transaction(async tx => {
      const exhausted = await tx.query(`SELECT wt.id, wt.workflow_run_id FROM workflow_tasks wt
        JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
        WHERE wt.status = 'pending' AND wt.attempt_count >= 5
          AND wr.status IN ('queued', 'running')
          AND ($1::text IS NULL OR wt.workflow_run_id = $1)
          AND ($2::text IS NULL OR wr.workflow_name = $2)
        ORDER BY wt.workflow_run_id, wt.id
        FOR UPDATE OF wr, wt SKIP LOCKED`, [runId, workflowName]);
      for (const task of exhausted) {
        await tx.query(`UPDATE workflow_tasks
          SET status = 'failed', finished_at = $1, terminal_reason = 'ATTEMPT_LIMIT',
              last_error_code = 'ATTEMPT_LIMIT', last_error_message = 'Task attempt limit reached.'
          WHERE id = $2 AND status = 'pending'`, [at, task.id]);
        await this.blockDescendants(task.id, at, 'UPSTREAM_ATTEMPT_LIMIT');
        await this.refreshRunStatus(task.workflow_run_id, at);
      }
      const task = await tx.one(`SELECT wt.id, wt.workflow_run_id FROM workflow_tasks wt
        JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
        WHERE wt.status = 'pending'
          AND wt.attempt_count < 5
          AND (wt.retry_available_at IS NULL OR wt.retry_available_at <= $1::timestamptz)
          AND wr.status IN ('queued', 'running')
          AND ($2::text IS NULL OR wt.workflow_run_id = $2)
          AND ($3::text IS NULL OR wr.workflow_name = $3)
          AND (wr.consent_grant_id IS NULL OR EXISTS (
            SELECT 1 FROM consent_grants cg
            WHERE cg.id = wr.consent_grant_id
              AND cg.revoked_at IS NULL
              AND (cg.expires_at IS NULL OR cg.expires_at > $1::timestamptz)
          ))
          AND NOT EXISTS (
            SELECT 1 FROM workflow_task_dependencies dependency
            JOIN workflow_tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
            WHERE dependency.workflow_task_id = wt.id AND prerequisite.status <> 'completed'
          )
        ORDER BY wt.created_at, wt.id LIMIT 1
        FOR UPDATE OF wr, wt SKIP LOCKED`, [at, runId, workflowName]);
      if (!task) return null;
      const claimed = await tx.run(`UPDATE workflow_tasks
        SET status = 'running', attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, $1::timestamptz), lease_owner = $2, lease_expires_at = $3,
            retry_available_at = NULL, last_error_code = NULL, last_error_message = NULL
        WHERE id = $4 AND status = 'pending' AND attempt_count < 5`, [at, workerId, leaseExpiresAt, task.id]);
      if (claimed.rowCount !== 1) return null;
      await tx.query(`UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, $1::timestamptz)
        WHERE id = $2 AND status IN ('queued', 'running')`, [at, task.workflow_run_id]);
      await tx.query(`INSERT INTO workflow_events
        (workflow_run_id, workflow_task_id, event_type, event_payload_json, occurred_at)
        VALUES ($1, $2, 'task.claimed', $3, $4)`,
      [task.workflow_run_id, task.id, jsonParam({ workerId, leaseExpiresAt }), at]);
      return task.id;
    });
    return taskId ? this.getTask(taskId) : null;
  }

  /** Locks the run, then the task, in the contract's order. Returns the locked task row or null. */
  async lockRunAndTask(tx, taskId) {
    const located = await tx.one('SELECT workflow_run_id FROM workflow_tasks WHERE id = $1', [taskId]);
    if (!located) return null;
    await tx.query('SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE', [located.workflow_run_id]);
    return tx.one('SELECT * FROM workflow_tasks WHERE id = $1 FOR UPDATE', [taskId]);
  }

  async completeTask(taskId, { output = {}, workerId = null } = {}) {
    const at = this.clock().toISOString();
    const outputJson = serialize(output);
    await this.database.transaction(async tx => {
      const task = await this.lockRunAndTask(tx, taskId);
      if (!task || task.status !== 'running' || (workerId && task.lease_owner !== workerId)) {
        throw new Error('Only the worker holding a running task lease can complete it.');
      }
      const updated = await tx.run(`UPDATE workflow_tasks
        SET status = 'completed', output_digest = $1, output_json = $2, finished_at = $3,
            lease_owner = NULL, lease_expires_at = NULL, terminal_reason = 'completed'
        WHERE id = $4 AND status = 'running' AND ($5::text IS NULL OR lease_owner = $5)`,
      [digest(outputJson), outputJson, at, taskId, workerId]);
      if (updated.rowCount !== 1) throw new Error('Task lease changed before completion.');
      await this.refreshRunStatus(task.workflow_run_id, at);
    });
    return this.getTask(taskId);
  }

  async failTask(taskId, { workerId = null, code = 'TASK_FAILED', message = 'Task failed.', retryAt = null } = {}) {
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      const task = await this.lockRunAndTask(tx, taskId);
      if (!task || task.status !== 'running' || (workerId && task.lease_owner !== workerId)) {
        throw new Error('Only the worker holding a running task lease can fail it.');
      }
      const willRetry = task.attempt_count < 5 && retryAt;
      const status = willRetry ? 'pending' : 'failed';
      await tx.query(`UPDATE workflow_tasks
        SET status = $1, retry_available_at = $2, last_error_code = $3, last_error_message = $4,
            lease_owner = NULL, lease_expires_at = NULL, finished_at = $5, terminal_reason = $6
        WHERE id = $7`, [status, willRetry ? retryAt : null, code, message, willRetry ? null : at, willRetry ? null : code, taskId]);
      if (!willRetry) await this.blockDescendants(taskId, at, `UPSTREAM_${code}`);
      await this.refreshRunStatus(task.workflow_run_id, at);
    });
    return this.getTask(taskId);
  }

  async recoverExpiredLeases({ at = this.clock().toISOString() } = {}) {
    return this.database.transaction(async tx => {
      const expired = await tx.query(`SELECT id, workflow_run_id, attempt_count FROM workflow_tasks
        WHERE status = 'running' AND lease_expires_at <= $1::timestamptz
        ORDER BY workflow_run_id, id`, [at]);
      let recovered = 0;
      for (const candidate of expired) {
        await tx.query('SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE', [candidate.workflow_run_id]);
        const task = await tx.one(`SELECT id, workflow_run_id, attempt_count FROM workflow_tasks
          WHERE id = $1 AND status = 'running' AND lease_expires_at <= $2::timestamptz FOR UPDATE`, [candidate.id, at]);
        if (!task) continue;
        const exhausted = task.attempt_count >= 5;
        await tx.query(`UPDATE workflow_tasks
          SET status = $1, lease_owner = NULL, lease_expires_at = NULL, retry_available_at = $2,
              last_error_code = 'LEASE_EXPIRED', last_error_message = 'Worker lease expired.',
              finished_at = $3, terminal_reason = $4
          WHERE id = $5`, [exhausted ? 'failed' : 'pending', exhausted ? null : at, exhausted ? at : null, exhausted ? 'LEASE_EXPIRED' : null, task.id]);
        if (exhausted) await this.blockDescendants(task.id, at, 'UPSTREAM_LEASE_EXPIRED');
        await this.refreshRunStatus(task.workflow_run_id, at);
        recovered += 1;
      }
      return recovered;
    });
  }

  async refreshRunStatus(runId, at = this.clock().toISOString()) {
    const states = await this.database.query(`SELECT status, count(*) AS count FROM workflow_tasks
      WHERE workflow_run_id = $1 GROUP BY status`, [runId]);
    const counts = Object.fromEntries(states.map(row => [row.status, row.count]));
    if ((counts.pending ?? 0) + (counts.running ?? 0) > 0) return;
    const terminal = ['failed', 'blocked', 'revoked', 'cancelled', 'interrupted'].find(status => counts[status]);
    const releaseTask = await this.database.one(`SELECT output_json FROM workflow_tasks
      WHERE workflow_run_id = $1 AND task_kind = 'deterministic_release_gate' AND status = 'completed'
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
    await this.database.query('UPDATE workflow_runs SET status = $1, finished_at = $2, terminal_reason = $3 WHERE id = $4',
      [status, at, terminal ?? (releaseBlocked ? 'RELEASE_BLOCKED' : 'completed'), runId]);
  }

  async blockDescendants(taskId, at, reason) {
    await this.database.query(`WITH RECURSIVE descendants(id) AS (
        SELECT workflow_task_id FROM workflow_task_dependencies WHERE depends_on_task_id = $1
        UNION
        SELECT dependency.workflow_task_id
        FROM workflow_task_dependencies dependency
        JOIN descendants parent ON parent.id = dependency.depends_on_task_id
      )
      UPDATE workflow_tasks
      SET status = 'blocked', finished_at = $2, terminal_reason = $3,
          last_error_code = $3, last_error_message = 'A required upstream task did not complete.'
      WHERE id IN (SELECT id FROM descendants) AND status = 'pending'`, [taskId, at, reason]);
  }

  getRun(runId) {
    return this.database.one('SELECT * FROM workflow_runs WHERE id = $1', [runId]);
  }

  getTask(taskId) {
    return this.database.one('SELECT * FROM workflow_tasks WHERE id = $1', [taskId]);
  }
}
