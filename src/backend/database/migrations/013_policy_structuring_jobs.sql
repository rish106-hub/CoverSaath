-- Durable minimal structuring job state (ADR 0006 addendum). Expand-only: one new table and its guards.
--
--   * policy_structuring_jobs: one row per attempt to structure one document for one workflow run.
--     Identifiers, statuses and codes only: never document text, values or quotes. A process restart
--     turns a running row into interrupted; a new paid attempt then needs an explicit restart request.
--   * At most one queued or running attempt per (workflow run, document), erased or not, so a run in
--     flight is never paid for twice. Attempts are numbered per (workflow run, document).
--   * Identity never changes. A finished row (committed, failed, interrupted) keeps its status; the
--     erasure stamp is set once. DELETE is blocked.
--   * Erasure safety net: a document moving to deletion_requested or deleted stamps its jobs erased.
--
-- Rollback: old code ignores this table; revert code and keep or drop the table on a local database.
-- Mirrored by PostgreSQL migration 010.

CREATE TABLE policy_structuring_jobs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  document_id TEXT NOT NULL REFERENCES document_uploads(id),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  pipeline_version TEXT NOT NULL CHECK (
    length(pipeline_version) BETWEEN 3 AND 128
    AND pipeline_version NOT GLOB '*[^a-z0-9/._+:-]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'committed', 'failed', 'interrupted')),
  evidence_outcome TEXT CHECK (evidence_outcome IS NULL OR evidence_outcome IN ('complete', 'partial_review_required', 'failed')),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 2 AND 64
      AND error_code GLOB '[A-Z]*'
      AND error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 1000),
  consent_grant_id TEXT NOT NULL REFERENCES consent_grants(id),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT,
  structuring_run_id TEXT REFERENCES policy_structuring_runs(id),
  erased_at TEXT,
  erasure_reason_code TEXT,
  CHECK ((status IN ('queued', 'running')) = (finished_at IS NULL)),
  CHECK (structuring_run_id IS NULL OR status = 'committed'),
  CHECK (
    (erased_at IS NULL AND erasure_reason_code IS NULL)
    OR (
      erased_at IS NOT NULL AND erasure_reason_code IS NOT NULL
      AND erased_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND length(erasure_reason_code) BETWEEN 1 AND 64
      AND erasure_reason_code NOT GLOB '*[^a-z0-9_]*'
    )
  )
) STRICT;

CREATE UNIQUE INDEX policy_structuring_jobs_active_uidx
ON policy_structuring_jobs(workflow_run_id, document_id)
WHERE status IN ('queued', 'running');

CREATE UNIQUE INDEX policy_structuring_jobs_attempt_uidx
ON policy_structuring_jobs(workflow_run_id, document_id, attempt);

CREATE INDEX policy_structuring_jobs_status_idx
ON policy_structuring_jobs(status);

CREATE INDEX policy_structuring_jobs_document_idx
ON policy_structuring_jobs(document_id);

-- A job belongs to its workflow run's case and household, to a document of that same case and
-- household, and to a consent grant of that household. New jobs start queued or running, unerased.
CREATE TRIGGER policy_structuring_jobs_scope_insert
BEFORE INSERT ON policy_structuring_jobs
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_runs run
  JOIN service_cases service_case ON service_case.id = run.case_id
  JOIN document_uploads document ON document.id = NEW.document_id
  JOIN consent_grants grant_row ON grant_row.id = NEW.consent_grant_id
  WHERE run.id = NEW.workflow_run_id
    AND service_case.id = NEW.case_id
    AND service_case.household_id = NEW.household_id
    AND document.household_id = NEW.household_id
    AND document.case_id = NEW.case_id
    AND grant_row.household_id = NEW.household_id
)
OR NEW.status NOT IN ('queued', 'running')
OR NEW.erased_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'policy structuring job must start active and match its case, household, document and grant');
END;

-- Identity is immutable, a finished status is final, an erasure stamp is set once.
CREATE TRIGGER policy_structuring_jobs_no_update
BEFORE UPDATE ON policy_structuring_jobs
WHEN NOT (
  NEW.id IS OLD.id
  AND NEW.household_id IS OLD.household_id
  AND NEW.case_id IS OLD.case_id
  AND NEW.workflow_run_id IS OLD.workflow_run_id
  AND NEW.document_id IS OLD.document_id
  AND NEW.source_version IS OLD.source_version
  AND NEW.pipeline_version IS OLD.pipeline_version
  AND NEW.attempt IS OLD.attempt
  AND NEW.consent_grant_id IS OLD.consent_grant_id
  AND NEW.started_at IS OLD.started_at
  AND (OLD.status IN ('queued', 'running') OR (
    NEW.status IS OLD.status
    AND NEW.evidence_outcome IS OLD.evidence_outcome
    AND NEW.error_code IS OLD.error_code
    AND NEW.finished_at IS OLD.finished_at
    AND NEW.structuring_run_id IS OLD.structuring_run_id
  ))
  AND (OLD.erased_at IS NULL OR (NEW.erased_at IS OLD.erased_at AND NEW.erasure_reason_code IS OLD.erasure_reason_code))
)
BEGIN
  SELECT RAISE(ABORT, 'policy structuring jobs are append only');
END;

CREATE TRIGGER policy_structuring_jobs_no_delete
BEFORE DELETE ON policy_structuring_jobs
BEGIN
  SELECT RAISE(ABORT, 'policy structuring jobs are append only');
END;

-- Safety net: a document deletion request stamps its jobs erased (status kept, identifiers only).
CREATE TRIGGER policy_structuring_jobs_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  UPDATE policy_structuring_jobs
  SET erased_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      erasure_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND erased_at IS NULL;
END;
