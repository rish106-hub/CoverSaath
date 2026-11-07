// Checks that a database connection has the least privilege promised by scripts/sql/db-roles.sql (S1).
// Used by scripts/verify-db-roles.mjs (the owner, after cutover) and by tests/db-roles.test.mjs (local PostgreSQL).
// Every forbidden statement runs inside a transaction that is always rolled back with a short lock_timeout, so even a
// role that wrongly succeeds leaves nothing behind. Results carry check names and SQLSTATE codes only, never a
// connection string, password or driver message.
import { createPostgresPool } from '../../src/backend/database/postgres/index.js';

const RUNTIME_POLICY_NAME = 'coversaath_runtime_access';
const INSUFFICIENT_PRIVILEGE = '42501';
const AUTH_REJECTED = new Set(['28P01', '28000']);

// Statements a runtime role must be refused. `table` names exist in every CoverSaath schema.
export const forbiddenRuntimeStatements = Object.freeze([
  ['create_table', 'CREATE TABLE public.s1_probe_table (id integer)'],
  ['alter_table', 'ALTER TABLE public.schema_migrations ADD COLUMN s1_probe integer'],
  ['drop_table', 'DROP TABLE public.schema_migrations'],
  ['truncate_table', 'TRUNCATE public.schema_migrations'],
  ['create_temp_table', 'CREATE TEMP TABLE s1_probe_temp (id integer)'],
  ['create_schema', 'CREATE SCHEMA s1_probe_schema'],
  ['create_role', 'CREATE ROLE s1_probe_role'],
  ['write_schema_migrations', "INSERT INTO public.schema_migrations (version, checksum, applied_at) VALUES ('s1-probe', 'x', 'x')"],
  ['update_audit_events', 'UPDATE public.audit_events SET id = id WHERE false'],
  ['delete_audit_events', 'DELETE FROM public.audit_events WHERE false'],
  ['disable_trigger', 'ALTER TABLE public.audit_events DISABLE TRIGGER ALL'],
  ['disable_rls', 'ALTER TABLE public.audit_events DISABLE ROW LEVEL SECURITY'],
]);

async function refusedWith42501(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    try {
      await client.query(sql);
      return { refused: false, code: null };
    } catch (error) {
      return { refused: error?.code === INSUFFICIENT_PRIVILEGE, code: typeof error?.code === 'string' ? error.code : null };
    }
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

// Returns [{ check, ok, detail? }]. `pool` must be connected as the role under test.
export async function probeRuntimeRole(pool) {
  const results = [];
  const record = (check, ok, detail) => results.push(detail === undefined ? { check, ok } : { check, ok, detail });

  const attributes = (await pool.query(`
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolreplication,
      (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships
    FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
  record('role_not_superuser', attributes?.rolsuper === false);
  record('role_not_bypassrls', attributes?.rolbypassrls === false);
  record('role_cannot_create_db_or_role', attributes?.rolcreatedb === false && attributes?.rolcreaterole === false);
  record('role_not_replication', attributes?.rolreplication === false);
  record('role_has_no_memberships', attributes?.memberships === 0);

  const privileges = (await pool.query(`
    SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS schema_create,
      has_database_privilege(current_user, current_database(), 'CREATE') AS database_create,
      has_database_privilege(current_user, current_database(), 'TEMPORARY') AS database_temporary,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user))
        + (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)) AS owned_objects,
      (SELECT count(*)::int FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef) AS security_definer_functions,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND has_table_privilege(current_user, c.oid, 'TRUNCATE, REFERENCES, TRIGGER')) AS forbidden_table_privileges,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND c.relname NOT IN ('schema_migrations', 'audit_events')
        AND NOT has_table_privilege(current_user, c.oid, 'SELECT, INSERT, UPDATE, DELETE')) AS tables_missing_dml,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND c.relname <> 'schema_migrations'
        AND NOT has_table_privilege(current_user, c.oid, 'SELECT')) AS tables_missing_select,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_policy p
          WHERE p.polrelid = c.oid AND p.polname = $1 AND p.polcmd = '*' AND p.polpermissive
            AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = current_user)]::oid[]
        )) AS tables_without_runtime_policy`, [RUNTIME_POLICY_NAME])).rows[0];
  record('no_create_in_schema', privileges.schema_create === false);
  record('no_create_in_database', privileges.database_create === false);
  record('no_temporary_in_database', privileges.database_temporary === false);
  record('owns_nothing', privileges.owned_objects === 0);
  // A SECURITY DEFINER function runs with its owner's rights; none should exist in `public` unless reviewed.
  record('no_security_definer_functions', privileges.security_definer_functions === 0, { count: privileges.security_definer_functions });
  record('no_truncate_references_trigger', privileges.forbidden_table_privileges === 0);
  record('dml_on_application_tables', privileges.tables_missing_dml === 0, { missing: privileges.tables_missing_dml });
  record('select_on_all_tables', privileges.tables_missing_select === 0, { missing: privileges.tables_missing_select });
  record('policy_on_every_table', privileges.tables_without_runtime_policy === 0, { missing: privileges.tables_without_runtime_policy });

  for (const [name, sql] of forbiddenRuntimeStatements) {
    const outcome = await refusedWith42501(pool, sql);
    record(`refused_${name}`, outcome.refused, { code: outcome.code });
  }
  return results;
}

// True only when the server answered with an authentication failure. Any other failure (network, TLS, pooler
// message) is `inconclusive`: it proves nothing about the credential and needs a human look.
// `createPool` is injectable so a test can supply a stub.
export async function probeCredentialRejected(poolOptions, { createPool = createPostgresPool } = {}) {
  let pool;
  try {
    pool = createPool({ ...poolOptions, max: 1, connectionTimeoutMs: 10_000 });
    await pool.query('SELECT 1');
    return { result: 'accepted', code: null };
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : null;
    return { result: AUTH_REJECTED.has(code) ? 'rejected' : 'inconclusive', code };
  } finally {
    await pool?.end?.().catch(() => {});
  }
}

// Role checks for the migrator: it owns the application tables, cannot bypass RLS and is not a superuser.
export async function probeMigratorRole(pool) {
  const row = (await pool.query(`
    SELECT r.rolsuper, r.rolbypassrls, r.rolcreatedb, r.rolcreaterole, r.rolreplication,
      (SELECT count(*)::int FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
        AND c.relowner <> r.oid) AS tables_not_owned
    FROM pg_roles r WHERE r.rolname = current_user`)).rows[0];
  return [
    { check: 'migrator_not_superuser', ok: row?.rolsuper === false },
    { check: 'migrator_not_bypassrls', ok: row?.rolbypassrls === false },
    { check: 'migrator_cannot_create_db_or_role', ok: row?.rolcreatedb === false && row?.rolcreaterole === false && row?.rolreplication === false },
    { check: 'migrator_owns_all_tables', ok: row?.tables_not_owned === 0, detail: { notOwned: row?.tables_not_owned } },
  ];
}
