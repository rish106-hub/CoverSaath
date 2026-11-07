// Data lifecycle registry (S3): where personal and derived data lives, how an erasure treats it, whether the export
// includes it and which retention rule applies. It is the single list the erasure code, the retention sweep, the export
// and the proof tests agree on. A test (tests/data-erasure-proof.test.mjs) compares it with the live PostgreSQL
// catalog: a table that is not classified here fails the build, so a new store cannot ship without an erasure decision.
//
// FOR LEGAL REVIEW: the classes, retention periods and the "retained after erasure" rows below are engineering
// placeholders. They are not legal advice and are not final. See docs/architecture/data-lifecycle.md.
//
// Erasure kinds
//   delete            every row of the erased scope is deleted.
//   scrub_prune       content columns are scrubbed in place, then the row is deleted unless another row still refers to it.
//                     A row that cannot go (a foreign key from an append-only table) stays as a content-free tombstone.
//   redact_only       an append-only trigger forbids deletion. Content columns are redacted in place through the
//                     narrow update the trigger permits; the row stays with ids, enumerations and digests only.
//   tombstone         the row stays on purpose (an audit foreign key points at it). Content columns are overwritten.
//   audit_retained    append-only audit chain. Payloads carry codes and counts only (never names, text or values).
//   ledger            the deletion ledger itself (retention_records): ids, reason code and times only.
//   global            not household data: reference data, operator data or process-wide counters.

export const ERASURE_KINDS = Object.freeze(['delete', 'scrub_prune', 'redact_only', 'tombstone', 'audit_retained', 'ledger', 'global']);

// Reason codes written to the ledger and the audit trail. 'retention_expired' and 'data_subject_request' are already
// accepted by every derived-store erasure path.
export const ERASURE_REASONS = Object.freeze({
  dataSubjectRequest: 'data_subject_request',
  retentionExpired: 'retention_expired',
});

// The name a scrubbed member or adult carries. Stored names are sealed (they start with enc1. or enc2.), so this plain
// literal can never be a real stored name; reads treat it as "erased" and skip the row.
export const ERASED_NAME = '[erased]';

const store = (table, erasure, scope, exported, note) => Object.freeze({ table, erasure, scope, exported, note });

