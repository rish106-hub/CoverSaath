-- Provider call audit (ADR 0030). Expand-only and safe to run more than once: one table, one scope trigger, its lockdown.
-- provider_calls: one row per model-provider call attempt that reached the gateway (including refused, unavailable and failed ones).
-- It stores COUNTS and a digest, never the payload:
--   * redaction_report_json: gate counts only (gate version, gated slots, placeholders, reason-code count, gated bytes). No text,
--     no placeholder kinds, no values.
--   * payload_sha256: sha256 of the redacted outbound prompt, so a call can be matched to a stored run. NULL when no payload was built.
--   * tokens, cost_paise: usage as reported by the provider. household_id is NULL for a call with no household (a system task).
-- Rows are erased with the household (erasure repository) and are never updated: the table is append-only. A row holds no
-- personal data, but it is household-scoped usage history, so household erasure deletes it.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Rollback: expand-only. Revert the code and turn CHAT_MODEL_ENABLED off; a synthetic-only project may drop the table.
CREATE TABLE IF NOT EXISTS public.provider_calls (
  id text PRIMARY KEY,
  household_id text REFERENCES public.households(id),
  purpose text NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{1,63}$'),
  provider text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  model text NOT NULL CHECK (length(model) BETWEEN 1 AND 120),
  redaction_report_json text NOT NULL CHECK (length(redaction_report_json) <= 2000 AND redaction_report_json::jsonb IS NOT NULL),
  payload_sha256 text CHECK (payload_sha256 IS NULL OR payload_sha256 ~ '^[0-9a-f]{64}$'),
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost_paise integer NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  status text NOT NULL CHECK (status ~ '^[a-z][a-z0-9_]{1,63}$'),
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_calls_household_idx ON public.provider_calls (household_id, created_at);

-- Scope: a row that names a household must name an existing one (also enforced by the foreign key; the trigger gives a clear error).
CREATE OR REPLACE FUNCTION public.provider_calls_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.household_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.households WHERE id = NEW.household_id) THEN
    RAISE EXCEPTION 'provider call must name an existing household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS provider_calls_scope_insert ON public.provider_calls;
CREATE TRIGGER provider_calls_scope_insert
BEFORE INSERT ON public.provider_calls
FOR EACH ROW EXECUTE FUNCTION public.provider_calls_scope_insert_fn();

-- Append-only.
CREATE OR REPLACE FUNCTION public.provider_calls_append_only_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'provider calls are append-only; household erasure deletes them';
END;
$$;

DROP TRIGGER IF EXISTS provider_calls_append_only ON public.provider_calls;
CREATE TRIGGER provider_calls_append_only
BEFORE UPDATE ON public.provider_calls
FOR EACH ROW EXECUTE FUNCTION public.provider_calls_append_only_fn();

ALTER TABLE public.provider_calls ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.provider_calls FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
