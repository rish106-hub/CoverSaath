-- Coversaath local schema. It contains structure only and no real household data.
-- Sensitive payloads stay outside SQLite. This database stores controlled paths,
-- hashes, derived facts, permissions and audit records.

CREATE TABLE households (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE adult_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  locale TEXT,
  account_status TEXT NOT NULL DEFAULT 'invited' CHECK (account_status IN ('invited', 'active', 'suspended', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE household_roles (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  adult_user_id TEXT NOT NULL REFERENCES adult_users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member', 'operator', 'backup_operator', 'viewer')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (household_id, adult_user_id, role)
) STRICT;

CREATE TABLE household_members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  adult_user_id TEXT REFERENCES adult_users(id),
  display_name TEXT NOT NULL,
  member_kind TEXT NOT NULL CHECK (member_kind IN ('adult', 'dependent')),
  relationship_label TEXT,
  date_of_birth TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((member_kind = 'adult' AND adult_user_id IS NOT NULL) OR member_kind = 'dependent')
) STRICT;

CREATE TABLE consent_grants (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  subject_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  granted_to_actor TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN (
    'profile_intake', 'document_processing', 'coverage_reconstruction', 'voice_intake',
    'institutional_clarification', 'human_review', 'purchase_review', 'payment'
  )),
  notice_version TEXT NOT NULL,
  evidence_method TEXT NOT NULL CHECK (evidence_method IN ('typed', 'voice_recorded', 'signed', 'fixture')),
  granted_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
) STRICT;

CREATE TABLE consent_scopes (
  id TEXT PRIMARY KEY,
  consent_grant_id TEXT NOT NULL REFERENCES consent_grants(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('profile_field', 'document', 'policy', 'case', 'voice_call', 'payment_order')),
  resource_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('collect', 'read', 'derive', 'share', 'contact', 'approve', 'pay')),
  data_category TEXT NOT NULL,
  recipient TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (consent_grant_id, resource_type, resource_id, action, data_category, recipient)
) STRICT;

CREATE TABLE consent_revocations (
  id TEXT PRIMARY KEY,
  consent_grant_id TEXT NOT NULL UNIQUE REFERENCES consent_grants(id),
  revoked_by_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  reason TEXT,
  revoked_at TEXT NOT NULL,
  downstream_deletion_due_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER consent_revocations_mark_grant
AFTER INSERT ON consent_revocations
BEGIN
  UPDATE consent_grants SET revoked_at = NEW.revoked_at WHERE id = NEW.consent_grant_id;
END;

CREATE TABLE service_cases (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  subject_member_id TEXT REFERENCES household_members(id),
  opened_by_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('renewal', 'workforce_entry', 'family_change', 'planned_care', 'emergency', 'user_requested_review')),
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'collecting', 'processing', 'human_review', 'blocked', 'ready', 'closed', 'revoked')),
  emergency_mode INTEGER NOT NULL DEFAULT 0 CHECK (emergency_mode IN (0, 1)),
  stated_estimate_minor INTEGER CHECK (stated_estimate_minor IS NULL OR stated_estimate_minor >= 0),
  currency TEXT CHECK (currency IS NULL OR length(currency) = 3),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;

CREATE TABLE case_participants (
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  adult_user_id TEXT NOT NULL REFERENCES adult_users(id),
  participant_role TEXT NOT NULL CHECK (participant_role IN ('requester', 'subject', 'operator', 'backup_operator', 'reviewer')),
  consent_grant_id TEXT REFERENCES consent_grants(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (case_id, adult_user_id, participant_role)
) STRICT, WITHOUT ROWID;

CREATE TABLE document_uploads (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT REFERENCES service_cases(id),
  uploaded_by_adult_id TEXT NOT NULL REFERENCES adult_users(id),
  consent_grant_id TEXT NOT NULL REFERENCES consent_grants(id),
  document_kind TEXT NOT NULL CHECK (document_kind IN ('policy_wording', 'policy_schedule', 'endorsement', 'member_card', 'hospital_estimate', 'medical_record', 'identity_record', 'other')),
  original_filename TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  content_sha256 TEXT NOT NULL CHECK (length(content_sha256) = 64),
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  malware_status TEXT NOT NULL DEFAULT 'pending' CHECK (malware_status IN ('pending', 'clean', 'blocked', 'not_scanned_fixture')),
  encryption_status TEXT NOT NULL DEFAULT 'required' CHECK (encryption_status IN ('required', 'encrypted_local', 'fixture_only')),
  lifecycle_state TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'quarantined', 'deletion_requested', 'deleted')),
  uploaded_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE ocr_jobs (
  id TEXT PRIMARY KEY,
  document_upload_id TEXT NOT NULL REFERENCES document_uploads(id),
  provider TEXT NOT NULL CHECK (provider IN ('sarvam', 'fixture')),
  provider_job_ref TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitted', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  error_code TEXT,
  error_message TEXT,
  requested_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (provider, provider_job_ref)
) STRICT;

