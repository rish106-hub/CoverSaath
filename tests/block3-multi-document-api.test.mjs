// Block 3 through the real application with two uploaded documents: a personal policy and a corporate (group) policy for
// the same household. Upload, Sarvam OCR (mocked HTTP), clauses, Gemini (mocked SDK driver), stored answer, decision
// catalogue, Block 4 handoff, then consent revocation. No provider call leaves the process. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';
import { assertHandoffContract } from '../src/features/decision-catalogue/index.js';

const bootstrapToken = 'coversaath-multidoc-bootstrap-token-01';
const PERSONAL_NUMBER = 'SYN-PERS-410001';
const GROUP_NUMBER = 'SYN-GRP-820002';
// One OCR result per upload, in upload order.
const DOCUMENT_PAGES = [
  [[
    { text: 'SYNTHETIC TEST DATA - NOT A REAL POLICY', tag: 'paragraph' },
    { text: 'Policy Schedule - Synthetic Personal Health Plan', tag: 'headline' },
    { text: `Policy Number: ${PERSONAL_NUMBER}`, tag: 'paragraph' },
    { text: 'Room rent limit: Rs 5,000 per day', tag: 'paragraph' },
  ]],
  [[
    { text: 'SYNTHETIC TEST DATA - NOT A REAL POLICY', tag: 'paragraph' },
    { text: 'Group Health Certificate - Synthetic Employer Cover', tag: 'headline' },
    { text: `Policy Number: ${GROUP_NUMBER}`, tag: 'paragraph' },
    { text: 'Room rent limit: Rs 8,000 per day', tag: 'paragraph' },
  ]],
];

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
    if (parsed.pathname.endsWith('/digitise')) {
      submissions += 1;
      return providerJson({ job_id: `structuring-job-${submissions}`, status: 'pending' }, 201);
    }
    const jobId = parsed.pathname.split('/').at(-2);
    if (parsed.pathname.endsWith('/status')) return providerJson({ job_id: jobId, status: 'completed' });
    if (parsed.pathname.endsWith('/results')) {
      const pages = DOCUMENT_PAGES[Number(jobId.split('-').at(-1)) - 1];
      return providerJson({
        type: 'digitise', job_id: jobId, status: 'completed',
        usage: { pages_total: pages.length, pages_processed: pages.length, pages_succeeded: pages.length, pages_failed: 0 },
        documents: [{ pages: pages.map((blocks, index) => ({
          page_num: index + 1,
          blocks: blocks.map((block, order) => ({ block_id: `p${index + 1}b${order}`, text: block.text, layout_tag: block.tag, reading_order: order + 1 })),
        })) }],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

// Distinct page sizes so the two uploads have different bytes.
async function pdf(width) {
  const document = await PDFDocument.create();
  document.addPage([width, 400]);
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

async function startApp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-multidoc-'));
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
  return { database, requests, call, base };
}

async function household(app) {
  const { call } = app;
  const identity = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Multi household', owner: { displayName: 'Member A Synthetic' } } });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const opened = await call('/api/v1/cases', { method: 'POST', token, body: { householdId, subjectMemberId: identity.data.ownerMember.id, triggerType: 'planned_care' } });
  const caseId = opened.data.id;
  const processing = await call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, purpose: 'document_processing', scopes: [
      { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
      { resourceType: 'case', resourceId: caseId, action: 'read', dataCategory: 'source_pack_metadata', recipient: adultId },
    ] },
  });
  assert.equal(processing.status, 201);
  const documentIds = [];
  for (const [index, kind] of ['policy_schedule', 'policy_schedule'].entries()) {
    const upload = await fetch(`${app.base}/api/v1/cases/${caseId}/documents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(), 'X-Document-Kind': kind, 'X-Consent-Grant-Id': processing.data.id, 'X-Filename': `synthetic-${index}.pdf` },
      body: await pdf(300 + index),
    });
    assert.equal(upload.status, 201);
    const documentId = (await upload.json()).document.id;
    await eventually(() => app.database.prepare(`SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'active' AND malware_status = 'clean'`).get(documentId));
    const sarvamGrant = await call('/api/v1/consents', {
      method: 'POST', token,
      body: { householdId, subjectAdultId: adultId, grantedToActor: 'sarvam', purpose: 'document_processing',
        scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] },
    });
    const ocr = await call(`/api/v1/documents/${documentId}/ocr-jobs`, { method: 'POST', token, body: { consentGrantId: sarvamGrant.data.id } });
    assert.equal(ocr.status, 202, JSON.stringify(ocr.data));
    const refreshed = await call(`/api/v1/ocr-jobs/${ocr.data.job.id}/refresh`, { method: 'POST', token, body: { consentGrantId: sarvamGrant.data.id } });
    assert.equal(refreshed.data.job.status, 'succeeded', JSON.stringify(refreshed.data));
    documentIds.push(documentId);
  }
  const questionGrant = await call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId, subjectAdultId: adultId, grantedToActor: 'google-gemini', purpose: 'document_processing',
      scopes: documentIds.map(documentId => ({ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_question', recipient: 'google-gemini' })) },
  });
  assert.equal(questionGrant.status, 201, JSON.stringify(questionGrant.data));
  return { token, householdId, caseId, documentIds, questionGrantId: questionGrant.data.id };
}

const ask = (app, s, body) => app.call(`/api/v1/cases/${s.caseId}/questions`, { method: 'POST', token: s.token, headers: { 'Idempotency-Key': randomUUID() }, body });
const catalogue = (app, s, answerId, query = '') => app.call(`/api/v1/cases/${s.caseId}/decision-catalogue?answerId=${encodeURIComponent(answerId)}${query}`, { token: s.token });

test('two uploaded policies: separate candidate policies, model values only as candidates, a valid handoff, revocation erases', async t => {
  const app = await startApp(t);
  const s = await household(app);

  const unnamed = await ask(app, s, { question: 'What is the room rent limit?', consentGrantId: s.questionGrantId });
  assert.equal(unnamed.status, 409, 'several current documents must be named');
  assert.equal(unnamed.data.error.code, 'POLICY_EVIDENCE_DOCUMENTS_REQUIRED');

  const answered = await ask(app, s, { question: 'What is the room rent limit?', consentGrantId: s.questionGrantId, documentIds: s.documentIds });
  assert.equal(answered.status, 201, JSON.stringify(answered.data));
  const built = await catalogue(app, s, answered.data.answerId);
  assert.equal(built.status, 200, JSON.stringify(built.data));
  const c = built.data.catalogue;

  // Each document prints exactly one number: two candidate policies, never verified by this path.
  assert.deepEqual(c.documentAssociations.map(d => d.status), ['candidate', 'candidate']);
  assert.ok(c.documentAssociations.every(d => d.verified === false));
  const [personalPolicy, groupPolicy] = c.documentAssociations.map(d => d.policyId);
  assert.notEqual(personalPolicy, groupPolicy);
  const typed = c.facts.filter(f => f.factType === 'room_rent_limit');
  assert.equal(typed.length, 2);
  assert.deepEqual(typed.map(f => f.policyId).sort(), [personalPolicy, groupPolicy].sort(), 'each value sits on its own document\'s policy');
  assert.ok(typed.every(f => f.state === 'extracted_unverified' && f.verified === false));

  const handoff = await catalogue(app, s, answered.data.answerId, '&format=handoff');
  assert.equal(handoff.status, 200);
  assert.equal(assertHandoffContract(handoff.data), true);
  assert.equal(handoff.data.combinedConfirmedCover, null, 'two limits are never added');
  // An unreviewed model reading is not contractual evidence: the item stays missing and the reading is listed beside it.
  const byDocument = new Map(c.documentAssociations.map(d => [d.policyId, d.documentId]));
  for (const policy of handoff.data.policies) {
    const room = policy.items.find(i => i.rule === 'room_rent_limit' && i.topic === 'room rent');
    assert.equal(room.state, 'missing');
    assert.equal(room.reason, 'only_non_contractual_sources');
    assert.equal(room.value, null);
    assert.deepEqual(room.discrepancies.map(d => d.documentId), [byDocument.get(policy.policyId)], 'only this policy\'s document is cited');
  }
  assert.deepEqual(typed.map(f => f.value.amountMinor).sort(), [500000, 800000]);
  for (const body of [built.data, handoff.data]) {
    const json = JSON.stringify(body);
    assert.ok(!json.includes(PERSONAL_NUMBER) && !json.includes(GROUP_NUMBER), 'printed policy numbers never leave the server');
  }
  assert.ok(app.requests.every(r => !r.prompt.includes('Member A Synthetic')), 'the household name never reaches the model');

  const revoked = await app.call(`/api/v1/consents/${s.questionGrantId}/revoke`, { method: 'POST', token: s.token, body: {} });
  assert.ok([200, 201, 204].includes(revoked.status));
  const after = await catalogue(app, s, answered.data.answerId);
  assert.equal(after.status, 404);
  assert.equal(app.database.prepare('SELECT count(*) AS n FROM policy_clauses WHERE document_id IN (?, ?)').get(...s.documentIds).n, 0, 'derived clauses are erased');
});
