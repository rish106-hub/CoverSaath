import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatabase, createDatabaseFromEnv, toMicroUsd, fromMicroUsd, jsonParam } from '../src/backend/database/index.js';
import { AuditRepository, WorkflowRepository } from '../src/backend/repositories/index.js';
import { PolicyRecordRepository } from '../src/backend/repositories/policy-record-repository.js';
import { createTestDatabase, sql } from './helpers/test-database.js';

// These run on PGlite by default. PGlite has a single connection, so the concurrency tests below pass
// trivially there; set TEST_DATABASE_URL (Postgres 16) to run them across real pooled connections.

const at = '2026-09-18T10:00:00.000Z';

async function seedCase(database) {
  await sql.run(database, 'INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'h-1', 'H', at, at);
  await sql.run(database, "INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)", 'a-1', 'A', at, at);
  await sql.run(database, "INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES ('r-1', ?, ?, 'owner', 'active', ?)", 'h-1', 'a-1', at);
  await sql.run(database, "INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES ('m-1', ?, ?, 'A', 'adult', ?, ?)", 'h-1', 'a-1', at, at);
  await sql.run(database, "INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at) VALUES ('c-1', ?, 'm-1', ?, 'renewal', 'processing', ?, ?)", 'h-1', 'a-1', at, at);
  return 'c-1';
}

test('type parsers: timestamptz is an ISO string, jsonb is raw JSON text, int8 is a Number', async t => {
  const database = await createDatabase({ pglite: true });
  t.after(() => database.close());
  const row = await database.one(`SELECT '2026-09-18 10:00:00.123+05:30'::timestamptz AS ts, '{"b":1,"a":[2]}'::jsonb AS doc,
    9007199254740993::bigint AS unsafe, 42::bigint AS safe, count(*) AS total FROM (VALUES (1), (2)) v`);
  assert.equal(row.ts, new Date('2026-09-18T10:00:00.123+05:30').toISOString());
  assert.equal(typeof row.doc, 'string');
  assert.deepEqual(JSON.parse(row.doc), { b: 1, a: [2] });
  assert.equal(row.safe, 42);
  assert.equal(row.total, 2);
  assert.equal(row.unsafe, '9007199254740993');
  const echoed = await database.one('SELECT $1::jsonb AS doc, $2::timestamptz AS ts', [jsonParam({ x: 'a\u0000b' }), at]);
  assert.deepEqual(JSON.parse(echoed.doc), { x: 'ab' });
  assert.equal(echoed.ts, at);
});

test('USD is stored as integer micro-USD and read back as the same USD number', () => {
  assert.equal(toMicroUsd(0.123456), 123456);
  assert.equal(fromMicroUsd(toMicroUsd(5)), 5);
  assert.equal(toMicroUsd(null), null);
  assert.equal(toMicroUsd(0.1 + 0.2), 300000);
});

test('transactions roll back on error, nest as savepoints, and auto-join calls made on the root adapter', async t => {
  const database = await createDatabase({ pglite: true });
  t.after(() => database.close());
  await database.exec('CREATE TABLE ledger (id text PRIMARY KEY, amount_cents bigint NOT NULL)');
  await assert.rejects(database.transaction(async tx => {
    await tx.query("INSERT INTO ledger VALUES ('a', 1)");
    await database.query("INSERT INTO ledger VALUES ('b', 2)");
    throw new Error('boom');
  }), /boom/);
  assert.equal((await database.one('SELECT count(*) AS n FROM ledger')).n, 0);

  await database.transaction(async tx => {
    await tx.query("INSERT INTO ledger VALUES ('keep', 1)");
    await assert.rejects(database.transaction(async inner => {
      await inner.query("INSERT INTO ledger VALUES ('discard', 2)");
      throw new Error('inner');
    }), /inner/);
    await tx.query("INSERT INTO ledger VALUES ('also-keep', 3)");
  });
  assert.deepEqual((await database.query('SELECT id FROM ledger ORDER BY id')).map(row => row.id), ['also-keep', 'keep']);
});

test('queries started after a transaction ends fall back to the root, never to a released connection', async t => {
  const database = await createDatabase({ pglite: true });
  t.after(() => database.close());
  await database.exec('CREATE TABLE late (id text PRIMARY KEY)');
  let late;
  await database.transaction(async () => {
    setImmediate(() => { late = database.query("INSERT INTO late VALUES ('after-commit')"); });
  });
  await new Promise(resolve => setImmediate(resolve));
  await late;
  assert.equal((await database.one('SELECT count(*) AS n FROM late')).n, 1);
});

test('driver errors keep their message and expose the SQLSTATE as sqlState, never as code', async t => {
  const database = await createDatabase({ pglite: true });
  t.after(() => database.close());
  await database.exec('CREATE TABLE unique_things (id text PRIMARY KEY)');
  await database.query("INSERT INTO unique_things VALUES ('x')");
  const error = await database.query("INSERT INTO unique_things VALUES ('x')").catch(caught => caught);
  assert.match(error.message, /duplicate key|unique constraint/i);
  assert.equal(error.sqlState, '23505');
  assert.equal(error.code, undefined);
});

test('production refuses to start an embedded database without DATABASE_URL', async () => {
  await assert.rejects(createDatabaseFromEnv({ NODE_ENV: 'production' }), /DATABASE_URL is required in production/);
  await assert.rejects(createDatabaseFromEnv({ DATABASE_POOL_MAX: 'zero', DATABASE_URL: 'postgres://x' }), /positive integers/);
});

test('concurrent claimNext never hands the same task to two workers', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const caseId = await seedCase(database);
  const workflows = new WorkflowRepository(database, { clock: () => new Date(at) });
  const taskCount = 12;
  await workflows.createRunWithTasks({
    id: 'run-race', caseId, workflowName: 'race',
    tasks: Array.from({ length: taskCount }, (_, index) => ({ id: `task-${String(index).padStart(2, '0')}`, agentName: 'w', taskKind: 'work', input: { index } })),
  });
  const claims = await Promise.all(Array.from({ length: taskCount * 2 }, (_, index) => workflows.claimNext({ workerId: `worker-${index}` })));
  const claimed = claims.filter(Boolean).map(task => task.id);
  assert.equal(new Set(claimed).size, claimed.length, 'a task was claimed twice');
  assert.ok(claimed.length > 0);
  // Drain whatever SKIP LOCKED skipped under contention; every task is claimed exactly once overall.
  for (;;) {
    const task = await workflows.claimNext({ workerId: 'drain' });
    if (!task) break;
    claimed.push(task.id);
  }
  assert.equal(new Set(claimed).size, taskCount);
  assert.equal(claimed.length, taskCount);
  assert.equal((await sql.get(database, "SELECT max(attempt_count) AS most FROM workflow_tasks")).most, 1);
});

