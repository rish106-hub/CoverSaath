// P1-A: the retry, timeout, lease and idempotency contracts match the running code.
// PostgreSQL (S3.2 async runtime) and synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { AuditRepository, CaseRepository, WorkflowRepository } from '../src/backend/repositories/index.js';
import {
  COVERAGE_ANALYSIS_WORKFLOW,
  createCoverageAnalysisRuntime,
  createPersistentCoverageAnalysisService,
} from '../src/features/coverage-analysis/index.js';
import { POLICY_PARAMETER_REGISTRY_VERSION } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import {
  FIXTURE_RUNTIME_LIMITS,
  IDEMPOTENCY_KEY_LENGTH,
  IDEMPOTENCY_SCOPES,
  IDEMPOTENCY_TTL_MS,
  MODEL_CALL_POLICY,
  PERSISTED_RUN_STATES,
  PERSISTED_TASK_STATES,
  PERSISTENT_WORKER_LIMITS,
  TASK_LEASE_DURATION_MS,
  TASK_MAX_ATTEMPTS,
  TASK_RETRY_POLICY,
  TASK_STATE_TRANSITIONS,
  assertTaskTransition,
  validateIdempotencyKey,
} from '../src/contracts/execution-policy.js';

const START = Date.parse('2026-10-14T09:00:00.000Z');
const pg = postgresTestOptions();

// Households are seeded with direct SQL: this file exercises the workflow and case repositories.
async function seedHousehold(db, at) {
  await db.run(`INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at)
    VALUES ('adult-p1a', 'Synthetic adult', 'en-IN', 'active', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO households (id, display_name, created_at, updated_at)
    VALUES ('household-p1a', 'Synthetic household', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, starts_at, created_at)
    VALUES ('role-p1a', 'household-p1a', 'adult-p1a', 'owner', 'active', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-p1a', 'household-p1a', 'adult-p1a', 'Synthetic adult', 'adult', ?, ?)`, [at, at]);
}

async function world(t) {
  let now = START;
  const clock = () => new Date(now);
  const { db: database } = await freshDatabase(t, { clock });
  const audit = new AuditRepository(database, { clock });
  const workflows = new WorkflowRepository(database, { clock, audit });
  const cases = new CaseRepository(database, { clock, audit });
  await seedHousehold(database, new Date(now).toISOString());
  await cases.create({ id: 'case-p1a', householdId: 'household-p1a', subjectMemberId: 'member-p1a', openedByAdultId: 'adult-p1a', triggerType: 'renewal' });
  const createRun = id => workflows.createRunWithTasks({
    id, caseId: 'case-p1a', workflowName: 'p1a-policy', workflowVersion: '6', executionMode: 'fixture',
    tasks: [
      { key: 'first', agentName: 'p1a/first', taskKind: 'p1a_first', dependsOn: [], input: { key: 'first' } },
      { key: 'second', agentName: 'p1a/second', taskKind: 'p1a_second', dependsOn: ['first'], input: { key: 'second' } },
    ],
  });
  return {
    database, services: { workflows, cases }, createRun,
    advance(ms) { now += ms; },
    now: () => now,
    task: id => workflows.getTask(id),
  };
}

const transition = (operation, before, after) => assertTaskTransition(operation, before.status, after.status);

test('P1-A policy: the retry policy constants equal the workflow repository defaults', () => {
  assert.equal(new WorkflowRepository(null).leaseDurationMs, TASK_LEASE_DURATION_MS);
  assert.equal(TASK_LEASE_DURATION_MS, 60_000);
  assert.equal(TASK_MAX_ATTEMPTS, 5);
  assert.deepEqual(TASK_RETRY_POLICY, { maxAttempts: 5, leaseDurationMs: 60_000, retryOn: ['LEASE_EXPIRED'], retryDelayMs: 0, thrownErrorIsTerminal: true });
  assert.ok(Object.isFrozen(TASK_RETRY_POLICY) && Object.isFrozen(TASK_RETRY_POLICY.retryOn));
  assert.ok(COVERAGE_ANALYSIS_WORKFLOW.tasks.every(task => task.retryPolicy === TASK_RETRY_POLICY));
});

