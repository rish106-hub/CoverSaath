-- Knowvia Postgres baseline (Postgres 16+). Consolidates SQLite migrations 001-006 as a 1:1 port.
-- Structure only; no real household data. Sensitive payloads stay outside the database.
-- Type mapping: text timestamps -> timestamptz(3) (millisecond precision keeps optimistic revisions exact),
-- *_json text -> jsonb, REAL USD -> bigint micro-USD, 0/1 flags stay smallint with CHECK.
-- Rollback: forward-fix only; a baseline has no down path (dev data only).

CREATE TABLE households (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'restricted', 'closed')),
  city text CHECK (city IS NULL OR (length(city) BETWEEN 1 AND 80)),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL
);

CREATE TABLE adult_users (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  contact_email text,
  contact_phone text,
  locale text,
  account_status text NOT NULL DEFAULT 'invited' CHECK (account_status IN ('invited', 'active', 'suspended', 'closed')),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL
);

CREATE TABLE household_roles (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  adult_user_id text NOT NULL REFERENCES adult_users(id),
  role text NOT NULL CHECK (role IN ('owner', 'member', 'operator', 'backup_operator', 'viewer')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  starts_at timestamptz(3),
  ends_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  UNIQUE (household_id, adult_user_id, role)
);

CREATE TABLE household_members (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  adult_user_id text REFERENCES adult_users(id),
  display_name text NOT NULL,
  member_kind text NOT NULL CHECK (member_kind IN ('adult', 'dependent')),
  relationship_label text,
  date_of_birth text,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CHECK ((member_kind = 'adult' AND adult_user_id IS NOT NULL) OR member_kind = 'dependent')
);

CREATE TABLE consent_grants (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  subject_adult_id text NOT NULL REFERENCES adult_users(id),
  granted_to_actor text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN (
    'profile_intake', 'document_processing', 'coverage_reconstruction', 'voice_intake',
    'institutional_clarification', 'human_review', 'purchase_review', 'payment'
  )),
  notice_version text NOT NULL,
  evidence_method text NOT NULL CHECK (evidence_method IN ('typed', 'voice_recorded', 'signed', 'fixture')),
  granted_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3),
  revoked_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);

CREATE TABLE consent_scopes (
  id text PRIMARY KEY,
  consent_grant_id text NOT NULL REFERENCES consent_grants(id),
  resource_type text NOT NULL CHECK (resource_type IN ('profile_field', 'document', 'policy', 'case', 'voice_call', 'payment_order')),
  resource_id text,
  action text NOT NULL CHECK (action IN ('collect', 'read', 'derive', 'share', 'contact', 'approve', 'pay')),
  data_category text NOT NULL,
  recipient text,
  created_at timestamptz(3) NOT NULL,
  UNIQUE (consent_grant_id, resource_type, resource_id, action, data_category, recipient)
);

CREATE TABLE consent_revocations (
  id text PRIMARY KEY,
  consent_grant_id text NOT NULL UNIQUE REFERENCES consent_grants(id),
  revoked_by_adult_id text NOT NULL REFERENCES adult_users(id),
  reason text,
  revoked_at timestamptz(3) NOT NULL,
  downstream_deletion_due_at timestamptz(3),
  created_at timestamptz(3) NOT NULL
);

CREATE TABLE service_cases (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  subject_member_id text REFERENCES household_members(id),
  opened_by_adult_id text NOT NULL REFERENCES adult_users(id),
  trigger_type text NOT NULL CHECK (trigger_type IN ('renewal', 'workforce_entry', 'family_change', 'planned_care', 'emergency', 'user_requested_review')),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'collecting', 'processing', 'human_review', 'blocked', 'ready', 'closed', 'revoked')),
  emergency_mode smallint NOT NULL DEFAULT 0 CHECK (emergency_mode IN (0, 1)),
  stated_estimate_minor bigint CHECK (stated_estimate_minor IS NULL OR stated_estimate_minor >= 0),
  currency text CHECK (currency IS NULL OR length(currency) = 3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  closed_at timestamptz(3)
);

CREATE TABLE case_participants (
  case_id text NOT NULL REFERENCES service_cases(id),
  adult_user_id text NOT NULL REFERENCES adult_users(id),
  participant_role text NOT NULL CHECK (participant_role IN ('requester', 'subject', 'operator', 'backup_operator', 'reviewer')),
  consent_grant_id text REFERENCES consent_grants(id),
  created_at timestamptz(3) NOT NULL,
  PRIMARY KEY (case_id, adult_user_id, participant_role)
);

CREATE TABLE document_uploads (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  case_id text REFERENCES service_cases(id),
  uploaded_by_adult_id text NOT NULL REFERENCES adult_users(id),
  consent_grant_id text NOT NULL REFERENCES consent_grants(id),
  document_kind text NOT NULL CHECK (document_kind IN ('policy_wording', 'policy_schedule', 'endorsement', 'member_card', 'hospital_estimate', 'medical_record', 'identity_record', 'other')),
  original_filename text NOT NULL,
  storage_path text NOT NULL UNIQUE,
  content_sha256 text NOT NULL CHECK (length(content_sha256) = 64),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  malware_status text NOT NULL DEFAULT 'pending' CHECK (malware_status IN ('pending', 'clean', 'blocked', 'not_scanned_fixture')),
  encryption_status text NOT NULL DEFAULT 'required' CHECK (encryption_status IN ('required', 'encrypted_local', 'fixture_only')),
  lifecycle_state text NOT NULL DEFAULT 'active' CHECK (lifecycle_state IN ('active', 'quarantined', 'deletion_requested', 'deleted')),
  uploaded_at timestamptz(3) NOT NULL,
  deleted_at timestamptz(3),
  logical_document_id text,
  source_version text NOT NULL DEFAULT '1'
);

