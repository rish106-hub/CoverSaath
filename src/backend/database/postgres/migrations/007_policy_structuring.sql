-- Policy document structuring (ADR 0006). Expand-only. Mirrors SQLite migration 011:
-- same tables, columns, checks, indexes, trigger names, timing, events and messages.
-- PostgreSQL adds TRUNCATE guards (003 convention) and revokes TRUNCATE from PUBLIC.

CREATE TABLE public.policy_structuring_runs (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES public.households(id),
  case_id text NOT NULL REFERENCES public.service_cases(id),
  workflow_run_id text NOT NULL REFERENCES public.workflow_runs(id),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_version text NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  pipeline_version text NOT NULL CHECK (
    length(pipeline_version) BETWEEN 3 AND 128
    AND NOT (pipeline_version ~ '[^a-z0-9/._+:-]')
  ),
  counts_json text NOT NULL CHECK (
    counts_json IS JSON OBJECT AND length(counts_json) <= 4096
  ),
  created_at text NOT NULL,
  erased_at text,
  erasure_reason_code text,
  CHECK (
    (erased_at IS NULL AND erasure_reason_code IS NULL)
    OR (
      erased_at IS NOT NULL AND erasure_reason_code IS NOT NULL
      AND erased_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND length(erasure_reason_code) BETWEEN 1 AND 64
      AND NOT (erasure_reason_code ~ '[^a-z0-9_]')
    )
  )
);

CREATE UNIQUE INDEX policy_structuring_runs_live_identity_uidx
ON public.policy_structuring_runs(workflow_run_id, document_id, source_version, pipeline_version)
WHERE erased_at IS NULL;

CREATE INDEX policy_structuring_runs_document_idx
ON public.policy_structuring_runs(document_id, created_at);

CREATE TABLE public.proposed_parameters (
  id text PRIMARY KEY,
  structuring_run_id text NOT NULL REFERENCES public.policy_structuring_runs(id),
  household_id text NOT NULL REFERENCES public.households(id),
  document_id text NOT NULL REFERENCES public.document_uploads(id),
  source_page_id text NOT NULL REFERENCES public.source_pages(id),
  registry_version text NOT NULL REFERENCES public.coverage_parameter_registry_versions(version),
  proposed_key text NOT NULL CHECK (
    length(proposed_key) BETWEEN 3 AND 64
    AND proposed_key ~ '^[a-z]'
    AND NOT (proposed_key ~ '[^a-z0-9_]')
  ),
  category text NOT NULL CHECK (category IN (
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'unassigned'
  )),
  label text CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
  value_json text CHECK (value_json IS NULL OR (value_json IS JSON AND length(value_json) <= 16384)),
  page bigint NOT NULL CHECK (page > 0),
  block_index bigint NOT NULL CHECK (block_index >= 0),
  status text NOT NULL CHECK (status IN ('pending_review', 'accepted', 'rejected')),
  created_at text NOT NULL,
  redacted_at text,
  redaction_reason_code text,
  CHECK (
    (redacted_at IS NULL AND redaction_reason_code IS NULL AND label IS NOT NULL AND value_json IS NOT NULL)
    OR (
      redacted_at IS NOT NULL AND redaction_reason_code IS NOT NULL AND label IS NULL AND value_json IS NULL
      AND redacted_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      AND length(redaction_reason_code) BETWEEN 1 AND 64
      AND NOT (redaction_reason_code ~ '[^a-z0-9_]')
    )
  )
);

CREATE INDEX proposed_parameters_document_idx
ON public.proposed_parameters(document_id, page, block_index);

CREATE INDEX proposed_parameters_run_idx
ON public.proposed_parameters(structuring_run_id);

-- Structuring runs.
CREATE FUNCTION public.policy_structuring_runs_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_runs AS run
    JOIN public.service_cases AS service_case ON service_case.id = run.case_id
    JOIN public.document_uploads AS document ON document.id = NEW.document_id
    WHERE run.id = NEW.workflow_run_id
      AND service_case.id = NEW.case_id
      AND service_case.household_id = NEW.household_id
      AND document.household_id = NEW.household_id
      AND document.case_id = NEW.case_id
  ) THEN
    RAISE EXCEPTION 'policy structuring run must match its workflow case, household and document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_structuring_runs_scope_insert
BEFORE INSERT ON public.policy_structuring_runs
FOR EACH ROW EXECUTE FUNCTION public.policy_structuring_runs_scope_insert_fn();

CREATE FUNCTION public.policy_structuring_runs_active_document_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.document_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'policy structuring requires an active document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_structuring_runs_active_document_insert
BEFORE INSERT ON public.policy_structuring_runs
FOR EACH ROW EXECUTE FUNCTION public.policy_structuring_runs_active_document_insert_fn();

CREATE FUNCTION public.policy_structuring_runs_erased_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'policy structuring runs cannot be inserted erased';
END;
$$;

CREATE TRIGGER policy_structuring_runs_erased_insert
BEFORE INSERT ON public.policy_structuring_runs
FOR EACH ROW
WHEN (NEW.erased_at IS NOT NULL OR NEW.erasure_reason_code IS NOT NULL)
EXECUTE FUNCTION public.policy_structuring_runs_erased_insert_fn();

CREATE FUNCTION public.policy_structuring_runs_append_only_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'policy structuring runs are append only';
END;
$$;

