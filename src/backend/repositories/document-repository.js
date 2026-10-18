// Persistent implementation of the document-intake repository port (getConsent, findByHash,
// findVersion, createDocument, getDocument, updateDocument) plus the guarded state changes the
// upload service and scan worker need. Methods are synchronous over node:sqlite; callers await them
// so the port stays async for the S3.2 PostgreSQL runtime.
//
// Every state change is conditional on the current state and writes its audit event in the same
// transaction. Audit payloads carry codes and counts only: no filename, text or hash.

import { randomBytes } from 'node:crypto';

const DOCUMENT_COLUMNS = `id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
  original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
  encryption_status, lifecycle_state, uploaded_at, deleted_at, logical_document_id, source_version,
  scan_attempts, next_scan_at`;

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}

function toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    caseId: row.case_id,
    uploadedByAdultId: row.uploaded_by_adult_id,
    consentGrantId: row.consent_grant_id,
    logicalDocumentId: row.logical_document_id,
    version: Number(row.source_version),
    sourceVersion: row.source_version,
    documentKind: row.document_kind,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size,
    contentSha256: row.content_sha256,
    storageKey: row.storage_path,
    malwareStatus: row.malware_status,
    encryptionStatus: row.encryption_status,
    lifecycleState: row.lifecycle_state,
    createdAt: row.uploaded_at,
    deletedAt: row.deleted_at,
    scanAttempts: row.scan_attempts,
    nextScanAt: row.next_scan_at,
  };
}