CREATE TABLE ocr_jobs (
  id text PRIMARY KEY,
  document_upload_id text NOT NULL REFERENCES document_uploads(id),
  provider text NOT NULL CHECK (provider IN ('sarvam', 'fixture')),
  provider_job_ref text,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitted', 'processing', 'succeeded', 'failed', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0 AND attempt_count <= 5),
  error_code text,
  error_message text,
  requested_at timestamptz(3) NOT NULL,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  contract_version text NOT NULL DEFAULT 'knowvia.ocr.v1',
  authorization_json jsonb,
  result_json jsonb,
  result_digest text CHECK (result_digest IS NULL OR length(result_digest) = 64),
  updated_at timestamptz(3),
  UNIQUE (provider, provider_job_ref)
);

CREATE TABLE source_pages (
  id text PRIMARY KEY,
  document_upload_id text NOT NULL REFERENCES document_uploads(id),
  ocr_job_id text REFERENCES ocr_jobs(id),
  page_number integer NOT NULL CHECK (page_number > 0),
  source_version text NOT NULL,
  page_sha256 text NOT NULL CHECK (length(page_sha256) = 64),
  extracted_text text,
  extraction_status text NOT NULL CHECK (extraction_status IN ('pending', 'extracted', 'failed', 'manual_verified')),
  confidence_basis_points integer CHECK (confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  created_at timestamptz(3) NOT NULL,
  output_contract_version text NOT NULL DEFAULT 'knowvia.ocr.v1',
  text_sha256 text CHECK (text_sha256 IS NULL OR length(text_sha256) = 64),
  provider_page_ref text,
  provenance_json jsonb,
  UNIQUE (document_upload_id, source_version, page_number)
);

CREATE TABLE insurers (
  id text PRIMARY KEY,
  legal_name text NOT NULL,
  regulator_identifier text,
  created_at timestamptz(3) NOT NULL
);

CREATE TABLE policies (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  insurer_id text REFERENCES insurers(id),
  policy_kind text NOT NULL CHECK (policy_kind IN ('group', 'personal', 'top_up', 'unknown')),
  policy_number_masked text,
  policy_version text,
  starts_on text,
  ends_on text,
  source_document_id text REFERENCES document_uploads(id),
  verification_state text NOT NULL DEFAULT 'unverified' CHECK (verification_state IN ('unverified', 'document_backed', 'institution_confirmed', 'conflicted')),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL
);

CREATE TABLE policy_members (
  policy_id text NOT NULL REFERENCES policies(id),
  household_member_id text NOT NULL REFERENCES household_members(id),
  membership_state text NOT NULL CHECK (membership_state IN ('unknown', 'stated', 'document_backed', 'institution_confirmed', 'conflicted')),
  member_reference_masked text,
  source_page_id text REFERENCES source_pages(id),
  created_at timestamptz(3) NOT NULL,
  PRIMARY KEY (policy_id, household_member_id)
);

CREATE TABLE evidence_facts (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  case_id text REFERENCES service_cases(id),
  policy_id text REFERENCES policies(id),
  subject_member_id text REFERENCES household_members(id),
  fact_key text NOT NULL,
  value_json jsonb,
  epistemic_state text NOT NULL CHECK (epistemic_state IN ('known', 'unknown', 'conflict')),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('document', 'adult_statement', 'institutional_reply', 'calculation', 'fixture')),
  provenance_kind text NOT NULL CHECK (provenance_kind IN ('document_page', 'adult_statement', 'proxy_statement', 'institutional_reply', 'calculation', 'fixture')),
  source_page_id text REFERENCES source_pages(id),
  statement_adult_id text REFERENCES adult_users(id),
  institutional_source_ref text,
  calculation_method text,
  source_locator text,
  asserted_by text NOT NULL,
  effective_at timestamptz(3),
  observed_at timestamptz(3) NOT NULL,
  retrieved_at timestamptz(3),
  confidence_basis_points integer CHECK (confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  review_status text NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'reviewed', 'rejected')),
  subject_confirmation_state text NOT NULL DEFAULT 'not_applicable' CHECK (subject_confirmation_state IN ('not_applicable', 'unconfirmed', 'confirmed', 'rejected')),
  permitted_viewers_json jsonb,
  expires_at timestamptz(3),
  supersedes_fact_id text REFERENCES evidence_facts(id),
  created_at timestamptz(3) NOT NULL,
  CHECK (
    (epistemic_state = 'unknown' AND value_json IS NULL) OR
    (epistemic_state IN ('known', 'conflict') AND value_json IS NOT NULL)
  ),
  CHECK (epistemic_state = 'unknown' OR provenance_kind <> 'document_page' OR source_page_id IS NOT NULL),
  CHECK (epistemic_state = 'unknown' OR provenance_kind NOT IN ('adult_statement', 'proxy_statement') OR statement_adult_id IS NOT NULL),
  CHECK (epistemic_state = 'unknown' OR provenance_kind <> 'institutional_reply' OR institutional_source_ref IS NOT NULL),
  CHECK (epistemic_state = 'unknown' OR provenance_kind <> 'calculation' OR calculation_method IS NOT NULL),
  CHECK (provenance_kind <> 'proxy_statement' OR subject_confirmation_state <> 'not_applicable')
);

CREATE TABLE fact_conflicts (
  id text PRIMARY KEY,
  fact_key text NOT NULL,
  left_fact_id text NOT NULL REFERENCES evidence_facts(id),
  right_fact_id text NOT NULL REFERENCES evidence_facts(id),
  resolution_state text NOT NULL DEFAULT 'open' CHECK (resolution_state IN ('open', 'resolved', 'accepted_unknown')),
  resolved_by_review_id text,
  created_at timestamptz(3) NOT NULL,
  resolved_at timestamptz(3),
  CHECK (left_fact_id <> right_fact_id)
);

CREATE TABLE coverage_graph_snapshots (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  case_id text NOT NULL REFERENCES service_cases(id),
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'reviewed', 'released', 'superseded')),
  graph_json jsonb NOT NULL,
  generated_by_run_id text,
  created_at timestamptz(3) NOT NULL,
  UNIQUE (case_id, version)
);

