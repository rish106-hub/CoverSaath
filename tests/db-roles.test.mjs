import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { adminQuery, postgresTestOptions, testDatabaseUrl, scratchMigrationDirectory, useBlankDatabase, useTestDatabase } from './support/postgres.mjs';
import { ask, household, startApp } from './support/household-api-harness.mjs';
import {
  createPostgresPool, migrationPoolOptionsFromEnv, postgresPoolOptionsFromEnv, runPostgresMigrations, validatePostgresSchema,
} from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { forbiddenRuntimeStatements, probeCredentialRejected, probeMigratorRole, probeRuntimeRole } from '../scripts/lib/db-role-probe.mjs';

// S1 (ADR 0011 D5): least-privilege database roles. These tests run scripts/sql/db-roles.sql against throwaway local
// databases under per-test role names (roles are cluster-wide, so the real names knowvia_runtime and
// knowvia_migrator are never created here). Nothing here touches a remote database.

const opts = postgresTestOptions();
const SQL = readFileSync(new URL('../scripts/sql/db-roles.sql', import.meta.url), 'utf8');
const ROLLBACK_SQL = readFileSync(new URL('../scripts/sql/db-roles-rollback.sql', import.meta.url), 'utf8');

function roleNames() {
  const id = randomBytes(4).toString('hex');
  return { runtime: `s1rt_${id}`, migrator: `s1mg_${id}` };
}
const ROLE_NAME = /^s1(rt|mg)_[0-9a-f]{8}$/;
// The role scripts are committed files, never user input; the only substitution is the two per-test role names, and
// those are checked against a fixed shape before they reach SQL. No value is concatenated into a statement here.
function renamed(sql, names) {
  assert.match(names.runtime, ROLE_NAME);
  assert.match(names.migrator, ROLE_NAME);
  return sql.replaceAll('knowvia_runtime', names.runtime).replaceAll('knowvia_migrator', names.migrator);
}
// The script travels as a bound parameter (set_config), and a constant DO block executes it, so no statement text is
// built from file contents. One transaction, as with `psql -1`, so a failed check rolls the whole script back.
async function applyRoleScript(db, script, names) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('coversaath.test_script', $1, true)", [renamed(script, names)]);
    await client.query("DO $run$ BEGIN EXECUTE current_setting('coversaath.test_script'); END $run$");
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
const failures = results => results.filter(item => !item.ok);

// Applies the role SQL to `handle`, sets throwaway passwords and opens one pool per role.
// pgvector (migration 053) is installed once by an admin before a least-privilege migrator runs the migrations, as on Supabase, where
// the `extensions` schema ships and the postgres role may create the extension. The role SQL then grants both roles USAGE on it.
async function installVector(pool) {
  await pool.query('CREATE SCHEMA IF NOT EXISTS extensions');
  await pool.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
}

