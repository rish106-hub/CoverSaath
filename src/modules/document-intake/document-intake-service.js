import { createHash, randomUUID } from 'node:crypto';
import {
  DOCUMENT_KINDS,
  DocumentIntakeError,
  assertByteStorage,
  assertDocumentRepository,
  clone,
} from './contracts.js';
import { validateDocumentFile } from './file-validation.js';

const FORBIDDEN_PROOF_KINDS = new Set(['hrms_export', 'payroll', 'form_16']);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new DocumentIntakeError('INVALID_INPUT', `${name} is required.`);
  return value.trim();
};

function assertConsent(consent, input, now) {
  const expiry = consent?.expiresAt ? Date.parse(consent.expiresAt) : null;
  const collectScope = consent?.scopes?.some(scope =>
    scope.resourceType === 'document' && scope.action === 'collect' && scope.dataCategory === 'insurance_document',
  );
  if (!consent || consent.status !== 'granted' || consent.revokedAt || consent.purpose !== 'document_processing' ||
      consent.householdId !== input.householdId || consent.subjectAdultId !== input.uploadedByAdultId ||
      (expiry !== null && (!Number.isFinite(expiry) || expiry <= now.getTime())) || !collectScope) {
    throw new DocumentIntakeError('ACTIVE_CONSENT_REQUIRED', 'Active document-processing consent with collect scope is required.');
  }
}

function safeMetadata(record) {
  const copy = clone(record);
  delete copy.storageKey;
  return copy;
}

