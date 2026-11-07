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
const renamed = (sql, names) => sql.replaceAll('knowvia_runtime', names.runtime).replaceAll('knowvia_migrator', names.migrator);
const failures = results => results.filter(item => !item.ok);

// Applies the role SQL to `handle`, sets throwaway passwords and opens one pool per role.
async function withRoles(t, handle, names = roleNames()) {
  await handle.pool.query(renamed(SQL, names));
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
});

test('probeCredentialRejected: only an authentication failure proves a credential is dead', async () => {
  const stub = behaviour => () => ({ query: async () => behaviour(), end: async () => {} });
  assert.deepEqual(await probeCredentialRejected({}, { createPool: stub(() => { throw Object.assign(new Error('x'), { code: '28P01' }); }) }), { result: 'rejected', code: '28P01' });
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
  await handle.pool.query(renamed(SQL, names));
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
  await blank.pool.query(renamed(SQL, names));
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
  await handle.pool.query(renamed(SQL, names));
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
  await handle.pool.query(renamed(ROLLBACK_SQL, names));
  const after = (await handle.pool.query(`
    SELECT count(*) FILTER (WHERE pg_get_userbyid(c.relowner) <> current_user)::int AS not_owned_by_admin,
      count(*) FILTER (WHERE has_table_privilege($1, c.oid, 'SELECT, INSERT, UPDATE, DELETE'))::int AS runtime_grants,
      (SELECT count(*)::int FROM pg_policy) AS policies,
      count(*) FILTER (WHERE c.relkind IN ('r', 'p') AND NOT c.relrowsecurity)::int AS tables_without_rls
    FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v') `, [names.runtime])).rows[0];
  assert.deepEqual(after, { not_owned_by_admin: 0, runtime_grants: 0, policies: before.policies, tables_without_rls: 0 });
  // The database default is back: TEMPORARY belongs to PUBLIC again and the migrator keeps no grant of its own.
  const temporary = (await handle.pool.query(
    `SELECT has_database_privilege($1, current_database(), 'TEMPORARY') AS runtime, d.datacl::text AS acl FROM pg_database d WHERE d.datname = current_database()`,
    [names.runtime])).rows[0];
  assert.equal(temporary.runtime, true);
  assert.ok(!temporary.acl?.includes(names.migrator), 'no leftover grant to the migrator');
  await assert.rejects(roles.runtime.query('SELECT 1 FROM public.households'), { code: '42501' });
  // And the whole thing can be applied again after a rollback.
  await handle.pool.query(renamed(SQL, names));
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
  // The runtime role cannot make its own function (no CREATE on the schema), so ownership is shown with a grant.
  await handle.pool.query(`ALTER FUNCTION public.s1_probe_definer() OWNER TO "${names.runtime}"`);
  const checks = failures(await probeRuntimeRole(roles.runtime)).map(item => item.check);
  assert.ok(checks.includes('owns_nothing'), 'a function owned by the runtime role is reported');
  // Re-running the SQL hands the function back to the migrator.
  await handle.pool.query(renamed(SQL, names));
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)).map(item => item.check), ['no_security_definer_functions']);
});

test('the policy check requires the runtime policy itself, not just any policy', opts, async t => {
  const handle = await useTestDatabase(t);
  const roles = await withRoles(t, handle);
  await handle.pool.query(`DROP POLICY coversaath_runtime_access ON public.households`);
  await handle.pool.query(`CREATE POLICY some_other_policy ON public.households FOR SELECT USING (true)`);
  assert.deepEqual(failures(await probeRuntimeRole(roles.runtime)).map(item => item.check), ['policy_on_every_table']);
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
  // The admin builds the schema and owns it, as the Supabase postgres user does today.
  assert.ok((await runPostgresMigrations(pool)).length > 25);

  await pool.query(renamed(SQL, names));
  await pool.query(renamed(SQL, names)); // idempotent for a non-superuser too
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
  await assert.rejects(pool.query(renamed(SQL, names)), /unexpected attributes/);
  await adminQuery(`ALTER ROLE "${names.runtime}" NOREPLICATION`);
  await pool.query(renamed(SQL, names));

  await runtime.end();
  runtime = undefined;
  await pool.query(renamed(ROLLBACK_SQL, names));
  const after = (await pool.query(`
    SELECT count(*) FILTER (WHERE pg_get_userbyid(relowner) <> current_user)::int AS not_owned_by_admin,
      (SELECT count(*)::int FROM pg_policy WHERE polname = 'coversaath_runtime_access') AS runtime_policies
    FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v')`)).rows[0];
  assert.deepEqual(after, { not_owned_by_admin: 0, runtime_policies: 0 });
});
