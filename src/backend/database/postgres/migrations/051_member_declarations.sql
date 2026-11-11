-- Holdings and memory, part 4: member_declarations (ADR 0032). Expand-only and safe to run more than once: one new table, its triggers
-- and its lockdown.
-- What a household member declared to an insurer or on a proposal form: a pre-existing disease, a prior condition, a habit, an
-- occupation, a nominee. It is the structured home of the declarations a user reports; household_memory_facts holds the resolved
-- reading of them (tier user_declaration), this table holds the declaration record itself.
--   label_enc  the declaration text (a disease, a condition, a habit...). It is HEALTH DATA: application-encrypted (column-crypto.js,
--              AAD member_declarations.label_enc.<row id>), and a CHECK allows only enc2 values. It is never plaintext and never indexed.
--   kind       closed enum. kind alone says what sort of declaration exists for a member (for example that one is a pre-existing
--              disease). That is itself sensitive; it is plain so the app can list by kind without unsealing. Flagged for owner review.
--   declared_on a calendar day (UTC date), plain; declared_to_insurer a flag.
-- Rules this table enforces itself: member, holding, document, consent grant and declarer belong to the declaration's household
-- (scope trigger); the declarer is an active adult of the household. Health and nominee data of a dependent needs the guardian rules of
-- ADR 0026, enforced by the repository.
-- Erased with its member (FK cascade), with its holding link cleared (ON DELETE SET NULL), with the household and on withdrawal of the
-- consent grant it was written under (application erasure paths).
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- Consent, privacy and declaration wording is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code and turn HOLDINGS_ENABLED off; a synthetic-only project may drop the table.
CREATE TABLE IF NOT EXISTS public.member_declarations (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  member_id text NOT NULL REFERENCES public.household_members(id) ON DELETE CASCADE,
  holding_id text REFERENCES public.policy_holdings(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('pre_existing_disease', 'prior_condition', 'habit', 'occupation', 'nominee', 'other')),
  label_enc text NOT NULL CHECK (label_enc ~ '^enc2[.]'),
  declared_on text CHECK (declared_on IS NULL OR declared_on ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'),
  declared_to_insurer boolean,
  document_id text REFERENCES public.document_uploads(id) ON DELETE SET NULL,
  consent_grant_id text NOT NULL REFERENCES public.consent_grants(id),
  declared_by_adult_id text NOT NULL REFERENCES public.adult_users(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at text NOT NULL,
  updated_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS member_declarations_household_idx ON public.member_declarations (household_id, member_id, kind);
CREATE INDEX IF NOT EXISTS member_declarations_member_idx ON public.member_declarations (member_id);
CREATE INDEX IF NOT EXISTS member_declarations_holding_idx ON public.member_declarations (holding_id) WHERE holding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_declarations_document_idx ON public.member_declarations (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS member_declarations_consent_idx ON public.member_declarations (consent_grant_id);
CREATE INDEX IF NOT EXISTS member_declarations_declarer_idx ON public.member_declarations (declared_by_adult_id);

CREATE OR REPLACE FUNCTION public.member_declarations_scope_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.household_members AS member WHERE member.id = NEW.member_id AND member.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'declaration must match a member of its household';
  END IF;
  IF NEW.holding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'declaration must match a holding of its household';
  END IF;
  IF NEW.document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document WHERE document.id = NEW.document_id AND document.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'declaration must match a document of its household';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_grants AS grant_record WHERE grant_record.id = NEW.consent_grant_id AND grant_record.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'declaration must use a consent grant of its household';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.declared_by_adult_id AND role.status = 'active'
  ) THEN
    RAISE EXCEPTION 'declaration declarer must be an active adult of the household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS member_declarations_scope_insert ON public.member_declarations;
CREATE TRIGGER member_declarations_scope_insert
BEFORE INSERT ON public.member_declarations
FOR EACH ROW EXECUTE FUNCTION public.member_declarations_scope_fn();
DROP TRIGGER IF EXISTS member_declarations_scope_update ON public.member_declarations;
CREATE TRIGGER member_declarations_scope_update
BEFORE UPDATE OF household_id, member_id, holding_id, document_id, consent_grant_id, declared_by_adult_id ON public.member_declarations
FOR EACH ROW EXECUTE FUNCTION public.member_declarations_scope_fn();

ALTER TABLE public.member_declarations ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.member_declarations FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.member_declarations FROM PUBLIC;
END
$$;