async function withRoles(t, handle, names = roleNames()) {
  await installVector(handle.pool);
  await applyRoleScript(handle.pool, SQL, names);
  const pools = {};
  for (const [kind, role] of [['runtime', names.runtime], ['migrator', names.migrator]]) {
    const password = randomBytes(12).toString('hex');
    await handle.pool.query(`ALTER ROLE "${role}" PASSWORD '${password}'`);
    const url = new URL(handle.url);
    url.username = role;
    url.password = password;
    pools[kind] = createPostgresPool({ connectionString: url.toString(), max: 4, applicationName: 'coversaath-test-roles' });
  }
  t.after(async () => {
    await Promise.all(Object.values(pools).map(pool => pool.end().catch(() => {})));
    await handle.drop();
    for (const role of [names.runtime, names.migrator]) await adminQuery(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  });
  return { ...pools, names };
}

test('migrationPoolOptionsFromEnv prefers MIGRATION_DATABASE_URL and the API path never reads it', () => {
  const api = 'postgres://api_user@localhost:5432/coversaath';
  const migrator = 'postgres://migrator_user@localhost:5432/coversaath';
  assert.equal(migrationPoolOptionsFromEnv({ DATABASE_URL: api, MIGRATION_DATABASE_URL: migrator }).connectionString, migrator);
  assert.equal(migrationPoolOptionsFromEnv({ DATABASE_URL: api }).connectionString, api);
  assert.equal(migrationPoolOptionsFromEnv({ DATABASE_URL: api, MIGRATION_DATABASE_URL: '  ' }).connectionString, api);
  assert.equal(postgresPoolOptionsFromEnv({ DATABASE_URL: api, MIGRATION_DATABASE_URL: migrator }).connectionString, api);
  assert.throws(() => migrationPoolOptionsFromEnv({}), { code: 'DATABASE_URL_REQUIRED' });
  assert.equal(migrationPoolOptionsFromEnv({ MIGRATION_DATABASE_URL: migrator }).connectionString, migrator);
  // An invalid migrator URL is reported under its own name, and never echoes the value.
  assert.throws(() => migrationPoolOptionsFromEnv({ DATABASE_URL: api, MIGRATION_DATABASE_URL: 'mysql://u:secret-token@h/db' }), error => {
    assert.equal(error.code, 'DATABASE_URL_INVALID');
    assert.match(error.message, /^MIGRATION_DATABASE_URL /);
    assert.ok(!error.message.includes('secret-token'));
    return true;
  });
});

test('probeCredentialRejected: only an authentication failure proves a credential is dead', async () => {
  const stub = behaviour => () => ({ query: async () => behaviour(), end: async () => {} });
  assert.deepEqual(await probeCredentialRejected({}, { createPool: stub(() => { throw Object.assign(new Error('x'), { code: '28P01' }); }) }), { result: 'rejected', code: '28P01' });
  assert.deepEqual(await probeCredentialRejected({}, { createPool: stub(() => { throw Object.assign(new Error('x'), { code: '28000' }); }) }), { result: 'inconclusive', code: '28000' }, 'a pg_hba refusal is not proof');
  assert.deepEqual(await probeCredentialRejected({}, { createPool: stub(() => ({ rows: [] })) }), { result: 'accepted', code: null });
  assert.deepEqual(await probeCredentialRejected({}, { createPool: stub(() => { throw Object.assign(new Error('x'), { code: 'ECONNREFUSED' }); }) }), { result: 'inconclusive', code: 'ECONNREFUSED' });
  assert.deepEqual(await probeCredentialRejected({}, { createPool: stub(() => { throw new Error('no code'); }) }), { result: 'inconclusive', code: null });
});

test('the role SQL contains no password, secret or connection string', () => {
  for (const sql of [SQL, ROLLBACK_SQL]) {
    assert.doesNotMatch(sql, /password\s+['"]/i);
    assert.doesNotMatch(sql, /postgres(ql)?:\/\//i);
    assert.doesNotMatch(sql, /\beyJ[A-Za-z0-9_-]{10,}/);
  }
});

test('the runtime role created by the SQL cannot ALTER, CREATE or DROP, has no BYPASSRLS and holds DML only', opts, async t => {
  const roles = await withRoles(t, await useTestDatabase(t));
  const runtime = await probeRuntimeRole(roles.runtime);
  assert.deepEqual(failures(runtime), []);
  assert.ok(runtime.length >= 20, 'the probe should not be vacuous');
  assert.ok(forbiddenRuntimeStatements.some(([name]) => name === 'create_temp_table'));
  await assert.rejects(roles.runtime.query('CREATE TEMP TABLE s1_temp (id integer)'), { code: '42501' });
  assert.deepEqual(failures(await probeMigratorRole(roles.migrator)), []);

  // The probe itself must be able to fail: a probe against a superuser connection reports problems.
  const admin = (await useTestDatabase(t));
  const adminResults = await probeRuntimeRole(admin.pool);
  assert.ok(failures(adminResults).length > 5, 'a superuser must fail the least-privilege probe');

  // No escalation path.
  await assert.rejects(roles.runtime.query(`SET ROLE "${roles.names.migrator}"`), { code: '42501' });
  await assert.rejects(roles.runtime.query('SELECT rolpassword FROM pg_authid'), { code: '42501' });
  await assert.rejects(roles.runtime.query('ALTER TABLE public.households OWNER TO CURRENT_USER'), { code: '42501' });
});

test('applying the role SQL twice changes nothing', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, handle, names);
  const snapshot = async () => (await handle.pool.query(`
    SELECT c.relname, c.relkind, pg_get_userbyid(c.relowner) AS owner, c.relacl::text AS acl, c.relrowsecurity,
      (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'S') ORDER BY c.relname`)).rows;
  const first = await snapshot();
  await applyRoleScript(handle.pool, SQL, names);
  assert.deepEqual(await snapshot(), first);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)), []);
  const owners = new Set(first.filter(row => row.relkind !== 'S' || !row.relname.endsWith('_seq')).map(row => row.owner));
  assert.deepEqual([...owners], [names.migrator]);
});

