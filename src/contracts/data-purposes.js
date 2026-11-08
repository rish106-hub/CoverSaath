// Purpose registry: every stored column, which purpose it serves, and what the notice, legal basis, retention and consenter are.
// DPDP Act 2023 s5 (notice), s6 (consent), s8 (storage limitation) and s9 (children) mapped for engineering; ADR 0018.
//
// FOR LEGAL REVIEW: legal bases, retention classes and the guardian rules below are PLACEHOLDERS, not legal advice and not
// final. No retention period is decided (ADR 0018 Q1). Deterministic code, not this file, decides consent; this file only
// describes the data so that a notice can be shown and a drift test can fail when a column appears without a purpose.
//
// Shape: DATA_REGISTRY[table] = { purpose, consenter?, retentionClass?, personal: { category: [columns] }, system: [columns] }.
// `personal` lists columns a person typed, uploaded or that are derived from what they did; `system` lists keys, timestamps,
// enums, counters and workflow bookkeeping. tests/data-purposes.test.mjs compares both lists with the migrated schema
// (information_schema), so adding a column without classifying it, or classifying one that does not exist, fails the build.
// No personal data lives in this file.
import { NOTICES, NOTICE_SET_VERSION, NOTICE_LEGAL_REVIEW_STATUS, NOTICE_LANGUAGE } from './notices/index.js';

export const PERSONAL_DATA_CATEGORIES = Object.freeze({
  identity: 'Names a person typed or a document holds.',
  contact: 'Email address or phone number.',
  demographic: 'Date of birth and similar facts about a person.',
  relationship: 'Role or relationship between people in a household.',
  location: 'Addresses, saved places and current location.',
  profile_answer: 'Answers the person gave to profile questions.',
  preference: 'Settings, permission choices and set-up progress.',
  financial: 'Amounts the person entered or estimated.',
  insurance_policy: 'Policy number (masked), dates and cover details.',
  health_or_policy_content: 'Text, facts and clauses read from policy or health documents, and sealed document bytes.',
  free_text: 'Filenames, questions, notes and reasons typed by a person, reviewer or a provider error message.',
  derived_content: 'JSON payloads and stored results made from the above.',
  derived_digest: 'Fingerprints (hashes) of the above content.',
  derived_identifier: 'Keyed fingerprints of contact or identity values.',
  credential_hash: 'Fingerprints of sign-in tokens.',
  behavioural: 'Activity records and fingerprints of a network address.',
});

// Placeholder retention classes. FOR LEGAL REVIEW. `period` stays pending until the owner records ADR 0018 Q1.
export const RETENTION_CLASSES = Object.freeze({
  until_consent_ends: { description: 'Erased when the permission is withdrawn or expires, or after the household closes.', period: 'pending_owner_decision' },
  account_lifetime: { description: 'Kept while the household exists, then erased after it closes.', period: 'pending_owner_decision' },
  operational_short: { description: 'Short technical window, removed automatically.', period: 'pending_owner_decision' },
  audit_record: { description: 'Content-free record kept for the period counsel sets.', period: 'pending_owner_decision' },
  reference_no_personal: { description: 'Holds no personal data.', period: 'not_applicable' },
});

export const CONSENTERS = Object.freeze({
  self: 'The person the data is about.',
  self_or_guardian: 'The person, or a parent or lawful guardian when the person is a child or cannot decide (DPDP s9). Verifiable guardian consent is NOT built yet.',
  not_applicable: 'No personal data, or a record that no permission governs.',
});

const placeholderBasis = candidate => Object.freeze({ status: 'pending_legal_review', candidate });

