import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { buildStoredBlocks, serializeStoredBlocks } from '../src/features/input/index.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';

// Durable minimal job state (in-memory jobs defect): structuring attempts lived only in a Map, so a
// restart lost them and nothing stopped a silent paid rerun. Fake callers only, zero network.
const pgOptions = postgresTestOptions();
const run = 'run-parameters';
const household = 'household-parameters';
const document = 'document-jobs';
const owned = { id: document, householdId: household, caseId: 'case-parameters' };
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const LINE = 'Sum insured: Rs. 5,00,000';
const startInput = (extra = {}) => ({ document: owned, workflowRunId: run, consentGrantId: 'consent-parameters', subjectAdultId: 'adult-parameters', ...extra });

async function open(t) {
  const { db: database, services } = await freshDatabase(t, { clock: () => new Date(at) });
  await seedParameterWorld(database);
  await services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: 'policy-parameters/v1', ...parameterScope(), updatedBy: 'test' });
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
  return { database, services };
}

// Counts every provider call. mode: 'answer' | 'hang' | 'fail'. A `gate` promise holds every
// call until it resolves, so an attempt stays running for as long as a test needs it.
function fakeModel(mode = 'answer', { gate } = {}) {
  const calls = [];
  const call = async ({ payload }) => {
    calls.push(payload.chunks ? 'extract' : 'reconcile');
    if (gate) await gate;
    if (mode === 'hang') return new Promise(() => {});
    if (mode === 'fail') throw Object.assign(new Error('synthetic provider failure'), { code: 'PROVIDER_FAILED' });
    if (!payload.chunks) return { json: { conflicts: [] }, usage: { inputTokens: 1, outputTokens: 1 } };
    const items = payload.chunks.filter(chunk => chunk.text.includes(LINE)).map(chunk => ({
      chunk_id: chunk.chunk_id, registry_key: 'd.sum_insured', value: 'Rs. 5,00,000', subject: 'policy',
      evidence_quote: LINE, page: chunk.page, block_index: chunk.block_indexes.at(-1),
    }));
    return { json: { items }, usage: { inputTokens: 10, outputTokens: 2 } };
  };
  return { calls, createModelCall: () => call };
}

const service = (services, model) => createPolicyStructuringService({ services, loadKnownIdentifiers: async () => [], createModelCall: model.createModelCall, env: enabled });
const jobRows = database => database.prepare('SELECT * FROM policy_structuring_jobs ORDER BY attempt').all();
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a restart turns a running attempt into interrupted and never re-dispatches it (in-memory jobs defect)', pgOptions, async t => {
  const { database, services } = await open(t);
  const first = fakeModel('hang');
  const before = service(services, first);
  assert.equal((await before.start(startInput())).status, 'running');
  await flush();
  assert.deepEqual((await jobRows(database)).map(row => [row.status, row.attempt]), [['running', 1]]);
  assert.equal((await before.result({ document: owned, workflowRunId: run })).status, 'running');

  // A new process on the same database. Every public method waits for start-up recovery first.
  const model = fakeModel();
  const after = service(services, model);
  const shown = await after.result({ document: owned, workflowRunId: run });
  assert.deepEqual((await jobRows(database)).map(row => [row.status, row.error_code]), [['interrupted', 'STRUCTURING_INTERRUPTED']]);
  assert.equal(shown.status, 'interrupted');
  assert.equal(shown.processingStatus, 'interrupted');
  await flush();
  assert.equal(model.calls.length, 0, 'nothing re-dispatched on start-up');
  const [audit] = await database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'policy_structuring.jobs_interrupted'").all();
  assert.deepEqual(JSON.parse(audit.event_payload_json), { jobs: 1 });

  await assert.rejects(() => after.start(startInput()), error => error.code === 'STRUCTURING_RESTART_REQUIRED' && error.statusCode === 409
    && error.priorStatus === 'interrupted');
  await assert.rejects(() => after.start(startInput({ restart: 'yes' })), { code: 'VALIDATION_ERROR' });
  assert.equal(model.calls.length, 0, 'no paid call without an explicit restart');

  assert.equal((await after.start(startInput({ restart: true }))).status, 'running');
  await after.settle(document, run);
  assert.deepEqual((await jobRows(database)).map(row => [row.status, row.attempt]), [['interrupted', 1], ['committed', 2]]);
  const committed = (await jobRows(database))[1];
  assert.ok(committed.structuring_run_id);
  assert.equal(committed.evidence_outcome, 'partial_review_required');
  assert.equal((await after.result({ document: owned, workflowRunId: run })).status, 'finished');

  // A committed run replays with zero calls.
  const calls = model.calls.length;
  assert.equal((await after.start(startInput())).status, 'finished');
  assert.equal((await after.start(startInput({ restart: true }))).status, 'finished');
  assert.equal(model.calls.length, calls);
  assert.equal((await jobRows(database)).length, 2);
});

test('concurrent starts create one running attempt and one paid run', pgOptions, async t => {
  const { database, services } = await open(t);
  // The provider call is held open so the attempt is still running when the second start is tried.
  let release;
  const model = fakeModel('answer', { gate: new Promise(resolve => { release = resolve; }) });
  const structuring = service(services, model);
  const started = await Promise.all([startInput(), startInput(), startInput({ restart: true })].map(input => structuring.start(input)));
  assert.deepEqual(started.map(body => body.status), ['running', 'running', 'running']);
  assert.equal((await jobRows(database)).filter(row => row.status === 'running').length, 1);
  await assert.rejects(() => services.policyStructuring.startJob({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1',
    pipelineVersion: 'policy-structuring/v2', consentGrantId: 'consent-parameters',
  }), { code: 'STRUCTURING_ALREADY_RUNNING' });
  release();
  await structuring.settle(document, run);
  assert.equal(model.calls.filter(kind => kind === 'extract').length, 1);
  assert.equal((await jobRows(database)).length, 1);
});

