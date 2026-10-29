import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';

// W4 journey through the real application: upload, Sarvam OCR (mocked HTTP), stored blocks, Gemini through
// the model gateway (mocked SDK driver), deterministic validation, registry store, review result, revocation.
// Synthetic data only.

const pgOptions = postgresTestOptions();
const bootstrapToken = 'coversaath-test-bootstrap-token-0001';
const OWNER_NAME = 'Ishaan Synthetic';
const PAGES = [
  [
    { text: 'Policy Schedule', tag: 'headline' },
    { text: `Policyholder: ${OWNER_NAME}`, tag: 'paragraph' },
    { text: 'Room rent limit: 5,000 per day', tag: 'paragraph' },
    { text: 'Pre-existing disease waiting period: 3 years', tag: 'paragraph' },
  ],
  [
    { text: 'Customer Information Sheet', tag: 'headline' },
    { text: 'Pre-existing disease waiting period: 36 months of continuous coverage', tag: 'paragraph' },
    { text: 'Free look period: 15 days', tag: 'paragraph' },
  ],
];
// Readings the stub "model" returns when a chunk contains the printed phrase.
const READINGS = [
  { phrase: '5,000 per day', key: 'd.room_rent_limit' },
  { phrase: '3 years', key: 'f.ped_waiting_period' },
  { phrase: '36 months', key: 'f.ped_waiting_period' },
  { phrase: '15 days', key: 'b.free_look_period' },
];

function stubDriver(requests, { onGenerate } = {}) {
  return {
    loadModel: async () => ({ mocked: true }),
    createAgent: settings => ({
      generate: async ({ prompt }) => {
        requests.push({ agentId: settings.id, instructions: settings.instructions, prompt });
        await onGenerate?.(requests.length);
        const payload = JSON.parse(prompt);
        if (settings.id === 'knowvia-policy_structuring_reconcile') {
          return { output: { conflicts: [] }, totalUsage: { inputTokens: 40, outputTokens: 5 } };
        }
        const items = [];
        for (const chunk of payload.chunks) {
          for (const line of chunk.text.split('\n')) {
            for (const reading of READINGS.filter(entry => line.includes(entry.phrase))) {
              items.push({
                chunk_id: chunk.chunk_id, registry_key: reading.key, value: reading.phrase, subject: 'policy',
                evidence_quote: line.trim(), page: chunk.page, block_index: chunk.block_indexes[0],
                confidence: 'high', rationale: 'Printed in the chunk.',
              });
            }
          }
        }
        return { output: { items }, totalUsage: { inputTokens: 200, outputTokens: 50 } };
      },
    }),
  };
}

const providerJson = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, async text() { return JSON.stringify(value); } });

