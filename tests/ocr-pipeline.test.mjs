import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { ConsentRepository, OcrRepository } from '../src/backend/repositories/index.js';
import {
  createFixtureOcrProvider,
  createOcrService,
  validateOcrOutput,
} from '../src/modules/document-intake/index.js';
import { createSarvamOcrProvider } from '../src/integrations/index.js';

const AT = '2026-09-18T12:00:00.000Z';
const SHA = 'a'.repeat(64);
const authorization = Object.freeze({
  authorized: true,
  consentGrantId: 'consent-ocr',
  requestedByAdultId: 'adult-ocr',
  purpose: 'document_processing',
});
const liveAuthorization = Object.freeze({
  authorized: true,
  consentGrantId: 'consent-sarvam',
  requestedByAdultId: 'adult-ocr',
  purpose: 'document_processing',
  recipient: 'sarvam',
  settings: Object.freeze({ language: 'en-IN', contentType: 'mixed' }),
});

function harness({ active = true, expiresAt = '2026-09-19T12:00:00.000Z' } = {}) {
  const database = openDatabase({ path: ':memory:' });
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-ocr', 'Synthetic OCR household', AT, AT);
  database.prepare('INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('adult-ocr', 'Synthetic adult', 'active', AT, AT);
  database.prepare(`INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    'role-ocr', 'household-ocr', 'adult-ocr', 'owner', 'active', AT,
  );
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'consent-ocr', 'household-ocr', 'adult-ocr', 'knowvia', 'document_processing',
    'v1', 'fixture', AT, expiresAt, AT,
  );
  database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, action, data_category, created_at)
    VALUES (?, ?, 'document', 'collect', 'insurance_document', ?)`).run('scope-ocr', 'consent-ocr', AT);
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size,
     malware_status, encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'document-ocr', 'household-ocr', 'adult-ocr', 'consent-ocr', 'policy_schedule',
    'synthetic.pdf', 'fixture/document-ocr', SHA, 'application/pdf', 128,
    'not_scanned_fixture', 'fixture_only', 'quarantined', AT, 'policy-synthetic', '3',
  );
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'consent-sarvam', 'household-ocr', 'adult-ocr', 'sarvam', 'document_processing',
    'v1', 'fixture', AT, expiresAt, AT,
  );
  database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES (?, ?, 'document', ?, 'derive', 'insurance_document', 'sarvam', ?)`).run(
    'scope-sarvam', 'consent-sarvam', 'document-ocr', AT,
  );
  if (active) database.prepare("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'document-ocr'").run();
  return { database, repository: new OcrRepository(database) };
}

test('fixture OCR persists versioned structured output and page provenance with zero provider calls', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const provider = createFixtureOcrProvider({ pages: [
    { pageNumber: 2, text: 'Page two synthetic clause.', confidenceBasisPoints: 8000 },
    { pageNumber: 1, text: 'Page one synthetic schedule.', confidenceBasisPoints: null },
  ] });
  const service = createOcrService({
    repository: context.repository,
    provider,
    mode: 'fixture',
    now: () => new Date(AT),
  });
  const job = await service.start({ documentId: 'document-ocr', authorization });

  assert.equal(job.status, 'succeeded');
  assert.equal(job.contractVersion, 'knowvia.ocr.v1');
  assert.equal(job.result.assessment.authority, 'unverified_evidence_only');
  assert.equal(job.result.assessment.humanReviewRequired, true);
  assert.deepEqual(job.result.pages.map(page => page.pageNumber), [1, 2]);
  assert.equal(job.result.pages[0].provenance.locator, 'document:document-ocr:version:3:page:1');
  assert.equal(provider.health().calls, 0);
  assert.equal(provider.health().accuracyMeasured, false);

  const stored = context.database.prepare('SELECT * FROM source_pages ORDER BY page_number').all();
  assert.equal(stored.length, 2);
  assert.equal(stored[0].output_contract_version, 'knowvia.ocr.v1');
  assert.equal(JSON.parse(stored[0].provenance_json).contentSha256, SHA);
  assert.equal(stored[0].text_sha256.length, 64);
});

test('authorization, consent and quarantine checks fail closed before OCR work', async t => {
  const context = harness({ active: false });
  t.after(() => context.database.close());
  const service = createOcrService({ repository: context.repository, provider: createFixtureOcrProvider(), mode: 'fixture', now: () => new Date(AT) });
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization }),
    error => error.code === 'DOCUMENT_NOT_OCR_READY',
  );
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get().count, 0);

  context.database.prepare("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'document-ocr'").run();
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization: { ...authorization, requestedByAdultId: 'other' } }),
    error => error.code === 'OCR_AUTHORIZATION_REQUIRED',
  );
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get().count, 0);
});

test('structured OCR validation rejects source mismatch, duplicate pages and unbounded text', () => {
  const base = {
    schemaVersion: 'knowvia.ocr.v1',
    document: { id: 'document-ocr', sourceVersion: '3', contentSha256: SHA },
    provider: { name: 'fixture', jobRef: 'fixture-job' },
    pages: [{ pageNumber: 1, text: 'Synthetic page.' }],
  };
  assert.throws(
    () => validateOcrOutput(base, { documentId: 'different' }),
    error => error.code === 'OCR_SOURCE_MISMATCH',
  );
  assert.throws(
    () => validateOcrOutput({ ...base, pages: [...base.pages, ...base.pages] }),
    error => error.code === 'OCR_SCHEMA_INVALID',
  );
  assert.throws(
    () => validateOcrOutput({ ...base, pages: [{ pageNumber: 1, text: 'x'.repeat(200_001) }] }),
    error => error.code === 'OCR_SCHEMA_INVALID',
  );
});

test('live Sarvam path refuses incomplete configuration and records a durable failed job', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const service = createOcrService({
    repository: context.repository,
    provider: createSarvamOcrProvider({ env: { SARVAM_OCR_ENABLED: 'true' } }),
    byteReader: async () => Buffer.from('%PDF- synthetic'),
    mode: 'live',
    now: () => new Date(AT),
  });
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'PROVIDER_NOT_CONFIGURED',
  );
  const failed = context.database.prepare('SELECT status, error_code FROM ocr_jobs').get();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'PROVIDER_NOT_CONFIGURED');
});

test('live OCR refuses non-PDF documents before reading bytes or calling the provider', async t => {
  const context = harness();
  t.after(() => context.database.close());
  context.database.prepare("UPDATE document_uploads SET mime_type = 'image/png' WHERE id = 'document-ocr'").run();
  let reads = 0;
  let calls = 0;
  const provider = {
    name: 'sarvam', mode: 'live', health: () => ({ status: 'ready' }),
    async createJob() { calls += 1; throw new Error('not reached'); },
    async getJob() { throw new Error('not reached'); },
    async cancelJob() { throw new Error('not reached'); },
    normalizeResult() { throw new Error('not reached'); },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => { reads += 1; return Buffer.alloc(0); }, mode: 'live', now: () => new Date(AT),
  });
  await assert.rejects(service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'OCR_UNSUPPORTED_MEDIA_TYPE');
  assert.equal(reads, 0);
  assert.equal(calls, 0);
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get().count, 0);
});

test('verified live transport normalizes provider data and never persists its raw payload', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const raw = { secretDiagnostic: 'must-not-persist', blocks: ['Synthetic provider text.'] };
  const transport = {
    async createJob() { return { status: 'submitted', jobRef: 'provider-job-1' }; },
    async getJob() { return { status: 'succeeded', result: raw }; },
    async cancelJob() { return { status: 'cancelled' }; },
    normalizeResult(value, expected) {
      return {
        schemaVersion: 'knowvia.ocr.v1',
        document: { id: expected.documentId, sourceVersion: expected.sourceVersion, contentSha256: expected.contentSha256 },
        provider: { name: 'sarvam', jobRef: 'provider-job-1' },
        pages: [{ pageNumber: 1, text: value.blocks[0], providerPageRef: 'page-1' }],
        warnings: [],
      };
    },
  };
  const provider = createSarvamOcrProvider({ env: { SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only' }, transport });
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live',
    now: () => new Date(AT), pollIntervalMs: 0,
  });
  const submitted = await service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  assert.equal(submitted.status, 'submitted');
  const completed = await service.refresh(submitted.id, { authorization: liveAuthorization });
  assert.equal(completed.status, 'succeeded');
  assert.equal(JSON.stringify(completed).includes('must-not-persist'), false);
  assert.equal(context.database.prepare('SELECT result_json FROM ocr_jobs WHERE id = ?').get(submitted.id).result_json.includes('must-not-persist'), false);
});

test('revocation between Sarvam batches stops every later provider submission', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const consents = new ConsentRepository(context.database, { clock: () => new Date(AT) });
  let submissions = 0;
  const segmenter = { async segment() { return {
    pageCount: 11,
    segments: [
      { index: 0, originalPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], bytes: Buffer.from('%PDF- one'), contentSha256: 'a'.repeat(64) },
      { index: 1, originalPages: [11], bytes: Buffer.from('%PDF- two'), contentSha256: 'b'.repeat(64) },
    ],
  }; } };
  const fetchImpl = async () => {
    submissions += 1;
    if (submissions === 1) consents.revoke({ grantId: 'consent-sarvam', revokedByAdultId: 'adult-ocr' });
    return {
      ok: true, status: 201, headers: { get: () => null },
      async text() { return JSON.stringify({ job_id: `revoked-job-${submissions}`, status: 'pending' }); },
    };
  };
  const provider = createSarvamOcrProvider({
    env: { SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only' }, segmenter, fetchImpl,
  });
  const service = createOcrService({
    repository: context.repository, provider, byteReader: async () => Buffer.from('%PDF- synthetic'),
    mode: 'live', now: () => new Date(AT),
  });

  await assert.rejects(service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'OCR_AUTHORIZATION_REQUIRED');
  assert.equal(submissions, 1);
  const job = context.database.prepare('SELECT status, error_code, provider_job_ref FROM ocr_jobs').get();
  assert.equal(job.status, 'cancelled');
  assert.equal(job.error_code, 'CONSENT_REVOKED');
  assert.match(job.provider_job_ref, /^sarvam-v1\./);
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 0);
});

test('revocation after segmentation but before the first Sarvam POST prevents all disclosure', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const consents = new ConsentRepository(context.database, { clock: () => new Date(AT) });
  let submissions = 0;
  const provider = createSarvamOcrProvider({
    env: { SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only' },
    segmenter: { async segment() {
      consents.revoke({ grantId: 'consent-sarvam', revokedByAdultId: 'adult-ocr' });
      return { pageCount: 1, segments: [{
        index: 0, originalPages: [1], bytes: Buffer.from('%PDF- one'), contentSha256: 'a'.repeat(64),
      }] };
    } },
    fetchImpl: async () => { submissions += 1; throw new Error('must not dispatch'); },
  });
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => new Date(AT),
  });
  await assert.rejects(service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'OCR_AUTHORIZATION_REQUIRED');
  assert.equal(submissions, 0);
  assert.deepEqual({ ...context.database.prepare('SELECT status, error_code, provider_job_ref FROM ocr_jobs').get() }, {
    status: 'cancelled', error_code: 'CONSENT_REVOKED', provider_job_ref: null,
  });
});

test('an uncertain Sarvam submission cannot be resubmitted by replay or explicit retry', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let calls = 0;
  const provider = createSarvamOcrProvider({
    env: { SARVAM_OCR_ENABLED: 'true', SARVAM_API_KEY: 'test-only' },
    segmenter: { async segment() { return { pageCount: 1, segments: [{
      index: 0, originalPages: [1], bytes: Buffer.from('%PDF- one'), contentSha256: 'a'.repeat(64),
    }] }; } },
    fetchImpl: async () => { calls += 1; throw new Error('synthetic timeout after dispatch'); },
  });
  const service = createOcrService({
    repository: context.repository, provider, byteReader: async () => Buffer.from('%PDF- synthetic'),
    mode: 'live', now: () => new Date(AT),
  });
  await assert.rejects(service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'OCR_PROVIDER_NETWORK_UNCERTAIN');
  const failed = await service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 1);
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization: liveAuthorization, retryFailed: true }),
    error => error.code === 'OCR_RECONCILIATION_REQUIRED',
  );
  assert.equal(calls, 1);
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get().count, 1);
});

test('a dispatched invalid Sarvam response cannot be explicitly retried', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let calls = 0;
  const provider = {
    name: 'sarvam', mode: 'live', health: () => ({ status: 'ready' }),
    async createJob() { calls += 1; throw Object.assign(new Error('invalid dispatched response'), { code: 'OCR_PROVIDER_RESPONSE_INVALID' }); },
    async getJob() { throw new Error('not reached'); },
    async cancelJob() { throw new Error('not reached'); },
    normalizeResult() { throw new Error('not reached'); },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => new Date(AT),
  });
  await assert.rejects(service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'OCR_PROVIDER_RESPONSE_INVALID');
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization: liveAuthorization, retryFailed: true }),
    error => error.code === 'OCR_RECONCILIATION_REQUIRED',
  );
  assert.equal(calls, 1);
});

test('polling is bounded and an overdue job fails without another provider call', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let current = new Date(AT);
  let polls = 0;
  const provider = {
    name: 'sarvam', mode: 'live', health: () => ({ status: 'ready' }),
    async createJob() { return { status: 'submitted', jobRef: 'bounded-poll-job' }; },
    async getJob() { polls += 1; return { status: 'processing', jobRef: 'bounded-poll-job' }; },
    async cancelJob() { throw new Error('not reached'); },
    normalizeResult() { throw new Error('not reached'); },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live',
    now: () => current, pollIntervalMs: 2_000, jobDeadlineMs: 60_000,
  });
  const submitted = await service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  assert.equal((await service.refresh(submitted.id, { authorization: liveAuthorization })).status, 'submitted');
  assert.equal(polls, 0);
  current = new Date(Date.parse(AT) + 2_000);
  assert.equal((await service.refresh(submitted.id, { authorization: liveAuthorization })).status, 'processing');
  assert.equal(polls, 1);
  current = new Date(Date.parse(AT) + 60_001);
  const expired = await service.refresh(submitted.id, { authorization: liveAuthorization });
  assert.equal(expired.status, 'failed');
  assert.equal(expired.errorCode, 'OCR_PROVIDER_DEADLINE_EXCEEDED');
  assert.equal(polls, 1);
});

test('a new service instance resumes a durable provider job after restart', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let current = new Date(AT);
  const provider = {
    name: 'sarvam', mode: 'live', health: () => ({ status: 'ready' }),
    async createJob() { return { status: 'submitted', jobRef: 'restart-job' }; },
    async getJob() { return { status: 'succeeded', result: { text: 'Synthetic recovered page.' } }; },
    async cancelJob() { throw new Error('not reached'); },
    normalizeResult(raw, expected) {
      return {
        schemaVersion: 'knowvia.ocr.v1',
        document: { id: expected.documentId, sourceVersion: expected.sourceVersion, contentSha256: expected.contentSha256 },
        provider: { name: 'sarvam', jobRef: 'restart-job' },
        pages: [{ pageNumber: 1, text: raw.text, providerPageRef: 'restart-page-1' }], warnings: [],
      };
    },
  };
  const first = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => current,
  });
  const submitted = await first.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  current = new Date(Date.parse(AT) + 3_000);
  const restarted = createOcrService({
    repository: new OcrRepository(context.database), provider,
    byteReader: async () => { throw new Error('restart must not reread or resubmit'); },
    mode: 'live', now: () => current,
  });
  const completed = await restarted.refresh(submitted.id, { authorization: liveAuthorization });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.pages[0].text, 'Synthetic recovered page.');
});

test('a database failure rolls back every source page and leaves a failed job', async t => {
  const context = harness();
  t.after(() => context.database.close());
  context.database.exec(`CREATE TRIGGER synthetic_ocr_commit_failure
    BEFORE UPDATE OF status ON ocr_jobs
    WHEN NEW.status = 'succeeded'
    BEGIN SELECT RAISE(ABORT, 'synthetic OCR commit failure'); END`);
  const provider = {
    name: 'sarvam', mode: 'live', health: () => ({ status: 'ready' }),
    async createJob() { return { status: 'succeeded', result: { text: 'Must roll back.' } }; },
    async getJob() { return { status: 'succeeded', result: { text: 'Recovered without resubmission.' } }; },
    async cancelJob() { throw new Error('not reached'); },
    normalizeResult(raw, expected) {
      return {
        schemaVersion: 'knowvia.ocr.v1',
        document: { id: expected.documentId, sourceVersion: expected.sourceVersion, contentSha256: expected.contentSha256 },
        provider: { name: 'sarvam', jobRef: 'synthetic-atomic-job' },
        pages: [{ pageNumber: 1, text: raw.text, providerPageRef: 'synthetic-atomic-job:page:1' }], warnings: [],
      };
    },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => new Date(AT),
  });
  await assert.rejects(service.start({ documentId: 'document-ocr', authorization: liveAuthorization }),
    error => error.code === 'OCR_PERSISTENCE_FAILED' && !error.message.includes('synthetic OCR commit failure'));
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 0);
  assert.deepEqual({ ...context.database.prepare('SELECT status, error_code FROM ocr_jobs').get() }, {
    status: 'failed', error_code: 'OCR_PERSISTENCE_FAILED',
  });
  assert.equal(context.database.prepare('SELECT provider_job_ref FROM ocr_jobs').get().provider_job_ref, 'synthetic-atomic-job');
  context.database.exec('DROP TRIGGER synthetic_ocr_commit_failure');
  const reconciled = await service.refresh(context.database.prepare('SELECT id FROM ocr_jobs').get().id, {
    authorization: liveAuthorization,
  });
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(reconciled.result.pages[0].text, 'Recovered without resubmission.');
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 1);
});

test('a polled result survives a transient database failure and reconciles without another POST', async t => {
  const context = harness();
  t.after(() => context.database.close());
  context.database.exec(`CREATE TRIGGER synthetic_polled_commit_failure
    BEFORE UPDATE OF status ON ocr_jobs
    WHEN NEW.status = 'succeeded'
    BEGIN SELECT RAISE(ABORT, 'synthetic polled commit failure'); END`);
  let submissions = 0;
  let polls = 0;
  const provider = {
    name: 'sarvam', mode: 'live', health: () => ({ status: 'ready' }),
    async createJob() { submissions += 1; return { status: 'submitted', jobRef: 'polled-atomic-job' }; },
    async getJob() { polls += 1; return { status: 'succeeded', jobRef: 'polled-atomic-job', result: { text: 'Recovered polled result.' } }; },
    async cancelJob() { throw new Error('not reached'); },
    normalizeResult(raw, expected) {
      return {
        schemaVersion: 'knowvia.ocr.v1',
        document: { id: expected.documentId, sourceVersion: expected.sourceVersion, contentSha256: expected.contentSha256 },
        provider: { name: 'sarvam', jobRef: 'polled-atomic-job' },
        pages: [{ pageNumber: 1, text: raw.text, providerPageRef: 'polled-atomic-job:page:1' }], warnings: [],
      };
    },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live',
    now: () => new Date(AT), pollIntervalMs: 0,
  });
  const submitted = await service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  await assert.rejects(service.refresh(submitted.id, { authorization: liveAuthorization }),
    error => error.code === 'OCR_PERSISTENCE_FAILED');
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 0);
  assert.deepEqual({ ...context.database.prepare('SELECT status, error_code, provider_job_ref FROM ocr_jobs').get() }, {
    status: 'failed', error_code: 'OCR_PERSISTENCE_FAILED', provider_job_ref: 'polled-atomic-job',
  });
  context.database.exec('DROP TRIGGER synthetic_polled_commit_failure');
  const reconciled = await service.refresh(submitted.id, { authorization: liveAuthorization });
  assert.equal(reconciled.status, 'succeeded');
  assert.equal(submissions, 1);
  assert.equal(polls, 2);
});

test('document deletion while provider submission is in flight stays cancelled and cancels remote work', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let releaseProvider;
  let providerEntered;
  const entered = new Promise(resolve => { providerEntered = resolve; });
  const gate = new Promise(resolve => { releaseProvider = resolve; });
  const cancelledRefs = [];
  const requestIds = [];
  const provider = {
    name: 'sarvam',
    mode: 'live',
    health: () => ({ provider: 'sarvam', status: 'ready' }),
    async createJob({ requestId }) {
      requestIds.push(requestId);
      providerEntered();
      await gate;
      return { status: 'submitted', jobRef: 'remote-delete-race' };
    },
    async getJob() { throw new Error('not reached'); },
    async cancelJob({ jobRef, requestId }) { cancelledRefs.push(jobRef); requestIds.push(requestId); return { status: 'cancelled' }; },
    normalizeResult() { throw new Error('not reached'); },
  };
  const service = createOcrService({
    repository: context.repository,
    provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'),
    mode: 'live',
    now: () => new Date(AT),
  });
  const starting = service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  await entered;
  const job = context.database.prepare('SELECT id FROM ocr_jobs').get();
  context.database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-ocr'").run();
  context.database.prepare(`UPDATE ocr_jobs SET status = 'cancelled', completed_at = ?,
    error_code = 'DOCUMENT_DELETED', error_message = 'Source document deletion was requested.', updated_at = ?
    WHERE id = ?`).run(AT, AT, job.id);
  releaseProvider();

  const result = await starting;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(cancelledRefs, ['remote-delete-race']);
  assert.deepEqual(requestIds, [job.id, job.id]);
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 0);
  assert.equal(context.database.prepare('SELECT status FROM ocr_jobs WHERE id = ?').get(job.id).status, 'cancelled');
});

test('consent revocation during provider submission preserves a failed remote cancellation for retry', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let releaseProvider;
  let providerEntered;
  const entered = new Promise(resolve => { providerEntered = resolve; });
  const gate = new Promise(resolve => { releaseProvider = resolve; });
  const provider = {
    name: 'sarvam', mode: 'live',
    health: () => ({ provider: 'sarvam', status: 'ready' }),
    async createJob() { providerEntered(); await gate; return { status: 'submitted', jobRef: 'remote-consent-race' }; },
    async getJob() { throw new Error('not reached'); },
    async cancelJob() { throw new Error('synthetic provider cancellation outage'); },
    normalizeResult() { throw new Error('not reached'); },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => new Date(AT),
  });
  const starting = service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  await entered;
  const job = context.database.prepare('SELECT id, started_at FROM ocr_jobs').get();
  assert.equal(job.started_at, AT);
  context.database.prepare(`UPDATE ocr_jobs SET status = 'cancelled', completed_at = ?,
    error_code = 'CONSENT_REVOKED', error_message = NULL, authorization_json = NULL, updated_at = ?
    WHERE id = ?`).run(AT, AT, job.id);
  releaseProvider();

  await assert.rejects(starting, /synthetic provider cancellation outage/);
  assert.deepEqual({ ...context.database.prepare(`SELECT status, provider_job_ref, error_code
    FROM ocr_jobs WHERE id = ?`).get(job.id) }, {
    status: 'cancelled', provider_job_ref: 'remote-consent-race', error_code: 'CONSENT_REVOKED',
  });
});

test('deletion racing an immediate OCR result erases locally and reconciles by durable request id', async t => {
  const context = harness();
  t.after(() => context.database.close());
  let releaseProvider;
  let providerEntered;
  const entered = new Promise(resolve => { providerEntered = resolve; });
  const gate = new Promise(resolve => { releaseProvider = resolve; });
  const cancellations = [];
  const provider = {
    name: 'sarvam', mode: 'live',
    health: () => ({ provider: 'sarvam', status: 'ready' }),
    async createJob({ requestId }) {
      providerEntered();
      await gate;
      return {
        status: 'succeeded',
        result: {
          schemaVersion: 'knowvia.ocr.v1',
          document: { id: 'document-ocr', sourceVersion: '3', contentSha256: SHA },
          provider: { name: 'sarvam', jobRef: 'remote-immediate-result' },
          pages: [{ pageNumber: 1, text: 'must not persist', confidenceBasisPoints: 9000 }],
          warnings: [], requestId,
        },
      };
    },
    async getJob() { throw new Error('not reached'); },
    async cancelJob(input) { cancellations.push(input); return { status: 'cancelled' }; },
    normalizeResult(raw) { return raw; },
  };
  const service = createOcrService({
    repository: context.repository, provider,
    byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => new Date(AT),
  });
  const starting = service.start({ documentId: 'document-ocr', authorization: liveAuthorization });
  await entered;
  const job = context.database.prepare('SELECT id FROM ocr_jobs').get();
  context.database.prepare(`UPDATE ocr_jobs SET status = 'cancelled', completed_at = ?,
    error_code = 'DOCUMENT_DELETED', error_message = NULL, authorization_json = NULL, updated_at = ?
    WHERE id = ?`).run(AT, AT, job.id);
  releaseProvider();

  const result = await starting;
  assert.equal(result.status, 'cancelled');
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 0);
  assert.equal(context.database.prepare('SELECT provider_job_ref FROM ocr_jobs WHERE id = ?').get(job.id).provider_job_ref, null);
  assert.deepEqual(cancellations.map(item => ({ jobRef: item.jobRef, requestId: item.requestId })), [
    { jobRef: 'remote-immediate-result', requestId: job.id },
  ]);
});
