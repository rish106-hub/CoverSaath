// S3.2 WP2b: the intake repositories (OCR, document, evidence, clause, policy structuring) on the
// async PostgreSQL interface. Cross-household denial, erasure of derived rows, row-lock races,
// idempotency under concurrency, int8 counts as Numbers and the section-4 silent-failure sites.
// Repositories owned by other work packages (consent, coverage parameters) are replaced by small
// local doubles; rows they would write are seeded with direct SQL. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { ClauseRepository, ftsQuery } from '../src/backend/repositories/clause-repository.js';
import { DocumentRepository } from '../src/backend/repositories/document-repository.js';
import { EvidenceRepository } from '../src/backend/repositories/evidence-repository.js';
import { OcrRepository } from '../src/backend/repositories/ocr-repository.js';
import { PolicyStructuringRepository } from '../src/backend/repositories/policy-structuring-repository.js';
import { buildClauses } from '../src/features/policy-evidence/index.js';
import { buildStoredBlocks } from '../src/features/input/index.js';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { parameterAt as AT, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();
const clock = () => new Date(AT);
const sha = text => createHash('sha256').update(text).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const HOUSEHOLD = 'household-parameters';
const CASE = 'case-parameters';
const ADULT = 'adult-parameters';
const RUN = 'run-parameters';
const DOCUMENT = 'document-parameters';
const INTRUDER = 'household-intruder';
const INTRUDER_CASE = 'case-intruder';
const INTRUDER_DOCUMENT = 'document-intruder';
const PIPELINE = 'policy-structuring/v-test';

// A second household with its own adult, consent, case and active document.
async function seedIntruder(db) {
  await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [INTRUDER, 'Other', AT, AT]);
  await db.run(`INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at)
    VALUES ('adult-intruder', 'Other adult', 'active', ?, ?)`, [AT, AT]);
  await db.run(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-intruder', ?, 'adult-intruder', 'owner', 'active', ?)`, [INTRUDER, AT]);
  await db.run(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-intruder', ?, 'adult-intruder', 'Other adult', 'adult', ?, ?)`, [INTRUDER, AT, AT]);
  await db.run(`INSERT INTO consent_grants (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
    evidence_method, granted_at, created_at) VALUES ('consent-intruder', ?, 'adult-intruder', 'knowvia-local',
    'document_processing', 'v1', 'fixture', ?, ?)`, [INTRUDER, AT, AT]);
  await db.run(`INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, 'member-intruder', 'adult-intruder', 'renewal', 'processing', ?, ?)`, [INTRUDER_CASE, INTRUDER, AT, AT]);
  await db.run(`INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
    original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state,
    uploaded_at, source_version, logical_document_id)
    VALUES (?, ?, ?, 'adult-intruder', 'consent-intruder', 'policy_schedule', 'other.pdf', 'fixture/intruder', ?,
      'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, '1', 'logical-shared')`,
  [INTRUDER_DOCUMENT, INTRUDER, INTRUDER_CASE, 'f'.repeat(64), AT]);
}

// A fresh active document of the main household with no OCR job yet.
async function seedFreshDocument(db, id = 'document-fresh', { version = '1' } = {}) {
  await db.run(`INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
    original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state,
    uploaded_at, source_version, logical_document_id)
    VALUES (?, ?, ?, ?, 'consent-parameters', 'policy_schedule', 'fresh.pdf', ?, ?, 'application/pdf', 4096, 'clean',
      'encrypted_local', 'active', ?, ?, ?)`, [id, HOUSEHOLD, CASE, ADULT, `fixture/${id}`, sha(id), AT, version, `logical-${id}`]);
  return id;
}

async function world(t) {
  const { db } = await freshDatabase(t);
  await seedParameterWorld(db);
  await seedIntruder(db);
  await db.run(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, action, data_category, created_at)
    VALUES ('scope-parameters', 'consent-parameters', 'document', 'collect', 'insurance_document', ?)`, [AT]);
  const audit = new AuditRepository(db, { clock });
  return { db, audit };
}

const count = async (db, sql, params = []) => (await db.one(`SELECT count(*) AS count FROM ${sql}`, params)).count;
const auditPayloads = async (db, action) => (await db.many('SELECT event_payload_json FROM audit_events WHERE action = ? ORDER BY id', [action]))
  .map(row => JSON.parse(row.event_payload_json));

// --- OCR -----------------------------------------------------------------------------------------

const authorization = { authorized: true, consentGrantId: 'consent-parameters', requestedByAdultId: ADULT, purpose: 'document_processing' };
const jobValue = (documentId, id, extra = {}) => ({
  id, documentUploadId: documentId, provider: 'fixture', status: 'processing', contractVersion: 'knowvia.ocr.v2',
  authorization, requestedAt: AT, updatedAt: AT, ...extra,
});
const pageText = number => `Synthetic page ${number} text`;
function ocrPages(documentId, { version = '1', blocks = true, numbers = [1, 2] } = {}) {
  return numbers.map(number => ({
    documentUploadId: documentId, pageNumber: number, sourceVersion: version, textSha256: sha(pageText(number)),
    text: pageText(number), extractionStatus: 'extracted', confidenceBasisPoints: 9000, createdAt: AT,
    outputContractVersion: blocks ? 'knowvia.ocr.v2' : 'knowvia.ocr.v1', providerPageRef: `ref:${number}`, provenance: { fixture: true },
    blocks: blocks ? buildStoredBlocks([{ tag: 'paragraph', text: pageText(number), readingOrder: 1 }], pageText(number)) : null,
  }));
}
const succeeded = digest => ({ status: 'succeeded', resultDigest: digest, completedAt: AT, updatedAt: AT });

test('OCR: jobs, pages and blocks round-trip with Number counts and household-scoped block reads', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documentId = await seedFreshDocument(db);

  const ready = await ocr.getReadyDocument(documentId, AT);
  assert.equal(ready.documentId, documentId);
  assert.equal(ready.byteSize, 4096);
  assert.equal(typeof ready.byteSize, 'number');
  assert.equal(await ocr.getReadyDocument(INTRUDER_DOCUMENT, AT), null, 'no collect scope on the other household grant');

  const claimed = await ocr.createOrGetJob(jobValue(documentId, 'ocr-job-1'));
  assert.equal(claimed.created, true);
  assert.equal(claimed.job.attemptCount, 1);
  assert.equal(typeof claimed.job.attemptCount, 'number');
  const again = await ocr.createOrGetJob(jobValue(documentId, 'ocr-job-2'));
  assert.deepEqual([again.created, again.job.id], [false, 'ocr-job-1']);

  const done = await ocr.completeJob('ocr-job-1', ocrPages(documentId), succeeded('a'.repeat(64)));
  assert.equal(done.status, 'succeeded');
  const stored = await ocr.getDocumentBlockPages({ documentId, householdId: HOUSEHOLD });
  assert.equal(stored.complete, true);
  assert.deepEqual(stored.pages.map(page => [page.page, page.status]), [[1, 'stored'], [2, 'stored']]);
  assert.equal(typeof stored.pages[0].page, 'number');
  await assert.rejects(ocr.getDocumentBlockPages({ documentId, householdId: INTRUDER }), { code: 'DOCUMENT_NOT_FOUND' });
  await assert.rejects(ocr.getDocumentBlockPages({ documentId: INTRUDER_DOCUMENT, householdId: HOUSEHOLD }), { code: 'DOCUMENT_NOT_FOUND' });
  // The seeded document holds only page 2: incomplete pages fail closed.
  await assert.rejects(ocr.getDocumentBlockPages({ documentId: DOCUMENT, householdId: HOUSEHOLD }), { code: 'OCR_PAGES_INCOMPLETE' });

  const actions = (await db.many("SELECT action FROM audit_events WHERE resource_type = 'ocr_job' ORDER BY id")).map(row => row.action);
  assert.deepEqual(actions, ['ocr.job_created', 'ocr.job_succeeded']);
  assert.deepEqual((await auditPayloads(db, 'ocr.job_succeeded'))[0].pageCount, 2);
});

test('OCR: expired consent and a mismatched disclosure grant make the document not ready', pgOptions, async t => {
  const { db } = await world(t);
  const ocr = new OcrRepository(db);
  const documentId = await seedFreshDocument(db);
  await db.run("UPDATE consent_grants SET expires_at = '2026-10-09T11:00:00.000Z' WHERE id = 'consent-parameters'");
  assert.ok(await ocr.getReadyDocument(documentId, AT));
  assert.equal(await ocr.getReadyDocument(documentId, '2026-10-09T12:00:00.000Z'), null);
  assert.equal(await ocr.getReadyDocument(documentId, AT, {
    consentGrantId: 'consent-parameters', recipient: 'sarvam', requestedByAdultId: ADULT,
  }), null, 'no derive scope for the recipient');
});

test('OCR: a v1 document needs a blocks upgrade and the upgrade fills blocks once', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-v1', { contractVersion: 'knowvia.ocr.v1' }));
  await ocr.completeJob('ocr-v1', ocrPages(documentId, { blocks: false }), succeeded('b'.repeat(64)));
  assert.deepEqual(await ocr.getBlocksUpgradeState(documentId), { needed: true, pages: 2 });
  const upgrade = await ocr.createOrGetJob(jobValue(documentId, 'ocr-upgrade', { authorization: { ...authorization, blocksUpgrade: true } }));
  assert.equal(upgrade.created, true);
  const changed = ocrPages(documentId).map(page => ({ ...page, textSha256: sha('different') }));
  await assert.rejects(ocr.attachUpgradeBlocks('ocr-upgrade', changed, succeeded('c'.repeat(64))), { code: 'OCR_UPGRADE_TEXT_CHANGED' });
  assert.equal(await count(db, 'source_pages WHERE document_upload_id = ? AND blocks_json IS NOT NULL', [documentId]), 0);
  const attached = await ocr.attachUpgradeBlocks('ocr-upgrade', ocrPages(documentId), succeeded('c'.repeat(64)));
  assert.equal(attached.status, 'succeeded');
  assert.equal(await count(db, 'source_pages WHERE document_upload_id = ? AND blocks_upgrade_job_id = ?', [documentId, 'ocr-upgrade']), 2);
  assert.deepEqual(await ocr.getBlocksUpgradeState(documentId), { needed: false, pages: 2 });
  assert.equal((await ocr.attachUpgradeBlocks('ocr-upgrade', ocrPages(documentId), succeeded('c'.repeat(64)))).status, 'succeeded', 'same digest replays');
  await assert.rejects(ocr.attachUpgradeBlocks('ocr-upgrade', ocrPages(documentId), succeeded('d'.repeat(64))), { code: 'OCR_JOB_ALREADY_COMPLETED' });
  await assert.rejects(ocr.attachUpgradeBlocks('ocr-v1', ocrPages(documentId), succeeded('d'.repeat(64))), { code: 'OCR_UPGRADE_NOT_NEEDED' });
});

test('OCR concurrency: ten concurrent requests for one document create one job', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documentId = await seedFreshDocument(db);
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => ocr.createOrGetJob(jobValue(documentId, `ocr-race-${index}`))));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(new Set(results.map(result => result.job.id)).size, 1);
  assert.equal(await count(db, 'ocr_jobs WHERE document_upload_id = ?', [documentId]), 1);
  assert.equal(await count(db, "audit_events WHERE action = 'ocr.job_created'"), 1);
});

test('OCR concurrency: a double completion stores the pages once; a different digest fails closed', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-double'));
  const same = await Promise.all([1, 2, 3].map(() => ocr.completeJob('ocr-double', ocrPages(documentId), succeeded('e'.repeat(64)))));
  assert.ok(same.every(job => job.status === 'succeeded' && job.resultDigest === 'e'.repeat(64)));
  assert.equal(await count(db, 'source_pages WHERE ocr_job_id = ?', ['ocr-double']), 2);
  assert.equal(await count(db, "audit_events WHERE action = 'ocr.job_succeeded'"), 1);

  await seedFreshDocument(db, 'document-fresh-2');
  await ocr.createOrGetJob(jobValue('document-fresh-2', 'ocr-differs'));
  const settled = await Promise.allSettled([
    ocr.completeJob('ocr-differs', ocrPages('document-fresh-2'), succeeded('1'.repeat(64))),
    ocr.completeJob('ocr-differs', ocrPages('document-fresh-2'), succeeded('2'.repeat(64))),
  ]);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(settled.find(result => result.status === 'rejected').reason.code, 'OCR_JOB_ALREADY_COMPLETED');
  assert.equal(await count(db, 'source_pages WHERE ocr_job_id = ?', ['ocr-differs']), 2);
});

// Holds the job row lock in a separate transaction until `release` resolves.
function holdJobRow(db, jobId, whileHeld) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let locked;
  const lockedPromise = new Promise(resolve => { locked = resolve; });
  const holder = db.transaction(async () => {
    await db.one('SELECT id FROM ocr_jobs WHERE id = ? FOR UPDATE', [jobId]);
    locked();
    await gate;
    await whileHeld();
  });
  return { holder, locked: lockedPromise, release: () => release() };
}

test('OCR row lock: completion waits for the job row and fails closed when it was cancelled meanwhile', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-locked'));
  const hold = holdJobRow(db, 'ocr-locked', () => db.run("UPDATE ocr_jobs SET status = 'cancelled', error_code = 'DOCUMENT_DELETED' WHERE id = 'ocr-locked'"));
  await hold.locked;
  let settled = false;
  const completion = ocr.completeJob('ocr-locked', ocrPages(documentId), succeeded('3'.repeat(64)));
  const observed = completion.then(() => 'fulfilled', error => error).finally(() => { settled = true; });
  await sleep(150);
  assert.equal(settled, false, 'completion must wait for the row lock');
  hold.release();
  await hold.holder;
  const outcome = await observed;
  assert.ok(outcome instanceof Error);
  assert.match(outcome.message, /changed before completion/);
  assert.equal(await count(db, 'source_pages WHERE ocr_job_id = ?', ['ocr-locked']), 0, 'no page survives a failed completion');
  assert.equal((await ocr.getJob('ocr-locked')).status, 'cancelled');
});

test('OCR row lock: an update waits for the job row and never revives a cancelled job', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-update'));
  const hold = holdJobRow(db, 'ocr-update', () => db.run("UPDATE ocr_jobs SET status = 'cancelled', error_code = 'CONSENT_REVOKED' WHERE id = 'ocr-update'"));
  await hold.locked;
  let settled = false;
  const update = ocr.updateJob('ocr-update', { status: 'submitted', providerJobRef: 'remote-1' }).finally(() => { settled = true; });
  await sleep(150);
  assert.equal(settled, false, 'update must wait for the row lock');
  hold.release();
  await hold.holder;
  const result = await update;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.providerJobRef, null);
  assert.equal(await ocr.updateJob('ocr-missing', { status: 'failed' }), null);
});

// --- Documents -----------------------------------------------------------------------------------

const uploadRecord = (id, extra = {}) => ({
  id, householdId: HOUSEHOLD, caseId: CASE, uploadedByAdultId: ADULT, consentGrantId: 'consent-parameters',
  documentKind: 'policy_schedule', originalFilename: 'upload.pdf', storageKey: `store/${id}`, contentSha256: sha(`content:${id}`),
  mimeType: 'application/pdf', byteSize: 2048, malwareStatus: 'pending', encryptionStatus: 'encrypted_local', createdAt: AT,
  logicalDocumentId: `logical-${id}`, version: 1, ...extra,
});

// Collaborators owned by other work packages. Async on purpose: a missing await shows as undefined counts.
function erasureDoubles({ fail = false } = {}) {
  const calls = [];
  return {
    calls,
    coverageParameters: {
      async redactObservationsForDocument(input) { calls.push(['observations', input.documentId]); await sleep(5); return { redactedObservations: 3 }; },
    },
    consents: {
      async eraseDerivedRunData(input) {
        calls.push(['derived', input.householdId, input.documentIds]);
        await sleep(5);
        if (fail) throw Object.assign(new Error('synthetic failure'), { code: 'SYNTHETIC_FAILURE' });
        return { runs: 1, tasks: 2, facts: 0, policies: 0, policyMembers: 0, graphs: 0, graphNodes: 0, graphEdges: 0 };
      },
    },
  };
}

test('documents: create with idempotency, household-scoped reads and Number counts', pgOptions, async t => {
  const { db, audit } = await world(t);
  const documents = new DocumentRepository(db, { clock, audit });
  const created = await documents.createDocument(uploadRecord('upload-1'), {
    actorAdultId: ADULT,
    idempotency: { scope: 'document-upload:case-parameters', key: 'idem-1', requestDigest: 'd'.repeat(64), expiresAt: '2026-10-10T10:00:00.000Z', response: record => ({ document: { id: record.id } }) },
  });
  assert.equal(created.lifecycleState, 'quarantined');
  assert.equal(created.byteSize, 2048);
  assert.equal(typeof created.scanAttempts, 'number');
  assert.equal((await documents.findIdempotency('document-upload:case-parameters', 'idem-1')).response_status, 201);
  assert.equal(await documents.findIdempotency('document-upload:case-parameters', 'idem-1', '2026-10-11T00:00:00.000Z'), null, 'expired key is purged');

  assert.equal((await documents.findByHash(HOUSEHOLD, created.contentSha256)).id, 'upload-1');
  assert.equal(await documents.findByHash(INTRUDER, created.contentSha256), null);
  assert.equal((await documents.findVersion(HOUSEHOLD, 'logical-upload-1', 1)).id, 'upload-1');
  assert.equal(await documents.findVersion(INTRUDER, 'logical-upload-1', 1), null);
  assert.deepEqual((await documents.listForCase(CASE, INTRUDER)).length, 0);
  assert.ok((await documents.listForCase(CASE, HOUSEHOLD)).some(record => record.id === 'upload-1'));
  assert.equal(await documents.countPendingForHousehold(HOUSEHOLD), 1);
  assert.equal(await documents.countPendingForHousehold(INTRUDER), 0);
  const active = await documents.countActiveForCase(CASE);
  assert.equal(typeof active, 'number');
  assert.equal(active, 3);
  assert.equal((await documents.getConsent('consent-parameters')).scopes[0].action, 'collect');
  assert.throws(() => documents.updateDocument(), { code: 'DOCUMENT_UPDATE_NOT_SUPPORTED' });
  assert.deepEqual((await auditPayloads(db, 'document.uploaded'))[0], { byteSize: 2048, documentKind: 'policy_schedule', mimeType: 'application/pdf' });
});

test('documents: latest active versions are household-scoped and fail closed on a bad version', pgOptions, async t => {
  const { db } = await world(t);
  const documents = new DocumentRepository(db, { clock });
  await seedFreshDocument(db, 'doc-v2', { version: '2' });
  await db.run("UPDATE document_uploads SET logical_document_id = 'logical-shared' WHERE id = 'doc-v2'");
  await seedFreshDocument(db, 'doc-v5', { version: '5' });
  await db.run("UPDATE document_uploads SET logical_document_id = 'logical-shared' WHERE id = 'doc-v5'");
  assert.deepEqual([...await documents.latestActiveVersions(HOUSEHOLD, ['logical-shared', 'logical-absent'])], [['logical-shared', 5]]);
  // The intruder's document shares the logical id but never leaks across households.
  assert.deepEqual([...await documents.latestActiveVersions(INTRUDER, ['logical-shared'])], [['logical-shared', 1]]);
  assert.equal((await documents.latestActiveVersions('household-none', ['logical-shared'])).size, 0);
  await seedFreshDocument(db, 'doc-bad', { version: 'v7' });
  await db.run("UPDATE document_uploads SET logical_document_id = 'logical-shared' WHERE id = 'doc-bad'");
  assert.ok(Number.isNaN((await documents.latestActiveVersions(HOUSEHOLD, ['logical-shared'])).get('logical-shared')));
  assert.equal((await documents.latestActiveVersions(HOUSEHOLD, [])).size, 0);
  await assert.rejects(documents.latestActiveVersions(HOUSEHOLD, Array.from({ length: 1001 }, (_, index) => `l-${index}`)), { code: 'DOCUMENT_INPUT_INVALID' });
});

test('documents: scan transitions, worker queue, deferrals and the completed tombstone', pgOptions, async t => {
  const { db, audit } = await world(t);
  const documents = new DocumentRepository(db, { clock, audit });
  await documents.createDocument(uploadRecord('scan-clean'), {});
  await documents.createDocument(uploadRecord('scan-blocked'), {
    idempotency: { scope: 'document-upload:case-parameters', key: 'idem-blocked', requestDigest: 'e'.repeat(64), expiresAt: '2026-10-10T10:00:00.000Z', response: record => ({ document: { id: record.id } }) },
  });
  assert.deepEqual(await documents.listWorkDocumentIds({ includePendingScans: true }), ['scan-blocked', 'scan-clean']);
  assert.equal(await documents.deferScan('scan-clean', { nextScanAt: '2026-10-09T11:00:00.000Z' }), true);
  assert.deepEqual(await documents.listWorkDocumentIds({ includePendingScans: true }), ['scan-blocked']);
  assert.equal((await documents.getDocument('scan-clean')).scanAttempts, 1);
  assert.equal(await documents.markScanClean('scan-clean', { engine: 'fixture' }), true);
  assert.equal(await documents.markScanClean('scan-clean'), false, 'a second clean is a no-op');
  assert.equal(await documents.markScanClean('document-missing'), false);
  assert.equal(await documents.markScanBlocked('scan-blocked', { reasonCode: 'MALWARE' }), true);
  assert.deepEqual(await documents.listWorkDocumentIds({ includePendingScans: false }), ['scan-blocked']);
  assert.equal(await documents.deferDeletion('scan-blocked', { nextScanAt: '2026-10-09T09:00:00.000Z' }), true);
  assert.ok((await documents.liveStorageKeys()).has('store/scan-blocked'));

  assert.equal(await documents.completeDeletion('scan-blocked'), true);
  assert.equal(await documents.completeDeletion('scan-blocked'), false);
  const tombstone = await documents.getDocument('scan-blocked');
  assert.equal(tombstone.lifecycleState, 'deleted');
  assert.equal(tombstone.originalFilename, '[deleted]');
  assert.ok(!(await documents.liveStorageKeys()).has('store/scan-blocked'));
  // The JSON path lookup (was json_extract) removes the upload idempotency record with the document.
  assert.equal(await count(db, 'idempotency_keys WHERE idempotency_key = ?', ['idem-blocked']), 0);
  assert.deepEqual((await db.many("SELECT action FROM audit_events WHERE resource_id = 'scan-blocked' ORDER BY id")).map(row => row.action),
    ['document.uploaded', 'document.scan_blocked', 'document.bytes_deleted']);
  assert.equal(await documents.purgeExpiredIdempotency('2027-01-01T00:00:00.000Z'), 0);
});

test('documents: erasure removes every derived row of the document and only that document', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const clauses = new ClauseRepository(db, { clock, audit });
  const doubles = erasureDoubles();
  const documents = new DocumentRepository(db, { clock, audit, ...doubles });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-erase'));
  await ocr.completeJob('ocr-erase', ocrPages(documentId), succeeded('4'.repeat(64)));
  await seedFreshDocument(db, 'document-keep');
  await ocr.createOrGetJob(jobValue('document-keep', 'ocr-keep', { status: 'submitted' }));
  await db.run("UPDATE ocr_jobs SET provider_job_ref = 'remote-erase' WHERE id = 'ocr-erase'");
  const built = buildClauses(await ocr.getDocumentBlockPages({ documentId, householdId: HOUSEHOLD }), { documentId, sourceVersion: '1' });
  await clauses.saveClauses({ householdId: HOUSEHOLD, caseId: CASE, documentId, clauses: built.clauses });
  await clauses.saveAnswer(answerInput({ documentIds: [documentId] }));

  const erased = await documents.requestDeletion(documentId, { actorAdultId: ADULT });
  assert.equal(erased.state, 'pending');
  assert.equal(erased.document.lifecycleState, 'deletion_requested');
  assert.deepEqual(doubles.calls.map(call => call[0]), ['observations', 'derived']);
  assert.equal(await count(db, 'source_pages WHERE document_upload_id = ? AND (extracted_text IS NOT NULL OR blocks_json IS NOT NULL OR text_sha256 IS NOT NULL)', [documentId]), 0);
  assert.equal(await count(db, 'ocr_jobs WHERE document_upload_id = ? AND (authorization_json IS NOT NULL OR result_json IS NOT NULL)', [documentId]), 0);
  assert.equal(await count(db, 'policy_clauses WHERE document_id = ?', [documentId]), 0);
  assert.equal(await count(db, 'policy_answers'), 0);
  // The other document keeps its job.
  assert.equal((await ocr.getJob('ocr-keep')).status, 'submitted');
  const [payload] = await auditPayloads(db, 'document.deletion_requested');
  assert.deepEqual([payload.ocrJobs, payload.sourcePages, payload.observations, payload.runs, payload.tasks], [1, 2, 3, 1, 2]);
  assert.deepEqual((await documents.listPendingOcrCancellations(documentId)), []);

  assert.equal((await documents.requestDeletion(documentId, { actorAdultId: ADULT })).state, 'pending', 'idempotent');
  assert.equal(await documents.requestDeletion('document-missing', { actorAdultId: ADULT }), null);
  await assert.rejects(new DocumentRepository(db, { clock, audit }).requestDeletion('document-keep', { actorAdultId: ADULT }), { code: 'ERASURE_NOT_CONFIGURED' });
});

test('documents: an in-flight provider job is cancelled on erasure and listed with its camelCase reference', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documents = new DocumentRepository(db, { clock, audit, ...erasureDoubles() });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-inflight', { status: 'submitted' }));
  await ocr.updateJob('ocr-inflight', { providerJobRef: 'remote-inflight' });
  await documents.requestDeletion(documentId, { actorAdultId: ADULT });
  const job = await ocr.getJob('ocr-inflight');
  assert.deepEqual([job.status, job.errorCode, job.providerJobRef], ['cancelled', 'DOCUMENT_DELETED', 'remote-inflight']);
  assert.deepEqual(await documents.listPendingOcrCancellations(documentId), [{ id: 'ocr-inflight', provider: 'fixture', providerJobRef: 'remote-inflight' }]);
  assert.equal(await documents.completeOcrCancellation('ocr-inflight', { remoteCancellation: false }), true);
  assert.equal((await ocr.getJob('ocr-inflight')).errorCode, 'OCR_PROVIDER_CANCELLATION_UNSUPPORTED');
  assert.equal(await documents.completeOcrCancellation('ocr-inflight'), false, 'only DOCUMENT_DELETED or CONSENT_REVOKED rows complete');
  // OcrRepository completes a cancellation on any cancelled row.
  assert.equal((await ocr.completeCancellation('ocr-inflight')).providerJobRef, null);
  assert.equal((await ocr.recordCancellationReference('ocr-inflight', 'late-ref')).providerJobRef, null, 'error code no longer qualifies');
});

test('documents: a failing erasure collaborator rolls back the whole erasure', pgOptions, async t => {
  const { db, audit } = await world(t);
  const ocr = new OcrRepository(db, { audit });
  const documents = new DocumentRepository(db, { clock, audit, ...erasureDoubles({ fail: true }) });
  const documentId = await seedFreshDocument(db);
  await ocr.createOrGetJob(jobValue(documentId, 'ocr-rollback'));
  await ocr.completeJob('ocr-rollback', ocrPages(documentId), succeeded('5'.repeat(64)));
  await assert.rejects(documents.requestDeletion(documentId, { actorAdultId: ADULT }), { code: 'SYNTHETIC_FAILURE' });
  assert.equal((await documents.getDocument(documentId)).lifecycleState, 'active');
  assert.equal(await count(db, 'source_pages WHERE document_upload_id = ? AND extracted_text IS NOT NULL', [documentId]), 2);
  assert.equal(await count(db, "audit_events WHERE action = 'document.deletion_requested'"), 0);
});

// --- Evidence facts ------------------------------------------------------------------------------

test('evidence: facts append and read back; a fact cannot cite another household', pgOptions, async t => {
  const { db } = await world(t);
  const evidence = new EvidenceRepository(db, { clock });
  const fact = await evidence.append({
    householdId: HOUSEHOLD, caseId: CASE, factKey: 'policy.sum_insured', value: { amountMinor: 500000 },
    epistemicState: 'known', provenanceKind: 'document_page', sourcePageId: 'page-parameters', assertedBy: 'fixture',
    confidenceBasisPoints: 8000,
  });
  assert.deepEqual(fact.value, { amountMinor: 500000 });
  assert.equal(fact.confidence_basis_points, 8000);
  assert.equal((await evidence.get(fact.id)).id, fact.id);
  assert.equal(await evidence.get('fact-missing'), null);
  assert.equal((await evidence.listForCase(CASE)).length, 1);
  const second = await evidence.append({
    householdId: HOUSEHOLD, caseId: CASE, factKey: 'policy.sum_insured', value: { amountMinor: 300000 },
    epistemicState: 'known', provenanceKind: 'adult_statement', statementAdultId: ADULT, assertedBy: 'fixture',
  });
  const conflict = await evidence.recordConflict({ factKey: 'policy.sum_insured', leftFactId: fact.id, rightFactId: second.id });
  assert.equal(conflict.left_fact_id, fact.id);
  await assert.rejects(evidence.append({
    householdId: INTRUDER, caseId: CASE, factKey: 'policy.sum_insured', value: { amountMinor: 1 },
    epistemicState: 'known', provenanceKind: 'adult_statement', statementAdultId: 'adult-intruder', assertedBy: 'fixture',
  }), error => typeof error.code === 'string');
  await assert.rejects(evidence.append({ householdId: HOUSEHOLD, factKey: 'x', epistemicState: 'known', provenanceKind: 'rumour', assertedBy: 'x' }),
    /provenance kind/);
});

// --- Clauses and answers -------------------------------------------------------------------------

const clausePages = {
  pages: [
    { page: 1, status: 'stored', blocks: [
      { tag: 'headline', text: 'Policy Schedule' },
      { tag: 'paragraph', text: 'Sum Insured Rs. 5,00,000 for the synthetic family floater.' },
    ] },
    { page: 2, status: 'stored', blocks: [
      { tag: 'section-title', text: 'Waiting Periods' },
      { tag: 'paragraph', text: 'Cataract surgery has a waiting period of 24 months.' },
      { tag: 'section-title', text: 'Endorsement' },
      { tag: 'paragraph', text: 'The waiting period for cataract is waived for eligible members by this endorsement.' },
    ] },
  ],
};
const answerBody = { question: 'cataract?', covered: [], limited_or_excluded: [], conditions: [], overrides_checked: [], unknowns: ['x'], calculations: [], sources: [{ documentId: DOCUMENT, page: 2, quote: 'q' }], state: 'conditional', legalReview: 'required' };
function answerInput({ key = 'idem-key-0001', digest = 'a'.repeat(64), householdId = HOUSEHOLD, caseId = CASE, documentIds = [DOCUMENT], consentCheck } = {}) {
  return {
    householdId, caseId, requestedByAdultId: ADULT, idempotencyKey: key, requestDigest: digest, question: 'cataract?',
    answer: { ...answerBody, sources: documentIds.map(documentId => ({ documentId, page: 2, quote: 'q' })) },
    access: { consentGrantId: 'grant-question', subjectAdultId: ADULT, documentIds },
    ...(consentCheck ? { consentCheck } : {}),
  };
}

async function clauseWorld(t) {
  const context = await world(t);
  const clauses = new ClauseRepository(context.db, { clock, audit: context.audit });
  const built = buildClauses(clausePages, { documentId: DOCUMENT, sourceVersion: 'version-1' });
  const saved = await clauses.saveClauses({ householdId: HOUSEHOLD, caseId: CASE, documentId: DOCUMENT, clauses: built.clauses });
  assert.deepEqual(saved, { inserted: built.clauses.length, total: built.clauses.length });
  return { ...context, clauses, built };
}
const scope = { householdId: HOUSEHOLD, caseId: CASE, documentIds: [DOCUMENT] };

test('clauses: persist, replay as no-ops, list in build order and fail closed on a changed digest', pgOptions, async t => {
  const { clauses, built } = await clauseWorld(t);
  assert.deepEqual(await clauses.saveClauses({ householdId: HOUSEHOLD, caseId: CASE, documentId: DOCUMENT, clauses: built.clauses }), { inserted: 0, total: built.clauses.length });
  const listed = await clauses.listClauses(scope);
  assert.deepEqual(listed.map(clause => clause.clauseId), built.clauses.map(clause => clause.clauseId));
  assert.ok(listed.every(clause => typeof clause.page === 'number'));
  assert.deepEqual(await clauses.clauseDocumentIds({ householdId: HOUSEHOLD, caseId: CASE }), [DOCUMENT]);
  await assert.rejects(clauses.saveClauses({ householdId: HOUSEHOLD, caseId: CASE, documentId: DOCUMENT, clauses: [{ ...built.clauses[0], digest: 'f'.repeat(64) }] }), { code: 'CLAUSE_DIGEST_CONFLICT' });
});

test('clauses: every household-scoped method denies another household with one not-found shape', pgOptions, async t => {
  const { clauses, built } = await clauseWorld(t);
  const saved = await clauses.saveAnswer(answerInput());
  await assert.rejects(clauses.saveClauses({ householdId: INTRUDER, caseId: CASE, documentId: DOCUMENT, clauses: built.clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  await assert.rejects(clauses.saveClauses({ householdId: INTRUDER, caseId: INTRUDER_CASE, documentId: DOCUMENT, clauses: built.clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  assert.deepEqual(await clauses.listClauses({ householdId: INTRUDER, caseId: CASE, documentIds: [DOCUMENT] }), []);
  assert.deepEqual(await clauses.searchClauses({ householdId: INTRUDER, caseId: CASE, documentIds: [DOCUMENT], query: 'cataract' }), []);
  assert.deepEqual(await clauses.clauseDocumentIds({ householdId: INTRUDER, caseId: CASE }), []);
  await assert.rejects(clauses.getAnswer({ householdId: INTRUDER, caseId: CASE, answerId: saved.answerId }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  assert.equal(await clauses.findAnswerByKey({ householdId: INTRUDER, caseId: CASE, idempotencyKey: 'idem-key-0001', requestDigest: 'a'.repeat(64) }), null);
  await assert.rejects(clauses.saveAnswer(answerInput({ householdId: INTRUDER })), error => error.code !== undefined, 'the answer insert trigger refuses a foreign case');
  assert.deepEqual((await clauses.eraseDerived({ householdId: INTRUDER, documentIds: [DOCUMENT], reasonCode: 'consent_revoked' })), { clauses: 0, answers: 0, reviews: 0 });
  assert.equal((await clauses.listClauses(scope)).length, built.clauses.length, 'a foreign erasure leaves the household rows');
});

test('clauses: word search stems, filters by kind and never passes operators', pgOptions, async t => {
  const { clauses } = await clauseWorld(t);
  const hits = await clauses.searchClauses({ ...scope, query: 'cataract waiting' });
  assert.ok(hits.length >= 2);
  assert.ok(hits.every(hit => /cataract|waiting/i.test(hit.text)));
  assert.ok((await clauses.searchClauses({ ...scope, query: 'cataracts' })).length > 0, 'stemming');
  assert.deepEqual(await clauses.searchClauses({ ...scope, query: 'cataract', kinds: ['exclusion'] }), []);
  assert.ok((await clauses.searchClauses({ ...scope, query: 'cataract', kinds: ['waiting_period', 'endorsement'] })).length > 0);
  assert.deepEqual(await clauses.searchClauses({ ...scope, query: "*** '' !| & :*" }), []);
  assert.deepEqual((await clauses.searchClauses({ ...scope, query: "cataract') | ('sum" })).map(hit => hit.clauseId).sort(),
    (await clauses.searchClauses({ ...scope, query: 'cataract sum' })).map(hit => hit.clauseId).sort());
  assert.equal(ftsQuery('NEAR(a b) OR "x" -y*'), '"near" OR "or"');
  await assert.rejects(clauses.searchClauses({ ...scope, query: 'x', limit: 0 }), { code: 'CLAUSE_INPUT_INVALID' });
});

test('answers: replay, digest conflict and access metadata beside the answer', pgOptions, async t => {
  const { db, clauses } = await clauseWorld(t);
  const first = await clauses.saveAnswer(answerInput());
  const replay = await clauses.saveAnswer(answerInput());
  assert.deepEqual([first.replayed, replay.replayed, replay.answerId], [false, true, first.answerId]);
  await assert.rejects(clauses.saveAnswer(answerInput({ digest: 'b'.repeat(64) })), { code: 'IDEMPOTENCY_KEY_REUSED' });
  assert.equal(await count(db, 'policy_answers'), 1);
  assert.deepEqual(first.access, { consentGrantId: 'grant-question', subjectAdultId: ADULT, documentIds: [DOCUMENT] });
  assert.equal(Object.hasOwn(first.answer, 'access'), false);
  const read = await clauses.getAnswer({ householdId: HOUSEHOLD, caseId: CASE, answerId: first.answerId });
  assert.deepEqual(read.access, first.access);
  assert.equal((await clauses.findAnswerByKey({ householdId: HOUSEHOLD, caseId: CASE, idempotencyKey: 'idem-key-0001', requestDigest: 'a'.repeat(64) })).answerId, first.answerId);
  await assert.rejects(clauses.findAnswerByKey({ householdId: HOUSEHOLD, caseId: CASE, idempotencyKey: 'idem-key-0001', requestDigest: 'c'.repeat(64) }), { code: 'IDEMPOTENCY_KEY_REUSED' });
});

test('answers: an async consent check that rejects late writes nothing (section 4: awaited inside the transaction)', pgOptions, async t => {
  const { db, clauses } = await clauseWorld(t);
  const late = async () => { await sleep(20); throw Object.assign(new Error('Consent withdrawn.'), { code: 'CONSENT_NOT_CURRENT' }); };
  await assert.rejects(clauses.saveAnswer(answerInput({ consentCheck: late })), { code: 'CONSENT_NOT_CURRENT' });
  await assert.rejects(clauses.saveAnswer(answerInput({ consentCheck: () => { throw Object.assign(new Error('no'), { code: 'CONSENT_NOT_CURRENT' }); } })), { code: 'CONSENT_NOT_CURRENT' });
  assert.equal(await count(db, 'policy_answers'), 0);
  let checked = 0;
  const saved = await clauses.saveAnswer(answerInput({ consentCheck: async () => { await sleep(5); checked += 1; } }));
  assert.equal(saved.replayed, false);
  assert.equal(checked, 1);
  await assert.rejects(clauses.saveAnswer(answerInput({ key: 'idem-key-0002', consentCheck: 'yes' })), { code: 'CLAUSE_INPUT_INVALID' });
});

test('answers concurrency: eight concurrent saves of one key store one answer', pgOptions, async t => {
  const { db, clauses } = await clauseWorld(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => clauses.saveAnswer(answerInput({ key: 'idem-key-race' }))));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(new Set(results.map(result => result.answerId)).size, 1);
  assert.equal(await count(db, 'policy_answers'), 1);
});

test('clauses: erasure deletes clauses, citing answers and reviews of the document with a counts-only audit', pgOptions, async t => {
  const { db, clauses } = await clauseWorld(t);
  await clauses.saveAnswer(answerInput());
  await clauses.saveAnswer(answerInput({ key: 'idem-key-other', documentIds: ['document-other'] }));
  const erased = await clauses.eraseDerived({ householdId: HOUSEHOLD, documentIds: [DOCUMENT], reasonCode: 'consent_revoked', caseId: CASE });
  assert.ok(erased.clauses > 0);
  assert.equal(erased.answers, 1);
  assert.equal(typeof erased.clauses, 'number');
  assert.equal(await count(db, 'policy_clauses'), 0);
  assert.equal(await count(db, 'policy_answers'), 1, 'an answer citing another document stays');
  const [payload] = await auditPayloads(db, 'policy_evidence.erased');
  assert.deepEqual(payload, { reasonCode: 'consent_revoked', clauses: erased.clauses, answers: 1, reviews: 0, documents: 1 });
  assert.deepEqual(await clauses.eraseDerived({ householdId: HOUSEHOLD, documentIds: [DOCUMENT], reasonCode: 'consent_revoked' }), { clauses: 0, answers: 0, reviews: 0 });
  await assert.rejects(clauses.eraseDerived({ householdId: HOUSEHOLD, documentIds: [DOCUMENT], reasonCode: 'whim' }), { code: 'CLAUSE_INPUT_INVALID' });
});

test('clauses: erasure without a household erases by document and joins a caller transaction', pgOptions, async t => {
  const { db, clauses } = await clauseWorld(t);
  await clauses.saveAnswer(answerInput());
  await assert.rejects(db.transaction(async () => {
    await clauses.eraseDerived({ documentIds: [DOCUMENT], reasonCode: 'document_erasure' });
    assert.equal(await count(db, 'policy_clauses'), 0);
    throw new Error('caller rolls back');
  }), /caller rolls back/);
  assert.ok(await count(db, 'policy_clauses') > 0, 'the caller rollback restores the rows');
  const erased = await clauses.eraseDerived({ documentIds: [DOCUMENT], reasonCode: 'document_erasure' });
  assert.equal(erased.answers, 1);
  assert.equal(await count(db, 'policy_clauses'), 0);
});

test('clauses: the database safety net deletes clauses and citing answers when a document leaves active', pgOptions, async t => {
  const { db, clauses } = await clauseWorld(t);
  await clauses.saveAnswer(answerInput());
  await db.run("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?", [DOCUMENT]);
  assert.equal(await count(db, 'policy_clauses'), 0);
  assert.equal(await count(db, 'policy_answers'), 0);
  await assert.rejects(clauses.saveClauses({ householdId: HOUSEHOLD, caseId: CASE, documentId: DOCUMENT, clauses: buildClauses(clausePages, { documentId: DOCUMENT, sourceVersion: 'version-2' }).clauses }), { code: 'POLICY_EVIDENCE_NOT_FOUND' });
  assert.throws(() => new ClauseRepository({ prepare() {}, exec() {} }), TypeError);
});

// --- Policy structuring --------------------------------------------------------------------------

// CoverageParameterRepository belongs to another work package; this double records calls only.
function parameterDouble({ pin = null, failWith = null } = {}) {
  return {
    calls: [],
    async getRegistryPin() { await sleep(1); if (failWith) await failWith(); return pin; },
    async listForRun() { await sleep(1); return []; },
    async listObservations() { return []; },
    async appendObservation() { throw new Error('not expected'); },
    async setResolution() { throw new Error('not expected'); },
  };
}

const proposal = (key, blockIndex = 0) => ({
  proposedKey: key, category: 'unassigned', label: `Synthetic ${key}`, evidenceQuote: 'Synthetic clause', page: 2, blockIndex,
  value: { text: 'Synthetic value' },
});
const commitInput = (extra = {}) => ({
  householdId: HOUSEHOLD, workflowRunId: RUN, documentId: DOCUMENT, sourceVersion: 'version-1', pipelineVersion: PIPELINE,
  registryVersion, recordedBy: 'structuring-test', consentCheck: async () => { await sleep(1); },
  decisions: [{ parameterKey: 'a.not_in_run', state: 'extracted_unverified', reasonCode: 'model_extracted_unverified', observations: [{ page: 2, value: { text: 'x' } }] }],
  proposals: [proposal('synthetic_one', 0), proposal('synthetic_two', 1)],
  ...extra,
});

function structuringRepo(db, audit, options = {}) {
  return new PolicyStructuringRepository(db, { clock, audit, coverageParameters: parameterDouble(options) });
}

test('structuring: commit stores the run and proposals with counts only; a replay writes nothing', pgOptions, async t => {
  const { db, audit } = await world(t);
  const structuring = structuringRepo(db, audit);
  const committed = await structuring.commitStructuring(commitInput());
  assert.deepEqual({ ...committed, structuringRunId: undefined }, { replayed: false, structuringRunId: undefined, observations: 0, parameters: 0, conflicting: 0, skippedKeys: 1, proposals: 2 });
  const replay = await structuring.commitStructuring(commitInput());
  assert.deepEqual([replay.replayed, replay.structuringRunId], [true, committed.structuringRunId]);
  const listed = await structuring.listProposals({ householdId: HOUSEHOLD, documentId: DOCUMENT, structuringRunId: committed.structuringRunId });
  assert.deepEqual(listed.map(item => [item.proposedKey, item.page, item.blockIndex]), [['synthetic_one', 2, 0], ['synthetic_two', 2, 1]]);
  assert.equal(typeof listed[0].page, 'number');
  const run = await structuring.getStructuringRun({ householdId: HOUSEHOLD, workflowRunId: RUN, documentId: DOCUMENT });
  assert.equal(run.counts.proposals, 2);
  assert.equal(await count(db, "audit_events WHERE action = 'policy_structuring.committed'"), 1);
  assert.doesNotMatch(JSON.stringify(await auditPayloads(db, 'policy_structuring.committed')), /Synthetic/);
  await assert.rejects(structuring.commitStructuring(commitInput({ registryVersion: 'nope' })), { code: 'STRUCTURING_INPUT_INVALID' });
  await assert.rejects(structuringRepo(db, audit, { pin: { registryVersion: 'other' } }).commitStructuring(commitInput({ pipelineVersion: 'policy-structuring/v-other' })), { code: 'STRUCTURING_REGISTRY_MISMATCH' });
});

test('structuring concurrency: eight concurrent commits of one identity store one run and one set of proposals', pgOptions, async t => {
  const { db, audit } = await world(t);
  const structuring = structuringRepo(db, audit);
  const results = await Promise.all(Array.from({ length: 8 }, () => structuring.commitStructuring(commitInput())));
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(new Set(results.map(result => result.structuringRunId)).size, 1);
  assert.equal(await count(db, 'policy_structuring_runs'), 1);
  assert.equal(await count(db, 'proposed_parameters'), 2);
  assert.equal(await count(db, "audit_events WHERE action = 'policy_structuring.committed'"), 1);
});

test('structuring: every household-scoped method denies another household with one coded error', pgOptions, async t => {
  const { db, audit } = await world(t);
  const structuring = structuringRepo(db, audit);
  const committed = await structuring.commitStructuring(commitInput());
  const denied = { code: 'STRUCTURING_SCOPE_NOT_FOUND' };
  await assert.rejects(structuring.commitStructuring(commitInput({ householdId: INTRUDER })), denied);
  await assert.rejects(structuring.commitStructuring(commitInput({ documentId: INTRUDER_DOCUMENT })), denied);
  await assert.rejects(structuring.listProposals({ householdId: INTRUDER, documentId: DOCUMENT, structuringRunId: committed.structuringRunId }), denied);
  await assert.rejects(structuring.getStructuringRun({ householdId: INTRUDER, workflowRunId: RUN, documentId: DOCUMENT }), denied);
  await assert.rejects(structuring.startJob({ householdId: INTRUDER, workflowRunId: RUN, documentId: DOCUMENT, sourceVersion: 'version-1', pipelineVersion: PIPELINE, consentGrantId: 'consent-intruder' }), denied);
  await assert.rejects(structuring.latestJob({ householdId: INTRUDER, workflowRunId: RUN, documentId: DOCUMENT }), denied);
  assert.deepEqual(await structuring.eraseDerived({ householdId: INTRUDER, documentIds: [DOCUMENT], reasonCode: 'consent_revoked' }), { proposals: 0, observations: 0, runs: 0, jobs: 0 });
  assert.equal((await structuring.listProposals({ householdId: HOUSEHOLD, documentId: DOCUMENT, structuringRunId: committed.structuringRunId })).length, 2);
});

test('structuring: an async consent check that rejects late writes nothing (section 4)', pgOptions, async t => {
  const { db, audit } = await world(t);
  const structuring = structuringRepo(db, audit);
  const late = async () => { await sleep(20); throw Object.assign(new Error('Consent withdrawn.'), { code: 'CONSENT_NOT_CURRENT', statusCode: 403 }); };
  await assert.rejects(structuring.commitStructuring(commitInput({ consentCheck: late })), { code: 'CONSENT_NOT_CURRENT' });
  assert.equal(await count(db, 'policy_structuring_runs'), 0);
  assert.equal(await count(db, 'proposed_parameters'), 0);
  assert.equal(await count(db, "audit_events WHERE action LIKE 'policy_structuring.%'"), 0);
});

test('structuring: database errors never pass through as application codes (P0001, data exceptions)', pgOptions, async t => {
  const { db, audit } = await world(t);
  const raise = () => db.run("DO $$ BEGIN RAISE EXCEPTION 'synthetic trigger detail'; END $$");
  await assert.rejects(structuringRepo(db, audit, { failWith: raise }).commitStructuring(commitInput()), error => {
    assert.equal(error.code, 'STRUCTURING_COMMIT_FAILED');
    assert.doesNotMatch(error.message, /synthetic trigger detail/);
    return true;
  });
  await assert.rejects(structuringRepo(db, audit, { failWith: () => db.one('SELECT 1 / 0 AS x') }).commitStructuring(commitInput()), { code: 'STRUCTURING_COMMIT_FAILED' });
  await assert.rejects(structuring404(db, audit), { code: 'STRUCTURING_PAGE_NOT_FOUND' });
  assert.equal(await count(db, 'policy_structuring_runs'), 0);
});
const structuring404 = (db, audit) => structuringRepo(db, audit).commitStructuring(commitInput({ proposals: [{ ...proposal('synthetic_far'), page: 9 }] }));

test('structuring jobs: concurrent starts leave one running attempt; finish and interrupt return Numbers', pgOptions, async t => {
  const { db, audit } = await world(t);
  const structuring = structuringRepo(db, audit);
  const start = () => structuring.startJob({ householdId: HOUSEHOLD, workflowRunId: RUN, documentId: DOCUMENT, sourceVersion: 'version-1', pipelineVersion: PIPELINE, consentGrantId: 'consent-parameters' });
  const settled = await Promise.allSettled(Array.from({ length: 6 }, start));
  const started = settled.filter(result => result.status === 'fulfilled');
  assert.equal(started.length, 1);
  assert.ok(settled.filter(result => result.status === 'rejected').every(result => result.reason.code === 'STRUCTURING_ALREADY_RUNNING'));
  const job = started[0].value;
  assert.deepEqual([job.status, job.attempt], ['running', 1]);
  assert.equal(await structuring.finishJob({ jobId: job.id, status: 'failed', errorCode: 'SYNTHETIC_ERROR' }), true);
  assert.equal(await structuring.finishJob({ jobId: job.id, status: 'committed' }), false, 'a finished attempt is final');
  const second = await start();
  assert.equal(second.attempt, 2);
  const interrupted = await structuring.interruptRunningJobs();
  assert.equal(interrupted, 1);
  assert.equal(typeof interrupted, 'number');
  assert.equal(await structuring.interruptRunningJobs(), 0);
  assert.equal((await structuring.latestJob({ householdId: HOUSEHOLD, workflowRunId: RUN, documentId: DOCUMENT })).status, 'interrupted');
  assert.deepEqual((await auditPayloads(db, 'policy_structuring.jobs_interrupted'))[0], { jobs: 1 });
});

test('structuring: erasure redacts proposals and stamps runs and jobs, household-scoped and idempotent', pgOptions, async t => {
  const { db, audit } = await world(t);
  const structuring = structuringRepo(db, audit);
  const committed = await structuring.commitStructuring(commitInput());
  await structuring.startJob({ householdId: HOUSEHOLD, workflowRunId: RUN, documentId: DOCUMENT, sourceVersion: 'version-1', pipelineVersion: PIPELINE, consentGrantId: 'consent-parameters' });
  const erased = await structuring.eraseDerived({ householdId: HOUSEHOLD, documentIds: [DOCUMENT], reasonCode: 'consent_revoked', caseId: CASE });
  assert.deepEqual(erased, { proposals: 2, observations: 0, runs: 1, jobs: 1 });
  assert.equal(await count(db, 'proposed_parameters WHERE value_json IS NOT NULL OR label IS NOT NULL'), 0);
  assert.equal(await count(db, 'policy_structuring_runs WHERE erased_at IS NULL'), 0);
  assert.equal(await count(db, 'policy_structuring_jobs WHERE erased_at IS NULL'), 0);
  assert.deepEqual(await structuring.listProposals({ householdId: HOUSEHOLD, documentId: DOCUMENT, structuringRunId: committed.structuringRunId }), []);
  assert.deepEqual(await structuring.eraseDerived({ householdId: HOUSEHOLD, documentIds: [DOCUMENT], reasonCode: 'consent_revoked' }), { proposals: 0, observations: 0, runs: 0, jobs: 0 });
  const [payload] = await auditPayloads(db, 'policy_structuring.erased');
  assert.deepEqual(payload, { reasonCode: 'consent_revoked', proposals: 2, observations: 0, runs: 1, jobs: 1, documents: 1, workflowRuns: 0 });
  // An erased identity can be committed again.
  assert.equal((await structuring.commitStructuring(commitInput())).replayed, false);
  const byRun = await structuring.eraseDerived({ workflowRunIds: [RUN], reasonCode: 'source_consent_not_current' });
  assert.deepEqual([byRun.runs, byRun.proposals], [1, 2]);
  await assert.rejects(structuring.eraseDerived({ documentIds: [DOCUMENT], reasonCode: 'whim' }), { code: 'STRUCTURING_INPUT_INVALID' });
});
