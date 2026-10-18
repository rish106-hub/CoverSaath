import { createHash, randomUUID } from 'node:crypto';
import { createDocumentIntakeService } from '../../modules/document-intake/index.js';

// Block 1 upload orchestration. Identity always comes from the authenticated principal and the
// household from the case row, never from the request. Bytes are validated and inspected before
// they are stored; a stored document stays quarantined until a malware scan marks it clean.

export const UPLOAD_DOCUMENT_KINDS = Object.freeze(['policy_wording', 'policy_schedule', 'endorsement']);
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const SCAN_RETRY_BASE_MS = 30_000;
const SCAN_RETRY_MAX_MS = 60 * 60 * 1000;
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
// A missing object is confirmed over a few attempts before the document is rejected, and a
// scanner that keeps returning an error (not an outage) is given up on after a bounded number.
const MISSING_OBJECT_ATTEMPTS = 3;
const SCANNER_ERROR_ATTEMPTS = 10;

// Status codes for intake errors that reach the client. Everything else stays 400.
const INTAKE_STATUS = Object.freeze({
  ACTIVE_CONSENT_REQUIRED: 403,
  DUPLICATE_DOCUMENT: 409,
  DOCUMENT_VERSION_EXISTS: 409,
  FILE_TOO_LARGE: 413,
  PDF_STRUCTURE_INVALID: 422,
  PDF_PASSWORD_REQUIRED: 422,
  PDF_ACTIVE_CONTENT: 422,
  PDF_PAGE_LIMIT: 422,
  PDF_RESOURCE_LIMIT: 422,
  PDF_UNSUPPORTED_ENCODING: 422,
});

const USER_STATUS = Object.freeze({
  received_pending_checks: 'Received, waiting for security checks',
  accepted: 'Document accepted',
  rejected: 'This file could not be accepted',
  deletion_pending: 'Deletion in progress',
  deleted: 'Deleted',
});

function fail(code, message, statusCode) {
  throw Object.assign(new Error(message), { code, statusCode });
}

export function documentStatus(record) {
  if (record.lifecycleState === 'deleted') return 'deleted';
  if (record.malwareStatus === 'blocked') return 'rejected';
  if (record.lifecycleState === 'deletion_requested') return 'deletion_pending';
  if (record.lifecycleState === 'active' && record.malwareStatus === 'clean') return 'accepted';
  return 'received_pending_checks';
}

// The client-visible document. No storage key, hash, filename or uploader identity.
export function documentDto(record) {
  const status = documentStatus(record);
  return {
    id: record.id,
    caseId: record.caseId,
    documentKind: record.documentKind,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    status,
    statusLabel: USER_STATUS[status],
    lifecycleState: record.lifecycleState,
    malwareStatus: record.malwareStatus,
    uploadedAt: record.createdAt,
    logicalDocumentId: record.logicalDocumentId,
    sourceVersion: record.sourceVersion ?? String(record.version),
  };
}

function headerText(value, name, { max = 200, pattern = null } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (pattern && !pattern.test(value))) {
    fail('INVALID_REQUEST', `${name} is required.`, 400);
  }
  return value.trim();
}

function decodeFilename(value) {
  if (typeof value === 'string' && value.length > 600) fail('INVALID_FILENAME', 'The filename is too long.', 400);
  const raw = headerText(value, 'X-Filename', { max: 600 });
  try {
    return decodeURIComponent(raw);
  } catch {
    return fail('INVALID_FILENAME', 'The filename is not usable.', 400);
  }
}

