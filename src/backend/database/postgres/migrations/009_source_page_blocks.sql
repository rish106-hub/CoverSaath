-- Stored OCR blocks (ADR 0006 addendum, knowvia.ocr.v2). Expand-only. Mirrors SQLite migration 012:
-- same column, check, trigger names, timing, events and messages.

ALTER TABLE public.source_pages ADD COLUMN blocks_json text CHECK (
  blocks_json IS NULL OR (blocks_json IS JSON OBJECT AND length(blocks_json) <= 1000000)
);

CREATE FUNCTION public.source_pages_blocks_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.extracted_text IS NULL OR EXISTS (
    SELECT 1 FROM public.document_uploads document
    WHERE document.id = NEW.document_upload_id AND document.lifecycle_state IN ('deletion_requested', 'deleted')
  ) THEN
    RAISE EXCEPTION 'source page blocks require page text and a live document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER source_pages_blocks_insert
BEFORE INSERT ON public.source_pages
FOR EACH ROW
WHEN (NEW.blocks_json IS NOT NULL)
EXECUTE FUNCTION public.source_pages_blocks_insert_fn();

CREATE FUNCTION public.source_pages_blocks_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'source page blocks are immutable; only erasure may clear them';
END;
$$;

CREATE TRIGGER source_pages_blocks_immutable
BEFORE UPDATE OF blocks_json ON public.source_pages
FOR EACH ROW
WHEN (NEW.blocks_json IS NOT NULL AND (OLD.blocks_json IS NULL OR NEW.blocks_json IS DISTINCT FROM OLD.blocks_json))
EXECUTE FUNCTION public.source_pages_blocks_immutable_fn();

CREATE FUNCTION public.source_pages_blocks_erase_with_text_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.source_pages SET blocks_json = NULL WHERE id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER source_pages_blocks_erase_with_text
AFTER UPDATE OF extracted_text ON public.source_pages
FOR EACH ROW
WHEN (NEW.extracted_text IS NULL AND NEW.blocks_json IS NOT NULL)
EXECUTE FUNCTION public.source_pages_blocks_erase_with_text_fn();

CREATE FUNCTION public.source_pages_blocks_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.source_pages SET blocks_json = NULL WHERE document_upload_id = NEW.id AND blocks_json IS NOT NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER source_pages_blocks_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.source_pages_blocks_erase_on_document_erasure_fn();
