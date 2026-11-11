-- Chat v1 storage (ADR 0029 voice transcripts, ADR 0031 memory). Expand-only and safe to run more than once: three tables, their
-- scope triggers and their lockdown.
--   chat_threads      one conversation of a household, optionally about one holding. Ids and timestamps only.
--   chat_turns        one message. Content is sealed (enc2, AAD chat_turns.content_enc.<row id>); a turn that came from a voice note also
--                     keeps its transcript sealed (transcript_enc, ADR 0029: the owner chose to store transcripts, FOR LEGAL REVIEW).
--                     audio_document_id is set only when the server runs with VOICE_AUDIO_RETAIN exactly "true"; the database repeats
--                     that the fields belong to a voice turn only. Assistant turns carry the provider audit summary: provider, model,
--                     tokens, cost in paise, latency and the sha256 of the REDACTED prompt (never the prompt).
--   retrieval_traces  what one answer rested on: ids of the holdings, memory rows, chunks and open conflicts it drew on, and how they were found
--                     (vector, keyword or facts only). Ids only.
-- Everything here is derived from a household's documents and statements, so it is erased with the household, with the holding or
-- document it was derived from, and on consent revocation (memory-erasure.js deletes any thread whose trace names an erased fact or
-- chunk, and every thread of an erased holding). Rows are DELETED, never redacted.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Revert the code and turn MEMORY_ENABLED off; a synthetic-only project may drop the tables.
CREATE TABLE IF NOT EXISTS public.chat_threads (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  created_by_adult_id text NOT NULL REFERENCES public.adult_users(id),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_threads_household_idx ON public.chat_threads (household_id, created_at);
CREATE INDEX IF NOT EXISTS chat_threads_holding_idx ON public.chat_threads (holding_id) WHERE holding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS chat_threads_adult_idx ON public.chat_threads (created_by_adult_id);

CREATE TABLE IF NOT EXISTS public.chat_turns (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  thread_id text NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  turn_index integer NOT NULL CHECK (turn_index >= 0),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  input_kind text NOT NULL DEFAULT 'text' CHECK (input_kind IN ('text', 'voice')),
  content_enc text NOT NULL CHECK (content_enc ~ '^enc2[.]'),
  transcript_enc text CHECK (transcript_enc IS NULL OR transcript_enc ~ '^enc2[.]'),
  audio_document_id text REFERENCES public.document_uploads(id) ON DELETE SET NULL,
  intent text CHECK (intent IS NULL OR intent ~ '^[a-z][a-z_]{1,39}$'),
  answer_source text CHECK (answer_source IS NULL OR answer_source IN ('model', 'deterministic')),
  provider text CHECK (provider IS NULL OR provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  model text CHECK (model IS NULL OR length(model) BETWEEN 1 AND 120),
  redacted_prompt_hash text CHECK (redacted_prompt_hash IS NULL OR redacted_prompt_hash ~ '^[0-9a-f]{64}$'),
  tokens_in integer NOT NULL DEFAULT 0 CHECK (tokens_in >= 0),
  tokens_out integer NOT NULL DEFAULT 0 CHECK (tokens_out >= 0),
  cost_paise integer NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  latency_ms integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
  created_at text NOT NULL,
  -- Voice fields belong to a voice turn of the user; the transcript is stored when there is a voice turn.
  CONSTRAINT chat_turns_voice_check CHECK (
    (input_kind = 'voice' AND role = 'user') OR (input_kind = 'text' AND transcript_enc IS NULL AND audio_document_id IS NULL)),
  -- Provider and answer summary belong to an assistant turn.
  CONSTRAINT chat_turns_assistant_check CHECK (
    role = 'assistant' OR (intent IS NULL AND answer_source IS NULL AND provider IS NULL AND model IS NULL AND redacted_prompt_hash IS NULL
      AND tokens_in = 0 AND tokens_out = 0 AND cost_paise = 0 AND latency_ms = 0))
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_turns_thread_order ON public.chat_turns (household_id, thread_id, turn_index);
CREATE INDEX IF NOT EXISTS chat_turns_thread_idx ON public.chat_turns (thread_id);
CREATE INDEX IF NOT EXISTS chat_turns_audio_idx ON public.chat_turns (audio_document_id) WHERE audio_document_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.retrieval_traces (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  thread_id text NOT NULL REFERENCES public.chat_threads(id) ON DELETE CASCADE,
  turn_id text NOT NULL REFERENCES public.chat_turns(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('vector', 'keyword', 'facts_only')),
  holding_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(holding_ids) <= 50),
  fact_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(fact_ids) <= 200),
  chunk_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(chunk_ids) <= 200),
  conflict_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(conflict_ids) <= 200),
  created_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS retrieval_traces_turn_idx ON public.retrieval_traces (household_id, turn_id);