export function createDocumentUploadService({
  services,
  repository,
  storage,
  inspectFile = null,
  scanner = null,
  clock = () => new Date(),
  random = Math.random,
  limits = { maxDocumentsPerCase: 50, maxPendingPerHousehold: 20 },
}) {
  const intake = storage
    ? createDocumentIntakeService({ repository, storage, mode: 'live', now: clock, inspectFile })
    : null;
  let onStored = () => {};

  function requireStorage() {
    if (!intake) fail('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Document storage is not configured.', 503);
  }

  // A replay answers with the document's current state, not the state at first upload.
  function replay(stored, requestDigest) {
    if (stored.request_digest !== requestDigest) {
      fail('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was already used for a different upload.', 409);
    }
    const original = JSON.parse(stored.response_json).document;
    const current = original?.id ? repository.getDocument(original.id) : null;
    return { status: 200, body: { document: current ? documentDto(current) : original, idempotentReplay: true } };
  }

  return Object.freeze({
    configured: Boolean(intake),
    scannerConfigured: Boolean(scanner),

    // Called after a document is committed, so the worker can scan it without waiting for a sweep.
    setOnStored(fn) { onStored = fn; },

    async upload({ principal, caseRecord, headers, bytes }) {
      requireStorage();
      const idempotencyKey = headerText(headers['idempotency-key'], 'Idempotency-Key', { max: 200 });
      if (idempotencyKey.length < 8) fail('IDEMPOTENCY_KEY_REQUIRED', 'A stable Idempotency-Key header between 8 and 200 characters is required.', 400);
      const documentKind = headerText(headers['x-document-kind'], 'X-Document-Kind', { max: 40 });
      if (!UPLOAD_DOCUMENT_KINDS.includes(documentKind)) {
        fail('UNSUPPORTED_DOCUMENT_KIND', `Document kind must be one of: ${UPLOAD_DOCUMENT_KINDS.join(', ')}.`, 400);
      }
      const consentGrantId = headerText(headers['x-consent-grant-id'], 'X-Consent-Grant-Id');
      const filename = decodeFilename(headers['x-filename']);
      const logicalDocumentId = headers['x-logical-document-id'] === undefined
        ? null
        : headerText(headers['x-logical-document-id'], 'X-Logical-Document-Id', { max: 100, pattern: /^[A-Za-z0-9_-]+$/ });
      const version = headers['x-document-version'] === undefined
        ? 1
        : Number(headerText(headers['x-document-version'], 'X-Document-Version', { max: 6, pattern: /^[1-9][0-9]{0,5}$/ }));

      // Uploader consent: current, from the uploader, for this household, with document collect scope.
      const grant = services.requireDocumentProcessingConsent({ consentGrantId, subjectAdultId: principal.adultId });
      if (grant.household_id !== caseRecord.household_id) {
        fail('CONSENT_SCOPE_REQUIRED', 'Consent does not cover this resource and action.', 403);
      }
      // A grant scoped to one existing document does not permit collecting new documents.
      const householdWideCollect = repository.getConsent(consentGrantId)?.scopes.some(scope =>
        scope.resourceType === 'document' && scope.action === 'collect'
        && scope.dataCategory === 'insurance_document' && scope.resourceId === null);
      if (!householdWideCollect) fail('CONSENT_SCOPE_REQUIRED', 'Consent does not cover this resource and action.', 403);

      const contentSha256 = createHash('sha256').update(bytes).digest('hex');
      const requestDigest = createHash('sha256').update(JSON.stringify({
        caseId: caseRecord.id, documentKind, consentGrantId, filename, logicalDocumentId, version, contentSha256,
      })).digest('hex');
      const scope = `document-upload:${principal.adultId}:${caseRecord.id}`;
      const existing = repository.findIdempotency(scope, idempotencyKey, clock().toISOString());
      if (existing) return replay(existing, requestDigest);

      if (repository.countActiveForCase(caseRecord.id) >= limits.maxDocumentsPerCase
        || repository.countPendingForHousehold(caseRecord.household_id) >= limits.maxPendingPerHousehold) {
        fail('UPLOAD_CAPACITY_REACHED', 'Upload capacity reached. Wait for pending documents to be checked.', 429);
      }

      let record;
      try {
        record = await intake.intake({
          householdId: caseRecord.household_id,
          caseId: caseRecord.id,
          uploadedByAdultId: principal.adultId,
          consentGrantId,
          logicalDocumentId: logicalDocumentId ?? randomUUID(),
          version,
          documentKind,
          filename,
          mimeType: 'application/pdf',
          bytes,
          persistenceContext: {
            actorAdultId: principal.adultId,
            idempotency: {
              scope,
              key: idempotencyKey,
              requestDigest,
              expiresAt: new Date(clock().getTime() + IDEMPOTENCY_TTL_MS).toISOString(),
              response: stored => ({ document: documentDto(stored) }),
            },
          },
        });
      } catch (error) {
        // A concurrent request with the same key committed first (seen as a duplicate, a unique
        // violation or an idempotency-key conflict): answer as a replay of that request.
        const raced = repository.findIdempotency(scope, idempotencyKey);
        if (raced) return replay(raced, requestDigest);
        // The unique indexes are the final word on concurrent duplicates and versions.
        const message = String(error?.message);
        if (/UNIQUE|unique/.test(message) && /content_sha256|content_live/.test(message)) {
          fail('DUPLICATE_DOCUMENT', 'The same document bytes already exist for this household.', 409);
        }
        if (/UNIQUE|unique/.test(message) && /logical_document_id|logical_version/.test(message)) {
          fail('DOCUMENT_VERSION_EXISTS', 'This immutable document version already exists.', 409);
        }
        if (error?.name === 'DocumentIntakeError') {
          error.statusCode = INTAKE_STATUS[error.code] ?? 400;
        }
        throw error;
      }
      onStored(record.id);
      return { status: 201, body: { document: documentDto(repository.getDocument(record.id)) } };
    },

    listForCase(caseRecord) {
      return { caseId: caseRecord.id, documents: repository.listForCase(caseRecord.id, caseRecord.household_id).map(documentDto) };
    },

    getDocument(documentId) {
      return repository.getDocument(documentId);
    },

    listWorkDocumentIds(limit) {
      return repository.listWorkDocumentIds({ includePendingScans: Boolean(scanner), limit, at: clock().toISOString() });
    },

    // One unit of background work. Returns 'clean', 'blocked', 'deleted', 'deferred' or 'skipped'.
    // Scanner and transient storage failures defer the scan on the row (durable backoff, capped at
    // an hour, retried indefinitely) instead of throwing, so an outage never strands a document.
    async processDocument(documentId) {
      const record = repository.getDocument(documentId);
      if (!record || !storage) return 'skipped';
      const nextDue = () => {
        const exponent = Math.min(record.scanAttempts ?? 0, 10);
        const delay = Math.min(SCAN_RETRY_MAX_MS, SCAN_RETRY_BASE_MS * 2 ** exponent) * (0.5 + random() / 2);
        return new Date(clock().getTime() + delay).toISOString();
      };
      if (record.lifecycleState === 'deletion_requested') {
        // A storage reference outside the key scheme (a pre-intake fixture row) has no bytes here.
        if (/^[0-9a-f]{64}$/.test(record.storageKey)) {
          try {
            await storage.remove({ storageKey: record.storageKey });
          } catch {
            repository.deferDeletion(documentId, { nextScanAt: nextDue() });
            return 'deferred';
          }
        }
        return repository.completeDeletion(documentId) ? 'deleted' : 'skipped';
      }
      if (!scanner || record.lifecycleState !== 'quarantined' || record.malwareStatus !== 'pending') return 'skipped';
      const reject = async reasonCode => {
        if (repository.markScanBlocked(documentId, { reasonCode })) {
          await storage.remove({ storageKey: record.storageKey });
          repository.completeDeletion(documentId);
        }
        return 'blocked';
      };
      const defer = () => {
        repository.deferScan(documentId, { nextScanAt: nextDue() });
        return 'deferred';
      };
      const attemptsSoFar = record.scanAttempts ?? 0;
      let bytes;
      try {
        bytes = await storage.read({ documentId: record.id, storageKey: record.storageKey });
      } catch (error) {
        if (error?.code === 'STORAGE_TAMPERED') return reject('STORAGE_INTEGRITY_FAILED');
        if (error?.code === 'STORAGE_OBJECT_MISSING' && attemptsSoFar + 1 >= MISSING_OBJECT_ATTEMPTS) return reject('STORAGE_OBJECT_MISSING');
        return defer();
      }
      let result;
      try {
        result = await scanner.scan(bytes);
      } catch (error) {
        if (error?.retryable === false && attemptsSoFar + 1 >= SCANNER_ERROR_ATTEMPTS) return reject('SCAN_FAILED_REPEATEDLY');
        return defer();
      }
      if (result.status === 'clean') {
        return repository.markScanClean(documentId, { engine: 'clamd' }) ? 'clean' : 'skipped';
      }
      if (repository.markScanBlocked(documentId, { reasonCode: 'MALWARE_DETECTED', signature: result.signature ?? null })) {
        await storage.remove({ storageKey: record.storageKey });
        repository.completeDeletion(documentId);
      }
      return 'blocked';
    },

    // Removes ciphertext with no live row (a crash between storing bytes and committing the row)
    // and abandoned temporary files, once they are older than an hour. Returns counts only.
    async sweepOrphans() {
      repository.purgeExpiredIdempotency(clock().toISOString());
      if (!storage?.list) return { removed: 0 };
      const live = repository.liveStorageKeys();
      const cutoff = clock().getTime() - ORPHAN_MIN_AGE_MS;
      let removed = 0;
      for (const entry of await storage.list()) {
        if (entry.modifiedAt > cutoff) continue;
        if (entry.temporary) {
          await storage.removeTemporary(entry.name);
          removed += 1;
        } else if (!live.has(entry.storageKey)) {
          await storage.remove({ storageKey: entry.storageKey });
          removed += 1;
        }
      }
      return { removed };
    },
  });
}