export const PURPOSES = Object.freeze({
  account_access: { noticeId: 'notice_account_access', legalBasis: placeholderBasis('contract_or_legitimate_use'), retentionClass: 'account_lifetime', consenter: 'self' },
  profile_intake: { noticeId: 'notice_profile_intake', legalBasis: placeholderBasis('consent'), retentionClass: 'account_lifetime', consenter: 'self_or_guardian' },
  affordability_planning: { noticeId: 'notice_affordability_planning', legalBasis: placeholderBasis('consent'), retentionClass: 'account_lifetime', consenter: 'self_or_guardian' },
  device_and_location: { noticeId: 'notice_device_and_location', legalBasis: placeholderBasis('consent'), retentionClass: 'account_lifetime', consenter: 'self_or_guardian' },
  document_processing: { noticeId: 'notice_document_processing', legalBasis: placeholderBasis('consent'), retentionClass: 'until_consent_ends', consenter: 'self_or_guardian' },
  coverage_reconstruction: { noticeId: 'notice_coverage_reconstruction', legalBasis: placeholderBasis('consent'), retentionClass: 'until_consent_ends', consenter: 'self_or_guardian' },
  ai_assisted_analysis: { noticeId: 'notice_ai_assisted_analysis', legalBasis: placeholderBasis('consent'), retentionClass: 'until_consent_ends', consenter: 'self_or_guardian' },
  human_review: { noticeId: 'notice_human_review', legalBasis: placeholderBasis('consent'), retentionClass: 'until_consent_ends', consenter: 'self_or_guardian' },
  consent_and_audit_record: { noticeId: 'notice_consent_and_audit_record', legalBasis: placeholderBasis('legal_obligation_or_legitimate_use'), retentionClass: 'audit_record', consenter: 'self_or_guardian' },
  service_operations: { noticeId: 'notice_service_operations', legalBasis: placeholderBasis('legitimate_use'), retentionClass: 'operational_short', consenter: 'self' },
  // No personal data: catalogue, registry and migration bookkeeping. Needs no notice.
  reference_data: { noticeId: null, legalBasis: placeholderBasis('not_applicable'), retentionClass: 'reference_no_personal', consenter: 'not_applicable' },
});

const entry = (purpose, personal, system, extra = {}) => Object.freeze({ purpose, personal: Object.freeze(personal), system: Object.freeze(system), ...extra });

