// Postgres job queue and worker loop (migration 034, plan B4). Synthetic identifiers only; no network; no timed sleeps:
// time is a test clock, concurrency uses real parallel connections, and every wait is bounded by an event or a test timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { JobQueueRepository, retryDelayMs } from '../src/backend/repositories/job-queue-repository.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { parameterAt, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pg = postgresTestOptions();
const START = Date.parse('2026-11-07T09:00:00.000Z');
const LEASE_MS = 60_000;
const KIND = 'ocr.document';
const HOUSEHOLD = 'household-queue';

async function world(t) {
  let now = START;
  const clock = () => new Date(now);
  const { db, services } = await freshDatabase(t, { clock });
  const queue = new JobQueueRepository(db, { clock });
  return { db, queue, services, advance: ms => { now += ms; }, clock };
}

const enqueue = (queue, extra = {}) => queue.enqueue({ kind: KIND, householdId: HOUSEHOLD, documentId: 'document-queue', ...extra });
const states = db => db.many('SELECT id, status, attempts, locked_by, last_error_code FROM job_queue ORDER BY created_at, id');
const pause = () => new Promise(resolve => setImmediate(resolve));

test('enqueue stores identifiers only and refuses free text, nesting and bad kinds', pg, async t => {
  const { db, queue } = await world(t);
  const { job, created } = await enqueue(queue, { payload: { documentId: 'document-queue', pageRef: 'page-1' } });
  assert.equal(created, true);
  assert.deepEqual(job.payload, { documentId: 'document-queue', pageRef: 'page-1' });
  assert.equal(job.status, 'queued');
  for (const payload of [{ text: 'Sum insured Rs. 5,00,000' }, { nested: { a: 'b' } }, { n: 5 }, { a: 'x'.repeat(200) }, ['list'], 'text', { 'bad key': 'x' }]) {
    await assert.rejects(enqueue(queue, { payload }), { code: 'JOB_QUEUE_INPUT_INVALID' }, JSON.stringify(payload));
  }
  await assert.rejects(queue.enqueue({ kind: 'Bad Kind', householdId: HOUSEHOLD }), { code: 'JOB_QUEUE_INPUT_INVALID' });
  await assert.rejects(queue.enqueue({ kind: KIND }), { code: 'JOB_QUEUE_INPUT_INVALID' });
  await assert.rejects(enqueue(queue, { documentId: 'has spaces and a name' }), { code: 'JOB_QUEUE_INPUT_INVALID' });
  await assert.rejects(enqueue(queue, { maxAttempts: 0 }), { code: 'JOB_QUEUE_INPUT_INVALID' });
  assert.equal((await db.one('SELECT count(*) AS count FROM job_queue')).count, 1);
});

test('the table itself refuses a running job without a lease and a finished job without a finish time', pg, async t => {
  const { db, queue } = await world(t);
  const { job } = await enqueue(queue);
  await assertDbError(db.run("UPDATE job_queue SET status = 'running' WHERE id = ?", [job.id]), { sqlstate: '23514' });
  await assertDbError(db.run("UPDATE job_queue SET status = 'dead' WHERE id = ?", [job.id]), { sqlstate: '23514' });
  await assertDbError(db.run("UPDATE job_queue SET last_error_code = 'free text with spaces' WHERE id = ?", [job.id]), { sqlstate: '23514' });
});

test('a dedupe key enqueues once while the job is queued or running, and is free again once it finished', pg, async t => {
  const { queue } = await world(t);
  const first = await enqueue(queue, { dedupeKey: 'ocr:document-queue:v1' });
  const again = await enqueue(queue, { dedupeKey: 'ocr:document-queue:v1' });
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.job.id, first.job.id);
  const claimed = await queue.claim({ workerId: 'worker-a', kinds: [KIND], leaseMs: LEASE_MS });
  assert.equal((await enqueue(queue, { dedupeKey: 'ocr:document-queue:v1' })).job.id, first.job.id, 'a running job still holds the key');
  assert.equal(await queue.complete({ id: claimed.id, workerId: 'worker-a', attempt: claimed.attempt }), true);
  const next = await enqueue(queue, { dedupeKey: 'ocr:document-queue:v1' });
  assert.equal(next.created, true);
  assert.notEqual(next.job.id, first.job.id);
});

