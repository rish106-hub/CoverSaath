import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { JobQueueRepository } from '../src/backend/repositories/job-queue-repository.js';
import { buildJobHandlers } from '../src/server/worker.js';
import { HOLDING_CREATE_JOB_KIND } from '../src/contracts/holdings.js';

// Holding creation after OCR must not strand the document (pipeline reliability F2): a failure after the OCR pages are stored queues a
// bounded, idempotent holding.create job; a retry succeeds without a second holding; spent attempts leave a coded failure the holdings list
// shows. A trigger stands in for the database failure. Synthetic data only. Needs TEST_DATABASE_URL.

const opts = postgresTestOptions();
const ON = { POLICY_FACTS_ENABLED: 'true', HOLDINGS_ENABLED: 'true' };
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const n = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);

async function failingWorld(t) {
  fixture.pages = [page(['Sum Insured: Rs. 5,00,000/-']), page(['Schedule of benefits'])];
  const app = await startApp(t, { env: ON });
  await app.database.run(`CREATE FUNCTION fail_holding_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic outage'; END $$`);
  await app.database.run('CREATE TRIGGER fail_holding_insert BEFORE INSERT ON policy_holdings FOR EACH ROW EXECUTE FUNCTION fail_holding_insert()');
  const s = await scenario(app, { name: 'Retry' });
  const services = createBackendServices(app.database, { env: { ...app.env, ...ON } });
  const queue = new JobQueueRepository(app.database);
  const worker = createJobWorker({ queue, handlers: { [HOLDING_CREATE_JOB_KIND]: buildJobHandlers(services, ON)[HOLDING_CREATE_JOB_KIND] }, workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const issues = async () => (await app.call(`/api/v1/households/${s.householdId}/holdings`, { token: s.token })).data.creation_issues;
  const runCreateJobs = async () => {
    await app.database.run(`UPDATE job_queue SET run_after = now() - interval '1 minute' WHERE kind = ? AND status = 'queued'`, [HOLDING_CREATE_JOB_KIND]);
    const outcomes = [];
    for (let i = 0; i < 10; i += 1) { const out = await worker.runOnce(); if (!out) break; outcomes.push(out.outcome); }
    return outcomes;
  };
  return { app, s, services, issues, runCreateJobs, heal: () => app.database.run('DROP TRIGGER fail_holding_insert ON policy_holdings') };
}

test('holding creation fails after OCR: the document is retried, one holding results, a duplicate delivery adds none', opts, async t => {
  const { app, s, issues, runCreateJobs, heal } = await failingWorld(t);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM policy_holdings WHERE household_id = ?', [s.householdId]), 0, 'creation failed');
  assert.equal(await n(app, 'SELECT count(*) AS n FROM ocr_jobs'), 1, 'the OCR result stands');
  const job = await app.database.one('SELECT * FROM job_queue WHERE kind = ?', [HOLDING_CREATE_JOB_KIND]);
  assert.ok(job, 'a holding.create job was queued');
  assert.deepEqual([job.household_id, job.document_id, job.max_attempts, job.status], [s.householdId, s.documentId, 3, 'queued']);
  assert.deepEqual(await issues(), [{ document_id: s.documentId, state: 'retrying', code: null }]);

  assert.deepEqual(await runCreateJobs(), ['retry'], 'first attempt fails, requeued with backoff');
  await heal();
  assert.deepEqual(await runCreateJobs(), ['succeeded']);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM policy_holdings WHERE household_id = ? AND document_id = ?', [s.householdId, s.documentId]), 1);
  assert.equal(await n(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.detect_insurer' AND document_id = ?", [s.documentId]), 1);
  assert.deepEqual(await issues(), [], 'no issue once the holding exists');

  // A duplicate delivery of the same job creates no second holding and no second detect job.
  await app.database.run(`INSERT INTO job_queue (id, kind, household_id, document_id, payload_json, max_attempts, run_after, created_at, updated_at)
    VALUES ('job-dup', ?, ?, ?, '{}', 3, now() - interval '1 minute', now(), now())`, [HOLDING_CREATE_JOB_KIND, s.householdId, s.documentId]);
  assert.deepEqual(await runCreateJobs(), ['succeeded']);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM policy_holdings WHERE household_id = ?', [s.householdId]), 1);
  assert.equal(await n(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.detect_insurer' AND document_id = ?", [s.documentId]), 1);
});

test('holding creation keeps failing: attempts are bounded and the end state is a coded failure the app can show', opts, async t => {
  const { app, s, issues, runCreateJobs } = await failingWorld(t);
  assert.deepEqual(await runCreateJobs(), ['retry']);
  assert.deepEqual(await runCreateJobs(), ['retry']);
  assert.deepEqual(await runCreateJobs(), ['dead']);
  assert.deepEqual(await runCreateJobs(), [], 'no fourth attempt');
  const job = await app.database.one('SELECT status, attempts, last_error_code FROM job_queue WHERE kind = ?', [HOLDING_CREATE_JOB_KIND]);
  assert.deepEqual([job.status, Number(job.attempts), job.last_error_code], ['dead', 3, 'HOLDING_CREATE_FAILED']);
  assert.deepEqual(await issues(), [{ document_id: s.documentId, state: 'failed', code: 'HOLDING_CREATE_FAILED' }]);
  // Another household sees nothing of it.
  const other = await scenario(app, { name: 'Other' });
  const view = (await app.call(`/api/v1/households/${other.householdId}/holdings`, { token: other.token })).data;
  assert.ok(!JSON.stringify(view.creation_issues).includes(s.documentId));
  assert.equal((await app.call(`/api/v1/households/${s.householdId}/holdings`, { token: other.token })).status, 404);
});
