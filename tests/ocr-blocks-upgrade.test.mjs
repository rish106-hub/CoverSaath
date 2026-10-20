import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { buildStoredBlocks, createOcrService, serializeStoredBlocks, validateOcrOutput } from '../src/features/input/index.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { rawSarvamResult, sarvamTransport } from './support/sarvam-blocks-fixture.mjs';

// Explicit block upgrade for knowvia.ocr.v1 documents (blocks upgrade defect): structuring told the
// household to "Run OCR again", which a stored v1 success always blocked. Fake providers count every
// call; zero network. Synthetic data only.
const document = 'document-upgrade';
const household = 'household-parameters';
const run = 'run-parameters';
const authorization = Object.freeze({
  authorized: true, consentGrantId: 'consent-parameters', requestedByAdultId: 'adult-parameters', purpose: 'document_processing',
});
const expected = { documentId: document, sourceVersion: 'version-1', contentSha256: '6'.repeat(64) };
// The page text a Sarvam-shaped result normalises to; a v1 document stored exactly this text.
const sarvamTexts = (raw = rawSarvamResult()) => sarvamTransport().normalizeResult(raw, expected).pages.map(page => page.text);

function open(t, { texts = sarvamTexts(), withBlocks = false } = {}) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: 'policy-parameters/v1', ...parameterScope(), updatedBy: 'test' });
  database.prepare(`INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
    original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES (?, ?, 'case-parameters', 'adult-parameters', 'consent-parameters', 'policy_schedule', 'fixture.pdf', 'fixture/document-upgrade', ?,
    'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`).run(document, household, expected.contentSha256, at);
  for (const [id, action, recipient] of [['scope-collect', 'collect', null], ['scope-gemini-upgrade', 'derive', 'google-gemini']]) {
    database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
      VALUES (?, 'consent-parameters', 'document', ?, ?, 'insurance_document', ?, ?)`).run(id, document, action, recipient, at);
  }
  database.prepare(`INSERT INTO ocr_jobs (id, document_upload_id, provider, status, attempt_count, contract_version, requested_at, completed_at, updated_at)
    VALUES ('ocr-v1', ?, 'fixture', 'succeeded', 1, 'knowvia.ocr.v1', ?, ?, ?)`).run(document, at, at, at);
  texts.forEach((text, index) => {
    const blocks = withBlocks ? serializeStoredBlocks(index + 1, buildStoredBlocks([{ text, tag: 'paragraph', readingOrder: 1 }], text)) : null;
    database.prepare(`INSERT INTO source_pages (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
      extracted_text, extraction_status, created_at, text_sha256, output_contract_version, blocks_json)
      VALUES (?, ?, 'ocr-v1', ?, 'version-1', ?, ?, 'extracted', ?, ?, 'knowvia.ocr.v1', ?)`)
      .run(`page-upgrade-${index + 1}`, document, index + 1, 'b'.repeat(64), text, at, validateOcrOutput({
        schemaVersion: 'knowvia.ocr.v1', document: { id: document, sourceVersion: 'version-1', contentSha256: expected.contentSha256 },
        provider: { name: 'fixture', jobRef: 'x' }, pages: [{ pageNumber: 1, text }],
      }, {}).pages[0].textSha256, blocks);
  });
  return { database, services };
}

// A Sarvam-shaped v2 provider: `async` returns submitted and finishes on refresh.
function upgradeProvider({ raw = rawSarvamResult(), async = false } = {}) {
  const transport = sarvamTransport();
  const calls = [];
  return {
    calls,
    provider: Object.freeze({
      name: 'fixture', mode: 'fixture', outputContractVersion: 'knowvia.ocr.v2',
      health: () => ({ provider: 'fixture', networkAttempted: false }),
      async createJob() {
        calls.push('createJob');
        return async ? { status: 'submitted', jobRef: 'upgrade-job' } : { status: 'succeeded', jobRef: 'upgrade-job', result: raw };
      },
      async getJob() { calls.push('getJob'); return { status: 'succeeded', jobRef: 'upgrade-job', result: raw }; },
      async cancelJob() { return { status: 'cancelled' }; },
      normalizeResult: (result, expectedDocument) => transport.normalizeResult(result, expectedDocument),
    }),
  };
}

const ocrService = (services, provider) => createOcrService({ repository: services.ocr, provider, mode: 'fixture', now: () => new Date(at), pollIntervalMs: 0 });
const upgrade = (service, extra = {}) => service.start({ documentId: document, authorization, mode: 'blocks_upgrade', acknowledgeProviderCharge: true, ...extra });
const pages = database => database.prepare(`SELECT id, page_number, extracted_text, text_sha256, blocks_json, blocks_upgrade_job_id
  FROM source_pages WHERE document_upload_id = ? ORDER BY page_number`).all(document);
const ocrJobs = database => database.prepare('SELECT id, status, contract_version, error_code FROM ocr_jobs WHERE document_upload_id = ? ORDER BY requested_at, id').all(document);

test('U1: the Sarvam normaliser reproduces page text exactly for the same provider output, in any block order', () => {
  const first = sarvamTexts();
  assert.deepEqual(sarvamTexts(), first);
  const shuffled = rawSarvamResult();
  for (const page of shuffled.results[0].documents[0].pages) page.blocks.reverse();
  assert.deepEqual(sarvamTexts(shuffled), first, 'text follows reading order, not response order');
});

test('a v1 document: structuring names the upgrade request instead of "Run OCR again"', t => {
  const { services } = open(t);
  const structuring = createPolicyStructuringService({ services, loadKnownIdentifiers: async () => [], createModelCall: () => () => {}, env: { POLICY_STRUCTURING_ENABLED: 'true' } });
  assert.throws(() => structuring.start({ document: { id: document, householdId: household, caseId: 'case-parameters' }, workflowRunId: run,
    consentGrantId: 'consent-parameters', subjectAdultId: 'adult-parameters' }), error => error.code === 'STRUCTURING_BLOCKS_UNAVAILABLE'
    && error.statusCode === 409 && /blocks_upgrade/.test(error.message) && !/Run OCR again/.test(error.message));
});

test('without acknowledgement the upgrade is refused before any provider call (blocks upgrade defect)', async t => {
  const { database, services } = open(t);
  const { provider, calls } = upgradeProvider();
  const service = ocrService(services, provider);
  for (const extra of [{ acknowledgeProviderCharge: false }, { acknowledgeProviderCharge: 'true' }, { acknowledgeProviderCharge: undefined }]) {
    await assert.rejects(upgrade(service, extra), { code: 'OCR_UPGRADE_CHARGE_UNACKNOWLEDGED' });
  }
  await assert.rejects(service.start({ documentId: document, authorization, mode: 'everything' }), { code: 'OCR_MODE_INVALID' });
  assert.equal(calls.length, 0);
  assert.deepEqual(ocrJobs(database).map(job => job.id), ['ocr-v1'], 'no job row either');
});

test('a normal OCR request on a v1 document never starts a silent paid rerun', async t => {
  const { database, services } = open(t);
  const { provider, calls } = upgradeProvider();
  const job = await ocrService(services, provider).start({ documentId: document, authorization });
  assert.equal(job.id, 'ocr-v1');
  assert.equal(calls.length, 0);
  assert.equal(ocrJobs(database).length, 1);
});

test('an acknowledged upgrade makes one provider call, attaches blocks to the same pages and unblocks structuring', async t => {
  const { database, services } = open(t);
  const before = pages(database);
  const { provider, calls } = upgradeProvider();
  const service = ocrService(services, provider);
  const job = await upgrade(service);
  assert.equal(job.status, 'succeeded');
  assert.equal(job.contractVersion, 'knowvia.ocr.v2', 'a job that stored blocks records the v2 output contract');
  assert.deepEqual(calls, ['createJob']);
  const after = pages(database);
  assert.deepEqual(after.map(page => [page.id, page.extracted_text, page.text_sha256]), before.map(page => [page.id, page.extracted_text, page.text_sha256]),
    'page identity and text are unchanged, so existing observations keep their source page');
  assert.ok(after.every(page => page.blocks_json !== null && page.blocks_upgrade_job_id === job.id));
  const stored = services.ocr.getDocumentBlockPages({ documentId: document, householdId: household });
  assert.equal(stored.complete, true);

  // Repeat request: nothing left to upgrade, no second charge.
  await assert.rejects(upgrade(service), { code: 'OCR_UPGRADE_NOT_NEEDED' });
  assert.equal(calls.length, 1);

  const audits = database.prepare("SELECT action, event_payload_json FROM audit_events WHERE action LIKE 'ocr.blocks_upgrade%' ORDER BY id").all();
  assert.deepEqual(audits.map(row => row.action), ['ocr.blocks_upgrade_requested', 'ocr.blocks_upgrade_completed']);
  assert.equal(JSON.parse(audits[1].event_payload_json).pageCount, 2);
  assert.equal(JSON.stringify(audits).includes('Synthetic Insurer'), false, 'audit holds counts and codes only');

  // Structuring now starts.
  const structuring = createPolicyStructuringService({
    services, loadKnownIdentifiers: async () => [], env: { POLICY_STRUCTURING_ENABLED: 'true' },
    createModelCall: () => async ({ payload }) => (payload.chunks ? { json: { items: [] }, usage: {} } : { json: { conflicts: [] }, usage: {} }),
  });
  const owned = { id: document, householdId: household, caseId: 'case-parameters' };
  assert.equal(structuring.start({ document: owned, workflowRunId: run, consentGrantId: 'consent-parameters', subjectAdultId: 'adult-parameters' }).status, 'running');
  await structuring.settle(document, run);
});

test('a document that already has blocks is refused with zero provider calls', async t => {
  const { database, services } = open(t, { withBlocks: true });
  const { provider, calls } = upgradeProvider();
  await assert.rejects(upgrade(ocrService(services, provider)), { code: 'OCR_UPGRADE_NOT_NEEDED' });
  assert.equal(calls.length, 0);
  assert.equal(ocrJobs(database).length, 1);
});

test('a duplicate upgrade request returns the in-flight job without a second charge', async t => {
  const { database, services } = open(t);
  const { provider, calls } = upgradeProvider({ async: true });
  const service = ocrService(services, provider);
  const first = await upgrade(service);
  assert.equal(first.status, 'submitted');
  const second = await upgrade(service);
  assert.equal(second.id, first.id);
  assert.deepEqual(calls, ['createJob']);
  const done = await service.refresh(first.id, { authorization });
  assert.equal(done.status, 'succeeded');
  assert.ok(pages(database).every(page => page.blocks_upgrade_job_id === first.id));
});

test('text that differs from the stored page fails closed and keeps the v1 pages', async t => {
  const { database, services } = open(t, { texts: ['Synthetic page that was read differently', sarvamTexts()[1]] });
  const { provider, calls } = upgradeProvider({ async: true });
  const service = ocrService(services, provider);
  const job = await upgrade(service);
  await assert.rejects(service.refresh(job.id, { authorization }), { code: 'OCR_UPGRADE_TEXT_CHANGED' });
  const failed = ocrJobs(database).find(row => row.id === job.id);
  assert.deepEqual([failed.status, failed.error_code, failed.contract_version], ['failed', 'OCR_UPGRADE_TEXT_CHANGED', 'knowvia.ocr.v2']);
  assert.ok(pages(database).every(page => page.blocks_json === null && page.blocks_upgrade_job_id === null), 'no page takes blocks');
  // A repeat request returns the failed attempt: no second charge.
  const again = await upgrade(service);
  assert.equal(again.id, job.id);
  assert.equal(again.errorCode, 'OCR_UPGRADE_TEXT_CHANGED');
  assert.deepEqual(calls, ['createJob', 'getJob']);
});

test('revocation during an upgrade cancels it, and revocation after one erases the attached blocks', async t => {
  const { database, services } = open(t);
  const { provider, calls } = upgradeProvider({ async: true });
  const service = ocrService(services, provider);
  const job = await upgrade(service);
  services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  assert.equal(services.ocr.getJob(job.id).status, 'cancelled');
  assert.equal((await service.refresh(job.id, { authorization })).status, 'cancelled');
  assert.equal(calls.includes('getJob'), false, 'nothing fetched after revocation');
  assert.ok(pages(database).every(page => page.blocks_json === null));

  const second = open(t);
  const completed = upgradeProvider();
  await upgrade(ocrService(second.services, completed.provider));
  assert.ok(pages(second.database).every(page => page.blocks_json !== null));
  second.services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  assert.ok(pages(second.database).every(page => page.blocks_json === null && page.extracted_text === null));
});

test('the narrowed immutability trigger allows only the one-time fill by a succeeded v2 upgrade job', async t => {
  const { database, services } = open(t);
  const [page] = pages(database);
  const blocks = serializeStoredBlocks(1, buildStoredBlocks([{ text: page.extracted_text, tag: 'paragraph', readingOrder: 1 }], page.extracted_text));
  const fill = (jobId, id = page.id) => database.prepare('UPDATE source_pages SET blocks_json = ?, blocks_upgrade_job_id = ? WHERE id = ?').run(blocks, jobId, id);
  const immutable = /source page blocks are immutable/;
  assert.throws(() => database.prepare('UPDATE source_pages SET blocks_json = ? WHERE id = ?').run(blocks, page.id), immutable, 'no fill without an upgrade job');
  assert.throws(() => fill('ocr-v1'), immutable, 'the v1 job is not an upgrade job');
  database.prepare(`INSERT INTO ocr_jobs (id, document_upload_id, provider, status, attempt_count, contract_version, requested_at, updated_at)
    VALUES ('ocr-v2-running', ?, 'sarvam', 'processing', 1, 'knowvia.ocr.v2', ?, ?)`).run(document, at, at);
  assert.throws(() => fill('ocr-v2-running'), immutable, 'an unfinished upgrade job cannot fill');
  assert.throws(() => database.prepare("UPDATE source_pages SET blocks_upgrade_job_id = 'ocr-v1' WHERE id = ?").run(page.id),
    /blocks upgrade job is set once with its blocks/);

  const { provider } = upgradeProvider();
  const job = await upgrade(ocrService(services, provider));
  const [upgraded, other] = pages(database);
  assert.throws(() => database.prepare('UPDATE source_pages SET blocks_json = ? WHERE id = ?').run(other.blocks_json, upgraded.id), immutable,
    'blocks never change after the fill');
  assert.throws(() => database.prepare("UPDATE source_pages SET blocks_upgrade_job_id = 'ocr-v2-running' WHERE id = ?").run(upgraded.id),
    /blocks upgrade job is set once with its blocks/);
  database.prepare('UPDATE source_pages SET extracted_text = NULL WHERE id = ?').run(upgraded.id);
  assert.equal(pages(database)[0].blocks_json, null, 'erasure still clears blocks');
  assert.throws(() => fill(job.id, upgraded.id), immutable, 'an erased page is never refilled');
});