export const DATA_REGISTRY = Object.freeze({
  // ---- account_access ----
  adult_users: entry('account_access',
    { identity: ['display_name'], contact: ['contact_email', 'contact_phone', 'phone_ciphertext'], derived_identifier: ['phone_hash', 'contact_email_hash'], preference: ['locale'] },
    ['id', 'account_status', 'created_at', 'updated_at']),
  auth_identities: entry('account_access',
    { derived_identifier: ['subject_sha256'] },
    ['id', 'adult_user_id', 'issuer', 'created_at', 'last_used_at', 'revoked_at']),
  api_sessions: entry('account_access',
    { credential_hash: ['token_sha256'] },
    ['id', 'adult_user_id', 'issued_at', 'expires_at', 'revoked_at', 'last_seen_at', 'created_at']),
  households: entry('account_access',
    { identity: ['display_name'] },
    ['id', 'status', 'created_at', 'updated_at']),
  household_roles: entry('account_access',
    { relationship: ['role'] },
    ['id', 'household_id', 'adult_user_id', 'status', 'starts_at', 'ends_at', 'created_at']),

  // ---- profile_intake ----
  household_members: entry('profile_intake',
    { identity: ['display_name'], demographic: ['date_of_birth'], relationship: ['relationship_label', 'member_kind'] },
    ['id', 'household_id', 'adult_user_id', 'created_at', 'updated_at']),
  profile_answers: entry('profile_intake',
    { profile_answer: ['value_ciphertext'] },
    ['id', 'household_id', 'case_id', 'adult_user_id', 'field_key', 'source', 'created_at', 'updated_at']),
  adult_preferences: entry('profile_intake', { preference: ['prefs_ciphertext'] },
    ['adult_user_id', 'household_id', 'schema_version', 'revision', 'updated_at'], { consenter: 'self' }),
  onboarding_progress: entry('profile_intake', { preference: ['state_ciphertext'] },
    ['adult_user_id', 'household_id', 'completed_at', 'revision', 'updated_at'], { consenter: 'self' }),

  // ---- affordability_planning ----
  tool_scenarios: entry('affordability_planning',
    { financial: ['inputs_ciphertext'] },
    ['id', 'household_id', 'adult_user_id', 'tool', 'schema_version', 'revision', 'updated_at']),

  // ---- device_and_location ----
  device_permissions: entry('device_and_location',
    { preference: ['state'] },
    ['id', 'household_id', 'adult_user_id', 'permission', 'surface', 'wording_version', 'decided_at', 'updated_at', 'revision'], { consenter: 'self' }),
  household_places: entry('device_and_location',
    { location: ['label_ciphertext', 'payload_ciphertext'] },
    ['id', 'household_id', 'adult_user_id', 'member_id', 'kind', 'slot', 'precision', 'source', 'captured_at', 'expires_at', 'revision']),

  // ---- document_processing ----
  document_uploads: entry('document_processing',
    { free_text: ['original_filename'], derived_digest: ['content_sha256'] },
    ['id', 'household_id', 'case_id', 'uploaded_by_adult_id', 'consent_grant_id', 'document_kind', 'storage_path', 'mime_type', 'byte_size', 'malware_status', 'encryption_status', 'lifecycle_state', 'uploaded_at', 'deleted_at', 'logical_document_id', 'source_version', 'scan_attempts', 'next_scan_at']),
  document_blobs: entry('document_processing',
    { health_or_policy_content: ['envelope'] },
    ['document_id', 'storage_key', 'household_id', 'created_at']),
  ocr_jobs: entry('document_processing',
    { health_or_policy_content: ['result_json'], derived_digest: ['result_digest'], free_text: ['error_message'] },
    ['id', 'document_upload_id', 'provider', 'provider_job_ref', 'status', 'attempt_count', 'error_code', 'requested_at', 'started_at', 'completed_at', 'contract_version', 'authorization_json', 'updated_at']),
  source_pages: entry('document_processing',
    { health_or_policy_content: ['extracted_text', 'blocks_json', 'provenance_json'], derived_digest: ['page_sha256', 'text_sha256'] },
    ['id', 'document_upload_id', 'ocr_job_id', 'page_number', 'source_version', 'extraction_status', 'confidence_basis_points', 'created_at', 'output_contract_version', 'provider_page_ref', 'blocks_upgrade_job_id']),

  // ---- coverage_reconstruction ----
  policies: entry('coverage_reconstruction',
    { insurance_policy: ['policy_number_masked', 'starts_on', 'ends_on'] },
    ['id', 'household_id', 'insurer_id', 'policy_kind', 'policy_version', 'source_document_id', 'verification_state', 'created_at', 'updated_at']),
  policy_members: entry('coverage_reconstruction',
    { insurance_policy: ['member_reference_masked'] },
    ['policy_id', 'household_member_id', 'membership_state', 'source_page_id', 'created_at']),
  service_cases: entry('coverage_reconstruction',
    { financial: ['stated_estimate_minor', 'stated_estimate_ciphertext'] },
    ['id', 'household_id', 'subject_member_id', 'opened_by_adult_id', 'trigger_type', 'status', 'emergency_mode', 'currency', 'created_at', 'updated_at', 'closed_at']),
  case_participants: entry('coverage_reconstruction', {},
    ['case_id', 'adult_user_id', 'participant_role', 'consent_grant_id', 'created_at']),
  evidence_facts: entry('coverage_reconstruction',
    { health_or_policy_content: ['value_json', 'source_locator', 'institutional_source_ref'] },
    ['id', 'household_id', 'case_id', 'policy_id', 'subject_member_id', 'fact_key', 'epistemic_state', 'evidence_kind', 'provenance_kind', 'source_page_id', 'statement_adult_id', 'calculation_method', 'asserted_by', 'effective_at', 'observed_at', 'retrieved_at', 'confidence_basis_points', 'review_status', 'subject_confirmation_state', 'permitted_viewers_json', 'expires_at', 'supersedes_fact_id', 'created_at', 'redacted_at', 'redaction_reason_code']),
  fact_conflicts: entry('coverage_reconstruction', {},
    ['id', 'fact_key', 'left_fact_id', 'right_fact_id', 'resolution_state', 'resolved_by_review_id', 'created_at', 'resolved_at']),
  policy_clauses: entry('coverage_reconstruction',
    { health_or_policy_content: ['title', 'text'], derived_digest: ['digest'] },
    ['id', 'household_id', 'case_id', 'document_id', 'source_version', 'page', 'block_indexes_json', 'kind', 'created_at']),
  coverage_graph_snapshots: entry('coverage_reconstruction',
    { derived_content: ['graph_json'] },
    ['id', 'household_id', 'case_id', 'version', 'status', 'generated_by_run_id', 'created_at']),
  coverage_graph_nodes: entry('coverage_reconstruction',
    { health_or_policy_content: ['label'] },
    ['id', 'snapshot_id', 'node_type', 'entity_ref', 'epistemic_state', 'source_fact_id', 'created_at']),
  coverage_graph_edges: entry('coverage_reconstruction', {},
    ['id', 'snapshot_id', 'from_node_id', 'to_node_id', 'relationship', 'source_fact_id', 'created_at']),
  coverage_parameter_records: entry('coverage_reconstruction', {},
    ['id', 'workflow_run_id', 'registry_version', 'parameter_key', 'household_id', 'case_id', 'subject_id', 'policy_id', 'applicable', 'created_at', 'updated_at']),
  coverage_parameter_observations: entry('coverage_reconstruction',
    { health_or_policy_content: ['value_json'], derived_digest: ['source_digest'] },
    ['id', 'parameter_record_id', 'source_id', 'document_id', 'version', 'page', 'extraction_method', 'review_status', 'observed_at', 'recorded_by', 'created_at', 'redacted_at', 'redaction_reason_code']),
  coverage_parameter_acquisitions: entry('coverage_reconstruction', {},
    ['parameter_record_id', 'acquisition_state', 'reason_code', 'requested_at', 'received_at', 'updated_by', 'updated_at']),
  coverage_parameter_resolutions: entry('coverage_reconstruction',
    { health_or_policy_content: ['resolved_value_json'] },
    ['parameter_record_id', 'resolution_state', 'resolved_observation_id', 'reason_code', 'transition_authority', 'updated_by', 'updated_at']),
  workflow_runs: entry('coverage_reconstruction',
    { health_or_policy_content: ['input_json'], derived_digest: ['input_digest'] },
    ['id', 'case_id', 'workflow_name', 'workflow_version', 'execution_mode', 'status', 'started_at', 'finished_at', 'created_at', 'case_revision', 'consent_grant_id', 'terminal_reason']),
  workflow_tasks: entry('coverage_reconstruction',
    { health_or_policy_content: ['input_json', 'output_json'], derived_digest: ['input_digest', 'output_digest'], free_text: ['last_error_message'] },
    ['id', 'workflow_run_id', 'parent_task_id', 'agent_name', 'task_kind', 'status', 'attempt_count', 'started_at', 'finished_at', 'created_at', 'lease_owner', 'lease_expires_at', 'retry_available_at', 'last_error_code', 'terminal_reason']),
  workflow_task_dependencies: entry('coverage_reconstruction', {},
    ['workflow_task_id', 'depends_on_task_id', 'created_at']),
  workflow_events: entry('coverage_reconstruction',
    { derived_content: ['event_payload_json'] },
    ['id', 'workflow_run_id', 'workflow_task_id', 'event_type', 'occurred_at']),
  integration_outbox: entry('coverage_reconstruction',
    { derived_content: ['payload_json'], derived_digest: ['payload_digest'], free_text: ['last_error'] },
    ['id', 'case_id', 'provider', 'operation', 'consent_grant_id', 'human_approval_id', 'release_gate_id', 'status', 'attempt_count', 'available_at', 'locked_at', 'created_at', 'updated_at']),
  integration_webhook_events: entry('coverage_reconstruction',
    { derived_content: ['payload_json'], free_text: ['processing_error'] },
    ['id', 'provider', 'provider_event_id', 'event_type', 'signature_status', 'received_at', 'processed_at']),

  // ---- ai_assisted_analysis ----
  policy_answers: entry('ai_assisted_analysis',
    { free_text: ['question'], health_or_policy_content: ['answer_json'], derived_digest: ['request_digest'] },
    ['id', 'household_id', 'case_id', 'requested_by_adult_id', 'idempotency_key', 'state', 'document_ids_json', 'created_at']),
  proposed_parameters: entry('ai_assisted_analysis',
    { health_or_policy_content: ['label', 'value_json'] },
    ['id', 'structuring_run_id', 'household_id', 'document_id', 'source_page_id', 'registry_version', 'proposed_key', 'category', 'page', 'block_index', 'status', 'created_at', 'redacted_at', 'redaction_reason_code']),
  policy_structuring_jobs: entry('ai_assisted_analysis', {},
    ['id', 'household_id', 'case_id', 'workflow_run_id', 'document_id', 'source_version', 'pipeline_version', 'status', 'evidence_outcome', 'error_code', 'attempt', 'consent_grant_id', 'started_at', 'updated_at', 'finished_at', 'structuring_run_id', 'erased_at', 'erasure_reason_code']),
  policy_structuring_runs: entry('ai_assisted_analysis', {},
    ['id', 'household_id', 'case_id', 'workflow_run_id', 'document_id', 'source_version', 'pipeline_version', 'counts_json', 'created_at', 'erased_at', 'erasure_reason_code']),

  // ---- human_review ----
  human_reviews: entry('human_review', {},
    ['id', 'case_id', 'workflow_run_id', 'reviewer_adult_id', 'review_kind', 'status', 'recommendation_outcome', 'conflict_disclosure_shown', 'started_at', 'completed_at', 'created_at']),
  human_approvals: entry('human_review',
    { derived_digest: ['approved_payload_digest'] },
    ['id', 'case_id', 'adult_user_id', 'consent_grant_id', 'approval_kind', 'target_type', 'target_id', 'decision', 'decided_at', 'created_at']),
  reviewer_findings: entry('human_review',
    { free_text: ['message', 'resolution_note'] },
    ['id', 'workflow_run_id', 'workflow_task_id', 'reviewer_kind', 'severity', 'finding_code', 'source_fact_id', 'resolved_at', 'created_at']),
  release_gates: entry('human_review', {},
    ['id', 'workflow_run_id', 'gate_kind', 'status', 'blocker_count', 'decided_by', 'decided_at', 'created_at']),
  catalogue_reviewer_grants: entry('human_review', {},
    ['id', 'household_id', 'adult_user_id', 'kind', 'status', 'granted_by', 'created_at', 'revoked_at', 'expires_at', 'case_id', 'granted_at']),
  catalogue_reviews: entry('human_review',
    { health_or_policy_content: ['fact_json'], derived_digest: ['request_digest', 'source_digests_json'] },
    ['id', 'household_id', 'case_id', 'grant_id', 'reviewer_adult_id', 'authority', 'decision', 'reason_code', 'idempotency_key', 'document_id', 'source_version', 'clause_ids_json', 'fact_key', 'created_at']),

  // ---- consent_and_audit_record ----
  consent_grants: entry('consent_and_audit_record', {},
    ['id', 'household_id', 'subject_adult_id', 'granted_to_actor', 'purpose', 'notice_version', 'evidence_method', 'granted_at', 'expires_at', 'revoked_at', 'created_at']),
  consent_scopes: entry('consent_and_audit_record', {},
    ['id', 'consent_grant_id', 'resource_type', 'resource_id', 'action', 'data_category', 'recipient', 'created_at']),
  consent_revocations: entry('consent_and_audit_record',
    { free_text: ['reason'] },
    ['id', 'consent_grant_id', 'revoked_by_adult_id', 'revoked_at', 'downstream_deletion_due_at', 'created_at']),
  audit_events: entry('consent_and_audit_record',
    { derived_content: ['event_payload_json'] },
    ['id', 'household_id', 'case_id', 'actor_type', 'actor_id', 'action', 'resource_type', 'resource_id', 'previous_event_hash', 'event_hash', 'occurred_at']),
  retention_records: entry('consent_and_audit_record', {},
    ['id', 'household_id', 'resource_type', 'resource_id', 'retention_basis', 'retain_until', 'deletion_state', 'requested_by_adult_id', 'requested_at', 'deleted_at', 'verified_at', 'created_at', 'updated_at']),

  // ---- service_operations ----
  app_events: entry('service_operations',
    { behavioural: ['client_hash', 'payload_enc'] },
    ['id', 'occurred_at', 'expires_at', 'event_name', 'request_id', 'household_id', 'adult_user_id', 'case_id', 'consent_grant_id', 'route', 'method', 'status', 'duration_ms', 'provider', 'outcome', 'code', 'redacted_at']),
  job_queue: entry('service_operations',
    { derived_identifier: ['payload_json'] },
    ['id', 'kind', 'household_id', 'document_id', 'consent_grant_id', 'payload_json', 'dedupe_key', 'status', 'attempts', 'max_attempts', 'run_after', 'locked_by', 'lease_expires_at', 'last_error_code', 'created_at', 'updated_at', 'finished_at']),
  rate_limit_buckets: entry('service_operations',
    { behavioural: ['key_hash'] },
    ['window_start', 'request_count']),
  idempotency_keys: entry('service_operations',
    { derived_content: ['response_json'], derived_digest: ['request_digest'], derived_identifier: ['document_index'] },
    ['scope', 'idempotency_key', 'response_status', 'locked_until', 'expires_at', 'created_at']),
  model_budget_reservations: entry('service_operations', {},
    ['id', 'scope', 'amount_micro_usd', 'state', 'actual_micro_usd', 'task', 'created_at', 'settled_at']),
  // Evidence-question leases (migration 032): hashed claim key, random owner token and timestamps; no household content.
  evidence_claims: entry('service_operations', {},
    ['claim_hash', 'owner', 'claimed_at', 'expires_at']),
  model_budget_scopes: entry('service_operations', {},
    ['scope', 'reserved_micro_usd', 'spent_micro_usd', 'updated_at']),

  // ---- reference_data (no personal data) ----
  insurers: entry('reference_data', {}, ['id', 'legal_name', 'regulator_identifier', 'created_at']),
  schema_migrations: entry('reference_data', {}, ['version', 'checksum', 'applied_at']),
  coverage_parameter_registry_versions: entry('reference_data', {}, ['version', 'registered_at']),
  coverage_parameter_registry_pins: entry('reference_data', {}, ['workflow_run_id', 'registry_version', 'pinned_at', 'created_at']),
  coverage_parameter_observation_rules: entry('reference_data', {}, ['extraction_method', 'resolution_state', 'transition_authority', 'requires_accepted']),
  curated_product_submissions: entry('reference_data', {},
    ['id', 'uin', 'insurer', 'product_name', 'wording_version', 'source_url', 'source_version_id', 'content_sha256', 'retrieved_on', 'effective_from', 'page_texts_json', 'facts_json', 'machine_checks_json', 'state', 'collected_by', 'checked_by', 'checked_at', 'published_at', 'previous_id', 'last_revalidated_at', 'created_at', 'page_text_origin', 'text_extractor_version']),
  curated_source_archives: entry('reference_data', {}, ['sha256', 'byte_size', 'content', 'created_at']),
  curated_action_nonces: entry('reference_data', {}, ['nonce', 'grant_id', 'action', 'submission_id', 'signature_sha256', 'used_at']),
  source_curator_grants: entry('reference_data', {}, ['id', 'adult_user_id', 'role', 'status', 'granted_by', 'created_at', 'expires_at', 'revoked_at', 'public_key']),
  reference_cache: entry('reference_data', {}, ['key', 'etag', 'body', 'signature', 'fetched_at', 'stale_after', 'status']),
  reference_cache_leases: entry('reference_data', {}, ['key', 'owner', 'claimed_at', 'expires_at']),
});

