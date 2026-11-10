-- Policy facts slice 2 (ADR 0025). Expand-only and safe to run more than once: two new tables, their triggers and their lockdown.
-- policy_facts: one row per datapoint read from a document (money, dates, periods, waiting, copay, no-claim bonus, payment, seller,
--   member ages, clauses...), per (document, source version, extraction run). fact_evidence: where in the document each fact is printed.
-- Rules these tables enforce themselves:
--   * fact_type is plain text with a shape CHECK. The closed list of types is validated in the application against the policy
--     parameter registry (src/features/policy-facts/fact-types.js, with a drift test); it is not a SQL enum so a new type needs no migration.
--   * Exact values (money, dates, quotes, free text, original waiting-period unit) are application-encrypted (column-crypto.js, AAD
--     <table>.<column>.<row id>) and a CHECK allows only enc2 values. Only coarse values are plaintext: an amount band, a day count,
--     basis points, an enum, a year-month. No keyed hash and no subject reference of any value is stored.
--   * A model or a deterministic reader writes only extracted_unverified, conflicting or unknown. 'reported' is the household owner's own
--     statement (origin user_statement, confirmation_source user_statement, ADR 0009): never 'proven'. No code path writes it yet.
--   * A fact is immutable except one guarded update: superseded_by_fact_id may be set once, to a fact of the same document.
--     A fact_evidence row is fully immutable.
--   * Rows are erased with their document (triggers below), with the case and the household (application erasure paths), and when the
--     processing consent is withdrawn (ConsentRepository.eraseDerivedRunData). Erasure DELETEs rows; it does not null them.
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- No TRUNCATE guard: runtime roles cannot TRUNCATE (same stance as 043).
-- Consent, privacy and notice wording around these stores is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code and turn POLICY_FACTS_ENABLED off; a synthetic-only project may drop both tables.
CREATE TABLE IF NOT EXISTS public.policy_facts (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  extraction_run_id text NOT NULL CHECK (length(extraction_run_id) BETWEEN 1 AND 200),
  fact_type text NOT NULL CHECK (fact_type ~ '^[a-z][a-z0-9_]{2,63}$'),
  scope_key text NOT NULL DEFAULT '' CHECK (scope_key ~ '^[a-z0-9_.:-]{0,64}$'),
  ordinal integer NOT NULL DEFAULT 0 CHECK (ordinal BETWEEN 0 AND 999),
  origin text NOT NULL CHECK (origin IN ('deterministic', 'model_proposed', 'user_statement')),
  state text NOT NULL CHECK (state IN ('unknown', 'extracted_unverified', 'conflicting', 'reported')),
  value_type text NOT NULL CHECK (value_type IN ('money', 'date', 'date_range', 'duration', 'percent', 'number', 'enum', 'bool', 'text')),
  currency text CHECK (currency IS NULL OR currency = 'INR'),
  amount_band text CHECK (amount_band IS NULL OR amount_band IN
    ('lt_10k', '10k_50k', '50k_1l', '1l_5l', '5l_10l', '10l_25l', '25l_50l', '50l_1cr', 'gte_1cr')),
  value_duration_days integer CHECK (value_duration_days IS NULL OR value_duration_days BETWEEN 0 AND 36600),
  value_percent_bp integer CHECK (value_percent_bp IS NULL OR value_percent_bp BETWEEN 0 AND 100000),
  value_bool boolean,
  value_enum text CHECK (value_enum IS NULL OR value_enum ~ '^[a-z][a-z0-9_]{0,39}$'),
  value_ym text CHECK (value_ym IS NULL OR value_ym ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  value_enc text CHECK (value_enc IS NULL OR value_enc ~ '^enc2[.]'),
  raw_text_enc text CHECK (raw_text_enc IS NULL OR raw_text_enc ~ '^enc2[.]'),
  normaliser_version text NOT NULL CHECK (normaliser_version ~ '^[a-z0-9_.-]{1,40}$'),
  confirmation_source text CHECK (confirmation_source IS NULL OR confirmation_source = 'user_statement'),
  confirmed_at text,
  confirmed_by_adult_id text REFERENCES public.adult_users(id),
  supersedes_fact_id text CHECK (supersedes_fact_id IS NULL OR length(supersedes_fact_id) BETWEEN 1 AND 128),
  superseded_by_fact_id text CHECK (superseded_by_fact_id IS NULL OR length(superseded_by_fact_id) BETWEEN 1 AND 128),
  created_at text NOT NULL,
  UNIQUE (extraction_run_id, fact_type, scope_key, ordinal),
  -- Authority: a reader (model or deterministic code) never writes above extracted_unverified; reported is the owner's statement only.
  CONSTRAINT policy_facts_reader_state_check CHECK (origin = 'user_statement' OR state IN ('extracted_unverified', 'conflicting', 'unknown')),
  CONSTRAINT policy_facts_reported_origin_check CHECK ((state = 'reported') = (origin = 'user_statement')),
  CONSTRAINT policy_facts_confirmation_check CHECK (
    (state = 'reported' AND confirmation_source IS NOT DISTINCT FROM 'user_statement' AND confirmed_at IS NOT NULL AND confirmed_by_adult_id IS NOT NULL)
    OR (state <> 'reported' AND confirmation_source IS NULL AND confirmed_at IS NULL AND confirmed_by_adult_id IS NULL)),
  -- An unknown or conflicting fact holds no value at all.
  CONSTRAINT policy_facts_no_value_check CHECK (state NOT IN ('unknown', 'conflicting') OR (
    currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL
    AND value_enum IS NULL AND value_ym IS NULL AND value_enc IS NULL AND raw_text_enc IS NULL)),
  -- Per value_type shape: exactly the columns of that type, nothing else. Every test is NULL-safe: a CHECK passes on NULL, so no operand may be NULL.
  CONSTRAINT policy_facts_shape_check CHECK (state IN ('unknown', 'conflicting') OR CASE value_type
    WHEN 'money' THEN value_enc IS NOT NULL AND currency IS NOT DISTINCT FROM 'INR' AND amount_band IS NOT NULL
      AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_enum IS NULL AND value_ym IS NULL
    WHEN 'date' THEN value_enc IS NOT NULL AND value_ym IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_enum IS NULL
    WHEN 'date_range' THEN value_enc IS NOT NULL AND value_ym IS NOT NULL AND value_duration_days IS NOT NULL AND value_duration_days >= 1
      AND currency IS NULL AND amount_band IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_enum IS NULL
    WHEN 'duration' THEN value_enc IS NOT NULL AND value_duration_days IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_enum IS NULL AND value_ym IS NULL
    WHEN 'percent' THEN value_percent_bp IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_bool IS NULL AND value_enum IS NULL AND value_ym IS NULL AND value_enc IS NULL
    WHEN 'number' THEN value_enc IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_enum IS NULL AND value_ym IS NULL
    WHEN 'enum' THEN value_enum IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_ym IS NULL AND value_enc IS NULL
    WHEN 'bool' THEN value_bool IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_enum IS NULL AND value_ym IS NULL AND value_enc IS NULL
    WHEN 'text' THEN value_enc IS NOT NULL
      AND currency IS NULL AND amount_band IS NULL AND value_duration_days IS NULL AND value_percent_bp IS NULL AND value_bool IS NULL AND value_enum IS NULL AND value_ym IS NULL
    ELSE false END)
);

CREATE INDEX IF NOT EXISTS policy_facts_household_idx ON public.policy_facts (household_id, case_id);
CREATE INDEX IF NOT EXISTS policy_facts_document_idx ON public.policy_facts (document_id, source_version);
CREATE INDEX IF NOT EXISTS policy_facts_confirmed_by_idx ON public.policy_facts (confirmed_by_adult_id) WHERE confirmed_by_adult_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.fact_evidence (
  id text PRIMARY KEY,
  fact_id text NOT NULL REFERENCES public.policy_facts(id) ON DELETE CASCADE,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  page integer NOT NULL CHECK (page BETWEEN 1 AND 5000),
  block_index integer CHECK (block_index IS NULL OR block_index BETWEEN 0 AND 100000),
  -- No foreign key: a clause is a derived store that may be erased on its own, and evidence must not block that.
  clause_id text CHECK (clause_id IS NULL OR length(clause_id) BETWEEN 1 AND 200),
  quote_enc text NOT NULL CHECK (quote_enc ~ '^enc2[.]'),
  -- sha256 of the whole page text the quote was read from (source_pages.page_sha256), not of the quote: a hash of a short quote can be guessed.
  source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$'),
  role text NOT NULL CHECK (role IN ('primary', 'corroborating', 'conflicting')),
  created_at text NOT NULL
);

CREATE INDEX IF NOT EXISTS fact_evidence_fact_idx ON public.fact_evidence (fact_id);
CREATE INDEX IF NOT EXISTS fact_evidence_household_idx ON public.fact_evidence (household_id, case_id);
CREATE INDEX IF NOT EXISTS fact_evidence_document_idx ON public.fact_evidence (document_id, source_version);

CREATE OR REPLACE FUNCTION public.policy_facts_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
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
    RAISE EXCEPTION 'policy fact must match an active document of its case and household';
  END IF;
  IF NEW.confirmed_by_adult_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.confirmed_by_adult_id AND role.status = 'active'
  ) THEN
    RAISE EXCEPTION 'policy fact confirmer must be an active adult of the household';
  END IF;
  IF NEW.supersedes_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_facts AS earlier
    WHERE earlier.id = NEW.supersedes_fact_id AND earlier.document_id = NEW.document_id AND earlier.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'a superseded policy fact must belong to the same document';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS policy_facts_scope_insert ON public.policy_facts;