CREATE TABLE coverage_graph_nodes (
  id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES coverage_graph_snapshots(id),
  node_type text NOT NULL CHECK (node_type IN ('household_member', 'policy', 'protection', 'constraint', 'institution', 'unknown')),
  entity_ref text,
  label text NOT NULL,
  epistemic_state text NOT NULL CHECK (epistemic_state IN ('known', 'unknown', 'conflict')),
  source_fact_id text REFERENCES evidence_facts(id),
  created_at timestamptz(3) NOT NULL,
  UNIQUE (snapshot_id, id)
);

CREATE TABLE coverage_graph_edges (
  id text PRIMARY KEY,
  snapshot_id text NOT NULL REFERENCES coverage_graph_snapshots(id),
  from_node_id text NOT NULL REFERENCES coverage_graph_nodes(id),
  to_node_id text NOT NULL REFERENCES coverage_graph_nodes(id),
  relationship text NOT NULL,
  source_fact_id text REFERENCES evidence_facts(id),
  created_at timestamptz(3) NOT NULL,
  CHECK (from_node_id <> to_node_id)
);

CREATE TABLE workflow_runs (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES service_cases(id),
  workflow_name text NOT NULL,
  workflow_version text NOT NULL,
  execution_mode text NOT NULL CHECK (execution_mode IN ('fixture', 'live')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted')),
  input_digest text NOT NULL,
  started_at timestamptz(3),
  finished_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  case_revision text,
  consent_grant_id text REFERENCES consent_grants(id),
  input_json jsonb,
  terminal_reason text
);

CREATE TABLE workflow_tasks (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  parent_task_id text REFERENCES workflow_tasks(id),
  agent_name text NOT NULL,
  task_kind text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  input_digest text,
  output_digest text,
  started_at timestamptz(3),
  finished_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  input_json jsonb,
  output_json jsonb,
  lease_owner text,
  lease_expires_at timestamptz(3),
  retry_available_at timestamptz(3),
  last_error_code text,
  last_error_message text,
  terminal_reason text
);

CREATE TABLE workflow_task_dependencies (
  workflow_task_id text NOT NULL REFERENCES workflow_tasks(id),
  depends_on_task_id text NOT NULL REFERENCES workflow_tasks(id),
  created_at timestamptz(3) NOT NULL,
  PRIMARY KEY (workflow_task_id, depends_on_task_id),
  CHECK (workflow_task_id <> depends_on_task_id)
);

CREATE TABLE workflow_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  workflow_task_id text REFERENCES workflow_tasks(id),
  event_type text NOT NULL,
  event_payload_json jsonb NOT NULL,
  occurred_at timestamptz(3) NOT NULL
);

CREATE TABLE reviewer_findings (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  workflow_task_id text REFERENCES workflow_tasks(id),
  reviewer_kind text NOT NULL CHECK (reviewer_kind IN ('evidence', 'privacy', 'safety', 'regulated_boundary', 'human')),
  severity text NOT NULL CHECK (severity IN ('info', 'warning', 'blocker')),
  finding_code text NOT NULL,
  message text NOT NULL,
  source_fact_id text REFERENCES evidence_facts(id),
  resolved_at timestamptz(3),
  resolution_note text,
  created_at timestamptz(3) NOT NULL
);

CREATE TABLE release_gates (
  id text PRIMARY KEY,
  workflow_run_id text NOT NULL REFERENCES workflow_runs(id),
  gate_kind text NOT NULL CHECK (gate_kind IN ('evidence', 'privacy', 'safety', 'regulated_recommendation', 'external_action')),
  status text NOT NULL CHECK (status IN ('pending', 'passed', 'blocked', 'human_review_required')),
  blocker_count integer NOT NULL DEFAULT 0 CHECK (blocker_count >= 0),
  decided_by text NOT NULL,
  decided_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  UNIQUE (workflow_run_id, gate_kind),
  CHECK (status <> 'passed' OR blocker_count = 0)
);

CREATE TABLE human_reviews (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES service_cases(id),
  workflow_run_id text REFERENCES workflow_runs(id),
  reviewer_adult_id text REFERENCES adult_users(id),
  review_kind text NOT NULL CHECK (review_kind IN ('licensed_recommendation', 'ambiguity', 'exception', 'customer_requested', 'emergency_handoff')),
  status text NOT NULL CHECK (status IN ('requested', 'in_progress', 'completed', 'declined')),
  recommendation_outcome text CHECK (recommendation_outcome IS NULL OR recommendation_outcome IN ('buy', 'retain', 'defer', 'no_recommendation')),
  conflict_disclosure_shown smallint NOT NULL DEFAULT 0 CHECK (conflict_disclosure_shown IN (0, 1)),
  started_at timestamptz(3),
  completed_at timestamptz(3),
  created_at timestamptz(3) NOT NULL
);

CREATE TABLE human_approvals (
  id text PRIMARY KEY,
  case_id text NOT NULL REFERENCES service_cases(id),
  adult_user_id text NOT NULL REFERENCES adult_users(id),
  consent_grant_id text NOT NULL REFERENCES consent_grants(id),
  approval_kind text NOT NULL CHECK (approval_kind IN ('share_data', 'voice_call', 'declaration', 'purchase', 'payment', 'record_reply')),
  target_type text NOT NULL,
  target_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'withdrawn')),
  approved_payload_digest text NOT NULL,
  decided_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  UNIQUE (adult_user_id, approval_kind, target_type, target_id, approved_payload_digest)
);

