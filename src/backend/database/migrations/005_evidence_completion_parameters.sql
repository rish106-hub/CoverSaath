-- Expand-only persistence for version-pinned coverage parameter completion.
-- Existing workflow and evidence records remain unchanged and readable.
--
-- Authority model (kept in step with src/modules/coverage-analysis/parameter-records.js):
--   * A resolved value is always backed by one observation. The resolution state and
--     transition authority must match a row of coverage_parameter_observation_rules for
--     that observation's extraction method, so authority is a property of the evidence
--     and not a label a caller can choose.
--   * Model authority can only ever produce unknown, extracted_unverified or conflicting.
--
-- Erasure model: observations are append-only except for one redaction update that nulls
-- the extracted value and records when and why. Ids, provenance and digests are kept for audit.

CREATE TABLE coverage_parameter_registry_versions (
  version TEXT PRIMARY KEY CHECK (
    length(version) BETWEEN 3 AND 64
    AND version GLOB 'policy-parameters/v[0-9]*'
    AND version NOT GLOB '*[^a-z0-9/.-]*'
  ),
  registered_at TEXT NOT NULL
) STRICT;

-- A new registry version is a new row here plus an entry in the application registry;
-- no table rebuild is needed. Unknown versions still fail closed in the repository.
INSERT INTO coverage_parameter_registry_versions (version, registered_at)
VALUES ('policy-parameters/v1', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE coverage_parameter_registry_pins (
  workflow_run_id TEXT PRIMARY KEY REFERENCES workflow_runs(id),
  registry_version TEXT NOT NULL REFERENCES coverage_parameter_registry_versions(version),
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
  CHECK (acquisition_state <> 'received' OR (received_at IS NOT NULL AND requested_at IS NOT NULL))
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
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  source_digest TEXT NOT NULL CHECK (
    length(source_digest) = 64 AND source_digest NOT GLOB '*[^a-f0-9]*'
  ),
  observed_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  redacted_at TEXT,
  redaction_reason_code TEXT CHECK (
    redaction_reason_code IS NULL OR (
      length(redaction_reason_code) BETWEEN 1 AND 64
      AND redaction_reason_code NOT GLOB '*[^a-z0-9_]*'
    )
  ),
  CHECK (
    (redacted_at IS NULL AND redaction_reason_code IS NULL AND value_json IS NOT NULL)
    OR (redacted_at IS NOT NULL AND redaction_reason_code IS NOT NULL AND value_json IS NULL)
  )
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
    transition_authority <> 'model'
    OR resolution_state IN ('unknown', 'extracted_unverified', 'conflicting')
  ),
  CHECK (
    (resolution_state IN ('unknown', 'conflicting', 'not_permitted')
      AND resolved_value_json IS NULL AND resolved_observation_id IS NULL)
    OR
    (resolution_state IN ('reported', 'extracted_unverified', 'proven', 'calculated', 'dynamic')
      AND resolved_value_json IS NOT NULL AND resolved_observation_id IS NOT NULL)
  )
) STRICT;

-- Which observation methods may establish which resolution state, under which authority.
-- Mirrors OBSERVATION_RESOLUTION_RULES in parameter-records.js; a test keeps them identical.
CREATE TABLE coverage_parameter_observation_rules (
  extraction_method TEXT NOT NULL,
  resolution_state TEXT NOT NULL,
  transition_authority TEXT NOT NULL CHECK (transition_authority IN (
    'deterministic', 'human_reviewer', 'model', 'official_source'
  )),
  requires_accepted INTEGER NOT NULL CHECK (requires_accepted IN (0, 1)),
  PRIMARY KEY (extraction_method, resolution_state),
  CHECK (transition_authority <> 'model' OR resolution_state = 'extracted_unverified')
) STRICT;

INSERT INTO coverage_parameter_observation_rules
  (extraction_method, resolution_state, transition_authority, requires_accepted)
VALUES
  ('document_extraction', 'extracted_unverified', 'model', 0),
  ('human_report', 'reported', 'deterministic', 0),
  ('human_review', 'reported', 'human_reviewer', 0),
  ('human_review', 'proven', 'human_reviewer', 1),
  ('official_source_lookup', 'proven', 'official_source', 1),
  ('official_source_lookup', 'dynamic', 'official_source', 0),
  ('deterministic_calculation', 'calculated', 'deterministic', 0),
  ('deterministic_calculation', 'dynamic', 'deterministic', 0);

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

-- Observations are append-only. The single permitted update is redaction: it nulls the
-- extracted value and stamps redacted_at / redaction_reason_code. Every other column,
-- including ids, provenance, digest and review status, must be unchanged.
CREATE TRIGGER coverage_parameter_observations_no_update
BEFORE UPDATE ON coverage_parameter_observations
WHEN NOT (
  OLD.redacted_at IS NULL
  AND NEW.redacted_at IS NOT NULL
  AND NEW.value_json IS NULL
  AND NEW.redaction_reason_code IS NOT NULL
  AND NEW.id IS OLD.id
  AND NEW.parameter_record_id IS OLD.parameter_record_id
  AND NEW.source_id IS OLD.source_id
  AND NEW.document_id IS OLD.document_id
  AND NEW.version IS OLD.version
  AND NEW.page IS OLD.page
  AND NEW.extraction_method IS OLD.extraction_method
  AND NEW.review_status IS OLD.review_status
  AND NEW.source_digest IS OLD.source_digest
  AND NEW.observed_at IS OLD.observed_at
  AND NEW.recorded_by IS OLD.recorded_by
  AND NEW.created_at IS OLD.created_at
)
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