CREATE TABLE source_pages (
  id TEXT PRIMARY KEY,
  document_upload_id TEXT NOT NULL REFERENCES document_uploads(id),
  ocr_job_id TEXT REFERENCES ocr_jobs(id),
  page_number INTEGER NOT NULL CHECK (page_number > 0),
  source_version TEXT NOT NULL,
  page_sha256 TEXT NOT NULL CHECK (length(page_sha256) = 64),
  extracted_text TEXT,
  extraction_status TEXT NOT NULL CHECK (extraction_status IN ('pending', 'extracted', 'failed', 'manual_verified')),
  confidence_basis_points INTEGER CHECK (confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  created_at TEXT NOT NULL,
  UNIQUE (document_upload_id, source_version, page_number)
) STRICT;

CREATE TABLE insurers (
  id TEXT PRIMARY KEY,
  legal_name TEXT NOT NULL,
  regulator_identifier TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE policies (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  insurer_id TEXT REFERENCES insurers(id),
  policy_kind TEXT NOT NULL CHECK (policy_kind IN ('group', 'personal', 'top_up', 'unknown')),
  policy_number_masked TEXT,
  policy_version TEXT,
  starts_on TEXT,
  ends_on TEXT,
  source_document_id TEXT REFERENCES document_uploads(id),
  verification_state TEXT NOT NULL DEFAULT 'unverified' CHECK (verification_state IN ('unverified', 'document_backed', 'institution_confirmed', 'conflicted')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE policy_members (
  policy_id TEXT NOT NULL REFERENCES policies(id),
  household_member_id TEXT NOT NULL REFERENCES household_members(id),
  membership_state TEXT NOT NULL CHECK (membership_state IN ('unknown', 'stated', 'document_backed', 'institution_confirmed', 'conflicted')),
  member_reference_masked TEXT,
  source_page_id TEXT REFERENCES source_pages(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (policy_id, household_member_id)
) STRICT, WITHOUT ROWID;

CREATE TABLE evidence_facts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT REFERENCES service_cases(id),
  policy_id TEXT REFERENCES policies(id),
  subject_member_id TEXT REFERENCES household_members(id),
  fact_key TEXT NOT NULL,
  value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
  epistemic_state TEXT NOT NULL CHECK (epistemic_state IN ('known', 'unknown', 'conflict')),
  evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('document', 'adult_statement', 'institutional_reply', 'calculation', 'fixture')),
  source_page_id TEXT REFERENCES source_pages(id),
  source_locator TEXT,
  asserted_by TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  supersedes_fact_id TEXT REFERENCES evidence_facts(id),
  created_at TEXT NOT NULL,
  CHECK (
    (epistemic_state = 'unknown' AND value_json IS NULL) OR
    (epistemic_state IN ('known', 'conflict') AND value_json IS NOT NULL AND source_page_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE fact_conflicts (
  id TEXT PRIMARY KEY,
  fact_key TEXT NOT NULL,
  left_fact_id TEXT NOT NULL REFERENCES evidence_facts(id),
  right_fact_id TEXT NOT NULL REFERENCES evidence_facts(id),
  resolution_state TEXT NOT NULL DEFAULT 'open' CHECK (resolution_state IN ('open', 'resolved', 'accepted_unknown')),
  resolved_by_review_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (left_fact_id <> right_fact_id)
) STRICT;

CREATE TABLE coverage_graph_snapshots (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'reviewed', 'released', 'superseded')),
  graph_json TEXT NOT NULL CHECK (json_valid(graph_json)),
  generated_by_run_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (case_id, version)
) STRICT;

CREATE TABLE coverage_graph_nodes (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES coverage_graph_snapshots(id),
  node_type TEXT NOT NULL CHECK (node_type IN ('household_member', 'policy', 'protection', 'constraint', 'institution', 'unknown')),
  entity_ref TEXT,
  label TEXT NOT NULL,
  epistemic_state TEXT NOT NULL CHECK (epistemic_state IN ('known', 'unknown', 'conflict')),
  source_fact_id TEXT REFERENCES evidence_facts(id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE coverage_graph_edges (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES coverage_graph_snapshots(id),
  from_node_id TEXT NOT NULL REFERENCES coverage_graph_nodes(id),
  to_node_id TEXT NOT NULL REFERENCES coverage_graph_nodes(id),
  relationship TEXT NOT NULL,
  source_fact_id TEXT REFERENCES evidence_facts(id),
  created_at TEXT NOT NULL,
  CHECK (from_node_id <> to_node_id)
) STRICT;

CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  workflow_name TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('fixture', 'live')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted')),
  input_digest TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflow_tasks (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  parent_task_id TEXT REFERENCES workflow_tasks(id),
  agent_name TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  input_digest TEXT,
  output_digest TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE workflow_events (
  id INTEGER PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  workflow_task_id TEXT REFERENCES workflow_tasks(id),
  event_type TEXT NOT NULL,
  event_payload_json TEXT NOT NULL CHECK (json_valid(event_payload_json)),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TABLE reviewer_findings (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  workflow_task_id TEXT REFERENCES workflow_tasks(id),
  reviewer_kind TEXT NOT NULL CHECK (reviewer_kind IN ('evidence', 'privacy', 'safety', 'regulated_boundary', 'human')),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'blocker')),
  finding_code TEXT NOT NULL,
  message TEXT NOT NULL,
  source_fact_id TEXT REFERENCES evidence_facts(id),
  resolved_at TEXT,
  resolution_note TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE release_gates (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id),
  gate_kind TEXT NOT NULL CHECK (gate_kind IN ('evidence', 'privacy', 'safety', 'regulated_recommendation', 'external_action')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'passed', 'blocked', 'human_review_required')),
  blocker_count INTEGER NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  decided_by TEXT NOT NULL,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (workflow_run_id, gate_kind),
  CHECK (status <> 'passed' OR blocker_count = 0)
) STRICT;

CREATE TABLE human_reviews (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  workflow_run_id TEXT REFERENCES workflow_runs(id),
  reviewer_adult_id TEXT REFERENCES adult_users(id),
  review_kind TEXT NOT NULL CHECK (review_kind IN ('licensed_recommendation', 'ambiguity', 'exception', 'customer_requested', 'emergency_handoff')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'in_progress', 'completed', 'declined')),
  recommendation_outcome TEXT CHECK (recommendation_outcome IS NULL OR recommendation_outcome IN ('buy', 'retain', 'defer', 'no_recommendation')),
  conflict_disclosure_shown INTEGER NOT NULL DEFAULT 0 CHECK (conflict_disclosure_shown IN (0, 1)),
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE human_approvals (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES service_cases(id),
  adult_user_id TEXT NOT NULL REFERENCES adult_users(id),
  consent_grant_id TEXT NOT NULL REFERENCES consent_grants(id),
  approval_kind TEXT NOT NULL CHECK (approval_kind IN ('share_data', 'voice_call', 'declaration', 'purchase', 'payment', 'record_reply')),
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'withdrawn')),
  approved_payload_digest TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (adult_user_id, approval_kind, target_type, target_id, approved_payload_digest)
) STRICT;

CREATE TABLE integration_outbox (
  id TEXT PRIMARY KEY,
  case_id TEXT REFERENCES service_cases(id),
  provider TEXT NOT NULL CHECK (provider IN ('sarvam', 'gnani', 'pine_labs', 'email')),
  operation TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_digest TEXT NOT NULL,
  consent_grant_id TEXT NOT NULL REFERENCES consent_grants(id),
  human_approval_id TEXT REFERENCES human_approvals(id),
  release_gate_id TEXT REFERENCES release_gates(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  available_at TEXT NOT NULL,
  locked_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (provider = 'sarvam' OR human_approval_id IS NOT NULL),
  CHECK (provider NOT IN ('pine_labs', 'email') OR release_gate_id IS NOT NULL)
) STRICT;

CREATE TRIGGER integration_outbox_requires_active_consent
BEFORE INSERT ON integration_outbox
WHEN EXISTS (
  SELECT 1 FROM consent_grants
  WHERE id = NEW.consent_grant_id
    AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= NEW.created_at))
)
BEGIN
  SELECT RAISE(ABORT, 'active consent is required for an integration action');
END;

CREATE TABLE integration_webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('sarvam', 'gnani', 'pine_labs', 'email')),
  provider_event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  signature_status TEXT NOT NULL CHECK (signature_status IN ('pending', 'verified', 'invalid', 'fixture')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_error TEXT,
  UNIQUE (provider, provider_event_id)
) STRICT;

CREATE TABLE idempotency_keys (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  locked_until TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
) STRICT, WITHOUT ROWID;

CREATE TABLE retention_records (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('household', 'adult_user', 'case', 'document', 'source_page', 'workflow_run', 'integration_payload')),
  resource_id TEXT NOT NULL,
  retention_basis TEXT NOT NULL,
  retain_until TEXT,
  deletion_state TEXT NOT NULL DEFAULT 'active' CHECK (deletion_state IN ('active', 'requested', 'blocked_legal_hold', 'scheduled', 'deleted', 'verified')),
  requested_by_adult_id TEXT REFERENCES adult_users(id),
  requested_at TEXT,
  deleted_at TEXT,
  verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (resource_type, resource_id)
) STRICT;

