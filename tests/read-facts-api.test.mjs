import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { sharedColumnCrypto } from '../src/backend/security/column-crypto.js';
import { tableCounts } from './support/household-api-harness.mjs';
import { createApiServer } from '../src/server/server.js';
import { createBackendServices, readbackEnabled } from '../src/backend/services/index.js';
import { buildClauses } from '../src/features/policy-evidence/index.js';
import { FINDING_STATES } from '../src/contracts/policy-evidence.js';
import { ANALYSIS_ERROR_CODES } from '../src/contracts/error-codes.js';

const pgOptions = postgresTestOptions();

// Read-back of values (ADR 0012 D9, run V3a) through the real application: upload, stored OCR blocks from a local
// Sarvam stub, a deterministic read of the stored pages. No model call, nothing stored, no real provider call.
// Synthetic data only.

const bootstrapToken = 'coversaath-read-facts-bootstrap-token-0001';
const POLICY_NUMBER = 'SYN-PERS-410001';
const HOLDER = 'Asha Synthetic';
const LONG_CELL = 'Initial waiting Period (Code-Excl03): 30 days for all illnesses, except accidents, as stated in the policy wording that you '
  + 'received with this schedule, and as may be changed only by an endorsement that the insurer sends you in writing';
const table = rows => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
const PAGES = [
  [
    { text: 'Demo Health General Insurance Company Limited', tag: 'paragraph' },
    { text: table([
      // Four-column rows put identity values on the same row as the values that are read back.
      ['Policy Number', POLICY_NUMBER, 'Room Rent', 'Rs 5,000 per day'],
      ['Policyholder Name', HOLDER, 'Period of Insurance', '01-04-2025 to 31-03-2026'],
      ['Base sum Insured per insured person', '5,00,000'],
      // A decoy row holding the same short value as the PED row, with an identity value beside it.
      ['Policy Number', POLICY_NUMBER, 'Note', '24 months'],
      ['PED wait period applicable from policy inception', '24 months'],
    ]), tag: 'table' },
  ],
  [
    { text: table([
      ['Pre-existing diseases waiting period (Code-Excl01): 36 months', 'Applies'],
      [LONG_CELL, 'Applies'],
    ]), tag: 'table' },
    { text: `Dear ${HOLDER}, your policy has a co-payment of 20% on every claim.`, tag: 'paragraph' },
  ],
];

