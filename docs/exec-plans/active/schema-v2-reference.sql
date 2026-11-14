-- SCHEMA V2 REFERENCE (design only, 2026-11-03). NOT a migration and never run as one.
-- Companion to docs/exec-plans/active/full-system-design.md. Each "-- 0NN" block becomes one append-only, expand-only,
-- rerunnable migration after 029, built and reviewed separately. Conventions copied from 017 and 026:
--   * ids and timestamps are text (ISO-8601 UTC), like the rest of the schema;
--   * sealed columns end in _ciphertext, carry CHECK (~ '^enc[12][.]') and are bound by AAD <table>.<column>.<row id>;
--   * *_hash columns are keyed HMAC (key derived from the data key), never plain sha256 of low-entropy input;
--   * every table: RLS on, no policy, no Data API grant (016 pattern: DO block at the end of each migration);
--   * every table with a household_id cascades from households so household erasure is one DELETE;
--   * `revision` is bumped only by the touch_revision trigger, so optimistic concurrency cannot be skipped.
-- Synthetic data only. Wording and consent purposes need legal review.

-- ===================================================================================================================
-- 030 AUTH: signing keys, refresh tokens, challenges, devices, passkeys, notice acceptance
-- ===================================================================================================================

-- Public half of every JWT signing key. The private key is a Fly secret (KNOWVIA_JWT_PRIVATE_KEY_<kid>), never in the database.
CREATE TABLE IF NOT EXISTS public.auth_signing_keys (
  kid text PRIMARY KEY CHECK (kid ~ '^[A-Za-z0-9_-]{8,64}$'),
  alg text NOT NULL DEFAULT 'EdDSA' CHECK (alg = 'EdDSA'),
  public_jwk text NOT NULL CHECK (public_jwk IS JSON),
  status text NOT NULL CHECK (status IN ('next', 'active', 'retiring', 'revoked')),
  created_at text NOT NULL,
  activated_at text,
  retire_after text,                 -- last moment a token signed with this key can still be valid (activated + 15 min)
  revoked_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS auth_signing_keys_one_active ON public.auth_signing_keys ((status)) WHERE status = 'active';

-- api_sessions (001) is the revocable session row; a JWT carries its id as `sid`. Add what a browser session needs.
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS session_kind text NOT NULL DEFAULT 'bearer'
  CHECK (session_kind IN ('bearer', 'web', 'demo'));            -- 'bearer' = today's opaque token (scripts, tests)
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS household_id text REFERENCES public.households (id) ON DELETE CASCADE;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS device_id text;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS amr text CHECK (amr IS NULL OR amr IN ('beta', 'google', 'apple', 'email_otp', 'phone_otp', 'passkey', 'demo'));
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS absolute_expires_at text;   -- refresh chain cannot outlive this (90 days)
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS user_agent_hash text;
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS ip_prefix_hash text;        -- /24 or /48, keyed hash, for anomaly review only
ALTER TABLE public.api_sessions ADD COLUMN IF NOT EXISTS revoked_reason text
  CHECK (revoked_reason IS NULL OR revoked_reason IN ('sign_out', 'sign_out_all', 'refresh_reuse', 'admin', 'expired_demo', 'identity_revoked'));

-- Rotating refresh tokens. Opaque 256-bit values, stored as keyed hash. One live token per session; presenting a used one
-- (reuse) revokes the whole session and writes a `refresh_reuse` audit event.
CREATE TABLE IF NOT EXISTS public.auth_refresh_tokens (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES public.api_sessions (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  parent_id text REFERENCES public.auth_refresh_tokens (id) ON DELETE SET NULL,
  issued_at text NOT NULL,
  expires_at text NOT NULL,          -- 30 days sliding, capped by api_sessions.absolute_expires_at
  used_at text,                      -- set on rotation; a second use is reuse
  CHECK (julianday(expires_at) > julianday(issued_at))
);
CREATE INDEX IF NOT EXISTS auth_refresh_session_idx ON public.auth_refresh_tokens (session_id);

-- One-time codes and magic links. The code is never stored: only its keyed hash, bound to the destination hash.
CREATE TABLE IF NOT EXISTS public.auth_challenges (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('email_otp', 'phone_otp', 'magic_link', 'oidc_state')),
  destination_hash text,             -- HMAC(normalised e-mail or E.164); NULL for oidc_state
  code_hash text NOT NULL CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text,                   -- oidc_state: bound nonce; PKCE verifier lives in the sealed BFF cookie, not here
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 10),
  ip_prefix_hash text,
  created_at text NOT NULL,
  expires_at text NOT NULL,          -- 10 minutes (oidc_state 5 minutes)
  consumed_at text,
  CHECK (julianday(expires_at) > julianday(created_at))
);
CREATE INDEX IF NOT EXISTS auth_challenges_dest_idx ON public.auth_challenges (destination_hash, created_at);
CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON public.auth_challenges (expires_at);

