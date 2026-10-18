-- Block 1 document intake (ADR 0005). Expand-only. Mirrors SQLite migration 008.
-- Durable scan scheduling on the row and unique indexes for duplicate content and immutable
-- versions within a household.

ALTER TABLE public.document_uploads ADD COLUMN scan_attempts bigint NOT NULL DEFAULT 0 CHECK (scan_attempts >= 0);
ALTER TABLE public.document_uploads ADD COLUMN next_scan_at text;

CREATE UNIQUE INDEX document_uploads_household_content_live_uidx
  ON public.document_uploads(household_id, content_sha256)
  WHERE lifecycle_state NOT IN ('deleted', 'deletion_requested');

CREATE UNIQUE INDEX document_uploads_household_logical_version_uidx
  ON public.document_uploads(household_id, logical_document_id, source_version)
  WHERE logical_document_id IS NOT NULL;

CREATE INDEX document_uploads_work_idx
  ON public.document_uploads(lifecycle_state, malware_status, next_scan_at);