test('P1-A policy: claim grants a 60 s lease and only the lease holder can complete', pg, async t => {
  const context = await world(t);
  const run = await context.createRun('run-lease');
  const [first] = run.tasks;
  const claimed = await context.services.workflows.claimNext({ workerId: 'worker-a', runId: run.id });
  assert.equal(claimed.id, first.id);
  transition('claimNext', first, claimed);
  assert.equal(claimed.attempt_count, 1);
  assert.equal(claimed.lease_owner, 'worker-a');
  assert.equal(Date.parse(claimed.lease_expires_at) - context.now(), TASK_LEASE_DURATION_MS);
  // The dependent task is not claimable before its prerequisite completes.
  assert.equal(await context.services.workflows.claimNext({ workerId: 'worker-b', runId: run.id }), null);
  await assert.rejects(context.services.workflows.completeTask(first.id, { workerId: 'worker-b', output: {} }), /holding a running task lease/);
  await assert.rejects(context.services.workflows.failTask(first.id, { workerId: 'worker-b' }), /holding a running task lease/);
  await assert.rejects(context.services.workflows.completeTask('task-missing', { output: {} }), /holding a running task lease/);
  assert.equal((await context.task(first.id)).status, 'running', 'a rejected completion changes nothing');
  const completed = await context.services.workflows.completeTask(first.id, { workerId: 'worker-a', output: { ok: true } });
  transition('completeTask', claimed, completed);
  assert.equal(completed.terminal_reason, 'completed');
});

test('P1-A policy: an expired lease is retried until the attempt cap, then fails and blocks descendants', pg, async t => {
  const context = await world(t);
  const run = await context.createRun('run-expiry');
  const [first, second] = run.tasks;
  for (let attempt = 1; attempt <= TASK_MAX_ATTEMPTS; attempt += 1) {
    const claimed = await context.services.workflows.claimNext({ workerId: `worker-${attempt}`, runId: run.id });
    assert.equal(claimed?.id, first.id, `attempt ${attempt} claims the task`);
    assert.equal(claimed.attempt_count, attempt);
    context.advance(TASK_LEASE_DURATION_MS - 1);
    assert.equal(await context.services.workflows.recoverExpiredLeases(), 0, 'lease still valid one millisecond before expiry');
    context.advance(1);
    assert.equal(await context.services.workflows.recoverExpiredLeases(), 1);
    const recovered = await context.task(first.id);
    if (attempt < TASK_MAX_ATTEMPTS) {
      transition('recoverExpiredLeases', claimed, recovered);
      assert.equal(recovered.retry_available_at, new Date(context.now()).toISOString(), 'retried immediately');
      assert.equal(recovered.last_error_code, 'LEASE_EXPIRED');
    } else {
      transition('recoverExpiredLeases.attemptLimit', claimed, recovered);
      assert.equal(recovered.terminal_reason, 'LEASE_EXPIRED');
    }
  }
  const blocked = await context.task(second.id);
  transition('blockDescendants', second, blocked);
  assert.equal(blocked.terminal_reason, 'UPSTREAM_LEASE_EXPIRED');
  assert.equal((await context.services.workflows.getRun(run.id)).status, 'failed');
  assert.equal(await context.services.workflows.claimNext({ workerId: 'worker-late', runId: run.id }), null);
});