test('a failed attempt is recorded with codes only and needs restart: true', pgOptions, async t => {
  const { database, services } = await open(t);
  const failing = fakeModel('fail');
  const structuring = service(services, failing);
  await structuring.start(startInput());
  await structuring.settle(document, run);
  const [row] = await jobRows(database);
  assert.deepEqual([row.status, row.evidence_outcome, row.error_code, row.structuring_run_id], ['failed', 'failed', 'STRUCTURING_EVIDENCE_INSUFFICIENT', null]);
  const shown = await structuring.result({ document: owned, workflowRunId: run });
  assert.deepEqual([shown.status, shown.evidenceOutcome, shown.errorCode], ['finished', 'failed', 'STRUCTURING_EVIDENCE_INSUFFICIENT']);
  await assert.rejects(() => structuring.start(startInput()), error => error.code === 'STRUCTURING_RESTART_REQUIRED' && error.priorStatus === 'failed');
  assert.equal(failing.calls.filter(kind => kind === 'extract').length, 1);
  assert.equal((await structuring.start(startInput({ restart: true }))).status, 'running');
  await structuring.settle(document, run);
  assert.deepEqual((await jobRows(database)).map(row => row.attempt), [1, 2]);
  // Job rows carry identifiers, statuses and codes only.
  const stored = JSON.stringify(await jobRows(database));
  for (const text of ['Sum insured', '5,00,000', 'Schedule']) assert.equal(stored.includes(text), false, `job rows hold no ${text}`);
});

test('revocation stamps the jobs of the document erased, keeps their status and needs no restart', pgOptions, async t => {
  const { database, services } = await open(t);
  const structuring = service(services, fakeModel('fail'));
  await structuring.start(startInput());
  await structuring.settle(document, run);
  await services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  const [row] = await jobRows(database);
  assert.equal(row.status, 'failed', 'status kept');
  assert.equal(row.erasure_reason_code, 'consent_revoked');
  assert.match(row.erased_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal((await structuring.result({ document: owned, workflowRunId: run })).status, 'erased');
  const counts = await services.policyStructuring.eraseDerived({ householdId: household, documentIds: [document], reasonCode: 'consent_revoked' });
  assert.equal(counts.jobs, 0, 'idempotent');
});

test('database guards: scope, active start, identity, final status, no delete, erase with document', pgOptions, async t => {
  const { database, services } = await open(t);
  const insert = (extra = {}) => {
    const row = {
      id: 'job-x', household_id: household, workflow_run_id: run, document_id: document, status: 'running', attempt: 1,
      finished_at: null, erased_at: null, erasure_reason_code: null, ...extra,
    };
    return database.prepare(`INSERT INTO policy_structuring_jobs
      (id, household_id, case_id, workflow_run_id, document_id, source_version, pipeline_version, status, attempt, consent_grant_id,
       started_at, updated_at, finished_at, erased_at, erasure_reason_code)
      VALUES (?, ?, 'case-parameters', ?, ?, 'version-1', 'policy-structuring/v2', ?, ?,
        'consent-parameters', ?, ?, ?, ?, ?)`).run(row.id, row.household_id, row.workflow_run_id, row.document_id, row.status, row.attempt,
      at, at, row.finished_at, row.erased_at, row.erasure_reason_code);
  };
  const scope = { message: /policy structuring job must start active/ };
  await assertDbError(insert({ status: 'committed', finished_at: at }), scope);
  await assertDbError(insert({ erased_at: at, erasure_reason_code: 'consent_revoked' }), scope);
  await assert.rejects(insert({ document_id: 'document-missing' }), error => error.code === '23503' || /policy structuring job/.test(error.message));
  await insert();
  // One active attempt per key.
  await assertDbError(insert({ id: 'job-y', attempt: 2 }), { sqlstate: '23505' });
  const appendOnly = { message: /policy structuring jobs are append only/ };
  const update = sql => database.prepare(`UPDATE policy_structuring_jobs SET ${sql} WHERE id = 'job-x'`).run();
  await assertDbError(update('attempt = 9'), appendOnly);
  await update(`status = 'failed', error_code = 'PROVIDER_FAILED', finished_at = '${at}'`);
  await assertDbError(update("status = 'running', finished_at = NULL"), appendOnly);
  await assertDbError(update("error_code = 'OTHER_CODE'"), appendOnly);
  await assertDbError(update("error_code = 'not a code'"), { message: /violates check constraint|append only/ });
  await assertDbError(database.prepare("DELETE FROM policy_structuring_jobs WHERE id = 'job-x'").run(), appendOnly);
  await database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(document);
  const row = await database.prepare("SELECT status, erasure_reason_code FROM policy_structuring_jobs WHERE id = 'job-x'").get();
  assert.deepEqual({ ...row }, { status: 'failed', erasure_reason_code: 'document_erasure' });
  await assertDbError(update(`erased_at = '${at}', erasure_reason_code = 'consent_revoked'`), appendOnly);
  assert.equal(await services.policyStructuring.finishJob({ jobId: 'job-x', status: 'committed' }), false, 'a finished attempt is final');
});
