import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { buildStoredBlocks, serializeStoredBlocks } from '../src/features/input/index.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Durable minimal job state (in-memory jobs defect): structuring attempts lived only in a Map, so a
// restart lost them and nothing stopped a silent paid rerun. Fake callers only, zero network.
const run = 'run-parameters';
const household = 'household-parameters';
const document = 'document-jobs';
const owned = { id: document, householdId: household, caseId: 'case-parameters' };
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const LINE = 'Sum insured: Rs. 5,00,000';
const startInput = (extra = {}) => ({ document: owned, workflowRunId: run, consentGrantId: 'consent-parameters', subjectAdultId: 'adult-parameters', ...extra });

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: 'policy-parameters/v1', ...parameterScope(), updatedBy: 'test' });
  database.prepare(`INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
    original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES (?, ?, 'case-parameters', 'adult-parameters', 'consent-parameters', 'policy_schedule', 'fixture.pdf', 'fixture/document-jobs', ?,
    'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`).run(document, household, '7'.repeat(64), at);
  database.prepare(`INSERT INTO ocr_jobs (id, document_upload_id, provider, status, attempt_count, requested_at, completed_at, updated_at)
    VALUES ('ocr-jobs', ?, 'fixture', 'succeeded', 1, ?, ?, ?)`).run(document, at, at, at);
  const blocks = serializeStoredBlocks(1, buildStoredBlocks([
    { text: 'Schedule', tag: 'section-title', readingOrder: 1 }, { text: LINE, tag: 'paragraph', readingOrder: 2 },
  ], `Schedule\n${LINE}`));
  database.prepare(`INSERT INTO source_pages (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
    extracted_text, extraction_status, created_at, text_sha256, blocks_json)
    VALUES ('page-jobs', ?, 'ocr-jobs', 1, 'version-1', ?, ?, 'extracted', ?, ?, ?)`).run(document, 'b'.repeat(64), `Schedule\n${LINE}`, at, 'c'.repeat(64), blocks);
  database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-jobs', 'consent-parameters', 'document', ?, 'derive', 'insurance_document', 'google-gemini', ?)`).run(document, at);
  return { database, services };
}

