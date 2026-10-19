-- Block 1 document intake (ADR 0005). Expand-only.
-- Durable scan scheduling: attempts and the next due time live on the row, so a scanner outage
-- defers documents instead of stranding them, and deletion work is never starved by scan work.
-- Unique indexes make the duplicate-content and immutable-version checks hold under concurrency.
-- Fails if a database already holds live duplicates of the same content or version in one
-- household; resolve those rows first (local synthetic data only today).

ALTER TABLE document_uploads ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0 CHECK (scan_attempts >= 0);
ALTER TABLE document_uploads ADD COLUMN next_scan_at TEXT;

CREATE UNIQUE INDEX document_uploads_household_content_live_uidx
  ON document_uploads(household_id, content_sha256)
  WHERE lifecycle_state NOT IN ('deleted', 'deletion_requested');

CREATE UNIQUE INDEX document_uploads_household_logical_version_uidx
  ON document_uploads(household_id, logical_document_id, source_version)
  WHERE logical_document_id IS NOT NULL;

CREATE INDEX document_uploads_work_idx
  ON document_uploads(lifecycle_state, malware_status, next_scan_at);