let pagesInUse = PAGES;

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
        usage: { pages_total: pagesInUse.length, pages_processed: pagesInUse.length, pages_succeeded: pagesInUse.length, pages_failed: 0 },
        documents: [{ pages: pagesInUse.map((blocks, index) => ({
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

async function uploadDocument(app, s, { logicalId, version } = {}) {
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

async function grantReading(app, s, documentId) {
  const grant = await app.call('/api/v1/consents', {
    method: 'POST', token: s.token,
    body: { householdId: s.householdId, subjectAdultId: s.adultId, grantedToActor: 'sarvam', purpose: 'document_processing',
      scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }] },
  });
  assert.equal(grant.status, 201, JSON.stringify(grant.data));
  return grant.data.id;
}

async function readDocument(app, s, documentId, grantId) {
  const ocr = await app.call(`/api/v1/documents/${documentId}/ocr-jobs`, { method: 'POST', token: s.token, body: { consentGrantId: grantId } });
  assert.equal(ocr.status, 202, JSON.stringify(ocr.data));
  const refreshed = await app.call(`/api/v1/ocr-jobs/${ocr.data.job.id}/refresh`, { method: 'POST', token: s.token, body: { consentGrantId: grantId } });
  assert.equal(refreshed.data?.job?.status, 'succeeded', JSON.stringify(refreshed));
}

// Household, case and one uploaded document; `read` also grants reading and runs the stubbed OCR.
async function scenario(app, { name = 'ReadFacts', read = true, logicalId } = {}) {
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

const readFacts = (app, s, { token = s.token, caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/read-facts`, { token });

test('V3a: DOCUMENT_READBACK_ENABLED is off unless exactly "true"', () => {
  assert.equal(readbackEnabled({}), false);
  assert.equal(readbackEnabled({ DOCUMENT_READBACK_ENABLED: 'true' }), true);
  for (const value of ['TRUE', 'True', '1', 'yes', ' true', 'true ', 'false', '']) {
    assert.equal(readbackEnabled({ DOCUMENT_READBACK_ENABLED: value }), false, JSON.stringify(value));
  }
  assert.deepEqual(ANALYSIS_ERROR_CODES.READBACK_DISABLED, { httpStatus: 503, category: 'configuration', retryable: false });
});

test('V3a: a read document returns labelled, bounded values with page and quote, no identity, no model, no provider', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const providerBefore = app.providerCalls.length;
  const countsBefore = await tableCounts(app.database);

  const res = await readFacts(app, s);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.label, 'read_not_checked');
  assert.equal(res.data.notice, 'Read from your documents by a rule, not checked.');
  assert.deepEqual(res.data.excluded, []);
  assert.equal(res.data.documents.length, 1);
  const [document] = res.data.documents;
  assert.equal(document.documentId, s.documentId);
  assert.equal(document.documentKind, 'policy_schedule');
  const found = document.fields.filter(field => field.value !== null);
  assert.ok(found.length >= 1);
  for (const field of document.fields) {
    assert.deepEqual(Object.keys(field), ['field', 'topic', 'value', 'state', 'page', 'quote']);
    assert.ok(FINDING_STATES.includes(field.state), field.state);
    assert.notEqual(field.state, 'verified');
    if (field.value === null) { assert.equal(field.state, 'unknown'); continue; }
    assert.ok(Number.isSafeInteger(field.page) && field.page >= 1);
    assert.equal(typeof field.quote, 'string');
    assert.ok(field.quote.length <= 160 && field.quote.length > 0);
    assert.ok(field.quote.includes(field.value), `${field.field} quote cites its value`);
  }
  const byField = Object.fromEntries(document.fields.map(field => [field.field, field]));
  assert.equal(byField.insurer.value, 'Demo Health General Insurance Company Limited');
  assert.equal(byField.base_sum_insured.topic, 'sum_insured');
  assert.equal(byField.base_sum_insured.value, '5,00,000');
  assert.equal(byField.base_sum_insured.page, 1);
  assert.equal(byField.room_rent_limit.topic, 'room_rent');
  assert.equal(byField.room_rent_limit.value, 'Rs 5,000 per day');
  assert.equal(byField.room_rent_limit.quote, 'Room Rent | Rs 5,000 per day', 'the quote is the matched label and value only, not the four-column row');
  assert.equal(byField.policy_period_start.topic, 'policy_period');
  assert.equal(byField.policy_period_start.value, '01-04-2025');
  assert.equal(byField.policy_period_start.quote, 'Period of Insurance | 01-04-2025 to 31-03-2026');
  assert.equal(byField.policy_period_end.quote, 'Period of Insurance | 01-04-2025 to 31-03-2026');
  assert.equal(byField.co_payment.topic, 'co_payment');
  assert.equal(byField.co_payment.page, 2);
  assert.equal(byField.co_payment.value, '20% on every claim');
  assert.equal(byField.co_payment.quote, 'Dear [hidden], your policy has a co-payment of 20% on every claim.', 'a name in a paragraph quote is hidden');
  assert.equal(byField.initial_waiting_period.value, '30 days');
  assert.equal(byField.initial_waiting_period.quote.length, 160, 'a long cell is cut to 160 characters around the value');
  assert.ok(byField.initial_waiting_period.quote.includes('30 days'));
  assert.equal(byField.ped_waiting_period.topic, 'waiting_period');
  assert.equal(byField.ped_waiting_period.state, 'conflicting', 'two signals that disagree are reported as conflicting');
  assert.equal(byField.ped_waiting_period.quote, 'PED wait period applicable from policy inception | 24 months', 'the label pattern picks the PED row, not the decoy row with the same value');
  assert.equal(byField.icu_limit.state, 'unknown');

  // Identity fields are never extracted for this route, so neither their names nor their values can appear.
  const text = JSON.stringify(res.data);
  for (const forbidden of ['policy_number', 'policyholder_name', 'insured_members', 'total_premium', POLICY_NUMBER, HOLDER, 'Policyholder Name', 'Policy Number', 'Asha', 'Synthetic']) {
    assert.ok(!text.includes(forbidden), `${forbidden} must not be returned`);
  }
  assert.ok(!text.includes('consentGrantId') && !text.includes(s.readingGrantId), 'no grant ids are returned');

  assert.equal(app.providerCalls.length, providerBefore, 'read-facts makes no Sarvam call');
  assert.deepEqual(app.modelCalls, [], 'no model call');
  assert.deepEqual(app.outbound, [], 'no request left loopback');
  assert.deepEqual(await tableCounts(app.database), countsBefore, 'read-facts stores nothing and audits nothing');
});

test('V3a: flag off answers 503 READBACK_DISABLED after the case and permission checks', pgOptions, async t => {
  for (const flag of [undefined, 'false', 'TRUE']) {
    const app = await startApp(t, { env: { DOCUMENT_READBACK_ENABLED: flag } });
    const s = await scenario(app);
    const res = await readFacts(app, s);
    assert.equal(res.status, 503, `${flag}: ${JSON.stringify(res.data)}`);
    assert.equal(res.data.error.code, 'READBACK_DISABLED');
    assert.ok(!JSON.stringify(res.data).includes('Rs 5,000'));
    // The gate sits behind the ownership check: a foreign caller still sees the 404, not the flag state.
    const other = await scenario(app, { name: 'Other', read: false });
    assert.equal((await readFacts(app, s, { token: other.token })).status, 404);
  }
});

test('V3a: a foreign or missing case is the same 404, and a missing token is 401', pgOptions, async t => {
  const app = await startApp(t);
  const mine = await scenario(app, { name: 'Mine' });
  const other = await scenario(app, { name: 'Other' });
  const foreign = await readFacts(app, mine, { token: other.token });
  const missing = await readFacts(app, mine, { token: other.token, caseId: 'case-does-not-exist' });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.data.error, missing.data.error);
  assert.ok(!JSON.stringify(foreign.data).includes('Rs 5,000'));
  const anonymous = await app.call(`/api/v1/cases/${mine.caseId}/read-facts`);
  assert.equal(anonymous.status, 401);
  assert.equal((await readFacts(app, other)).status, 200, 'the owner of the other case still reads their own');
});

test('V3a: a revoked collect consent loses the source-pack field and answers 403 FIELD_ACCESS_REQUIRED', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.equal((await readFacts(app, s)).status, 200);
  const revoked = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  const res = await readFacts(app, s);
  assert.equal(res.status, 403, JSON.stringify(res.data));
  assert.equal(res.data.error.code, 'FIELD_ACCESS_REQUIRED');
});

test('V3a: a document not yet read is excluded as not_read, and reading is decided per document', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  const none = await readFacts(app, s);
  assert.equal(none.status, 200);
  assert.deepEqual(none.data.documents, []);
  assert.deepEqual(none.data.excluded, [{ documentId: s.documentId, reason: 'not_read' }]);

  // Reading consent for one document does not read, or reveal, the other.
  s.readingGrantId = await grantReading(app, s, s.documentId);
  await readDocument(app, s, s.documentId, s.readingGrantId);
  const second = await uploadDocument(app, s);
  const mixed = await readFacts(app, s);
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.data.documents.map(document => document.documentId), [s.documentId]);
  assert.deepEqual(mixed.data.excluded, [{ documentId: second, reason: 'not_read' }]);
  assert.equal(app.providerCalls.filter(url => url.endsWith('/digitise')).length, 1, 'only the consented document was sent to the provider');
});

test('V3a: revoking the reading grant withdraws the document and erases its pages and clauses', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  const { clauses, ocr } = createBackendServices(app.database);
  // Clauses are normally derived on the first question; derive them here so the erasure assertion is not vacuous.
  const stored = await ocr.getDocumentBlockPages({ documentId: s.documentId, householdId: s.householdId });
  const { clauses: built } = buildClauses(stored, { documentId: s.documentId, sourceVersion: stored.sourceVersion });
  assert.ok(built.length > 0);
  await clauses.saveClauses({ householdId: s.householdId, caseId: s.caseId, documentId: s.documentId, clauses: built });
  const pagesWithText = () => app.database.prepare(`SELECT count(*) AS n FROM source_pages WHERE document_upload_id = ? AND (extracted_text IS NOT NULL OR blocks_json IS NOT NULL)`).get(s.documentId);
  const clauseCount = () => app.database.prepare('SELECT count(*) AS n FROM policy_clauses WHERE document_id = ?').get(s.documentId);
  assert.ok((await pagesWithText()).n > 0);
  assert.ok((await clauseCount()).n > 0);
  assert.equal((await readFacts(app, s)).data.documents.length, 1);

  const revoked = await app.call(`/api/v1/consents/${s.readingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));

  const res = await readFacts(app, s);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.documents, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_withdrawn' }]);
  assert.ok(!JSON.stringify(res.data).includes('Rs 5,000'));
  assert.equal((await pagesWithText()).n, 0, 'extracted_text and blocks_json are NULL');
  assert.equal((await clauseCount()).n, 0, 'derived clauses are erased');
  assert.deepEqual(app.modelCalls, []);
  assert.deepEqual(app.outbound, []);
});

test('V3a: after revoke, a new grant and a new OCR start, the document reads again (U11)', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  await app.call(`/api/v1/consents/${s.readingGrantId}/revoke`, { method: 'POST', token: s.token, body: {} });
  const withdrawn = await readFacts(app, s);
  assert.deepEqual(withdrawn.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_withdrawn' }]);

  const newGrantId = await grantReading(app, s, s.documentId);
  const restart = await app.call(`/api/v1/documents/${s.documentId}/ocr-jobs`, { method: 'POST', token: s.token, body: { consentGrantId: newGrantId } });
  assert.equal(restart.status, 202, JSON.stringify(restart.data));
  // Until the new job succeeds the document is not read; it is not reported as readable from the erased one.
  assert.deepEqual((await readFacts(app, s)).data.excluded, [{ documentId: s.documentId, reason: 'not_read' }]);
  const refreshed = await app.call(`/api/v1/ocr-jobs/${restart.data.job.id}/refresh`, { method: 'POST', token: s.token, body: { consentGrantId: newGrantId } });
  assert.equal(refreshed.data.job.status, 'succeeded', JSON.stringify(refreshed.data));

  const again = await readFacts(app, s);
  assert.equal(again.status, 200);
  assert.deepEqual(again.data.excluded, [], 'if this is excluded as not_read the U11 fix is missing: stop');
  assert.equal(again.data.documents.length, 1);
  assert.ok(again.data.documents[0].fields.some(field => field.value !== null));
  assert.deepEqual(app.modelCalls, []);
  assert.deepEqual(app.outbound, []);
});

test('V3a: the per-request grant check decides: an expired reading grant hides values that are still stored', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.equal((await readFacts(app, s)).data.documents.length, 1);
  await app.database.run('UPDATE consent_grants SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', s.readingGrantId]);
  const stored = await app.database.one('SELECT count(*) AS n FROM source_pages WHERE document_upload_id = ? AND extracted_text IS NOT NULL', [s.documentId]);
  assert.ok(stored.n > 0, 'expiry erases nothing, so only the grant check can keep the text back');
  const res = await readFacts(app, s);
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.documents, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_expired' }]);
  assert.ok(!JSON.stringify(res.data).includes('Rs 5,000'));
});

test('V3a: a stored job authorization naming someone other than the uploader does not pass the grant check', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  assert.equal((await readFacts(app, s)).data.documents.length, 1);
  await app.database.run(`UPDATE ocr_jobs SET authorization_json = CAST(jsonb_set(CAST(authorization_json AS jsonb), '{requestedByAdultId}', '"adult-someone-else"') AS text)
    WHERE document_upload_id = ?`, [s.documentId]);
  const res = await readFacts(app, s);
  assert.deepEqual(res.data.documents, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_withdrawn' }]);
});

test('V3a: a job from any provider other than sarvam is never read back', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  await app.database.run("UPDATE ocr_jobs SET provider = 'fixture' WHERE document_upload_id = ?", [s.documentId]);
  const res = await readFacts(app, s);
  assert.deepEqual(res.data.documents, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'not_read' }]);
});

