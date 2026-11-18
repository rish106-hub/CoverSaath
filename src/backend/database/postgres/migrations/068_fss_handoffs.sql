-- FSS handoff (ADR 0037, contract docs/contracts/fss-handoff-v1.md). Expand-only and safe to run more than once: two new tables, their
-- lockdown and nothing else. No existing table, column, trigger or row changes.
--   fss_handoffs       one row per task CoverSaath handed to FSS for a holding: the opaque request id, the FSS handoff id, the state and the
--                      attempt count. Never the insurer name, product name or UIN (the sender reads those from the holding when it sends).
--   holding_fss_links  the mapping from a holding to the FSS product and version it matched: ids, how it matched and a confidence code.
-- Every column is an id, a closed enum, a counter or a timestamp. Nothing here is a sealed value and nothing is searched in SQL by content.
-- Erasure: both tables go with their holding (ON DELETE CASCADE), and the holding goes with its document, the document consent and the
-- household (memory-erasure.js). A signed notice for a request id that no longer exists is dropped by the receiver.
-- At most one open handoff per holding (partial unique index). 'queued' is local (not yet sent); 'failed' is local (three sends failed).
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Consent, privacy and notice wording around this store is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code; a synthetic-only project may drop both tables. Nothing else reads them.
CREATE TABLE IF NOT EXISTS public.fss_handoffs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text NOT NULL REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  request_id text NOT NULL UNIQUE CHECK (request_id ~ '^[A-Za-z0-9_-]{8,64}$'),
  fss_handoff_id text CHECK (fss_handoff_id IS NULL OR fss_handoff_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  fss_version_id text CHECK (fss_version_id IS NULL OR fss_version_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN (
    'queued', 'accepted', 'working', 'matched', 'no_match', 'needs_review', 'unavailable', 'rights_blocked', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  last_outcome text CHECK (last_outcome IS NULL OR last_outcome ~ '^[a-z][a-z0-9_]{1,59}$'),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  decided_at text,
  CHECK (fss_version_id IS NULL OR state = 'matched'),
  CHECK (decided_at IS NULL OR state IN ('matched', 'no_match', 'needs_review', 'unavailable', 'rights_blocked', 'failed'))
);

CREATE INDEX IF NOT EXISTS fss_handoffs_household_idx ON public.fss_handoffs (household_id, holding_id);
CREATE UNIQUE INDEX IF NOT EXISTS fss_handoffs_one_open_per_holding
  ON public.fss_handoffs (holding_id) WHERE state IN ('queued', 'accepted', 'working');
CREATE INDEX IF NOT EXISTS fss_handoffs_open_poll_idx
  ON public.fss_handoffs (updated_at) WHERE state IN ('accepted', 'working');

CREATE TABLE IF NOT EXISTS public.holding_fss_links (
  holding_id text PRIMARY KEY REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES public.households(id),
  fss_product_id text NOT NULL CHECK (fss_product_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  fss_version_id text CHECK (fss_version_id IS NULL OR fss_version_id ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  matched_by text NOT NULL CHECK (matched_by IN ('alias', 'uin', 'manual')),
  confidence text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  matched_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS holding_fss_links_household_idx ON public.holding_fss_links (household_id);

-- holding and household must agree on both tables.
CREATE OR REPLACE FUNCTION public.fss_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id) THEN
    RAISE EXCEPTION 'fss row must name a holding of its household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fss_handoffs_scope_insert ON public.fss_handoffs;
CREATE TRIGGER fss_handoffs_scope_insert BEFORE INSERT ON public.fss_handoffs FOR EACH ROW EXECUTE FUNCTION public.fss_scope_fn();
DROP TRIGGER IF EXISTS holding_fss_links_scope_insert ON public.holding_fss_links;
CREATE TRIGGER holding_fss_links_scope_insert BEFORE INSERT ON public.holding_fss_links FOR EACH ROW EXECUTE FUNCTION public.fss_scope_fn();

ALTER TABLE public.fss_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.holding_fss_links ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['fss_handoffs', 'holding_fss_links'] LOOP
    FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', tbl, api_role);
      END IF;
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', tbl);
  END LOOP;
END
$$;