export function createDocumentIntakeService({ repository, storage, mode = 'live', now = () => new Date(), maxBytes } = {}) {
  if (!['live', 'fixture'].includes(mode)) throw new TypeError('Document intake mode must be live or fixture.');
  assertDocumentRepository(repository);
  assertByteStorage(storage, mode);

  async function get(id) {
    const record = await repository.getDocument(id);
    if (!record) throw new DocumentIntakeError('DOCUMENT_NOT_FOUND', 'The document was not found.');
    return record;
  }

  return Object.freeze({
    async intake(input = {}) {
      const householdId = text(input.householdId, 'householdId');
      const caseId = input.caseId == null ? null : text(input.caseId, 'caseId');
      const uploadedByAdultId = text(input.uploadedByAdultId, 'uploadedByAdultId');
      const consentGrantId = text(input.consentGrantId, 'consentGrantId');
      const logicalDocumentId = text(input.logicalDocumentId, 'logicalDocumentId');
      if (!Number.isInteger(input.version) || input.version < 1) throw new DocumentIntakeError('INVALID_VERSION', 'A positive integer document version is required.');
      if (FORBIDDEN_PROOF_KINDS.has(input.documentKind) || !DOCUMENT_KINDS.includes(input.documentKind)) {
        throw new DocumentIntakeError('UNSUPPORTED_DOCUMENT_KIND', 'HRMS, payroll and unsupported records cannot establish policy terms.');
      }
      const consent = await repository.getConsent(consentGrantId);
      assertConsent(consent, { householdId, uploadedByAdultId }, now());
      const validated = validateDocumentFile({ filename: input.filename, declaredMimeType: input.mimeType, bytes: input.bytes, maxBytes });
      const contentSha256 = createHash('sha256').update(validated.bytes).digest('hex');
      if (await repository.findByHash(householdId, contentSha256)) throw new DocumentIntakeError('DUPLICATE_DOCUMENT', 'The same document bytes already exist for this household.');
      if (await repository.findVersion(householdId, logicalDocumentId, input.version)) throw new DocumentIntakeError('DOCUMENT_VERSION_EXISTS', 'This immutable document version already exists.');

      const id = randomUUID();
      const storageKey = await storage.put({ documentId: id, bytes: validated.bytes });
      const createdAt = now().toISOString();
      const record = {
        id, householdId, caseId, uploadedByAdultId, consentGrantId, logicalDocumentId, version: input.version,
        documentKind: input.documentKind,
        originalFilename: validated.safeFilename,
        mimeType: validated.detectedMimeType,
        byteSize: validated.bytes.length,
        contentSha256,
        storageKey,
        malwareStatus: mode === 'fixture' ? 'not_scanned_fixture' : 'pending',
        encryptionStatus: mode === 'fixture' ? 'fixture_only' : 'encrypted_local',
        lifecycleState: 'quarantined',
        createdAt,
        deletedAt: null,
        evidenceBoundary: input.documentKind === 'employer_benefit_booklet'
          ? 'Employer document terms remain unverified until source-linked review. HRMS or payroll is not policy proof.'
          : 'Upload acceptance does not establish policy meaning, applicability or approval.',
      };
      try {
        await repository.createDocument(record);
      } catch (error) {
        await storage.remove({ storageKey });
        throw error;
      }
      return safeMetadata(record);
    },

    async recordMalwareScan({ documentId, status, scannerReference = null }) {
      if (mode === 'fixture') throw new DocumentIntakeError('FIXTURE_SCAN_FORBIDDEN', 'Fixture storage cannot report a live malware scan.');
      if (!['clean', 'blocked'].includes(status)) throw new DocumentIntakeError('INVALID_MALWARE_STATUS', 'Scan status must be clean or blocked.');
      const record = await get(documentId);
      if (record.lifecycleState !== 'quarantined' || record.malwareStatus !== 'pending') throw new DocumentIntakeError('INVALID_DOCUMENT_STATE', 'Only a pending quarantined document can receive a scan result.');
      const updated = await repository.updateDocument(documentId, {
        ...record,
        malwareStatus: status,
        malwareScannerReference: scannerReference ? text(scannerReference, 'scannerReference') : null,
        lifecycleState: status === 'clean' ? 'active' : 'quarantined',
      });
      return safeMetadata(updated);
    },

    async activateFixture(documentId) {
      if (mode !== 'fixture') throw new DocumentIntakeError('FIXTURE_ONLY_OPERATION', 'Fixture activation is available only in fixture mode.');
      const record = await get(documentId);
      if (record.lifecycleState !== 'quarantined' || record.malwareStatus !== 'not_scanned_fixture') throw new DocumentIntakeError('INVALID_DOCUMENT_STATE', 'The fixture document cannot be activated.');
      return safeMetadata(await repository.updateDocument(documentId, { ...record, lifecycleState: 'active' }));
    },

    async getOcrReadyMetadata(documentId) {
      const record = await get(documentId);
      const consent = await repository.getConsent(record.consentGrantId);
      assertConsent(consent, record, now());
      const clean = record.malwareStatus === 'clean' || (mode === 'fixture' && record.malwareStatus === 'not_scanned_fixture');
      const protectedBytes = record.encryptionStatus === 'encrypted_local' || (mode === 'fixture' && record.encryptionStatus === 'fixture_only');
      if (record.lifecycleState !== 'active' || !clean || !protectedBytes) {
        throw new DocumentIntakeError('DOCUMENT_NOT_OCR_READY', 'The document must be active, protected and clean before OCR.');
      }
      return Object.freeze({
        documentId: record.id,
        sourceVersion: String(record.version),
        mimeType: record.mimeType,
        byteSize: record.byteSize,
        contentSha256: record.contentSha256,
        storageReference: record.storageKey,
        providerPayloadAuthorised: false,
      });
    },

    async readProtectedBytes(documentId) {
      const record = await get(documentId);
      if (record.lifecycleState === 'deleted' || record.lifecycleState === 'deletion_requested') throw new DocumentIntakeError('DOCUMENT_UNAVAILABLE', 'The document is unavailable.');
      assertConsent(await repository.getConsent(record.consentGrantId), record, now());
      return storage.read({ documentId: record.id, storageKey: record.storageKey });
    },

    async requestDeletion(documentId) {
      const record = await get(documentId);
      if (record.lifecycleState === 'deleted') return safeMetadata(record);
      if (record.lifecycleState === 'deletion_requested') return safeMetadata(record);
      return safeMetadata(await repository.updateDocument(documentId, { ...record, lifecycleState: 'deletion_requested' }));
    },

    async completeDeletion(documentId) {
      const record = await get(documentId);
      if (record.lifecycleState !== 'deletion_requested') throw new DocumentIntakeError('DELETION_NOT_REQUESTED', 'Deletion must be requested before bytes are removed.');
      await storage.remove({ storageKey: record.storageKey });
      const updated = await repository.updateDocument(documentId, {
        ...record,
        lifecycleState: 'deleted',
        deletedAt: now().toISOString(),
        originalFilename: '[deleted]',
      });
      return safeMetadata(updated);
    },
  });
}