test('P1-A policy: a thrown task error is terminal; failTask retries only when retryAt is given', pg, async t => {
  const context = await world(t);
  const run = await context.createRun('run-fail');
  const [first, second] = run.tasks;
  const claimed = await context.services.workflows.claimNext({ workerId: 'worker-a', runId: run.id });
  const failed = await context.services.workflows.failTask(first.id, { workerId: 'worker-a', code: 'AGENT_CONTRACT_INVALID', message: 'synthetic' });
  transition('failTask', claimed, failed);
  assert.equal(failed.terminal_reason, 'AGENT_CONTRACT_INVALID');
  assert.equal((await context.task(second.id)).terminal_reason, 'UPSTREAM_AGENT_CONTRACT_INVALID');
  assert.equal((await context.services.workflows.getRun(run.id)).status, 'failed');

  const retried = await context.createRun('run-retry');
  const retryTask = retried.tasks[0];
  const retryClaim = await context.services.workflows.claimNext({ workerId: 'worker-a', runId: retried.id });
  const pending = await context.services.workflows.failTask(retryTask.id, { workerId: 'worker-a', code: 'TASK_FAILED', retryAt: new Date(context.now() + 5_000).toISOString() });
  transition('failTask.retry', retryClaim, pending);
  assert.equal(await context.services.workflows.claimNext({ workerId: 'worker-a', runId: retried.id }), null, 'not claimable before retryAt');
  context.advance(5_000);
  assert.equal((await context.services.workflows.claimNext({ workerId: 'worker-a', runId: retried.id }))?.attempt_count, 2);
});

test('P1-A policy: a pending task at the attempt cap fails with ATTEMPT_LIMIT on the next claim', pg, async t => {
  const context = await world(t);
  const run = await context.createRun('run-limit');
  const [first, second] = run.tasks;
  await context.database.prepare('UPDATE workflow_tasks SET attempt_count = ? WHERE id = ?').run(TASK_MAX_ATTEMPTS, first.id);
  assert.equal(await context.services.workflows.claimNext({ workerId: 'worker-a', runId: run.id }), null);
  const failed = await context.task(first.id);
  transition('claimNext.attemptLimit', first, failed);
  assert.equal(failed.terminal_reason, 'ATTEMPT_LIMIT');
  assert.equal((await context.task(second.id)).terminal_reason, 'UPSTREAM_ATTEMPT_LIMIT');
  assert.equal((await context.services.workflows.getRun(run.id)).status, 'failed');
});

test('P1-A policy: undocumented task transitions are rejected', () => {
  assert.throws(() => assertTaskTransition('completeTask', 'pending', 'completed'), { code: 'TASK_TRANSITION_INVALID' });
  assert.throws(() => assertTaskTransition('claimNext', 'failed', 'running'), { code: 'TASK_TRANSITION_INVALID' });
  for (const rule of TASK_STATE_TRANSITIONS) {
    assert.ok(PERSISTED_TASK_STATES.includes(rule.from) && PERSISTED_TASK_STATES.includes(rule.to), rule.operation);
  }
});

test('P1-A policy: persisted run and task states equal the migration CHECK constraints', () => {
  const sql = readFileSync(new URL('../src/backend/database/postgres/migrations/001_baseline_schema.sql', import.meta.url), 'utf8');
  const statesOf = table => {
    const block = sql.slice(sql.indexOf(`CREATE TABLE ${table} (`));
    const match = block.match(/status text NOT NULL CHECK \(status IN \(([^)]*)\)\)/);
    return match[1].split(',').map(value => value.trim().replace(/'/g, ''));
  };
  assert.deepEqual(statesOf('workflow_runs'), [...PERSISTED_RUN_STATES]);
  assert.deepEqual(statesOf('workflow_tasks'), [...PERSISTED_TASK_STATES]);
});

test('P1-A policy: workflow_task idempotency keys live 24 h and conflict on a changed request', pg, async t => {
  const context = await world(t);
  const run = await context.createRun('run-idempotent');
  const request = { runId: run.id, agentName: 'p1a/extra', taskKind: 'p1a_extra', input: { n: 1 }, idempotencyKey: 'p1a-idempotent-1' };
  const first = await context.services.workflows.enqueueTask(request);
  assert.equal((await context.services.workflows.enqueueTask(request)).id, first.id);
  await assert.rejects(context.services.workflows.enqueueTask({ ...request, input: { n: 2 } }), { code: 'IDEMPOTENCY_CONFLICT' });
  const row = await context.database.prepare("SELECT expires_at, created_at, response_status FROM idempotency_keys WHERE scope = 'workflow_task' AND idempotency_key = ?").get(request.idempotencyKey);
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), IDEMPOTENCY_TTL_MS);
  assert.equal(row.response_status, IDEMPOTENCY_SCOPES.workflow_task.createdStatus);
  context.advance(IDEMPOTENCY_TTL_MS);
  assert.notEqual((await context.services.workflows.enqueueTask({ ...request, input: { n: 2 } })).id, first.id, 'an expired key is reused for a new request');
});