CREATE TRIGGER policy_facts_scope_insert
BEFORE INSERT ON public.policy_facts
FOR EACH ROW EXECUTE FUNCTION public.policy_facts_scope_insert_fn();

-- Immutable, with one guarded exception: superseded_by_fact_id is set once, to a fact of the same document.
CREATE OR REPLACE FUNCTION public.policy_facts_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.superseded_by_fact_id IS NULL AND NEW.superseded_by_fact_id IS NOT NULL
    AND (to_jsonb(NEW) - 'superseded_by_fact_id') = (to_jsonb(OLD) - 'superseded_by_fact_id')
    AND EXISTS (
      SELECT 1 FROM public.policy_facts AS later
      WHERE later.id = NEW.superseded_by_fact_id AND later.document_id = OLD.document_id AND later.household_id = OLD.household_id
    ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'policy facts are immutable; only superseded_by_fact_id may be set once; erasure deletes them';
END;
$$;

DROP TRIGGER IF EXISTS policy_facts_immutable ON public.policy_facts;
CREATE TRIGGER policy_facts_immutable
BEFORE UPDATE ON public.policy_facts
FOR EACH ROW EXECUTE FUNCTION public.policy_facts_immutable_fn();

CREATE OR REPLACE FUNCTION public.fact_evidence_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.policy_facts AS fact
    WHERE fact.id = NEW.fact_id
      AND fact.household_id = NEW.household_id
      AND fact.case_id = NEW.case_id
      AND fact.document_id = NEW.document_id
      AND fact.source_version = NEW.source_version
  ) THEN
    RAISE EXCEPTION 'fact evidence must match the document, case and household of its fact';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fact_evidence_scope_insert ON public.fact_evidence;
