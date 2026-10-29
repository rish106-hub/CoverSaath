import test from 'node:test';
import assert from 'node:assert/strict';
import {
  criticalIndexes, criticalTriggers, expectedTables, expectedViews,
} from '../src/backend/database/postgres/schema-expectations.js';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';

const ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const POSTGRES_ONLY_TRIGGERS = new Set([
  'audit_events_no_truncate',
  'coverage_parameter_observation_rules_no_truncate',
  'coverage_parameter_observations_no_truncate',
  'coverage_parameter_registry_pins_no_truncate',
  'coverage_parameter_registry_versions_no_truncate',
  'evidence_facts_no_truncate',
  'policy_structuring_jobs_no_truncate',
  'policy_structuring_runs_no_truncate',
  'proposed_parameters_no_truncate',
]);

async function postgresCatalog(pool) {
  const q = async (sql) => (await pool.query(sql)).rows;
  const catalog = { tables: {}, views: {}, triggers: {}, indexes: {} };
  const columns = await q(`SELECT c.relname AS table_name, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type,
      a.attnotnull AS not_null FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`);
  for (const row of columns) {
    catalog.tables[row.table_name] ??= { columns: [], primary: [], foreignKeys: [], unique: [], checks: 0 };
    catalog.tables[row.table_name].columns.push({ name: row.name, type: row.type, notNull: row.not_null });
  }
  const attributeNames = `(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(%KEY%) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = %REL% AND a.attnum = k.attnum)`;
  const constraints = await q(`SELECT con.contype, child.relname AS child, parent.relname AS parent, con.confupdtype, con.confdeltype,
      ${attributeNames.replace('%KEY%', 'con.conkey').replace('%REL%', 'con.conrelid')} AS cols,
      ${attributeNames.replace('%KEY%', 'COALESCE(con.confkey, ARRAY[]::int2[])').replace('%REL%', 'con.confrelid')} AS parent_cols
    FROM pg_constraint con JOIN pg_class child ON child.oid = con.conrelid LEFT JOIN pg_class parent ON parent.oid = con.confrelid
    WHERE child.relnamespace = current_schema()::regnamespace ORDER BY con.conname`);
  for (const row of constraints) {
    const table = catalog.tables[row.child];
    if (row.contype === 'p') table.primary = row.cols;
    if (row.contype === 'f') {
      table.foreignKeys.push({
        columns: row.cols, parent: row.parent, parentColumns: row.parent_cols,
        onUpdate: ACTIONS[row.confupdtype], onDelete: ACTIONS[row.confdeltype],
      });
    }
    if (row.contype === 'c') table.checks += 1;
  }
  const indexes = await q(`SELECT i.relname AS name, t.relname AS table_name, x.indisunique AS is_unique, x.indpred IS NOT NULL AS partial,
      pg_get_indexdef(x.indexrelid) AS def, x.indoption, x.indkey::int2[] AS key,
      EXISTS (SELECT 1 FROM pg_constraint con WHERE con.conindid = x.indexrelid) AS backs_constraint,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(x.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.attnum WHERE k.ord <= x.indnkeyatts) AS cols
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
    WHERE t.relnamespace = current_schema()::regnamespace ORDER BY i.relname`);
  for (const row of indexes) {
    const options = row.indoption.split ? row.indoption.split(' ') : row.indoption;
    const columns = row.cols.map((name, index) => `${name}${(Number(options[index]) & 1) === 1 ? ' DESC' : ''}`);
    if (row.backs_constraint) {
      const uniqueConstraint = (await pool.query(
        "SELECT contype FROM pg_constraint WHERE conindid = $1::regclass AND contype IN ('u', 'p') LIMIT 1", [row.name],
      )).rows[0];
      if (uniqueConstraint?.contype === 'u') catalog.tables[row.table_name].unique.push({ columns, partial: row.partial });
    } else {
      catalog.indexes[row.name] = { table: row.table_name, columns, unique: row.is_unique, partial: row.partial };
    }
  }
  for (const row of await q(`SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS cols FROM pg_class c
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 WHERE c.relkind = 'v' AND c.relnamespace = current_schema()::regnamespace
      GROUP BY c.relname`)) catalog.views[row.name] = row.cols;
  const triggers = await q(`SELECT t.tgname AS name, c.relname AS table_name, t.tgtype::int AS type,
      (SELECT COALESCE(array_agg(a.attname::text ORDER BY k.ord), ARRAY[]::text[]) FROM unnest(t.tgattr::int2[]) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.attnum) AS update_of
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relnamespace = current_schema()::regnamespace ORDER BY t.tgname`);
  for (const row of triggers) {
    if (POSTGRES_ONLY_TRIGGERS.has(row.name)) continue;
    const events = [row.type & 4 ? 'INSERT' : null, row.type & 8 ? 'DELETE' : null, row.type & 16 ? 'UPDATE' : null].filter(Boolean);
    assert.equal(events.length, 1, `${row.name} must have exactly one event`);
    assert.ok(row.type & 1, `${row.name} must be a row trigger`);
    catalog.triggers[row.name] = {
      table: row.table_name, timing: row.type & 2 ? 'BEFORE' : 'AFTER', event: events[0], updateOf: row.update_of,
    };
  }
  return catalog;
}