CREATE TABLE audit_events (
  id INTEGER PRIMARY KEY,
  household_id TEXT REFERENCES households(id),
  case_id TEXT REFERENCES service_cases(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('adult_user', 'system', 'agent', 'human_reviewer', 'integration')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  event_payload_json TEXT NOT NULL CHECK (json_valid(event_payload_json)),
  previous_event_hash TEXT,
  event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64),
  occurred_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append only');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append only');
END;

CREATE INDEX household_roles_household_idx ON household_roles(household_id, status);
CREATE INDEX consent_grants_subject_idx ON consent_grants(subject_adult_id, purpose, revoked_at, expires_at);
CREATE INDEX consent_scopes_grant_idx ON consent_scopes(consent_grant_id, action);
CREATE INDEX service_cases_household_idx ON service_cases(household_id, status, created_at);
CREATE INDEX document_uploads_case_idx ON document_uploads(case_id, lifecycle_state);
CREATE INDEX ocr_jobs_document_idx ON ocr_jobs(document_upload_id, status);
CREATE INDEX source_pages_document_idx ON source_pages(document_upload_id, page_number);
CREATE INDEX policies_household_idx ON policies(household_id, policy_kind);
CREATE INDEX evidence_facts_case_idx ON evidence_facts(case_id, fact_key, epistemic_state);
CREATE INDEX evidence_facts_policy_idx ON evidence_facts(policy_id, fact_key);
CREATE INDEX coverage_graph_case_idx ON coverage_graph_snapshots(case_id, version DESC);
CREATE INDEX workflow_runs_case_idx ON workflow_runs(case_id, created_at);
CREATE INDEX workflow_tasks_run_idx ON workflow_tasks(workflow_run_id, status);
CREATE INDEX workflow_events_run_idx ON workflow_events(workflow_run_id, occurred_at);
CREATE INDEX reviewer_findings_run_idx ON reviewer_findings(workflow_run_id, severity, resolved_at);
CREATE INDEX human_reviews_case_idx ON human_reviews(case_id, status);
CREATE INDEX integration_outbox_ready_idx ON integration_outbox(status, available_at);
CREATE INDEX webhook_events_unprocessed_idx ON integration_webhook_events(provider, processed_at);
CREATE INDEX retention_records_household_idx ON retention_records(household_id, deletion_state);
CREATE INDEX audit_events_case_idx ON audit_events(case_id, occurred_at);

CREATE VIEW active_consent_grants AS
SELECT * FROM consent_grants
WHERE revoked_at IS NULL
  AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP);

CREATE VIEW unresolved_evidence AS
SELECT * FROM evidence_facts WHERE epistemic_state IN ('unknown', 'conflict');