test('P1-A policy: analysis_run idempotency digests exactly the documented fields with a 24 h expiry', async () => {
  const now = new Date(START);
  const caseRecord = { id: 'case-digest', status: 'processing', revision: '2026-10-14T08:00:00.000Z', trigger_type: 'renewal', household_id: 'household-digest', analysis_subject_member_id: 'member-digest' };
  const recorded = [];
  const stub = existing => ({
    getCase: async () => caseRecord, requireCoverageConsent: async () => ({}), findIdempotency: async () => existing,
    recordIdempotency: async input => { recorded.push(input); }, createRunWithParameters: async () => null,
    verifyRunSourcesCurrent: async () => ({ allowed: true }), getCoverageSourcePages: async () => [], loadKnownIdentifiers: async () => [],
    getJob: async runId => ({ id: runId, status: 'queued' }), getTask: async () => null, claimNext: async () => null, dependencyOutputs: async () => ({}),
    completeTask: async () => null, failTask: async () => null, recoverExpiredLeases: async () => 0, isConsentActive: async () => true,
    stopForRevocation: async () => null, persistTaskArtifact: async () => null, recordModelObservations: async () => null,
  });
  const request = {
    caseId: caseRecord.id, caseRevision: caseRecord.revision, consentGrantId: 'consent-digest', executionMode: 'fixture', fixtureVariant: 'standard',
    modelPermission: false, parameterRegistryVersion: POLICY_PARAMETER_REGISTRY_VERSION, workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version,
  };
  assert.deepEqual(Object.keys(request).sort(), [...IDEMPOTENCY_SCOPES.analysis_run.digestFields]);
  const digest = value => createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort())).digest('hex');
  const call = port => createPersistentCoverageAnalysisService({ port, clock: () => now })
    .createAnalysisRun({ caseId: caseRecord.id, consentGrantId: 'consent-digest', idempotencyKey: 'p1a-digest-key' });
  const replay = await call(stub({ request_digest: digest(request), response_json: JSON.stringify({ runId: 'run-existing' }) }));
  assert.deepEqual(replay, { created: false, job: { id: 'run-existing', status: 'queued' } });
  // The same key against workflow version 5 (as stored before v6) is a conflict, never a replay.
  await assert.rejects(call(stub({ request_digest: digest({ ...request, workflowVersion: '5' }), response_json: '{}' })), { code: 'IDEMPOTENCY_CONFLICT' });
  const created = await call(stub(null));
  assert.equal(created.created, true);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].scope, 'analysis_run');
  assert.equal(recorded[0].requestDigest, digest(request));
  assert.equal(recorded[0].responseStatus, IDEMPOTENCY_SCOPES.analysis_run.createdStatus);
  assert.equal(Date.parse(recorded[0].expiresAt) - now.getTime(), IDEMPOTENCY_SCOPES.analysis_run.ttlMs);
});

test('P1-A policy: idempotency key bounds match the route', () => {
  assert.deepEqual(IDEMPOTENCY_KEY_LENGTH, { min: 8, max: 200 });
  assert.equal(validateIdempotencyKey('a'.repeat(8)), 'a'.repeat(8));
  assert.equal(validateIdempotencyKey('a'.repeat(200)), 'a'.repeat(200));
  for (const key of ['a'.repeat(7), 'a'.repeat(201), undefined, 12345678]) {
    assert.throws(() => validateIdempotencyKey(key), { code: 'IDEMPOTENCY_KEY_REQUIRED', statusCode: 400 });
  }
  const routes = readFileSync(new URL('../src/server/routes/v1-backend-routes.js', import.meta.url), 'utf8');
  assert.match(routes, /key\.length < 8 \|\| key\.length > 200/);
});

