import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { criticalIndexes, criticalTriggers, expectedTables, expectedViews } from '../src/backend/database/database.js';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';

const TYPE_MAP = { TEXT: 'text', INTEGER: 'bigint' };
const ACTIONS = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
const POSTGRES_ONLY_TRIGGERS = new Set([
  'audit_events_no_truncate',
  'coverage_parameter_observation_rules_no_truncate',
  'coverage_parameter_observations_no_truncate',
  'coverage_parameter_registry_pins_no_truncate',
  'coverage_parameter_registry_versions_no_truncate',
  'evidence_facts_no_truncate',
]);

function sqliteCatalog(database) {
  const objects = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
  const tables = objects.filter(item => item.type === 'table').map(item => item.name).sort();
  const catalog = { tables: {}, views: {}, triggers: {}, indexes: {} };
  for (const table of tables) {
    const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all();
    const fks = new Map();
    for (const row of database.prepare(`PRAGMA foreign_key_list(${table})`).all()) {
      if (!fks.has(row.id)) fks.set(row.id, { parent: row.table, columns: [], parentColumns: [], onUpdate: row.on_update, onDelete: row.on_delete });
      const fk = fks.get(row.id);
      fk.columns[row.seq] = row.from;
      fk.parentColumns[row.seq] = row.to;
    }
    const indexList = database.prepare(`PRAGMA index_list(${table})`).all();
    const indexColumns = name => database.prepare(`PRAGMA index_xinfo(${name})`).all()
      .filter(column => column.key === 1).map(column => `${column.name}${column.desc ? ' DESC' : ''}`);
    const unique = indexList.filter(index => index.unique === 1 && index.origin === 'u')
      .map(index => ({ columns: indexColumns(index.name), partial: index.partial === 1 }));
    const primary = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name);
    catalog.tables[table] = {
      columns: columns.map(column => ({
        name: column.name,
        type: TYPE_MAP[column.type] ?? column.type,
        notNull: column.notnull === 1 || column.pk > 0,
      })),
      primary,
      foreignKeys: [...fks.values()].map(fk => ({
        columns: fk.columns, parent: fk.parent, parentColumns: fk.parentColumns, onUpdate: fk.onUpdate, onDelete: fk.onDelete,
      })),
      unique,
      checks: (objects.find(item => item.name === table).sql.match(/\bCHECK\s*\(/g) ?? []).length,
    };
    for (const index of indexList.filter(item => item.origin === 'c')) {
      catalog.indexes[index.name] = { table, columns: indexColumns(index.name), unique: index.unique === 1, partial: index.partial === 1 };
    }
  }
  for (const view of objects.filter(item => item.type === 'view')) {
    catalog.views[view.name] = database.prepare(`PRAGMA table_info(${view.name})`).all().map(column => column.name);
  }
  for (const trigger of objects.filter(item => item.type === 'trigger')) {
    const match = /CREATE TRIGGER\s+\w+\s+(BEFORE|AFTER)\s+(INSERT|DELETE|UPDATE)(?:\s+OF\s+([\w,\s]+?))?\s+ON\s+(\w+)/i.exec(trigger.sql);
    assert.ok(match, `unparsed SQLite trigger ${trigger.name}`);
    catalog.triggers[trigger.name] = {
      table: match[4],
      timing: match[1].toUpperCase(),
      event: match[2].toUpperCase(),
      updateOf: match[3] ? match[3].split(',').map(name => name.trim()) : [],
    };
  }
  return catalog;
}

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

const sortKey = value => JSON.stringify(value);
const sortedList = list => [...list].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1));

