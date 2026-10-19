import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const migrationDirectory = fileURLToPath(new URL('./migrations', import.meta.url));
const legacyMigrationChecksums = Object.freeze({
  '002_integrity_and_provenance.sql': new Set(['afdfdcf9c4f6425bafe5bd2d3e0d5404bdf6378bdf2b172a74badd27af391110']),
});

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function migrationFiles(directory) {
  return readdirSync(directory)
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

export function runMigrations(database, { directory = migrationDirectory } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied = database.prepare('SELECT checksum FROM schema_migrations WHERE version = ?');
  const record = database.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)');
  const refreshChecksum = database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?');
  const completed = [];

  for (const version of migrationFiles(directory)) {
    const sql = readFileSync(resolve(directory, version), 'utf8');
    const checksum = digest(sql);
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = applied.get(version);
      if (existing) {
        if (existing.checksum !== checksum) {
          if (!legacyMigrationChecksums[version]?.has(existing.checksum)) throw new Error(`Applied migration changed: ${version}`);
          refreshChecksum.run(checksum, version);
        }
        database.exec('COMMIT');
        continue;
      }
      database.exec(sql);
      record.run(version, checksum, new Date().toISOString());
      database.exec('COMMIT');
      completed.push(version);
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Migration failed: ${version}: ${error.message}`, { cause: error });
    }
  }
  return completed;
}

export const expectedTables = Object.freeze([
  'schema_migrations', 'households', 'adult_users', 'household_roles', 'household_members',
  'consent_grants', 'consent_scopes', 'consent_revocations', 'service_cases', 'case_participants',
  'document_uploads', 'ocr_jobs', 'source_pages', 'insurers', 'policies', 'policy_members',
  'evidence_facts', 'fact_conflicts', 'coverage_graph_snapshots', 'coverage_graph_nodes',
  'coverage_graph_edges', 'workflow_runs', 'workflow_tasks', 'workflow_task_dependencies',
  'workflow_events', 'reviewer_findings', 'release_gates', 'human_reviews', 'human_approvals',
  'integration_outbox', 'integration_webhook_events', 'idempotency_keys', 'retention_records',
  'audit_events', 'api_sessions', 'coverage_parameter_registry_versions',
  'coverage_parameter_registry_pins', 'coverage_parameter_records',
  'coverage_parameter_acquisitions', 'coverage_parameter_observations',
  'coverage_parameter_resolutions', 'coverage_parameter_observation_rules',
  'policy_structuring_runs', 'proposed_parameters',
]);

export const expectedViews = Object.freeze(['active_consent_grants', 'unresolved_evidence']);

export const criticalTriggers = Object.freeze([
  'consent_revocations_mark_grant', 'integration_outbox_requires_active_consent',
  'audit_events_no_update', 'audit_events_no_delete',
  'workflow_task_dependencies_same_run_insert', 'workflow_task_dependencies_same_run_update',
  'consent_grants_household_subject_insert', 'service_cases_household_refs_insert',
  'consent_scopes_household_resource_insert', 'case_participants_household_refs_insert',
  'document_uploads_household_refs_insert',
  'document_uploads_quarantine_after_insert', 'document_uploads_activation_guard',
  'policies_household_source_insert', 'policy_members_household_refs_insert',
  'evidence_facts_household_refs_insert', 'coverage_graph_snapshots_household_case_insert',
  'evidence_facts_provenance_immutable', 'evidence_facts_no_delete', 'evidence_facts_redaction_insert',
  'evidence_facts_erased_document_insert', 'evidence_facts_redaction_format_update',
  'evidence_facts_redact_on_document_erasure', 'fact_conflicts_same_fact_insert',
  'coverage_graph_nodes_snapshot_fact_insert', 'coverage_graph_edges_snapshot_nodes_insert',
  'workflow_runs_household_consent_insert',
  'consent_scopes_profile_viewer_insert', 'consent_scopes_profile_viewer_update',
  'ocr_jobs_document_ready_insert', 'source_pages_ocr_document_match_insert',
  'source_pages_ocr_document_match_update',
  'coverage_parameter_records_scope_insert', 'coverage_parameter_records_identity_immutable',
  'coverage_parameter_observations_source_insert', 'coverage_parameter_observations_no_update',
  'coverage_parameter_observations_no_delete', 'coverage_parameter_resolutions_observation_insert',
  'coverage_parameter_resolutions_observation_update',
  'coverage_parameter_resolutions_authority_insert', 'coverage_parameter_resolutions_authority_update',
  'coverage_parameter_resolutions_model_no_downgrade', 'coverage_parameter_resolutions_not_permitted_exit',
  'coverage_parameter_observations_redaction_resets_resolution',
  'coverage_parameter_observations_redact_on_document_erasure',
  'coverage_parameter_registry_pins_immutable', 'coverage_parameter_registry_pins_no_delete',
  'coverage_parameter_registry_versions_immutable',
  'coverage_parameter_registry_versions_no_delete', 'coverage_parameter_observation_rules_immutable',
  'coverage_parameter_observation_rules_no_delete',
  'coverage_parameter_observations_active_document_insert', 'coverage_parameter_observations_human_review_insert',
  'policy_structuring_runs_scope_insert', 'policy_structuring_runs_active_document_insert',
  'policy_structuring_runs_erased_insert', 'policy_structuring_runs_no_update', 'policy_structuring_runs_no_delete',
  'proposed_parameters_scope_insert', 'proposed_parameters_active_document_insert',
  'proposed_parameters_initial_state_insert', 'proposed_parameters_no_update', 'proposed_parameters_no_delete',
  'policy_structuring_erase_on_document_erasure',
]);

export const criticalIndexes = Object.freeze([
  'consent_grants_subject_idx', 'service_cases_household_idx', 'document_uploads_household_consent_idx',
  'source_pages_ocr_job_idx', 'policy_members_member_idx', 'evidence_facts_case_idx',
  'workflow_runs_case_idx', 'workflow_tasks_claim_idx', 'workflow_tasks_lease_idx',
  'workflow_task_dependencies_parent_idx', 'integration_outbox_ready_idx',
  'integration_outbox_consent_status_idx', 'idempotency_keys_expiry_idx',
  'audit_events_household_chain_idx',
  'api_sessions_token_status_idx', 'api_sessions_adult_status_idx', 'consent_scopes_field_viewer_idx',
  'ocr_jobs_lifecycle_idx',
  'coverage_parameter_records_run_idx', 'coverage_parameter_records_case_idx',
  'coverage_parameter_observations_parameter_idx', 'coverage_parameter_observations_document_idx',
  'document_uploads_household_content_live_uidx', 'document_uploads_household_logical_version_uidx',
  'document_uploads_work_idx',
  'policy_structuring_runs_live_identity_uidx', 'policy_structuring_runs_document_idx',
  'proposed_parameters_document_idx', 'proposed_parameters_run_idx',
]);

export const requiredColumns = Object.freeze({
  document_uploads: ['logical_document_id', 'source_version', 'scan_attempts', 'next_scan_at'],
  evidence_facts: ['provenance_kind', 'statement_adult_id', 'institutional_source_ref', 'calculation_method', 'review_status', 'redacted_at', 'redaction_reason_code'],
  workflow_runs: ['case_revision', 'consent_grant_id', 'input_json', 'terminal_reason'],
  workflow_tasks: ['input_json', 'output_json', 'lease_owner', 'lease_expires_at', 'retry_available_at', 'terminal_reason'],
  ocr_jobs: ['contract_version', 'authorization_json', 'result_json', 'result_digest', 'updated_at'],
  source_pages: ['output_contract_version', 'text_sha256', 'provider_page_ref', 'provenance_json'],
  coverage_parameter_records: ['registry_version', 'parameter_key', 'subject_id', 'policy_id', 'applicable'],
  coverage_parameter_resolutions: ['resolution_state', 'transition_authority'],
  coverage_parameter_observations: ['redacted_at', 'redaction_reason_code'],
  coverage_parameter_observation_rules: ['extraction_method', 'resolution_state', 'transition_authority', 'requires_accepted'],
  policy_structuring_runs: ['erased_at', 'erasure_reason_code', 'counts_json'],
  proposed_parameters: ['redacted_at', 'redaction_reason_code', 'status'],
});

export function validateSchema(database) {
  const schemaObjects = database.prepare("SELECT type, name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const byType = type => new Set(schemaObjects.filter(item => item.type === type).map(item => item.name));
  const tables = byType('table');
  const views = byType('view');
  const triggers = byType('trigger');
  const indexes = byType('index');
  const missingTables = expectedTables.filter(name => !tables.has(name));
  const missingViews = expectedViews.filter(name => !views.has(name));
  const missingTriggers = criticalTriggers.filter(name => !triggers.has(name));
  const missingIndexes = criticalIndexes.filter(name => !indexes.has(name));
  const missingColumns = Object.entries(requiredColumns).flatMap(([table, columns]) => {
    if (!tables.has(table)) return columns.map(column => `${table}.${column}`);
    const existingColumns = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
    return columns.filter(column => !existingColumns.has(column)).map(column => `${table}.${column}`);
  });
  const foreignKeyErrors = database.prepare('PRAGMA foreign_key_check').all();
  const integrity = database.prepare('PRAGMA quick_check').get().quick_check;
  const valid = [missingTables, missingViews, missingTriggers, missingIndexes, missingColumns, foreignKeyErrors]
    .every(items => items.length === 0) && integrity === 'ok';
  return {
    valid,
    missingTables,
    missingViews,
    missingTriggers,
    missingIndexes,
    missingColumns,
    foreignKeyErrors,
    integrity,
    migrationCount: database.prepare('SELECT count(*) AS count FROM schema_migrations').get().count
  };
}

export function purgeExpiredIdempotencyKeys(database, { at = new Date().toISOString() } = {}) {
  return database.prepare(`DELETE FROM idempotency_keys
    WHERE julianday(expires_at) IS NOT NULL AND julianday(expires_at) <= julianday(?)`).run(at).changes;
}

export function openDatabase({ path = '.local/knowvia.sqlite', migrate = true } = {}) {
  const inMemory = path === ':memory:';
  const databaseRoot = resolve('.local');
  const resolvedPath = inMemory ? ':memory:' : resolve(databaseRoot, path);
  if (!inMemory) {
    const relativeToRoot = relative(databaseRoot, resolvedPath);
    if (relativeToRoot.startsWith('..') || relativeToRoot === '' || relativeToRoot.startsWith('../')) {
      throw new Error('Invalid database path: path must be within .local');
    }
    mkdirSync(dirname(resolvedPath), { recursive: true, mode: 0o700 });
  }
  const database = new DatabaseSync(resolvedPath);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  if (!inMemory) database.exec('PRAGMA journal_mode = WAL');
  if (migrate) {
    runMigrations(database);
    purgeExpiredIdempotencyKeys(database);
  }
  return database;
}