// `scope` is a SQL predicate over the table with one placeholder: the household id. null means the rows are reached by
// adult or case id lists rather than by household (see the note). `exported` names the export section, or null.
export const DATA_STORES = Object.freeze([
  // Identity and membership
  store('households', 'tombstone', 'id = ?', 'household', 'Name overwritten, status closed; the row stays because audit_events points at it.'),
  store('adult_users', 'scrub_prune', null, 'viewer', 'Reached by adult id. Name, e-mail, phone, ciphertext and hashes cleared; account closed. Stays as a tombstone while a case tombstone names the adult.'),
  store('household_roles', 'delete', 'household_id = ?', null, 'Deleted.'),
  store('household_members', 'scrub_prune', 'household_id = ?', 'members', 'Name, label and date of birth cleared; deleted unless an append-only fact or parameter record names the member.'),
  store('api_sessions', 'delete', null, null, 'Reached by adult id. Deleted for adults who belong to no other household.'),
  store('auth_identities', 'delete', null, null, 'Reached by adult id. Deleted for adults who belong to no other household.'),
  // Consent
  store('consent_grants', 'scrub_prune', 'household_id = ?', 'consents', 'All grants revoked, then deleted unless an append-only structuring job still names the grant.'),
  store('consent_scopes', 'scrub_prune', 'consent_grant_id IN (SELECT id FROM consent_grants WHERE household_id = ?)', 'consents', 'Deleted with the grant.'),
  store('consent_revocations', 'scrub_prune', 'consent_grant_id IN (SELECT id FROM consent_grants WHERE household_id = ?)', 'consents', 'Free-text reason cleared; deleted with the grant.'),
  // Cases and workflow
  store('service_cases', 'tombstone', 'household_id = ?', 'cases', 'Case facts overwritten, status closed; the row stays because audit_events points at it. Hidden through the ledger.'),
  store('case_participants', 'delete', 'case_id IN (SELECT id FROM service_cases WHERE household_id = ?)', null, 'Deleted.'),
  store('workflow_runs', 'scrub_prune', 'case_id IN (SELECT id FROM service_cases WHERE household_id = ?)', 'runs', 'Input cleared, run revoked; deleted unless an append-only record names the run.'),
  store('workflow_tasks', 'scrub_prune', 'workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id IN (SELECT id FROM service_cases WHERE household_id = ?))', null, 'Input, output and error text cleared; deleted with the run.'),
  store('workflow_task_dependencies', 'delete', 'workflow_task_id IN (SELECT id FROM workflow_tasks WHERE workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id IN (SELECT id FROM service_cases WHERE household_id = ?)))', null, 'Deleted.'),
  store('workflow_events', 'delete', 'workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id IN (SELECT id FROM service_cases WHERE household_id = ?))', null, 'Deleted.'),
  store('reviewer_findings', 'delete', 'workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id IN (SELECT id FROM service_cases WHERE household_id = ?))', null, 'Deleted (messages can quote evidence).'),
  store('release_gates', 'delete', 'workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id IN (SELECT id FROM service_cases WHERE household_id = ?))', null, 'Deleted.'),
  store('human_reviews', 'delete', 'case_id IN (SELECT id FROM service_cases WHERE household_id = ?)', null, 'Deleted.'),
  store('human_approvals', 'delete', 'case_id IN (SELECT id FROM service_cases WHERE household_id = ?)', null, 'Deleted.'),
  store('integration_outbox', 'delete', 'case_id IN (SELECT id FROM service_cases WHERE household_id = ?)', null, 'Deleted (payloads are outgoing provider requests).'),
  store('coverage_graph_snapshots', 'scrub_prune', 'household_id = ?', null, 'Graph cleared; deleted when nothing refers to it.'),
  store('coverage_graph_nodes', 'delete', 'snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE household_id = ?)', null, 'Deleted.'),
  store('coverage_graph_edges', 'delete', 'snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE household_id = ?)', null, 'Deleted.'),
  // Documents and what is read from them
  store('document_uploads', 'scrub_prune', 'household_id = ?', 'documents', 'Erased through the document path (bytes removed, name and hash replaced); the row is deleted once the bytes are gone and nothing refers to it.'),
  store('document_blobs', 'delete', 'household_id = ?', null, 'Encrypted bytes deleted by the document erasure trigger.'),
  store('ocr_jobs', 'scrub_prune', 'document_upload_id IN (SELECT id FROM document_uploads WHERE household_id = ?)', null, 'Result and authorisation cleared; deleted with the document.'),
  store('source_pages', 'scrub_prune', 'document_upload_id IN (SELECT id FROM document_uploads WHERE household_id = ?)', null, 'Text and blocks cleared; deleted with the document unless an append-only record names the page.'),
  store('policy_clauses', 'delete', 'household_id = ?', null, 'Deleted.'),
  store('policy_answers', 'delete', 'household_id = ?', null, 'Deleted.'),
  store('catalogue_reviews', 'delete', 'household_id = ?', null, 'Deleted.'),
  store('catalogue_reviewer_grants', 'delete', 'household_id = ?', null, 'Deleted.'),
  // Policies and evidence
  store('policies', 'scrub_prune', 'household_id = ?', 'policies', 'Insurer, number, dates cleared; deleted unless a fact or parameter record names the policy.'),
  store('policy_members', 'delete', 'policy_id IN (SELECT id FROM policies WHERE household_id = ?)', null, 'Deleted.'),
  store('evidence_facts', 'redact_only', 'household_id = ?', 'facts', 'Append-only. Value, locator and source redacted; key, state and ids stay.'),
  store('fact_conflicts', 'delete', 'left_fact_id IN (SELECT id FROM evidence_facts WHERE household_id = ?)', null, 'Deleted.'),
  store('coverage_parameter_records', 'scrub_prune', 'household_id = ?', null, 'Identity is immutable; deleted unless an append-only observation names the record.'),
  store('coverage_parameter_acquisitions', 'delete', 'parameter_record_id IN (SELECT id FROM coverage_parameter_records WHERE household_id = ?)', null, 'Deleted.'),
  store('coverage_parameter_resolutions', 'delete', 'parameter_record_id IN (SELECT id FROM coverage_parameter_records WHERE household_id = ?)', null, 'Deleted (resolved values are derived data).'),
  store('coverage_parameter_observations', 'redact_only', 'parameter_record_id IN (SELECT id FROM coverage_parameter_records WHERE household_id = ?)', null, 'Append-only. Value redacted; ids and digests stay.'),
  store('coverage_parameter_registry_pins', 'redact_only', 'workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id IN (SELECT id FROM service_cases WHERE household_id = ?))', null, 'Immutable. Holds a run id and a registry version only.'),
  store('policy_structuring_runs', 'redact_only', 'household_id = ?', null, 'Append-only. Stamped erased; ids and counts stay.'),
  store('policy_structuring_jobs', 'redact_only', 'household_id = ?', null, 'Append-only. Stamped erased; ids and status stay.'),
  store('proposed_parameters', 'redact_only', 'household_id = ?', null, 'Append-only. Label and value cleared.'),
  // User-stated data
  store('profile_answers', 'delete', 'household_id = ?', 'profileAnswers', 'Deleted.'),
  store('device_permissions', 'delete', 'household_id = ?', 'userData', 'Deleted.'),
  store('household_places', 'delete', 'household_id = ?', 'userData', 'Deleted.'),
  store('adult_preferences', 'delete', 'household_id = ?', 'userData', 'Deleted.'),
  store('onboarding_progress', 'delete', 'household_id = ?', 'userData', 'Deleted.'),
  store('tool_scenarios', 'delete', 'household_id = ?', 'userData', 'Deleted.'),
  // Telemetry, idempotency, ledger and audit
  store('job_queue', 'delete', 'household_id = ?', null, 'Identifiers only (kind, document and grant ids). Deleted on revocation, document erasure and household erasure; never blocks an erasure.'),
  store('app_events', 'delete', 'household_id = ?', null, 'Deleted by household, case and adult id.'),
  store('idempotency_keys', 'delete', null, null, 'Reached by the ids a response mentions. Responses can carry document names and job content.'),
  store('retention_records', 'ledger', 'household_id = ?', null, 'The deletion ledger. Reason code and times only.'),
  store('audit_events', 'audit_retained', 'household_id = ?', 'audit', 'Append-only hash chain; codes and counts only.'),
  // Not household data
  store('insurers', 'global', null, null, 'Reference data shared by every household.'),
  store('integration_webhook_events', 'global', null, null, 'Provider events without a household key (operator data).'),
  store('model_budget_scopes', 'global', null, null, 'Process-wide spend counters.'),
  store('model_budget_reservations', 'global', null, null, 'Process-wide spend counters.'),
  store('rate_limit_buckets', 'global', null, null, 'Keyed request counters; the key is a keyed hash.'),
  store('evidence_claims', 'global', null, null, 'Short-lived question claims keyed by a hash; no household content, purged at expiry.'),
  store('schema_migrations', 'global', null, null, 'Migration ledger.'),
  store('coverage_parameter_registry_versions', 'global', null, null, 'Registry reference data.'),
  store('coverage_parameter_observation_rules', 'global', null, null, 'Rule reference data.'),
  store('curated_source_archives', 'global', null, null, 'Public insurer wording collected by operators; no household link.'),
  store('curated_product_submissions', 'global', null, null, 'Operator-curated public product data; names the curator adult only.'),
  store('curated_action_nonces', 'global', null, null, 'Operator signed-action nonces.'),
  store('source_curator_grants', 'global', null, null, 'Operator role grants; names the curator adult only.'),
]);