test('the migrator builds the whole schema from an empty database, and a second db:init run is a no-op', opts, async t => {
  const blank = await useBlankDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, blank, names);
  assert.deepEqual(await runPostgresMigrations(roles.migrator).then(applied => applied.length > 25), true, 'every migration applies without superuser');
  assert.deepEqual(await runPostgresMigrations(roles.migrator), []);
  const report = await validatePostgresSchema(roles.migrator);
  assert.equal(report.valid, true, JSON.stringify({ ...report, collation: undefined }));
  // Run the grants again now that the tables exist.
  await applyRoleScript(blank.pool, SQL, names);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)), []);
  assert.deepEqual(failures(await probeMigratorRole(roles.migrator)), []);
  // The API's /ready check runs the same validator as the runtime role.
  assert.equal((await validatePostgresSchema(roles.runtime)).valid, true);
});

test('a table added by a later migration needs the SQL re-run before the runtime can use it', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, handle, names);
  const directory = scratchMigrationDirectory(t, {
    '999_s1_probe.sql': 'CREATE TABLE s1_probe_items (id text PRIMARY KEY, note text);\nALTER TABLE s1_probe_items ENABLE ROW LEVEL SECURITY;\n',
  });
  assert.deepEqual(await runPostgresMigrations(roles.migrator, { directory }), ['999_s1_probe.sql']);
  // Default privileges already grant DML, but with no policy yet the row level security denies the runtime role.
  await assert.rejects(roles.runtime.query("INSERT INTO s1_probe_items (id, note) VALUES ('a', 'b')"), { code: '42501' });
  const flagged = await probeRuntimeRole(roles.runtime);
  assert.deepEqual(failures(flagged).map(item => item.check), ['policy_on_every_table'], 'the probe reports the missing policy');
  await applyRoleScript(handle.pool, SQL, names);
  await roles.runtime.query("INSERT INTO s1_probe_items (id, note) VALUES ('a', 'b')");
  assert.equal((await roles.runtime.query('SELECT count(*)::int AS n FROM s1_probe_items')).rows[0].n, 1);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)), []);
  // The runtime role still cannot alter what the migrator made.
  await assert.rejects(roles.runtime.query('ALTER TABLE s1_probe_items ADD COLUMN extra text'), { code: '42501' });
});

test('the rollback SQL returns ownership and removes every runtime grant and policy', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const before = (await handle.pool.query(`SELECT current_user AS who, (SELECT count(*)::int FROM pg_policy) AS policies`)).rows[0];
  const roles = await withRoles(t, handle, names);
  await applyRoleScript(handle.pool, ROLLBACK_SQL, names);
  const after = (await handle.pool.query(`
    SELECT count(*) FILTER (WHERE pg_get_userbyid(c.relowner) <> current_user)::int AS not_owned_by_admin,
      count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE'))::int AS runtime_grants,
      (SELECT count(*)::int FROM pg_policy) AS policies,
      count(*) FILTER (WHERE c.relkind IN ('r', 'p') AND NOT c.relrowsecurity)::int AS tables_without_rls
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v') `, [names.runtime])).rows[0];
  assert.deepEqual(after, { not_owned_by_admin: 0, runtime_grants: 0, policies: before.policies, tables_without_rls: 0 });
  // Migration 003 revokes TEMPORARY from PUBLIC, so the rollback must not grant it back: the runtime role (which still
  // exists) gets no temporary-table right through PUBLIC, and the migrator keeps no grant of its own.
  const temporary = (await handle.pool.query(
    `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS runtime, d.datacl::text AS acl FROM pg_database d WHERE d.datname = current_database()`,
    [names.runtime])).rows[0];
  assert.equal(temporary.runtime, false);
  assert.ok(!temporary.acl?.includes(names.migrator), 'no leftover grant to the migrator');
  assert.ok(!/(^|[{,])=[a-zA-Z]*T/.test(temporary.acl ?? ''), 'TEMPORARY is not granted back to PUBLIC');
  await assert.rejects(roles.runtime.query('SELECT 1 FROM public.households'), { code: '42501' });
  // And the whole thing can be applied again after a rollback.
  await applyRoleScript(handle.pool, SQL, names);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)), []);
});