CREATE TABLE integration_outbox (
  id text PRIMARY KEY,
  case_id text REFERENCES service_cases(id),
  provider text NOT NULL CHECK (provider IN ('sarvam', 'gnani', 'pine_labs', 'email')),
  operation text NOT NULL,
  payload_json jsonb NOT NULL,
  payload_digest text NOT NULL,
  consent_grant_id text NOT NULL REFERENCES consent_grants(id),
  human_approval_id text REFERENCES human_approvals(id),
  release_gate_id text REFERENCES release_gates(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed', 'cancelled', 'blocked')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
  available_at timestamptz(3) NOT NULL,
  locked_at timestamptz(3),
  last_error text,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  CHECK (provider = 'sarvam' OR human_approval_id IS NOT NULL),
  CHECK (provider NOT IN ('pine_labs', 'email') OR release_gate_id IS NOT NULL)
);

CREATE TABLE integration_webhook_events (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK (provider IN ('sarvam', 'gnani', 'pine_labs', 'email')),
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  signature_status text NOT NULL CHECK (signature_status IN ('pending', 'verified', 'invalid', 'fixture')),
  payload_json jsonb NOT NULL,
  received_at timestamptz(3) NOT NULL,
  processed_at timestamptz(3),
  processing_error text,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_digest text NOT NULL,
  response_status integer,
  response_json jsonb,
  locked_until timestamptz(3),
  expires_at timestamptz(3) NOT NULL,
  created_at timestamptz(3) NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE retention_records (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  resource_type text NOT NULL CHECK (resource_type IN ('household', 'adult_user', 'case', 'document', 'source_page', 'workflow_run', 'integration_payload')),
  resource_id text NOT NULL,
  retention_basis text NOT NULL,
  retain_until timestamptz(3),
  deletion_state text NOT NULL DEFAULT 'active' CHECK (deletion_state IN ('active', 'requested', 'blocked_legal_hold', 'scheduled', 'deleted', 'verified')),
  requested_by_adult_id text REFERENCES adult_users(id),
  requested_at timestamptz(3),
  deleted_at timestamptz(3),
  verified_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  UNIQUE (resource_type, resource_id)
);

CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  household_id text REFERENCES households(id),
  case_id text REFERENCES service_cases(id),
  actor_type text NOT NULL CHECK (actor_type IN ('adult_user', 'system', 'agent', 'human_reviewer', 'integration')),
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  event_payload_json jsonb NOT NULL,
  previous_event_hash text,
  event_hash text NOT NULL UNIQUE CHECK (length(event_hash) = 64),
  occurred_at timestamptz(3) NOT NULL
);

CREATE TABLE api_sessions (
  id text PRIMARY KEY,
  adult_user_id text NOT NULL REFERENCES adult_users(id),
  token_sha256 text NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  issued_at timestamptz(3) NOT NULL,
  expires_at timestamptz(3) NOT NULL,
  revoked_at timestamptz(3),
  last_seen_at timestamptz(3),
  created_at timestamptz(3) NOT NULL,
  CHECK (expires_at > issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);

CREATE TABLE policy_records (
  id text PRIMARY KEY,
  household_id text NOT NULL REFERENCES households(id),
  created_by_adult_id text NOT NULL REFERENCES adult_users(id),
  consent_grant_id text NOT NULL REFERENCES consent_grants(id),
  status text NOT NULL CHECK (status IN ('processing', 'needs_review', 'ready', 'failed', 'revoked')),
  contract_version text NOT NULL,
  display_title text,
  insurer_name text,
  product_name text,
  policy_number_masked text,
  summary_json jsonb,
  created_at timestamptz(3) NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  ready_at timestamptz(3),
  CHECK ((status = 'ready') = (ready_at IS NOT NULL))
);

CREATE TABLE policy_record_documents (
  policy_record_id text NOT NULL REFERENCES policy_records(id),
  document_upload_id text NOT NULL REFERENCES document_uploads(id),
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (policy_record_id, document_upload_id)
);

CREATE TABLE breakdown_jobs (
  id text PRIMARY KEY,
  policy_record_id text NOT NULL REFERENCES policy_records(id),
  household_id text NOT NULL REFERENCES households(id),
  idempotency_key text NOT NULL,
  request_digest text NOT NULL CHECK (length(request_digest) = 64),
  execution_mode text NOT NULL CHECK (execution_mode IN ('live', 'fixture')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'interrupted', 'cancelled')),
  current_step text,
  steps_json jsonb NOT NULL,
  budget_micro_usd bigint NOT NULL CHECK (budget_micro_usd >= 0),
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  error_code text,
  error_message text,
  created_at timestamptz(3) NOT NULL,
  started_at timestamptz(3),
  completed_at timestamptz(3),
  updated_at timestamptz(3) NOT NULL,
  UNIQUE (household_id, idempotency_key)
);

CREATE TABLE policy_parameters (
  id text PRIMARY KEY,
  policy_record_id text NOT NULL REFERENCES policy_records(id),
  section_number integer NOT NULL CHECK (section_number BETWEEN 1 AND 12),
  parameter_key text NOT NULL,
  evidence_state text NOT NULL CHECK (evidence_state IN ('Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted')),
  critical smallint NOT NULL CHECK (critical IN (0, 1)),
  visibility text NOT NULL CHECK (visibility IN ('cover', 'operational', 'protected')),
  review_state text NOT NULL CHECK (review_state IN ('unreviewed', 'confirmed', 'corrected', 'confirmed_absent')),
  result_json jsonb NOT NULL,
  updated_at timestamptz(3) NOT NULL,
  UNIQUE (policy_record_id, parameter_key)
);

CREATE TABLE policy_parameter_reviews (
  id text PRIMARY KEY,
  policy_record_id text NOT NULL REFERENCES policy_records(id),
  parameter_key text NOT NULL,
  action text NOT NULL CHECK (action IN ('confirm', 'correct', 'mark_absent')),
  previous_json jsonb NOT NULL,
  next_json jsonb NOT NULL,
  reviewed_by_adult_id text NOT NULL REFERENCES adult_users(id),
  note text,
  created_at timestamptz(3) NOT NULL
);

CREATE TABLE breakdown_model_calls (
  id text PRIMARY KEY,
  breakdown_job_id text NOT NULL REFERENCES breakdown_jobs(id),
  agent text NOT NULL,
  prompt_version text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_micro_usd bigint CHECK (cost_micro_usd IS NULL OR cost_micro_usd >= 0),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  error_code text,
  created_at timestamptz(3) NOT NULL
);

-- ---------------------------------------------------------------------------------------------
-- Triggers (plpgsql). Each keeps the SQLite trigger name and message.
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION trg_consent_revocations_mark_grant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE consent_grants SET revoked_at = NEW.revoked_at WHERE id = NEW.consent_grant_id;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_revocations_mark_grant AFTER INSERT ON consent_revocations
  FOR EACH ROW EXECUTE FUNCTION trg_consent_revocations_mark_grant();

CREATE FUNCTION trg_integration_outbox_requires_active_consent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM consent_grants
    WHERE id = NEW.consent_grant_id
      AND (revoked_at IS NOT NULL OR (expires_at IS NOT NULL AND expires_at <= NEW.created_at))
  ) THEN
    RAISE EXCEPTION 'active consent is required for an integration action';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER integration_outbox_requires_active_consent BEFORE INSERT ON integration_outbox
  FOR EACH ROW EXECUTE FUNCTION trg_integration_outbox_requires_active_consent();

