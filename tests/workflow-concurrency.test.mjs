// S3.2 design section 5: concurrency gates for the async PostgreSQL workflow and auth
// repositories. Synthetic data only. Each test runs on its own cloned database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { AuditRepository, AuthRepository, CaseRepository, WorkflowRepository } from '../src/backend/repositories/index.js';

const pg = postgresTestOptions();
const START = Date.parse('2026-10-20T09:00:00.000Z');
const LEASE_MS = 60_000;

// Households and adults are seeded with direct SQL: the household repository is converted in
// another work package. Cases go through the (async) case repository.
async function world(t, { maxActiveSessions } = {}) {
  let now = START;
  const clock = () => new Date(now);
  const { db, handle } = await freshDatabase(t, { clock });
  const audit = new AuditRepository(db, { clock });
  const workflows = new WorkflowRepository(db, { clock, audit, leaseDurationMs: LEASE_MS });
  const cases = new CaseRepository(db, { clock, audit });
  const auth = new AuthRepository(db, { clock, ...(maxActiveSessions ? { maxActiveSessions } : {}) });
  const at = clock().toISOString();
  for (const adult of ['adult-c1', 'adult-c2', 'adult-c3']) {
    await db.run(`INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at)
      VALUES (?, 'Synthetic adult', 'en-IN', 'active', ?, ?)`, [adult, at, at]);
  }
  await db.run(`INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at)
    VALUES ('adult-suspended', 'Synthetic suspended adult', 'en-IN', 'suspended', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO households (id, display_name, created_at, updated_at)
    VALUES ('household-c', 'Synthetic household', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, starts_at, created_at)
    VALUES ('role-c', 'household-c', 'adult-c1', 'owner', 'active', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-c', 'household-c', 'adult-c1', 'Synthetic adult', 'adult', ?, ?)`, [at, at]);
  await cases.create({ id: 'case-c', householdId: 'household-c', subjectMemberId: 'member-c', openedByAdultId: 'adult-c1', triggerType: 'renewal' });
  let runs = 0;
  return {
    db, handle, workflows, auth,
    advance(ms) { now += ms; },
    // `count` independent tasks (no dependencies) in one run.
    async run(count, name = `run-c${(runs += 1)}`) {
      return workflows.createRunWithTasks({
        id: name, caseId: 'case-c', workflowName: 'concurrency', executionMode: 'fixture',
        tasks: Array.from({ length: count }, (_, index) => ({ key: `t${index}`, agentName: 'concurrency/agent', taskKind: 'concurrency', input: { index } })),
      });
    },
  };
}

// A database interface that runs `hook` once, right after the first query whose SQL matches.
function interleave(db, method, pattern, hook) {
  let fired = false;
  const wrapped = {
    query: (sql, params) => db.query(sql, params),
    one: (sql, params) => db.one(sql, params),
    many: (sql, params) => db.many(sql, params),
    run: (sql, params) => db.run(sql, params),
    transaction: (fn, options) => db.transaction(fn, options),
    lock: (namespace, key) => db.lock(namespace, key),
  };
  wrapped[method] = async (sql, params) => {
    const result = await db[method](sql, params);
    if (!fired && pattern.test(sql)) {
      fired = true;
      await hook();
    }
    return result;
  };
  return { database: wrapped, fired: () => fired };
}

async function claimedEvents(db, runId) {
  return db.many(`SELECT workflow_task_id, event_payload_json FROM workflow_events
    WHERE workflow_run_id = ? AND event_type = 'task.claimed' ORDER BY id`, [runId]);
}