test('PostgreSQL catalog equals the final SQLite catalog (tables, columns, keys, indexes, views, triggers)', postgresTestOptions(), async t => {
  const sqlite = openDatabase({ path: ':memory:' });
  t.after(() => sqlite.close());
  const { pool } = await useTestDatabase(t);
  const expected = sqliteCatalog(sqlite);
  const actual = await postgresCatalog(pool);
  // schema_migrations is created by each runner; both sides have it.
  assert.deepEqual(Object.keys(actual.tables).sort(), Object.keys(expected.tables).sort(), 'table names');
  for (const [name, table] of Object.entries(expected.tables)) {
    const pgTable = actual.tables[name];
    assert.deepEqual(pgTable.columns, table.columns, `${name}: columns (name, type, not null, order)`);
    assert.deepEqual(pgTable.primary, table.primary, `${name}: primary key`);
    assert.deepEqual(sortedList(pgTable.foreignKeys), sortedList(table.foreignKeys), `${name}: foreign keys and actions`);
    assert.deepEqual(sortedList(pgTable.unique), sortedList(table.unique), `${name}: unique constraints`);
    assert.equal(pgTable.checks, table.checks, `${name}: CHECK constraint count`);
  }
  assert.deepEqual(actual.indexes, expected.indexes, 'named indexes (columns, order, unique, partial)');
  assert.deepEqual(actual.views, expected.views, 'views and their columns');
  assert.deepEqual(actual.triggers, expected.triggers, 'trigger names, tables, timing, events, UPDATE OF columns');

  for (const name of expectedTables) assert.ok(actual.tables[name], `expected table ${name}`);
  for (const name of expectedViews) assert.ok(actual.views[name], `expected view ${name}`);
  for (const name of criticalTriggers) assert.ok(actual.triggers[name], `critical trigger ${name}`);
  for (const name of criticalIndexes) assert.ok(actual.indexes[name], `critical index ${name}`);

  const count = items => Object.values(items).reduce((sum, item) => sum + item.length, 0);
  const counts = {
    tables: Object.keys(actual.tables).length,
    columns: count(Object.fromEntries(Object.entries(actual.tables).map(([name, table]) => [name, table.columns]))),
    foreignKeys: count(Object.fromEntries(Object.entries(actual.tables).map(([name, table]) => [name, table.foreignKeys]))),
    uniqueConstraints: count(Object.fromEntries(Object.entries(actual.tables).map(([name, table]) => [name, table.unique]))),
    checkConstraints: Object.values(actual.tables).reduce((sum, table) => sum + table.checks, 0),
    namedIndexes: Object.keys(actual.indexes).length,
    views: Object.keys(actual.views).length,
    triggers: Object.keys(actual.triggers).length,
  };
  console.log(`catalog parity: ${JSON.stringify(counts)}`);
  assert.deepEqual(counts, {
    tables: Object.keys(expected.tables).length,
    columns: counts.columns,
    foreignKeys: Object.values(expected.tables).reduce((sum, table) => sum + table.foreignKeys.length, 0),
    uniqueConstraints: Object.values(expected.tables).reduce((sum, table) => sum + table.unique.length, 0),
    checkConstraints: Object.values(expected.tables).reduce((sum, table) => sum + table.checks, 0),
    namedIndexes: Object.keys(expected.indexes).length,
    views: Object.keys(expected.views).length,
    triggers: Object.keys(expected.triggers).length,
  });
});

test('seed rows equal the SQLite seed rows', postgresTestOptions(), async t => {
  const sqlite = openDatabase({ path: ':memory:' });
  t.after(() => sqlite.close());
  const { pool } = await useTestDatabase(t);
  const rules = 'SELECT extraction_method, resolution_state, transition_authority, requires_accepted FROM coverage_parameter_observation_rules ORDER BY 1, 2';
  assert.deepEqual(
    (await pool.query(rules)).rows.map(row => ({ ...row, requires_accepted: Number(row.requires_accepted) })),
    sqlite.prepare(rules).all().map(row => ({ ...row })),
  );
  const versions = 'SELECT version FROM coverage_parameter_registry_versions ORDER BY version';
  assert.deepEqual((await pool.query(versions)).rows, sqlite.prepare(versions).all().map(row => ({ ...row })));
  const registered = (await pool.query('SELECT registered_at FROM coverage_parameter_registry_versions')).rows[0].registered_at;
  assert.match(registered, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('the PostgreSQL migrations record exactly the immutable migration files', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const versions = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map(row => row.version);
  assert.deepEqual(versions, ['001_baseline_schema.sql', '002_baseline_triggers.sql', '003_harden_invariants.sql', '004_document_intake_scheduling.sql']);
});