// Counts every provider call. mode: 'answer' | 'hang' | 'fail'.
function fakeModel(mode = 'answer') {
  const calls = [];
  const call = async ({ payload }) => {
    calls.push(payload.chunks ? 'extract' : 'reconcile');
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

test('a restart turns a running attempt into interrupted and never re-dispatches it (in-memory jobs defect)', async t => {
  const { database, services } = open(t);
  const first = fakeModel('hang');
  const before = service(services, first);
  assert.equal(before.start(startInput()).status, 'running');
  await flush();
  assert.deepEqual(jobRows(database).map(row => [row.status, row.attempt]), [['running', 1]]);
  assert.equal(before.result({ document: owned, workflowRunId: run }).status, 'running');

  // A new process on the same database.
  const model = fakeModel();
  const after = service(services, model);
  assert.deepEqual(jobRows(database).map(row => [row.status, row.error_code]), [['interrupted', 'STRUCTURING_INTERRUPTED']]);
  const shown = after.result({ document: owned, workflowRunId: run });
  assert.equal(shown.status, 'interrupted');
  assert.equal(shown.processingStatus, 'interrupted');
  await flush();
  assert.equal(model.calls.length, 0, 'nothing re-dispatched on start-up');
  const [audit] = database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'policy_structuring.jobs_interrupted'").all();
  assert.deepEqual(JSON.parse(audit.event_payload_json), { jobs: 1 });

  assert.throws(() => after.start(startInput()), error => error.code === 'STRUCTURING_RESTART_REQUIRED' && error.statusCode === 409
    && error.priorStatus === 'interrupted');
  assert.throws(() => after.start(startInput({ restart: 'yes' })), { code: 'VALIDATION_ERROR' });
  assert.equal(model.calls.length, 0, 'no paid call without an explicit restart');

  assert.equal(after.start(startInput({ restart: true })).status, 'running');
  await after.settle(document, run);
  assert.deepEqual(jobRows(database).map(row => [row.status, row.attempt]), [['interrupted', 1], ['committed', 2]]);
  const committed = jobRows(database)[1];
  assert.ok(committed.structuring_run_id);
  assert.equal(committed.evidence_outcome, 'partial_review_required');
  assert.equal(after.result({ document: owned, workflowRunId: run }).status, 'finished');

  // A committed run replays with zero calls.
  const calls = model.calls.length;
  assert.equal(after.start(startInput()).status, 'finished');
  assert.equal(after.start(startInput({ restart: true })).status, 'finished');
  assert.equal(model.calls.length, calls);
  assert.equal(jobRows(database).length, 2);
});

test('concurrent starts create one running attempt and one paid run', async t => {
  const { database, services } = open(t);
  const model = fakeModel();
  const structuring = service(services, model);
  assert.equal(structuring.start(startInput()).status, 'running');
  assert.equal(structuring.start(startInput()).status, 'running');
  assert.equal(structuring.start(startInput({ restart: true })).status, 'running');
  assert.equal(jobRows(database).filter(row => row.status === 'running').length, 1);
  assert.throws(() => services.policyStructuring.startJob({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1',
    pipelineVersion: 'policy-structuring/v2', consentGrantId: 'consent-parameters',
  }), { code: 'STRUCTURING_ALREADY_RUNNING' });
  await structuring.settle(document, run);
  assert.equal(model.calls.filter(kind => kind === 'extract').length, 1);
  assert.equal(jobRows(database).length, 1);
});

test('a failed attempt is recorded with codes only and needs restart: true', async t => {
  const { database, services } = open(t);
  const failing = fakeModel('fail');
  const structuring = service(services, failing);
  structuring.start(startInput());
  await structuring.settle(document, run);
  const [row] = jobRows(database);
  assert.deepEqual([row.status, row.evidence_outcome, row.error_code, row.structuring_run_id], ['failed', 'failed', 'STRUCTURING_EVIDENCE_INSUFFICIENT', null]);
  const shown = structuring.result({ document: owned, workflowRunId: run });
  assert.deepEqual([shown.status, shown.evidenceOutcome, shown.errorCode], ['finished', 'failed', 'STRUCTURING_EVIDENCE_INSUFFICIENT']);
  assert.throws(() => structuring.start(startInput()), error => error.code === 'STRUCTURING_RESTART_REQUIRED' && error.priorStatus === 'failed');
  assert.equal(failing.calls.filter(kind => kind === 'extract').length, 1);
  assert.equal(structuring.start(startInput({ restart: true })).status, 'running');
  await structuring.settle(document, run);
  assert.deepEqual(jobRows(database).map(row => row.attempt), [1, 2]);
  // Job rows carry identifiers, statuses and codes only.
  const stored = JSON.stringify(jobRows(database));
  for (const text of ['Sum insured', '5,00,000', 'Schedule']) assert.equal(stored.includes(text), false, `job rows hold no ${text}`);
});

test('revocation stamps the jobs of the document erased, keeps their status and needs no restart', async t => {
  const { database, services } = open(t);
  const structuring = service(services, fakeModel('fail'));
  structuring.start(startInput());
  await structuring.settle(document, run);
  services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  const [row] = jobRows(database);
  assert.equal(row.status, 'failed', 'status kept');
  assert.equal(row.erasure_reason_code, 'consent_revoked');
  assert.match(row.erased_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(structuring.result({ document: owned, workflowRunId: run }).status, 'erased');
  const counts = services.policyStructuring.eraseDerived({ householdId: household, documentIds: [document], reasonCode: 'consent_revoked' });
  assert.equal(counts.jobs, 0, 'idempotent');
});

test('database guards: scope, active start, identity, final status, no delete, erase with document', t => {
  const { database, services } = open(t);
  const insert = (extra = {}) => database.prepare(`INSERT INTO policy_structuring_jobs
    (id, household_id, case_id, workflow_run_id, document_id, source_version, pipeline_version, status, attempt, consent_grant_id,
     started_at, updated_at, finished_at, erased_at, erasure_reason_code)
    VALUES (@id, @household_id, 'case-parameters', @workflow_run_id, @document_id, 'version-1', 'policy-structuring/v2', @status, @attempt,
      'consent-parameters', @at, @at, @finished_at, @erased_at, @erasure_reason_code)`).run({
    id: 'job-x', household_id: household, workflow_run_id: run, document_id: document, status: 'running', attempt: 1, at,
    finished_at: null, erased_at: null, erasure_reason_code: null, ...extra,
  });
  const scope = /policy structuring job must start active/;
  assert.throws(() => insert({ status: 'committed', finished_at: at }), scope);
  assert.throws(() => insert({ erased_at: at, erasure_reason_code: 'consent_revoked' }), scope);
  assert.throws(() => insert({ document_id: 'document-missing' }), /FOREIGN KEY|policy structuring job/);
  insert();
  assert.throws(() => insert({ id: 'job-y', attempt: 2 }), /UNIQUE constraint failed/, 'one active attempt per key');
  const appendOnly = /policy structuring jobs are append only/;
  const update = sql => database.prepare(`UPDATE policy_structuring_jobs SET ${sql} WHERE id = 'job-x'`).run();
  assert.throws(() => update("attempt = 9"), appendOnly);
  update(`status = 'failed', error_code = 'PROVIDER_FAILED', finished_at = '${at}'`);
  assert.throws(() => update("status = 'running', finished_at = NULL"), appendOnly);
  assert.throws(() => update("error_code = 'OTHER_CODE'"), appendOnly);
  assert.throws(() => update("error_code = 'not a code'"), /CHECK constraint failed|append only/);
  assert.throws(() => database.prepare("DELETE FROM policy_structuring_jobs WHERE id = 'job-x'").run(), appendOnly);
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(document);
  const row = database.prepare("SELECT status, erasure_reason_code FROM policy_structuring_jobs WHERE id = 'job-x'").get();
  assert.deepEqual({ ...row }, { status: 'failed', erasure_reason_code: 'document_erasure' });
  assert.throws(() => update(`erased_at = '${at}', erasure_reason_code = 'consent_revoked'`), appendOnly);
  assert.equal(services.policyStructuring.finishJob({ jobId: 'job-x', status: 'committed' }), false, 'a finished attempt is final');
});