test('P1-A policy: persistent worker and fixture runtime bounds match the services', async () => {
  const methods = ['getCase', 'requireCoverageConsent', 'findIdempotency', 'recordIdempotency', 'createRunWithParameters', 'verifyRunSourcesCurrent',
    'getCoverageSourcePages', 'loadKnownIdentifiers', 'getJob', 'getTask', 'claimNext', 'dependencyOutputs', 'completeTask', 'failTask',
    'recoverExpiredLeases', 'isConsentActive', 'stopForRevocation', 'persistTaskArtifact', 'recordModelObservations'];
  const port = Object.fromEntries(methods.map(method => [method, async () => null]));
  const { maxConcurrency, maxTasksPerSettle } = PERSISTENT_WORKER_LIMITS;
  for (const value of [maxConcurrency.min, maxConcurrency.default, maxConcurrency.max]) assert.doesNotThrow(() => createPersistentCoverageAnalysisService({ port, maxConcurrency: value }));
  for (const value of [maxConcurrency.min - 1, maxConcurrency.max + 1]) assert.throws(() => createPersistentCoverageAnalysisService({ port, maxConcurrency: value }), /between 1 and 8/);
  const service = createPersistentCoverageAnalysisService({ port });
  for (const value of [maxTasksPerSettle.min - 1, maxTasksPerSettle.max + 1]) await assert.rejects(service.runUntilSettled('run-x', { maxTasks: value }), /between 1 and 100/);
  assert.equal(await service.runUntilSettled('run-x', { maxTasks: maxTasksPerSettle.max }), null);
  const persistent = readFileSync(new URL('../src/features/coverage-analysis/persistent-service.js', import.meta.url), 'utf8');
  assert.match(persistent, /maxConcurrency = 4,/);
  assert.match(persistent, /\{ maxTasks = 30 \}/);
  const runtime = readFileSync(new URL('../src/features/coverage-analysis/runtime.js', import.meta.url), 'utf8');
  assert.match(runtime, new RegExp(`task\\.attempts < ${FIXTURE_RUNTIME_LIMITS.maxAttempts} \\? 'pending' : 'blocked'`));
  assert.match(runtime, new RegExp(`\\{ maxTicks = ${FIXTURE_RUNTIME_LIMITS.maxTicks.default} \\}`));
  const store = { createRun: async run => run, loadRun: async () => null, replaceRun: async run => run };
  const fixture = createCoverageAnalysisRuntime({ port: store });
  await assert.rejects(fixture.runUntilSettled('run-x', { maxTicks: FIXTURE_RUNTIME_LIMITS.maxTicks.max + 1 }), /between 1 and 100/);
});

test('P1-A policy: model call timeout and retry limits match the live runtime and gateway', () => {
  const live = readFileSync(new URL('../src/features/ai-analysis/live-coverage-runtime.js', import.meta.url), 'utf8');
  assert.match(live, /LLM_TIMEOUT_MS \?\? 30_000, 'LLM_TIMEOUT_MS', \{ max: 60_000, integer: true \}/);
  assert.match(live, /maxRetries: 0/);
  const gateway = readFileSync(new URL('../src/features/ai-analysis/model-gateway.js', import.meta.url), 'utf8');
  assert.match(gateway, /timeoutMs: 30_000, maxRetries: 0/);
  assert.deepEqual(MODEL_CALL_POLICY, { defaultTimeoutMs: 30_000, maxTimeoutMs: 60_000, maxRetries: 0 });
  // A model call may run as long as one task lease. Recorded as a risk in ADR 0001.
  assert.ok(MODEL_CALL_POLICY.maxTimeoutMs <= TASK_LEASE_DURATION_MS);
});