CREATE INDEX IF NOT EXISTS retrieval_traces_thread_idx ON public.retrieval_traces (thread_id);

CREATE OR REPLACE FUNCTION public.chat_threads_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.holding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'chat thread must match a holding of its household';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.created_by_adult_id AND role.status = 'active'
  ) THEN
    RAISE EXCEPTION 'chat thread creator must be an active adult of the household';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS chat_threads_scope_insert ON public.chat_threads;
CREATE TRIGGER chat_threads_scope_insert BEFORE INSERT ON public.chat_threads FOR EACH ROW EXECUTE FUNCTION public.chat_threads_scope_fn();

CREATE OR REPLACE FUNCTION public.chat_turns_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.chat_threads AS thread WHERE thread.id = NEW.thread_id AND thread.household_id = NEW.household_id) THEN
    RAISE EXCEPTION 'chat turn must match a thread of its household';
  END IF;
  IF NEW.audio_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.audio_document_id AND document.household_id = NEW.household_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'chat turn audio must be an active document of its household';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS chat_turns_scope_insert ON public.chat_turns;
CREATE TRIGGER chat_turns_scope_insert BEFORE INSERT ON public.chat_turns FOR EACH ROW EXECUTE FUNCTION public.chat_turns_scope_fn();

CREATE OR REPLACE FUNCTION public.retrieval_traces_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chat_turns AS turn
    WHERE turn.id = NEW.turn_id AND turn.thread_id = NEW.thread_id AND turn.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'retrieval trace must match a turn of its household and thread';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS retrieval_traces_scope_insert ON public.retrieval_traces;
CREATE TRIGGER retrieval_traces_scope_insert BEFORE INSERT ON public.retrieval_traces FOR EACH ROW EXECUTE FUNCTION public.retrieval_traces_scope_fn();

-- Turns and traces are append-only; a thread only moves its updated_at.
CREATE OR REPLACE FUNCTION public.chat_append_only_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'chat turns and retrieval traces are append-only; erasure deletes them';
END;
$$;
-- The one allowed change of a turn: the audio reference is cleared when its document is erased (ON DELETE SET NULL).
CREATE OR REPLACE FUNCTION public.chat_turns_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.audio_document_id IS NOT NULL AND NEW.audio_document_id IS NULL
    AND (to_jsonb(NEW) - 'audio_document_id') = (to_jsonb(OLD) - 'audio_document_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'chat turns and retrieval traces are append-only; erasure deletes them';
END;
$$;
DROP TRIGGER IF EXISTS chat_turns_append_only ON public.chat_turns;
CREATE TRIGGER chat_turns_append_only BEFORE UPDATE ON public.chat_turns FOR EACH ROW EXECUTE FUNCTION public.chat_turns_immutable_fn();
DROP TRIGGER IF EXISTS retrieval_traces_append_only ON public.retrieval_traces;
CREATE TRIGGER retrieval_traces_append_only BEFORE UPDATE ON public.retrieval_traces FOR EACH ROW EXECUTE FUNCTION public.chat_append_only_fn();

ALTER TABLE public.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.retrieval_traces ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['chat_threads', 'chat_turns', 'retrieval_traces'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', table_name);
  END LOOP;
END
$$;
