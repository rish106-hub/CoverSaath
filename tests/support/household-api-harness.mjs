// Real-application harness for Block 4 API tests: upload, Sarvam OCR (mocked HTTP), clauses, Gemini (mocked SDK driver),
// stored answers, consents. No provider call leaves the process. Synthetic data only.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './temp-root.mjs';
import { openDatabase } from '../../src/backend/database/index.js';
import { createApiServer } from '../../src/server/server.js';

export const bootstrapToken = 'coversaath-household-api-bootstrap-token-01';
export const NUMBERS = ['SYN-PERS-410001', 'SYN-GRP-820002', 'SYN-TOP-930003'];
const RENT = ['Rs 5,000', 'Rs 8,000', 'Rs 12,000'];
const pagesFor = index => [[
  { text: 'SYNTHETIC TEST DATA - NOT A REAL POLICY', tag: 'paragraph' },
  { text: `Policy Schedule - Synthetic Plan ${index + 1}`, tag: 'headline' },
  { text: `Policy Number: ${NUMBERS[index]}`, tag: 'paragraph' },
  { text: `Room rent limit: ${RENT[index]} per day`, tag: 'paragraph' },
]];

function stubDriver(requests) {
  return {
    loadModel: async () => ({ mocked: true }),
    createAgent: settings => ({
      generate: async ({ prompt }) => {
        requests.push({ agentId: settings.id, prompt });
        const payload = JSON.parse(prompt);
        if (settings.id === 'knowvia-policy_evidence_investigate') {
          const findings = payload.clauses.flatMap(clause => {
            const line = clause.text.split('\n').find(text => text.startsWith('Room rent limit:'));
            return line ? [{ clause_ids: [clause.clause_id], quote: line, subject: 'room rent', conditions: [], exceptions: [] }] : [];
          });
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
    if (parsed.pathname.endsWith('/digitise')) { submissions += 1; return providerJson({ job_id: `structuring-job-${submissions}`, status: 'pending' }, 201); }
    const jobId = parsed.pathname.split('/').at(-2);
    if (parsed.pathname.endsWith('/status')) return providerJson({ job_id: jobId, status: 'completed' });
    if (parsed.pathname.endsWith('/results')) {
      const pages = pagesFor((Number(jobId.split('-').at(-1)) - 1) % NUMBERS.length);
      return providerJson({
        type: 'digitise', job_id: jobId, status: 'completed',
        usage: { pages_total: pages.length, pages_processed: pages.length, pages_succeeded: pages.length, pages_failed: 0 },
        documents: [{ pages: pages.map((blocks, index) => ({ page_num: index + 1, blocks: blocks.map((block, order) => ({ block_id: `p${index + 1}b${order}`, text: block.text, layout_tag: block.tag, reading_order: order + 1 })) })) }],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

const pdf = async width => {
  const document = await PDFDocument.create();
  document.addPage([width, 400]);
  return Buffer.from(await document.save({ useObjectStreams: false }));
};

export async function eventually(check, { timeoutMs = 3000 } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Condition not met in time.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

export async function startApp(t, { env: extraEnv = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-household-'));
  const database = openDatabase({ path: join(directory, 'app.sqlite') });
  const requests = [];
  const env = {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, DOCUMENT_STORAGE_PATH: join(directory, 'documents'), DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only', SARVAM_OCR_RETRY_DELAY_MS: '0', SARVAM_OCR_POLL_INTERVAL_MS: '0',
    LLM_PROVIDER: 'google', GEMINI_API_KEY: 'test-only-not-a-real-key', LLM_MODEL: 'mock-gemini', LLM_MODEL_VERSION: 'mock-gemini-v1',
    LLM_INPUT_USD_PER_MILLION: '0.75', LLM_OUTPUT_USD_PER_MILLION: '4.50', ORCHESTRATION_RUN_BUDGET_USD: '0.25', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
    POLICY_STRUCTURING_ENABLED: 'true', POLICY_EVIDENCE_ENABLED: 'true', ...extraEnv,
  };
  const server = createApiServer({
    database, env, sarvamFetch: sarvamFetch(), analysisLiveModelDriver: stubDriver(requests),
    documentScanner: { mode: 'clamd', async scan() { return { status: 'clean' }; }, async ping() { return true; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, rawBody, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method, headers: { ...(body || rawBody ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(rawBody !== undefined ? { body: rawBody } : body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { database, requests, call, base, env };
}

/** A household with one case holding `documents` uploaded and OCR'd policies and a document-specific Gemini grant. */
export async function household(app, { name = 'Household', documents = 1 } = {}) {
  const { call } = app;
  const identity = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: `${name} household`, owner: { displayName: `${name} Owner Synthetic` } } });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const memberId = identity.data.ownerMember.id;
  const opened = await call('/api/v1/cases', { method: 'POST', token, body: { householdId, subjectMemberId: memberId, triggerType: 'planned_care' } });
  const caseId = opened.data.id;
  const processing = await call('/api/v1/consents', { method: 'POST', token, body: { householdId, subjectAdultId: adultId, purpose: 'document_processing', scopes: [
    { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
    { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: adultId },
  ] } });
  assert.equal(processing.status, 201);
  const documentIds = [];
  for (let index = 0; index < documents; index += 1) {
    const upload = await fetch(`${app.base}/api/v1/cases/${caseId}/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(), 'X-Document-Kind': 'policy_schedule', 'X-Consent-Grant-Id': processing.data.id, 'X-Filename': `synthetic-${index}.pdf` },
      body: await pdf(300 + index + (name.length * 7)),
    });
    assert.equal(upload.status, 201);
    const documentId = (await upload.json()).document.id;
    await eventually(() => app.database.prepare(`SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'active' AND malware_status = 'clean'`).get(documentId));
    const sarvam = await call('/api/v1/consents', { method: 'POST', token, body: { householdId, subjectAdultId: adultId, grantedToActor: 'sarvam', purpose: 'document_processing', scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] } });
    const ocr = await call(`/api/v1/documents/${documentId}/ocr-jobs`, { method: 'POST', token, body: { consentGrantId: sarvam.data.id } });
    assert.equal(ocr.status, 202, JSON.stringify(ocr.data));
    const refreshed = await call(`/api/v1/ocr-jobs/${ocr.data.job.id}/refresh`, { method: 'POST', token, body: { consentGrantId: sarvam.data.id } });
    assert.equal(refreshed.data.job.status, 'succeeded', JSON.stringify(refreshed.data));
    documentIds.push(documentId);
  }
  const questionGrant = await call('/api/v1/consents', { method: 'POST', token, body: { householdId, subjectAdultId: adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
    scopes: documentIds.map(documentId => ({ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_question', recipient: 'google-gemini' })) } });
  assert.equal(questionGrant.status, 201, JSON.stringify(questionGrant.data));
  return { token, householdId, adultId, memberId, caseId, documentIds, questionGrantId: questionGrant.data.id, processingGrantId: processing.data.id };
}

export const ask = (app, s, { documentIds = s.documentIds, question = 'What is the room rent limit?', token = s.token, caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/questions`, {
  method: 'POST', token, headers: { 'Idempotency-Key': randomUUID() }, body: { question, consentGrantId: s.questionGrantId, ...(documentIds.length > 1 || documentIds !== s.documentIds ? { documentIds } : {}) },
});

export const preview = (app, householdId, body, { token, rawBody } = {}) => app.call(`/api/v1/households/${householdId}/coverage-preview`, { method: 'POST', token, ...(rawBody !== undefined ? { rawBody } : { body }) });
export const scenarioBody = (sources, scenario = {}) => ({ contractVersion: 'household-scenario/v1', sources, scenario: { scenarioType: 'general_benefit', topic: 'room rent', ...scenario } });

/** Row counts of every application table: a read-only route must leave all of them unchanged. */
export function tableCounts(database) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").all().map(row => row.name);
  return Object.fromEntries(tables.map(name => { try { return [name, database.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n]; } catch { return [name, null]; } }));
}