test('only due jobs of the asked kinds are claimed, oldest due first', pg, async t => {
  const { queue, advance } = await world(t);
  const later = await enqueue(queue, { runAfter: new Date(START + 10_000).toISOString() });
  const other = await queue.enqueue({ kind: 'llm.structure', householdId: HOUSEHOLD });
  assert.equal(await queue.claim({ workerId: 'worker-a', kinds: [KIND], leaseMs: LEASE_MS }), null, 'not due yet');
  assert.equal((await queue.claim({ workerId: 'worker-a', kinds: ['llm.structure'], leaseMs: LEASE_MS })).id, other.job.id, 'kind filter');
  advance(10_000);
  const claimed = await queue.claim({ workerId: 'worker-a', kinds: [KIND], leaseMs: LEASE_MS });
  assert.equal(claimed.id, later.job.id);
  assert.equal(claimed.attempt, 1);
  assert.equal(claimed.status, 'running');
  await assert.rejects(queue.claim({ workerId: 'worker-a', kinds: [], leaseMs: LEASE_MS }), { code: 'JOB_QUEUE_INPUT_INVALID' });
  await assert.rejects(queue.claim({ workerId: 'bad worker', kinds: [KIND] }), { code: 'JOB_QUEUE_INPUT_INVALID' });
});

test('two workers racing for one job: it runs exactly once', pg, async t => {
  const { queue } = await world(t);
  await enqueue(queue);
  const ran = [];
  const handlers = { [KIND]: async ({ job }) => { ran.push(job.id); await pause(); await pause(); } };
  const workers = ['worker-a', 'worker-b'].map(workerId => createJobWorker({ queue, handlers, workerId, leaseMs: LEASE_MS }));
  const results = await Promise.all(workers.map(worker => worker.runOnce()));
  assert.equal(results.filter(Boolean).length, 1, 'one worker got the job, the other got nothing');
  assert.deepEqual(results.filter(Boolean).map(result => result.outcome), ['succeeded']);
  assert.equal(ran.length, 1);
  assert.deepEqual((await states(queue.database)).map(row => [row.status, row.attempts]), [['succeeded', 1]]);
});

test('four workers draining thirty jobs run every job exactly once', pg, async t => {
  const { queue, db } = await world(t);
  const ids = [];
  for (let n = 0; n < 30; n += 1) ids.push((await enqueue(queue, { documentId: `document-queue-${n}` })).job.id);
  const ran = new Map();
  const handlers = { [KIND]: async ({ job }) => { ran.set(job.id, (ran.get(job.id) ?? 0) + 1); await pause(); } };
  const workers = Array.from({ length: 4 }, (_, n) => createJobWorker({ queue, handlers, workerId: `worker-${n}`, leaseMs: LEASE_MS }));
  await Promise.all(workers.map(async worker => { while (await worker.runOnce()); }));
  assert.equal(ran.size, 30);
  assert.ok([...ran.values()].every(count => count === 1), 'no job ran twice');
  assert.deepEqual([...ran.keys()].sort(), [...ids].sort());
  assert.deepEqual((await states(db)).map(row => row.status), Array(30).fill('succeeded'));
  assert.deepEqual(await queue.stats(), { queued: 0, running: 0, succeeded: 30, dead: 0, due: 0 });
});

test('a crashed worker\'s job is claimed again after its lease expires, and the stale worker is fenced out', pg, async t => {
  const { queue, advance } = await world(t);
  const { job } = await enqueue(queue);
  const crashed = await queue.claim({ workerId: 'worker-a', kinds: [KIND], leaseMs: LEASE_MS });
  assert.equal(crashed.attempt, 1);
  advance(LEASE_MS - 1);
  assert.equal(await queue.claim({ workerId: 'worker-b', kinds: [KIND], leaseMs: LEASE_MS }), null, 'a live lease is not taken');
  assert.equal(await queue.heartbeat({ id: job.id, workerId: 'worker-a', attempt: 1, leaseMs: LEASE_MS }), true, 'a heartbeat renews it');
  advance(LEASE_MS - 1);
  assert.equal(await queue.claim({ workerId: 'worker-b', kinds: [KIND], leaseMs: LEASE_MS }), null, 'the renewed lease still holds');
  advance(1);
  const taken = await queue.claim({ workerId: 'worker-b', kinds: [KIND], leaseMs: LEASE_MS });
  assert.equal(taken.id, job.id);
  assert.equal(taken.attempt, 2);
  assert.equal(taken.lockedBy, 'worker-b');
  // The stale worker comes back: nothing it does touches the job.
  assert.equal(await queue.heartbeat({ id: job.id, workerId: 'worker-a', attempt: 1 }), false);
  assert.equal(await queue.complete({ id: job.id, workerId: 'worker-a', attempt: 1 }), false);
  assert.equal(await queue.fail({ id: job.id, workerId: 'worker-a', attempt: 1, errorCode: 'STALE' }), null);
  // Same worker id, older attempt number: also fenced.
  assert.equal(await queue.complete({ id: job.id, workerId: 'worker-b', attempt: 1 }), false);
  assert.equal(await queue.complete({ id: job.id, workerId: 'worker-b', attempt: 2 }), true);
  assert.equal((await queue.get(job.id)).status, 'succeeded');
});