/** One row per stored column: { table, column, kind: 'personal'|'system', category, purpose, noticeId, legalBasis, retentionClass, consenter }. */
export function registryFields() {
  const rows = [];
  for (const [table, spec] of Object.entries(DATA_REGISTRY)) {
    const purpose = PURPOSES[spec.purpose];
    const base = {
      table, purpose: spec.purpose, noticeId: purpose.noticeId, legalBasis: purpose.legalBasis,
      retentionClass: spec.retentionClass ?? purpose.retentionClass, consenter: spec.consenter ?? purpose.consenter,
    };
    for (const [category, columns] of Object.entries(spec.personal)) {
      for (const column of columns) rows.push({ ...base, column, kind: 'personal', category });
    }
    for (const column of spec.system) rows.push({ ...base, column, kind: 'system', category: null });
  }
  return rows;
}

/** One notice by id in the same shape as the list, or null. */
export function noticeView(id) {
  return noticeSetView().notices.find(notice => notice.id === id) ?? null;
}

/** The public notice list: static text and the registry facts a reader needs. No household, adult or other stored data. */
export function noticeSetView() {
  const consenterByPurpose = id => PURPOSES[id].consenter;
  return {
    version: NOTICE_SET_VERSION,
    language: NOTICE_LANGUAGE,
    legalReview: NOTICE_LEGAL_REVIEW_STATUS,
    notices: NOTICES.map(notice => ({
      id: notice.id,
      version: notice.version,
      purposeId: notice.purposeId,
      title: notice.title,
      summary: notice.summary,
      items: notice.items.map(item => ({ data: item.data, use: item.use })),
      recipients: [...notice.recipients],
      retention: notice.retention,
      retentionClass: PURPOSES[notice.purposeId].retentionClass,
      withdrawal: notice.withdrawal,
      consentBy: consenterByPurpose(notice.purposeId),
      guardianNote: notice.guardianNote,
      legalReview: notice.legalReview,
    })),
  };
}
