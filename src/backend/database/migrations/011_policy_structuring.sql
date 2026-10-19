-- Policy document structuring (ADR 0006). Expand-only: two new tables and their guards.
--
--   * policy_structuring_runs: one row per committed structuring of one document version for one
--     workflow run and pipeline version. Counts only, never values. The single permitted update is
--     the erasure stamp (erased_at / erasure_reason_code); a live (unerased) identity is unique, so a
--     replayed commit finds the stored row instead of writing twice.
--   * proposed_parameters: values the model found that do not map to a registry key. They are
--     proposals for human review, never parameter values. Inserted pending_review and unredacted;
--     afterwards only a review status change (on unredacted rows) or the redaction carve-out
--     (label and value nulled, redaction stamped) is permitted. DELETE is blocked.
--   * Erasure safety net: a document moving to deletion_requested or deleted redacts its proposals
--     and stamps its structuring runs erased. Repository erasure runs first and adds the audit event.
-- Mirrored by PostgreSQL migration 007.

CREATE TABLE policy_structuring_runs (
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
  counts_json TEXT NOT NULL CHECK (
    json_valid(counts_json) AND json_type(counts_json) = 'object' AND length(counts_json) <= 4096
  ),
  created_at TEXT NOT NULL,
  erased_at TEXT,
  erasure_reason_code TEXT,
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

CREATE UNIQUE INDEX policy_structuring_runs_live_identity_uidx
ON policy_structuring_runs(workflow_run_id, document_id, source_version, pipeline_version)
WHERE erased_at IS NULL;

CREATE INDEX policy_structuring_runs_document_idx
ON policy_structuring_runs(document_id, created_at);

CREATE TABLE proposed_parameters (
  id TEXT PRIMARY KEY,
  structuring_run_id TEXT NOT NULL REFERENCES policy_structuring_runs(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  document_id TEXT NOT NULL REFERENCES document_uploads(id),
  source_page_id TEXT NOT NULL REFERENCES source_pages(id),
  registry_version TEXT NOT NULL REFERENCES coverage_parameter_registry_versions(version),
  proposed_key TEXT NOT NULL CHECK (
    length(proposed_key) BETWEEN 3 AND 64
    AND proposed_key GLOB '[a-z]*'
    AND proposed_key NOT GLOB '*[^a-z0-9_]*'
  ),
  category TEXT NOT NULL CHECK (category IN (
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'unassigned'
  )),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 120),
  value_json TEXT CHECK (value_json IS NULL OR (json_valid(value_json) AND length(value_json) <= 16384)),
  page INTEGER NOT NULL CHECK (page > 0),
  block_index INTEGER NOT NULL CHECK (block_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending_review', 'accepted', 'rejected')),
  created_at TEXT NOT NULL,
  redacted_at TEXT,
  redaction_reason_code TEXT,
  CHECK (
    (redacted_at IS NULL AND redaction_reason_code IS NULL AND label IS NOT NULL AND value_json IS NOT NULL)
    OR (
      redacted_at IS NOT NULL AND redaction_reason_code IS NOT NULL AND label IS NULL AND value_json IS NULL
      AND redacted_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
      AND length(redaction_reason_code) BETWEEN 1 AND 64
      AND redaction_reason_code NOT GLOB '*[^a-z0-9_]*'
    )
  )
) STRICT;

CREATE INDEX proposed_parameters_document_idx
ON proposed_parameters(document_id, page, block_index);

CREATE INDEX proposed_parameters_run_idx
ON proposed_parameters(structuring_run_id);

-- A structuring run belongs to its workflow run's case and household, and to a document of that
-- same case and household.
CREATE TRIGGER policy_structuring_runs_scope_insert
BEFORE INSERT ON policy_structuring_runs
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_runs run
  JOIN service_cases service_case ON service_case.id = run.case_id
  JOIN document_uploads document ON document.id = NEW.document_id
  WHERE run.id = NEW.workflow_run_id
    AND service_case.id = NEW.case_id
    AND service_case.household_id = NEW.household_id
    AND document.household_id = NEW.household_id
    AND document.case_id = NEW.case_id
)
BEGIN
  SELECT RAISE(ABORT, 'policy structuring run must match its workflow case, household and document');
END;

CREATE TRIGGER policy_structuring_runs_active_document_insert
BEFORE INSERT ON policy_structuring_runs
WHEN NOT EXISTS (
  SELECT 1 FROM document_uploads document
  WHERE document.id = NEW.document_id AND document.lifecycle_state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'policy structuring requires an active document');
END;

CREATE TRIGGER policy_structuring_runs_erased_insert
BEFORE INSERT ON policy_structuring_runs
WHEN NEW.erased_at IS NOT NULL OR NEW.erasure_reason_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'policy structuring runs cannot be inserted erased');
END;

