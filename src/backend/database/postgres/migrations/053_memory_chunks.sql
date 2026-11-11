-- Memory chunks (ADR 0031). Expand-only and safe to run more than once: the pgvector extension, one table, its triggers and its lockdown.
-- memory_chunks: retrieval units of one household's memory, embedded so chat can find the passages closest to a question.
--   * The vector extension lives in the `extensions` schema (the Supabase convention, ADR 0011), so every reference below is
--     schema-qualified and application queries name `extensions.vector` and the OPERATOR(extensions.<=>) form. On a database where it
--     is already installed elsewhere the CREATE below is a no-op and this migration fails on the first qualified reference: fix the
--     extension location first (a documented, reversible step, docs/runbooks/fly-deploy.md).
--   * chunk_text_enc is the REDACTED passage (what was embedded, with placeholders for names and identifiers), sealed (enc2, AAD
--     memory_chunks.chunk_text_enc.<row id>). It is never decrypted into a prompt as a name or identifier because none is in it.
--   * embedding is PLAINTEXT by necessity: pgvector cannot index ciphertext. An embedding leaks some of the content it encodes
--     (ADR 0031 records this). Mitigations: own-PDF passages are redacted before embedding, chunks are household scoped, and rows are
--     DELETED (never redacted) on erasure: with the holding, the source document, the consent grant and the household.
--   * Rows are replaced, never edited (a BEFORE UPDATE guard). One live row per (household, holding, scope, source_ref).
--   * HNSW partial index over the household scopes; the main btree index starts with household_id. Cross-household reads are
--     impossible by construction: every query filters on household_id first.
--   * Insurer wording (shared by reference_cache id, never per household) is NOT stored here: scope insurer_doc is not allowed.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Revert the code and turn MEMORY_ENABLED off; a synthetic-only project may drop the table.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.memory_chunks (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('own_pdf', 'confirmed_fact', 'declaration', 'chat_summary')),
  source_ref text NOT NULL CHECK (source_ref ~ '^[a-z0-9_.:-]{1,100}$'),
  chunk_text_enc text NOT NULL CHECK (chunk_text_enc ~ '^enc2[.]'),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  embedding extensions.vector(1024) NOT NULL,
  embedding_model text NOT NULL CHECK (length(embedding_model) BETWEEN 1 AND 120),
  token_count integer NOT NULL DEFAULT 0 CHECK (token_count >= 0),
  source_document_id text REFERENCES public.document_uploads(id) ON DELETE CASCADE,
  consent_grant_id text NOT NULL REFERENCES public.consent_grants(id),
  created_at text NOT NULL
);

-- Main access path: household first, then the holding and scope.
CREATE INDEX IF NOT EXISTS memory_chunks_household_idx ON public.memory_chunks (household_id, holding_id, scope);
CREATE UNIQUE INDEX IF NOT EXISTS memory_chunks_source_slot
  ON public.memory_chunks (household_id, COALESCE(holding_id, ''), scope, source_ref);
CREATE INDEX IF NOT EXISTS memory_chunks_document_idx ON public.memory_chunks (source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS memory_chunks_consent_idx ON public.memory_chunks (consent_grant_id);
-- Nearest-neighbour search. SCALE: at more than about 1M rows per project partition by household hash and use hnsw.iterative_scan.
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_hnsw ON public.memory_chunks
  USING hnsw (embedding extensions.vector_cosine_ops) WHERE scope IN ('own_pdf', 'confirmed_fact', 'declaration');

CREATE OR REPLACE FUNCTION public.memory_chunks_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_grants AS grant_record WHERE grant_record.id = NEW.consent_grant_id AND grant_record.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory chunk must use a consent grant of its household';
  END IF;
  IF NEW.holding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory chunk must match a holding of its household';
  END IF;
  IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.source_document_id AND document.household_id = NEW.household_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'memory chunk must match an active document of its household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS memory_chunks_scope_insert ON public.memory_chunks;
CREATE TRIGGER memory_chunks_scope_insert
BEFORE INSERT ON public.memory_chunks
FOR EACH ROW EXECUTE FUNCTION public.memory_chunks_scope_insert_fn();

CREATE OR REPLACE FUNCTION public.memory_chunks_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'memory chunks are replaced, never edited; erasure deletes them';
END;
$$;

DROP TRIGGER IF EXISTS memory_chunks_immutable ON public.memory_chunks;
CREATE TRIGGER memory_chunks_immutable
BEFORE UPDATE ON public.memory_chunks
FOR EACH ROW EXECUTE FUNCTION public.memory_chunks_immutable_fn();

ALTER TABLE public.memory_chunks ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.memory_chunks FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.memory_chunks FROM PUBLIC;
END
$$;
