// P1-A: request/response schemas of the existing analysis-run routes, checked against the
// real server on the loopback interface (127.0.0.1, as tests/backend-api.test.mjs does).
// Synthetic data only; no external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';
import {
  ANALYSIS_RUN_ROUTES,
  validateAnalysisJob,
  validateAnalysisTaskSummary,
  validateApiErrorBody,
  validateCreateAnalysisRunRequest,
  validateCreateAnalysisRunResponse,
} from '../src/contracts/analysis-run-api.js';
import { ANALYSIS_ERROR_CODES } from '../src/contracts/error-codes.js';

const apiCode = { code: 'API_CONTRACT_INVALID' };
const bootstrapToken = 'knowvia-p1a-bootstrap-token-000001';
const headers = { 'idempotency-key': 'p1a-request-key' };

test('P1-A API: the create-run request validator mirrors the route rules and rejects unknown fields', () => {
  assert.deepEqual(validateCreateAnalysisRunRequest({ caseId: 'case-1', headers, body: { consentGrantId: ' consent-1 ' } }), {
    caseId: 'case-1', idempotencyKey: 'p1a-request-key', consentGrantId: 'consent-1', executionMode: 'fixture', modelPermission: false, fixtureVariant: 'standard',
  });
  assert.equal(validateCreateAnalysisRunRequest({ caseId: 'case-1', headers, body: { consentGrantId: 'c', executionMode: 'live', modelPermission: true } }).executionMode, 'live');
  const rejected = [
    [{ caseId: 'case-1', headers: {}, body: { consentGrantId: 'c' } }, /Idempotency-Key/],
    [{ caseId: 'case-1', headers: { 'idempotency-key': 'short' }, body: { consentGrantId: 'c' } }, /Idempotency-Key/],
    [{ caseId: 'case-1', headers, body: {} }, /consentGrantId/],
    [{ caseId: 'case-1', headers, body: { consentGrantId: '   ' } }, /consentGrantId/],
    [{ caseId: 'case-1', headers, body: { consentGrantId: 'c', executionMode: 'batch' } }, /executionMode/],
    [{ caseId: 'case-1', headers, body: { consentGrantId: 'c', executionMode: 'live' } }, /modelPermission=true/],
    [{ caseId: 'case-1', headers, body: { consentGrantId: 'c', modelPermission: 'yes' } }, /boolean/],
    [{ caseId: 'case-1', headers, body: { consentGrantId: 'c', fixtureVariant: 'other' } }, /fixtureVariant/],
    [{ caseId: 'case-1', headers, body: { consentGrantId: 'c', workflowVersion: '5' } }, /unknown field\(s\): workflowVersion/],
    [{ caseId: '', headers, body: { consentGrantId: 'c' } }, /caseId/],
    [{ caseId: 'case-1', headers, body: null }, /must be an object/],
  ];
  for (const [request, message] of rejected) assert.throws(() => validateCreateAnalysisRunRequest(request), { ...apiCode, message }, String(message));
  assert.deepEqual(Object.keys(ANALYSIS_RUN_ROUTES), ['createRun', 'getJob', 'getTask']);
});

test('P1-A API: error bodies are validated in both shapes the server emits', () => {
  assert.deepEqual(validateApiErrorBody({ error: { code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'm' } }), { shape: 'coded', code: 'IDEMPOTENCY_KEY_REQUIRED', message: 'm' });
  assert.deepEqual(validateApiErrorBody({ error: 'Plain message.' }), { shape: 'legacy_message', code: null, message: 'Plain message.' });
  assert.throws(() => validateApiErrorBody({ error: { code: 'X', message: 'm', stack: 's' } }), apiCode);
  assert.throws(() => validateApiErrorBody({ error: { code: 'lowercase', message: 'm' } }), apiCode);
  assert.throws(() => validateApiErrorBody({ error: 'm', detail: 'x' }), apiCode);
});

async function start(t) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-p1a-api-'));
  const database = openDatabase({ path: join(directory, 'knowvia.sqlite') });
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (path, { method = 'GET', body, token, idempotencyKey } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
}

