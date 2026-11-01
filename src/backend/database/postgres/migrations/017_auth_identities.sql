-- Sign-in identities (ADR 0012 D3, run V1a). Expand-only: one new table, no change to an existing table.
-- An identity is the pair (issuer, subject) from an allow-listed sign-in provider. The subject is stored only as
-- sha256(issuer || LF || subject), never raw, and nothing here is ever looked up by e-mail. A row maps to exactly one
-- adult; revoked_at set means the identity can no longer start a session.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
CREATE TABLE public.auth_identities (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES public.adult_users(id),
  issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 200),
  subject_sha256 text NOT NULL CHECK (length(subject_sha256) = 64),
  created_at text NOT NULL,
  last_used_at text,
  revoked_at text,
  UNIQUE (issuer, subject_sha256),
  CHECK (subject_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK (revoked_at IS NULL OR julianday(revoked_at) >= julianday(created_at))
);

CREATE INDEX auth_identities_adult_idx ON public.auth_identities (adult_user_id);

ALTER TABLE public.auth_identities ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.auth_identities FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