CREATE TRIGGER fact_evidence_scope_insert
BEFORE INSERT ON public.fact_evidence
FOR EACH ROW EXECUTE FUNCTION public.fact_evidence_scope_insert_fn();

CREATE OR REPLACE FUNCTION public.fact_evidence_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'fact evidence is immutable; erasure deletes it';
END;
$$;

DROP TRIGGER IF EXISTS fact_evidence_immutable ON public.fact_evidence;
CREATE TRIGGER fact_evidence_immutable
BEFORE UPDATE ON public.fact_evidence
FOR EACH ROW EXECUTE FUNCTION public.fact_evidence_immutable_fn();

CREATE OR REPLACE FUNCTION public.policy_facts_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.fact_evidence WHERE document_id = NEW.id;
  DELETE FROM public.policy_facts WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS policy_facts_erase_on_document_erasure ON public.document_uploads;
CREATE TRIGGER policy_facts_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.policy_facts_erase_on_document_erasure_fn();

ALTER TABLE public.policy_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fact_evidence ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.policy_facts FROM %I', api_role);
      EXECUTE format('REVOKE ALL ON TABLE public.fact_evidence FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.policy_facts FROM PUBLIC;
  REVOKE ALL ON TABLE public.fact_evidence FROM PUBLIC;
END
$$;
