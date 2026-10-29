// Review fixes for the PostgreSQL cutover: (1) the global active-case cap holds under concurrent
// creation, (2) structuring-job recovery interrupts only attempts whose lease expired, never a live
// instance's attempt on a shared database. Synthetic data only; fake model, zero network, no sleeps.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { AuditRepository, CaseRepository } from '../src/backend/repositories/index.js';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { buildStoredBlocks, serializeStoredBlocks } from '../src/features/input/index.js';
import { parameterAt, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pg = postgresTestOptions();
const START = Date.parse('2026-10-20T09:00:00.000Z');

// ---------------------------------------------------------------------------------------------
// 1. Case capacity
// ---------------------------------------------------------------------------------------------

async function caseWorld(t, households = 5) {
  const clock = () => new Date(START);
  const { db } = await freshDatabase(t, { clock });
  const cases = new CaseRepository(db, { clock, audit: new AuditRepository(db, { clock }) });
  const at = clock().toISOString();
  await db.run(`INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at)
    VALUES ('adult-cap', 'Synthetic adult', 'en-IN', 'active', ?, ?)`, [at, at]);
  const ids = [];
  for (let n = 0; n < households; n += 1) {
    ids.push(`household-cap-${n}`);
    await db.run(`INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, 'Synthetic household', ?, ?)`, [ids[n], at, at]);
    await db.run(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, starts_at, created_at)
      VALUES (?, ?, 'adult-cap', 'owner', 'active', ?, ?)`, [`role-cap-${n}`, ids[n], at, at]);
  }
  const create = (n, cap) => cases.create({
    householdId: ids[n % ids.length], openedByAdultId: 'adult-cap', triggerType: 'renewal', maxActiveCases: cap,
  });
  const count = async () => (await db.one(`SELECT count(*) AS count FROM service_cases WHERE status NOT IN ('closed', 'revoked')`, [])).count;
  return { db, cases, create, count };
}

test('concurrent case creations at the global cap create exactly cap cases', pg, async t => {
  const { db, create, count } = await caseWorld(t);
  const cap = 4;
  const settled = await Promise.allSettled(Array.from({ length: 24 }, (_, n) => create(n, cap)));
  const created = settled.filter(result => result.status === 'fulfilled');
  const refused = settled.filter(result => result.status === 'rejected');
  assert.equal(created.length, cap, 'the cap is never exceeded');
  assert.equal(refused.length, 24 - cap);
  assert.ok(refused.every(result => result.reason.code === 'CASE_CAPACITY_REACHED' && result.reason.statusCode === 429));
  assert.equal(await count(), cap);
  // Only the winners left an audit event; a refused creation leaves no case and no event.
  assert.equal((await db.one("SELECT count(*) AS count FROM audit_events WHERE action = 'case.created'", [])).count, cap);
});

test('a closed case frees capacity and no cap means no limit', pg, async t => {
  const { db, cases, create, count } = await caseWorld(t, 2);
  const first = await create(0, 1);
  await assert.rejects(create(1, 1), { code: 'CASE_CAPACITY_REACHED', statusCode: 429 });
  await db.run(`UPDATE service_cases SET status = 'closed', closed_at = ? WHERE id = ?`, [new Date(START).toISOString(), first.id]);
  assert.ok((await create(1, 1)).id);
  assert.equal(await count(), 1);
  assert.ok((await cases.create({ householdId: 'household-cap-0', openedByAdultId: 'adult-cap', triggerType: 'renewal' })).id, 'no cap given: no limit');
  await assert.rejects(create(0, -1), TypeError);
});

// ---------------------------------------------------------------------------------------------
// 2. Structuring job leases
// ---------------------------------------------------------------------------------------------

const run = 'run-parameters';
const household = 'household-parameters';
const document = 'document-jobs';
const owned = { id: document, householdId: household, caseId: 'case-parameters' };
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const LINE = 'Sum insured: Rs. 5,00,000';
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const startInput = (extra = {}) => ({ document: owned, workflowRunId: run, consentGrantId: 'consent-parameters', subjectAdultId: 'adult-parameters', ...extra });

async function jobWorld(t) {
  let now = Date.parse(parameterAt);
  const clock = () => new Date(now);
  const { db: database, services } = await freshDatabase(t, { clock });
  await seedParameterWorld(database);
  await services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: 'policy-parameters/v1', ...parameterScope(), updatedBy: 'test' });
  const at = parameterAt;
  await database.prepare(`INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
    original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES (?, ?, 'case-parameters', 'adult-parameters', 'consent-parameters', 'policy_schedule', 'fixture.pdf', 'fixture/document-jobs', ?,
    'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`).run(document, household, '7'.repeat(64), at);
  await database.prepare(`INSERT INTO ocr_jobs (id, document_upload_id, provider, status, attempt_count, requested_at, completed_at, updated_at)
    VALUES ('ocr-jobs', ?, 'fixture', 'succeeded', 1, ?, ?, ?)`).run(document, at, at, at);
  const blocks = serializeStoredBlocks(1, buildStoredBlocks([
    { text: 'Schedule', tag: 'section-title', readingOrder: 1 }, { text: LINE, tag: 'paragraph', readingOrder: 2 },
  ], `Schedule\n${LINE}`));
  await database.prepare(`INSERT INTO source_pages (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
    extracted_text, extraction_status, created_at, text_sha256, blocks_json)
    VALUES ('page-jobs', ?, 'ocr-jobs', 1, 'version-1', ?, ?, 'extracted', ?, ?, ?)`).run(document, 'b'.repeat(64), `Schedule\n${LINE}`, at, 'c'.repeat(64), blocks);
  await database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-jobs', 'consent-parameters', 'document', ?, 'derive', 'insurance_document', 'google-gemini', ?)`).run(document, at);
  return { database, services, advance: ms => { now += ms; }, stamp: () => new Date(now).toISOString() };
}

// Every provider call waits on `gate`, so an attempt stays running until the test releases it.
function gatedModel() {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const calls = [];
  const call = async ({ payload }) => {
    calls.push(payload.chunks ? 'extract' : 'reconcile');
    await gate;
    return payload.chunks ? { json: { items: [] }, usage: { inputTokens: 1, outputTokens: 1 } } : { json: { conflicts: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
  };
  return { calls, release, createModelCall: () => call };
}

const instance = (services, model) => createPolicyStructuringService({
  services, loadKnownIdentifiers: async () => [], createModelCall: model.createModelCall, env: enabled, leaseMs: LEASE_MS, heartbeatMs: HEARTBEAT_MS,
});
const jobRows = database => database.prepare('SELECT * FROM policy_structuring_jobs ORDER BY attempt').all();
const flush = () => new Promise(resolve => setImmediate(resolve));
// Waits on a database condition by yielding to the event loop, bounded, never a timed sleep.
async function until(read, accept) {
  for (let turn = 0; turn < 5000; turn += 1) {
    const value = await read();
    if (accept(value)) return value;
    await flush();
  }
  throw new Error('condition not reached');
}

test('a second instance interrupts only expired-lease jobs, never another live instance\'s job', pg, async t => {
  mock.timers.enable({ apis: ['setInterval'] });
  t.after(() => mock.timers.reset());
  const { database, services, advance, stamp } = await jobWorld(t);
  const started = stamp();
  const modelA = gatedModel();
  const instanceA = instance(services, modelA);
  assert.equal((await instanceA.start(startInput())).status, 'running');
  await until(() => jobRows(database), rows => rows.length === 1);
  t.after(async () => { modelA.release(); await instanceA.settle(document, run); });
  assert.deepEqual((await jobRows(database)).map(row => [row.status, row.updated_at]), [['running', started]]);

  // Instance B starts while A's lease is current: A's job is not B's to interrupt.
  advance(HEARTBEAT_MS);
  const instanceB = instance(services, gatedModel());
  assert.equal((await instanceB.result({ document: owned, workflowRunId: run })).status, 'running');
  assert.deepEqual((await jobRows(database)).map(row => row.status), ['running']);

  // A is alive far past its first lease window because it heartbeats: instance C still leaves it alone.
  advance(HEARTBEAT_MS * 3);
  mock.timers.tick(HEARTBEAT_MS);
  const beaten = await until(() => jobRows(database), rows => rows[0].updated_at !== started);
  assert.equal(beaten[0].updated_at, stamp(), 'the heartbeat refreshed the lease');
  const instanceC = instance(services, gatedModel());
  assert.equal((await instanceC.result({ document: owned, workflowRunId: run })).status, 'running');
  assert.deepEqual((await jobRows(database)).map(row => [row.status, row.error_code]), [['running', null]]);
  assert.equal((await database.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'policy_structuring.jobs_interrupted'").get()).n, 0);

  // A dies (no more heartbeats): once its lease expires, instance D interrupts the job.
  advance(LEASE_MS + 1);
  const instanceD = instance(services, gatedModel());
  const shown = await instanceD.result({ document: owned, workflowRunId: run });
  assert.equal(shown.processingStatus, 'interrupted');
  assert.deepEqual((await jobRows(database)).map(row => [row.status, row.error_code]), [['interrupted', 'STRUCTURING_INTERRUPTED']]);
  const [audit] = await database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'policy_structuring.jobs_interrupted'").all();
  assert.deepEqual(JSON.parse(audit.event_payload_json), { jobs: 1 });
  await assert.rejects(() => instanceD.start(startInput()), error => error.code === 'STRUCTURING_RESTART_REQUIRED' && error.priorStatus === 'interrupted');
});

test('the repository interrupts by lease and keeps the explicit interrupt-all mode', pg, async t => {
  const { database, services, advance } = await jobWorld(t);
  const repository = services.policyStructuring;
  const [grant] = ['consent-parameters'];
  const job = await repository.startJob({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion: 'policy-structuring/v2', consentGrantId: grant,
  });
  assert.equal(await repository.interruptRunningJobs({ leaseMs: LEASE_MS }), 0, 'a fresh lease survives');
  advance(LEASE_MS - 1);
  assert.equal(await repository.heartbeatJob({ jobId: job.id }), true);
  advance(LEASE_MS - 1);
  assert.equal(await repository.interruptRunningJobs({ leaseMs: LEASE_MS }), 0, 'a heartbeat renews the lease');
  advance(1);
  assert.equal(await repository.interruptRunningJobs({ leaseMs: LEASE_MS }), 1, 'the lease expires exactly at the limit');
  assert.equal(await repository.heartbeatJob({ jobId: job.id }), false, 'a finished job is not revived');
  assert.deepEqual((await jobRows(database)).map(row => row.status), ['interrupted']);
  await assert.rejects(repository.interruptRunningJobs({ leaseMs: -1 }), { code: 'STRUCTURING_INPUT_INVALID' });
  const second = await repository.startJob({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion: 'policy-structuring/v2', consentGrantId: grant,
  });
  assert.equal(second.attempt, 2);
  assert.equal(await repository.interruptRunningJobs(), 1, 'no leaseMs: every active job (single-process takeover)');
});
