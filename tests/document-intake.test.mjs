import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createDocumentIntakeService,
  createEncryptedLocalByteStorage,
  createFixtureMemoryByteStorage,
  createMemoryDocumentRepository,
  sanitizeFilename,
} from '../src/modules/document-intake/index.js';

const PDF = Buffer.from('%PDF-1.7\nsynthetic policy fixture only\n%%EOF');
const OTHER_PDF = Buffer.from('%PDF-1.7\ndifferent synthetic fixture\n%%EOF');
const now = new Date('2026-09-18T12:00:00.000Z');
const consent = (overrides = {}) => ({
  id: 'consent-1',
  householdId: 'household-1',
  subjectAdultId: 'adult-1',
  purpose: 'document_processing',
  status: 'granted',
  expiresAt: '2026-09-19T12:00:00.000Z',
  revokedAt: null,
  scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  ...overrides,
});

const upload = (overrides = {}) => ({
  householdId: 'household-1',
  caseId: 'case-1',
  uploadedByAdultId: 'adult-1',
  consentGrantId: 'consent-1',
  logicalDocumentId: 'policy-a',
  version: 1,
  documentKind: 'policy_schedule',
  filename: 'policy.pdf',
  mimeType: 'application/pdf',
  bytes: PDF,
  ...overrides,
});

function fixtureService(consents = [consent()], options = {}) {
  return createDocumentIntakeService({
    repository: createMemoryDocumentRepository({ consents }),
    storage: createFixtureMemoryByteStorage(),
    mode: 'fixture',
    now: () => now,
    ...options,
  });
}

test('traversal filenames are reduced to a safe leaf name', async () => {
  assert.equal(sanitizeFilename('../../private/secret policy.pdf'), 'secret policy.pdf');
  assert.equal(sanitizeFilename('..\\..\\private\\policy.pdf'), 'policy.pdf');
  const record = await fixtureService().intake(upload({ filename: '../../private/policy.pdf' }));
  assert.equal(record.originalFilename, 'policy.pdf');
  assert.equal(record.originalFilename.includes('/'), false);
});

test('MIME signatures and extensions must agree', async () => {
  const service = fixtureService();
  await assert.rejects(
    service.intake(upload({ mimeType: 'image/png' })),
    error => error.code === 'MIME_MISMATCH',
  );
  await assert.rejects(
    service.intake(upload({ filename: 'policy.jpg' })),
    error => error.code === 'EXTENSION_MISMATCH',
  );
});

test('oversize files fail before storage', async () => {
  const service = fixtureService([consent()], { maxBytes: 8 });
  await assert.rejects(service.intake(upload()), error => error.code === 'FILE_TOO_LARGE');
});

test('missing, revoked, expired and wrong-scope consent fail closed', async () => {
  await assert.rejects(fixtureService([]).intake(upload()), error => error.code === 'ACTIVE_CONSENT_REQUIRED');
  await assert.rejects(fixtureService([consent({ revokedAt: '2026-09-18T11:00:00.000Z' })]).intake(upload()), error => error.code === 'ACTIVE_CONSENT_REQUIRED');
  await assert.rejects(fixtureService([consent({ expiresAt: '2026-09-18T11:00:00.000Z' })]).intake(upload()), error => error.code === 'ACTIVE_CONSENT_REQUIRED');
  await assert.rejects(fixtureService([consent({ scopes: [] })]).intake(upload()), error => error.code === 'ACTIVE_CONSENT_REQUIRED');
});

test('duplicate hashes and immutable logical versions are rejected', async () => {
  const service = fixtureService();
  await service.intake(upload());
  await assert.rejects(service.intake(upload({ logicalDocumentId: 'policy-b', version: 2 })), error => error.code === 'DUPLICATE_DOCUMENT');
  await assert.rejects(service.intake(upload({ bytes: OTHER_PDF })), error => error.code === 'DOCUMENT_VERSION_EXISTS');
});

