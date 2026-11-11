-- Holdings and memory, part 2: household_memory_facts (ADR 0023, accepted with the changes recorded in ADR 0032).
-- Expand-only and safe to run more than once: one new table, its triggers and its lockdown.
-- One row = one value of one fact key, from one tier, for one slot (household, holding, policy, member, scope). EAV by design: a new
-- fact key is a line in src/contracts/policy-facts.js, never a column and never a migration.
--   source_tier own_pdf | ida_wording | user_declaration, each with its own closed status set (CHECK below):
--                 own_pdf          extracted_unverified | conflicting | unknown       (machine reading of the household's own PDF)
--                 ida_wording      reviewed_reference | conflicting | unknown         (deterministic code over the IDA reference)
--                 user_declaration user_confirmed                                     (a household adult's own statement)
--               A model never writes reviewed_reference or user_confirmed. The bare word "confirmed" is not a status.
-- Rules this table enforces itself:
--   * The value is application-encrypted (column-crypto.js, AAD household_memory_facts.value_enc.<row id>), a CHECK allows only enc2
--     values, and value_enc is NULL exactly when the status is unknown. NO plaintext value, NO GIN or full-text column over values, NO
--     keyed hash of a value: that would undo ADR 0013 and ADR 0025 D3. A conflicting row holds its bounded alternatives sealed in
--     value_enc. Plain columns are ids, the fact key (a public registry name), closed enums and timestamps.
--   * The reference the IDA tier read (cache key, version, evidence digests) is sealed (reference_ref_enc) because it links one
--     household to one product.
--   * IDA wording only writes product terms. A user declaration may not set a product term except as a conflict resolution
--     (capture_method conflict_resolution, resolves_fact_ids): the owner may resolve any conflict (ADR 0032, FOR LEGAL REVIEW).
--   * Append-only with supersession. A row is immutable except that superseded_at may be stamped once. DELETE is allowed (erasure).
--     supersedes_id carries no foreign key, like policy_facts.supersedes_fact_id (044): the scope trigger checks it, and erasure may
--     delete a chain in any order.
--   * proposed_parameter_id carries no foreign key (see the column comment); every other provenance id does.
--   * Rows are erased with their holding and document (FK cascade and the trigger below), with a revoked consent grant, the member,
--     the household (application erasure paths) and when the user deletes a declaration.
--   * Timestamps are UTC ISO-8601 text like its neighbours (not timestamptz as first sketched in ADR 0023).
-- Row level security is on with no policy and the Data API roles get no privileges (see 016_data_api_lockdown.sql).
-- No TRUNCATE guard: runtime roles cannot TRUNCATE (same stance as 043 and 044).
-- Consent, privacy and declaration wording around this store is a DRAFT and needs legal review.
-- Rollback: expand-only. Revert the code and turn HOLDINGS_ENABLED off; a synthetic-only project may drop the table.
CREATE TABLE IF NOT EXISTS public.household_memory_facts (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 100),
  household_id text NOT NULL REFERENCES public.households(id),
  holding_id text REFERENCES public.policy_holdings(id) ON DELETE CASCADE,
  policy_id text REFERENCES public.policies(id) ON DELETE CASCADE,
  subject_member_id text REFERENCES public.household_members(id) ON DELETE CASCADE,
  member_scope text NOT NULL CHECK (member_scope IN ('policy', 'policyholder', 'dependent', 'household')),
  fact_key text NOT NULL CHECK (fact_key ~ '^[a-z][a-z0-9_]{2,63}$'),
  scope_key text NOT NULL DEFAULT '' CHECK (scope_key ~ '^[a-z0-9_.:-]{0,64}$'),
  key_schema text NOT NULL CHECK (key_schema IN ('policy-facts/v1', 'declarations/v1')),
  fact_class text NOT NULL CHECK (fact_class IN ('personal_value', 'product_term', 'household_declaration')),
  source_tier text NOT NULL CHECK (source_tier IN ('own_pdf', 'ida_wording', 'user_declaration')),
  status text NOT NULL CHECK (status IN ('extracted_unverified', 'conflicting', 'unknown', 'reviewed_reference', 'user_confirmed')),
  value_enc text CHECK (value_enc IS NULL OR value_enc ~ '^enc2[.]'),
  consent_grant_id text NOT NULL REFERENCES public.consent_grants(id),
  source_document_id text REFERENCES public.document_uploads(id) ON DELETE CASCADE,
  source_page_id text REFERENCES public.source_pages(id) ON DELETE CASCADE,
  block_index integer CHECK (block_index IS NULL OR block_index BETWEEN 0 AND 100000),
  policy_fact_id text REFERENCES public.policy_facts(id) ON DELETE CASCADE,
  parameter_record_id text REFERENCES public.coverage_parameter_records(id) ON DELETE CASCADE,
  -- No foreign key: proposed_parameters is append-only with a TRUNCATE guard, and a referencing table would make Postgres refuse the
  -- truncate (0A000) before that guard fires. The scope trigger checks the household; rows go with their source document.
  proposed_parameter_id text CHECK (proposed_parameter_id IS NULL OR length(proposed_parameter_id) BETWEEN 1 AND 100),
  policy_clause_id text REFERENCES public.policy_clauses(id) ON DELETE CASCADE,
  reference_ref_enc text CHECK (reference_ref_enc IS NULL OR reference_ref_enc ~ '^enc2[.]'),
  declared_by_adult_id text REFERENCES public.adult_users(id),
  capture_method text CHECK (capture_method IS NULL OR capture_method IN ('typed', 'voice_transcript', 'box_confirm', 'conflict_resolution')),
  resolves_fact_ids text[] NOT NULL DEFAULT '{}' CHECK (cardinality(resolves_fact_ids) <= 10),
  derivation_version text CHECK (derivation_version IS NULL OR derivation_version ~ '^[a-z0-9_.-]{1,40}$'),
  supersedes_id text CHECK (supersedes_id IS NULL OR length(supersedes_id) BETWEEN 1 AND 100),
  superseded_at text,
  created_at text NOT NULL,
  -- Tier and status pairing: a machine tier never holds a user status and the user tier never holds a machine status.
  CONSTRAINT household_memory_facts_tier_status_check CHECK (
    (source_tier = 'own_pdf' AND status IN ('extracted_unverified', 'conflicting', 'unknown'))
    OR (source_tier = 'ida_wording' AND status IN ('reviewed_reference', 'conflicting', 'unknown'))
    OR (source_tier = 'user_declaration' AND status = 'user_confirmed')),
  -- A sealed value exists exactly when the status is not unknown.
  CONSTRAINT household_memory_facts_value_check CHECK ((status = 'unknown') = (value_enc IS NULL)),
  -- Provenance per tier (ADR 0023 D2).
  CONSTRAINT household_memory_facts_own_pdf_check CHECK (source_tier <> 'own_pdf' OR (
    source_document_id IS NOT NULL AND source_page_id IS NOT NULL AND reference_ref_enc IS NULL
    AND declared_by_adult_id IS NULL AND capture_method IS NULL AND cardinality(resolves_fact_ids) = 0)),
  CONSTRAINT household_memory_facts_ida_check CHECK (source_tier <> 'ida_wording' OR (
    reference_ref_enc IS NOT NULL AND source_document_id IS NOT NULL AND fact_class = 'product_term'
    AND declared_by_adult_id IS NULL AND capture_method IS NULL AND cardinality(resolves_fact_ids) = 0)),
  CONSTRAINT household_memory_facts_user_check CHECK (source_tier <> 'user_declaration' OR (
    declared_by_adult_id IS NOT NULL AND capture_method IS NOT NULL AND reference_ref_enc IS NULL
    AND source_page_id IS NULL AND policy_fact_id IS NULL AND parameter_record_id IS NULL AND proposed_parameter_id IS NULL AND policy_clause_id IS NULL
    AND (fact_class <> 'product_term' OR capture_method = 'conflict_resolution')
    AND ((capture_method = 'conflict_resolution') = (cardinality(resolves_fact_ids) > 0)))),
  -- The unit of a declaration key is the declarations schema; the policy registry covers every other row.
  CONSTRAINT household_memory_facts_declaration_schema_check CHECK (key_schema <> 'declarations/v1' OR fact_class = 'household_declaration'),
  CONSTRAINT household_memory_facts_supersession_check CHECK (supersedes_id IS NULL OR supersedes_id <> id)
);

-- Current slot: one live row per tier for each (household, holding, policy, member, key, scope).
CREATE UNIQUE INDEX IF NOT EXISTS household_memory_facts_current_slot
  ON public.household_memory_facts (household_id, COALESCE(holding_id, ''), COALESCE(policy_id, ''), COALESCE(subject_member_id, ''), fact_key, scope_key, source_tier)
  WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_read_idx
  ON public.household_memory_facts (household_id, holding_id, fact_class) WHERE superseded_at IS NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_policy_idx ON public.household_memory_facts (policy_id) WHERE policy_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_member_idx ON public.household_memory_facts (subject_member_id) WHERE subject_member_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_document_idx ON public.household_memory_facts (source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_page_idx ON public.household_memory_facts (source_page_id) WHERE source_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_consent_idx ON public.household_memory_facts (consent_grant_id);
CREATE INDEX IF NOT EXISTS household_memory_facts_supersedes_idx ON public.household_memory_facts (supersedes_id) WHERE supersedes_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_declared_by_idx ON public.household_memory_facts (declared_by_adult_id) WHERE declared_by_adult_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_policy_fact_idx ON public.household_memory_facts (policy_fact_id) WHERE policy_fact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_parameter_idx ON public.household_memory_facts (parameter_record_id) WHERE parameter_record_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_proposed_idx ON public.household_memory_facts (proposed_parameter_id) WHERE proposed_parameter_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_memory_facts_clause_idx ON public.household_memory_facts (policy_clause_id) WHERE policy_clause_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.household_memory_facts_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.consent_grants AS grant_record WHERE grant_record.id = NEW.consent_grant_id AND grant_record.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must use a consent grant of its household';
  END IF;
  IF NEW.holding_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_holdings AS holding WHERE holding.id = NEW.holding_id AND holding.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a holding of its household';
  END IF;
  IF NEW.policy_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policies AS policy WHERE policy.id = NEW.policy_id AND policy.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a policy of its household';
  END IF;
  IF NEW.subject_member_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_members AS member WHERE member.id = NEW.subject_member_id AND member.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a member of its household';
  END IF;
  IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.source_document_id AND document.household_id = NEW.household_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'memory fact must match an active document of its household';
  END IF;
  IF NEW.source_page_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.source_pages AS page WHERE page.id = NEW.source_page_id AND page.document_upload_id = NEW.source_document_id
  ) THEN
    RAISE EXCEPTION 'memory fact page must belong to its source document';
  END IF;
  IF NEW.policy_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_facts AS fact
    WHERE fact.id = NEW.policy_fact_id AND fact.household_id = NEW.household_id AND fact.document_id IS NOT DISTINCT FROM NEW.source_document_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a policy fact of its document and household';
  END IF;
  IF NEW.parameter_record_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.coverage_parameter_records AS record WHERE record.id = NEW.parameter_record_id AND record.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a parameter record of its household';
  END IF;
  IF NEW.proposed_parameter_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.proposed_parameters AS proposed WHERE proposed.id = NEW.proposed_parameter_id AND proposed.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a proposed parameter of its household';
  END IF;
  IF NEW.policy_clause_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.policy_clauses AS clause WHERE clause.id = NEW.policy_clause_id AND clause.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'memory fact must match a clause of its household';
  END IF;
  IF NEW.declared_by_adult_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.declared_by_adult_id AND role.status = 'active'
  ) THEN
    RAISE EXCEPTION 'memory fact declarer must be an active adult of the household';
  END IF;
  IF NEW.supersedes_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.household_memory_facts AS earlier
    WHERE earlier.id = NEW.supersedes_id AND earlier.household_id = NEW.household_id AND earlier.fact_key = NEW.fact_key
  ) THEN
    RAISE EXCEPTION 'a superseded memory fact must belong to the same household and key';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS household_memory_facts_scope_insert ON public.household_memory_facts;
CREATE TRIGGER household_memory_facts_scope_insert
BEFORE INSERT ON public.household_memory_facts
FOR EACH ROW EXECUTE FUNCTION public.household_memory_facts_scope_insert_fn();

-- Immutable, with one guarded exception: superseded_at is stamped once.
CREATE OR REPLACE FUNCTION public.household_memory_facts_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD.superseded_at IS NULL AND NEW.superseded_at IS NOT NULL
    AND (to_jsonb(NEW) - 'superseded_at') = (to_jsonb(OLD) - 'superseded_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'memory facts are immutable; only superseded_at may be stamped once; erasure deletes them';
END;
$$;

DROP TRIGGER IF EXISTS household_memory_facts_immutable ON public.household_memory_facts;
CREATE TRIGGER household_memory_facts_immutable
BEFORE UPDATE ON public.household_memory_facts
FOR EACH ROW EXECUTE FUNCTION public.household_memory_facts_immutable_fn();

ALTER TABLE public.household_memory_facts ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.household_memory_facts FROM %I', api_role);
    END IF;
  END LOOP;
  REVOKE ALL ON TABLE public.household_memory_facts FROM PUBLIC;
END
$$;
