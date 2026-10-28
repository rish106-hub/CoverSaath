// Persistent implementation of the document-intake repository port (getConsent, findByHash,
// findVersion, createDocument, getDocument, updateDocument) plus the guarded state changes the
// upload service and scan worker need, on the async PostgreSQL interface (S3.2).
//
// Every state change is conditional on the current state and writes its audit event in the same
// transaction. Each such transaction takes the document's household advisory lock first (lock
// order, design section 3), so erasure, scan results and OCR completion of one household never
// interleave. Audit payloads carry codes and counts only: no filename, text or hash.

import { randomBytes } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';

const DOCUMENT_COLUMNS = `id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
  original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
  encryption_status, lifecycle_state, uploaded_at, deleted_at, logical_document_id, source_version,
  scan_attempts, next_scan_at`;

const MAX_LATEST_VERSION_IDS = 1_000;

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
  constructor(database, { clock = () => new Date(), audit, coverageParameters = null, consents = null } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.coverageParameters = coverageParameters;
    this.consents = consents;
  }

  // One transaction holding the household lock (a NULL or unknown household uses the global key).
  transaction(fn, householdId = null) {
    return this.database.transaction(fn, { locks: [householdLock(householdId)] });
  }

  async #householdOf(documentId) {
    return (await this.database.one('SELECT household_id FROM document_uploads WHERE id = ?', [documentId]))?.household_id ?? null;
  }

  // Shape expected by document-intake-service.assertConsent. Expiry and revocation are re-checked
  // there and again by the document_uploads_household_refs_insert trigger at insert time.
  async getConsent(grantId) {
    const grant = await this.database.one('SELECT * FROM consent_grants WHERE id = ?', [grantId]);
    if (!grant) return null;
    const scopes = await this.database.many(`SELECT resource_type, resource_id, action, data_category, recipient
      FROM consent_scopes WHERE consent_grant_id = ? ORDER BY created_at, id`, [grantId]);
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

  async findByHash(householdId, contentSha256) {
    return toRecord(await this.database.one(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads
      WHERE household_id = ? AND content_sha256 = ? AND lifecycle_state NOT IN ('deleted', 'deletion_requested')
      ORDER BY uploaded_at LIMIT 1`, [householdId, contentSha256]));
  }

  async findVersion(householdId, logicalDocumentId, version) {
    return toRecord(await this.database.one(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads
      WHERE household_id = ? AND logical_document_id = ? AND source_version = ? LIMIT 1`,
    [householdId, logicalDocumentId, String(version)]));
  }

  async getDocument(documentId) {
    return toRecord(await this.database.one(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads WHERE id = ?`, [documentId]));
  }

  // The intake service's generic update path is not used by the persistent runtime: every
  // transition goes through a guarded method below so concurrent workers cannot regress state.
  updateDocument() {
    throw coded('DOCUMENT_UPDATE_NOT_SUPPORTED', 'Use a guarded document transition.', 500);
  }

  async findIdempotency(scope, key, at = this.clock().toISOString()) {
    await this.database.run(`DELETE FROM idempotency_keys
      WHERE scope = ? AND idempotency_key = ? AND julianday(expires_at) <= julianday(CAST(? AS text))`, [scope, key, at]);
    return (await this.database.one('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?', [scope, key])) ?? null;
  }

  // context: { actorAdultId, idempotency?: { scope, key, requestDigest, expiresAt, response(record) } }
  async createDocument(record, context = {}) {
    const at = record.createdAt;
    return this.transaction(async () => {
      await this.database.run(`INSERT INTO document_uploads
        (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename,
         storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state,
         uploaded_at, deleted_at, logical_document_id, source_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?, NULL, ?, ?)`, [
        record.id, record.householdId, record.caseId, record.uploadedByAdultId, record.consentGrantId,
        record.documentKind, record.originalFilename, record.storageKey, record.contentSha256, record.mimeType,
        record.byteSize, record.malwareStatus, record.encryptionStatus, at, record.logicalDocumentId,
        String(record.version),
      ]);
      await this.audit.append({
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
        const stored = await this.getDocument(record.id);
        await this.database.run(`INSERT INTO idempotency_keys
          (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
          VALUES (?, ?, ?, 201, ?, ?, ?)`, [
          idempotency.scope, idempotency.key, idempotency.requestDigest,
          JSON.stringify(idempotency.response(stored)), idempotency.expiresAt, at,
        ]);
      }
      return this.getDocument(record.id);
    }, record.householdId);
  }

  async countActiveForCase(caseId) {
    return (await this.database.one(`SELECT count(*) AS count FROM document_uploads
      WHERE case_id = ? AND lifecycle_state NOT IN ('deleted', 'deletion_requested')`, [caseId])).count;
  }

  async countPendingForHousehold(householdId) {
    return (await this.database.one(`SELECT count(*) AS count FROM document_uploads
      WHERE household_id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'`, [householdId])).count;
  }

  async listForCase(caseId, householdId, limit = 200) {
    return (await this.database.many(`SELECT ${DOCUMENT_COLUMNS} FROM document_uploads
      WHERE case_id = ? AND household_id = ? AND lifecycle_state <> 'deleted'
      ORDER BY uploaded_at, id LIMIT ?`, [caseId, householdId, limit])).map(toRecord);
  }

  // Highest active version per logical document across the household: a newer version may sit in another case.
  // A version that is not a positive integer is returned as NaN so the caller fails closed.
  async latestActiveVersions(householdId, logicalDocumentIds) {
    const ids = [...new Set(logicalDocumentIds)];
    if (ids.length > MAX_LATEST_VERSION_IDS) throw coded('DOCUMENT_INPUT_INVALID', 'Too many logical documents.', 400);
    const latest = new Map();
    if (!ids.length) return latest;
    const rows = await this.database.many(`SELECT logical_document_id, source_version FROM document_uploads
      WHERE household_id = ? AND lifecycle_state = 'active' AND logical_document_id = ANY(CAST(? AS text[]))`, [householdId, ids]);
    for (const row of rows) {
      const parsed = /^[1-9][0-9]*$/.test(row.source_version) ? Number(row.source_version) : Number.NaN;
      const version = Number.isSafeInteger(parsed) ? parsed : Number.NaN;
      const current = latest.get(row.logical_document_id);
      latest.set(row.logical_document_id, Number.isNaN(version) || Number.isNaN(current) ? Number.NaN : Math.max(current ?? 0, version));
    }
    return latest;
  }

  // Work for the background worker. Deletion work (revocation, malware hits) always comes first
  // so a backlog of deferred scans can never starve erasure. Scans are due when next_scan_at has
  // passed; a scanner outage pushes next_scan_at forward instead of stranding the row.
  async listWorkDocumentIds({ includePendingScans, limit = 50, at = this.clock().toISOString() }) {
    // A deletion that failed is deferred on the row like a scan, so repeated failures cannot crowd
    // out other work. A document whose scan was deferred before revocation waits at most until
    // its next_scan_at (one hour at most).
    const deletions = (await this.database.many(`SELECT id FROM document_uploads
      WHERE lifecycle_state = 'deletion_requested'
        AND (next_scan_at IS NULL OR julianday(next_scan_at) <= julianday(CAST(? AS text)))
      ORDER BY coalesce(next_scan_at, uploaded_at), id LIMIT ?`, [at, limit])).map(row => row.id);
    if (!includePendingScans || deletions.length >= limit) return deletions;
    const scans = (await this.database.many(`SELECT id FROM document_uploads
      WHERE lifecycle_state = 'quarantined' AND malware_status = 'pending'
        AND (next_scan_at IS NULL OR julianday(next_scan_at) <= julianday(CAST(? AS text)))
      ORDER BY coalesce(next_scan_at, uploaded_at), id LIMIT ?`, [at, limit - deletions.length])).map(row => row.id);
    return [...deletions, ...scans];
  }

  // Records a failed scan attempt and when to try again. Operational state only; no audit event.
  async deferScan(documentId, { nextScanAt }) {
    return (await this.database.run(`UPDATE document_uploads
      SET scan_attempts = scan_attempts + 1, next_scan_at = ?
      WHERE id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'`, [nextScanAt, documentId])).changes === 1;
  }

  async deferDeletion(documentId, { nextScanAt }) {
    return (await this.database.run(`UPDATE document_uploads
      SET scan_attempts = scan_attempts + 1, next_scan_at = ?
      WHERE id = ? AND lifecycle_state = 'deletion_requested'`, [nextScanAt, documentId])).changes === 1;
  }

  // Removes expired idempotency records for every scope (the per-key purge only runs on lookup).
  async purgeExpiredIdempotency(at = this.clock().toISOString()) {
    return (await this.database.run(`DELETE FROM idempotency_keys
      WHERE julianday(expires_at) <= julianday(CAST(? AS text))`, [at])).changes;
  }

  // Storage keys of every row whose bytes may still exist, for the orphan sweep.
  async liveStorageKeys() {
    return new Set((await this.database.many(`SELECT storage_path FROM document_uploads
      WHERE lifecycle_state <> 'deleted'`)).map(row => row.storage_path));
  }

  async listPendingOcrCancellations(documentId) {
    return this.database.many(`SELECT id, provider, provider_job_ref AS "providerJobRef"
      FROM ocr_jobs WHERE document_upload_id = ? AND status = 'cancelled'
        AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED')
      ORDER BY id`, [documentId]);
  }

  async completeOcrCancellation(jobId, { remoteCancellation = true } = {}) {
    return (await this.database.run(`UPDATE ocr_jobs SET
      provider_job_ref = CASE WHEN CAST(? AS boolean) THEN NULL ELSE provider_job_ref END,
      error_code = CASE WHEN CAST(? AS boolean) THEN NULL ELSE 'OCR_PROVIDER_CANCELLATION_UNSUPPORTED' END,
      error_message = NULL WHERE id = ? AND status = 'cancelled'
        AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED')`, [
      Boolean(remoteCancellation), Boolean(remoteCancellation), jobId,
    ])).changes === 1;
  }

  async markScanClean(documentId, { engine = null } = {}) {
    const householdId = await this.#householdOf(documentId);
    if (householdId === null) return false;
    return this.transaction(async () => {
      const { changes } = await this.database.run(`UPDATE document_uploads
        SET malware_status = 'clean', lifecycle_state = 'active'
        WHERE id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'
          AND encryption_status = 'encrypted_local'`, [documentId]);
      if (changes !== 1) return false;
      await this.appendSystemAudit(documentId, 'document.scan_clean', engine ? { engine } : {});
      return true;
    }, householdId);
  }

  // A blocked document never activates. Its bytes are removed by completeDeletion afterwards.
  async markScanBlocked(documentId, { reasonCode, signature = null }) {
    const householdId = await this.#householdOf(documentId);
    if (householdId === null) return false;
    return this.transaction(async () => {
      const { changes } = await this.database.run(`UPDATE document_uploads
        SET malware_status = 'blocked', lifecycle_state = 'deletion_requested'
        WHERE id = ? AND lifecycle_state = 'quarantined' AND malware_status = 'pending'`, [documentId]);
      if (changes !== 1) return false;
      await this.appendSystemAudit(documentId, 'document.scan_blocked', { reasonCode, ...(signature ? { signature } : {}) });
      return true;
    }, householdId);
  }

  async requestDeletion(documentId, { actorAdultId }) {
    const existing = await this.getDocument(documentId);
    if (!existing) return null;
    if (existing.lifecycleState === 'deleted') return { state: 'deleted', document: existing };
    if (existing.lifecycleState === 'deletion_requested') return { state: 'pending', document: existing };
    if (!this.coverageParameters || !this.consents?.eraseDerivedRunData) {
      throw coded('ERASURE_NOT_CONFIGURED', 'Document erasure is not configured.', 503);
    }
    // Household lock first; the collaborators below take consent, run and task row locks after it.
    return this.transaction(async () => {
      const at = this.clock().toISOString();
      // Re-read under the household lock; the final conditional update guards the row itself.
      const current = await this.getDocument(documentId);
      if (!current) return null;
      if (current.lifecycleState === 'deleted') return { state: 'deleted', document: current };
      if (current.lifecycleState === 'deletion_requested') return { state: 'pending', document: current };

      const observationCounts = await this.coverageParameters.redactObservationsForDocument({
        documentId,
        reasonCode: 'document_erasure',
        actorType: 'adult_user',
        actorId: actorAdultId,
        at,
      });
      const derivedCounts = await this.consents.eraseDerivedRunData({
        householdId: current.householdId,
        documentIds: [documentId],
        reason: 'document_erasure',
        resourceType: 'document',
        resourceId: documentId,
        caseId: current.caseId,
        actorType: 'adult_user',
        actorId: actorAdultId,
        at,
      });
      const ocrJobs = (await this.database.run(`UPDATE ocr_jobs SET
          status = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'cancelled' ELSE status END,
          completed_at = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN ? ELSE completed_at END,
          error_code = CASE
            WHEN status IN ('submitted', 'processing') OR (status = 'queued' AND started_at IS NOT NULL)
              THEN 'DOCUMENT_DELETED'
            WHEN status = 'cancelled' AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED')
              THEN error_code
            ELSE NULL
          END,
          provider_job_ref = CASE
            WHEN status IN ('submitted', 'processing')
              OR (status = 'cancelled' AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED'))
              THEN provider_job_ref
            ELSE NULL
          END,
          error_message = NULL, authorization_json = NULL, result_json = NULL, result_digest = NULL, updated_at = ?
        WHERE document_upload_id = ?`, [at, at, documentId])).changes;
      const sourcePages = (await this.database.run(`UPDATE source_pages SET extracted_text = NULL,
          extraction_status = 'failed', confidence_basis_points = NULL, page_sha256 = ?, text_sha256 = NULL,
          provider_page_ref = NULL, provenance_json = NULL, source_version = 'deleted:' || id
        WHERE document_upload_id = ?`, [
        'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', documentId,
      ])).changes;
      const { changes } = await this.database.run(`UPDATE document_uploads
        SET lifecycle_state = 'deletion_requested', next_scan_at = NULL
        WHERE id = ? AND lifecycle_state IN ('active', 'quarantined')`, [documentId]);
      if (changes !== 1) throw coded('DOCUMENT_DELETE_CONFLICT', 'Document deletion could not be requested.', 409);
      await this.audit.append({
        householdId: current.householdId,
        caseId: current.caseId,
        actorType: 'adult_user',
        actorId: actorAdultId,
        action: 'document.deletion_requested',
        resourceType: 'document',
        resourceId: documentId,
        payload: {
          ocrJobs,
          sourcePages,
          observations: observationCounts.redactedObservations,
          runs: derivedCounts.runs,
          tasks: derivedCounts.tasks,
          facts: derivedCounts.facts,
          policies: derivedCounts.policies,
          policyMembers: derivedCounts.policyMembers,
          graphs: derivedCounts.graphs,
          graphNodes: derivedCounts.graphNodes,
          graphEdges: derivedCounts.graphEdges,
        },
      });
      return { state: 'pending', document: await this.getDocument(documentId) };
    }, existing.householdId);
  }

  async completeDeletion(documentId) {
    const householdId = await this.#householdOf(documentId);
    if (householdId === null) return false;
    return this.transaction(async () => {
      const at = this.clock().toISOString();
      const { changes } = await this.database.run(`UPDATE document_uploads
        SET lifecycle_state = 'deleted', deleted_at = ?, original_filename = '[deleted]',
          content_sha256 = ?, storage_path = ?
        WHERE id = ? AND lifecycle_state = 'deletion_requested'`,
      // The tombstone keeps no content fingerprint (no confirmation that a known file was held)
      // and no usable storage reference.
      [at, randomBytes(32).toString('hex'), `deleted-${randomBytes(16).toString('hex')}`, documentId]);
      if (changes !== 1) return false;
      // Upload idempotency records carry a digest over the filename and content hash; drop them
      // with the document so no fingerprint outlives it.
      await this.database.run(`DELETE FROM idempotency_keys
        WHERE scope LIKE 'document-upload:%' AND (CAST(response_json AS jsonb) #>> '{document,id}') = ?`, [documentId]);
      await this.appendSystemAudit(documentId, 'document.bytes_deleted', {});
      return true;
    }, householdId);
  }

  async appendSystemAudit(documentId, action, payload) {
    const row = await this.database.one('SELECT household_id, case_id FROM document_uploads WHERE id = ?', [documentId]);
    await this.audit.append({
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