CREATE FUNCTION trg_audit_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit events are append only';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION trg_audit_events_append_only();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION trg_audit_events_append_only();

CREATE FUNCTION trg_workflow_task_dependencies_same_run() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM workflow_tasks child
    JOIN workflow_tasks parent ON parent.id = NEW.depends_on_task_id
    WHERE child.id = NEW.workflow_task_id AND child.workflow_run_id = parent.workflow_run_id
  ) THEN
    RAISE EXCEPTION 'workflow dependency must belong to the same run';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_task_dependencies_same_run_insert BEFORE INSERT ON workflow_task_dependencies
  FOR EACH ROW EXECUTE FUNCTION trg_workflow_task_dependencies_same_run();
CREATE TRIGGER workflow_task_dependencies_same_run_update BEFORE UPDATE ON workflow_task_dependencies
  FOR EACH ROW EXECUTE FUNCTION trg_workflow_task_dependencies_same_run();

CREATE FUNCTION trg_consent_grants_household_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
    UNION ALL
    SELECT 1 FROM household_roles WHERE household_id = NEW.household_id AND adult_user_id = NEW.subject_adult_id
  ) THEN
    RAISE EXCEPTION 'consent subject must belong to the household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_grants_household_subject_insert BEFORE INSERT ON consent_grants
  FOR EACH ROW EXECUTE FUNCTION trg_consent_grants_household_subject();
CREATE TRIGGER consent_grants_household_subject_update BEFORE UPDATE OF household_id, subject_adult_id ON consent_grants
  FOR EACH ROW EXECUTE FUNCTION trg_consent_grants_household_subject();

CREATE FUNCTION trg_consent_scopes_household_resource_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM consent_grants cg
    WHERE cg.id = NEW.consent_grant_id
      AND (
        (NEW.resource_type = 'case' AND EXISTS (
          SELECT 1 FROM service_cases sc WHERE sc.id = NEW.resource_id AND sc.household_id = cg.household_id
        )) OR
        (NEW.resource_type = 'document' AND EXISTS (
          SELECT 1 FROM document_uploads du WHERE du.id = NEW.resource_id AND du.household_id = cg.household_id
        )) OR
        (NEW.resource_type = 'policy' AND EXISTS (
          SELECT 1 FROM policies p WHERE p.id = NEW.resource_id AND p.household_id = cg.household_id
        )) OR
        NEW.resource_type IN ('profile_field', 'voice_call', 'payment_order')
      )
  ) THEN
    RAISE EXCEPTION 'consent resource must belong to the grant household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_scopes_household_resource_insert BEFORE INSERT ON consent_scopes
  FOR EACH ROW EXECUTE FUNCTION trg_consent_scopes_household_resource_insert();

CREATE FUNCTION trg_consent_scopes_resource_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id
    OR NEW.resource_type IS DISTINCT FROM OLD.resource_type
    OR NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
    RAISE EXCEPTION 'consent scope resource references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_scopes_resource_immutable BEFORE UPDATE OF consent_grant_id, resource_type, resource_id ON consent_scopes
  FOR EACH ROW EXECUTE FUNCTION trg_consent_scopes_resource_immutable();

CREATE FUNCTION trg_service_cases_household_refs() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id
      )) OR NOT EXISTS (
        SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
        UNION ALL
        SELECT 1 FROM household_roles WHERE household_id = NEW.household_id AND adult_user_id = NEW.opened_by_adult_id
      ) THEN
    RAISE EXCEPTION 'case participants must belong to the household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER service_cases_household_refs_insert BEFORE INSERT ON service_cases
  FOR EACH ROW EXECUTE FUNCTION trg_service_cases_household_refs();
CREATE TRIGGER service_cases_household_refs_update BEFORE UPDATE OF household_id, subject_member_id, opened_by_adult_id ON service_cases
  FOR EACH ROW EXECUTE FUNCTION trg_service_cases_household_refs();

CREATE FUNCTION trg_case_participants_household_refs_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM service_cases sc
    WHERE sc.id = NEW.case_id
      AND EXISTS (
        SELECT 1 FROM household_members hm WHERE hm.household_id = sc.household_id AND hm.adult_user_id = NEW.adult_user_id
        UNION ALL
        SELECT 1 FROM household_roles hr WHERE hr.household_id = sc.household_id AND hr.adult_user_id = NEW.adult_user_id
      )
      AND (NEW.consent_grant_id IS NULL OR EXISTS (
        SELECT 1 FROM consent_grants cg
        WHERE cg.id = NEW.consent_grant_id AND cg.household_id = sc.household_id AND cg.subject_adult_id = NEW.adult_user_id
      ))
  ) THEN
    RAISE EXCEPTION 'case participant must be household and consent scoped';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_participants_household_refs_insert BEFORE INSERT ON case_participants
  FOR EACH ROW EXECUTE FUNCTION trg_case_participants_household_refs_insert();

CREATE FUNCTION trg_case_participants_refs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.adult_user_id IS DISTINCT FROM OLD.adult_user_id
    OR NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id THEN
    RAISE EXCEPTION 'case participant references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER case_participants_refs_immutable BEFORE UPDATE OF case_id, adult_user_id, consent_grant_id ON case_participants
  FOR EACH ROW EXECUTE FUNCTION trg_case_participants_refs_immutable();

