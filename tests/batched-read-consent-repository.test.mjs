// One reading (sarvam) consent grant can name several documents, one exact derive scope each (run V2).
// Synthetic data only. These tests pin the invariant that makes batching safe: live OCR needs a scope whose
// resource_id is the document itself, a clean scan, and the right recipient, so a grant never reaches a
// document it does not name, and revoking it erases what was read from every document it named.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConsentRepository, OcrRepository } from '../src/backend/repositories/index.js';
import { createOcrService } from '../src/features/input/index.js';
import { rawSarvamResult, sarvamShapedFixtureProvider } from './support/sarvam-blocks-fixture.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();

const AT = '2026-09-18T12:00:00.000Z';
const CLEAN_DOCUMENTS = Object.freeze(['document-a', 'document-b']);
const PENDING_DOCUMENT = 'document-pending';
const ADULT = 'adult-batch';
const HOUSEHOLD = 'household-batch';

const sarvamScope = documentId => Object.freeze({
  resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam',
});
const disclosure = consentGrantId => ({ consentGrantId, requestedByAdultId: ADULT, recipient: 'sarvam' });

async function harness(t) {
  const { db: database } = await freshDatabase(t);
  const clock = () => new Date(AT);
  await database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(HOUSEHOLD, 'Synthetic batch household', AT, AT);
  await database.prepare('INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ADULT, 'Synthetic adult', 'active', AT, AT);
  await database.prepare(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-batch', ?, ?, 'owner', 'active', ?)`).run(HOUSEHOLD, ADULT, AT);
  const consents = new ConsentRepository(database, { clock });
  await consents.grant({
    id: 'consent-collect', householdId: HOUSEHOLD, subjectAdultId: ADULT, grantedToActor: 'knowvia', purpose: 'document_processing',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  const insertDocument = database.prepare(`INSERT INTO document_uploads
    (id, household_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename, storage_path,
     content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at,
     logical_document_id, source_version)
    VALUES (?, ?, ?, 'consent-collect', 'policy_schedule', 'synthetic.pdf', ?, ?, 'application/pdf', 128,
      ?, 'fixture_only', 'quarantined', ?, ?, '1')`);
  for (const [index, documentId] of [...CLEAN_DOCUMENTS, PENDING_DOCUMENT].entries()) {
    const clean = documentId !== PENDING_DOCUMENT;
    await insertDocument.run(
      documentId, HOUSEHOLD, ADULT, `fixture/${documentId}`, String(index + 1).repeat(64).slice(0, 64),
      clean ? 'not_scanned_fixture' : 'pending', AT, `logical-${documentId}`,
    );
  }
  // Only the clean documents leave quarantine; the third is still waiting for its scan.
  await database.prepare("UPDATE document_uploads SET lifecycle_state = 'active' WHERE malware_status = 'not_scanned_fixture'").run();
  return { database, consents, repository: new OcrRepository(database), clock };
}

const grantSarvam = (context, id, scopes) => context.consents.grant({
  id, householdId: HOUSEHOLD, subjectAdultId: ADULT, grantedToActor: 'sarvam', purpose: 'document_processing', scopes,
});

// Each call gets its own provider job id, as the real service does (provider_job_ref is unique per provider).
let providerJobs = 0;
function standInProvider() {
  const base = sarvamShapedFixtureProvider();
  return {
    ...base,
    name: 'sarvam',
    mode: 'live',
    async createJob() {
      const jobId = `batch-job-${++providerJobs}`;
      const raw = rawSarvamResult();
      raw.manifest.segments[0].jobId = jobId;
      raw.results[0].job_id = jobId;
      return { status: 'succeeded', jobRef: jobId, result: raw };
    },
  };
}

// Live mode with a local stand-in for the reading service: no network, and the same exact-consent check as production.
const liveService = context => createOcrService({
  repository: context.repository,
  provider: standInProvider(),
  byteReader: async () => Buffer.from('%PDF- synthetic'),
  mode: 'live',
  now: () => new Date(AT),
  pollIntervalMs: 0,
});

const authorizationFor = consentGrantId => Object.freeze({
  authorized: true, consentGrantId, requestedByAdultId: ADULT, purpose: 'document_processing', recipient: 'sarvam', settings: {},
});

test('one grant with two exact sarvam scopes opens both clean documents and not a document still waiting for its scan', pgOptions, async t => {
  const context = await harness(t);
  await grantSarvam(context, 'consent-sarvam', [...CLEAN_DOCUMENTS, PENDING_DOCUMENT].map(sarvamScope));

  for (const documentId of CLEAN_DOCUMENTS) {
    const ready = await context.repository.getReadyDocument(documentId, AT, disclosure('consent-sarvam'));
    assert.notEqual(ready, null, `${documentId} should be readable under the batch grant`);
    assert.equal(ready.documentId, documentId);
    assert.equal(ready.providerConsentGrantId, 'consent-sarvam');
  }
  assert.equal(await context.repository.getReadyDocument(PENDING_DOCUMENT, AT, disclosure('consent-sarvam')), null,
    'a grant never makes an unscanned document readable');

  // The wrong recipient or a different adult is refused for a named document.
  assert.equal(await context.repository.getReadyDocument('document-a', AT, { ...disclosure('consent-sarvam'), recipient: 'google-gemini' }), null);
  assert.equal(await context.repository.getReadyDocument('document-a', AT, { ...disclosure('consent-sarvam'), requestedByAdultId: 'someone-else' }), null);
});

test('a grant does not reach a document it does not name', pgOptions, async t => {
  const context = await harness(t);
  await grantSarvam(context, 'consent-only-a', [sarvamScope('document-a')]);
  assert.notEqual(await context.repository.getReadyDocument('document-a', AT, disclosure('consent-only-a')), null);
  assert.equal(await context.repository.getReadyDocument('document-b', AT, disclosure('consent-only-a')), null);
});

test('a scope with no resource id authorises nothing for OCR', pgOptions, async t => {
  const context = await harness(t);
  await grantSarvam(context, 'consent-null-resource', [{ ...sarvamScope('x'), resourceId: null }]);
  for (const documentId of CLEAN_DOCUMENTS) {
    assert.equal(await context.repository.getReadyDocument(documentId, AT, disclosure('consent-null-resource')), null);
  }
});

test('revoking the batch grant erases what was read from both documents', pgOptions, async t => {
  const context = await harness(t);
  await grantSarvam(context, 'consent-sarvam', CLEAN_DOCUMENTS.map(sarvamScope));
  const service = liveService(context);
  for (const documentId of CLEAN_DOCUMENTS) {
    const job = await service.start({ documentId, authorization: authorizationFor('consent-sarvam') });
    assert.equal(job.status, 'succeeded');
  }
  const before = await context.database.prepare('SELECT document_upload_id, result_json FROM ocr_jobs ORDER BY document_upload_id').all();
  assert.equal(before.length, 2);
  assert.ok(before.every(row => row.result_json !== null), 'results exist before the revoke');

  await context.consents.revoke({ grantId: 'consent-sarvam', revokedByAdultId: ADULT });

  const after = await context.database.prepare('SELECT document_upload_id, result_json FROM ocr_jobs ORDER BY document_upload_id').all();
  assert.deepEqual(after.map(row => [row.document_upload_id, row.result_json]), [['document-a', null], ['document-b', null]]);
  for (const documentId of CLEAN_DOCUMENTS) {
    await assert.rejects(context.repository.getDocumentBlockPages({ documentId, householdId: HOUSEHOLD }),
      error => error.code === 'OCR_PAGES_UNAVAILABLE', 'no readable pages remain after the revoke');
  }
  // The documents themselves were collected under another grant and stay.
  assert.equal((await context.database.prepare("SELECT count(*) AS count FROM document_uploads WHERE lifecycle_state = 'active'").get()).count, 2);
});

test('revoke then re-read: a new grant for the same documents reads them again', pgOptions, async t => {
  const context = await harness(t);
  await grantSarvam(context, 'consent-sarvam', CLEAN_DOCUMENTS.map(sarvamScope));
  const service = liveService(context);
  for (const documentId of CLEAN_DOCUMENTS) await service.start({ documentId, authorization: authorizationFor('consent-sarvam') });
  await context.consents.revoke({ grantId: 'consent-sarvam', revokedByAdultId: ADULT });

  // The withdrawn grant opens nothing; a new one does.
  assert.equal(await context.repository.getReadyDocument('document-a', AT, disclosure('consent-sarvam')), null);
  await grantSarvam(context, 'consent-sarvam-again', CLEAN_DOCUMENTS.map(sarvamScope));
  for (const documentId of CLEAN_DOCUMENTS) {
    assert.notEqual(await context.repository.getReadyDocument(documentId, AT, disclosure('consent-sarvam-again')), null);
    await service.start({ documentId, authorization: authorizationFor('consent-sarvam-again') });
  }

  for (const documentId of CLEAN_DOCUMENTS) {
    const stored = await context.repository.getDocumentBlockPages({ documentId, householdId: HOUSEHOLD });
    assert.equal(stored.complete, true, `${documentId} has readable pages again`);
    assert.deepEqual(stored.pages.map(page => page.page), [1, 2]);
  }
});

// ---- createOrGetJob: which existing job is reused (an erased success is not) ----

const jobValue = (documentId, id) => ({
  id, documentUploadId: documentId, provider: 'sarvam', status: 'queued', contractVersion: 'knowvia.ocr.v2',
  authorization: { authorized: true, consentGrantId: 'consent-sarvam', requestedByAdultId: ADULT, purpose: 'document_processing', recipient: 'sarvam' },
  requestedAt: AT, updatedAt: AT,
});

test('createOrGetJob reuses a succeeded job that still has its result', pgOptions, async t => {
  const context = await harness(t);
  await grantSarvam(context, 'consent-sarvam', CLEAN_DOCUMENTS.map(sarvamScope));
  const service = liveService(context);
  const first = await service.start({ documentId: 'document-a', authorization: authorizationFor('consent-sarvam') });
  const second = await service.start({ documentId: 'document-a', authorization: authorizationFor('consent-sarvam') });
  assert.equal(second.id, first.id, 'no second paid read for a document that already has its result');
  assert.equal((await context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get()).count, 1);
});

test('createOrGetJob does not reuse a succeeded job whose result was erased', pgOptions, async t => {
  const context = await harness(t);
  const first = await context.repository.createOrGetJob(jobValue('document-a', 'job-erased'));
  assert.equal(first.created, true);
  await context.database.prepare(`UPDATE ocr_jobs SET status = 'succeeded', result_json = NULL, result_digest = NULL,
    provider_job_ref = NULL WHERE id = 'job-erased'`).run();
  const next = await context.repository.createOrGetJob(jobValue('document-a', 'job-fresh'), { anyContract: true });
  assert.equal(next.created, true);
  assert.equal(next.job.id, 'job-fresh');
  // The erased row is kept, not deleted or reused.
  assert.deepEqual((await context.database.prepare('SELECT id, status, result_json FROM ocr_jobs ORDER BY id').all())
    .map(row => [row.id, row.status, row.result_json]), [['job-erased', 'succeeded', null], ['job-fresh', 'queued', null]]);
  // And the fresh in-flight job is reused from then on.
  const again = await context.repository.createOrGetJob(jobValue('document-a', 'job-third'), { anyContract: true });
  assert.deepEqual([again.created, again.job.id], [false, 'job-fresh']);
});

test('createOrGetJob reuses queued and running jobs', pgOptions, async t => {
  const context = await harness(t);
  for (const status of ['queued', 'submitted', 'processing']) {
    await context.database.prepare('DELETE FROM ocr_jobs').run();
    await context.repository.createOrGetJob(jobValue('document-b', `job-${status}`));
    if (status !== 'queued') {
      await context.database.prepare('UPDATE ocr_jobs SET status = ?, provider_job_ref = ? WHERE id = ?').run(status, `ref-${status}`, `job-${status}`);
    }
    const again = await context.repository.createOrGetJob(jobValue('document-b', `other-${status}`), { anyContract: true });
    assert.deepEqual([again.created, again.job.id], [false, `job-${status}`], status);
  }
});

test('two concurrent starts for one document create exactly one job', pgOptions, async t => {
  const context = await harness(t);
  const results = await Promise.all([
    context.repository.createOrGetJob(jobValue('document-a', 'job-race-1'), { anyContract: true }),
    context.repository.createOrGetJob(jobValue('document-a', 'job-race-2'), { anyContract: true }),
  ]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(results[0].job.id, results[1].job.id);
  assert.equal((await context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get()).count, 1);
});

test('after an erased success a concurrent double start creates one fresh job', pgOptions, async t => {
  const context = await harness(t);
  await context.repository.createOrGetJob(jobValue('document-a', 'job-old'));
  await context.database.prepare("UPDATE ocr_jobs SET status = 'succeeded', result_json = NULL, provider_job_ref = NULL WHERE id = 'job-old'").run();
  const results = await Promise.all([
    context.repository.createOrGetJob(jobValue('document-a', 'job-new-1'), { anyContract: true }),
    context.repository.createOrGetJob(jobValue('document-a', 'job-new-2'), { anyContract: true }),
  ]);
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal((await context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get()).count, 2);
});

test('createOrGetJob still reuses a succeeded job with no stored result when its page text is still stored (legacy job)', pgOptions, async t => {
  const context = await harness(t);
  await context.repository.createOrGetJob(jobValue('document-a', 'job-legacy'));
  await context.database.prepare(`UPDATE ocr_jobs SET status = 'succeeded', result_json = NULL, result_digest = NULL,
    provider_job_ref = NULL WHERE id = 'job-legacy'`).run();
  await context.database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256, extracted_text, extraction_status, created_at)
    VALUES ('page-legacy-1', 'document-a', 'job-legacy', 1, '1', ?, 'Synthetic page text.', 'extracted', ?)`).run('c'.repeat(64), AT);
  const again = await context.repository.createOrGetJob(jobValue('document-a', 'job-should-not-exist'), { anyContract: true });
  assert.deepEqual([again.created, again.job.id], [false, 'job-legacy'], 'stored page text means the document was read: no silent paid rerun');
  assert.equal((await context.database.prepare('SELECT count(*) AS count FROM ocr_jobs').get()).count, 1);

  // Once that text is erased the same job counts as erased and a fresh one is created.
  await context.database.prepare("UPDATE source_pages SET extracted_text = NULL, extraction_status = 'failed' WHERE id = 'page-legacy-1'").run();
  const fresh = await context.repository.createOrGetJob(jobValue('document-a', 'job-after-erasure'), { anyContract: true });
  assert.deepEqual([fresh.created, fresh.job.id], [true, 'job-after-erasure']);
});
