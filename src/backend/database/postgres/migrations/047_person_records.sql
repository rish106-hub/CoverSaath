-- Capture everything, part 1: person records and member details (ADR 0026, design capture-everything-design.md sections 3-5).
-- Expand-only and safe to run more than once: one new table, nullable columns on household_members, no value changes.
--   person_records  one sealed JSON document per (household, subject member, record type, slot) for the long tail nobody queries
--                   inside: self profile, health context, nominees, emergency contacts, advisors, member notes, out-of-pocket spend.
--                   payload_ciphertext is a sealed envelope (enc1 or padded enc2, AES-256-GCM, AAD person_records.payload_ciphertext.<id>)
--                   that the CHECK forces. Plain: ids, the closed record_type / source / state / completeness enums, schema_version,
--                   timestamps and the revision. completeness is computed by the server from the registry, never by the client.
--   household_members  gender, age_band (the only age kept for a dependent under 18), sealed mobile and e-mail, a keyed hash of the
--                   mobile (lookup and per-household uniqueness only), preferred channel, lives_with_household, who a member depends
--                   on, the guardian adult member, a revision counter and a deletion tombstone reserved for sync.
-- Health context, nominees and children's data are sensitive: consent, notice and health wording is not final and needs legal review.
-- Row level security is on with no policy and the Data API roles hold nothing (see 016_data_api_lockdown.sql). A member's records go
-- with the member and all records with the household (ON DELETE CASCADE); the application also deletes them explicitly with counts.
CREATE TABLE IF NOT EXISTS public.person_records (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households (id) ON DELETE CASCADE,
  subject_member_id text REFERENCES public.household_members (id) ON DELETE CASCADE,
  record_type text NOT NULL CHECK (record_type IN (
    'self_profile', 'health_context', 'nominee', 'emergency_contact', 'advisor', 'member_note', 'out_of_pocket_spend')),
  slot text NOT NULL DEFAULT 'main' CHECK (slot ~ '^[A-Za-z0-9_.-]{1,40}$'),
  payload_ciphertext text NOT NULL CHECK (payload_ciphertext ~ '^enc[12][.]' AND length(payload_ciphertext) <= 16384),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  completeness text NOT NULL DEFAULT 'partial' CHECK (completeness IN ('empty', 'partial', 'complete')),
  source text NOT NULL CHECK (source IN ('user_typed', 'voice', 'document', 'digilocker', 'import')),
  state text NOT NULL DEFAULT 'user_stated' CHECK (state IN ('user_stated', 'extracted_unverified', 'conflicting', 'confirmed_by_user')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  deleted_at text
);
CREATE UNIQUE INDEX IF NOT EXISTS person_records_unique
  ON public.person_records (household_id, COALESCE(subject_member_id, ''), record_type, slot);
CREATE INDEX IF NOT EXISTS person_records_household_type_idx ON public.person_records (household_id, record_type);
CREATE INDEX IF NOT EXISTS person_records_subject_idx ON public.person_records (subject_member_id) WHERE subject_member_id IS NOT NULL;

-- A record's subject member must belong to the record's household (the application checks it too; this is the safety net).
CREATE OR REPLACE FUNCTION public.person_records_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_members AS member
    WHERE member.id = NEW.subject_member_id AND member.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'person record must match its member and household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS person_records_scope_insert ON public.person_records;
CREATE TRIGGER person_records_scope_insert
BEFORE INSERT ON public.person_records
FOR EACH ROW EXECUTE FUNCTION public.person_records_scope_fn();
DROP TRIGGER IF EXISTS person_records_scope_update ON public.person_records;
CREATE TRIGGER person_records_scope_update
BEFORE UPDATE OF household_id, subject_member_id ON public.person_records
FOR EACH ROW EXECUTE FUNCTION public.person_records_scope_fn();
-- Sync slice: attach the revision / change-log triggers to person_records and household_members here once that migration exists.

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

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.household_members'::regclass AND conname = 'household_members_no_self_link_check') THEN
    ALTER TABLE public.household_members ADD CONSTRAINT household_members_no_self_link_check
      CHECK ((dependent_on_member_id IS NULL OR dependent_on_member_id <> id) AND (guardian_member_id IS NULL OR guardian_member_id <> id));
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS household_members_mobile_unique
  ON public.household_members (household_id, mobile_hash) WHERE mobile_hash IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE public.person_records ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.person_records FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