test('a job that keeps expiring its lease is dead-lettered once it has used its attempts', pg, async t => {
  const { queue, advance } = await world(t);
  const { job } = await enqueue(queue, { maxAttempts: 2 });
  for (const attempt of [1, 2]) {
    assert.equal((await queue.claim({ workerId: `worker-${attempt}`, kinds: [KIND], leaseMs: LEASE_MS })).attempt, attempt);
    advance(LEASE_MS);
  }
  assert.equal(await queue.claim({ workerId: 'worker-3', kinds: [KIND], leaseMs: LEASE_MS }), null);
  const dead = await queue.get(job.id);
  assert.equal(dead.status, 'dead');
  assert.equal(dead.lastErrorCode, 'JOB_LEASE_EXPIRED');
  assert.equal(dead.lockedBy, null);
});

test('a failing handler is retried with growing backoff, then dead-lettered at the attempt cap', pg, async t => {
  const { queue, advance, db } = await world(t);
  const { job } = await enqueue(queue, { maxAttempts: 3 });
  let calls = 0;
  const events = [];
  const handlers = { [KIND]: async () => { calls += 1; throw Object.assign(new Error('provider said: Sum insured Rs. 5,00,000'), { code: 'OCR_PROVIDER_DOWN' }); } };
  const worker = createJobWorker({ queue, handlers, workerId: 'worker-a', leaseMs: LEASE_MS, onEvent: event => events.push(event) });

  assert.equal((await worker.runOnce()).outcome, 'retry');
  assert.equal(await worker.runOnce(), null, 'not due before the backoff has passed');
  const afterFirst = await queue.get(job.id);
  assert.equal(afterFirst.status, 'queued');
  assert.equal(Date.parse(afterFirst.runAfter) - START, retryDelayMs(1));
  advance(retryDelayMs(1) - 1);
  assert.equal(await worker.runOnce(), null);
  advance(1);
  assert.equal((await worker.runOnce()).outcome, 'retry');
  const afterSecond = await queue.get(job.id);
  assert.equal(Date.parse(afterSecond.runAfter) - (START + retryDelayMs(1)), retryDelayMs(2));
  assert.ok(retryDelayMs(2) > retryDelayMs(1));
  advance(retryDelayMs(2));
  assert.equal((await worker.runOnce()).outcome, 'dead');
  advance(10 * 60 * 60_000);
  assert.equal(await worker.runOnce(), null, 'a dead job never runs again');
  assert.equal(calls, 3, 'exactly max_attempts runs');
  const final = await queue.get(job.id);
  assert.equal(final.status, 'dead');
  assert.equal(final.attempt, 3);
  assert.equal(final.lastErrorCode, 'OCR_PROVIDER_DOWN');
  assert.ok(!JSON.stringify(await db.many('SELECT * FROM job_queue')).includes('Sum insured'), 'only the code is stored, never the message');
  assert.ok(!JSON.stringify(events).includes('Sum insured'), 'events carry ids and codes only');
  assert.deepEqual(events.map(event => event.type), ['job.started', 'job.retry', 'job.started', 'job.retry', 'job.started', 'job.dead']);
  assert.equal(retryDelayMs(40), 15 * 60_000, 'the backoff is capped');
});