-- Identities (017) gain a provider label and linking provenance. Still keyed by (issuer, subject hash), never by e-mail.
ALTER TABLE public.auth_identities ADD COLUMN IF NOT EXISTS provider text
  CHECK (provider IS NULL OR provider IN ('beta', 'google', 'apple', 'email', 'phone', 'passkey'));
ALTER TABLE public.auth_identities ADD COLUMN IF NOT EXISTS linked_via_session_id text REFERENCES public.api_sessions (id) ON DELETE SET NULL;
ALTER TABLE public.auth_identities ADD COLUMN IF NOT EXISTS email_verified boolean NOT NULL DEFAULT false;

-- Passkeys (WebAuthn). Public key only; no secret exists server-side. Built later; table fixed now.
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

-- Browsers/devices a person signed in from (list, rename, revoke in Settings). Label is typed text, so sealed.
CREATE TABLE IF NOT EXISTS public.devices (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES public.adult_users (id) ON DELETE CASCADE,
  label_ciphertext text CHECK (label_ciphertext IS NULL OR label_ciphertext ~ '^enc[12][.]'),
  platform text CHECK (platform IS NULL OR platform IN ('web', 'ios', 'android')),
  first_seen_at text NOT NULL,
  last_seen_at text NOT NULL,
  revoked_at text
);

-- Notice and consent-to-terms acceptance at sign-up and on every version change. Wording is not final (legal review).
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

-- ===================================================================================================================
-- 031 SYNC: revision trigger, change log, mutation dedupe
-- ===================================================================================================================

CREATE OR REPLACE FUNCTION public.touch_revision_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  RETURN NEW;
END;
$$;

-- Append-only log of "this row changed". No values: only entity, id, revision, op. Written by a trigger so no code path
-- (route, script, backfill) can change synced data without leaving a cursor entry.
CREATE TABLE IF NOT EXISTS public.household_changes (
  seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  entity text NOT NULL CHECK (entity ~ '^[a-z_]{1,40}$'),
  entity_id text NOT NULL,
  op text NOT NULL CHECK (op IN ('upsert', 'delete')),
  revision integer NOT NULL,
  actor_adult_id text,
  at text NOT NULL
);
CREATE INDEX IF NOT EXISTS household_changes_cursor_idx ON public.household_changes (household_id, seq);
CREATE INDEX IF NOT EXISTS household_changes_trim_idx ON public.household_changes (at);   -- purge older than 30 days

-- Low-water mark per household: a client cursor below it gets 410 CURSOR_EXPIRED and must take a snapshot.
CREATE TABLE IF NOT EXISTS public.household_sync_state (
  household_id text PRIMARY KEY REFERENCES public.households (id) ON DELETE CASCADE,
  min_seq bigint NOT NULL DEFAULT 0,
  updated_at text NOT NULL
);

CREATE OR REPLACE FUNCTION public.log_household_change_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
DECLARE
  hid text; eid text; rev integer; operation text;