export const STORE_BY_TABLE = Object.freeze(Object.fromEntries(DATA_STORES.map(item => [item.table, item])));

// Export sections that are deliberately not in the export, with the reason. FOR LEGAL REVIEW.
export const EXPORT_EXCLUSIONS = Object.freeze([
  { section: 'document_bytes', reason: 'No route serves document bytes; the original files stay with the person who uploaded them.' },
  { section: 'ocr_text_and_clauses', reason: 'Text read from documents is never returned by any route; counts are included.' },
  { section: 'model_prompts_and_outputs', reason: 'Stored only as erased or unverified derived data; counts are included.' },
  { section: 'other_adults_private_data', reason: 'Places, preferences, scenarios and answers of another adult are exported to that adult only.' },
  { section: 'credentials', reason: 'Session tokens and sign-in identity hashes are never exported.' },
]);

// Retention periods are configuration with documented placeholders (docs/architecture/data-lifecycle.md). A null period
// means "not scheduled": the sweep reports nothing and deletes nothing for it. FOR LEGAL REVIEW.
export const RETENTION_RULES = Object.freeze([
  { key: 'closedCaseDays', env: 'RETENTION_CLOSED_CASE_DAYS', placeholder: 365, appliesTo: 'cases that are closed or revoked', action: 'erase the case' },
  { key: 'inactiveHouseholdDays', env: 'RETENTION_INACTIVE_HOUSEHOLD_DAYS', placeholder: 730, appliesTo: 'households with no activity', action: 'erase the household' },
  { key: 'expiredSessionDays', env: 'RETENTION_EXPIRED_SESSION_DAYS', placeholder: 30, appliesTo: 'expired or revoked API sessions', action: 'delete the session' },
  { key: 'deletedDocumentTombstoneDays', env: 'RETENTION_DELETED_DOCUMENT_DAYS', placeholder: 0, appliesTo: 'document tombstones whose bytes are gone', action: 'delete the tombstone when nothing refers to it' },
  { key: 'erasureLedgerDays', env: 'RETENTION_ERASURE_LEDGER_DAYS', placeholder: 1825, appliesTo: 'deletion ledger rows', action: 'reported only (never deleted by the sweep)' },
]);

// Consent revocation reasons (S3 review): a code from this fixed set, never free text. The reason lands in the revocation row
// and in an audit payload that can never be erased, so a person's own words must not reach either. Anything else is stored as
// 'other'. Wording shown to people for these codes is FOR LEGAL REVIEW.
export const REVOCATION_REASONS = Object.freeze([
  'user_request', 'no_longer_needed', 'privacy_concern', 'other', 'household_erasure', 'data_subject_request', 'retention_expired',
]);

export function normalizeRevocationReason(reason) {
  if (reason === null || reason === undefined) return null;
  return REVOCATION_REASONS.includes(reason) ? reason : 'other';
}
