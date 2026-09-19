import { createHash, randomUUID } from 'node:crypto';

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

export class WorkflowRepository {
  constructor(database, { clock = () => new Date(), audit, leaseDurationMs = 60_000 } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.leaseDurationMs = leaseDurationMs;
  }

  createRun({
    id: runId = id('run'), caseId, workflowName, workflowVersion = 'v1', executionMode = 'live',
    caseRevision = null, consentGrantId = null, input = {},
  }) {
    const at = this.clock().toISOString();
    const inputJson = serialize(input);
    this.database.prepare(`INSERT INTO workflow_runs
      (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
       case_revision, consent_grant_id, input_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`)
      .run(runId, caseId, workflowName, workflowVersion, executionMode, digest(inputJson), caseRevision, consentGrantId, inputJson, at);
    return this.getRun(runId);
  }

  createRunWithTasks({ tasks = [], ...runInput }) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const run = this.createRun(runInput);
      const tasksByKey = new Map();
      for (const definition of tasks) {
        const dependencyTaskIds = (definition.dependsOn ?? []).map(key => {
          const task = tasksByKey.get(key);
          if (!task) throw new Error(`Workflow dependency is not defined before use: ${key}`);
          return task.id;
        });
        const task = this.insertTask({
          ...definition,
          runId: run.id,
          dependencyTaskIds,
          at: this.clock().toISOString(),
        });
        tasksByKey.set(definition.key, task);
      }
      this.database.exec('COMMIT');
      return { ...this.getRun(run.id), tasks: [...tasksByKey.values()] };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  enqueueTask({
    id: taskId = id('task'), runId, agentName, taskKind, input = {}, parentTaskId = null,
    dependencyTaskIds = [], idempotencyKey, expiresAt,
  }) {
    if (!idempotencyKey) throw new Error('Task idempotency key is required.');
    const at = this.clock().toISOString();
    const dependencies = [...new Set([parentTaskId, ...dependencyTaskIds].filter(Boolean))];
    const requestDigest = digest({ runId, agentName, taskKind, input, dependencies });
    const expiry = expiresAt ?? new Date(this.clock().getTime() + 24 * 60 * 60 * 1000).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`DELETE FROM idempotency_keys
        WHERE scope = 'workflow_task' AND idempotency_key = ?
          AND julianday(expires_at) <= julianday(?)`).run(idempotencyKey, at);
      const existing = this.database.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?').get('workflow_task', idempotencyKey);
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          const error = new Error('Idempotency key was reused with a different request.');
          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        this.database.exec('COMMIT');
        return JSON.parse(existing.response_json);
      }
      const task = this.insertTask({ taskId, runId, agentName, taskKind, input, parentTaskId, dependencyTaskIds: dependencies, at });
      this.database.prepare(`INSERT INTO idempotency_keys
        (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
        VALUES ('workflow_task', ?, ?, 201, ?, ?, ?)`)
        .run(idempotencyKey, requestDigest, JSON.stringify(task), expiry, at);
      this.database.exec('COMMIT');
      return task;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  insertTask({
    id: suppliedId, taskId: suppliedTaskId, runId, agentName, taskKind, input = {}, parentTaskId = null,
    dependencyTaskIds = [], at = this.clock().toISOString(),
  }) {
    const taskId = suppliedTaskId ?? suppliedId ?? id('task');
    const dependencies = [...new Set([parentTaskId, ...dependencyTaskIds].filter(Boolean))];
    const inputJson = serialize(input);
    this.database.prepare(`INSERT INTO workflow_tasks
      (id, workflow_run_id, parent_task_id, agent_name, task_kind, status, input_digest, input_json, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`)
      .run(taskId, runId, parentTaskId ?? dependencies[0] ?? null, agentName, taskKind, digest(inputJson), inputJson, at);
    const insertDependency = this.database.prepare(`INSERT INTO workflow_task_dependencies
      (workflow_task_id, depends_on_task_id, created_at) VALUES (?, ?, ?)`);
    for (const dependencyId of dependencies) insertDependency.run(taskId, dependencyId, at);
    return this.getTask(taskId);
  }

  claimNext({ workerId = 'local-worker', leaseDurationMs = this.leaseDurationMs } = {}) {
    const now = this.clock();
    const at = now.toISOString();
    const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs).toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const exhausted = this.database.prepare(`SELECT wt.id, wt.workflow_run_id FROM workflow_tasks wt
        JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
        WHERE wt.status = 'pending' AND wt.attempt_count >= 5
          AND wr.status IN ('queued', 'running')`).all();
      for (const task of exhausted) {
        this.database.prepare(`UPDATE workflow_tasks
          SET status = 'failed', finished_at = ?, terminal_reason = 'ATTEMPT_LIMIT',
              last_error_code = 'ATTEMPT_LIMIT', last_error_message = 'Task attempt limit reached.'
          WHERE id = ? AND status = 'pending'`).run(at, task.id);
        this.blockDescendants(task.id, at, 'UPSTREAM_ATTEMPT_LIMIT');
        this.refreshRunStatus(task.workflow_run_id, at);
      }
      const task = this.database.prepare(`SELECT wt.* FROM workflow_tasks wt
        JOIN workflow_runs wr ON wr.id = wt.workflow_run_id
        WHERE wt.status = 'pending'
          AND wt.attempt_count < 5
          AND (wt.retry_available_at IS NULL OR julianday(wt.retry_available_at) <= julianday(?))
          AND wr.status IN ('queued', 'running')
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
        ORDER BY wt.created_at, wt.id LIMIT 1`).get(at, at);
      if (!task) {
        this.database.exec('COMMIT');
        return null;
      }
      const claimed = this.database.prepare(`UPDATE workflow_tasks
        SET status = 'running', attempt_count = attempt_count + 1,
            started_at = COALESCE(started_at, ?), lease_owner = ?, lease_expires_at = ?,
            retry_available_at = NULL, last_error_code = NULL, last_error_message = NULL
        WHERE id = ? AND status = 'pending' AND attempt_count < 5`).run(at, workerId, leaseExpiresAt, task.id);
      if (claimed.changes !== 1) {
        this.database.exec('ROLLBACK');
        return null;
      }
      this.database.prepare(`UPDATE workflow_runs SET status = 'running', started_at = COALESCE(started_at, ?)
        WHERE id = ? AND status IN ('queued', 'running')`).run(at, task.workflow_run_id);
      this.database.prepare(`INSERT INTO workflow_events
        (workflow_run_id, workflow_task_id, event_type, event_payload_json, occurred_at)
        VALUES (?, ?, 'task.claimed', ?, ?)`)
        .run(task.workflow_run_id, task.id, JSON.stringify({ workerId, leaseExpiresAt }), at);
      this.database.exec('COMMIT');
      return this.getTask(task.id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  completeTask(taskId, { output = {}, workerId = null } = {}) {
    const at = this.clock().toISOString();
    const outputJson = serialize(output);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId);
      if (!task || task.status !== 'running' || (workerId && task.lease_owner !== workerId)) {
        throw new Error('Only the worker holding a running task lease can complete it.');
      }
      const updated = this.database.prepare(`UPDATE workflow_tasks
        SET status = 'completed', output_digest = ?, output_json = ?, finished_at = ?,
            lease_owner = NULL, lease_expires_at = NULL, terminal_reason = 'completed'
        WHERE id = ? AND status = 'running' AND (? IS NULL OR lease_owner = ?)`)
        .run(digest(outputJson), outputJson, at, taskId, workerId, workerId);
      if (updated.changes !== 1) throw new Error('Task lease changed before completion.');
      this.refreshRunStatus(task.workflow_run_id, at);
      this.database.exec('COMMIT');
      return this.getTask(taskId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  failTask(taskId, { workerId = null, code = 'TASK_FAILED', message = 'Task failed.', retryAt = null } = {}) {
    const at = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const task = this.getTask(taskId);
      if (!task || task.status !== 'running' || (workerId && task.lease_owner !== workerId)) {
        throw new Error('Only the worker holding a running task lease can fail it.');
      }
      const willRetry = task.attempt_count < 5 && retryAt;
      const status = willRetry ? 'pending' : 'failed';
      this.database.prepare(`UPDATE workflow_tasks
        SET status = ?, retry_available_at = ?, last_error_code = ?, last_error_message = ?,
            lease_owner = NULL, lease_expires_at = NULL, finished_at = ?, terminal_reason = ?
        WHERE id = ?`).run(status, willRetry ? retryAt : null, code, message, willRetry ? null : at, willRetry ? null : code, taskId);
      if (!willRetry) this.blockDescendants(taskId, at, `UPSTREAM_${code}`);
      this.refreshRunStatus(task.workflow_run_id, at);
      this.database.exec('COMMIT');
      return this.getTask(taskId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recoverExpiredLeases({ at = this.clock().toISOString() } = {}) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const expired = this.database.prepare(`SELECT id, workflow_run_id, attempt_count FROM workflow_tasks
        WHERE status = 'running' AND julianday(lease_expires_at) <= julianday(?)`).all(at);
      for (const task of expired) {
        const exhausted = task.attempt_count >= 5;
        this.database.prepare(`UPDATE workflow_tasks
          SET status = ?, lease_owner = NULL, lease_expires_at = NULL, retry_available_at = ?,
              last_error_code = 'LEASE_EXPIRED', last_error_message = 'Worker lease expired.',
              finished_at = ?, terminal_reason = ?
          WHERE id = ? AND status = 'running'`)
          .run(exhausted ? 'failed' : 'pending', exhausted ? null : at, exhausted ? at : null, exhausted ? 'LEASE_EXPIRED' : null, task.id);
        if (exhausted) this.blockDescendants(task.id, at, 'UPSTREAM_LEASE_EXPIRED');
        this.refreshRunStatus(task.workflow_run_id, at);
      }
      this.database.exec('COMMIT');
      return expired.length;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  refreshRunStatus(runId, at = this.clock().toISOString()) {
    const states = this.database.prepare(`SELECT status, count(*) AS count FROM workflow_tasks
      WHERE workflow_run_id = ? GROUP BY status`).all(runId);
    const counts = Object.fromEntries(states.map(row => [row.status, row.count]));
    if ((counts.pending ?? 0) + (counts.running ?? 0) > 0) return;
    const terminal = ['failed', 'blocked', 'revoked', 'cancelled', 'interrupted'].find(status => counts[status]);
    const status = terminal ?? 'completed';
    this.database.prepare(`UPDATE workflow_runs SET status = ?, finished_at = ?, terminal_reason = ? WHERE id = ?`)
      .run(status, at, terminal ?? 'completed', runId);
  }

  blockDescendants(taskId, at, reason) {
    this.database.prepare(`WITH RECURSIVE descendants(id) AS (
        SELECT workflow_task_id FROM workflow_task_dependencies WHERE depends_on_task_id = ?
        UNION
        SELECT dependency.workflow_task_id
        FROM workflow_task_dependencies dependency
        JOIN descendants parent ON parent.id = dependency.depends_on_task_id
      )
      UPDATE workflow_tasks
      SET status = 'blocked', finished_at = ?, terminal_reason = ?,
          last_error_code = ?, last_error_message = 'A required upstream task did not complete.'
      WHERE id IN (SELECT id FROM descendants) AND status = 'pending'`)
      .run(taskId, at, reason, reason);
  }

  getRun(runId) {
    return this.database.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) ?? null;
  }

  getTask(taskId) {
    return this.database.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(taskId) ?? null;
  }
}