test('fixture documents stay quarantined until explicit fixture activation', async () => {
  const service = fixtureService();
  const record = await service.intake(upload());
  assert.equal(record.lifecycleState, 'quarantined');
  assert.equal(record.malwareStatus, 'not_scanned_fixture');
  await assert.rejects(service.getOcrReadyMetadata(record.id), error => error.code === 'DOCUMENT_NOT_OCR_READY');
  const active = await service.activateFixture(record.id);
  assert.equal(active.lifecycleState, 'active');
  const ocr = await service.getOcrReadyMetadata(record.id);
  assert.equal(ocr.providerPayloadAuthorised, false);
  assert.equal(Object.hasOwn(ocr, 'bytes'), false);
});

test('live storage encrypts bytes and refuses a tampered authentication tag', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coversaath-docs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = createEncryptedLocalByteStorage({ baseDirectory: directory, key: randomBytes(32) });
  const service = createDocumentIntakeService({
    repository: createMemoryDocumentRepository({ consents: [consent()] }),
    storage,
    mode: 'live',
    now: () => now,
  });
  const record = await service.intake(upload());
  const storageKey = createHash('sha256').update(record.id).digest('hex');
  const storedPath = join(directory, `${storageKey}.csd`);
  const encrypted = await readFile(storedPath);
  assert.equal(encrypted.includes(PDF), false);
  encrypted[20] ^= 0xff;
  await writeFile(storedPath, encrypted);
  await assert.rejects(service.readProtectedBytes(record.id), error => error.code === 'STORAGE_TAMPERED');
});

test('live OCR readiness requires a clean scan and authenticated storage', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'coversaath-docs-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = createDocumentIntakeService({
    repository: createMemoryDocumentRepository({ consents: [consent()] }),
    storage: createEncryptedLocalByteStorage({ baseDirectory: directory, key: randomBytes(32) }),
    mode: 'live', now: () => now,
  });
  const record = await service.intake(upload());
  assert.equal(record.encryptionStatus, 'encrypted_local');
  await assert.rejects(service.getOcrReadyMetadata(record.id), error => error.code === 'DOCUMENT_NOT_OCR_READY');
  const active = await service.recordMalwareScan({ documentId: record.id, status: 'clean', scannerReference: 'scanner-result-1' });
  assert.equal(active.lifecycleState, 'active');
  assert.equal((await service.getOcrReadyMetadata(record.id)).documentId, record.id);
});

test('deletion is requested before bytes are removed and the tombstone remains', async () => {
  const service = fixtureService();
  const record = await service.intake(upload());
  await service.activateFixture(record.id);
  const requested = await service.requestDeletion(record.id);
  assert.equal(requested.lifecycleState, 'deletion_requested');
  await assert.rejects(service.readProtectedBytes(record.id), error => error.code === 'DOCUMENT_UNAVAILABLE');
  const deleted = await service.completeDeletion(record.id);
  assert.equal(deleted.lifecycleState, 'deleted');
  assert.equal(deleted.originalFilename, '[deleted]');
  assert.equal(deleted.deletedAt, now.toISOString());
  await assert.rejects(service.getOcrReadyMetadata(record.id), error => error.code === 'DOCUMENT_NOT_OCR_READY');
});

test('fixture and live storage cannot be silently substituted', () => {
  const repository = createMemoryDocumentRepository({ consents: [consent()] });
  assert.throws(
    () => createDocumentIntakeService({ repository, storage: createFixtureMemoryByteStorage(), mode: 'live' }),
    error => error.code === 'ENCRYPTED_STORAGE_REQUIRED',
  );
  assert.throws(
    () => createDocumentIntakeService({ repository, storage: createEncryptedLocalByteStorage({ baseDirectory: '.local/test', key: randomBytes(32) }), mode: 'fixture' }),
    error => error.code === 'FIXTURE_STORAGE_REQUIRED',
  );
  assert.throws(
    () => createEncryptedLocalByteStorage({ baseDirectory: '.local/test' }),
    error => error.code === 'ENCRYPTION_KEY_REQUIRED',
  );
});

test('HRMS and payroll shaped documents cannot establish policy terms', async () => {
  for (const documentKind of ['hrms_export', 'payroll', 'form_16']) {
    await assert.rejects(fixtureService().intake(upload({ documentKind })), error => error.code === 'UNSUPPORTED_DOCUMENT_KIND');
  }
});