test('V3a: every succeeded job whose pages are returned must still hold a current grant', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app);
  // A second succeeded job with a lapsed grant owns one of the stored pages: its text would be returned, so it must be checked.
  const crypto = sharedColumnCrypto();
  const job = await app.database.one('SELECT * FROM ocr_jobs WHERE document_upload_id = ?', [s.documentId]);
  await app.database.run(`INSERT INTO ocr_jobs (id, document_upload_id, provider, provider_job_ref, status, attempt_count, contract_version, authorization_json, result_json, result_digest, requested_at, updated_at)
    VALUES (?, ?, 'sarvam', NULL, 'succeeded', 1, ?, ?, ?, ?, ?, ?)`, [
    'job-second', s.documentId, job.contract_version, JSON.stringify({ ...JSON.parse(job.authorization_json), consentGrantId: 'grant-does-not-exist' }),
    // result_json is sealed with the job id in its AAD (ADR 0013), so the copy is re-sealed for the new row.
    crypto.seal('ocr_jobs', 'result_json', 'job-second', crypto.open('ocr_jobs', 'result_json', job.id, job.result_json)),
    job.result_digest, '2999-01-01T00:00:00.000Z', '2999-01-01T00:00:00.000Z']);
  await app.database.run("UPDATE source_pages SET ocr_job_id = 'job-second' WHERE document_upload_id = ? AND page_number = 2", [s.documentId]);
  const res = await readFacts(app, s);
  assert.deepEqual(res.data.documents, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'reading_permission_withdrawn' }]);
});