test('a non-retryable failure is dead-lettered at once and an uncoded failure is stored as JOB_FAILED', pg, async t => {
  const { queue } = await world(t);
  const fatal = await enqueue(queue, { documentId: 'document-fatal' });
  const plain = await enqueue(queue, { documentId: 'document-plain' });
  const handlers = {
    [KIND]: async ({ job }) => {
      throw job.id === fatal.job.id ? Object.assign(new Error('x'), { code: 'CONSENT_NOT_CURRENT', retryable: false }) : new Error('boom');
    },
  };
  const worker = createJobWorker({ queue, handlers, workerId: 'worker-a', leaseMs: LEASE_MS });
  const outcomes = [(await worker.runOnce()).outcome, (await worker.runOnce()).outcome].sort();
  assert.deepEqual(outcomes, ['dead', 'retry']);
  assert.deepEqual([(await queue.get(fatal.job.id)).lastErrorCode, (await queue.get(plain.job.id)).lastErrorCode], ['CONSENT_NOT_CURRENT', 'JOB_FAILED']);
  assert.equal((await queue.get(fatal.job.id)).status, 'dead');
});

test('a worker with no handler for a kind leaves the job queued', pg, async t => {
  const { queue } = await world(t);
  const { job } = await enqueue(queue);
  const worker = createJobWorker({ queue, handlers: {}, workerId: 'worker-a', leaseMs: LEASE_MS });
  assert.equal(await worker.runOnce(), null);
  assert.equal((await queue.get(job.id)).status, 'queued');
});

test('a handler learns it lost its lease: the signal aborts and nothing is completed', { ...pg, timeout: 30_000 }, async t => {
  const { queue, db } = await world(t);
  const { job } = await enqueue(queue);
  let aborted;
  const handlers = {
    [KIND]: ({ signal }) => new Promise(resolve => {
      // The job row is erased (a consent revocation) while the handler runs; the next heartbeat is refused.
      db.run('DELETE FROM job_queue WHERE id = ?', [job.id]);
      signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    }),
  };
  const worker = createJobWorker({ queue, handlers, workerId: 'worker-a', leaseMs: LEASE_MS, heartbeatMs: 10 });
  const result = await worker.runOnce();
  assert.deepEqual(result, { jobId: job.id, outcome: 'lease_lost' });
  assert.equal(aborted, true);
  assert.equal(await queue.get(job.id), null);
});

test('start() runs a job that arrives later, and stop() drains and returns', { ...pg, timeout: 30_000 }, async t => {
  const { queue } = await world(t);
  let handled;
  const done = new Promise(resolve => { handled = resolve; });
  const worker = createJobWorker({ queue, handlers: { [KIND]: async ({ job }) => handled(job.id) }, workerId: 'worker-a', leaseMs: LEASE_MS, pollMs: 20, concurrency: 2 });
  worker.start();
  const { job } = await enqueue(queue);
  assert.equal(await done, job.id);
  assert.equal(await worker.stop({ timeoutMs: 10_000 }), true);
  const later = await enqueue(queue, { documentId: 'document-after-stop' });
  assert.equal((await queue.get(later.job.id)).status, 'queued', 'a stopped worker claims nothing');
  assert.throws(() => createJobWorker({ queue, handlers: {}, workerId: 'w', concurrency: 0 }), TypeError);
  assert.throws(() => createJobWorker({ queue, handlers: {}, workerId: 'w', leaseMs: 1000, heartbeatMs: 1000 }), TypeError);
});

test('stats report depth and purge removes only old succeeded jobs', pg, async t => {
  const { queue, advance } = await world(t);
  const a = await enqueue(queue, { documentId: 'document-a' });
  await enqueue(queue, { documentId: 'document-b' });
  await enqueue(queue, { documentId: 'document-c', runAfter: new Date(START + 60_000).toISOString() });
  const claimed = await queue.claim({ workerId: 'worker-a', kinds: [KIND], leaseMs: LEASE_MS });
  assert.deepEqual(await queue.stats(), { queued: 2, running: 1, succeeded: 0, dead: 0, due: 1 });
  await queue.complete({ id: claimed.id, workerId: 'worker-a', attempt: 1 });
  advance(3_600_000);
  assert.equal(await queue.purgeSucceeded(1_800_000), 1);
  assert.equal(await queue.purgeSucceeded(1_800_000), 0);
  assert.equal((await queue.stats()).queued, 2);
  assert.ok(a.job.id);
});

// ---------------------------------------------------------------------------------------------
// Erasure (AI.md invariant 3): revocation and document erasure delete the queued work of what was withdrawn.
// ---------------------------------------------------------------------------------------------

