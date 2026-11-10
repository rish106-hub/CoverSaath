-- Policy facts slice 1 (ADR 0024). Expand-only and safe to run more than once: one new table, its triggers and its lockdown.
-- One row per (document, source version): the identity of the policy a document describes (UIN, insurer, policy name) and what the
-- owner confirmed about it. Rules this table enforces itself:
--   * The policy name and the insurer name are NEVER stored before the owner confirms them. They are application-encrypted
--     (src/backend/security/column-crypto.js, AAD policy_profiles.<column>.<row id>) and a CHECK allows them only in the
--     'reported' state, which needs confirmed_at, confirmed_by_adult_id and confirmation_source = 'user_statement'.
--   * 'reported' is the household owner's own statement (ADR 0009). It is never 'proven' and there is no 'user_confirmed' state.
--   * The UIN and the insurer code are public product identifiers (the IRDAI product and insurer codes printed on a policy), so they
--     are plaintext and may be stored as 'extracted_unverified' before confirmation. Nothing here is a model output.
--   * Rows are erased with their document (trigger below), with the case and the household (application erasure paths), and when
--     the processing consent is withdrawn (ConsentRepository.eraseDerivedRunData).
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- No TRUNCATE guard: the neighbouring mutable tables (policy_clauses, profile_answers) have none and runtime roles cannot TRUNCATE.
-- Consent, privacy and notice wording around this store is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code and turn POLICY_FACTS_ENABLED off; a synthetic-only project may drop the table.
CREATE TABLE IF NOT EXISTS public.policy_profiles (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  uin text CHECK (uin IS NULL OR uin ~ '^[A-Z0-9]{8,24}$'),
  insurer_code text CHECK (insurer_code IS NULL OR insurer_code ~ '^[A-Z0-9]{2,12}$'),
  insurer_name_enc text CHECK (insurer_name_enc IS NULL OR insurer_name_enc ~ '^enc2[.]'),
  policy_name_enc text CHECK (policy_name_enc IS NULL OR policy_name_enc ~ '^enc2[.]'),
  uin_state text NOT NULL DEFAULT 'unknown' CHECK (uin_state IN ('unknown', 'extracted_unverified', 'conflicting', 'reported')),
  insurer_state text NOT NULL DEFAULT 'unknown' CHECK (insurer_state IN ('unknown', 'extracted_unverified', 'conflicting', 'reported')),
  policy_name_state text NOT NULL DEFAULT 'unknown' CHECK (policy_name_state IN ('unknown', 'extracted_unverified', 'conflicting', 'reported')),
  confirmation_source text CHECK (confirmation_source IS NULL OR confirmation_source = 'user_statement'),
  confirmed_at text,
  confirmed_by_adult_id text REFERENCES public.adult_users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (document_id, source_version),
  -- The names exist only once the owner has reported them.
  CONSTRAINT policy_profiles_policy_name_reported_check CHECK (policy_name_enc IS NULL OR policy_name_state = 'reported'),
  CONSTRAINT policy_profiles_insurer_name_reported_check CHECK (insurer_name_enc IS NULL OR insurer_state = 'reported'),
  -- A reported field has a value, and a state that names a value has a value.
  CONSTRAINT policy_profiles_policy_name_value_check CHECK (policy_name_state <> 'reported' OR policy_name_enc IS NOT NULL),
  CONSTRAINT policy_profiles_uin_value_check CHECK (uin_state NOT IN ('reported', 'extracted_unverified') OR uin IS NOT NULL),
  CONSTRAINT policy_profiles_insurer_value_check CHECK (insurer_state <> 'extracted_unverified' OR insurer_code IS NOT NULL),
  CONSTRAINT policy_profiles_insurer_reported_value_check CHECK (insurer_state <> 'reported' OR insurer_code IS NOT NULL OR insurer_name_enc IS NOT NULL),
  -- A conflicting field holds no single value.
  CONSTRAINT policy_profiles_uin_conflict_check CHECK (uin_state <> 'conflicting' OR uin IS NULL),
  -- Anything reported carries who said it and when.
  CONSTRAINT policy_profiles_reported_confirmation_check CHECK (
    (uin_state <> 'reported' AND insurer_state <> 'reported' AND policy_name_state <> 'reported')
    OR (confirmed_at IS NOT NULL AND confirmed_by_adult_id IS NOT NULL AND confirmation_source = 'user_statement'))
);

CREATE INDEX IF NOT EXISTS policy_profiles_household_idx ON public.policy_profiles (household_id, case_id);
CREATE INDEX IF NOT EXISTS policy_profiles_confirmed_by_idx ON public.policy_profiles (confirmed_by_adult_id) WHERE confirmed_by_adult_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.policy_profiles_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    JOIN public.service_cases AS service_case ON service_case.id = NEW.case_id
    WHERE document.id = NEW.document_id
      AND document.household_id = NEW.household_id
      AND document.case_id = NEW.case_id
      AND document.source_version = NEW.source_version
      AND service_case.household_id = NEW.household_id
      AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'policy profile must match an active document of its case and household';
  END IF;
  IF NEW.confirmed_by_adult_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.confirmed_by_adult_id AND role.status = 'active'
  ) THEN
    RAISE EXCEPTION 'policy profile confirmer must be an active adult of the household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS policy_profiles_scope_insert ON public.policy_profiles;
CREATE TRIGGER policy_profiles_scope_insert
BEFORE INSERT ON public.policy_profiles
FOR EACH ROW EXECUTE FUNCTION public.policy_profiles_scope_insert_fn();

CREATE OR REPLACE FUNCTION public.policy_profiles_update_guard_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.household_id <> OLD.household_id OR NEW.case_id <> OLD.case_id
    OR NEW.document_id <> OLD.document_id OR NEW.source_version <> OLD.source_version OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'policy profile identity is immutable';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'policy profile version must increase by one';
  END IF;
  IF (OLD.uin_state = 'reported' AND NEW.uin_state <> 'reported')
    OR (OLD.insurer_state = 'reported' AND NEW.insurer_state <> 'reported')
    OR (OLD.policy_name_state = 'reported' AND NEW.policy_name_state <> 'reported') THEN
    RAISE EXCEPTION 'a reported policy profile field cannot return to an unconfirmed state';
  END IF;
  -- Only the confirm path sets a name: it also moves the confirmation time and the confirmer.
  IF (NEW.policy_name_enc IS DISTINCT FROM OLD.policy_name_enc OR NEW.insurer_name_enc IS DISTINCT FROM OLD.insurer_name_enc)
    AND (NEW.confirmed_at IS NULL OR NEW.confirmed_by_adult_id IS NULL) THEN
    RAISE EXCEPTION 'a policy or insurer name needs a confirmation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS policy_profiles_update_guard ON public.policy_profiles;
CREATE TRIGGER policy_profiles_update_guard
BEFORE UPDATE ON public.policy_profiles
FOR EACH ROW EXECUTE FUNCTION public.policy_profiles_update_guard_fn();

CREATE OR REPLACE FUNCTION public.policy_profiles_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.policy_profiles WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS policy_profiles_erase_on_document_erasure ON public.document_uploads;
CREATE TRIGGER policy_profiles_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.policy_profiles_erase_on_document_erasure_fn();

ALTER TABLE public.policy_profiles ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.policy_profiles FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.policy_profiles FROM PUBLIC;
END
$$;