test('V3a: a document with a newer version is superseded, and a document being deleted is not read', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { logicalId: 'logical-policy' });
  const second = await uploadDocument(app, s, { logicalId: 'logical-policy', version: 2 });
  const res = await readFacts(app, s);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.documents, []);
  assert.deepEqual(res.data.excluded, [{ documentId: s.documentId, reason: 'superseded' }, { documentId: second, reason: 'not_read' }]);
  assert.ok(!JSON.stringify(res.data).includes('Rs 5,000'));

  const other = await scenario(app, { name: 'Deleting' });
  await app.database.run("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?", [other.documentId]);
  const gone = await readFacts(app, other);
  assert.equal(gone.status, 200);
  assert.deepEqual(gone.data.documents, []);
  assert.ok(!JSON.stringify(gone.data).includes('Rs 5,000'));
});

test('V3a: a value longer than 60 characters, or one that is or holds an identity string, is shown as unknown', pgOptions, async t => {
  const app = await startApp(t);
  const cases = [
    `${'A very long synthetic insurer name '.repeat(3)}General Insurance Company Limited`,
    `${HOLDER} General Insurance Company Limited`,
  ];
  for (const insurer of cases) {
    pagesInUse = [[
      { text: table([['Policyholder Name', HOLDER], ['Room Rent', 'Rs 5,000 per day']]), tag: 'table' },
      { text: insurer, tag: 'paragraph' },
    ], [{ text: 'Synthetic filler page', tag: 'paragraph' }]];
    t.after(() => { pagesInUse = PAGES; });
    const s = await scenario(app, { name: `Value${cases.indexOf(insurer)}` });
    const res = await readFacts(app, s);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const byField = Object.fromEntries(res.data.documents[0].fields.map(field => [field.field, field]));
    assert.equal(byField.insurer.state, 'unknown');
    assert.equal(byField.insurer.value, null);
    assert.equal(byField.insurer.quote, null);
    assert.equal(byField.room_rent_limit.value, 'Rs 5,000 per day', 'other fields are unaffected');
    assert.ok(!JSON.stringify(res.data).includes(HOLDER));
  }
});