-- The single permitted update stamps erasure once; every other column is unchanged.
CREATE TRIGGER policy_structuring_runs_no_update
BEFORE UPDATE ON policy_structuring_runs
WHEN NOT (
  OLD.erased_at IS NULL
  AND NEW.erased_at IS NOT NULL
  AND NEW.erasure_reason_code IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.household_id IS OLD.household_id
  AND NEW.case_id IS OLD.case_id
  AND NEW.workflow_run_id IS OLD.workflow_run_id
  AND NEW.document_id IS OLD.document_id
  AND NEW.source_version IS OLD.source_version
  AND NEW.pipeline_version IS OLD.pipeline_version
  AND NEW.counts_json IS OLD.counts_json
  AND NEW.created_at IS OLD.created_at
)
BEGIN
  SELECT RAISE(ABORT, 'policy structuring runs are append only');
END;

CREATE TRIGGER policy_structuring_runs_no_delete
BEFORE DELETE ON policy_structuring_runs
BEGIN
  SELECT RAISE(ABORT, 'policy structuring runs are append only');
END;

-- A proposal cites a page of its run's document version, in the same household, and the run is live.
CREATE TRIGGER proposed_parameters_scope_insert
BEFORE INSERT ON proposed_parameters
WHEN NOT EXISTS (
  SELECT 1
  FROM policy_structuring_runs structuring
  JOIN document_uploads document ON document.id = NEW.document_id
  JOIN source_pages page ON page.id = NEW.source_page_id
  WHERE structuring.id = NEW.structuring_run_id
    AND structuring.erased_at IS NULL
    AND structuring.document_id = NEW.document_id
    AND structuring.household_id = NEW.household_id
    AND document.household_id = NEW.household_id
    AND page.document_upload_id = NEW.document_id
    AND page.source_version = structuring.source_version
    AND page.page_number = NEW.page
)
BEGIN
  SELECT RAISE(ABORT, 'proposed parameter must match its structuring run, household and document page');
END;

CREATE TRIGGER proposed_parameters_active_document_insert
BEFORE INSERT ON proposed_parameters
WHEN NOT EXISTS (
  SELECT 1 FROM document_uploads document
  WHERE document.id = NEW.document_id AND document.lifecycle_state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'proposed parameters require an active document');
END;

CREATE TRIGGER proposed_parameters_initial_state_insert
BEFORE INSERT ON proposed_parameters
WHEN NEW.status <> 'pending_review' OR NEW.redacted_at IS NOT NULL OR NEW.redaction_reason_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'proposed parameters are inserted pending review and unredacted');
END;

-- Two permitted updates, both with identity and provenance unchanged:
--   * redaction: label and value nulled, redaction stamped once, status unchanged;
--   * review: status changed on an unredacted row, label and value unchanged.
CREATE TRIGGER proposed_parameters_no_update
BEFORE UPDATE ON proposed_parameters
WHEN NOT (
  OLD.redacted_at IS NULL
  AND NEW.id IS OLD.id
  AND NEW.structuring_run_id IS OLD.structuring_run_id
  AND NEW.household_id IS OLD.household_id
  AND NEW.document_id IS OLD.document_id
  AND NEW.source_page_id IS OLD.source_page_id
  AND NEW.registry_version IS OLD.registry_version
  AND NEW.proposed_key IS OLD.proposed_key
  AND NEW.category IS OLD.category
  AND NEW.page IS OLD.page
  AND NEW.block_index IS OLD.block_index
  AND NEW.created_at IS OLD.created_at
  AND (
    (
      NEW.redacted_at IS NOT NULL
      AND NEW.redaction_reason_code IS NOT NULL
      AND NEW.label IS NULL
      AND NEW.value_json IS NULL
      AND NEW.status IS OLD.status
    )
    OR (
      NEW.redacted_at IS NULL
      AND NEW.redaction_reason_code IS NULL
      AND NEW.label IS OLD.label
      AND NEW.value_json IS OLD.value_json
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'proposed parameters are append only');
END;

CREATE TRIGGER proposed_parameters_no_delete
BEFORE DELETE ON proposed_parameters
BEGIN
  SELECT RAISE(ABORT, 'proposed parameters are append only');
END;

-- Safety net: proposals can never outlive a document deletion request or consent revocation, and
-- the document's structuring runs are marked erased so a later commit starts a new identity.
CREATE TRIGGER policy_structuring_erase_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  UPDATE proposed_parameters
  SET label = NULL, value_json = NULL,
      redacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      redaction_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND redacted_at IS NULL;
  UPDATE policy_structuring_runs
  SET erased_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      erasure_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND erased_at IS NULL;
END;
