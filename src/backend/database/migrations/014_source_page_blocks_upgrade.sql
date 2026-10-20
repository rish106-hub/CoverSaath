-- Explicit block upgrade for knowvia.ocr.v1 pages (ADR 0006 addendum). Expand-only: one nullable
-- column, the blocks immutability trigger narrowed (same name, same event), one new guard.
--
--   * blocks_upgrade_job_id names the succeeded knowvia.ocr.v2 OCR job of the same document version
--     that filled a v1 page's blocks. It is set once, together with the blocks, and never changes.
--   * source_pages_blocks_immutable still rejects every blocks change except one: a one-time NULL to
--     blocks fill on a page that was never upgraded, with its text unchanged, naming a succeeded v2 job
--     of the same document whose current version is the page's version. The application checks that
--     the new provider text equals the stored text (text_sha256) before it writes; erasure still clears
--     blocks, and an erased page (upgrade id kept) can never be refilled.
--
-- Rollback: forward-only. Revert code and re-initialise the local database (no production data).
-- Mirrored by PostgreSQL migration 011.

ALTER TABLE source_pages ADD COLUMN blocks_upgrade_job_id TEXT REFERENCES ocr_jobs(id);

DROP TRIGGER source_pages_blocks_immutable;

CREATE TRIGGER source_pages_blocks_immutable
BEFORE UPDATE OF blocks_json ON source_pages
WHEN NEW.blocks_json IS NOT NULL AND (OLD.blocks_json IS NULL OR NEW.blocks_json <> OLD.blocks_json)
  AND NOT (
    OLD.blocks_json IS NULL
    AND OLD.blocks_upgrade_job_id IS NULL
    AND NEW.blocks_upgrade_job_id IS NOT NULL
    AND NEW.extracted_text IS NOT NULL
    AND NEW.extracted_text IS OLD.extracted_text
    AND NEW.text_sha256 IS OLD.text_sha256
    AND NEW.source_version IS OLD.source_version
    AND NEW.document_upload_id IS OLD.document_upload_id
    AND EXISTS (
      SELECT 1 FROM ocr_jobs job
      JOIN document_uploads document ON document.id = job.document_upload_id
      WHERE job.id = NEW.blocks_upgrade_job_id
        AND job.document_upload_id = NEW.document_upload_id
        AND job.id IS NOT NEW.ocr_job_id
        AND job.status = 'succeeded'
        AND job.contract_version = 'knowvia.ocr.v2'
        AND document.source_version = NEW.source_version
        AND document.lifecycle_state = 'active'
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'source page blocks are immutable; only erasure may clear them');
END;

CREATE TRIGGER source_pages_blocks_upgrade_job_immutable
BEFORE UPDATE OF blocks_upgrade_job_id ON source_pages
WHEN NEW.blocks_upgrade_job_id IS NOT OLD.blocks_upgrade_job_id
  AND NOT (OLD.blocks_upgrade_job_id IS NULL AND OLD.blocks_json IS NULL AND NEW.blocks_json IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'source page blocks upgrade job is set once with its blocks');
END;
