-- Explicit block upgrade for knowvia.ocr.v1 pages (ADR 0006 addendum). Expand-only. Mirrors SQLite
-- migration 014: same column, the blocks immutability trigger narrowed (same name, timing and event,
-- the allowed fill checked in its function), one new guard with the same message.
-- Rollback: forward-only. Revert code and re-initialise the local database (no production data).

ALTER TABLE public.source_pages ADD COLUMN blocks_upgrade_job_id text REFERENCES public.ocr_jobs(id);

CREATE OR REPLACE FUNCTION public.source_pages_blocks_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.blocks_json IS NULL
    AND OLD.blocks_upgrade_job_id IS NULL
    AND NEW.blocks_upgrade_job_id IS NOT NULL
    AND NEW.extracted_text IS NOT NULL
    AND NEW.extracted_text IS NOT DISTINCT FROM OLD.extracted_text
    AND NEW.text_sha256 IS NOT DISTINCT FROM OLD.text_sha256
    AND NEW.source_version IS NOT DISTINCT FROM OLD.source_version
    AND NEW.document_upload_id IS NOT DISTINCT FROM OLD.document_upload_id
    AND EXISTS (
      SELECT 1 FROM public.ocr_jobs AS job
      JOIN public.document_uploads AS document ON document.id = job.document_upload_id
      WHERE job.id = NEW.blocks_upgrade_job_id
        AND job.document_upload_id = NEW.document_upload_id
        AND job.id IS DISTINCT FROM NEW.ocr_job_id
        AND job.status = 'succeeded'
        AND job.contract_version = 'knowvia.ocr.v2'
        AND document.source_version = NEW.source_version
        AND document.lifecycle_state = 'active'
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'source page blocks are immutable; only erasure may clear them';
END;
$$;

CREATE FUNCTION public.source_pages_blocks_upgrade_job_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'source page blocks upgrade job is set once with its blocks';
END;
$$;

CREATE TRIGGER source_pages_blocks_upgrade_job_immutable
BEFORE UPDATE OF blocks_upgrade_job_id ON public.source_pages
FOR EACH ROW
WHEN (NEW.blocks_upgrade_job_id IS DISTINCT FROM OLD.blocks_upgrade_job_id
  AND NOT (OLD.blocks_upgrade_job_id IS NULL AND OLD.blocks_json IS NULL AND NEW.blocks_json IS NOT NULL))
EXECUTE FUNCTION public.source_pages_blocks_upgrade_job_immutable_fn();
