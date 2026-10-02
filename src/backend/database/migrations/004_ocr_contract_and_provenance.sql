-- Expand-only OCR lifecycle metadata. Existing jobs and source pages remain readable.
ALTER TABLE document_uploads ADD COLUMN logical_document_id TEXT;
ALTER TABLE document_uploads ADD COLUMN source_version TEXT NOT NULL DEFAULT '1';

ALTER TABLE ocr_jobs ADD COLUMN contract_version TEXT NOT NULL DEFAULT 'knowvia.ocr.v1';
ALTER TABLE ocr_jobs ADD COLUMN authorization_json TEXT CHECK (authorization_json IS NULL OR json_valid(authorization_json));
ALTER TABLE ocr_jobs ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
ALTER TABLE ocr_jobs ADD COLUMN result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64);
ALTER TABLE ocr_jobs ADD COLUMN updated_at TEXT;

ALTER TABLE source_pages ADD COLUMN output_contract_version TEXT NOT NULL DEFAULT 'knowvia.ocr.v1';
ALTER TABLE source_pages ADD COLUMN text_sha256 TEXT CHECK (text_sha256 IS NULL OR length(text_sha256) = 64);
ALTER TABLE source_pages ADD COLUMN provider_page_ref TEXT;
ALTER TABLE source_pages ADD COLUMN provenance_json TEXT CHECK (provenance_json IS NULL OR json_valid(provenance_json));

CREATE INDEX ocr_jobs_lifecycle_idx
ON ocr_jobs(status, requested_at, document_upload_id);

CREATE TRIGGER ocr_jobs_document_ready_insert
BEFORE INSERT ON ocr_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM document_uploads document
  JOIN consent_grants consent ON consent.id = document.consent_grant_id
  WHERE document.id = NEW.document_upload_id
    AND document.lifecycle_state = 'active'
    AND document.malware_status IN ('clean', 'not_scanned_fixture')
    AND document.encryption_status IN ('encrypted_local', 'fixture_only')
    AND consent.purpose = 'document_processing'
    AND consent.revoked_at IS NULL
    AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(NEW.requested_at))
)
BEGIN
  SELECT RAISE(ABORT, 'OCR requires an active protected document and current processing consent');
END;

CREATE TRIGGER source_pages_ocr_document_match_insert
BEFORE INSERT ON source_pages
WHEN NEW.ocr_job_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ocr_jobs job
  WHERE job.id = NEW.ocr_job_id AND job.document_upload_id = NEW.document_upload_id
)
BEGIN
  SELECT RAISE(ABORT, 'source page OCR job must belong to its document');
END;

CREATE TRIGGER source_pages_ocr_document_match_update
BEFORE UPDATE OF document_upload_id, ocr_job_id ON source_pages
WHEN NEW.ocr_job_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ocr_jobs job
  WHERE job.id = NEW.ocr_job_id AND job.document_upload_id = NEW.document_upload_id
)
BEGIN
  SELECT RAISE(ABORT, 'source page OCR job must belong to its document');
END;
