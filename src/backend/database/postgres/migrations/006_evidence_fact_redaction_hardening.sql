-- Forward fix for 005 (review of PR #13). 005 is merged and immutable; mirrors SQLite 010.
-- 1. Facts cannot cite pages of a document whose erasure has started.
-- 2. Redaction timestamps must be exact ISO-8601 UTC with milliseconds (trigger; the 005
--    constraint stays).
-- 3. Backfill facts of documents whose erasure started before 005.

CREATE FUNCTION public.evidence_facts_erased_document_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.source_pages AS page
    JOIN public.document_uploads AS document ON document.id = page.document_upload_id
    WHERE page.id = NEW.source_page_id AND document.lifecycle_state IN ('deletion_requested', 'deleted')
  ) THEN
    RAISE EXCEPTION 'evidence facts cannot cite an erased document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER evidence_facts_erased_document_insert
BEFORE INSERT ON public.evidence_facts
FOR EACH ROW
WHEN (NEW.source_page_id IS NOT NULL)
EXECUTE FUNCTION public.evidence_facts_erased_document_insert_fn();

CREATE FUNCTION public.evidence_facts_redaction_format_update_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.redacted_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    OR public.julianday(NEW.redacted_at) IS NULL THEN
    RAISE EXCEPTION 'evidence fact redaction time must be ISO-8601 UTC with milliseconds';
  END IF;
  RETURN NEW;
END;
$$;

-- A trigger, like SQLite 010, so both engines keep the same constraint and trigger catalog.
CREATE TRIGGER evidence_facts_redaction_format_update
BEFORE UPDATE OF redacted_at ON public.evidence_facts
FOR EACH ROW
WHEN (NEW.redacted_at IS NOT NULL)
EXECUTE FUNCTION public.evidence_facts_redaction_format_update_fn();

UPDATE public.evidence_facts
SET epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
    institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL,
    effective_at = NULL,
    redacted_at = public.coversaath_utc_now(),
    redaction_reason_code = 'document_erasure'
WHERE redacted_at IS NULL
  AND source_page_id IN (
    SELECT page.id FROM public.source_pages AS page
    JOIN public.document_uploads AS document ON document.id = page.document_upload_id
    WHERE document.lifecycle_state IN ('deletion_requested', 'deleted')
  );