test('P1-A API: live route responses match the response schemas', async t => {
  const call = await start(t);
  const identity = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Synthetic household', owner: { displayName: 'Synthetic owner' } } });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const created = await call('/api/v1/cases', { method: 'POST', token, body: {
    householdId: identity.data.household.id, subjectMemberId: identity.data.ownerMember.id, openedByAdultId: identity.data.owner.id, triggerType: 'renewal',
  } });
  assert.equal(created.status, 201);
  const caseId = created.data.id;
  const collecting = await call(`/api/v1/cases/${caseId}/transitions`, { method: 'POST', token, body: { toStatus: 'collecting', expectedRevision: created.data.revision, actorId: identity.data.owner.id } });
  const processing = await call(`/api/v1/cases/${caseId}/transitions`, { method: 'POST', token, body: { toStatus: 'processing', expectedRevision: collecting.data.revision, actorId: identity.data.owner.id } });
  assert.equal(processing.status, 200);
  const grant = await call('/api/v1/consents', { method: 'POST', token, body: {
    householdId: identity.data.household.id, subjectAdultId: identity.data.owner.id, purpose: 'coverage_reconstruction',
    scopes: [
      { resourceType: 'case', resourceId: caseId, action: 'derive', dataCategory: 'insurance_document' },
      { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'analysis_summary', recipient: identity.data.owner.id },
    ],
  } });
  assert.equal(grant.status, 201);
  const path = `/api/v1/cases/${caseId}/analysis-runs`;
  const body = { consentGrantId: grant.data.id, executionMode: 'fixture' };
  assert.doesNotThrow(() => validateCreateAnalysisRunRequest({ caseId, headers: { 'idempotency-key': 'p1a-api-run-0001' }, body }));

  const run = await call(path, { method: 'POST', token, idempotencyKey: 'p1a-api-run-0001', body });
  assert.equal(run.status, ANALYSIS_RUN_ROUTES.createRun.createdStatus, JSON.stringify(run.data));
  validateCreateAnalysisRunResponse(run.data);
  assert.equal(run.data.workflowVersion, '6');
  assert.equal(run.data.dispatchStatus, 'fixture_completed');
  assert.equal(run.data.dag.length, 22);

  const replay = await call(path, { method: 'POST', token, idempotencyKey: 'p1a-api-run-0001', body });
  assert.equal(replay.status, ANALYSIS_RUN_ROUTES.createRun.replayStatus);
  validateCreateAnalysisRunResponse(replay.data);
  assert.deepEqual([replay.data.id, replay.data.dispatchStatus], [run.data.id, 'idempotent_existing_run']);

  const job = await call(`/api/v1/jobs/${run.data.id}`, { token });
  assert.equal(job.status, 200);
  validateAnalysisJob(job.data);
  assert.throws(() => validateAnalysisJob({ ...job.data, inputJson: '{}' }), apiCode);

  const task = await call(`/api/v1/tasks/${run.data.tasks[0].id}`, { token });
  assert.equal(task.status, 200);
  validateAnalysisTaskSummary(task.data);
  assert.throws(() => validateAnalysisTaskSummary({ ...task.data, output_json: '{}' }), apiCode);

  // Route-level errors carry a registered code with the registered status.
  const missingKey = await call(path, { method: 'POST', token, body });
  assert.equal(missingKey.status, 400);
  const missing = validateApiErrorBody(missingKey.data);
  assert.deepEqual([missing.shape, missing.code], ['coded', 'IDEMPOTENCY_KEY_REQUIRED']);
  assert.equal(ANALYSIS_ERROR_CODES[missing.code].httpStatus, missingKey.status);
  const unknownJob = await call('/api/v1/jobs/run-does-not-exist', { token });
  assert.deepEqual([unknownJob.status, validateApiErrorBody(unknownJob.data).code], [404, 'JOB_NOT_FOUND']);

  // Finding F-API-1 (ADR 0001): an error raised asynchronously by the analysis service
  // (here IDEMPOTENCY_CONFLICT) escapes the route mapper. It reaches the client as HTTP 400
  // with an uncoded message instead of the registered 409 { error: { code } }. This pins
  // today's behaviour; when the route awaits the service, update this to 409 / coded.
  const conflict = await call(path, { method: 'POST', token, idempotencyKey: 'p1a-api-run-0001', body: { ...body, fixtureVariant: 'blocked_source' } });
  const conflictError = validateApiErrorBody(conflict.data);
  assert.deepEqual([conflict.status, conflictError.shape], [400, 'legacy_message']);
  assert.equal(ANALYSIS_ERROR_CODES.IDEMPOTENCY_CONFLICT.httpStatus, 409);
});
