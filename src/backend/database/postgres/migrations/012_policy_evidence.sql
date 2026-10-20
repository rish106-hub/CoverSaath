-- Evidence-first reasoning (ADR 0008). Mirrors SQLite migration 015: same tables, columns, checks, indexes,
-- trigger names, timing, events and messages. The FTS index (SQLite 016) has no PostgreSQL counterpart yet.

CREATE TABLE public.policy_clauses (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  page bigint NOT NULL CHECK (page > 0),
  block_indexes_json text NOT NULL CHECK (block_indexes_json IS JSON ARRAY),
  title text CHECK (title IS NULL OR length(title) <= 200),
  kind text NOT NULL CHECK (kind IN (
    'benefit', 'limit', 'condition', 'exclusion', 'waiting_period', 'definition', 'endorsement', 'schedule_fact', 'procedure', 'other'
  )),
  text text NOT NULL CHECK (length(text) BETWEEN 1 AND 100000),
  digest text NOT NULL CHECK (length(digest) = 64),
  created_at text NOT NULL
);

CREATE INDEX policy_clauses_document_idx ON public.policy_clauses(document_id, page);
CREATE INDEX policy_clauses_household_idx ON public.policy_clauses(household_id, case_id);

CREATE FUNCTION public.policy_clauses_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    JOIN public.service_cases AS service_case ON service_case.id = NEW.case_id
    WHERE document.id = NEW.document_id
      AND document.household_id = NEW.household_id
      AND document.case_id = NEW.case_id
      AND service_case.household_id = NEW.household_id
      AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'policy clause must match an active document of its case and household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_clauses_scope_insert
BEFORE INSERT ON public.policy_clauses
FOR EACH ROW EXECUTE FUNCTION public.policy_clauses_scope_insert_fn();

CREATE FUNCTION public.policy_clauses_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'policy clauses are immutable; erasure deletes them';
END;
$$;

CREATE TRIGGER policy_clauses_immutable
BEFORE UPDATE ON public.policy_clauses
FOR EACH ROW EXECUTE FUNCTION public.policy_clauses_immutable_fn();

CREATE TABLE public.policy_answers (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  requested_by_adult_id text NOT NULL REFERENCES public.adult_users(id),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  question text NOT NULL CHECK (length(question) BETWEEN 1 AND 2000),
  state text NOT NULL CHECK (state IN ('evidence_found', 'conditional', 'insufficient_evidence')),
  document_ids_json text NOT NULL CHECK (document_ids_json IS JSON ARRAY),
  answer_json text NOT NULL CHECK (answer_json IS JSON OBJECT AND length(answer_json) <= 262144),
  created_at text NOT NULL,
  UNIQUE (household_id, case_id, idempotency_key)
);

CREATE INDEX policy_answers_case_idx ON public.policy_answers(household_id, case_id, created_at);

CREATE FUNCTION public.policy_answers_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.service_cases AS service_case
    WHERE service_case.id = NEW.case_id AND service_case.household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'policy answer must match its case and household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_answers_scope_insert
BEFORE INSERT ON public.policy_answers
FOR EACH ROW EXECUTE FUNCTION public.policy_answers_scope_insert_fn();

CREATE FUNCTION public.policy_answers_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'policy answers are immutable; erasure deletes them';
END;
$$;

CREATE TRIGGER policy_answers_immutable
BEFORE UPDATE ON public.policy_answers
FOR EACH ROW EXECUTE FUNCTION public.policy_answers_immutable_fn();

CREATE FUNCTION public.policy_evidence_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.policy_answers
  WHERE EXISTS (SELECT 1 FROM json_array_elements_text(policy_answers.document_ids_json::json) AS cited(value) WHERE cited.value = NEW.id);
  DELETE FROM public.policy_clauses WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER policy_evidence_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.policy_evidence_erase_on_document_erasure_fn();