test('concurrent completion of sibling tasks still settles the run', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const caseId = await seedCase(database);
  const workflows = new WorkflowRepository(database, { clock: () => new Date(at) });
  await workflows.createRunWithTasks({
    id: 'run-settle', caseId, workflowName: 'settle',
    tasks: ['a', 'b', 'c', 'd'].map(key => ({ key, id: `task-${key}`, agentName: 'w', taskKind: 'work', input: {} })),
  });
  const tasks = [];
  for (let index = 0; index < 4; index += 1) tasks.push(await workflows.claimNext({ workerId: 'w' }));
  await Promise.all(tasks.map(task => workflows.completeTask(task.id, { workerId: 'w', output: { ok: true } })));
  assert.equal((await workflows.getRun('run-settle')).status, 'completed');
});

test('the same idempotency key enqueued concurrently yields one task and one stored key', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const caseId = await seedCase(database);
  const workflows = new WorkflowRepository(database, { clock: () => new Date(at) });
  const run = await workflows.createRun({ id: 'run-idem', caseId, workflowName: 'idem' });
  const request = { runId: run.id, agentName: 'w', taskKind: 'work', input: { n: 1 }, idempotencyKey: 'same-key-0001' };
  const results = await Promise.all(Array.from({ length: 8 }, () => workflows.enqueueTask(request)));
  assert.equal(new Set(results.map(task => task.id)).size, 1);
  assert.equal((await sql.get(database, 'SELECT count(*) AS n FROM workflow_tasks')).n, 1);
  assert.equal((await sql.get(database, "SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key = 'same-key-0001'")).n, 1);
});

test('concurrent audit appends form one unbroken hash chain per household', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await seedCase(database);
  const audit = new AuditRepository(database, { clock: () => new Date(at) });
  await Promise.all(Array.from({ length: 10 }, (_, index) => audit.append({
    householdId: 'h-1', caseId: 'c-1', action: 'test.event', resourceType: 'case', resourceId: `c-${index}`, payload: { index },
  })));
  const events = await sql.all(database, "SELECT id, previous_event_hash, event_hash FROM audit_events WHERE household_id = 'h-1' ORDER BY id");
  assert.equal(events.length, 10);
  assert.equal(events[0].previous_event_hash, null);
  for (let index = 1; index < events.length; index += 1) assert.equal(events[index].previous_event_hash, events[index - 1].event_hash);
});

test('parallel step updates on one breakdown job never lose each other', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const caseId = await seedCase(database);
  await sql.run(database, `INSERT INTO consent_grants (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
    VALUES ('g-1', 'h-1', 'a-1', 'local', 'coverage_reconstruction', 'v1', 'fixture', ?, ?)`, at, at);
  const records = new PolicyRecordRepository(database, { clock: () => new Date(at) });
  const steps = Array.from({ length: 9 }, (_, index) => ({ id: `step-${index}`, status: 'pending' }));
  const { job } = await records.createRecordWithJob({
    householdId: 'h-1', createdByAdultId: 'a-1', consentGrantId: 'g-1', contractVersion: 'v', documentIds: [],
    idempotencyKey: 'job-key-0001', requestDigest: 'f'.repeat(64), executionMode: 'fixture', budgetUsd: 1.5, steps,
  });
  assert.equal(job.budgetUsd, 1.5);
  await Promise.all(steps.map((step, index) => records.patchStep(job.id, step.id, { status: 'succeeded' }, { spentUsd: (index + 1) / 100 })));
  const after = await records.getJob(job.id);
  assert.deepEqual(after.steps.map(step => step.status), Array(9).fill('succeeded'));
  assert.equal(after.spentUsd, 0.09);
  await records.updateJob(job.id, { spentUsd: 0.01 });
  assert.equal((await records.getJob(job.id)).spentUsd, 0.09, 'spend never moves backwards');
  assert.equal(caseId, 'c-1');
});
