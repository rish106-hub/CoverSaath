import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPostgresPool, postgresMigrationDirectory, postgresMigrationFiles, postgresTestMigrationRoot,
  runPostgresMigrations, validatePostgresSchema,
} from '../src/backend/database/postgres/index.js';
import {
  adminQuery, createTestDatabase, ensureTemplate, migrationSetDigest, postgresTestOptions, useBlankDatabase, useTestDatabase,
} from './support/postgres.mjs';
import { insert, one } from './support/postgres-fixtures.mjs';

const baseline = ['001_baseline_schema.sql', '002_baseline_triggers.sql', '003_harden_invariants.sql', '004_document_intake_scheduling.sql', '005_evidence_fact_redaction.sql', '006_evidence_fact_redaction_hardening.sql', '007_policy_structuring.sql', '008_julianday_hour_24.sql', '009_source_page_blocks.sql', '010_policy_structuring_jobs.sql', '011_source_page_blocks_upgrade.sql', '012_policy_evidence.sql', '013_catalogue_reviews.sql', '014_curated_product_workflow.sql'];

function scratchDirectory(t, files = {}) {
  mkdirSync(postgresTestMigrationRoot, { recursive: true });
  const directory = mkdtempSync(join(postgresTestMigrationRoot, 'runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql);
  return directory;
}

test('a fresh database migrates, records checksums, validates, and a repeat run is a no-op', postgresTestOptions(), async t => {
  const { pool } = await useBlankDatabase(t);
  assert.deepEqual(postgresMigrationFiles(), baseline);
  assert.deepEqual(await runPostgresMigrations(pool), baseline);
  assert.deepEqual(await runPostgresMigrations(pool), []);

  const rows = (await pool.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
  assert.deepEqual(rows.map(row => row.version), baseline);
  for (const row of rows) {
    const sql = readFileSync(join(postgresMigrationDirectory, row.version), 'utf8');
    assert.equal(row.checksum, createHash('sha256').update(sql).digest('hex'));
    assert.match(row.applied_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  const validation = await validatePostgresSchema(pool);
  assert.deepEqual(
    { ...validation, foreignKeyErrors: validation.foreignKeyErrors.length },
    {
      valid: true, missingTables: [], missingViews: [], missingTriggers: [], missingIndexes: [], missingColumns: [],
      disabledTriggers: [], foreignKeyErrors: 0, collation: 'C', localeProvider: 'c', orderingValid: true,
      collationValid: true, unsafeFunctionSearchPaths: [], migrationCount: 14,
    },
  );
  const publicTemporary = await one(pool, `SELECT count(*)::int AS n
    FROM pg_database d, LATERAL aclexplode(COALESCE(d.datacl, acldefault('d', d.datdba))) acl
    WHERE d.datname = current_database() AND acl.grantee = 0 AND acl.privilege_type = 'TEMPORARY'`);
  assert.equal(publicTemporary.n, 0, 'PUBLIC cannot create temporary objects in the migrated database');
});

test('a changed applied migration is refused and nothing later is applied', postgresTestOptions(), async t => {
  const { pool } = await useBlankDatabase(t);
  const directory = scratchDirectory(t, {
    '001_first.sql': 'CREATE TABLE first_table (id bigint);\n',
    '002_second.sql': 'CREATE TABLE second_table (id bigint);\n',
  });
  assert.deepEqual(await runPostgresMigrations(pool, { directory }), ['001_first.sql', '002_second.sql']);
  writeFileSync(join(directory, '001_first.sql'), 'CREATE TABLE first_table (id bigint);\n-- edited after it was applied\n');
  writeFileSync(join(directory, '003_third.sql'), 'CREATE TABLE third_table (id bigint);\n');
  await assert.rejects(runPostgresMigrations(pool, { directory }), error => {
    assert.equal(error.code, 'POSTGRES_MIGRATION_CHECKSUM_CHANGED');
    assert.match(error.message, /001_first\.sql/);
    return true;
  });
  assert.equal((await one(pool, "SELECT to_regclass('third_table') AS name")).name, null);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM schema_migrations')).n, 2);
});

test('a failing migration file rolls back completely and can be fixed and re-run', postgresTestOptions(), async t => {
  const { pool } = await useBlankDatabase(t);
  const directory = scratchDirectory(t, {
    '001_good.sql': 'CREATE TABLE good_table (id bigint);\n',
    '002_broken.sql': 'CREATE TABLE partial_table (id bigint);\nINSERT INTO partial_table VALUES (1);\nCREATE FUNCTION partial_fn() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;\nSELECT 1 / 0;\n',
  });
  await assert.rejects(runPostgresMigrations(pool, { directory }), error => {
    assert.equal(error.code, 'POSTGRES_MIGRATION_FAILED');
    assert.match(error.message, /002_broken\.sql/);
    assert.doesNotMatch(error.message, /division by zero/i);
    return true;
  });
  assert.deepEqual((await pool.query('SELECT version FROM schema_migrations')).rows.map(row => row.version), ['001_good.sql']);
  assert.equal((await one(pool, "SELECT to_regclass('partial_table') AS name")).name, null);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'partial_fn'")).n, 0);
  assert.equal((await one(pool, "SELECT to_regclass('good_table')::text AS name")).name, 'good_table');
  const lock = await one(pool, `SELECT count(*)::int AS n FROM pg_locks
    WHERE locktype = 'advisory' AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`);
  assert.equal(lock.n, 0, 'the advisory lock is released after a failure');

  writeFileSync(join(directory, '002_broken.sql'), 'CREATE TABLE partial_table (id bigint);\n');
  assert.deepEqual(await runPostgresMigrations(pool, { directory }), ['002_broken.sql']);
});

test('concurrent runners wait beyond pool lock_timeout and apply each file exactly once', postgresTestOptions(), async t => {
  const { pool, url } = await useBlankDatabase(t);
  const directory = scratchDirectory(t, {
    '001_log.sql': 'CREATE TABLE apply_log (version text);\n',
    '002_entry.sql': "INSERT INTO apply_log VALUES ('002');\nSELECT pg_sleep(0.3);\n",
    '003_entry.sql': "INSERT INTO apply_log VALUES ('003');\n",
  });
  const pools = Array.from({ length: 5 }, () => createPostgresPool({
    connectionString: url, max: 2, lockTimeoutMs: 50, applicationName: 'runner-race',
  }));
  t.after(() => Promise.all(pools.map(item => item.end())));
  const results = await Promise.all(pools.map(item => runPostgresMigrations(item, { directory })));
  assert.deepEqual(results.flat().sort(), ['001_log.sql', '002_entry.sql', '003_entry.sql']);
  assert.deepEqual((await pool.query('SELECT version FROM apply_log ORDER BY version')).rows.map(row => row.version), ['002', '003']);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM schema_migrations')).n, 3);

  const real = await useBlankDatabase(t);
  const racers = Array.from({ length: 4 }, () => createPostgresPool({ connectionString: real.url, max: 2, applicationName: 'runner-race' }));
  t.after(() => Promise.all(racers.map(item => item.end())));
  const applied = await Promise.all(racers.map(item => runPostgresMigrations(item)));
  assert.deepEqual(applied.flat().sort(), baseline);
  assert.equal((await validatePostgresSchema(real.pool)).valid, true);
});

test('the migration runner restores lock_timeout and redacts setup failures', postgresTestOptions(), async t => {
  const { url } = await useBlankDatabase(t);
  const pool = createPostgresPool({ connectionString: url, max: 1, lockTimeoutMs: 77, applicationName: 'runner-restore' });
  t.after(() => pool.end());
  const directory = scratchDirectory(t, {
    '001_one.sql': "CREATE TABLE one_table (lock_timeout text);\nINSERT INTO one_table VALUES (current_setting('lock_timeout'));\n",
  });
  await runPostgresMigrations(pool, { directory });
  assert.equal((await one(pool, "SELECT current_setting('lock_timeout') AS value")).value, '77ms');
  // Migration statements run under the pool lock_timeout; only the advisory-lock wait disables it.
  assert.equal((await one(pool, 'SELECT lock_timeout FROM one_table')).lock_timeout, '77ms');

  await assert.rejects(runPostgresMigrations({
    connect: async () => { throw new Error('secret-host.example internal driver detail'); },
  }, { directory }), error => {
    assert.equal(error.code, 'POSTGRES_MIGRATION_FAILED');
    assert.equal(error.message, 'PostgreSQL migration runner could not connect.');
    assert.doesNotMatch(error.message, /secret-host|driver/i);
    return true;
  });
});

test('validatePostgresSchema reports a dropped, disabled or missing critical object', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  assert.equal((await validatePostgresSchema(pool)).valid, true);

  await pool.query('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
  let result = await validatePostgresSchema(pool);
  assert.equal(result.valid, false);
  assert.deepEqual(result.disabledTriggers, ['audit_events_no_update']);
  await pool.query('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');

  await pool.query('DROP TRIGGER audit_events_no_delete ON audit_events');
  result = await validatePostgresSchema(pool);
  assert.equal(result.valid, false);
  assert.deepEqual(result.missingTriggers, ['audit_events_no_delete']);

  await pool.query('DROP TRIGGER audit_events_no_truncate ON audit_events');
  result = await validatePostgresSchema(pool);
  assert.deepEqual(result.missingTriggers, ['audit_events_no_delete', 'audit_events_no_truncate']);

  await pool.query('DROP INDEX workflow_tasks_claim_idx');
  assert.deepEqual((await validatePostgresSchema(pool)).missingIndexes, ['workflow_tasks_claim_idx']);

  await pool.query('ALTER TABLE ocr_jobs DROP COLUMN result_digest');
  assert.deepEqual((await validatePostgresSchema(pool)).missingColumns, ['ocr_jobs.result_digest']);

  await pool.query('DROP VIEW unresolved_evidence');
  assert.deepEqual((await validatePostgresSchema(pool)).missingViews, ['unresolved_evidence']);

  await pool.query('DROP TABLE integration_webhook_events');
  const missing = await validatePostgresSchema(pool);
  assert.deepEqual(missing.missingTables, ['integration_webhook_events']);
  assert.equal(missing.valid, false);
});

test('validatePostgresSchema rejects a guard function without the fixed search path', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  await pool.query('ALTER FUNCTION document_uploads_household_refs_insert_fn() RESET search_path');
  const result = await validatePostgresSchema(pool);
  assert.equal(result.valid, false);
  assert.deepEqual(result.unsafeFunctionSearchPaths, ['document_uploads_household_refs_insert_fn()']);
});

test('validatePostgresSchema ignores extension-owned functions in the project schema', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  await pool.query('CREATE EXTENSION pgcrypto SCHEMA public');
  const result = await validatePostgresSchema(pool);
  assert.deepEqual(result.unsafeFunctionSearchPaths, []);
  assert.equal(result.valid, true);
});

test('validatePostgresSchema finds orphaned rows behind a NOT VALID foreign key', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  await insert(pool, 'households', { id: 'household-orphan-parent' });
  await pool.query('ALTER TABLE household_roles DROP CONSTRAINT household_roles_household_id_fkey');
  await insert(pool, 'adult_users', { id: 'adult-orphan' });
  await insert(pool, 'household_roles', { id: 'role-orphan', household_id: 'household-missing', adult_user_id: 'adult-orphan' });
  await pool.query(`ALTER TABLE household_roles ADD CONSTRAINT household_roles_household_id_fkey
    FOREIGN KEY (household_id) REFERENCES households(id) NOT VALID`);
  const result = await validatePostgresSchema(pool);
  assert.equal(result.valid, false);
  assert.deepEqual(result.foreignKeyErrors.map(item => `${item.constraint}:${item.reason}`).sort(), [
    'household_roles_household_id_fkey:not_validated',
    'household_roles_household_id_fkey:orphaned_rows',
  ]);
  assert.equal(result.foreignKeyErrors.find(item => item.reason === 'orphaned_rows').count, 1);
});

test('validatePostgresSchema rejects a database whose collation is not C', postgresTestOptions(), async t => {
  let handle;
  try {
    handle = await useBlankDatabase(t, { locale: 'en_US.UTF-8' });
  } catch (error) {
    t.skip(`no en_US.UTF-8 locale on this server: ${error.code}`);
    return;
  }
  await runPostgresMigrations(handle.pool);
  const result = await validatePostgresSchema(handle.pool);
  assert.equal(result.collationValid, false);
  assert.equal(result.valid, false);
  assert.notEqual(result.collation, 'C');
});

test('validatePostgresSchema rejects ICU even when datcollate reports C', postgresTestOptions(), async t => {
  let handle;
  try {
    handle = await useBlankDatabase(t, { locale: 'C', localeProvider: 'icu', icuLocale: 'en-US' });
  } catch (error) {
    t.skip(`ICU database creation is unavailable on this server: ${error.code}`);
    return;
  }
  await runPostgresMigrations(handle.pool);
  const result = await validatePostgresSchema(handle.pool);
  assert.equal(result.collation, 'C');
  assert.equal(result.localeProvider, 'i');
  assert.equal(result.collationValid, false);
  assert.equal(result.valid, false);
});

test('the harness keeps one idle template per migration digest and drops its clones', postgresTestOptions(), async t => {
  const name = await ensureTemplate();
  assert.equal(name, `coversaath_tpl_${migrationSetDigest()}`);
  assert.match(name, /^coversaath_tpl_[0-9a-f]{12}$/);
  const [first, second] = await Promise.all([createTestDatabase(), createTestDatabase()]);
  t.after(async () => { await first.drop(); await second.drop(); });
  assert.notEqual(first.name, second.name);
  await first.pool.query("INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('h', 'x', 'a', 'b')");
  assert.equal((await one(second.pool, 'SELECT count(*)::int AS n FROM households')).n, 0, 'clones are isolated');
  assert.equal((await adminQuery('SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1', [name])).rows[0].n, 0,
    'the template has no open connections');
  assert.equal((await adminQuery('SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE $1', ['coversaath_tplb_%'])).rows[0].n, 0,
    'no half-built template remains');
  await first.drop();
  assert.equal((await adminQuery('SELECT count(*)::int AS n FROM pg_database WHERE datname = $1', [first.name])).rows[0].n, 0);
});

test('parallel clones of one template are all valid', postgresTestOptions(), async t => {
  const handles = await Promise.all(Array.from({ length: 6 }, () => createTestDatabase()));
  t.after(() => Promise.all(handles.map(handle => handle.drop())));
  for (const handle of handles) {
    assert.equal((await validatePostgresSchema(handle.pool)).valid, true);
  }
});