const GRANT = 'consent-parameters';
const ADULT = 'adult-parameters';
const PARAMETER_HOUSEHOLD = 'household-parameters';
const DOCUMENT = 'document-parameters';

async function erasureWorld(t) {
  const { db, services } = await freshDatabase(t, { clock: () => new Date(parameterAt) });
  await seedParameterWorld(db);
  const queue = services.jobQueue;
  const row = (extra = {}) => queue.enqueue({ kind: KIND, householdId: PARAMETER_HOUSEHOLD, ...extra });
  const jobs = {
    // Due first, so the running-job test claims it.
    byDocument: (await row({ documentId: DOCUMENT, runAfter: new Date(Date.parse(parameterAt) - 60_000).toISOString() })).job,
    byGrant: (await row({ consentGrantId: GRANT, documentId: 'document-unrelated' })).job,
    both: (await row({ documentId: DOCUMENT, consentGrantId: GRANT })).job,
    otherDocument: (await row({ documentId: 'document-untouched' })).job,
    otherGrant: (await row({ consentGrantId: 'consent-other' })).job,
    otherHousehold: (await queue.enqueue({ kind: KIND, householdId: 'household-other', documentId: DOCUMENT })).job,
  };
  return { db, services, queue, jobs };
}

test('consent revocation deletes the grant\'s and the withdrawn documents\' jobs, in any state, and keeps the rest', pg, async t => {
  const { db, services, queue, jobs } = await erasureWorld(t);
  // One of them is running when the revocation lands.
  const running = await queue.claim({ workerId: 'worker-a', kinds: [KIND], leaseMs: LEASE_MS });
  assert.ok(running);
  await db.run(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-queue', ?, 'document', ?, 'collect', 'insurance_document', NULL, ?)`, [GRANT, DOCUMENT, parameterAt]);
  await services.consents.revoke({ grantId: GRANT, revokedByAdultId: ADULT });
  const left = (await db.many('SELECT id FROM job_queue ORDER BY id')).map(item => item.id).sort();
  assert.deepEqual(left, [jobs.otherDocument.id, jobs.otherGrant.id, jobs.otherHousehold.id].sort());
  // The worker that held one learns it at its next heartbeat and cannot complete or fail it.
  assert.equal(await queue.heartbeat({ id: running.id, workerId: 'worker-a', attempt: 1 }), false);
  assert.equal(await queue.complete({ id: running.id, workerId: 'worker-a', attempt: 1 }), false);
  const audit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'job_queue.erased'");
  assert.deepEqual(JSON.parse(audit.event_payload_json), { reason: 'consent_revoked', jobs: 3, documents: 2 });
  // Revoking again changes nothing.
  await services.consents.revoke({ grantId: GRANT, revokedByAdultId: ADULT });
  assert.equal((await db.one('SELECT count(*) AS count FROM job_queue')).count, 3);
});

test('document erasure deletes that household\'s jobs for the document only', pg, async t => {
  const { db, services, jobs } = await erasureWorld(t);
  const counts = await services.consents.eraseDerivedRunData({
    householdId: PARAMETER_HOUSEHOLD, documentIds: [DOCUMENT], reason: 'document_erasure', resourceType: 'document', resourceId: DOCUMENT,
  });
  assert.equal(counts.jobs, 2);
  const left = (await db.many('SELECT id FROM job_queue')).map(item => item.id).sort();
  assert.deepEqual(left, [jobs.byGrant.id, jobs.otherDocument.id, jobs.otherGrant.id, jobs.otherHousehold.id].sort(), 'another household\'s job for the same id stays');
  assert.deepEqual(await services.consents.eraseDerivedRunData({
    householdId: PARAMETER_HOUSEHOLD, documentIds: [DOCUMENT], reason: 'document_erasure', resourceType: 'document', resourceId: DOCUMENT,
  }).then(result => result.jobs), 0, 'idempotent');
});

test('the queue table holds no copy of anything the erasure paths miss: no column besides ids, codes and times', pg, async t => {
  const { db } = await world(t);
  const columns = (await db.many(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'job_queue' ORDER BY ordinal_position`))
    .map(row => row.column_name);
  assert.deepEqual(columns, ['id', 'kind', 'household_id', 'document_id', 'consent_grant_id', 'payload_json', 'dedupe_key', 'status', 'attempts',
    'max_attempts', 'run_after', 'locked_by', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at', 'finished_at']);
});