CREATE FUNCTION trg_document_uploads_household_refs_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM consent_grants cg
    WHERE cg.id = NEW.consent_grant_id
      AND cg.household_id = NEW.household_id
      AND cg.subject_adult_id = NEW.uploaded_by_adult_id
      AND cg.purpose = 'document_processing'
      AND cg.revoked_at IS NULL
      AND (cg.expires_at IS NULL OR cg.expires_at > NEW.uploaded_at)
  ) OR (NEW.case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id
  )) THEN
    RAISE EXCEPTION 'document must be household and active-consent scoped';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_uploads_household_refs_insert BEFORE INSERT ON document_uploads
  FOR EACH ROW EXECUTE FUNCTION trg_document_uploads_household_refs_insert();

CREATE FUNCTION trg_document_uploads_quarantine_after_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state = 'active' AND (NEW.malware_status = 'pending' OR NEW.encryption_status = 'required') THEN
    UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER document_uploads_quarantine_after_insert AFTER INSERT ON document_uploads
  FOR EACH ROW EXECUTE FUNCTION trg_document_uploads_quarantine_after_insert();

CREATE FUNCTION trg_document_uploads_household_refs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id
    OR NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.uploaded_by_adult_id IS DISTINCT FROM OLD.uploaded_by_adult_id
    OR NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id THEN
    RAISE EXCEPTION 'document household and consent references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_uploads_household_refs_immutable BEFORE UPDATE OF household_id, case_id, uploaded_by_adult_id, consent_grant_id ON document_uploads
  FOR EACH ROW EXECUTE FUNCTION trg_document_uploads_household_refs_immutable();

CREATE FUNCTION trg_document_uploads_activation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.lifecycle_state = 'active' AND NOT (
    NEW.malware_status IN ('clean', 'not_scanned_fixture')
    AND NEW.encryption_status IN ('encrypted_local', 'fixture_only')
  ) THEN
    RAISE EXCEPTION 'document cannot activate before validation and protected storage';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER document_uploads_activation_guard BEFORE UPDATE OF lifecycle_state ON document_uploads
  FOR EACH ROW EXECUTE FUNCTION trg_document_uploads_activation_guard();

CREATE FUNCTION trg_policies_household_source_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM document_uploads WHERE id = NEW.source_document_id AND household_id = NEW.household_id
  ) THEN
    RAISE EXCEPTION 'policy source document must belong to the household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_household_source_insert BEFORE INSERT ON policies
  FOR EACH ROW EXECUTE FUNCTION trg_policies_household_source_insert();

CREATE FUNCTION trg_policies_household_source_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id THEN
    RAISE EXCEPTION 'policy household and source references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policies_household_source_immutable BEFORE UPDATE OF household_id, source_document_id ON policies
  FOR EACH ROW EXECUTE FUNCTION trg_policies_household_source_immutable();

CREATE FUNCTION trg_policy_members_household_refs_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM policies p
    JOIN household_members hm ON hm.id = NEW.household_member_id
    WHERE p.id = NEW.policy_id AND p.household_id = hm.household_id
      AND (NEW.source_page_id IS NULL OR EXISTS (
        SELECT 1 FROM source_pages sp
        JOIN document_uploads du ON du.id = sp.document_upload_id
        WHERE sp.id = NEW.source_page_id AND du.household_id = p.household_id
      ))
  ) THEN
    RAISE EXCEPTION 'policy member references must belong to the household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_members_household_refs_insert BEFORE INSERT ON policy_members
  FOR EACH ROW EXECUTE FUNCTION trg_policy_members_household_refs_insert();

CREATE FUNCTION trg_policy_members_refs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.policy_id IS DISTINCT FROM OLD.policy_id
    OR NEW.household_member_id IS DISTINCT FROM OLD.household_member_id
    OR NEW.source_page_id IS DISTINCT FROM OLD.source_page_id THEN
    RAISE EXCEPTION 'policy member references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_members_refs_immutable BEFORE UPDATE OF policy_id, household_member_id, source_page_id ON policy_members
  FOR EACH ROW EXECUTE FUNCTION trg_policy_members_refs_immutable();

CREATE FUNCTION trg_evidence_facts_household_refs_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.case_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id)) OR
     (NEW.policy_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM policies WHERE id = NEW.policy_id AND household_id = NEW.household_id)) OR
     (NEW.subject_member_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE id = NEW.subject_member_id AND household_id = NEW.household_id)) OR
     (NEW.source_page_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM source_pages sp JOIN document_uploads du ON du.id = sp.document_upload_id
       WHERE sp.id = NEW.source_page_id AND du.household_id = NEW.household_id
     )) OR
     (NEW.statement_adult_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND adult_user_id = NEW.statement_adult_id
       UNION ALL
       SELECT 1 FROM household_roles WHERE household_id = NEW.household_id AND adult_user_id = NEW.statement_adult_id
     )) OR
     (NEW.supersedes_fact_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM evidence_facts prior
       WHERE prior.id = NEW.supersedes_fact_id AND prior.household_id = NEW.household_id AND prior.fact_key = NEW.fact_key
     )) THEN
    RAISE EXCEPTION 'evidence references must belong to the household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER evidence_facts_household_refs_insert BEFORE INSERT ON evidence_facts
  FOR EACH ROW EXECUTE FUNCTION trg_evidence_facts_household_refs_insert();

CREATE FUNCTION trg_evidence_facts_provenance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'evidence facts are append only; add a superseding fact';
END $$;
CREATE TRIGGER evidence_facts_provenance_immutable BEFORE UPDATE ON evidence_facts
  FOR EACH ROW EXECUTE FUNCTION trg_evidence_facts_provenance_immutable();

CREATE FUNCTION trg_coverage_graph_snapshots_household_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM service_cases WHERE id = NEW.case_id AND household_id = NEW.household_id) THEN
    RAISE EXCEPTION 'coverage graph case must belong to the household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coverage_graph_snapshots_household_case_insert BEFORE INSERT ON coverage_graph_snapshots
  FOR EACH ROW EXECUTE FUNCTION trg_coverage_graph_snapshots_household_case_insert();