test('concurrent claims: every task is claimed exactly once', pg, async t => {
  const context = await world(t);
  const run = await context.run(12);
  const claims = [];
  const worker = async name => {
    for (let task = await context.workflows.claimNext({ workerId: name, runId: run.id }); task; task = await context.workflows.claimNext({ workerId: name, runId: run.id })) {
      claims.push({ worker: name, id: task.id, attempt: task.attempt_count, owner: task.lease_owner });
    }
  };
  await Promise.all(Array.from({ length: 8 }, (_, index) => worker(`worker-${index}`)));
  const expected = run.tasks.map(task => task.id).sort();
  assert.deepEqual(claims.map(claim => claim.id).sort(), expected, 'each task claimed once, none missed');
  assert.ok(claims.every(claim => claim.attempt === 1 && claim.owner === claim.worker));
  const rows = await context.db.many("SELECT status, attempt_count, lease_owner FROM workflow_tasks WHERE workflow_run_id = ?", [run.id]);
  assert.ok(rows.every(row => row.status === 'running' && row.attempt_count === 1));
  assert.equal((await claimedEvents(context.db, run.id)).length, expected.length, 'one claim event per task');
  assert.equal((await context.workflows.getRun(run.id)).status, 'running');
});

test('a claim that loses its candidate to another worker selects again under the run lock', pg, async t => {
  const context = await world(t);
  const run = await context.run(2);
  // A second interface over the same pool runs its own transaction, as another process would.
  const other = new WorkflowRepository(createDatabase(context.handle.pool), { clock: () => new Date(START), leaseDurationMs: LEASE_MS });
  let stolen;
  const racing = interleave(context.db, 'one', /^SELECT wt\.id, wt\.workflow_run_id FROM workflow_tasks wt/, async () => {
    stolen = await other.claimNext({ workerId: 'worker-other', runId: run.id });
  });
  const repository = new WorkflowRepository(racing.database, { clock: () => new Date(START), leaseDurationMs: LEASE_MS });
  const claimed = await repository.claimNext({ workerId: 'worker-raced', runId: run.id });
  assert.ok(racing.fired());
  assert.ok(stolen, 'the other worker claimed the raced candidate');
  const remaining = run.tasks.map(task => task.id).find(taskId => taskId !== stolen.id);
  assert.equal(claimed?.id, remaining, 'the raced worker gets the next task instead of nothing');
  assert.equal(claimed.lease_owner, 'worker-raced');
  assert.equal((await context.workflows.getTask(stolen.id)).lease_owner, 'worker-other');
  assert.equal((await context.workflows.getTask(stolen.id)).attempt_count, 1);
  assert.equal((await claimedEvents(context.db, run.id)).length, 2);
});

test('sibling completions settle the run', pg, async t => {
  const context = await world(t);
  for (let round = 0; round < 5; round += 1) {
    const run = await context.run(6);
    const claimed = [];
    for (let index = 0; index < run.tasks.length; index += 1) {
      claimed.push(await context.workflows.claimNext({ workerId: `worker-${index}`, runId: run.id }));
    }
    await Promise.all(claimed.map(task => context.workflows.completeTask(task.id, { workerId: task.lease_owner, output: { ok: true } })));
    const settled = await context.workflows.getRun(run.id);
    assert.equal(settled.status, 'completed', `round ${round}: the last sibling completion settles the run`);
    assert.equal(settled.terminal_reason, 'completed');
  }
});

test('sibling completion and failure settle the run as failed', pg, async t => {
  const context = await world(t);
  for (let round = 0; round < 5; round += 1) {
    const run = await context.run(4);
    const claimed = [];
    for (let index = 0; index < run.tasks.length; index += 1) {
      claimed.push(await context.workflows.claimNext({ workerId: `worker-${index}`, runId: run.id }));
    }
    await Promise.all(claimed.map((task, index) => (index === 0
      ? context.workflows.failTask(task.id, { workerId: task.lease_owner, code: 'TASK_FAILED' })
      : context.workflows.completeTask(task.id, { workerId: task.lease_owner, output: { ok: true } }))));
    assert.equal((await context.workflows.getRun(run.id)).status, 'failed', `round ${round}`);
  }
});