CREATE TRIGGER policy_structuring_runs_no_update
BEFORE UPDATE ON public.policy_structuring_runs
FOR EACH ROW
WHEN (NOT (
  OLD.erased_at IS NULL
  AND NEW.erased_at IS NOT NULL
  AND NEW.erasure_reason_code IS NOT NULL
  AND NEW.id IS NOT DISTINCT FROM OLD.id
  AND NEW.household_id IS NOT DISTINCT FROM OLD.household_id
  AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
  AND NEW.workflow_run_id IS NOT DISTINCT FROM OLD.workflow_run_id
  AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id
  AND NEW.source_version IS NOT DISTINCT FROM OLD.source_version
  AND NEW.pipeline_version IS NOT DISTINCT FROM OLD.pipeline_version
  AND NEW.counts_json IS NOT DISTINCT FROM OLD.counts_json
  AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
))
EXECUTE FUNCTION public.policy_structuring_runs_append_only_fn();

CREATE TRIGGER policy_structuring_runs_no_delete
BEFORE DELETE ON public.policy_structuring_runs
FOR EACH ROW EXECUTE FUNCTION public.policy_structuring_runs_append_only_fn();

CREATE TRIGGER policy_structuring_runs_no_truncate
BEFORE TRUNCATE ON public.policy_structuring_runs
FOR EACH STATEMENT EXECUTE FUNCTION public.policy_structuring_runs_append_only_fn();

-- Proposed parameters.
CREATE FUNCTION public.proposed_parameters_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.policy_structuring_runs AS structuring
    JOIN public.document_uploads AS document ON document.id = NEW.document_id
    JOIN public.source_pages AS page ON page.id = NEW.source_page_id
    WHERE structuring.id = NEW.structuring_run_id
      AND structuring.erased_at IS NULL
      AND structuring.document_id = NEW.document_id
      AND structuring.household_id = NEW.household_id
      AND document.household_id = NEW.household_id
      AND page.document_upload_id = NEW.document_id
      AND page.source_version = structuring.source_version
      AND page.page_number = NEW.page
  ) THEN
    RAISE EXCEPTION 'proposed parameter must match its structuring run, household and document page';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER proposed_parameters_scope_insert
BEFORE INSERT ON public.proposed_parameters
FOR EACH ROW EXECUTE FUNCTION public.proposed_parameters_scope_insert_fn();

CREATE FUNCTION public.proposed_parameters_active_document_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.document_uploads AS document
    WHERE document.id = NEW.document_id AND document.lifecycle_state = 'active'
  ) THEN
    RAISE EXCEPTION 'proposed parameters require an active document';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER proposed_parameters_active_document_insert
BEFORE INSERT ON public.proposed_parameters
FOR EACH ROW EXECUTE FUNCTION public.proposed_parameters_active_document_insert_fn();

CREATE FUNCTION public.proposed_parameters_initial_state_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'proposed parameters are inserted pending review and unredacted';
END;
$$;

CREATE TRIGGER proposed_parameters_initial_state_insert
BEFORE INSERT ON public.proposed_parameters
FOR EACH ROW
WHEN (NEW.status <> 'pending_review' OR NEW.redacted_at IS NOT NULL OR NEW.redaction_reason_code IS NOT NULL)
EXECUTE FUNCTION public.proposed_parameters_initial_state_insert_fn();

CREATE FUNCTION public.proposed_parameters_append_only_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'proposed parameters are append only';
END;
$$;

CREATE TRIGGER proposed_parameters_no_update
BEFORE UPDATE ON public.proposed_parameters
FOR EACH ROW
WHEN (NOT (
  OLD.redacted_at IS NULL
  AND NEW.id IS NOT DISTINCT FROM OLD.id
  AND NEW.structuring_run_id IS NOT DISTINCT FROM OLD.structuring_run_id
  AND NEW.household_id IS NOT DISTINCT FROM OLD.household_id
  AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id
  AND NEW.source_page_id IS NOT DISTINCT FROM OLD.source_page_id
  AND NEW.registry_version IS NOT DISTINCT FROM OLD.registry_version
  AND NEW.proposed_key IS NOT DISTINCT FROM OLD.proposed_key
  AND NEW.category IS NOT DISTINCT FROM OLD.category
  AND NEW.page IS NOT DISTINCT FROM OLD.page
  AND NEW.block_index IS NOT DISTINCT FROM OLD.block_index
  AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  AND (
    (
      NEW.redacted_at IS NOT NULL
      AND NEW.redaction_reason_code IS NOT NULL
      AND NEW.label IS NULL
      AND NEW.value_json IS NULL
      AND NEW.status IS NOT DISTINCT FROM OLD.status
    )
    OR (
      NEW.redacted_at IS NULL
      AND NEW.redaction_reason_code IS NULL
      AND NEW.label IS NOT DISTINCT FROM OLD.label
      AND NEW.value_json IS NOT DISTINCT FROM OLD.value_json
    )
  )
))
EXECUTE FUNCTION public.proposed_parameters_append_only_fn();

CREATE TRIGGER proposed_parameters_no_delete
BEFORE DELETE ON public.proposed_parameters
FOR EACH ROW EXECUTE FUNCTION public.proposed_parameters_append_only_fn();

CREATE TRIGGER proposed_parameters_no_truncate
BEFORE TRUNCATE ON public.proposed_parameters
FOR EACH STATEMENT EXECUTE FUNCTION public.proposed_parameters_append_only_fn();

-- Safety net: document erasure redacts proposals and marks structuring runs erased.
CREATE FUNCTION public.policy_structuring_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.proposed_parameters
  SET label = NULL, value_json = NULL,
      redacted_at = public.coversaath_utc_now(),
      redaction_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND redacted_at IS NULL;
  UPDATE public.policy_structuring_runs
  SET erased_at = public.coversaath_utc_now(),
      erasure_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND erased_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER policy_structuring_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.policy_structuring_erase_on_document_erasure_fn();

REVOKE TRUNCATE ON TABLE public.policy_structuring_runs, public.proposed_parameters FROM PUBLIC;
