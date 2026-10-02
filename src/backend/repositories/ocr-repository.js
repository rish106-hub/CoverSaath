import { randomUUID } from 'node:crypto';

const parse = value => value == null ? null : JSON.parse(value);

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
  constructor(database) {
    this.database = database;
  }

  getReadyDocument(documentId, at) {
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
    return Object.freeze({
      documentId: row.document_id,
      consentGrantId: row.consent_grant_id,
      uploadedByAdultId: row.uploaded_by_adult_id,
      sourceVersion: row.source_version,
      contentSha256: row.content_sha256,
      mimeType: row.mime_type,
      byteSize: row.byte_size,
      storageReference: row.storage_path,
    });
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
    const current = this.getJob(jobId);
    if (!current) return null;
    const next = { ...current, ...changes };
    this.database.prepare(`UPDATE ocr_jobs SET
      provider_job_ref = ?, status = ?, contract_version = ?, result_json = ?, result_digest = ?,
      error_code = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
      WHERE id = ?`).run(
      next.providerJobRef, next.status, next.contractVersion,
      next.result == null ? null : JSON.stringify(next.result), next.resultDigest,
      next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
    );
    return this.getJob(jobId);
  }

  completeJob(jobId, pages, changes) {
    const job = this.getJob(jobId);
    if (!job) throw new Error('OCR job was not found.');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.database.prepare(`SELECT ocr_job_id FROM source_pages
        WHERE document_upload_id = ? AND source_version = ?`).all(job.documentUploadId, pages[0]?.sourceVersion ?? '');
      if (existing.some(row => row.ocr_job_id !== jobId)) {
        const error = new Error('Source pages already exist for this immutable document version.');
        error.code = 'OCR_PAGES_ALREADY_EXIST';
        throw error;
      }
      this.database.prepare('DELETE FROM source_pages WHERE ocr_job_id = ?').run(jobId);
      const insert = this.database.prepare(`INSERT INTO source_pages
        (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
         extracted_text, extraction_status, confidence_basis_points, created_at,
         output_contract_version, text_sha256, provider_page_ref, provenance_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const page of pages) {
        insert.run(
          `page-${randomUUID()}`, page.documentUploadId, jobId, page.pageNumber, page.sourceVersion,
          page.textSha256, page.text, page.extractionStatus, page.confidenceBasisPoints, page.createdAt,
          page.outputContractVersion, page.textSha256, page.providerPageRef, JSON.stringify(page.provenance),
        );
      }
      const next = { ...job, ...changes };
      const updated = this.database.prepare(`UPDATE ocr_jobs SET
        provider_job_ref = ?, status = ?, contract_version = ?, result_json = ?, result_digest = ?,
        error_code = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status IN ('queued', 'submitted', 'processing')`).run(
        next.providerJobRef, next.status, next.contractVersion,
        next.result == null ? null : JSON.stringify(next.result), next.resultDigest,
        next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
      );
      if (updated.changes !== 1) throw new Error('OCR job changed before completion.');
      this.database.exec('COMMIT');
      return this.getJob(jobId);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
}
