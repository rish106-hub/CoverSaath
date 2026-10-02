-- Additive: lasting policy records built from uploaded documents by the 12-section breakdown.
-- A policy record outlives any single care case. Parameters are stored per record and key.

CREATE TABLE policy_records (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_by_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  consent_grant_id TEXT NOT NULL REFERENCES consent_grants(id),
  status TEXT NOT NULL CHECK (status IN ('processing', 'needs_review', 'ready', 'failed', 'revoked')),
  contract_version TEXT NOT NULL,
  display_title TEXT,
  insurer_name TEXT,
  product_name TEXT,
  policy_number_masked TEXT,
  summary_json TEXT CHECK (summary_json IS NULL OR json_valid(summary_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_at TEXT,
  CHECK ((status = 'ready') = (ready_at IS NOT NULL))
) STRICT;

CREATE INDEX policy_records_household_idx ON policy_records(household_id, status, created_at);

CREATE TABLE policy_record_documents (
  policy_record_id TEXT NOT NULL REFERENCES policy_records(id),
  document_upload_id TEXT NOT NULL REFERENCES document_uploads(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  PRIMARY KEY (policy_record_id, document_upload_id)
) STRICT;

CREATE TRIGGER policy_record_documents_same_household
BEFORE INSERT ON policy_record_documents
WHEN NOT EXISTS (
  SELECT 1 FROM policy_records record
  JOIN document_uploads document ON document.household_id = record.household_id
  WHERE record.id = NEW.policy_record_id AND document.id = NEW.document_upload_id
)
BEGIN
  SELECT RAISE(ABORT, 'policy record documents must belong to the same household');
END;

CREATE TABLE breakdown_jobs (
  id TEXT PRIMARY KEY,
  policy_record_id TEXT NOT NULL REFERENCES policy_records(id),
  household_id TEXT NOT NULL REFERENCES households(id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('live', 'fixture')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
  current_step TEXT,
  steps_json TEXT NOT NULL CHECK (json_valid(steps_json)),
  budget_usd REAL NOT NULL CHECK (budget_usd >= 0),
  spent_usd REAL NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE (household_id, idempotency_key)
) STRICT;

CREATE INDEX breakdown_jobs_status_idx ON breakdown_jobs(status, updated_at);
CREATE INDEX breakdown_jobs_record_idx ON breakdown_jobs(policy_record_id, created_at);

CREATE TABLE policy_parameters (
  id TEXT PRIMARY KEY,
  policy_record_id TEXT NOT NULL REFERENCES policy_records(id),
  section_number INTEGER NOT NULL CHECK (section_number BETWEEN 1 AND 12),
  parameter_key TEXT NOT NULL,
  evidence_state TEXT NOT NULL CHECK (evidence_state IN ('Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted')),
  critical INTEGER NOT NULL CHECK (critical IN (0, 1)),
  visibility TEXT NOT NULL CHECK (visibility IN ('cover', 'operational', 'protected')),
  review_state TEXT NOT NULL CHECK (review_state IN ('unreviewed', 'confirmed', 'corrected', 'confirmed_absent')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  updated_at TEXT NOT NULL,
  UNIQUE (policy_record_id, parameter_key)
) STRICT;

CREATE INDEX policy_parameters_section_idx ON policy_parameters(policy_record_id, section_number);

CREATE TABLE policy_parameter_reviews (
  id TEXT PRIMARY KEY,
  policy_record_id TEXT NOT NULL REFERENCES policy_records(id),
  parameter_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('confirm', 'correct', 'mark_absent')),
  previous_json TEXT NOT NULL CHECK (json_valid(previous_json)),
  next_json TEXT NOT NULL CHECK (json_valid(next_json)),
  reviewed_by_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  note TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE breakdown_model_calls (
  id TEXT PRIMARY KEY,
  breakdown_job_id TEXT NOT NULL REFERENCES breakdown_jobs(id),
  agent TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX breakdown_model_calls_job_idx ON breakdown_model_calls(breakdown_job_id, created_at);
