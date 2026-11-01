-- Stored user-stated profile answers (run E1a, ADR 0013). Expand-only and safe to run more than once: one new table,
-- no change to an existing table. These are what the user told us (who is covered, city, renewal month, a few yes/no
-- answers), NOT evidence read from a document and NOT model output, so source is fixed to 'user_stated'.
-- The value is application-encrypted (AES-256-GCM envelope, see src/backend/security/column-crypto.js) before it reaches
-- this column; SQL never inspects it. One row per (case, field). DRAFT: consent and notice wording for this store is not
-- final and needs legal review.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
CREATE TABLE IF NOT EXISTS public.profile_answers (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  adult_user_id text NOT NULL REFERENCES public.adult_users(id),
  field_key text NOT NULL CHECK (field_key IN (
    'covered_people', 'city', 'state', 'renewal_month', 'has_employer_cover', 'has_personal_policy', 'has_top_up_policy'
  )),
  value_ciphertext text NOT NULL CHECK (length(value_ciphertext) BETWEEN 1 AND 4096),
  source text NOT NULL DEFAULT 'user_stated' CHECK (source = 'user_stated'),
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (case_id, field_key)
);

CREATE INDEX IF NOT EXISTS profile_answers_household_idx ON public.profile_answers (household_id, case_id);

CREATE OR REPLACE FUNCTION public.profile_answers_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.service_cases AS service_case
    WHERE service_case.id = NEW.case_id AND service_case.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'profile answer must match its case and household';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS profile_answers_scope_insert ON public.profile_answers;
CREATE TRIGGER profile_answers_scope_insert
BEFORE INSERT ON public.profile_answers
FOR EACH ROW EXECUTE FUNCTION public.profile_answers_scope_insert_fn();

ALTER TABLE public.profile_answers ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.profile_answers FROM %I', api_role);
    END IF;
  END LOOP;
END
$$;