export class DocumentRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  transaction(fn) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  // Shape expected by document-intake-service.assertConsent. Expiry and revocation are re-checked
  // there and again by the document_uploads_household_refs_insert trigger at insert time.
  getConsent(grantId) {
    const grant = this.database.prepare('SELECT * FROM consent_grants WHERE id = ?').get(grantId);
    if (!grant) return null;
    const scopes = this.database.prepare(`SELECT resource_type, resource_id, action, data_category, recipient
      FROM consent_scopes WHERE consent_grant_id = ? ORDER BY created_at, id`).all(grantId);
    return {
      id: grant.id,
      householdId: grant.household_id,
      subjectAdultId: grant.subject_adult_id,
      purpose: grant.purpose,
      status: grant.revoked_at ? 'revoked' : 'granted',
      revokedAt: grant.revoked_at,
      expiresAt: grant.expires_at,
      scopes: scopes.map(scope => ({
        resourceType: scope.resource_type,
        resourceId: scope.resource_id,
        action: scope.action,
        dataCategory: scope.data_category,
        recipient: scope.recipient,
      })),
    };
  }

  findByHash(householdId, contentSha256) {
    return toRecord(this.database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads
      WHERE household_id = ? AND content_sha256 = ? AND lifecycle_state NOT IN ('deleted', 'deletion_requested')
      ORDER BY uploaded_at LIMIT 1`).get(householdId, contentSha256));
  }

  findVersion(householdId, logicalDocumentId, version) {
    return toRecord(this.database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads
      WHERE household_id = ? AND logical_document_id = ? AND source_version = ? LIMIT 1`)
      .get(householdId, logicalDocumentId, String(version)));
  }

  getDocument(documentId) {
    return toRecord(this.database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads WHERE id = ?`).get(documentId));
  }

  // The intake service's generic update path is not used by the persistent runtime: every
  // transition goes through a guarded method below so concurrent workers cannot regress state.
  updateDocument() {
    throw coded('DOCUMENT_UPDATE_NOT_SUPPORTED', 'Use a guarded document transition.', 500);
  }

  findIdempotency(scope, key, at = this.clock().toISOString()) {
    this.database.prepare(`DELETE FROM idempotency_keys
      WHERE scope = ? AND idempotency_key = ? AND julianday(expires_at) <= julianday(?)`).run(scope, key, at);
    return this.database.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?').get(scope, key) ?? null;
  }

  // context: { actorAdultId, idempotency?: { scope, key, requestDigest, expiresAt, response(record) } }
  createDocument(record, context = {}) {
    const at = record.createdAt;
    return this.transaction(() => {
      this.database.prepare(`INSERT INTO document_uploads
        (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename,
         storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state,
         uploaded_at, deleted_at, logical_document_id, source_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?, NULL, ?, ?)`)
        .run(record.id, record.householdId, record.caseId, record.uploadedByAdultId, record.consentGrantId,
          record.documentKind, record.originalFilename, record.storageKey, record.contentSha256, record.mimeType,
          record.byteSize, record.malwareStatus, record.encryptionStatus, at, record.logicalDocumentId,
          String(record.version));
      this.audit.append({
        householdId: record.householdId,
        caseId: record.caseId,
        actorType: 'adult_user',
        actorId: context.actorAdultId ?? record.uploadedByAdultId,
        action: 'document.uploaded',
        resourceType: 'document',
        resourceId: record.id,
        payload: { documentKind: record.documentKind, byteSize: record.byteSize, mimeType: record.mimeType },
      });
      const idempotency = context.idempotency;
      if (idempotency) {
        const stored = this.getDocument(record.id);
        this.database.prepare(`INSERT INTO idempotency_keys
          (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
          VALUES (?, ?, ?, 201, ?, ?, ?)`)
          .run(idempotency.scope, idempotency.key, idempotency.requestDigest,
            JSON.stringify(idempotency.response(stored)), idempotency.expiresAt, at);
      }
      return this.getDocument(record.id);
    });
  }

  countActiveForCase(caseId) {
    return this.database.prepare(`SELECT count(*) AS count FROM document_uploads
      WHERE case_id = ? AND lifecycle_state NOT IN ('deleted', 'deletion_requested')`).get(caseId).count;
  }

  countPendingForHousehold(householdId) {
    return this.database.prepare(`SELECT count(*) AS count FROM document_uploads
      WHERE household_id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'`).get(householdId).count;
  }

  listForCase(caseId, householdId, limit = 200) {
    return this.database.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads
      WHERE case_id = ? AND household_id = ? AND lifecycle_state <> 'deleted'
      ORDER BY uploaded_at, id LIMIT ?`).all(caseId, householdId, limit).map(toRecord);
  }

  // Work for the background worker. Deletion work (revocation, malware hits) always comes first
  // so a backlog of deferred scans can never starve erasure. Scans are due when next_scan_at has
  // passed; a scanner outage pushes next_scan_at forward instead of stranding the row.
  listWorkDocumentIds({ includePendingScans, limit = 50, at = this.clock().toISOString() }) {
    // A deletion that failed is deferred on the row like a scan, so repeated failures cannot crowd
    // out other work. A document whose scan was deferred before revocation waits at most until
    // its next_scan_at (one hour at most).
    const deletions = this.database.prepare(`SELECT id FROM document_uploads
      WHERE lifecycle_state = 'deletion_requested'
        AND (next_scan_at IS NULL OR julianday(next_scan_at) <= julianday(?))
      ORDER BY coalesce(next_scan_at, uploaded_at), id LIMIT ?`).all(at, limit).map(row => row.id);
    if (!includePendingScans || deletions.length >= limit) return deletions;
    const scans = this.database.prepare(`SELECT id FROM document_uploads
      WHERE lifecycle_state = 'quarantined' AND malware_status = 'pending'
        AND (next_scan_at IS NULL OR julianday(next_scan_at) <= julianday(?))
      ORDER BY coalesce(next_scan_at, uploaded_at), id LIMIT ?`).all(at, limit - deletions.length).map(row => row.id);
    return [...deletions, ...scans];
  }

  // Records a failed scan attempt and when to try again. Operational state only; no audit event.
  deferScan(documentId, { nextScanAt }) {
    return this.database.prepare(`UPDATE document_uploads
      SET scan_attempts = scan_attempts + 1, next_scan_at = ?
      WHERE id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'`).run(nextScanAt, documentId).changes === 1;
  }

  deferDeletion(documentId, { nextScanAt }) {
    return this.database.prepare(`UPDATE document_uploads
      SET scan_attempts = scan_attempts + 1, next_scan_at = ?
      WHERE id = ? AND lifecycle_state = 'deletion_requested'`).run(nextScanAt, documentId).changes === 1;
  }

  // Removes expired idempotency records for every scope (the per-key purge only runs on lookup).
  purgeExpiredIdempotency(at = this.clock().toISOString()) {
    return this.database.prepare(`DELETE FROM idempotency_keys
      WHERE julianday(expires_at) <= julianday(?)`).run(at).changes;
  }

  // Storage keys of every row whose bytes may still exist, for the orphan sweep.
  liveStorageKeys() {
    return new Set(this.database.prepare(`SELECT storage_path FROM document_uploads
      WHERE lifecycle_state <> 'deleted'`).all().map(row => row.storage_path));
  }

  markScanClean(documentId, { engine = null } = {}) {
    return this.transaction(() => {
      const changed = this.database.prepare(`UPDATE document_uploads
        SET malware_status = 'clean', lifecycle_state = 'active'
        WHERE id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'
          AND encryption_status = 'encrypted_local'`).run(documentId).changes;
      if (changed !== 1) return false;
      this.appendSystemAudit(documentId, 'document.scan_clean', engine ? { engine } : {});
      return true;
    });
  }

  // A blocked document never activates. Its bytes are removed by completeDeletion afterwards.
  markScanBlocked(documentId, { reasonCode, signature = null }) {
    return this.transaction(() => {
      const changed = this.database.prepare(`UPDATE document_uploads
        SET malware_status = 'blocked', lifecycle_state = 'deletion_requested'
        WHERE id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'`).run(documentId).changes;
      if (changed !== 1) return false;
      this.appendSystemAudit(documentId, 'document.scan_blocked', { reasonCode, ...(signature ? { signature } : {}) });
      return true;
    });
  }

  completeDeletion(documentId) {
    return this.transaction(() => {
      const at = this.clock().toISOString();
      const changed = this.database.prepare(`UPDATE document_uploads
        SET lifecycle_state = 'deleted', deleted_at = ?, original_filename = '[deleted]',
          content_sha256 = ?, storage_path = ?
        WHERE id = ? AND lifecycle_state = 'deletion_requested'`)
        // The tombstone keeps no content fingerprint (no confirmation that a known file was held)
        // and no usable storage reference.
        .run(at, randomBytes(32).toString('hex'), `deleted-${randomBytes(16).toString('hex')}`, documentId).changes;
      if (changed !== 1) return false;
      // Upload idempotency records carry a digest over the filename and content hash; drop them
      // with the document so no fingerprint outlives it.
      this.database.prepare(`DELETE FROM idempotency_keys
        WHERE scope LIKE 'document-upload:%' AND json_extract(response_json, '$.document.id') = ?`).run(documentId);
      this.appendSystemAudit(documentId, 'document.bytes_deleted', {});
      return true;
    });
  }

  appendSystemAudit(documentId, action, payload) {
    const row = this.database.prepare('SELECT household_id, case_id FROM document_uploads WHERE id = ?').get(documentId);
    this.audit.append({
      householdId: row.household_id,
      caseId: row.case_id,
      actorType: 'system',
      actorId: 'document-intake-worker',
      action,
      resourceType: 'document',
      resourceId: documentId,
      payload,
    });
  }
}
