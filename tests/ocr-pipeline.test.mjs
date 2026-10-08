import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, sql } from './helpers/test-database.js';
import { OcrRepository } from '../src/backend/repositories/index.js';
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

async function harness({ active = true, expiresAt = '2026-09-19T12:00:00.000Z' } = {}) {
  const database = await createTestDatabase();
  await sql.run(database, 'INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'household-ocr', 'Synthetic OCR household', AT, AT);
  await sql.run(database, 'INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', 'adult-ocr', 'Synthetic adult', 'active', AT, AT);
  await sql.run(database, `INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)`, 'role-ocr', 'household-ocr', 'adult-ocr', 'owner', 'active', AT,);
  await sql.run(database, `INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'consent-ocr', 'household-ocr', 'adult-ocr', 'knowvia', 'document_processing',
    'v1', 'fixture', AT, expiresAt, AT,);
  await sql.run(database, `INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, action, data_category, created_at)
    VALUES (?, ?, 'document', 'collect', 'insurance_document', ?)`, 'scope-ocr', 'consent-ocr', AT);
  await sql.run(database, `INSERT INTO document_uploads
    (id, household_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size,
     malware_status, encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, 'document-ocr', 'household-ocr', 'adult-ocr', 'consent-ocr', 'policy_schedule',
    'synthetic.pdf', 'fixture/document-ocr', SHA, 'application/pdf', 128,
    'not_scanned_fixture', 'fixture_only', 'quarantined', AT, 'policy-synthetic', '3',);
  if (active) await sql.run(database, "UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'document-ocr'");
  return { database, repository: new OcrRepository(database) };
}

test('fixture OCR persists versioned structured output and page provenance with zero provider calls', async t => {
  const context = await harness();
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

  const stored = await sql.all(context.database, 'SELECT * FROM source_pages ORDER BY page_number');
  assert.equal(stored.length, 2);
  assert.equal(stored[0].output_contract_version, 'knowvia.ocr.v1');
  assert.equal(JSON.parse(stored[0].provenance_json).contentSha256, SHA);
  assert.equal(stored[0].text_sha256.length, 64);
});

test('authorization, consent and quarantine checks fail closed before OCR work', async t => {
  const context = await harness({ active: false });
  t.after(() => context.database.close());
  const service = createOcrService({ repository: context.repository, provider: createFixtureOcrProvider(), mode: 'fixture', now: () => new Date(AT) });
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization }),
    error => error.code === 'DOCUMENT_NOT_OCR_READY',
  );
  assert.equal((await sql.get(context.database, 'SELECT count(*) AS count FROM ocr_jobs')).count, 0);

  await sql.run(context.database, "UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'document-ocr'");
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization: { ...authorization, requestedByAdultId: 'other' } }),
    error => error.code === 'OCR_AUTHORIZATION_REQUIRED',
  );
  assert.equal((await sql.get(context.database, 'SELECT count(*) AS count FROM ocr_jobs')).count, 0);
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
  const context = await harness();
  t.after(() => context.database.close());
  const service = createOcrService({
    repository: context.repository,
    provider: createSarvamOcrProvider({ env: {} }),
    byteReader: async () => Buffer.from('%PDF- synthetic'),
    mode: 'live',
    now: () => new Date(AT),
  });
  await assert.rejects(
    service.start({ documentId: 'document-ocr', authorization }),
    error => error.code === 'PROVIDER_NOT_CONFIGURED',
  );
  const failed = await sql.get(context.database, 'SELECT status, error_code FROM ocr_jobs');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error_code, 'PROVIDER_NOT_CONFIGURED');
});

test('verified live transport normalizes provider data and never persists its raw payload', async t => {
  const context = await harness();
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
  const provider = createSarvamOcrProvider({ env: { SARVAM_API_KEY: 'test-only' }, transport });
  const service = createOcrService({ repository: context.repository, provider, byteReader: async () => Buffer.from('%PDF- synthetic'), mode: 'live', now: () => new Date(AT) });
  const submitted = await service.start({ documentId: 'document-ocr', authorization });
  assert.equal(submitted.status, 'submitted');
  const completed = await service.refresh(submitted.id, { authorization });
  assert.equal(completed.status, 'succeeded');
  assert.equal(JSON.stringify(completed).includes('must-not-persist'), false);
  assert.equal((await sql.get(context.database, 'SELECT result_json FROM ocr_jobs WHERE id = ?', submitted.id)).result_json.includes('must-not-persist'), false);
});
