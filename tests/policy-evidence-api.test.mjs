import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';

// ADR 0008 answer API through the real application: upload, Sarvam OCR (mocked HTTP), stored blocks, clauses,
// Gemini through the model gateway (mocked SDK driver), cited conditional answer. Synthetic data only.

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

function stubDriver(requests) {
  return {
    loadModel: async () => ({ mocked: true }),
    createAgent: settings => ({
      generate: async ({ prompt }) => {
        requests.push({ agentId: settings.id, instructions: settings.instructions, prompt });
        const payload = JSON.parse(prompt);
        if (settings.id === 'knowvia-policy_evidence_investigate') {
          const clause = payload.clauses.find(entry => entry.text.includes('Room rent limit: 5,000 per day'));
          const findings = clause ? [{ clause_ids: [clause.clause_id], quote: 'Room rent limit: 5,000 per day', subject: 'room rent', conditions: [], exceptions: [] }] : [];
          return { output: { findings }, totalUsage: { inputTokens: 300, outputTokens: 40 } };
        }
        if (settings.id === 'knowvia-policy_evidence_override_sweep') return { output: { overrides: [] }, totalUsage: { inputTokens: 300, outputTokens: 10 } };
        throw new Error(`unexpected agent ${settings.id}`);
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

async function startApp(t, { env: extraEnv = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-structuring-'));
  const database = openDatabase({ path: join(directory, 'app.sqlite') });
  const requests = [];
  const env = {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only', SARVAM_OCR_RETRY_DELAY_MS: '0', SARVAM_OCR_POLL_INTERVAL_MS: '0',
    LLM_PROVIDER: 'google', GEMINI_API_KEY: 'test-only-not-a-real-key', LLM_MODEL: 'mock-gemini', LLM_MODEL_VERSION: 'mock-gemini-v1',
    LLM_INPUT_USD_PER_MILLION: '0.75', LLM_OUTPUT_USD_PER_MILLION: '4.50',
    ORCHESTRATION_RUN_BUDGET_USD: '0.25', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
    POLICY_STRUCTURING_ENABLED: 'true', POLICY_EVIDENCE_ENABLED: 'true',
    ...extraEnv,
  };
  const server = createApiServer({
    database, env, sarvamFetch: sarvamFetch(), analysisLiveModelDriver: stubDriver(requests),
    documentScanner: { mode: 'clamd', async scan() { return { status: 'clean' }; }, async ping() { return true; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
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

  const grant = (dataCategory) => call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory, recipient: 'google-gemini' }] },
  });
  const questionGrant = await grant('insurance_question');
  assert.equal(questionGrant.status, 201, JSON.stringify(questionGrant.data));
  const structuringGrant = await grant('insurance_document');
  assert.equal(structuringGrant.status, 201, JSON.stringify(structuringGrant.data));
  return { token, householdId, adultId, caseId, documentId, questionGrantId: questionGrant.data.id, structuringGrantId: structuringGrant.data.id, ownerMemberId: identity.data.ownerMember.id };
}

const ask = (app, s, { grantId = s.questionGrantId, key = randomUUID(), question = 'What is the room rent limit?', token = s.token, caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/questions`, {
  method: 'POST', token, headers: { 'Idempotency-Key': key }, body: { question, consentGrantId: grantId },
});
const rows = (app, table) => app.database.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;

test('B4: a question is answered with cited, conditional evidence and replays without new provider calls', async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const key = randomUUID();
  const first = await ask(app, s, { key });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const { answer } = first.data;
  assert.notEqual(answer.state, 'sure', 'there is no verdict state');
  assert.ok(['evidence_found', 'conditional', 'insufficient_evidence'].includes(answer.state));
  assert.equal(answer.legalReview, 'required');
  assert.ok(answer.sources.length >= 1 && answer.sources[0].quote === 'Room rent limit: 5,000 per day' && answer.sources[0].page === 1);
  assert.equal(answer.overrides_checked.at(-1).status, 'completed');
  assert.deepEqual(answer.calculations, []);
  assert.equal(app.requests.length, 2, 'one investigation and one mandatory sweep');
  assert.ok(app.requests.every(request => request.agentId.startsWith('knowvia-policy_evidence_')));
  assert.ok(app.requests.every(request => !request.prompt.includes('Ishaan') && !request.prompt.includes('Synthetic')), 'the owner name never reaches the model');

  const replay = await ask(app, s, { key });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replayed, true);
  assert.equal(replay.data.answerId, first.data.answerId);
  assert.equal(app.requests.length, 2, 'a replay costs nothing');
  assert.equal((await ask(app, s, { key, question: 'A different question?' })).status, 409);

  const read = await app.call(`/api/v1/cases/${s.caseId}/questions/${first.data.answerId}`, { token: s.token });
  assert.equal(read.status, 200);
  assert.deepEqual(read.data.answer, answer);
  assert.equal(read.data.current, true);
  assert.ok(!JSON.stringify(read.data).includes('consentGrantId') && !JSON.stringify(replay.data).includes('consentGrantId'), 'access metadata is never returned');
});

test('B4: no question grant, a structuring-only grant or a disabled flag never reaches the model', async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const structuringOnly = await ask(app, s, { grantId: s.structuringGrantId });
  assert.equal(structuringOnly.status, 403, JSON.stringify(structuringOnly.data));
  assert.equal(structuringOnly.data.error.code, 'CONSENT_SCOPE_REQUIRED');
  assert.equal(app.requests.length, 0);
  const missingKey = await app.call(`/api/v1/cases/${s.caseId}/questions`, { method: 'POST', token: s.token, body: { question: 'q?', consentGrantId: s.questionGrantId } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const off = await startApp(t, { env: { POLICY_EVIDENCE_ENABLED: 'false' } });
  const s2 = await scenario(off, 'Off');
  const disabled = await ask(off, s2);
  assert.equal(disabled.status, 503);
  assert.equal(disabled.data.error.code, 'EVIDENCE_DISABLED');
  assert.equal(off.requests.length, 0);
});

test('B4: another household gets the same 404 and no stored answer is readable', async t => {
  const app = await startApp(t);
  const s = await scenario(app, 'Mine');
  const other = await scenario(app, 'Other');
  const answered = await ask(app, s);
  assert.equal(answered.status, 201, JSON.stringify(answered.data));
  const foreignPost = await ask(app, s, { token: other.token });
  const missingPost = await ask(app, s, { token: other.token, caseId: 'case-does-not-exist' });
  assert.equal(foreignPost.status, 404);
  assert.deepEqual(foreignPost.data.error, missingPost.data.error);
  const foreignGet = await app.call(`/api/v1/cases/${s.caseId}/questions/${answered.data.answerId}`, { token: other.token });
  assert.equal(foreignGet.status, 404);
  const ownCaseForeignAnswer = await app.call(`/api/v1/cases/${other.caseId}/questions/${answered.data.answerId}`, { token: other.token });
  assert.equal(ownCaseForeignAnswer.status, 404);
});

test('B4: revoking the question grant erases clauses, FTS rows and answers', async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const answered = await ask(app, s);
  assert.equal(answered.status, 201);
  assert.ok(rows(app, 'policy_clauses') > 0 && rows(app, 'policy_answers') === 1);
  const revoked = await app.call(`/api/v1/consents/${s.questionGrantId}/revoke`, { method: 'POST', token: s.token, body: {} });
  assert.ok([200, 201, 204].includes(revoked.status), JSON.stringify(revoked.data));
  assert.equal(rows(app, 'policy_clauses'), 0);
  assert.equal(rows(app, 'policy_answers'), 0);
  assert.equal((await app.call(`/api/v1/cases/${s.caseId}/questions/${answered.data.answerId}`, { token: s.token })).status, 404);
  const after = await ask(app, s, { key: randomUUID() });
  assert.ok([403, 409].includes(after.status));
  assert.equal(app.requests.length, 2, 'no new provider call after revocation');
});