test('the API journey (household, case, consent, upload, OCR, question, revocation) works as the runtime role', opts, async t => {
  const handle = await useTestDatabase(t);
  const roles = await withRoles(t, handle);
  const runtimeDb = createDatabase(roles.runtime);
  const database = Object.freeze({
    ...runtimeDb,
    prepare: sql => ({
      get: (...params) => runtimeDb.one(sql, params),
      all: (...params) => runtimeDb.many(sql, params),
      run: (...params) => runtimeDb.run(sql, params),
    }),
  });
  const app = await startApp(t, { database });
  const s = await household(app, { name: 'Roles', documents: 1 });
  const answer = await ask(app, s);
  assert.ok([200, 201].includes(answer.status), `question returned ${answer.status}`);
  const revoked = await app.call(`/api/v1/consents/${s.questionGrantId}/revoke`, { method: 'POST', token: s.token, body: { householdId: s.householdId, reason: 'roles test' } });
  assert.ok([200, 201].includes(revoked.status), `revocation returned ${revoked.status}: ${JSON.stringify(revoked.data)}`);
  const ready = await app.call('/api/v1/ready');
  assert.equal(ready.status, 200, JSON.stringify(ready.data));
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)), []);
});

test('a SECURITY DEFINER function in public is flagged, and a function owned by the runtime role fails owns_nothing', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, handle, names);
  const directory = scratchMigrationDirectory(t, {
    '999_s1_definer.sql': 'CREATE FUNCTION public.s1_probe_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS $$ SELECT 1 $$;\n',
  });
  assert.deepEqual(await runPostgresMigrations(roles.migrator, { directory }), ['999_s1_definer.sql']);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)).map(item => item.check), ['no_security_definer_functions']);
  // The runtime role cannot make its own function (no CREATE on the schema), so ownership is shown with a grant. Only a
  // superuser can hand an object to a role that lacks CREATE on the schema; a non-superuser admin (the Supabase shape)
  // cannot, so that part is skipped there and the rest of the test still runs.
  const isSuperuser = (await handle.pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0].rolsuper;
  if (isSuperuser) {
    await handle.pool.query(`ALTER FUNCTION public.s1_probe_definer() OWNER TO "${names.runtime}"`);
    const checks = failures(await probeRuntimeRole(roles.runtime)).map(item => item.check);
    assert.ok(checks.includes('owns_nothing'), 'a function owned by the runtime role is reported');
    // Re-running the SQL hands the function back to the migrator.
    await applyRoleScript(handle.pool, SQL, names);
  }
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)).map(item => item.check), ['no_security_definer_functions']);
});

test('the policy check requires the runtime policy itself, not just any policy', opts, async t => {
  const handle = await useTestDatabase(t);
  const roles = await withRoles(t, handle);
  await handle.pool.query(`DROP POLICY coversaath_runtime_access ON public.households`);
  await handle.pool.query(`CREATE POLICY some_other_policy ON public.households FOR SELECT USING (true)`);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)).map(item => item.check), ['policy_on_every_table']);
});

const checkNames = results => failures(results).map(item => item.check);

test('the probe checks each privilege, RLS state and policy expressions, and reads read-only tables from the catalogue', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, handle, names);
  const rt = `"${names.runtime}"`;
  const restore = () => applyRoleScript(handle.pool, SQL, names);

  // One missing write privilege is not hidden by SELECT (a privilege list passes on any single match).
  await handle.pool.query(`REVOKE UPDATE ON public.households FROM ${rt}`);
  assert.deepEqual(checkNames(await probeRuntimeRole(roles.runtime)), ['dml_on_application_tables']);
  await restore();

  // A disabled RLS keeps the policy but ignores it.
  await handle.pool.query('ALTER TABLE public.households DISABLE ROW LEVEL SECURITY');
  assert.deepEqual(checkNames(await probeRuntimeRole(roles.runtime)), ['policy_on_every_table']);
  await restore();

  // A policy of the right name that no longer grants anything.
  await handle.pool.query('DROP POLICY coversaath_runtime_access ON public.households');
  await handle.pool.query(`CREATE POLICY coversaath_runtime_access ON public.households AS PERMISSIVE FOR ALL TO ${rt} USING (false) WITH CHECK (false)`);
  assert.deepEqual(checkNames(await probeRuntimeRole(roles.runtime)), ['policy_on_every_table']);
  await restore();

  // schema_migrations stays read-only and audit_events stays insert and read only, whatever an RLS refusal looks like.
  await handle.pool.query(`GRANT UPDATE ON public.schema_migrations TO ${rt}`);
  assert.ok(checkNames(await probeRuntimeRole(roles.runtime)).includes('schema_migrations_read_only'));
  await restore();
  await handle.pool.query(`GRANT DELETE ON public.audit_events TO ${rt}`);
  assert.ok(checkNames(await probeRuntimeRole(roles.runtime)).includes('audit_events_insert_not_update_delete'));
  await restore();
  assert.deepEqual(checkNames(await probeRuntimeRole(roles.runtime)), []);
});