-- Authority is derived from the selected observation, never from the caller.
CREATE TRIGGER coverage_parameter_resolutions_authority_insert
BEFORE INSERT ON coverage_parameter_resolutions
WHEN NEW.resolved_observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM coverage_parameter_observations observation
  JOIN coverage_parameter_observation_rules rule
    ON rule.extraction_method = observation.extraction_method
  WHERE observation.id = NEW.resolved_observation_id
    AND observation.redacted_at IS NULL
    AND observation.review_status IN ('not_reviewed', 'accepted')
    AND rule.resolution_state = NEW.resolution_state
    AND rule.transition_authority = NEW.transition_authority
    AND (rule.requires_accepted = 0 OR observation.review_status = 'accepted')
)
BEGIN
  SELECT RAISE(ABORT, 'resolution state and authority are not supported by the observation');
END;

CREATE TRIGGER coverage_parameter_resolutions_authority_update
BEFORE UPDATE ON coverage_parameter_resolutions
WHEN NEW.resolved_observation_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM coverage_parameter_observations observation
  JOIN coverage_parameter_observation_rules rule
    ON rule.extraction_method = observation.extraction_method
  WHERE observation.id = NEW.resolved_observation_id
    AND observation.redacted_at IS NULL
    AND observation.review_status IN ('not_reviewed', 'accepted')
    AND rule.resolution_state = NEW.resolution_state
    AND rule.transition_authority = NEW.transition_authority
    AND (rule.requires_accepted = 0 OR observation.review_status = 'accepted')
)
BEGIN
  SELECT RAISE(ABORT, 'resolution state and authority are not supported by the observation');
END;

-- A model cannot overwrite a value that deterministic code or a human established.
CREATE TRIGGER coverage_parameter_resolutions_model_no_downgrade
BEFORE UPDATE ON coverage_parameter_resolutions
WHEN NEW.transition_authority = 'model'
  AND OLD.resolution_state IN ('proven', 'calculated', 'dynamic', 'not_permitted')
BEGIN
  SELECT RAISE(ABORT, 'model authority cannot replace an established resolution');
END;

CREATE TRIGGER coverage_parameter_resolutions_not_permitted_exit
BEFORE UPDATE OF resolution_state ON coverage_parameter_resolutions
WHEN OLD.resolution_state = 'not_permitted'
  AND NEW.resolution_state NOT IN ('not_permitted', 'unknown')
BEGIN
  SELECT RAISE(ABORT, 'not_permitted can only return to unknown');
END;

-- Redacting an observation withdraws any resolution that relied on it, and any conflict
-- that was built from it, so no resolved value can outlive its evidence.
CREATE TRIGGER coverage_parameter_observations_redaction_resets_resolution
AFTER UPDATE OF redacted_at ON coverage_parameter_observations
WHEN OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
BEGIN
  UPDATE coverage_parameter_resolutions
  SET resolution_state = 'unknown',
      resolved_value_json = NULL,
      resolved_observation_id = NULL,
      reason_code = 'source_redacted',
      transition_authority = 'deterministic',
      updated_by = 'privacy-redaction',
      updated_at = NEW.redacted_at
  WHERE parameter_record_id = NEW.parameter_record_id
    AND (resolved_observation_id = NEW.id OR resolution_state = 'conflicting');
END;

-- Safety net: values can never outlive a document deletion request or consent revocation,
-- which moves the document to deletion_requested. The repository erasure method adds the
-- audit event; this trigger guarantees the redaction itself.
CREATE TRIGGER coverage_parameter_observations_redact_on_document_erasure
AFTER UPDATE OF lifecycle_state ON document_uploads
WHEN NEW.lifecycle_state IN ('deletion_requested', 'deleted')
  AND OLD.lifecycle_state NOT IN ('deletion_requested', 'deleted')
BEGIN
  UPDATE coverage_parameter_observations
  SET value_json = NULL,
      redacted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      redaction_reason_code = 'document_erasure'
  WHERE document_id = NEW.id AND redacted_at IS NULL;
END;

-- Pins, registry metadata and observation rules are immutable once written.
CREATE TRIGGER coverage_parameter_registry_pins_immutable
BEFORE UPDATE ON coverage_parameter_registry_pins
BEGIN
  SELECT RAISE(ABORT, 'registry pins are immutable');
END;

CREATE TRIGGER coverage_parameter_registry_versions_immutable
BEFORE UPDATE ON coverage_parameter_registry_versions
BEGIN
  SELECT RAISE(ABORT, 'registry versions are immutable');
END;

CREATE TRIGGER coverage_parameter_registry_versions_no_delete
BEFORE DELETE ON coverage_parameter_registry_versions
BEGIN
  SELECT RAISE(ABORT, 'registry versions are immutable');
END;

CREATE TRIGGER coverage_parameter_observation_rules_immutable
BEFORE UPDATE ON coverage_parameter_observation_rules
BEGIN
  SELECT RAISE(ABORT, 'observation rules are immutable');
END;

CREATE TRIGGER coverage_parameter_observation_rules_no_delete
BEFORE DELETE ON coverage_parameter_observation_rules
BEGIN
  SELECT RAISE(ABORT, 'observation rules are immutable');
END;