test('lease expiry against claim and completion: one outcome per task, never two owners', pg, async t => {
  const context = await world(t);
  const outcomes = new Set();
  for (let round = 0; round < 10; round += 1) {
    const run = await context.run(1);
    const [task] = run.tasks;
    const first = await context.workflows.claimNext({ workerId: 'worker-a', runId: run.id });
    assert.equal(first.id, task.id);
    context.advance(LEASE_MS);
    const [recovered, reclaimed, completion] = await Promise.allSettled([
      context.workflows.recoverExpiredLeases(),
      context.workflows.claimNext({ workerId: 'worker-b', runId: run.id }),
      context.workflows.completeTask(task.id, { workerId: 'worker-a', output: { ok: true } }),
    ]);
    assert.equal(recovered.status, 'fulfilled');
    assert.equal(reclaimed.status, 'fulfilled');
    const final = await context.workflows.getTask(task.id);
    const events = await claimedEvents(context.db, run.id);
    assert.equal(events.length, final.attempt_count, 'one claim event per attempt');
    if (completion.status === 'fulfilled') {
      // The holder completed before recovery: the expired lease was not recovered or re-claimed.
      assert.equal(final.status, 'completed');
      assert.equal(final.attempt_count, 1);
      assert.equal(recovered.value, 0);
      assert.equal(reclaimed.value, null);
      outcomes.add('completed');
    } else {
      assert.match(completion.reason.message, /holding a running task lease|lease changed/);
      assert.equal(recovered.value, 1);
      if (reclaimed.value) {
        assert.equal(final.status, 'running');
        assert.equal(final.lease_owner, 'worker-b');
        assert.equal(final.attempt_count, 2);
        outcomes.add('reclaimed');
        // Settle it so its lease does not expire into the next round's recovery count.
        await context.workflows.completeTask(task.id, { workerId: 'worker-b', output: { ok: true } });
      } else {
        assert.equal(final.status, 'pending');
        assert.equal(final.attempt_count, 1);
        outcomes.add('recovered');
      }
    }
    context.advance(1_000);
  }
  assert.ok(outcomes.size >= 1);
});

test('lease recovery re-checks each task under the run lock', pg, async t => {
  const context = await world(t);
  const run = await context.run(1);
  const [task] = run.tasks;
  await context.workflows.claimNext({ workerId: 'worker-a', runId: run.id });
  context.advance(LEASE_MS);
  // The holder completes between recovery's scan and its per-run transaction.
  const racing = interleave(context.db, 'many', /^SELECT id, workflow_run_id FROM workflow_tasks/, async () => {
    await context.workflows.completeTask(task.id, { workerId: 'worker-a', output: { ok: true } });
  });
  const repository = new WorkflowRepository(racing.database, { clock: () => new Date(START + LEASE_MS), leaseDurationMs: LEASE_MS });
  assert.equal(await repository.recoverExpiredLeases(), 0);
  assert.ok(racing.fired());
  const final = await context.workflows.getTask(task.id);
  assert.equal(final.status, 'completed');
  assert.equal(final.last_error_code, null, 'a completed task is not marked LEASE_EXPIRED');
  assert.equal((await context.workflows.getRun(run.id)).status, 'completed');
});

test('10 concurrent enqueueTask calls with one idempotency key create one task', pg, async t => {
  const context = await world(t);
  const run = await context.run(0, 'run-enqueue');
  const request = { runId: run.id, agentName: 'concurrency/extra', taskKind: 'concurrency_extra', input: { n: 1 }, idempotencyKey: 'concurrency-key-1' };
  const results = await Promise.all(Array.from({ length: 10 }, () => context.workflows.enqueueTask(request)));
  assert.equal(new Set(results.map(task => task.id)).size, 1, 'every caller gets the same task');
  assert.equal((await context.db.one('SELECT count(*) AS count FROM workflow_tasks WHERE workflow_run_id = ?', [run.id])).count, 1);
  assert.equal((await context.db.one("SELECT count(*) AS count FROM idempotency_keys WHERE scope = 'workflow_task' AND idempotency_key = ?", [request.idempotencyKey])).count, 1);
});

test('concurrent enqueueTask calls with one key and different requests: one wins, the rest conflict', pg, async t => {
  const context = await world(t);
  const run = await context.run(0, 'run-enqueue-conflict');
  const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, n) => context.workflows.enqueueTask({
    runId: run.id, agentName: 'concurrency/extra', taskKind: 'concurrency_extra', input: { n }, idempotencyKey: 'concurrency-key-2',
  })));
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(settled.filter(result => result.status === 'rejected').every(result => result.reason.code === 'IDEMPOTENCY_CONFLICT'));
  assert.equal((await context.db.one('SELECT count(*) AS count FROM workflow_tasks WHERE workflow_run_id = ?', [run.id])).count, 1);
});