test('the migrator probe fails on memberships, a lost schema CREATE and objects it does not own', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, handle, names);
  assert.deepEqual(checkNames(await probeMigratorRole(roles.migrator)), []);

  await handle.pool.query(`GRANT pg_read_all_data TO "${names.migrator}"`);
  assert.deepEqual(checkNames(await probeMigratorRole(roles.migrator)), ['migrator_has_no_memberships']);
  // The setup SQL refuses to finish while the migrator holds a membership.
  await assert.rejects(applyRoleScript(handle.pool, SQL, names), /migrator role must not be a member/);
  await handle.pool.query(`REVOKE pg_read_all_data FROM "${names.migrator}"`);

  await handle.pool.query(`REVOKE CREATE ON SCHEMA public FROM "${names.migrator}"`);
  assert.deepEqual(checkNames(await probeMigratorRole(roles.migrator)), ['migrator_can_create_in_schema']);
  await applyRoleScript(handle.pool, SQL, names);

  // A view (and a function) the migrator does not own are caught, not only tables.
  await handle.pool.query('CREATE VIEW public.s1_probe_view AS SELECT 1 AS one');
  assert.deepEqual(checkNames(await probeMigratorRole(roles.migrator)), ['migrator_owns_all_objects']);
  await handle.pool.query('DROP VIEW public.s1_probe_view');
  await handle.pool.query('CREATE FUNCTION public.s1_probe_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$');
  assert.deepEqual(checkNames(await probeMigratorRole(roles.migrator)), ['migrator_owns_all_objects']);
  await applyRoleScript(handle.pool, SQL, names);
  assert.deepEqual(checkNames(await probeMigratorRole(roles.migrator)), []);
});

