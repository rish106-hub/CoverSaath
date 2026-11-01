-- Shared runtime limits (ADR 0014, run backend-ops). Expand-only: three new tables, no change to an existing one.
-- Lets more than one API machine share one request rate limit and one model spend cap, and lets the spend cap survive a
-- restart (the in-memory budget forgets what was spent). The in-memory limiter and budget stay as the default and fallback.
--   rate_limit_buckets          fixed one-window counters keyed by a keyed hash of the client address (never the address).
--   model_budget_scopes         one row per spend scope with reserved and spent micro-USD (integers, no float drift).
--   model_budget_reservations   one row per reservation: reserved, then settled (actual cost) or released (never dispatched).
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  key_hash text NOT NULL CHECK (key_hash ~ '^[0-9a-f]{32}$'),
  window_start bigint NOT NULL CHECK (window_start >= 0),
  request_count integer NOT NULL CHECK (request_count >= 0),
  PRIMARY KEY (key_hash, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window_idx ON public.rate_limit_buckets (window_start);

CREATE TABLE IF NOT EXISTS public.model_budget_scopes (
  scope text PRIMARY KEY CHECK (scope ~ '^[a-z0-9_.-]{1,64}$'),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.model_budget_reservations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 64),
  scope text NOT NULL REFERENCES public.model_budget_scopes (scope),
  amount_micro_usd bigint NOT NULL CHECK (amount_micro_usd >= 0),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'settled', 'released')),
  actual_micro_usd bigint CHECK (actual_micro_usd IS NULL OR actual_micro_usd >= 0),
  task text CHECK (task IS NULL OR task ~ '^[A-Za-z0-9_.-]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK ((state = 'settled') = (actual_micro_usd IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS model_budget_reservations_scope_idx ON public.model_budget_reservations (scope, state);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_budget_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.model_budget_reservations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  table_name text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH table_name IN ARRAY ARRAY['rate_limit_buckets', 'model_budget_scopes', 'model_budget_reservations'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