BEGIN
  IF TG_OP = 'DELETE' THEN hid := OLD.household_id; eid := OLD.id; rev := COALESCE(OLD.revision, 0) + 1; operation := 'delete';
  ELSE hid := NEW.household_id; eid := NEW.id; rev := COALESCE(NEW.revision, 1); operation := 'upsert'; END IF;
  INSERT INTO public.household_changes (household_id, entity, entity_id, op, revision, actor_adult_id, at)
  VALUES (hid, TG_ARGV[0], eid, operation, rev, NULLIF(current_setting('knowvia.actor', true), ''),
          to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  RETURN NULL;
END;
$$;
-- Attached (AFTER INSERT OR UPDATE OR DELETE ... EXECUTE FUNCTION log_household_change_fn('<entity>')) to: household_members,
-- household_places, adult_preferences, onboarding_progress, tool_scenarios, device_permissions, person_records, policies,
-- policy_terms, household_dates, reminders, premium_payments, premium_dues, claims, service_cases, case_messages,
-- household_invites, document_uploads. The route sets `SET LOCAL knowvia.actor = <adult id>` in the same transaction.
-- BEFORE UPDATE touch_revision_fn is attached to every synced table that has a revision column.

-- Push idempotency reuses idempotency_keys (001): scope = 'sync:<adult id>', key = client mutation id, digest = body hash.

-- ===================================================================================================================
-- 032 PEOPLE: sealed record store + member contact columns
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.person_records (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  subject_member_id text REFERENCES public.household_members (id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN (
    'self_profile', 'health_context', 'nominee', 'emergency_contact', 'advisor', 'member_note', 'out_of_pocket_spend')),
  slot text NOT NULL DEFAULT 'main' CHECK (slot ~ '^[A-Za-z0-9_.-]{1,40}$'),
  payload_ciphertext text NOT NULL CHECK (payload_ciphertext ~ '^enc[12][.]' AND length(payload_ciphertext) <= 16384),
  schema_version integer NOT NULL DEFAULT 1,
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('empty', 'partial', 'complete')),
  source text NOT NULL CHECK (source IN ('user_typed', 'voice', 'document', 'digilocker', 'import')),
  state text NOT NULL DEFAULT 'user_stated' CHECK (state IN ('user_stated', 'extracted_unverified', 'conflicting', 'confirmed_by_user')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text                                            -- tombstone for sync; erasure physically deletes
);
CREATE UNIQUE INDEX IF NOT EXISTS person_records_unique ON public.person_records (household_id, COALESCE(subject_member_id, ''), record_type, slot);

ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS gender text CHECK (gender IS NULL OR gender IN ('female', 'male', 'other', 'undisclosed'));
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS age_band text CHECK (age_band IS NULL OR age_band IN ('0-5', '6-12', '13-17', '18-30', '31-45', '46-60', '61+'));
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS mobile_ciphertext text CHECK (mobile_ciphertext IS NULL OR mobile_ciphertext ~ '^enc[12][.]');
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS mobile_hash text CHECK (mobile_hash IS NULL OR mobile_hash ~ '^[0-9a-f]{64}$');
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS email_ciphertext text CHECK (email_ciphertext IS NULL OR email_ciphertext ~ '^enc[12][.]');
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS preferred_channel text CHECK (preferred_channel IS NULL OR preferred_channel IN ('whatsapp', 'sms', 'email'));
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS lives_with_household boolean;
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS dependent_on_member_id text REFERENCES public.household_members (id) ON DELETE SET NULL;
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS guardian_member_id text REFERENCES public.household_members (id) ON DELETE SET NULL;
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);
ALTER TABLE public.household_members ADD COLUMN IF NOT EXISTS deleted_at text;
CREATE UNIQUE INDEX IF NOT EXISTS household_members_mobile_unique ON public.household_members (household_id, mobile_hash) WHERE mobile_hash IS NOT NULL AND deleted_at IS NULL;