test('widened default privileges are removed, and database CREATE through PUBLIC aborts the SQL', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  const roles = await withRoles(t, handle, names);
  for (const scope of ['', 'IN SCHEMA public ']) {
    await handle.pool.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "${names.migrator}" ${scope}GRANT ALL ON TABLES TO "${names.runtime}"`);
  }
  await applyRoleScript(handle.pool, SQL, names);
  const directory = scratchMigrationDirectory(t, { '999_s1_defaults.sql': 'CREATE TABLE s1_probe_defaults (id text PRIMARY KEY);\n' });
  assert.deepEqual(await runPostgresMigrations(roles.migrator, { directory }), ['999_s1_defaults.sql']);
  const granted = (await handle.pool.query(
    `SELECT has_table_privilege($1, 'public.s1_probe_defaults', 'TRUNCATE') AS truncate, has_table_privilege($1, 'public.s1_probe_defaults', 'REFERENCES') AS refs,
       has_table_privilege($1, 'public.s1_probe_defaults', 'TRIGGER') AS trig, has_table_privilege($1, 'public.s1_probe_defaults', 'DELETE') AS del`,
    [names.runtime])).rows[0];
  assert.deepEqual(granted, { truncate: false, refs: false, trig: false, del: true });

  // A database that grants CREATE to PUBLIC would leave the runtime role able to create schemas: the SQL aborts.
  const database = (await handle.pool.query('SELECT current_database() AS name')).rows[0].name;
  await handle.pool.query(`GRANT CREATE ON DATABASE "${database}" TO PUBLIC`);
  await assert.rejects(applyRoleScript(handle.pool, SQL, names), /still create schemas/);
  await handle.pool.query(`REVOKE CREATE ON DATABASE "${database}" FROM PUBLIC`);
  await applyRoleScript(handle.pool, SQL, names);
});

test('the SQL takes bounded locks: a busy table makes it fail instead of stalling', opts, async t => {
  const handle = await useTestDatabase(t);
  const names = roleNames();
  await withRoles(t, handle, names);
  const blocker = await handle.pool.connect();
  try {
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE public.households IN ACCESS SHARE MODE');
    // ENABLE ROW LEVEL SECURITY needs ACCESS EXCLUSIVE, which waits for the open reader and then gives up.
    const started = Date.now();
    await assert.rejects(applyRoleScript(handle.pool, SQL, names), { code: '55P03' });
    assert.ok(Date.now() - started < 15_000, 'gave up within the lock timeout, not after an unbounded wait');
  } finally {
    await blocker.query('ROLLBACK').catch(() => {});
    blocker.release();
  }
});

test('the SQL and its rollback run as a non-superuser admin (the Supabase postgres shape)', opts, async t => {
  const id = randomBytes(4).toString('hex');
  const admin = { role: `s1adm_${id}`, database: `s1_admin_db_${id}`, password: randomBytes(12).toString('hex') };
  const names = roleNames();
  await adminQuery(`CREATE ROLE "${admin.role}" LOGIN NOSUPERUSER CREATEDB CREATEROLE REPLICATION BYPASSRLS PASSWORD '${admin.password}'`);
  await adminQuery(`CREATE DATABASE "${admin.database}" OWNER "${admin.role}" TEMPLATE template0 ENCODING 'UTF8' LOCALE 'C'`);
  const url = new URL(testDatabaseUrl());
  url.username = admin.role;
  url.password = admin.password;
  url.pathname = `/${admin.database}`;
  const pool = createPostgresPool({ connectionString: url.toString(), max: 2, applicationName: 'coversaath-test-admin-role' });
  const runtimePassword = randomBytes(12).toString('hex');
  let runtime;
  t.after(async () => {
    await runtime?.end().catch(() => {});
    await pool.end().catch(() => {});
    await adminQuery(`DROP DATABASE IF EXISTS "${admin.database}" WITH (FORCE)`).catch(() => {});
    for (const role of [names.runtime, names.migrator, admin.role]) await adminQuery(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
  });
  const attributes = (await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')).rows[0];
  assert.equal(attributes.rolsuper, false, 'the admin under test is not a superuser');
  // The extension is installed by a superuser (the stock extension is not trusted); the admin may use it, as the Supabase postgres user may.
  const installer = createPostgresPool({ connectionString: (() => { const target = new URL(testDatabaseUrl()); target.pathname = `/${admin.database}`; return target.toString(); })(), max: 1, applicationName: 'coversaath-test-extension' });
  try {
    await installVector(installer);
    await installer.query(`GRANT USAGE ON SCHEMA extensions TO "${admin.role}"`);
  } finally { await installer.end(); }
  // The admin builds the schema and owns it, as the Supabase postgres user does today.
  assert.ok((await runPostgresMigrations(pool)).length > 25);

  await applyRoleScript(pool, SQL, names);
  await applyRoleScript(pool, SQL, names); // idempotent for a non-superuser too
  await pool.query(`ALTER ROLE "${names.runtime}" PASSWORD '${runtimePassword}'`);
  const runtimeUrl = new URL(url.toString());
  runtimeUrl.username = names.runtime;
  runtimeUrl.password = runtimePassword;
  runtime = createPostgresPool({ connectionString: runtimeUrl.toString(), max: 2, applicationName: 'coversaath-test-roles' });
  assert.deepEqual(failures(await probeRuntimeRole(runtime)), []);
  const owners = (await pool.query(`SELECT DISTINCT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')`)).rows;
  assert.deepEqual(owners.map(row => row.owner), [names.migrator]);
  // The admin keeps working through the membership the SQL grants it.
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM public.households')).rows[0].n, 0);

  // A pre-existing role that drifted on an attribute the admin cannot change fails the run closed.
  await adminQuery(`ALTER ROLE "${names.runtime}" REPLICATION`);
  await assert.rejects(applyRoleScript(pool, SQL, names), /unexpected attributes/);
  await adminQuery(`ALTER ROLE "${names.runtime}" NOREPLICATION`);
  await applyRoleScript(pool, SQL, names);

  await runtime.end();
  runtime = undefined;
  await applyRoleScript(pool, ROLLBACK_SQL, names);
  const after = (await pool.query(`
    SELECT count(*) FILTER (WHERE pg_get_userbyid(relowner) <> current_user)::int AS not_owned_by_admin,
      (SELECT count(*)::int FROM pg_policy WHERE polname = 'coversaath_runtime_access') AS runtime_policies
    FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v')`)).rows[0];
  assert.deepEqual(after, { not_owned_by_admin: 0, runtime_policies: 0 });
});
