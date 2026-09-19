import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const migrationDirectory = fileURLToPath(new URL('./migrations', import.meta.url));

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
  const completed = [];

  for (const version of migrationFiles(directory)) {
    const sql = readFileSync(resolve(directory, version), 'utf8');
    const checksum = digest(sql);
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = applied.get(version);
      if (existing) {
        if (existing.checksum !== checksum) throw new Error(`Applied migration changed: ${version}`);
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

const expectedTables = Object.freeze([
  'schema_migrations', 'households', 'adult_users', 'household_roles', 'household_members',
  'consent_grants', 'consent_scopes', 'consent_revocations', 'service_cases', 'case_participants',
  'document_uploads', 'ocr_jobs', 'source_pages', 'insurers', 'policies', 'policy_members',
  'evidence_facts', 'fact_conflicts', 'coverage_graph_snapshots', 'coverage_graph_nodes',
  'coverage_graph_edges', 'workflow_runs', 'workflow_tasks', 'workflow_task_dependencies',
  'workflow_events', 'reviewer_findings', 'release_gates', 'human_reviews', 'human_approvals',
  'integration_outbox', 'integration_webhook_events', 'idempotency_keys', 'retention_records',
  'audit_events',
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
]);

const criticalIndexes = Object.freeze([
  'consent_grants_subject_idx', 'service_cases_household_idx', 'document_uploads_household_consent_idx',
  'source_pages_ocr_job_idx', 'policy_members_member_idx', 'evidence_facts_case_idx',
  'workflow_runs_case_idx', 'workflow_tasks_claim_idx', 'workflow_tasks_lease_idx',
  'workflow_task_dependencies_parent_idx', 'integration_outbox_ready_idx',
  'integration_outbox_consent_status_idx', 'idempotency_keys_expiry_idx',
  'audit_events_household_chain_idx',
]);

const requiredColumns = Object.freeze({
  evidence_facts: ['provenance_kind', 'statement_adult_id', 'institutional_source_ref', 'calculation_method', 'review_status'],
  workflow_runs: ['case_revision', 'consent_grant_id', 'input_json', 'terminal_reason'],
  workflow_tasks: ['input_json', 'output_json', 'lease_owner', 'lease_expires_at', 'retry_available_at', 'terminal_reason'],
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

export function openDatabase({ path = '.local/coversaath.sqlite', migrate = true } = {}) {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(path);
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  if (migrate) {
    runMigrations(database);
    purgeExpiredIdempotencyKeys(database);
  }
  return database;
}
