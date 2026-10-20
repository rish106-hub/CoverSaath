import { randomUUID } from 'node:crypto';
import { parseStoredBlocks, serializeStoredBlocks } from '../../features/input/ocr-blocks.js';

const parse = value => value == null ? null : JSON.parse(value);
const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const SAFE_PRE_DISPATCH_RETRY_CODES = new Set([
  'PROVIDER_NOT_CONFIGURED',
  'OCR_PROVIDER_DISABLED',
  'OCR_SEGMENTATION_UNAVAILABLE',
]);

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    documentUploadId: row.document_upload_id,
    provider: row.provider,
    providerJobRef: row.provider_job_ref,
    status: row.status,
    attemptCount: row.attempt_count,
    contractVersion: row.contract_version,
    authorization: parse(row.authorization_json),
    result: parse(row.result_json),
    resultDigest: row.result_digest,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    requestedAt: row.requested_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export class OcrRepository {
  constructor(database, { audit = null } = {}) {
    this.database = database;
    this.audit = audit;
  }

  appendLifecycleAudit(job, previousStatus, { pageCount = null } = {}) {
    if (!this.audit || (previousStatus !== null && previousStatus === job.status)) return;
    const document = this.database.prepare(`SELECT household_id, case_id
      FROM document_uploads WHERE id = ?`).get(job.documentUploadId);
    if (!document) return;
    const actorId = job.authorization?.requestedByAdultId ?? 'local-backend';
    const upgrade = job.authorization?.blocksUpgrade === true;
    const action = previousStatus === null ? (upgrade ? 'ocr.blocks_upgrade_requested' : 'ocr.job_created')
      : job.status === 'succeeded' ? (upgrade ? 'ocr.blocks_upgrade_completed' : 'ocr.job_succeeded')
        : job.status === 'failed' ? 'ocr.job_failed'
          : job.status === 'cancelled' ? 'ocr.job_cancelled'
            : 'ocr.job_status_changed';
    this.audit.append({
      householdId: document.household_id,
      caseId: document.case_id,
      actorType: job.authorization?.requestedByAdultId ? 'adult_user' : 'system',
      actorId,
      action,
      resourceType: 'ocr_job',
      resourceId: job.id,
      payload: {
        provider: job.provider,
        previousStatus,
        status: job.status,
        errorCode: job.errorCode,
        contractVersion: job.contractVersion,
        ...(pageCount === null ? {} : { pageCount }),
      },
    });
  }

  getReadyDocument(documentId, at, disclosure = null) {
    const row = this.database.prepare(`SELECT
        document.id AS document_id, document.consent_grant_id, document.uploaded_by_adult_id,
        document.source_version, document.content_sha256, document.mime_type, document.byte_size,
        document.storage_path
      FROM document_uploads document
      JOIN consent_grants consent ON consent.id = document.consent_grant_id
      WHERE document.id = ?
        AND document.lifecycle_state = 'active'
        AND document.malware_status IN ('clean', 'not_scanned_fixture')
        AND document.encryption_status IN ('encrypted_local', 'fixture_only')
        AND consent.purpose = 'document_processing'
        AND consent.revoked_at IS NULL
        AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(?))
        AND EXISTS (
          SELECT 1 FROM consent_scopes scope
          WHERE scope.consent_grant_id = consent.id
            AND scope.resource_type = 'document'
            AND (scope.resource_id IS NULL OR scope.resource_id = document.id)
            AND scope.action = 'collect'
            AND scope.data_category = 'insurance_document'
        )`).get(documentId, at);
    if (!row) return null;
    let providerConsentGrantId = null;
    if (disclosure) {
      const consent = this.database.prepare(`SELECT consent.id
        FROM consent_grants consent
        JOIN consent_scopes scope ON scope.consent_grant_id = consent.id
        JOIN document_uploads document ON document.id = ?
        WHERE consent.id = ?
          AND consent.household_id = document.household_id
          AND consent.subject_adult_id = document.uploaded_by_adult_id
          AND consent.granted_to_actor = ?
          AND consent.purpose = 'document_processing'
          AND consent.revoked_at IS NULL
          AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(?))
          AND scope.resource_type = 'document'
          AND scope.resource_id = document.id
          AND scope.action = 'derive'
          AND scope.data_category = 'insurance_document'
          AND scope.recipient = ?
        LIMIT 1`).get(documentId, disclosure.consentGrantId, disclosure.recipient, at, disclosure.recipient);
      if (!consent || disclosure.requestedByAdultId !== row.uploaded_by_adult_id) return null;
      providerConsentGrantId = consent.id;
    }
    return Object.freeze({
      documentId: row.document_id,
      consentGrantId: row.consent_grant_id,
      uploadedByAdultId: row.uploaded_by_adult_id,
      sourceVersion: row.source_version,
      contentSha256: row.content_sha256,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      storageReference: row.storage_path,
      providerConsentGrantId,
    });
  }

  // anyContract: a normal request reuses any live or succeeded job of the document whatever contract it
  // recorded, so recording a newer contract never starts a silent paid rerun. A blocks upgrade is keyed by
  // its own contract (knowvia.ocr.v2), so a stored v1 success does not block it and a repeat request
  // returns the same job.
  createOrGetJob(value, { retryFailed = false, anyContract = false } = {}) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = mapJob(this.database.prepare(`SELECT * FROM ocr_jobs
        WHERE document_upload_id = ? AND provider = ? AND (? OR contract_version = ?)
          AND status IN ('queued', 'submitted', 'processing', 'succeeded')
        ORDER BY requested_at, id LIMIT 1`).get(value.documentUploadId, value.provider, anyContract ? 1 : 0, value.contractVersion));
      if (existing) {
        this.database.exec('COMMIT');
        return { created: false, job: existing };
      }
      const failed = mapJob(this.database.prepare(`SELECT * FROM ocr_jobs
        WHERE document_upload_id = ? AND provider = ? AND (? OR contract_version = ?) AND status = 'failed'
        ORDER BY requested_at DESC, id DESC LIMIT 1`).get(
        value.documentUploadId, value.provider, anyContract ? 1 : 0, value.contractVersion,
      ));
      const safeToRetry = failed && !failed.providerJobRef && SAFE_PRE_DISPATCH_RETRY_CODES.has(failed.errorCode);
      if (failed && (!retryFailed || !safeToRetry)) {
        this.database.exec('COMMIT');
        return { created: false, job: failed, retryBlocked: retryFailed };
      }
      this.database.prepare(`INSERT INTO ocr_jobs
        (id, document_upload_id, provider, provider_job_ref, status, attempt_count,
         contract_version, authorization_json, requested_at, updated_at)
        VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)`).run(
        value.id, value.documentUploadId, value.provider, value.status, value.contractVersion,
        JSON.stringify(value.authorization), value.requestedAt, value.updatedAt,
      );
      const created = this.getJob(value.id);
      this.appendLifecycleAudit(created, null);
      this.database.exec('COMMIT');
      return { created: true, job: created, retryOf: failed?.id ?? null };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createJob(value) {
    this.database.prepare(`INSERT INTO ocr_jobs
      (id, document_upload_id, provider, provider_job_ref, status, attempt_count,
       contract_version, authorization_json, requested_at, updated_at)
      VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?)`).run(
      value.id, value.documentUploadId, value.provider, value.status, value.contractVersion,
      JSON.stringify(value.authorization), value.requestedAt, value.updatedAt,
    );
    return this.getJob(value.id);
  }

  getJob(jobId) {
    return mapJob(this.database.prepare('SELECT * FROM ocr_jobs WHERE id = ?').get(jobId));
  }

  updateJob(jobId, changes) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJob(jobId);
      if (!current) { this.database.exec('COMMIT'); return null; }
      // Cancellation is terminal. A provider response that returns after document erasure must not
      // restart the job or persist provider output.
      if (current.status === 'cancelled') { this.database.exec('COMMIT'); return current; }
      const next = { ...current, ...changes };
      const updated = this.database.prepare(`UPDATE ocr_jobs SET
        provider_job_ref = ?, status = ?, contract_version = ?, result_json = ?, result_digest = ?,
        error_code = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status <> 'cancelled'`).run(
        next.providerJobRef, next.status, next.contractVersion,
        next.result == null ? null : JSON.stringify(next.result), next.resultDigest,
        next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
      );
      const result = this.getJob(jobId);
      this.appendLifecycleAudit(result, current.status);
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  recordCancellationReference(jobId, providerJobRef) {
    this.database.prepare(`UPDATE ocr_jobs SET provider_job_ref = ?
      WHERE id = ? AND status = 'cancelled'
        AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED')
        AND provider_job_ref IS NULL`).run(providerJobRef, jobId);
    return this.getJob(jobId);
  }

  completeCancellation(jobId, { remoteCancellation = true } = {}) {
    this.database.prepare(`UPDATE ocr_jobs SET
      provider_job_ref = CASE WHEN ? THEN NULL ELSE provider_job_ref END,
      error_code = CASE WHEN ? THEN NULL ELSE 'OCR_PROVIDER_CANCELLATION_UNSUPPORTED' END,
      error_message = NULL WHERE id = ? AND status = 'cancelled'`).run(
      remoteCancellation ? 1 : 0, remoteCancellation ? 1 : 0, jobId,
    );
    return this.getJob(jobId);
  }

  // Pages are evidence: parameter observations reference source_pages, so they
  // are inserted once and never deleted or replaced here. Completing a job that
  // already completed is a no-op when the result digest is identical and a
  // stable error otherwise.
  completeJob(jobId, pages, changes) {
    const job = this.getJob(jobId);
    if (!job) throw new Error('OCR job was not found.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJob(jobId);
      const ownPages = this.database.prepare('SELECT count(*) AS count FROM source_pages WHERE ocr_job_id = ?').get(jobId).count;
      if (current.status === 'succeeded' || ownPages > 0) {
        if (current.status === 'succeeded' && ownPages > 0 && typeof changes?.resultDigest === 'string'
          && changes.resultDigest === current.resultDigest) {
          this.database.exec('COMMIT');
          return current;
        }
        const error = new Error('This OCR job is already completed; its source pages are immutable.');
        error.code = current.status === 'succeeded' ? 'OCR_JOB_ALREADY_COMPLETED' : 'OCR_PAGES_ALREADY_EXIST';
        throw error;
      }
      const existing = this.database.prepare(`SELECT ocr_job_id FROM source_pages
        WHERE document_upload_id = ? AND source_version = ?`).all(job.documentUploadId, pages[0]?.sourceVersion ?? '');
      if (existing.some(row => row.ocr_job_id !== jobId)) {
        const error = new Error('Source pages already exist for this immutable document version.');
        error.code = 'OCR_PAGES_ALREADY_EXIST';
        throw error;
      }
      const insert = this.database.prepare(`INSERT INTO source_pages
        (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
         extracted_text, extraction_status, confidence_basis_points, created_at,
         output_contract_version, text_sha256, provider_page_ref, provenance_json, blocks_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const page of pages) {
        // knowvia.ocr.v2 pages carry validated blocks; they are re-validated here so a malformed,
        // reordered or oversize block set fails the whole completion closed. v1 pages store NULL.
        const blocksJson = page.blocks == null ? null : serializeStoredBlocks(page.pageNumber, page.blocks);
        insert.run(
          `page-${randomUUID()}`, page.documentUploadId, jobId, page.pageNumber, page.sourceVersion,
          page.textSha256, page.text, page.extractionStatus, page.confidenceBasisPoints, page.createdAt,
          page.outputContractVersion, page.textSha256, page.providerPageRef, JSON.stringify(page.provenance), blocksJson,
        );
      }
      const next = { ...job, ...changes };
      const updated = this.database.prepare(`UPDATE ocr_jobs SET
        provider_job_ref = ?, status = ?, contract_version = ?, result_json = ?, result_digest = ?,
        error_code = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND (
          status IN ('queued', 'submitted', 'processing')
          OR (status = 'failed' AND error_code = 'OCR_PERSISTENCE_FAILED')
        )`).run(
        next.providerJobRef, next.status, next.contractVersion,
        next.result == null ? null : JSON.stringify(next.result), next.resultDigest,
        next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
      );
      if (updated.changes !== 1) throw new Error('OCR job changed before completion.');
      this.appendLifecycleAudit(this.getJob(jobId), current.status, { pageCount: pages.length });
      this.database.exec('COMMIT');
      return this.getJob(jobId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Whether the document's current version needs a blocks upgrade: every page was stored with text by
   * a succeeded job, at least one page has no blocks, and no page was upgraded or erased before.
   */
  getBlocksUpgradeState(documentId) {
    const document = this.database.prepare(`SELECT source_version FROM document_uploads
      WHERE id = ? AND lifecycle_state = 'active'`).get(documentId);
    if (!document) return Object.freeze({ needed: false, pages: 0 });
    const rows = this.database.prepare(`SELECT page.extracted_text IS NOT NULL AS has_text, page.blocks_json IS NULL AS missing,
        page.blocks_upgrade_job_id IS NOT NULL AS upgraded, job.status AS job_status
      FROM source_pages page LEFT JOIN ocr_jobs job ON job.id = page.ocr_job_id
      WHERE page.document_upload_id = ? AND page.source_version = ?`).all(documentId, document.source_version);
    const needed = rows.length > 0 && rows.every(row => row.has_text && !row.upgraded && row.job_status === 'succeeded')
      && rows.some(row => row.missing);
    return Object.freeze({ needed, pages: rows.length });
  }

  /**
   * Completes a blocks upgrade job: in one transaction the job succeeds and each stored page of the same
   * document version takes its blocks once, only when the new page text equals the stored text exactly
   * (text_sha256). Any difference fails closed with OCR_UPGRADE_TEXT_CHANGED and changes no page; page
   * ids and text never change, so existing observations keep their source page.
   */
  attachUpgradeBlocks(jobId, pages, changes) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getJob(jobId);
      if (!current || current.authorization?.blocksUpgrade !== true) throw coded('OCR_UPGRADE_NOT_NEEDED', 'This OCR job is not a blocks upgrade.', 409);
      if (!['queued', 'submitted', 'processing'].includes(current.status)) {
        if (current.status === 'succeeded' && changes?.resultDigest === current.resultDigest) {
          this.database.exec('COMMIT');
          return current;
        }
        throw coded('OCR_JOB_ALREADY_COMPLETED', 'This OCR job is already completed.', 409);
      }
      const stored = this.database.prepare(`SELECT id, page_number, text_sha256, blocks_json, blocks_upgrade_job_id, extracted_text
        FROM source_pages WHERE document_upload_id = ? AND source_version = ? ORDER BY page_number`)
        .all(current.documentUploadId, pages[0]?.sourceVersion ?? '');
      const byNumber = new Map(pages.map(page => [page.pageNumber, page]));
      const matches = stored.length === pages.length && stored.every(row => row.extracted_text !== null && row.blocks_upgrade_job_id === null
        && byNumber.get(row.page_number)?.textSha256 === row.text_sha256 && byNumber.get(row.page_number)?.blocks != null);
      if (!matches) throw coded('OCR_UPGRADE_TEXT_CHANGED', 'The provider text differs from the stored page text; the stored pages are kept.', 409);
      const next = { ...current, ...changes };
      const updated = this.database.prepare(`UPDATE ocr_jobs SET
        provider_job_ref = ?, status = ?, contract_version = ?, result_json = ?, result_digest = ?,
        error_code = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'submitted', 'processing')`).run(
        next.providerJobRef, next.status, next.contractVersion,
        next.result == null ? null : JSON.stringify(next.result), next.resultDigest,
        next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
      );
      if (updated.changes !== 1) throw new Error('OCR job changed before completion.');
      const fill = this.database.prepare(`UPDATE source_pages SET blocks_json = ?, blocks_upgrade_job_id = ?
        WHERE id = ? AND blocks_json IS NULL`);
      for (const row of stored) {
        if (row.blocks_json !== null) continue;
        const page = byNumber.get(row.page_number);
        fill.run(serializeStoredBlocks(page.pageNumber, page.blocks), jobId, row.id);
      }
      this.appendLifecycleAudit(this.getJob(jobId), current.status, { pageCount: stored.length });
      this.database.exec('COMMIT');
      return this.getJob(jobId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Block-level pages of a document's current version for the policy sectioner, household scoped.
   * Returns { documentId, sourceVersion, complete, pages: [{ page, sourcePageId, providerPageRef,
   * status, blocks }] }. A page stored without blocks (knowvia.ocr.v1) has status
   * 'blocks_unavailable' and blocks null, so it is never sectioned as if it were complete.
   */
  getDocumentBlockPages({ documentId, householdId }) {
    const document = this.database.prepare(`SELECT id, source_version FROM document_uploads
      WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`).get(documentId, householdId);
    if (!document) throw coded('DOCUMENT_NOT_FOUND', 'Document was not found.', 404);
    const rows = this.database.prepare(`SELECT page.id, page.page_number, page.provider_page_ref, page.blocks_json
      FROM source_pages page
      JOIN ocr_jobs job ON job.id = page.ocr_job_id
      WHERE page.document_upload_id = ? AND page.source_version = ? AND job.status = 'succeeded'
        AND page.extraction_status IN ('extracted', 'manual_verified') AND page.extracted_text IS NOT NULL
      ORDER BY page.page_number`).all(document.id, document.source_version);
    if (!rows.length) throw coded('OCR_PAGES_UNAVAILABLE', 'No stored OCR pages are available for this document.', 409);
    if (rows.some((row, index) => row.page_number !== index + 1)) {
      throw coded('OCR_PAGES_INCOMPLETE', 'Stored OCR pages are incomplete.', 409);
    }
    const pages = rows.map(row => Object.freeze({
      page: row.page_number,
      sourcePageId: row.id,
      providerPageRef: row.provider_page_ref,
      status: row.blocks_json == null ? 'blocks_unavailable' : 'stored',
      blocks: row.blocks_json == null ? null : parseStoredBlocks(row.blocks_json, row.page_number),
    }));
    return Object.freeze({
      documentId: document.id,
      sourceVersion: document.source_version,
      complete: pages.every(page => page.status === 'stored'),
      pages: Object.freeze(pages),
    });
  }
}
