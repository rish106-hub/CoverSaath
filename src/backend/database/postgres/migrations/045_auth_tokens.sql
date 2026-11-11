-- Auth, part 1: revocable web sessions, JWT signing keys, rotating refresh tokens (ADR 0016). Expand-only and rerunnable:
-- new tables use IF NOT EXISTS, new columns use ADD COLUMN IF NOT EXISTS, constraints are added once inside DO blocks. The one
-- relaxation of an existing column is api_sessions.token_sha256 losing NOT NULL, because a web session has no opaque bearer
-- token (its credential is a JWT plus a refresh token); a CHECK keeps it required for session_kind = 'bearer'. Opaque bearer
-- sessions, their lookups and every current test behave exactly as before.
--   * The private signing key is never here (environment secret). auth_signing_keys holds the public JWK only.
--   * Refresh tokens and one-time codes are stored only as keyed HMAC hashes (key derived from the data encryption key).
--   * Typed text (device and passkey labels) is sealed: *_ciphertext, CHECK ~ '^enc[12][.]', AAD <table>.<column>.<id>.
--   * Every table: row level security on, no policy, no Data API grant (016 pattern, DO block at the end).
--   * Erasure: api_sessions.household_id cascades from households, auth_refresh_tokens from api_sessions, and webauthn_credentials,
--     devices and notice_acceptances from adult_users. A household erase therefore removes its web sessions and refresh tokens.
-- auth_challenges, webauthn_credentials, devices and notice_acceptances are created now so the shape is fixed; challenge,
-- passkey and device routes are not built yet. Notice wording and consent purposes are draft and need legal review.

