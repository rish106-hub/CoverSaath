-- Reference-data cache and refresh lease for the future ReferenceDataPort (plan: insurance-data-api integration, run D3).
-- Expand-only: two new tables, nothing existing is altered.
--   reference_cache         one row per public reference-data key (insurer, product, version, facts). Holds PUBLIC data
--                           only. It has no household, case, member or consent column and must never get one.
--     key          lower-case ASCII path-like key, for example 'insurers/hdfc-ergo'. The shape check refuses spaces, '@' and
--                  anything that looks like a policy number or other household value.
--     etag         upstream ETag for conditional refresh (may be null).
--     signature    integrity signature of the body as delivered by the reference service; verified by the port, stored here.
--     fetched_at   database time of the last successful write.
--     stale_after  fetched_at plus the TTL (24 hours by default, set by the repository).
--     status       'fresh' or 'stale'. The port marks a copy 'stale' when a refresh fails, and serves it labelled as stale.
--   reference_cache_leases  expiring lease so only one process refreshes a key at a time (same pattern as evidence_claims,
--                           migration 032 on its branch). Expiry uses database time. Rows hold a key and a random owner token only.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
-- Rollback (manual, only if nothing depends on it): DROP TABLE public.reference_cache_leases; DROP TABLE public.reference_cache;
--   then DELETE FROM schema_migrations WHERE version = '033_reference_cache.sql'.
CREATE TABLE IF NOT EXISTS public.reference_cache (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200 AND key ~ '^[a-z0-9][a-z0-9._:/-]*$'),
  etag text CHECK (etag IS NULL OR length(etag) <= 256),
  body jsonb NOT NULL,
  signature text NOT NULL CHECK (length(signature) BETWEEN 1 AND 1024),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  stale_after timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'fresh' CHECK (status IN ('fresh', 'stale'))
);
CREATE INDEX IF NOT EXISTS reference_cache_stale_after_idx ON public.reference_cache (stale_after);

CREATE TABLE IF NOT EXISTS public.reference_cache_leases (
  key text PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 200 AND key ~ '^[a-z0-9][a-z0-9._:/-]*$'),
  owner text NOT NULL CHECK (length(owner) BETWEEN 16 AND 64),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS reference_cache_leases_expiry_idx ON public.reference_cache_leases (expires_at);

ALTER TABLE public.reference_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reference_cache_leases ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  table_name text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH table_name IN ARRAY ARRAY['reference_cache', 'reference_cache_leases'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', table_name, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