CREATE FUNCTION trg_coverage_graph_snapshots_refs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.household_id IS DISTINCT FROM OLD.household_id OR NEW.case_id IS DISTINCT FROM OLD.case_id THEN
    RAISE EXCEPTION 'coverage graph household references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coverage_graph_snapshots_refs_immutable BEFORE UPDATE OF household_id, case_id ON coverage_graph_snapshots
  FOR EACH ROW EXECUTE FUNCTION trg_coverage_graph_snapshots_refs_immutable();

CREATE FUNCTION trg_fact_conflicts_same_fact_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM evidence_facts left_fact
    JOIN evidence_facts right_fact ON right_fact.id = NEW.right_fact_id
    WHERE left_fact.id = NEW.left_fact_id
      AND left_fact.household_id = right_fact.household_id
      AND left_fact.fact_key = NEW.fact_key
      AND right_fact.fact_key = NEW.fact_key
  ) THEN
    RAISE EXCEPTION 'conflict facts must share a household and fact key';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fact_conflicts_same_fact_insert BEFORE INSERT ON fact_conflicts
  FOR EACH ROW EXECUTE FUNCTION trg_fact_conflicts_same_fact_insert();

CREATE FUNCTION trg_coverage_graph_nodes_snapshot_fact_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM coverage_graph_snapshots cgs
    JOIN evidence_facts ef ON ef.id = NEW.source_fact_id
    WHERE cgs.id = NEW.snapshot_id AND cgs.household_id = ef.household_id
  ) THEN
    RAISE EXCEPTION 'graph source fact must belong to the snapshot household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coverage_graph_nodes_snapshot_fact_insert BEFORE INSERT ON coverage_graph_nodes
  FOR EACH ROW EXECUTE FUNCTION trg_coverage_graph_nodes_snapshot_fact_insert();

CREATE FUNCTION trg_coverage_graph_edges_snapshot_nodes_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM coverage_graph_nodes source
    JOIN coverage_graph_nodes target ON target.id = NEW.to_node_id
    WHERE source.id = NEW.from_node_id
      AND source.snapshot_id = NEW.snapshot_id
      AND target.snapshot_id = NEW.snapshot_id
  ) OR (NEW.source_fact_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM coverage_graph_snapshots cgs
    JOIN evidence_facts ef ON ef.id = NEW.source_fact_id
    WHERE cgs.id = NEW.snapshot_id AND cgs.household_id = ef.household_id
  )) THEN
    RAISE EXCEPTION 'graph edge references must belong to the snapshot';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coverage_graph_edges_snapshot_nodes_insert BEFORE INSERT ON coverage_graph_edges
  FOR EACH ROW EXECUTE FUNCTION trg_coverage_graph_edges_snapshot_nodes_insert();

CREATE FUNCTION trg_workflow_runs_household_consent_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.consent_grant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM service_cases sc
    JOIN consent_grants cg ON cg.id = NEW.consent_grant_id
    WHERE sc.id = NEW.case_id AND sc.household_id = cg.household_id
  ) THEN
    RAISE EXCEPTION 'workflow consent must belong to the case household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_household_consent_insert BEFORE INSERT ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION trg_workflow_runs_household_consent_insert();

CREATE FUNCTION trg_workflow_runs_refs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
    OR NEW.case_revision IS DISTINCT FROM OLD.case_revision
    OR NEW.consent_grant_id IS DISTINCT FROM OLD.consent_grant_id THEN
    RAISE EXCEPTION 'workflow case and consent references are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER workflow_runs_refs_immutable BEFORE UPDATE OF case_id, case_revision, consent_grant_id ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION trg_workflow_runs_refs_immutable();

CREATE FUNCTION trg_consent_scopes_profile_viewer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.resource_type = 'profile_field' AND NEW.recipient IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM consent_grants grant_record
    JOIN household_roles viewer_role
      ON viewer_role.household_id = grant_record.household_id
     AND viewer_role.adult_user_id = NEW.recipient
     AND viewer_role.status = 'active'
    WHERE grant_record.id = NEW.consent_grant_id
  ) THEN
    RAISE EXCEPTION 'profile field recipient must be an active household viewer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_scopes_profile_viewer_insert BEFORE INSERT ON consent_scopes
  FOR EACH ROW EXECUTE FUNCTION trg_consent_scopes_profile_viewer();
CREATE TRIGGER consent_scopes_profile_viewer_update BEFORE UPDATE OF consent_grant_id, resource_type, recipient ON consent_scopes
  FOR EACH ROW EXECUTE FUNCTION trg_consent_scopes_profile_viewer();

CREATE FUNCTION trg_ocr_jobs_document_ready_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM document_uploads document
    JOIN consent_grants consent ON consent.id = document.consent_grant_id
    WHERE document.id = NEW.document_upload_id
      AND document.lifecycle_state = 'active'
      AND document.malware_status IN ('clean', 'not_scanned_fixture')
      AND document.encryption_status IN ('encrypted_local', 'fixture_only')
      AND consent.purpose = 'document_processing'
      AND consent.revoked_at IS NULL
      AND (consent.expires_at IS NULL OR consent.expires_at > NEW.requested_at)
  ) THEN
    RAISE EXCEPTION 'OCR requires an active protected document and current processing consent';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER ocr_jobs_document_ready_insert BEFORE INSERT ON ocr_jobs
  FOR EACH ROW EXECUTE FUNCTION trg_ocr_jobs_document_ready_insert();

CREATE FUNCTION trg_source_pages_ocr_document_match() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.ocr_job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ocr_jobs job WHERE job.id = NEW.ocr_job_id AND job.document_upload_id = NEW.document_upload_id
  ) THEN
    RAISE EXCEPTION 'source page OCR job must belong to its document';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_pages_ocr_document_match_insert BEFORE INSERT ON source_pages
  FOR EACH ROW EXECUTE FUNCTION trg_source_pages_ocr_document_match();
CREATE TRIGGER source_pages_ocr_document_match_update BEFORE UPDATE OF document_upload_id, ocr_job_id ON source_pages
  FOR EACH ROW EXECUTE FUNCTION trg_source_pages_ocr_document_match();

