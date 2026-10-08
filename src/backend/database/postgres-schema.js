import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabase, createDatabaseFromEnv } from './postgres-database.js';

const migrationDirectory = fileURLToPath(new URL('./migrations-pg', import.meta.url));

const digest = contents => createHash('sha256').update(contents).digest('hex');

function migrationFiles(directory) {
  return readdirSync(directory)
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

/**
 * Applies pending migrations in one transaction guarded by an advisory lock, so several instances
 * starting together (Cloud Run, Kubernetes) migrate exactly once. An applied file may never change.
 */
export async function runMigrations(database, { directory = migrationDirectory } = {}) {
  return database.transaction(async tx => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtext('knowvia-schema-migrations'))");
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz(3) NOT NULL
    )`);
    const completed = [];
    for (const version of migrationFiles(directory)) {
      const sql = readFileSync(resolve(directory, version), 'utf8');
      const checksum = digest(sql);
      const existing = await tx.one('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${version}`);
        continue;
      }
      try {
        await tx.exec(sql);
      } catch (error) {
        throw new Error(`Migration failed: ${version}: ${error.message}`, { cause: error });
      }
      await tx.query('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)', [version, checksum, new Date().toISOString()]);
      completed.push(version);
    }
    return completed;
  });
}

const expectedTables = Object.freeze([
  'schema_migrations', 'households', 'adult_users', 'household_roles', 'household_members',
  'consent_grants', 'consent_scopes', 'consent_revocations', 'service_cases', 'case_participants',
  'document_uploads', 'ocr_jobs', 'source_pages', 'insurers', 'policies', 'policy_members',
  'evidence_facts', 'fact_conflicts', 'coverage_graph_snapshots', 'coverage_graph_nodes',
  'coverage_graph_edges', 'workflow_runs', 'workflow_tasks', 'workflow_task_dependencies',
  'workflow_events', 'reviewer_findings', 'release_gates', 'human_reviews', 'human_approvals',
  'integration_outbox', 'integration_webhook_events', 'idempotency_keys', 'retention_records',
  'audit_events', 'api_sessions',
  'policy_records', 'policy_record_documents', 'breakdown_jobs', 'policy_parameters',
  'policy_parameter_reviews', 'breakdown_model_calls',
]);

const expectedViews = Object.freeze(['active_consent_grants', 'unresolved_evidence']);

const criticalTriggers = Object.freeze([
  'consent_revocations_mark_grant', 'integration_outbox_requires_active_consent',
  'audit_events_no_update', 'audit_events_no_delete',
  'workflow_task_dependencies_same_run_insert', 'workflow_task_dependencies_same_run_update',
  'consent_grants_household_subject_insert', 'service_cases_household_refs_insert',
  'consent_scopes_household_resource_insert', 'case_participants_household_refs_insert',
  'document_uploads_household_refs_insert',
  'document_uploads_quarantine_after_insert', 'document_uploads_activation_guard',
  'policies_household_source_insert', 'policy_members_household_refs_insert',
  'evidence_facts_household_refs_insert', 'coverage_graph_snapshots_household_case_insert',
  'evidence_facts_provenance_immutable', 'fact_conflicts_same_fact_insert',
  'coverage_graph_nodes_snapshot_fact_insert', 'coverage_graph_edges_snapshot_nodes_insert',
  'workflow_runs_household_consent_insert',
  'consent_scopes_profile_viewer_insert', 'consent_scopes_profile_viewer_update',
  'ocr_jobs_document_ready_insert', 'source_pages_ocr_document_match_insert',
  'source_pages_ocr_document_match_update',
  'policy_record_documents_same_household',
]);

const criticalIndexes = Object.freeze([
  'consent_grants_subject_idx', 'service_cases_household_idx', 'document_uploads_household_consent_idx',
  'source_pages_ocr_job_idx', 'policy_members_member_idx', 'evidence_facts_case_idx',
  'workflow_runs_case_idx', 'workflow_tasks_claim_idx', 'workflow_tasks_lease_idx',
  'workflow_task_dependencies_parent_idx', 'integration_outbox_ready_idx',
  'integration_outbox_consent_status_idx', 'idempotency_keys_expiry_idx',
  'audit_events_household_chain_idx', 'audit_events_chain_unique',
  'api_sessions_token_status_idx', 'api_sessions_adult_status_idx', 'consent_scopes_field_viewer_idx',
  'ocr_jobs_lifecycle_idx',
  'policy_records_household_idx', 'breakdown_jobs_status_idx', 'policy_parameters_section_idx',
]);