-- ===================================================================================================================
-- 033 POLICIES: terms entered by hand or read from a document (1:1 with policies)
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.policy_terms (
  id text PRIMARY KEY,
  policy_id text NOT NULL UNIQUE REFERENCES public.policies (id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  insurer_name_ciphertext text CHECK (insurer_name_ciphertext IS NULL OR insurer_name_ciphertext ~ '^enc[12][.]'),  -- when insurer_id is null ("other")
  product_name_ciphertext text CHECK (product_name_ciphertext IS NULL OR product_name_ciphertext ~ '^enc[12][.]'),
  policy_number_ciphertext text CHECK (policy_number_ciphertext IS NULL OR policy_number_ciphertext ~ '^enc[12][.]'),
  proposer_member_id text REFERENCES public.household_members (id) ON DELETE SET NULL,
  renewal_on text,
  sum_insured_minor bigint CHECK (sum_insured_minor IS NULL OR sum_insured_minor BETWEEN 0 AND 100000000000),
  premium_minor bigint CHECK (premium_minor IS NULL OR premium_minor BETWEEN 0 AND 100000000000),
  premium_frequency text CHECK (premium_frequency IS NULL OR premium_frequency IN ('monthly', 'quarterly', 'half_yearly', 'annual', 'single')),
  deductible_minor bigint CHECK (deductible_minor IS NULL OR deductible_minor >= 0),
  copay_pct integer CHECK (copay_pct IS NULL OR copay_pct BETWEEN 0 AND 100),
  room_rent_cap_minor bigint CHECK (room_rent_cap_minor IS NULL OR room_rent_cap_minor >= 0),
  no_claim_bonus_pct integer CHECK (no_claim_bonus_pct IS NULL OR no_claim_bonus_pct BETWEEN 0 AND 500),
  waiting_months_initial integer CHECK (waiting_months_initial IS NULL OR waiting_months_initial BETWEEN 0 AND 120),
  waiting_months_ped integer CHECK (waiting_months_ped IS NULL OR waiting_months_ped BETWEEN 0 AND 120),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  details_ciphertext text CHECK (details_ciphertext IS NULL OR (details_ciphertext ~ '^enc[12][.]' AND length(details_ciphertext) <= 16384)),
                                                              -- riders, specific waiting periods, TPA, helpline, advisor, employer, notes
  source text NOT NULL CHECK (source IN ('user_typed', 'voice', 'document', 'digilocker', 'import')),
  state text NOT NULL DEFAULT 'user_stated' CHECK (state IN ('user_stated', 'extracted_unverified', 'conflicting', 'confirmed_by_user')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
-- Amounts and percentages stay plain on purpose: deterministic compare, gap and stress code reads them. They are not
-- identifiers. Decision D10 in the design doc: seal them too and compute in the application only (costs SQL range checks).
ALTER TABLE public.policy_members ADD COLUMN IF NOT EXISTS member_reference_ciphertext text CHECK (member_reference_ciphertext IS NULL OR member_reference_ciphertext ~ '^enc[12][.]');

-- ===================================================================================================================
-- 034 DATES AND REMINDERS
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.household_dates (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  policy_id text REFERENCES public.policies (id) ON DELETE CASCADE,
  member_id text REFERENCES public.household_members (id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('renewal', 'premium_due', 'tax_proof', 'cover_ends', 'waiting_period_ends', 'checkup', 'custom')),
  due_on text NOT NULL CHECK (due_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  title_ciphertext text CHECK (title_ciphertext IS NULL OR title_ciphertext ~ '^enc[12][.]'),
  source text NOT NULL CHECK (source IN ('user_typed', 'voice', 'document', 'system')),
  status text NOT NULL DEFAULT 'upcoming' CHECK (status IN ('upcoming', 'done', 'dismissed')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS household_dates_due_idx ON public.household_dates (household_id, due_on) WHERE status = 'upcoming';

CREATE TABLE IF NOT EXISTS public.reminders (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  date_id text NOT NULL REFERENCES public.household_dates (id) ON DELETE CASCADE,
  lead_days integer NOT NULL CHECK (lead_days IN (0, 1, 7, 15, 30)),
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'whatsapp', 'sms')),
  remind_at text NOT NULL,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'queued', 'sent', 'cancelled', 'failed')),
  outbox_id text REFERENCES public.integration_outbox (id) ON DELETE SET NULL,
  consent_grant_id text REFERENCES public.consent_grants (id),     -- required for whatsapp, sms, email; null for in_app
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at text NOT NULL,
  CHECK (channel = 'in_app' OR consent_grant_id IS NOT NULL),
  UNIQUE (date_id, lead_days, channel)
);

-- ===================================================================================================================
-- 035 MONEY
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.premium_payments (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  policy_id text REFERENCES public.policies (id) ON DELETE SET NULL,
  payer_member_id text REFERENCES public.household_members (id) ON DELETE SET NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor BETWEEN 0 AND 100000000000),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  paid_on text NOT NULL CHECK (paid_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  method text NOT NULL DEFAULT 'unknown' CHECK (method IN ('card', 'upi', 'netbanking', 'payroll', 'cheque', 'cash', 'unknown')),
  tax_section text CHECK (tax_section IS NULL OR tax_section IN ('80D', '80C', 'none')),
  source text NOT NULL CHECK (source IN ('user_typed', 'voice', 'document', 'email', 'import')),
  source_ref_hash text CHECK (source_ref_hash IS NULL OR source_ref_hash ~ '^[0-9a-f]{64}$'),   -- dedupe the same receipt
  receipt_document_id text REFERENCES public.document_uploads (id) ON DELETE SET NULL,
  note_ciphertext text CHECK (note_ciphertext IS NULL OR note_ciphertext ~ '^enc[12][.]'),
  match_state text NOT NULL DEFAULT 'unmatched' CHECK (match_state IN ('unmatched', 'matched', 'duplicate')),
  matched_due_id text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS premium_payments_ref_unique ON public.premium_payments (household_id, source_ref_hash) WHERE source_ref_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS premium_payments_household_idx ON public.premium_payments (household_id, paid_on);

CREATE TABLE IF NOT EXISTS public.premium_dues (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  policy_id text NOT NULL REFERENCES public.policies (id) ON DELETE CASCADE,
  due_on text NOT NULL CHECK (due_on ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  state text NOT NULL DEFAULT 'expected' CHECK (state IN ('expected', 'paid', 'overdue')),
  derived boolean NOT NULL DEFAULT true,                      -- false once the person edited it
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at text NOT NULL,
  UNIQUE (policy_id, due_on)
);
ALTER TABLE public.premium_payments ADD CONSTRAINT premium_payments_due_fk FOREIGN KEY (matched_due_id) REFERENCES public.premium_dues (id) ON DELETE SET NULL;

-- ===================================================================================================================
-- 036 CLAIMS
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.claims (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  policy_id text REFERENCES public.policies (id) ON DELETE SET NULL,
  member_id text NOT NULL REFERENCES public.household_members (id) ON DELETE CASCADE,
  service_case_id text REFERENCES public.service_cases (id) ON DELETE SET NULL,
  hospital_ciphertext text CHECK (hospital_ciphertext IS NULL OR hospital_ciphertext ~ '^enc[12][.]'),
  reason_ciphertext text CHECK (reason_ciphertext IS NULL OR reason_ciphertext ~ '^enc[12][.]'),
  claim_ref_ciphertext text CHECK (claim_ref_ciphertext IS NULL OR claim_ref_ciphertext ~ '^enc[12][.]'),
  admitted_on text,
  discharged_on text,
  billed_minor bigint CHECK (billed_minor IS NULL OR billed_minor >= 0),
  approved_minor bigint CHECK (approved_minor IS NULL OR approved_minor >= 0),
  paid_minor bigint CHECK (paid_minor IS NULL OR paid_minor >= 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'filed', 'pre_auth', 'approved', 'short_settled', 'settled', 'rejected')),
  settlement_document_id text REFERENCES public.document_uploads (id) ON DELETE SET NULL,
  note_ciphertext text CHECK (note_ciphertext IS NULL OR note_ciphertext ~ '^enc[12][.]'),
  source text NOT NULL CHECK (source IN ('user_typed', 'voice', 'document', 'import')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CHECK (discharged_on IS NULL OR admitted_on IS NULL OR discharged_on >= admitted_on)
);

-- ===================================================================================================================
-- 037 DESK: counterparty, steps, messages
-- ===================================================================================================================

ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS desk_kind text
  CHECK (desk_kind IS NULL OR desk_kind IN ('claim_dispute', 'refund', 'pre_auth', 'document_request', 'renewal', 'general'));
ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS escalation_level integer NOT NULL DEFAULT 0 CHECK (escalation_level BETWEEN 0 AND 3);
ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS counterparty_kind text CHECK (counterparty_kind IS NULL OR counterparty_kind IN ('insurer', 'tpa', 'hospital'));
ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS counterparty_ciphertext text CHECK (counterparty_ciphertext IS NULL OR counterparty_ciphertext ~ '^enc[12][.]');
ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS next_update_on text;
ALTER TABLE public.service_cases ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1);

CREATE TABLE IF NOT EXISTS public.case_messages (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  case_id text NOT NULL REFERENCES public.service_cases (id) ON DELETE CASCADE,
  author_kind text NOT NULL CHECK (author_kind IN ('user', 'knowvia', 'insurer', 'tpa', 'hospital')),
  author_adult_id text REFERENCES public.adult_users (id) ON DELETE SET NULL,
  channel text NOT NULL CHECK (channel IN ('in_app', 'email', 'phone_note')),
  body_ciphertext text NOT NULL CHECK (body_ciphertext ~ '^enc[12][.]' AND length(body_ciphertext) <= 16384),
  document_id text REFERENCES public.document_uploads (id) ON DELETE SET NULL,
  sent_at text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS case_messages_case_idx ON public.case_messages (case_id, sent_at);

CREATE TABLE IF NOT EXISTS public.case_steps (
  case_id text NOT NULL REFERENCES public.service_cases (id) ON DELETE CASCADE,
  step text NOT NULL CHECK (step IN ('raised', 'with_tpa', 'awaiting_documents', 'decision', 'resolved')),
  state text NOT NULL CHECK (state IN ('pending', 'active', 'done')),
  at text,
  PRIMARY KEY (case_id, step)
);

-- ===================================================================================================================
-- 038 INVITES
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.household_invites (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  member_id text NOT NULL REFERENCES public.household_members (id) ON DELETE CASCADE,
  invited_by_adult_id text NOT NULL REFERENCES public.adult_users (id),
  accepted_adult_id text REFERENCES public.adult_users (id),
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'sms', 'email')),
  destination_ciphertext text NOT NULL CHECK (destination_ciphertext ~ '^enc[12][.]'),
  destination_hash text NOT NULL CHECK (destination_hash ~ '^[0-9a-f]{64}$'),
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'viewer')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'joined', 'expired', 'revoked')),
  token_hash text UNIQUE CHECK (token_hash IS NULL OR token_hash ~ '^[0-9a-f]{64}$'),
  expires_at text,
  consent_grant_id text REFERENCES public.consent_grants (id),
  outbox_id text REFERENCES public.integration_outbox (id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS household_invites_open_unique ON public.household_invites (household_id, destination_hash) WHERE status IN ('draft', 'sent');

-- ===================================================================================================================
-- 039 CRYPTO-SHRED (optional, decision D9): one wrapped data key per household
-- ===================================================================================================================

CREATE TABLE IF NOT EXISTS public.household_keys (
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  key_version integer NOT NULL CHECK (key_version >= 1),
  wrapped_dek text NOT NULL,                                   -- DEK sealed with the KEK from Fly secrets
  kek_id text NOT NULL,
  created_at text NOT NULL,
  destroyed_at text,                                           -- set + wrapped_dek overwritten = data unrecoverable, backups included
  PRIMARY KEY (household_id, key_version)
);

-- ===================================================================================================================
-- 040 DEMO HOUSEHOLDS
-- ===================================================================================================================

ALTER TABLE public.households ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'real' CHECK (kind IN ('real', 'demo', 'template'));
ALTER TABLE public.households ADD COLUMN IF NOT EXISTS demo_expires_at text;
ALTER TABLE public.households ADD COLUMN IF NOT EXISTS template_version text;
ALTER TABLE public.households ADD COLUMN IF NOT EXISTS cloned_from_household_id text REFERENCES public.households (id) ON DELETE SET NULL;
ALTER TABLE public.households ADD CONSTRAINT households_demo_expiry_check
  CHECK ((kind = 'demo') = (demo_expires_at IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS households_one_template ON public.households (template_version) WHERE kind = 'template';
CREATE INDEX IF NOT EXISTS households_demo_expiry_idx ON public.households (demo_expires_at) WHERE kind = 'demo';
-- Demo/template households may never own provider calls or outbound messages: enforced in code AND by trigger on
-- integration_outbox (INSERT raises when the case's household kind <> 'real') so no path can bypass it.