test('session capacity holds under concurrent issuance', pg, async t => {
  const context = await world(t, { maxActiveSessions: 3 });
  const adults = ['adult-c1', 'adult-c2', 'adult-c3'];
  const settled = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => context.auth.issueSession({ adultUserId: adults[index % adults.length] })));
  const issued = settled.filter(result => result.status === 'fulfilled');
  assert.equal(issued.length, 3, 'capacity is never exceeded');
  assert.ok(settled.filter(result => result.status === 'rejected').every(result => result.reason.code === 'SESSION_CAPACITY_REACHED' && result.reason.statusCode === 429));
  assert.equal((await context.db.one('SELECT count(*) AS count FROM api_sessions WHERE revoked_at IS NULL')).count, 3);
  // A revoked session frees capacity.
  const [{ value: session }] = issued;
  assert.equal(await context.auth.revokeSession({ sessionId: session.sessionId, adultUserId: session.adultUserId }), true);
  assert.equal(await context.auth.revokeSession({ sessionId: session.sessionId, adultUserId: session.adultUserId }), false);
  assert.ok((await context.auth.issueSession({ adultUserId: 'adult-c1' })).token);
});

test('session issuance and authentication fail closed', pg, async t => {
  const context = await world(t);
  await assert.rejects(context.auth.issueSession({ adultUserId: 'adult-suspended' }), { code: 'AUTH_SUBJECT_INVALID', statusCode: 403 });
  await assert.rejects(context.auth.issueSession({ adultUserId: 'adult-missing' }), { code: 'AUTH_SUBJECT_INVALID' });
  await assert.rejects(context.auth.issueSession({ adultUserId: 'adult-c1', durationMs: 1_000 }), /between one minute and 24 hours/);
  assert.equal((await context.db.one('SELECT count(*) AS count FROM api_sessions')).count, 0);

  const session = await context.auth.issueSession({ adultUserId: 'adult-c1', durationMs: 60_000 });
  assert.deepEqual(await context.auth.authenticate(session.token), { sessionId: session.sessionId, adultId: 'adult-c1', expiresAt: session.expiresAt });
  assert.equal(await context.auth.authenticate('x'.repeat(43)), null, 'an unknown token is not authenticated');
  assert.equal(await context.auth.authenticate('short'), null);
  context.advance(60_000);
  assert.equal(await context.auth.authenticate(session.token), null, 'an expired session is not authenticated');

  const second = await context.auth.issueSession({ adultUserId: 'adult-c1' });
  assert.equal(await context.auth.revokeSession({ sessionId: second.sessionId, adultUserId: 'adult-c2' }), false, 'only the owner revokes');
  assert.equal(await context.auth.revokeSession({ sessionId: second.sessionId, adultUserId: 'adult-c1' }), true);
  assert.equal(await context.auth.authenticate(second.token), null, 'a revoked session is not authenticated');
});

test('a session revoked between lookup and refresh is neither refreshed nor authenticated', pg, async t => {
  const context = await world(t);
  const session = await context.auth.issueSession({ adultUserId: 'adult-c1' });
  const racing = interleave(context.db, 'one', /FROM api_sessions JOIN adult_users/, async () => {
    assert.equal(await context.auth.revokeSession({ sessionId: session.sessionId, adultUserId: 'adult-c1' }), true);
  });
  const auth = new AuthRepository(racing.database, { clock: () => new Date(START) });
  assert.equal(await auth.authenticate(session.token), null);
  assert.ok(racing.fired());
  const row = await context.db.one('SELECT revoked_at, last_seen_at FROM api_sessions WHERE id = ?', [session.sessionId]);
  assert.ok(row.revoked_at);
  assert.equal(row.last_seen_at, null, 'a revoked session is never refreshed');
});
