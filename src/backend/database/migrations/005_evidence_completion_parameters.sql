-- Expand-only persistence for version-pinned coverage parameter completion.
-- Existing workflow and evidence records remain unchanged and readable.

CREATE TABLE coverage_parameter_registry_pins (
  workflow_run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  registry_version TEXT NOT NULL CHECK (registry_version = 'policy-parameters/v1'),
  pinned_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, registry_version)
) STRICT;

CREATE TABLE coverage_parameter_records (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  registry_version TEXT NOT NULL,
  parameter_key TEXT NOT NULL CHECK (
    length(parameter_key) BETWEEN 3 AND 128
    AND substr(parameter_key, 1, 1) BETWEEN 'a' AND 'k'
    AND substr(parameter_key, 2, 1) = '.'
    AND substr(parameter_key, 3) NOT GLOB '*[^a-z0-9_]*'
  ),
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  subject_id TEXT NOT NULL REFERENCES household_members(id),
  policy_id TEXT NOT NULL REFERENCES policies(id),
  applicable INTEGER NOT NULL DEFAULT 1 CHECK (applicable IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, parameter_key),
  FOREIGN KEY (workflow_run_id, registry_version)
    REFERENCES coverage_parameter_registry_pins(workflow_run_id, registry_version)
) STRICT;

CREATE TABLE coverage_parameter_acquisitions (
  parameter_record_id TEXT PRIMARY KEY REFERENCES coverage_parameter_records(id),
  acquisition_state TEXT NOT NULL CHECK (acquisition_state IN (
    'not_requested', 'requested', 'received', 'rejected', 'not_permitted'
  )),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  requested_at TEXT,
  received_at TEXT,
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  CHECK (acquisition_state <> 'requested' OR requested_at IS NOT NULL),
  CHECK (acquisition_state <> 'received' OR received_at IS NOT NULL)
) STRICT;

CREATE TABLE coverage_parameter_observations (
  id TEXT PRIMARY KEY,
  parameter_record_id TEXT NOT NULL REFERENCES coverage_parameter_records(id),
  source_id TEXT NOT NULL REFERENCES source_pages(id),
  document_id TEXT NOT NULL REFERENCES document_uploads(id),
  version TEXT NOT NULL CHECK (length(version) BETWEEN 1 AND 128),
  page TEXT NOT NULL CHECK (length(page) BETWEEN 1 AND 64),
  extraction_method TEXT NOT NULL CHECK (extraction_method IN (
    'deterministic_calculation', 'document_extraction', 'human_report', 'human_review',
    'official_source_lookup'
  )),
  review_status TEXT NOT NULL CHECK (review_status IN (
    'not_reviewed', 'accepted', 'rejected', 'superseded'
  )),
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'
  ),
  observed_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE coverage_parameter_resolutions (
  parameter_record_id TEXT PRIMARY KEY REFERENCES coverage_parameter_records(id),
  resolution_state TEXT NOT NULL CHECK (resolution_state IN (
    'unknown', 'reported', 'extracted_unverified', 'proven', 'calculated',
    'dynamic', 'conflicting', 'not_permitted'
  )),
  resolved_value_json TEXT CHECK (resolved_value_json IS NULL OR json_valid(resolved_value_json)),
  resolved_observation_id TEXT REFERENCES coverage_parameter_observations(id),
  reason_code TEXT CHECK (reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 128),
  transition_authority TEXT NOT NULL CHECK (transition_authority IN (
    'deterministic', 'human_reviewer', 'model', 'official_source'
  )),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  CHECK (
    (resolution_state IN ('unknown', 'conflicting', 'not_permitted')
      AND resolved_value_json IS NULL AND resolved_observation_id IS NULL)
    OR
    (resolution_state IN ('reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic')
      AND resolved_value_json IS NOT NULL AND resolved_observation_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX coverage_parameter_records_run_idx
ON coverage_parameter_records(workflow_run_id, parameter_key);

CREATE INDEX coverage_parameter_records_case_idx
ON coverage_parameter_records(case_id, registry_version, parameter_key);

CREATE INDEX coverage_parameter_observations_parameter_idx
ON coverage_parameter_observations(parameter_record_id, observed_at, id);

CREATE INDEX coverage_parameter_observations_document_idx
ON coverage_parameter_observations(document_id, version, page);

CREATE TRIGGER coverage_parameter_records_scope_insert
BEFORE INSERT ON coverage_parameter_records
WHEN NOT EXISTS (
  SELECT 1
  FROM workflow_runs run
  JOIN service_cases service_case ON service_case.id = run.case_id
  WHERE run.id = NEW.workflow_run_id
    AND service_case.id = NEW.case_id
    AND service_case.household_id = NEW.household_id
    AND EXISTS (
      SELECT 1 FROM household_members member
      WHERE member.id = NEW.subject_id AND member.household_id = NEW.household_id
    )
    AND EXISTS (
      SELECT 1 FROM policies policy
      WHERE policy.id = NEW.policy_id AND policy.household_id = NEW.household_id
    )
)
BEGIN
  SELECT RAISE(ABORT, 'coverage parameter must match its workflow case and household');
END;

CREATE TRIGGER coverage_parameter_records_identity_immutable
BEFORE UPDATE OF workflow_run_id, registry_version, parameter_key, household_id, case_id,
  subject_id, policy_id ON coverage_parameter_records
BEGIN
  SELECT RAISE(ABORT, 'coverage parameter identity is immutable');
END;

CREATE TRIGGER coverage_parameter_observations_source_insert
BEFORE INSERT ON coverage_parameter_observations
WHEN NOT EXISTS (
  SELECT 1
  FROM coverage_parameter_records parameter
  JOIN source_pages page ON page.id = NEW.source_id
  JOIN document_uploads document ON document.id = page.document_upload_id
  WHERE parameter.id = NEW.parameter_record_id
    AND document.id = NEW.document_id
    AND document.household_id = parameter.household_id
    AND document.case_id = parameter.case_id
    AND page.source_version = NEW.version
    AND CAST(page.page_number AS TEXT) = NEW.page
)
BEGIN
  SELECT RAISE(ABORT, 'parameter observation source must match its case and document page');
END;

CREATE TRIGGER coverage_parameter_observations_no_update
BEFORE UPDATE ON coverage_parameter_observations
BEGIN
  SELECT RAISE(ABORT, 'coverage parameter observations are append only');
END;

CREATE TRIGGER coverage_parameter_observations_no_delete
BEFORE DELETE ON coverage_parameter_observations
BEGIN
  SELECT RAISE(ABORT, 'coverage parameter observations are append only');
END;

CREATE TRIGGER coverage_parameter_resolutions_observation_insert
BEFORE INSERT ON coverage_parameter_resolutions
WHEN NEW.resolved_observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM coverage_parameter_observations observation
  WHERE observation.id = NEW.resolved_observation_id
    AND observation.parameter_record_id = NEW.parameter_record_id
)
BEGIN
  SELECT RAISE(ABORT, 'resolved observation must belong to the parameter');
END;

CREATE TRIGGER coverage_parameter_resolutions_observation_update
BEFORE UPDATE OF parameter_record_id, resolved_observation_id ON coverage_parameter_resolutions
WHEN NEW.resolved_observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM coverage_parameter_observations observation
  WHERE observation.id = NEW.resolved_observation_id
    AND observation.parameter_record_id = NEW.parameter_record_id
)
BEGIN
  SELECT RAISE(ABORT, 'resolved observation must belong to the parameter');
END;