function sarvamFetch() {
  let submissions = 0;
  return async url => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/digitise')) {
      submissions += 1;
      return providerJson({ job_id: `structuring-job-${submissions}`, status: 'pending' }, 201);
    }
    const jobId = parsed.pathname.split('/').at(-2);
    if (parsed.pathname.endsWith('/status')) return providerJson({ job_id: jobId, status: 'completed' });
    if (parsed.pathname.endsWith('/results')) {
      return providerJson({
        type: 'digitise', job_id: jobId, status: 'completed',
        usage: { pages_total: 2, pages_processed: 2, pages_succeeded: 2, pages_failed: 0 },
        documents: [{ pages: PAGES.map((blocks, index) => ({
          page_num: index + 1,
          blocks: blocks.map((block, order) => ({ block_id: `p${index + 1}b${order}`, text: block.text, layout_tag: block.tag, reading_order: order + 1 })),
        })) }],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

async function twoPagePdf() {
  const document = await PDFDocument.create();
  document.addPage([300, 400]);
  document.addPage([301, 401]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

async function eventually(check, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Condition not met in time.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function startApp(t, { env: extraEnv = {}, onGenerate } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-structuring-'));
  const { db: database } = await freshDatabase(t);
  const requests = [];
  const env = {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only', SARVAM_OCR_RETRY_DELAY_MS: '0', SARVAM_OCR_POLL_INTERVAL_MS: '0',
    LLM_PROVIDER: 'google', GEMINI_API_KEY: 'test-only-not-a-real-key', LLM_MODEL: 'mock-gemini', LLM_MODEL_VERSION: 'mock-gemini-v1',
    LLM_INPUT_USD_PER_MILLION: '0.75', LLM_OUTPUT_USD_PER_MILLION: '4.50',
    ORCHESTRATION_RUN_BUDGET_USD: '0.25', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
    POLICY_STRUCTURING_ENABLED: 'true',
    ...extraEnv,
  };
  const server = createApiServer({
    database, env, sarvamFetch: sarvamFetch(), analysisLiveModelDriver: stubDriver(requests, { onGenerate }),
    documentScanner: { mode: 'clamd', async scan() { return { status: 'clean' }; }, async ping() { return true; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, database, requests, call, base };
}

// Household, case, uploaded and OCR'd document, a fixture analysis run, and a document-specific Gemini grant.
async function scenario(app, name = 'Structuring') {
  const { call } = app;
  const identity = await call('/api/v1/households', {
    method: 'POST', token: bootstrapToken, body: { displayName: `${name} household`, owner: { displayName: OWNER_NAME } },
  });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const opened = await call('/api/v1/cases', { method: 'POST', token, body: { householdId, subjectMemberId: identity.data.ownerMember.id, triggerType: 'planned_care' } });
  assert.equal(opened.status, 201);
  const caseId = opened.data.id;
  const processing = await call('/api/v1/consents', {
    method: 'POST', token,
    body: {
      householdId, subjectAdultId: adultId, purpose: 'document_processing',
      scopes: [
        { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
        { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: adultId },
      ],
    },
  });
  assert.equal(processing.status, 201);
  const upload = await fetch(`${app.base}/api/v1/cases/${caseId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(),
      'X-Document-Kind': 'policy_schedule', 'X-Consent-Grant-Id': processing.data.id, 'X-Filename': 'synthetic-policy.pdf',
    },
    body: await twoPagePdf(),
  });
  assert.equal(upload.status, 201);
  const documentId = (await upload.json()).document.id;
  await eventually(() => app.database.prepare(`SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'active' AND malware_status = 'clean'`).get(documentId));
  const sarvamGrant = await call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, grantedToActor: 'sarvam', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] },
  });
  assert.equal(sarvamGrant.status, 201);
  const ocr = await call(`/api/v1/documents/${documentId}/ocr-jobs`, { method: 'POST', token, body: { consentGrantId: sarvamGrant.data.id } });
  assert.equal(ocr.status, 202, JSON.stringify(ocr.data));
  const refreshed = await call(`/api/v1/ocr-jobs/${ocr.data.job.id}/refresh`, { method: 'POST', token, body: { consentGrantId: sarvamGrant.data.id } });
  assert.equal(refreshed.data.job.status, 'succeeded', JSON.stringify(refreshed.data));

  let revision = opened.data.revision;
  for (const toStatus of ['collecting', 'processing']) {
    const moved = await call(`/api/v1/cases/${caseId}/transitions`, { method: 'POST', token, body: { toStatus, expectedRevision: revision, actorId: adultId } });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    revision = moved.data.revision;
  }
  const coverage = await call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, purpose: 'coverage_reconstruction',
      scopes: [{ resourceType: 'case', resourceId: caseId, action: 'derive', dataCategory: 'insurance_document' }] },
  });
  assert.equal(coverage.status, 201);
  const run = await call(`/api/v1/cases/${caseId}/analysis-runs`, {
    method: 'POST', token, headers: { 'Idempotency-Key': randomUUID() }, body: { consentGrantId: coverage.data.id, executionMode: 'fixture' },
  });
  assert.ok([200, 202].includes(run.status), JSON.stringify(run.data));
  const geminiGrant = await call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' }] },
  });
  assert.equal(geminiGrant.status, 201, JSON.stringify(geminiGrant.data));
  return { token, householdId, adultId, caseId, documentId, workflowRunId: run.data.id, geminiGrantId: geminiGrant.data.id };
}

const structuringPath = s => `/api/v1/documents/${s.documentId}/structuring-runs`;
const startStructuring = (app, s, grantId = s.geminiGrantId) => app.call(structuringPath(s), {
  method: 'POST', token: s.token, body: { workflowRunId: s.workflowRunId, consentGrantId: grantId },
});
const readResult = (app, s, token = s.token) => app.call(`${structuringPath(s)}?workflowRunId=${encodeURIComponent(s.workflowRunId)}`, { token });

test('W4: an uploaded policy is structured through the app and returns a human-reviewable result', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const started = await startStructuring(app, s);
  assert.equal(started.status, 202, JSON.stringify(started.data));
  assert.equal(started.data.structuring.status, 'running');
  await app.server.structuring.settle(s.documentId, s.workflowRunId);

  const result = await readResult(app, s);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  const review = result.data.structuring;
  assert.equal(review.status, 'finished');
  assert.equal(review.processingStatus, 'finished');
  assert.equal(review.evidenceOutcome, 'partial_review_required', 'critical keys are missing from the synthetic document');
  assert.equal(review.requiresReview, true);
  assert.ok(review.missingCriticalKeys.length > 0);
  const byKey = Object.fromEntries(review.parameters.map(parameter => [parameter.key, parameter]));
  assert.equal(byKey['d.room_rent_limit'].state, 'extracted_unverified');
  assert.equal(byKey['d.room_rent_limit'].readings[0].quote, 'Room rent limit: 5,000 per day');
  assert.equal(byKey['d.room_rent_limit'].readings[0].page, 1);
  assert.equal(typeof byKey['d.room_rent_limit'].readings[0].blockIndex, 'number');
  // 3 years against 36 months is a contradiction: flagged, never resolved to one value.
  assert.equal(byKey['f.ped_waiting_period'].state, 'conflicting');
  assert.ok(review.contradictions.includes('f.ped_waiting_period'));
  assert.equal(byKey['f.ped_waiting_period'].readings.length, 2);
  assert.ok(review.parameters.every(parameter => ['extracted_unverified', 'conflicting'].includes(parameter.state)));
  assert.ok(review.parameters.every(parameter => parameter.requiresHouseholdConfirmation === true));
  assert.ok(review.missing.length > 0, 'unread registry keys are listed as missing');
  assert.equal(review.structuringRun.counts.coverage.chunks.unaccounted, 0);
  assert.ok(Array.isArray(review.skippedChunks));
  assert.ok(review.structuringRun.counts.coverage.calls >= 2);
  assert.equal(typeof review.structuringRun.counts.coverage.rejectedReasons, 'object');

  // Every provider request went through the gateway prompt contract, and the household name never left.
  assert.ok(app.requests.length >= 2);
  assert.ok(app.requests.every(request => request.agentId.startsWith('knowvia-policy_structuring_')));
  assert.ok(app.requests.every(request => request.instructions.includes('untrusted')));
  assert.equal(app.requests.some(request => request.prompt.includes('Ishaan') || request.prompt.includes('Synthetic')), false);
  // Model call usage is stored counts-only with the run; audit carries no document text.
  const audit = JSON.stringify(await app.database.prepare(`SELECT event_payload_json FROM audit_events WHERE action LIKE 'policy_structuring%'`).all());
  assert.ok(audit.includes('observations'));
  assert.equal(audit.includes('5,000 per day'), false);

  // A repeat start is a replay: no new provider call.
  const calls = app.requests.length;
  const repeated = await startStructuring(app, s);
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.structuring.status, 'finished');
  assert.equal(repeated.data.structuring.evidenceOutcome, 'partial_review_required');
  assert.equal(app.requests.length, calls);

  // Another household cannot read or start it.
  const other = await scenario(app, 'Other');
  const foreignRead = await readResult(app, s, other.token);
  assert.equal(foreignRead.status, 404);
  const foreignStart = await app.call(structuringPath(s), { method: 'POST', token: other.token, body: { workflowRunId: s.workflowRunId, consentGrantId: other.geminiGrantId } });
  assert.equal(foreignStart.status, 404);

  // Revoking the Gemini grant erases the stored readings and proposals.
  const revoked = await app.call(`/api/v1/consents/${s.geminiGrantId}/revoke`, { method: 'POST', token: s.token, body: {} });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const afterRevoke = await readResult(app, s);
  assert.equal(afterRevoke.status, 200);
  assert.equal(afterRevoke.data.structuring.status, 'erased', 'structured readings are not served after revocation');
  const remaining = (await app.database.prepare(`SELECT COUNT(*) AS n FROM coverage_parameter_observations
    WHERE document_id = ? AND extraction_method = 'document_extraction' AND redacted_at IS NULL`).get(s.documentId)).n;
  assert.equal(remaining, 0);
  // Only the Gemini-derived output went: the document and its OCR pages rest on other grants and stay.
  assert.equal((await app.database.prepare(`SELECT lifecycle_state FROM document_uploads WHERE id = ?`).get(s.documentId)).lifecycle_state, 'active');
  assert.equal((await app.database.prepare(`SELECT COUNT(*) AS n FROM source_pages WHERE document_upload_id = ? AND extracted_text IS NOT NULL AND blocks_json IS NOT NULL`).get(s.documentId)).n, 2);

  // A grant cannot name another household's document, so it can never authorise or erase across households.
  const foreignGrant = await app.call('/api/v1/consents', {
    method: 'POST', token: other.token,
    body: { householdId: other.householdId, subjectAdultId: other.adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: s.documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' }] },
  });
  assert.equal(foreignGrant.status, 404);

  // After revocation the household can consent again and structure the same document for the same run.
  const regrant = await app.call('/api/v1/consents', {
    method: 'POST', token: s.token,
    body: { householdId: s.householdId, subjectAdultId: s.adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: s.documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' }] },
  });
  assert.equal(regrant.status, 201);
  const rerun = await startStructuring(app, s, regrant.data.id);
  assert.equal(rerun.status, 202, JSON.stringify(rerun.data));
  await app.server.structuring.settle(s.documentId, s.workflowRunId);
  const again = await readResult(app, s);
  assert.equal(again.data.structuring.status, 'finished');
  assert.ok(again.data.structuring.parameters.some(parameter => parameter.key === 'd.room_rent_limit'));
});

test('W4: without a document-specific Gemini grant nothing is sent', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const sarvamOnly = (await app.database.prepare(`SELECT consent_grant_id AS id FROM consent_scopes WHERE recipient = 'sarvam' AND resource_id = ?`).get(s.documentId)).id;
  const refused = await startStructuring(app, s, sarvamOnly);
  assert.ok([403, 409, 422].includes(refused.status), JSON.stringify(refused.data));
  assert.equal(app.requests.length, 0);
});

test('W4: with the feature flag off the route refuses and no provider call happens', pgOptions, async t => {
  const app = await startApp(t, { env: { POLICY_STRUCTURING_ENABLED: 'false' } });
  const s = await scenario(app);
  const refused = await startStructuring(app, s);
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error.code, 'STRUCTURING_DISABLED');
  assert.equal(app.requests.length, 0);
});

test('W4: consent revoked during the run stops further calls and stores nothing', pgOptions, async t => {
  let app;
  let s;
  app = await startApp(t, {
    onGenerate: async count => {
      if (count === 1) {
        const revoked = await app.call(`/api/v1/consents/${s.geminiGrantId}/revoke`, { method: 'POST', token: s.token, body: {} });
        assert.equal(revoked.status, 200);
      }
    },
  });
  s = await scenario(app);
  const started = await startStructuring(app, s);
  assert.equal(started.status, 202);
  await app.server.structuring.settle(s.documentId, s.workflowRunId);
  assert.equal(app.requests.length, 1, 'no provider call after the revocation');
  const result = await readResult(app, s);
  assert.equal(result.data.structuring.status, 'erased', 'the revoked attempt is erased, never shown as a result');
  assert.match(result.data.structuring.errorCode, /^[A-Z][A-Z0-9_]+$/);
  assert.equal((await app.database.prepare('SELECT COUNT(*) AS n FROM policy_structuring_runs WHERE document_id = ?').get(s.documentId)).n, 0);
});

test('W4: a restart turns a running attempt interrupted; a new attempt and a blocks upgrade need explicit flags', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const ocrJobs = async () => (await app.database.prepare('SELECT count(*) AS n FROM ocr_jobs WHERE document_upload_id = ?').get(s.documentId)).n;
  const sarvamGrantId = (await app.database.prepare(`SELECT consent_grant_id AS id FROM consent_scopes WHERE recipient = 'sarvam' AND resource_id = ?`).get(s.documentId)).id;
  const jobsBefore = await ocrJobs();

  // OCR: a repeat normal request reuses the stored success; an upgrade of a document with blocks is refused.
  const ocrPath = `/api/v1/documents/${s.documentId}/ocr-jobs`;
  const repeat = await app.call(ocrPath, { method: 'POST', token: s.token, body: { consentGrantId: sarvamGrantId } });
  assert.equal(repeat.status, 200);
  assert.equal(repeat.data.job.outputContractVersion, 'knowvia.ocr.v2');
  const notNeeded = await app.call(ocrPath, { method: 'POST', token: s.token, body: { consentGrantId: sarvamGrantId, mode: 'blocks_upgrade', acknowledgeProviderCharge: true } });
  assert.deepEqual([notNeeded.status, notNeeded.data.error.code], [409, 'OCR_UPGRADE_NOT_NEEDED']);
  const badMode = await app.call(ocrPath, { method: 'POST', token: s.token, body: { consentGrantId: sarvamGrantId, mode: 'rerun' } });
  assert.deepEqual([badMode.status, badMode.data.error.code], [400, 'OCR_MODE_INVALID']);
  assert.equal(await ocrJobs(), jobsBefore, 'no new OCR job, so no provider charge');

  // A running attempt left by a previous process (the structuring service starts on first use).
  const sourceVersion = (await app.database.prepare('SELECT source_version FROM document_uploads WHERE id = ?').get(s.documentId)).source_version;
  await app.database.prepare(`INSERT INTO policy_structuring_jobs (id, household_id, case_id, workflow_run_id, document_id, source_version,
    pipeline_version, status, attempt, consent_grant_id, started_at, updated_at)
    VALUES ('job-previous-process', ?, ?, ?, ?, ?, 'policy-structuring/v2', 'running', 1, ?, '2026-10-20T00:00:00.000Z', '2026-10-20T00:00:00.000Z')`)
    .run(s.householdId, s.caseId, s.workflowRunId, s.documentId, sourceVersion, s.geminiGrantId);
  const shown = await readResult(app, s);
  assert.equal(shown.data.structuring.processingStatus, 'interrupted');
  const refused = await startStructuring(app, s);
  assert.deepEqual([refused.status, refused.data.error.code], [409, 'STRUCTURING_RESTART_REQUIRED']);
  const invalid = await app.call(structuringPath(s), { method: 'POST', token: s.token, body: { workflowRunId: s.workflowRunId, consentGrantId: s.geminiGrantId, restart: 'yes' } });
  assert.deepEqual([invalid.status, invalid.data.error.code], [400, 'VALIDATION_ERROR']);
  assert.equal(app.requests.length, 0, 'no model call without restart: true');
  const restarted = await app.call(structuringPath(s), { method: 'POST', token: s.token, body: { workflowRunId: s.workflowRunId, consentGrantId: s.geminiGrantId, restart: true } });
  assert.equal(restarted.status, 202, JSON.stringify(restarted.data));
  await app.server.structuring.settle(s.documentId, s.workflowRunId);
  const finished = await readResult(app, s);
  assert.equal(finished.data.structuring.processingStatus, 'finished');
  assert.deepEqual((await app.database.prepare('SELECT status, attempt FROM policy_structuring_jobs WHERE document_id = ? ORDER BY attempt').all(s.documentId))
    .map(row => [row.status, row.attempt]), [['interrupted', 1], ['committed', 2]]);
});