const requiredColumns = Object.freeze({
  households: ['city'],
  document_uploads: ['logical_document_id', 'source_version'],
  evidence_facts: ['provenance_kind', 'statement_adult_id', 'institutional_source_ref', 'calculation_method', 'review_status'],
  workflow_runs: ['case_revision', 'consent_grant_id', 'input_json', 'terminal_reason'],
  workflow_tasks: ['input_json', 'output_json', 'lease_owner', 'lease_expires_at', 'retry_available_at', 'terminal_reason'],
  ocr_jobs: ['contract_version', 'authorization_json', 'result_json', 'result_digest', 'updated_at'],
  source_pages: ['output_contract_version', 'text_sha256', 'provider_page_ref', 'provenance_json'],
  breakdown_jobs: ['budget_micro_usd', 'spent_micro_usd'],
});

export async function validateSchema(database) {
  const tables = new Set((await database.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()")).map(row => row.name));
  const views = new Set((await database.query("SELECT viewname AS name FROM pg_views WHERE schemaname = current_schema()")).map(row => row.name));
  const triggers = new Set((await database.query(`SELECT t.tgname AS name FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = current_schema()`)).map(row => row.name));
  const indexes = new Set((await database.query("SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()")).map(row => row.name));
  const columnRows = await database.query('SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()');
  const columns = new Set(columnRows.map(row => `${row.table_name}.${row.column_name}`));
  const missingTables = expectedTables.filter(name => !tables.has(name));
  const missingViews = expectedViews.filter(name => !views.has(name));
  const missingTriggers = criticalTriggers.filter(name => !triggers.has(name));
  const missingIndexes = criticalIndexes.filter(name => !indexes.has(name));
  const missingColumns = Object.entries(requiredColumns)
    .flatMap(([table, names]) => names.map(column => `${table}.${column}`))
    .filter(name => !columns.has(name));
  // Postgres enforces foreign keys on every write; there is no deferred check to run.
  const foreignKeyErrors = [];
  const integrity = (await database.one('SELECT 1 AS ok'))?.ok === 1 ? 'ok' : 'failed';
  const valid = [missingTables, missingViews, missingTriggers, missingIndexes, missingColumns, foreignKeyErrors]
    .every(items => items.length === 0) && integrity === 'ok';
  const migrationCount = tables.has('schema_migrations') ? (await database.one('SELECT count(*) AS count FROM schema_migrations')).count : 0;
  return { valid, missingTables, missingViews, missingTriggers, missingIndexes, missingColumns, foreignKeyErrors, integrity, migrationCount };
}

export async function purgeExpiredIdempotencyKeys(database, { at = new Date().toISOString() } = {}) {
  return (await database.run('DELETE FROM idempotency_keys WHERE expires_at <= $1', [at])).rowCount;
}

/**
 * Opens a database and migrates it. Explicit `connectionString` or `pglite` options win; otherwise the driver
 * comes from the environment (DATABASE_URL, else embedded PGlite outside production).
 */
export async function openDatabase({ env = process.env, connectionString, pglite, dataDir, loadDataDir, schema, migrate = true, poolMax, statementTimeoutMs } = {}) {
  const explicit = connectionString || pglite;
  const database = explicit
    ? await createDatabase({ connectionString, pglite, dataDir, loadDataDir, schema, ...(poolMax ? { poolMax } : {}), ...(statementTimeoutMs ? { statementTimeoutMs } : {}) })
    : await createDatabaseFromEnv(env, loadDataDir ? { loadDataDir } : {});
  try {
    if (migrate) {
      await runMigrations(database);
      await purgeExpiredIdempotencyKeys(database);
    }
  } catch (error) {
    await database.close();
    throw error;
  }
  return database;
}