CREATE TABLE IF NOT EXISTS public.auth_signing_keys (
  kid text PRIMARY KEY CHECK (kid ~ '^[A-Za-z0-9_-]{8,64}$'),
  alg text NOT NULL DEFAULT 'EdDSA' CHECK (alg = 'EdDSA'),
  public_jwk text NOT NULL CHECK (public_jwk IS JSON),
  status text NOT NULL CHECK (status IN ('next', 'active', 'retiring', 'revoked')),
  created_at text NOT NULL,
  activated_at text,
  retire_after text,
  revoked_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_signing_keys_one_active ON public.auth_signing_keys ((status)) WHERE status = 'active';

ALTER TABLE public.api_sessions ALTER COLUMN token_sha256 DROP NOT NULL;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS session_kind text NOT NULL DEFAULT 'bearer'
  CHECK (session_kind IN ('bearer', 'web', 'demo'));
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS household_id text REFERENCES public.households (id) ON DELETE CASCADE;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS auth_identity_id text REFERENCES public.auth_identities (id) ON DELETE SET NULL;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS amr text
  CHECK (amr IS NULL OR amr IN ('beta', 'google', 'apple', 'email_otp', 'phone_otp', 'passkey', 'demo'));
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS absolute_expires_at text;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS user_agent_hash text;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS ip_prefix_hash text;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS revoked_reason text
  CHECK (revoked_reason IS NULL OR revoked_reason IN ('sign_out', 'sign_out_all', 'refresh_reuse', 'admin', 'expired_demo', 'identity_revoked', 'session_limit'));

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.api_sessions'::regclass AND conname = 'api_sessions_kind_shape_check') THEN
    ALTER TABLE public.api_sessions ADD CONSTRAINT api_sessions_kind_shape_check CHECK (
      (session_kind <> 'bearer' OR token_sha256 IS NOT NULL)
      AND (session_kind = 'bearer' OR (household_id IS NOT NULL AND absolute_expires_at IS NOT NULL))
      AND (revoked_reason IS NULL OR revoked_at IS NOT NULL));
  END IF;
END
$$;
CREATE INDEX IF NOT EXISTS api_sessions_household_idx ON public.api_sessions (household_id) WHERE household_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS api_sessions_identity_idx ON public.api_sessions (auth_identity_id) WHERE auth_identity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.auth_refresh_tokens (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES public.api_sessions (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  parent_id text REFERENCES public.auth_refresh_tokens (id) ON DELETE SET NULL,
  issued_at text NOT NULL,
  expires_at text NOT NULL,
  used_at text,
  CHECK (julianday(expires_at) > julianday(issued_at))
);
CREATE INDEX IF NOT EXISTS auth_refresh_session_idx ON public.auth_refresh_tokens (session_id);
CREATE INDEX IF NOT EXISTS auth_refresh_expiry_idx ON public.auth_refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS public.auth_challenges (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email_otp', 'phone_otp', 'magic_link', 'oidc_state')),
  destination_hash text CHECK (destination_hash IS NULL OR destination_hash ~ '^[0-9a-f]{64}$'),
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text CHECK (nonce_hash IS NULL OR nonce_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  ip_prefix_hash text,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  consumed_at text,
  CHECK (julianday(expires_at) > julianday(created_at))
);
CREATE INDEX IF NOT EXISTS auth_challenges_dest_idx ON public.auth_challenges (destination_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON public.auth_challenges (expires_at);

ALTER TABLE public.auth_identities ADD COLUMN IF NOT EXISTS provider text
  CHECK (provider IS NULL OR provider IN ('beta', 'google', 'apple', 'email', 'phone', 'passkey'));
ALTER TABLE public.auth_identities ADD COLUMN IF NOT EXISTS linked_via_session_id text REFERENCES public.api_sessions (id) ON DELETE SET NULL;
ALTER TABLE public.auth_identities ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.webauthn_credentials (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES public.adult_users (id) ON DELETE CASCADE,
  credential_id text NOT NULL UNIQUE,
  public_key text NOT NULL,
  sign_count bigint NOT NULL DEFAULT 0 CHECK (sign_count >= 0),
  transports text,
  label_ciphertext text CHECK (label_ciphertext IS NULL OR label_ciphertext ~ '^enc[12][.]'),
  created_at text NOT NULL,
  last_used_at text,
  revoked_at text
);
CREATE INDEX IF NOT EXISTS webauthn_credentials_adult_idx ON public.webauthn_credentials (adult_user_id);

CREATE TABLE IF NOT EXISTS public.devices (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES public.adult_users (id) ON DELETE CASCADE,
  label_ciphertext text CHECK (label_ciphertext IS NULL OR label_ciphertext ~ '^enc[12][.]'),
  platform text CHECK (platform IS NULL OR platform IN ('web', 'ios', 'android')),
  first_seen_at text NOT NULL,
  last_seen_at text NOT NULL,
  revoked_at text
);
CREATE INDEX IF NOT EXISTS devices_adult_idx ON public.devices (adult_user_id);

CREATE TABLE IF NOT EXISTS public.notice_acceptances (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES public.adult_users (id) ON DELETE CASCADE,
  notice_kind text NOT NULL CHECK (notice_kind IN ('privacy', 'terms', 'health_data', 'children_data', 'location')),
  notice_version text NOT NULL CHECK (notice_version ~ '^[A-Za-z0-9_.-]{1,40}$'),
  accepted_at text NOT NULL,
  surface text NOT NULL CHECK (surface IN ('signup', 'onboarding', 'settings', 'family', 'emergency', 'other')),
  withdrawn_at text,
  UNIQUE (adult_user_id, notice_kind, notice_version)
);

ALTER TABLE public.auth_signing_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webauthn_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notice_acceptances ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
  tbl text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      FOREACH tbl IN ARRAY ARRAY['auth_signing_keys', 'auth_refresh_tokens', 'auth_challenges', 'webauthn_credentials', 'devices', 'notice_acceptances'] LOOP
        EXECUTE format('REVOKE ALL ON TABLE public.%I FROM %I', tbl, api_role);
      END LOOP;
    END IF;
  END LOOP;
END
$$;
