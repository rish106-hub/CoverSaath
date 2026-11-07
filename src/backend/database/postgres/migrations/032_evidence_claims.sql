-- Evidence-question claims as expiring database leases (ADR 0014 addendum, run B1). Expand-only: one new table.
-- Replaces the per-process claim set in the policy-evidence service, so two API machines cannot both run the same
-- (household, case, idempotency key) question and bill the model twice. A holder renews the lease while it works; a
-- crashed holder stops renewing and the lease expires, after which another process may take it.
--   claim_hash   SHA-256 digest of (household, case, idempotency key); the key itself is never stored. Plain SHA-256,
--                not an HMAC, so every process derives the same hash (see ADR 0014 addendum D8).
--   owner        random per-claim token, so only the holder can renew or release.
--   expires_at   database time, so machine clock skew does not matter.
-- Holds no household content; rows live at most one lease term past the work and are deleted on release or purged.
-- Row level security on with no policy; Data API roles hold nothing (see 016_data_api_lockdown.sql).
CREATE TABLE IF NOT EXISTS public.evidence_claims (
  claim_hash text PRIMARY KEY CHECK (claim_hash ~ '^[0-9a-f]{64}$'),
  owner text NOT NULL CHECK (length(owner) BETWEEN 16 AND 64),
  claimed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_claims_expiry_idx ON public.evidence_claims (expires_at);

ALTER TABLE public.evidence_claims ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.evidence_claims FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
