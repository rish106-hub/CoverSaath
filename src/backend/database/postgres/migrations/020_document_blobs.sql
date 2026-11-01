-- Document bytes in the database (run E1c, ADR 0013). Expand-only and safe to run more than once: one new table, no change
-- to an existing table. A row holds the SAME CSD1 envelope the filesystem adapter writes (magic, nonce, tag, AES-256-GCM
-- ciphertext, AAD = document id), so the bytes are encrypted in the application BEFORE they reach PostgreSQL; the database
-- never sees plaintext and never holds a key. storage_key is sha256(document id), the reference stored in
-- document_uploads.storage_path.
--
-- There is deliberately no foreign key to document_uploads: intake stores the bytes first and creates the document row
-- afterwards, so a foreign key would reject the first insert. Instead (1) a trigger deletes the blob in the SAME
-- transaction in which a document enters deletion_requested or deleted (consent revocation, erasure, malware block), and
-- (2) the existing orphan sweep removes a blob with no live document row. household_id is kept so a blob can be located
-- and erased by household.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
CREATE TABLE IF NOT EXISTS public.document_blobs (
  document_id text PRIMARY KEY,
  storage_key text NOT NULL UNIQUE CHECK (storage_key ~ '^[0-9a-f]{64}$'),
  household_id text NOT NULL REFERENCES public.households(id),
  envelope bytea NOT NULL CHECK (octet_length(envelope) <= 16777216),
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS document_blobs_household_idx ON public.document_blobs (household_id);

CREATE OR REPLACE FUNCTION public.document_blobs_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.document_blobs WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS document_blobs_erase_on_document_erasure ON public.document_uploads;
CREATE TRIGGER document_blobs_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.document_blobs_erase_on_document_erasure_fn();

ALTER TABLE public.document_blobs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.document_blobs FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
