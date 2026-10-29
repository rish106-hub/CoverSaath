import {
  criticalIndexes, criticalTriggers, expectedTables, expectedViews, requiredColumns,
} from './schema-expectations.js';

const REQUIRED_COLLATION = 'C';
const SAFE_LOCALE_PROVIDERS = new Set(['b', 'c']);
const REQUIRED_FUNCTION_SEARCH_PATH = 'search_path=pg_catalog, public, pg_temp';
const POSTGRES_ONLY_CRITICAL_TRIGGERS = Object.freeze([
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
const requiredTriggers = Object.freeze([...criticalTriggers, ...POSTGRES_ONLY_CRITICAL_TRIGGERS]);

const quote = identifier => `"${String(identifier).replaceAll('"', '""')}"`;

async function names(pool, sql) {
  return new Set((await pool.query(sql)).rows.map(row => row.name));
}

const relationNames = (pool, kinds) => names(pool, `
  SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN (${kinds.map(kind => `'${kind}'`).join(', ')})`);

async function existingColumns(pool) {
  const rows = (await pool.query(`
    SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema()`)).rows;
  return new Set(rows.map(row => `${row.table_name}.${row.column_name}`));
}

async function foreignKeyDefinitions(pool) {
  return (await pool.query(`
    SELECT con.conname, con.convalidated, n.nspname AS schema_name, child.relname AS child, parent.relname AS parent,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum) AS child_columns,
      (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(con.confkey) WITH ORDINALITY AS k(attnum, ord)
        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum) AS parent_columns
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace n ON n.oid = child.relnamespace
    WHERE con.contype = 'f' AND n.nspname = current_schema()
    ORDER BY child.relname, con.conname`)).rows;
}

// A foreign key can hold orphans only when it was added NOT VALID or its triggers were bypassed
// (for example during a bulk import under session_replication_role = replica), so scan each one.
async function foreignKeyErrors(pool) {
  const errors = [];
  for (const fk of await foreignKeyDefinitions(pool)) {
    if (!fk.convalidated) errors.push({ table: fk.child, constraint: fk.conname, reason: 'not_validated' });
    const notNull = fk.child_columns.map(column => `c.${quote(column)} IS NOT NULL`).join(' AND ');
    const match = fk.child_columns.map((column, index) => `p.${quote(fk.parent_columns[index])} = c.${quote(column)}`).join(' AND ');
    const orphans = (await pool.query(`
      SELECT count(*)::int AS orphans FROM ${quote(fk.schema_name)}.${quote(fk.child)} c
      WHERE ${notNull} AND NOT EXISTS (SELECT 1 FROM ${quote(fk.schema_name)}.${quote(fk.parent)} p WHERE ${match})`)).rows[0].orphans;
    if (orphans > 0) errors.push({ table: fk.child, constraint: fk.conname, reason: 'orphaned_rows', count: orphans });
  }
  return errors;
}

// Same shape as the retired SQLite validateSchema (missing*, foreignKeyErrors, migrationCount, valid) plus the
// PostgreSQL checks: database collation must be C (ADR 0004, D4) and every critical trigger must be
// enabled (a disabled trigger would silently stop enforcing its invariant).
export async function validatePostgresSchema(pool) {
  const [tables, views, indexes, columns] = await Promise.all([
    relationNames(pool, ['r', 'p']),
    relationNames(pool, ['v']),
    names(pool, 'SELECT indexname AS name FROM pg_indexes WHERE schemaname = current_schema()'),
    existingColumns(pool),
  ]);
  const triggerRows = (await pool.query(`
    SELECT t.tgname AS name, t.tgenabled AS enabled FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT t.tgisinternal AND n.nspname = current_schema()`)).rows;
  const triggers = new Set(triggerRows.map(row => row.name));
  const disabledTriggers = triggerRows
    .filter(row => requiredTriggers.includes(row.name) && row.enabled !== 'O')
    .map(row => row.name);
  const missingTables = expectedTables.filter(name => !tables.has(name));
  const missingViews = expectedViews.filter(name => !views.has(name));
  const missingTriggers = requiredTriggers.filter(name => !triggers.has(name));
  const missingIndexes = criticalIndexes.filter(name => !indexes.has(name));
  const missingColumns = Object.entries(requiredColumns)
    .flatMap(([table, list]) => list.map(column => `${table}.${column}`))
    .filter(column => !columns.has(column));
  const databaseLocale = (await pool.query(`
    SELECT datcollate, datlocprovider::text AS locale_provider,
      ('B' COLLATE "default" < 'a' COLLATE "default") AS uppercase_before_lowercase
    FROM pg_database WHERE datname = current_database()`)).rows[0];
  const functionRows = (await pool.query(`
    SELECT p.oid::regprocedure::text AS name, p.proconfig AS settings
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = current_schema() AND p.prokind = 'f'
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
    ORDER BY p.oid::regprocedure::text`)).rows;
  const unsafeFunctionSearchPaths = functionRows
    .filter(row => !Array.isArray(row.settings) || !row.settings.includes(REQUIRED_FUNCTION_SEARCH_PATH))
    .map(row => row.name);
  // Supabase exposes the schema through its Data API: every table needs row level security (deny by
  // default) and the API roles `anon` and `authenticated` must hold no privilege on it (migration 016).
  const tablesWithoutRls = (await pool.query(`
    SELECT c.relname AS name FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
    ORDER BY c.relname`)).rows.map(row => row.name);
  const apiRoleGrants = (await pool.query(`
    SELECT DISTINCT c.relname || ' -> ' || r.rolname AS name
    FROM pg_class c
    JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated')
    WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind IN ('r', 'p', 'v')
      AND (has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
        OR has_table_privilege(r.oid, c.oid, 'DELETE, TRUNCATE, TRIGGER'))
    ORDER BY 1`)).rows.map(row => row.name);
  const collation = databaseLocale.datcollate;
  const localeProvider = databaseLocale.locale_provider;
  const orderingValid = databaseLocale.uppercase_before_lowercase === true;
  const migrationCount = tables.has('schema_migrations')
    ? (await pool.query('SELECT count(*)::int AS count FROM schema_migrations')).rows[0].count
    : 0;
  const foreignKeyProblems = missingTables.length === 0 ? await foreignKeyErrors(pool) : [];
  const collationValid = collation === REQUIRED_COLLATION && SAFE_LOCALE_PROVIDERS.has(localeProvider) && orderingValid;
  const valid = [
    missingTables, missingViews, missingTriggers, missingIndexes, missingColumns, disabledTriggers, foreignKeyProblems,
    unsafeFunctionSearchPaths, tablesWithoutRls, apiRoleGrants,
  ]
    .every(items => items.length === 0) && collationValid;
  return {
    valid,
    missingTables,
    missingViews,
    missingTriggers,
    missingIndexes,
    missingColumns,
    disabledTriggers,
    foreignKeyErrors: foreignKeyProblems,
    collation,
    localeProvider,
    orderingValid,
    collationValid,
    unsafeFunctionSearchPaths,
    tablesWithoutRls,
    apiRoleGrants,
    migrationCount,
  };
}
