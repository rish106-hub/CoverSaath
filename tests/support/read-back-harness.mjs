// Shared harness for the read-back route tests (read-facts, passages): upload, stored OCR blocks from a local Sarvam
// stub whose pages the test sets, and the real application. No real provider call is possible. Synthetic data only.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './temp-root.mjs';
import { freshDatabase } from './pg.mjs';
import { createApiServer } from '../../src/server/server.js';

export const bootstrapToken = 'coversaath-read-back-bootstrap-token-0001';
export const POLICY_NUMBER = 'SYN-PERS-410001';
export const HOLDER = 'Asha Synthetic';
export const table = rows => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
// The two-page document the stub Sarvam service returns for every job. Tests replace `fixture.pages`.
export const fixture = { pages: [[{ text: 'Synthetic', tag: 'paragraph' }], [{ text: 'Synthetic', tag: 'paragraph' }]] };

const providerJson = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, async text() { return JSON.stringify(value); } });

function sarvamFetch(calls) {
  let submissions = 0;
  return async url => {
    calls.push(String(url));
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/digitise')) { submissions += 1; return providerJson({ job_id: `readfacts-job-${submissions}`, status: 'pending' }, 201); }
    const jobId = parsed.pathname.split('/').at(-2);
    if (parsed.pathname.endsWith('/status')) return providerJson({ job_id: jobId, status: 'completed' });
    if (parsed.pathname.endsWith('/results')) {
      return providerJson({
        type: 'digitise', job_id: jobId, status: 'completed',
        usage: { pages_total: fixture.pages.length, pages_processed: fixture.pages.length, pages_succeeded: fixture.pages.length, pages_failed: 0 },
        documents: [{ pages: fixture.pages.map((blocks, index) => ({
          page_num: index + 1,
          blocks: blocks.map((block, order) => ({ block_id: `p${index + 1}b${order}`, text: block.text, layout_tag: block.tag, reading_order: order + 1 })),
        })) }],
      });
    }
    throw new Error(`Unexpected provider request: ${url}`);
  };
}

const pdf = async width => {
  const document = await PDFDocument.create();
  document.addPage([width, 400]);
  document.addPage([width + 1, 401]);
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
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-readfacts-'));
  const { db: database } = await freshDatabase(t);
  const providerCalls = [];
  const modelCalls = [];
  const outbound = [];
  const realFetch = globalThis.fetch;
  // Any request that leaves loopback is a provider call. The suite talks to its own server only.
  globalThis.fetch = (input, init) => {
    const target = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (target.hostname !== '127.0.0.1') outbound.push(target.href);
    return realFetch(input, init);
  };
  t.after(() => { globalThis.fetch = realFetch; });
  const env = {
    KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
    DOCUMENT_STORAGE_PATH: join(directory, 'documents'),
    DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'),
    SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only', SARVAM_OCR_RETRY_DELAY_MS: '0', SARVAM_OCR_POLL_INTERVAL_MS: '0',
    DOCUMENT_READBACK_ENABLED: 'true',
    ...extraEnv,
  };
  const server = createApiServer({
    database, env, sarvamFetch: sarvamFetch(providerCalls),
    analysisLiveModelDriver: { loadModel: async () => ({ mocked: true }), createAgent: () => ({ generate: async () => { modelCalls.push('model'); throw new Error('no model call expected'); } }) },
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
    return { status: response.status, data: await response.json().catch(() => null) };
  };
  return { database, call, base, providerCalls, modelCalls, outbound };
}

let widthSeed = 300;

export async function uploadDocument(app, s, { logicalId, version } = {}) {
  widthSeed += 1;
  const upload = await fetch(`${app.base}/api/v1/cases/${s.caseId}/documents`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/pdf', 'Idempotency-Key': randomUUID(),
      'X-Document-Kind': 'policy_schedule', 'X-Consent-Grant-Id': s.processingGrantId, 'X-Filename': 'synthetic-policy.pdf',
      ...(logicalId ? { 'X-Logical-Document-Id': logicalId, 'X-Document-Version': String(version ?? 1) } : {}),
    },
    body: await pdf(widthSeed),
  });
  assert.equal(upload.status, 201);
  const documentId = (await upload.json()).document.id;
  await eventually(() => app.database.prepare(`SELECT 1 FROM document_uploads WHERE id = ? AND lifecycle_state = 'active' AND malware_status = 'clean'`).get(documentId));
  return documentId;
}

export async function grantReading(app, s, documentId) {
  const grant = await app.call('/api/v1/consents', {
    method: 'POST', token: s.token,
    body: { householdId: s.householdId, subjectAdultId: s.adultId, grantedToActor: 'sarvam', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.data));
  return grant.data.id;
}

export async function readDocument(app, s, documentId, grantId) {
  const ocr = await app.call(`/api/v1/documents/${documentId}/ocr-jobs`, { method: 'POST', token: s.token, body: { consentGrantId: grantId } });
  assert.equal(ocr.status, 202, JSON.stringify(ocr.data));
  const refreshed = await app.call(`/api/v1/ocr-jobs/${ocr.data.job.id}/refresh`, { method: 'POST', token: s.token, body: { consentGrantId: grantId } });
  assert.equal(refreshed.data?.job?.status, 'succeeded', JSON.stringify(refreshed));
}

// Household, case and one uploaded document; `read` also grants reading and runs the stubbed OCR.
export async function scenario(app, { name = 'ReadFacts', read = true, logicalId } = {}) {
  const identity = await app.call('/api/v1/households', {
    method: 'POST', token: bootstrapToken, body: { displayName: `${name} household`, owner: { displayName: HOLDER } },
  });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;
  const householdId = identity.data.household.id;
  const adultId = identity.data.owner.id;
  const opened = await app.call('/api/v1/cases', { method: 'POST', token, body: { householdId, subjectMemberId: identity.data.ownerMember.id, triggerType: 'planned_care' } });
  assert.equal(opened.status, 201);
  const caseId = opened.data.id;
  const processing = await app.call('/api/v1/consents', {
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
  const s = { token, householdId, adultId, caseId, processingGrantId: processing.data.id };
  s.documentId = await uploadDocument(app, s, { logicalId });
  if (read) {
    s.readingGrantId = await grantReading(app, s, s.documentId);
    await readDocument(app, s, s.documentId, s.readingGrantId);
  }
  return s;
}

export const readFacts = (app, s, { token = s.token, caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/read-facts`, { token });