CREATE FUNCTION trg_policy_record_documents_same_household() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM policy_records record
    JOIN document_uploads document ON document.household_id = record.household_id
    WHERE record.id = NEW.policy_record_id AND document.id = NEW.document_upload_id
  ) THEN
    RAISE EXCEPTION 'policy record documents must belong to the same household';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_record_documents_same_household BEFORE INSERT ON policy_record_documents
  FOR EACH ROW EXECUTE FUNCTION trg_policy_record_documents_same_household();

-- ---------------------------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------------------------

CREATE INDEX household_roles_household_idx ON household_roles(household_id, status);
CREATE INDEX household_members_household_adult_idx ON household_members(household_id, adult_user_id);
CREATE INDEX consent_grants_subject_idx ON consent_grants(subject_adult_id, purpose, revoked_at, expires_at);
CREATE INDEX consent_scopes_grant_idx ON consent_scopes(consent_grant_id, action);
CREATE INDEX consent_scopes_field_viewer_idx ON consent_scopes(resource_type, resource_id, recipient, action, consent_grant_id);
CREATE INDEX service_cases_household_idx ON service_cases(household_id, status, created_at);
CREATE INDEX case_participants_adult_case_idx ON case_participants(adult_user_id, case_id);
CREATE INDEX document_uploads_case_idx ON document_uploads(case_id, lifecycle_state);
CREATE INDEX document_uploads_household_consent_idx ON document_uploads(household_id, consent_grant_id, lifecycle_state);
CREATE INDEX ocr_jobs_document_idx ON ocr_jobs(document_upload_id, status);
CREATE INDEX ocr_jobs_lifecycle_idx ON ocr_jobs(status, requested_at, document_upload_id);
CREATE INDEX source_pages_document_idx ON source_pages(document_upload_id, page_number);
CREATE INDEX source_pages_ocr_job_idx ON source_pages(ocr_job_id);
CREATE INDEX policies_household_idx ON policies(household_id, policy_kind);
CREATE INDEX policy_members_member_idx ON policy_members(household_member_id, membership_state);
CREATE INDEX evidence_facts_case_idx ON evidence_facts(case_id, fact_key, epistemic_state);
CREATE INDEX evidence_facts_policy_idx ON evidence_facts(policy_id, fact_key);
CREATE INDEX evidence_facts_source_page_idx ON evidence_facts(source_page_id);
CREATE INDEX evidence_facts_supersedes_idx ON evidence_facts(supersedes_fact_id);
CREATE INDEX evidence_facts_statement_adult_idx ON evidence_facts(statement_adult_id, fact_key);
CREATE INDEX fact_conflicts_left_idx ON fact_conflicts(left_fact_id, resolution_state);
CREATE INDEX fact_conflicts_right_idx ON fact_conflicts(right_fact_id, resolution_state);
CREATE INDEX coverage_graph_case_idx ON coverage_graph_snapshots(case_id, version DESC);
CREATE INDEX coverage_graph_nodes_snapshot_idx ON coverage_graph_nodes(snapshot_id, node_type);
CREATE INDEX coverage_graph_edges_snapshot_idx ON coverage_graph_edges(snapshot_id, from_node_id);
CREATE INDEX workflow_runs_case_idx ON workflow_runs(case_id, created_at);
CREATE INDEX workflow_runs_consent_idx ON workflow_runs(consent_grant_id, status);
CREATE INDEX workflow_tasks_run_idx ON workflow_tasks(workflow_run_id, status);
CREATE INDEX workflow_tasks_claim_idx ON workflow_tasks(status, created_at, id);
CREATE INDEX workflow_tasks_lease_idx ON workflow_tasks(status, lease_expires_at);
CREATE INDEX workflow_task_dependencies_parent_idx ON workflow_task_dependencies(depends_on_task_id, workflow_task_id);
CREATE INDEX workflow_events_run_idx ON workflow_events(workflow_run_id, occurred_at);
CREATE INDEX reviewer_findings_run_idx ON reviewer_findings(workflow_run_id, severity, resolved_at);
CREATE INDEX human_reviews_case_idx ON human_reviews(case_id, status);
CREATE INDEX human_approvals_consent_case_idx ON human_approvals(consent_grant_id, case_id);
CREATE INDEX integration_outbox_ready_idx ON integration_outbox(status, available_at);
CREATE INDEX integration_outbox_consent_status_idx ON integration_outbox(consent_grant_id, status);
CREATE INDEX webhook_events_unprocessed_idx ON integration_webhook_events(provider, processed_at);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
CREATE INDEX retention_records_household_idx ON retention_records(household_id, deletion_state);
CREATE INDEX audit_events_case_idx ON audit_events(case_id, occurred_at);
CREATE INDEX audit_events_household_chain_idx ON audit_events(household_id, id DESC);
-- The append-only hash chain must never fork: one successor per previous hash per household.
CREATE UNIQUE INDEX audit_events_chain_unique ON audit_events ((coalesce(household_id, '')), (coalesce(previous_event_hash, '')));
CREATE INDEX api_sessions_token_status_idx ON api_sessions(token_sha256, revoked_at, expires_at);
CREATE INDEX api_sessions_adult_status_idx ON api_sessions(adult_user_id, revoked_at, expires_at);
CREATE INDEX policy_records_household_idx ON policy_records(household_id, status, created_at);
CREATE INDEX breakdown_jobs_status_idx ON breakdown_jobs(status, updated_at);
CREATE INDEX breakdown_jobs_record_idx ON breakdown_jobs(policy_record_id, created_at);
CREATE INDEX policy_parameters_section_idx ON policy_parameters(policy_record_id, section_number);
CREATE INDEX breakdown_model_calls_job_idx ON breakdown_model_calls(breakdown_job_id, created_at);

-- ---------------------------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------------------------

CREATE VIEW active_consent_grants AS
SELECT * FROM consent_grants
WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now());

CREATE VIEW unresolved_evidence AS
SELECT * FROM evidence_facts WHERE epistemic_state IN ('unknown', 'conflict');
