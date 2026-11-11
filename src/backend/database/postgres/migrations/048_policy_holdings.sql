-- Holdings and memory, part 1: policy_holdings (ADR 0032, ADR 0023). Expand-only and safe to run more than once: one new table, its
-- triggers and its lockdown.
-- A holding is a THIN link: one policy a household holds, joined to the upload that evidences it and to the policy profile that
-- records what the owner reported about it. It stores NO insurer, plan, UIN or policy number. Those already live in policy_profiles
-- (043: UIN, insurer code, sealed names and their states) and policies (001: masked number, dates); a copy here could drift from them.
--   status  the holding's own lifecycle, plain closed enum. It is NOT a fact status: nothing here says a fact is confirmed.
--           uploaded -> insurer_pending -> product_reported -> parsed -> conflicts | ready
--           (product_reported = the owner stated the insurer and plan, written to policy_profiles in state reported, never proven)
-- Rules this table enforces itself:
--   * policy, document and profile must belong to the holding's household (scope trigger); a new holding needs an active document.
--   * one holding per upload (UNIQUE household_id, document_id).
--   * a holding is erased with its document (trigger below), with the household and on consent withdrawal (application erasure paths).
--     Memory facts and conflicts that point at it are deleted with it (ON DELETE CASCADE).
-- Nothing in this table is a sealed value: every column is an id, a closed enum or a timestamp.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- No TRUNCATE guard: runtime roles cannot TRUNCATE (same stance as 043 and 044).
-- Consent, privacy and notice wording around this store is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code and turn HOLDINGS_ENABLED off; a synthetic-only project may drop the table.
CREATE TABLE IF NOT EXISTS public.policy_holdings (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  policy_id text REFERENCES public.policies(id) ON DELETE SET NULL,
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  policy_profile_id text REFERENCES public.policy_profiles(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('retail_health', 'group_health', 'top_up', 'critical_illness', 'other')),
  status text NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'insurer_pending', 'product_reported', 'parsed', 'conflicts', 'ready')),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (household_id, document_id)
);

CREATE INDEX IF NOT EXISTS policy_holdings_household_status_idx ON public.policy_holdings (household_id, status);
CREATE INDEX IF NOT EXISTS policy_holdings_policy_idx ON public.policy_holdings (policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS policy_holdings_document_idx ON public.policy_holdings (document_id);
CREATE INDEX IF NOT EXISTS policy_holdings_profile_idx ON public.policy_holdings (policy_profile_id) WHERE policy_profile_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.policy_holdings_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.document_id AND document.household_id = NEW.household_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'policy holding must match an active document of its household';
  END IF;
  IF NEW.policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policies AS policy WHERE policy.id = NEW.policy_id AND policy.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'policy holding must match a policy of its household';
  END IF;
  IF NEW.policy_profile_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_profiles AS profile
    WHERE profile.id = NEW.policy_profile_id AND profile.household_id = NEW.household_id AND profile.document_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'policy holding must match a policy profile of its document and household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS policy_holdings_scope_insert ON public.policy_holdings;
CREATE TRIGGER policy_holdings_scope_insert
BEFORE INSERT ON public.policy_holdings
FOR EACH ROW EXECUTE FUNCTION public.policy_holdings_scope_fn();
DROP TRIGGER IF EXISTS policy_holdings_scope_update ON public.policy_holdings;
CREATE TRIGGER policy_holdings_scope_update
BEFORE UPDATE OF household_id, policy_id, document_id, policy_profile_id ON public.policy_holdings
FOR EACH ROW EXECUTE FUNCTION public.policy_holdings_scope_fn();

CREATE OR REPLACE FUNCTION public.policy_holdings_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.policy_holdings WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS policy_holdings_erase_on_document_erasure ON public.document_uploads;
CREATE TRIGGER policy_holdings_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.policy_holdings_erase_on_document_erasure_fn();

ALTER TABLE public.policy_holdings ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.policy_holdings FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.policy_holdings FROM PUBLIC;
END
$$;
