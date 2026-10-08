import { randomUUID } from 'node:crypto';
import { jsonParam, parseJson as parse, stripNul } from '../database/value-codec.js';

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

  async getReadyDocument(documentId, at) {
    const row = await this.database.one(`SELECT
        document.id AS document_id, document.consent_grant_id, document.uploaded_by_adult_id,
        document.source_version, document.content_sha256, document.mime_type, document.byte_size,
        document.storage_path
      FROM document_uploads document
      JOIN consent_grants consent ON consent.id = document.consent_grant_id
      WHERE document.id = $1
        AND document.lifecycle_state = 'active'
        AND document.malware_status IN ('clean', 'not_scanned_fixture')
        AND document.encryption_status IN ('encrypted_local', 'fixture_only')
        AND consent.purpose = 'document_processing'
        AND consent.revoked_at IS NULL
        AND (consent.expires_at IS NULL OR consent.expires_at > $2::timestamptz)
        AND EXISTS (
          SELECT 1 FROM consent_scopes scope
          WHERE scope.consent_grant_id = consent.id
            AND scope.resource_type = 'document'
            AND (scope.resource_id IS NULL OR scope.resource_id = document.id)
            AND scope.action = 'collect'
            AND scope.data_category = 'insurance_document'
        )`, [documentId, at]);
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

  async createJob(value) {
    await this.database.query(`INSERT INTO ocr_jobs
      (id, document_upload_id, provider, provider_job_ref, status, attempt_count,
       contract_version, authorization_json, requested_at, updated_at)
      VALUES ($1, $2, $3, NULL, $4, 1, $5, $6, $7, $8)`, [
      value.id, value.documentUploadId, value.provider, value.status, value.contractVersion,
      jsonParam(value.authorization), value.requestedAt, value.updatedAt,
    ]);
    return this.getJob(value.id);
  }

  async getJob(jobId) {
    return mapJob(await this.database.one('SELECT * FROM ocr_jobs WHERE id = $1', [jobId]));
  }

  async updateJob(jobId, changes) {
    const current = await this.getJob(jobId);
    if (!current) return null;
    const next = { ...current, ...changes };
    await this.database.query(`UPDATE ocr_jobs SET
      provider_job_ref = $1, status = $2, contract_version = $3, result_json = $4, result_digest = $5,
      error_code = $6, error_message = $7, started_at = $8, completed_at = $9, updated_at = $10
      WHERE id = $11`, [
      next.providerJobRef, next.status, next.contractVersion,
      jsonParam(next.result), next.resultDigest,
      next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
    ]);
    return this.getJob(jobId);
  }

  async completeJob(jobId, pages, changes) {
    await this.database.transaction(async tx => {
      const job = await tx.one('SELECT * FROM ocr_jobs WHERE id = $1 FOR UPDATE', [jobId]).then(mapJob);
      if (!job) throw new Error('OCR job was not found.');
      const existing = await tx.query(`SELECT ocr_job_id FROM source_pages
        WHERE document_upload_id = $1 AND source_version = $2`, [job.documentUploadId, pages[0]?.sourceVersion ?? '']);
      if (existing.some(row => row.ocr_job_id !== jobId)) {
        const error = new Error('Source pages already exist for this immutable document version.');
        error.code = 'OCR_PAGES_ALREADY_EXIST';
        throw error;
      }
      await tx.query('DELETE FROM source_pages WHERE ocr_job_id = $1', [jobId]);
      for (const page of pages) {
        await tx.query(`INSERT INTO source_pages
          (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
           extracted_text, extraction_status, confidence_basis_points, created_at,
           output_contract_version, text_sha256, provider_page_ref, provenance_json)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`, [
          `page-${randomUUID()}`, page.documentUploadId, jobId, page.pageNumber, page.sourceVersion,
          page.textSha256, stripNul(page.text), page.extractionStatus, page.confidenceBasisPoints, page.createdAt,
          page.outputContractVersion, page.textSha256, page.providerPageRef, jsonParam(page.provenance),
        ]);
      }
      const next = { ...job, ...changes };
      const updated = await tx.run(`UPDATE ocr_jobs SET
        provider_job_ref = $1, status = $2, contract_version = $3, result_json = $4, result_digest = $5,
        error_code = $6, error_message = $7, started_at = $8, completed_at = $9, updated_at = $10
        WHERE id = $11 AND status IN ('queued', 'submitted', 'processing')`, [
        next.providerJobRef, next.status, next.contractVersion,
        jsonParam(next.result), next.resultDigest,
        next.errorCode, next.errorMessage, next.startedAt, next.completedAt, next.updatedAt, jobId,
      ]);
      if (updated.rowCount !== 1) throw new Error('OCR job changed before completion.');
    });
    return this.getJob(jobId);
  }
}
