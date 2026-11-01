import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';
import { validatePostgresSchema } from '../src/backend/database/postgres/index.js';

// E1d (ADR 0013): row level security covers EVERY table in the public schema, and the Supabase Data API roles
// hold no privilege on any of them. A later migration that adds a table and forgets ENABLE ROW LEVEL SECURITY
// (or leaves a default grant to anon / authenticated) fails here, loudly, naming the table.

const tablesWithoutRls = pool => pool.query(`
  SELECT c.relname AS name FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity
  ORDER BY c.relname`).then(result => result.rows.map(row => row.name));

const apiRoleGrants = pool => pool.query(`
  SELECT DISTINCT c.relname || ' -> ' || r.rolname AS name
  FROM pg_class c
  JOIN pg_roles r ON r.rolname IN ('anon', 'authenticated')
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'S')
    AND (has_table_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR (c.relkind <> 'S' AND has_any_column_privilege(r.oid, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')))
  ORDER BY 1`).then(result => result.rows.map(row => row.name));

test('every table in the public schema has row level security enabled', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const tables = (await pool.query(`SELECT count(*)::int AS count FROM pg_class
    WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')`)).rows[0].count;
  assert.ok(tables >= 50, 'the schema should hold the full table set');
  assert.deepEqual(await tablesWithoutRls(pool), [], 'a table is missing ENABLE ROW LEVEL SECURITY');
});

test('the Data API roles anon and authenticated hold no privilege on any table, view or sequence', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  assert.deepEqual(await apiRoleGrants(pool), []);
  const roles = (await pool.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated')")).rows;
  if (roles.length === 0) t.diagnostic('anon and authenticated do not exist on this server; the grant check is vacuous here');
});

test('the schema validator reports no table without RLS and no API role grant', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const report = await validatePostgresSchema(pool);
  assert.deepEqual(report.tablesWithoutRls, []);
  assert.deepEqual(report.apiRoleGrants, []);
});

test('the check is not vacuous: a table created without RLS, or granted to an API role, is reported', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  await pool.query('CREATE TABLE public.e1_rls_probe (id text PRIMARY KEY)');
  assert.deepEqual(await tablesWithoutRls(pool), ['e1_rls_probe']);
  await pool.query('ALTER TABLE public.e1_rls_probe ENABLE ROW LEVEL SECURITY');
  assert.deepEqual(await tablesWithoutRls(pool), []);
  const hasApiRole = (await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'anon'")).rowCount > 0;
  if (hasApiRole) {
    await pool.query('GRANT SELECT ON public.e1_rls_probe TO anon');
    assert.deepEqual(await apiRoleGrants(pool), ['e1_rls_probe -> anon']);
  }
});

test('E1 tables exist with RLS on and no policy (deny by default)', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  for (const table of ['profile_answers', 'document_blobs', 'device_permissions', 'household_places', 'adult_preferences', 'onboarding_progress', 'tool_scenarios']) {
    const row = (await pool.query(`SELECT relrowsecurity FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relname = $1`, [table])).rows[0];
    assert.ok(row, `${table} must exist`);
    assert.equal(row.relrowsecurity, true, `${table} must have RLS enabled`);
    const policies = (await pool.query("SELECT count(*)::int AS count FROM pg_policies WHERE schemaname = 'public' AND tablename = $1", [table])).rows[0].count;
    assert.equal(policies, 0, `${table} must have no policy (isolation is enforced in application code)`);
  }
});
