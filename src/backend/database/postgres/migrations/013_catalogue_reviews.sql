-- Reviewed facts for the decision catalogue (ADR 0009 part 2). Mirrors SQLite migration 017: same tables, columns,
-- checks, indexes, trigger names, timing, events and messages. Expand-only.

CREATE TABLE public.catalogue_reviewer_grants (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  adult_user_id text NOT NULL REFERENCES public.adult_users(id),
  kind text NOT NULL CHECK (kind IN ('household_confirmer', 'independent_reviewer')),
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  granted_by text NOT NULL CHECK (length(granted_by) BETWEEN 1 AND 128),
  created_at text NOT NULL,
  revoked_at text,
  UNIQUE (household_id, adult_user_id, kind)
);

CREATE TABLE public.catalogue_reviews (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  grant_id text NOT NULL REFERENCES public.catalogue_reviewer_grants(id),
  reviewer_adult_id text NOT NULL REFERENCES public.adult_users(id),
  authority text NOT NULL CHECK (authority IN ('independent', 'household')),
  decision text NOT NULL CHECK (decision IN ('accepted', 'rejected', 'disputed')),
  reason_code text NOT NULL CHECK (reason_code IN ('matches_clause', 'does_not_match_clause', 'clause_ambiguous', 'other_source_conflicts', 'wrong_policy_or_person')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  clause_ids_json text NOT NULL CHECK (clause_ids_json IS JSON ARRAY),
  source_digests_json text NOT NULL CHECK (source_digests_json IS JSON ARRAY),
  fact_key text NOT NULL CHECK (length(fact_key) = 64),
  fact_json text NOT NULL CHECK (fact_json IS JSON OBJECT AND length(fact_json) <= 16384),
  created_at text NOT NULL,
  UNIQUE (household_id, case_id, idempotency_key)
);

CREATE INDEX catalogue_reviews_case_idx ON public.catalogue_reviews(household_id, case_id, created_at);
CREATE INDEX catalogue_reviews_document_idx ON public.catalogue_reviews(document_id);
CREATE INDEX catalogue_reviewer_grants_household_idx ON public.catalogue_reviewer_grants(household_id, adult_user_id, status);

CREATE FUNCTION public.catalogue_reviews_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    JOIN public.service_cases AS service_case ON service_case.id = NEW.case_id
    JOIN public.catalogue_reviewer_grants AS reviewer_grant ON reviewer_grant.id = NEW.grant_id
    WHERE document.id = NEW.document_id
      AND document.household_id = NEW.household_id
      AND document.case_id = NEW.case_id
      AND document.lifecycle_state = 'active'
      AND service_case.household_id = NEW.household_id
      AND reviewer_grant.household_id = NEW.household_id
      AND reviewer_grant.adult_user_id = NEW.reviewer_adult_id
      AND reviewer_grant.status = 'active'
      AND ((reviewer_grant.kind = 'independent_reviewer' AND NEW.authority = 'independent')
        OR (reviewer_grant.kind = 'household_confirmer' AND NEW.authority = 'household'))
  ) THEN
    RAISE EXCEPTION 'catalogue review must match an active document, case, household and active reviewer grant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalogue_reviews_scope_insert
BEFORE INSERT ON public.catalogue_reviews
FOR EACH ROW EXECUTE FUNCTION public.catalogue_reviews_scope_insert_fn();

CREATE FUNCTION public.catalogue_reviews_immutable_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'catalogue reviews are immutable; erasure deletes them';
END;
$$;

CREATE TRIGGER catalogue_reviews_immutable
BEFORE UPDATE ON public.catalogue_reviews
FOR EACH ROW EXECUTE FUNCTION public.catalogue_reviews_immutable_fn();

CREATE FUNCTION public.catalogue_reviewer_grants_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'household_confirmer' AND NOT EXISTS (
    SELECT 1 FROM public.household_roles AS role
    WHERE role.household_id = NEW.household_id AND role.adult_user_id = NEW.adult_user_id
  ) THEN
    RAISE EXCEPTION 'a household confirmer must hold a role in the household';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER catalogue_reviewer_grants_scope_insert
BEFORE INSERT ON public.catalogue_reviewer_grants
FOR EACH ROW EXECUTE FUNCTION public.catalogue_reviewer_grants_scope_insert_fn();

CREATE FUNCTION public.catalogue_reviews_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.catalogue_reviews WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;

CREATE TRIGGER catalogue_reviews_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.catalogue_reviews_erase_on_document_erasure_fn();
