-- Holding documents (two-document holdings). Expand-only and safe to run more than once: one new table, its triggers and its lockdown,
-- plus one nullable column on memory_chunks.
-- One policy is often evidenced by several PDFs (the schedule, the wording / terms and conditions, endorsements). A holding stays one per
-- document (048: UNIQUE household_id, document_id); this table additively LINKS further documents of the same household to a holding so
-- memory can embed their clauses for that holding's chat.
--   * holding, document and household must agree (scope trigger); a link needs an active document, and a holding's own document is never
--     linked to itself. One link per (holding, document).
--   * a link is erased with its holding (ON DELETE CASCADE), with its document (cascade, and the trigger below on withdrawal or erasure),
--     with the household and on consent withdrawal (application erasure paths: memory-erasure.js).
-- Nothing here is a sealed value: every column is an id, a closed enum or a timestamp.
-- memory_chunks.source_page: the printed page a wording passage came from, so a chat answer can cite document and page. Nullable.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Consent, privacy and notice wording around this store is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code (the link routes and the eager embedding of linked documents); a synthetic-only project may
-- drop holding_documents and the source_page column. Nothing else reads them.
CREATE TABLE IF NOT EXISTS public.holding_documents (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text NOT NULL REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  document_id text NOT NULL REFERENCES public.document_uploads(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('wording', 'endorsement', 'other')),
  created_at text NOT NULL,
  UNIQUE (holding_id, document_id)
);

CREATE INDEX IF NOT EXISTS holding_documents_household_idx ON public.holding_documents (household_id, holding_id);
CREATE INDEX IF NOT EXISTS holding_documents_document_idx ON public.holding_documents (document_id);

CREATE OR REPLACE FUNCTION public.holding_documents_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding
    WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id AND holding.document_id <> NEW.document_id
  ) THEN
    RAISE EXCEPTION 'holding document must link another document to a holding of its household';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.document_id AND document.household_id = NEW.household_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'holding document must match an active document of its household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS holding_documents_scope_insert ON public.holding_documents;
CREATE TRIGGER holding_documents_scope_insert
BEFORE INSERT ON public.holding_documents
FOR EACH ROW EXECUTE FUNCTION public.holding_documents_scope_fn();

CREATE OR REPLACE FUNCTION public.holding_documents_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.holding_documents WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS holding_documents_erase_on_document_erasure ON public.document_uploads;
CREATE TRIGGER holding_documents_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.holding_documents_erase_on_document_erasure_fn();

ALTER TABLE public.memory_chunks ADD COLUMN IF NOT EXISTS source_page integer CHECK (source_page IS NULL OR source_page BETWEEN 1 AND 100000);

ALTER TABLE public.holding_documents ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.holding_documents FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.holding_documents FROM PUBLIC;
END
$$;