// The SQLite schema this catalog was proven equal to is gone with its migration files (S3.3). The
// counts below freeze the PostgreSQL catalog: a migration that adds or drops an object changes them
// and must update this test in the same change. Named objects come from schema-expectations.js.
test('PostgreSQL catalog holds every expected object and the frozen object counts', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const actual = await postgresCatalog(pool);

  for (const name of expectedTables) assert.ok(actual.tables[name], `expected table ${name}`);
  for (const name of expectedViews) assert.ok(actual.views[name], `expected view ${name}`);
  for (const name of criticalTriggers) assert.ok(actual.triggers[name], `critical trigger ${name}`);
  for (const name of criticalIndexes) assert.ok(actual.indexes[name], `critical index ${name}`);

  const total = pick => Object.values(actual.tables).reduce((sum, table) => sum + pick(table), 0);
  assert.deepEqual({
    tables: Object.keys(actual.tables).length,
    columns: total(table => table.columns.length),
    foreignKeys: total(table => table.foreignKeys.length),
    uniqueConstraints: total(table => table.unique.length),
    checkConstraints: total(table => table.checks),
    namedIndexes: Object.keys(actual.indexes).length,
    views: Object.keys(actual.views).length,
    triggers: Object.keys(actual.triggers).length,
  }, {
    tables: 53, columns: 548, foreignKeys: 122, uniqueConstraints: 20, checkConstraints: 201, namedIndexes: 67, views: 2, triggers: 103,
  });
});

test('seed rows are the reviewed registry and observation rules', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const rules = 'SELECT extraction_method, resolution_state, transition_authority, requires_accepted FROM coverage_parameter_observation_rules ORDER BY 1, 2';
  assert.deepEqual(
    (await pool.query(rules)).rows.map(row => [row.extraction_method, row.resolution_state, row.transition_authority, Number(row.requires_accepted)]),
    [
      ['deterministic_calculation', 'calculated', 'deterministic', 0],
      ['deterministic_calculation', 'dynamic', 'deterministic', 0],
      ['document_extraction', 'extracted_unverified', 'model', 0],
      ['human_report', 'reported', 'deterministic', 0],
      ['human_review', 'proven', 'human_reviewer', 1],
      ['human_review', 'reported', 'human_reviewer', 0],
      ['official_source_lookup', 'dynamic', 'official_source', 0],
      ['official_source_lookup', 'proven', 'official_source', 1],
    ],
  );
  const versions = 'SELECT version FROM coverage_parameter_registry_versions ORDER BY version';
  assert.deepEqual((await pool.query(versions)).rows, [{ version: 'policy-parameters/v1' }]);
  const registered = (await pool.query('SELECT registered_at FROM coverage_parameter_registry_versions')).rows[0].registered_at;
  assert.match(registered, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('the PostgreSQL migrations record exactly the immutable migration files', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const versions = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version);
  assert.deepEqual(versions, ['001_baseline_schema.sql', '002_baseline_triggers.sql', '003_harden_invariants.sql', '004_document_intake_scheduling.sql', '005_evidence_fact_redaction.sql', '006_evidence_fact_redaction_hardening.sql', '007_policy_structuring.sql', '008_julianday_hour_24.sql', '009_source_page_blocks.sql', '010_policy_structuring_jobs.sql', '011_source_page_blocks_upgrade.sql', '012_policy_evidence.sql', '013_catalogue_reviews.sql', '014_curated_product_workflow.sql', '015_curated_signed_actions.sql', '016_data_api_lockdown.sql']);
});
