-- Durable minimal structuring job state (ADR 0006 addendum). Expand-only. Mirrors SQLite migration 013:
-- same table, columns, checks, indexes, trigger names, timing, events and messages.
-- PostgreSQL adds a TRUNCATE guard (003 convention) and revokes TRUNCATE from PUBLIC.
-- Rollback: old code ignores this table; revert code and keep or drop the table on a local database.

CREATE TABLE public.policy_structuring_jobs (
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
  status text NOT NULL CHECK (status IN ('queued', 'running', 'committed', 'failed', 'interrupted')),
  evidence_outcome text CHECK (evidence_outcome IS NULL OR evidence_outcome IN ('complete', 'partial_review_required', 'failed')),
  error_code text CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 2 AND 64
      AND error_code ~ '^[A-Z]'
      AND NOT (error_code ~ '[^A-Z0-9_]')
    )
  ),
  attempt bigint NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  consent_grant_id text NOT NULL REFERENCES public.consent_grants(id),
  started_at text NOT NULL,
  updated_at text NOT NULL,
  finished_at text,
  structuring_run_id text REFERENCES public.policy_structuring_runs(id),
  erased_at text,
  erasure_reason_code text,
  CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL)),
  CHECK (structuring_run_id IS NULL OR status = 'committed'),
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

CREATE UNIQUE INDEX policy_structuring_jobs_active_uidx
ON public.policy_structuring_jobs(workflow_run_id, document_id)
WHERE status IN ('queued', 'running');

CREATE UNIQUE INDEX policy_structuring_jobs_attempt_uidx
ON public.policy_structuring_jobs(workflow_run_id, document_id, attempt);

CREATE INDEX policy_structuring_jobs_status_idx
ON public.policy_structuring_jobs(status);

CREATE INDEX policy_structuring_jobs_document_idx
ON public.policy_structuring_jobs(document_id);

CREATE FUNCTION public.policy_structuring_jobs_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM public.workflow_runs AS run
    JOIN public.service_cases AS service_case ON service_case.id = run.case_id
    JOIN public.document_uploads AS document ON document.id = NEW.document_id
    JOIN public.consent_grants AS grant_row ON grant_row.id = NEW.consent_grant_id
    WHERE run.id = NEW.workflow_run_id
      AND service_case.id = NEW.case_id
      AND service_case.household_id = NEW.household_id
      AND document.household_id = NEW.household_id
      AND document.case_id = NEW.case_id
      AND grant_row.household_id = NEW.household_id
  ) OR NEW.status NOT IN ('queued', 'running') OR NEW.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'policy structuring job must start active and match its case, household, document and grant';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER policy_structuring_jobs_scope_insert
BEFORE INSERT ON public.policy_structuring_jobs
FOR EACH ROW EXECUTE FUNCTION public.policy_structuring_jobs_scope_insert_fn();

CREATE FUNCTION public.policy_structuring_jobs_append_only_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'policy structuring jobs are append only';
END;
$$;

CREATE TRIGGER policy_structuring_jobs_no_update
BEFORE UPDATE ON public.policy_structuring_jobs
FOR EACH ROW
WHEN (NOT (
  NEW.id IS NOT DISTINCT FROM OLD.id
  AND NEW.household_id IS NOT DISTINCT FROM OLD.household_id
  AND NEW.case_id IS NOT DISTINCT FROM OLD.case_id
  AND NEW.workflow_run_id IS NOT DISTINCT FROM OLD.workflow_run_id
  AND NEW.document_id IS NOT DISTINCT FROM OLD.document_id
  AND NEW.source_version IS NOT DISTINCT FROM OLD.source_version
  AND NEW.pipeline_version IS NOT DISTINCT FROM OLD.pipeline_version
  AND NEW.attempt IS NOT DISTINCT FROM OLD.attempt
  AND NEW.consent_grant_id IS NOT DISTINCT FROM OLD.consent_grant_id
  AND NEW.started_at IS NOT DISTINCT FROM OLD.started_at
  AND (OLD.status IN ('queued', 'running') OR (
    NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.evidence_outcome IS NOT DISTINCT FROM OLD.evidence_outcome
    AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
    AND NEW.finished_at IS NOT DISTINCT FROM OLD.finished_at
    AND NEW.structuring_run_id IS NOT DISTINCT FROM OLD.structuring_run_id
  ))
  AND (OLD.erased_at IS NULL OR (
    NEW.erased_at IS NOT DISTINCT FROM OLD.erased_at
    AND NEW.erasure_reason_code IS NOT DISTINCT FROM OLD.erasure_reason_code
  ))
))
EXECUTE FUNCTION public.policy_structuring_jobs_append_only_fn();

CREATE TRIGGER policy_structuring_jobs_no_delete
BEFORE DELETE ON public.policy_structuring_jobs
FOR EACH ROW EXECUTE FUNCTION public.policy_structuring_jobs_append_only_fn();

CREATE TRIGGER policy_structuring_jobs_no_truncate
BEFORE TRUNCATE ON public.policy_structuring_jobs
FOR EACH STATEMENT EXECUTE FUNCTION public.policy_structuring_jobs_append_only_fn();

-- Safety net: a document deletion request stamps its jobs erased (status kept, identifiers only).
CREATE FUNCTION public.policy_structuring_jobs_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.policy_structuring_jobs
  SET erased_at = public.coversaath_utc_now(),
      erasure_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND erased_at IS NULL;
  RETURN NULL;
END;
$$;

CREATE TRIGGER policy_structuring_jobs_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON public.document_uploads
FOR EACH ROW
WHEN (NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted'))
EXECUTE FUNCTION public.policy_structuring_jobs_erase_on_document_erasure_fn();

REVOKE TRUNCATE ON TABLE public.policy_structuring_jobs FROM PUBLIC;
