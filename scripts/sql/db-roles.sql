-- CoverSaath least-privilege database roles (S1, ADR 0011 D5). Idempotent: safe to run again, and it MUST be
-- run again after any migration that adds a table, view or sequence (see docs/runbooks/db-roles.md).
--
-- Run as the current owner/admin of the CoverSaath database (Supabase: the `postgres` user), connected to the
-- `coversaath` database, never to the default `postgres` database. One command, one transaction:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/db-roles.sql
-- It touches nothing outside this database except the two cluster-level roles it creates.
-- It takes short ACCESS EXCLUSIVE locks (ownership changes, ENABLE ROW LEVEL SECURITY, policies) and holds them until
-- the transaction ends. Run it in a maintenance window with the API drained. lock_timeout is set to 5 seconds, so a
-- busy table makes the run fail and roll back instead of stalling live traffic: retry in a quieter moment.
--
-- No password appears here and none may be added. A new role has no password and so cannot log in over
-- password authentication until the owner sets one (docs/runbooks/db-roles.md, step 3).
--
--   knowvia_migrator  Owns every table, view, sequence and function in `public`. DDL only through db:init and
--                     the other owner-only scripts. NOT superuser, NOBYPASSRLS (it is the owner, so RLS does not
--                     apply to it unless FORCEd).
--   knowvia_runtime   What the running API connects as. LOGIN, NOSUPERUSER, NOCREATEDB, NOCREATEROLE,
--                     NOREPLICATION, NOBYPASSRLS, no role memberships. DML only, no DDL, no TRUNCATE, no
--                     REFERENCES, no TRIGGER, no CREATE on the schema or the database. Because it is not the owner
--                     and cannot bypass RLS, each table carries one policy for this role only. The policy is
--                     permissive on purpose: the access boundary stays the backend (household ownership checks).
--                     `anon` and `authenticated` still have no policy and no grant, so the Data API stays denied.
--                     schema_migrations is read-only for it. audit_events is read and insert only: it can SELECT and
--                     INSERT but not UPDATE or DELETE (the append-only triggers already refuse those; this is the
--                     second layer). SELECT stays because AuditRepository reads the log back.
DO $roles$
DECLARE
  runtime_role  constant text := 'knowvia_runtime';
  migrator_role constant text := 'knowvia_migrator';
  policy_name   constant text := 'coversaath_runtime_access';
  target_schema constant text := 'public';
  this_database text := current_database();
  item record;
  api_role text;
BEGIN
  PERFORM set_config('client_min_messages', 'warning', true);
  PERFORM set_config('lock_timeout', '5s', true);
  IF this_database = 'postgres' THEN
    RAISE EXCEPTION 'Refusing to run in the default postgres database; connect to the coversaath database.';
  END IF;

  -- 1. Roles. Attributes are re-asserted on every run so a drifted role is corrected.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migrator_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN', migrator_role);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    EXECUTE format('CREATE ROLE %I LOGIN', runtime_role);
  END IF;
  -- Only the attributes a non-superuser admin may change are set here. SUPERUSER, REPLICATION and BYPASSRLS can be
  -- changed only by a superuser (Supabase `postgres` is not one), and a new role defaults to NOSUPERUSER,
  -- NOREPLICATION and NOBYPASSRLS. Step 7 fails the whole run if a pre-existing role drifted on any of them.
  EXECUTE format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE', migrator_role);
  EXECUTE format('ALTER ROLE %I LOGIN NOCREATEDB NOCREATEROLE', runtime_role);
  EXECUTE format('ALTER ROLE %I SET search_path TO %I', migrator_role, target_schema);
  EXECUTE format('ALTER ROLE %I SET search_path TO %I', runtime_role, target_schema);

  -- A non-superuser admin (Supabase) must be able to act as the migrator to hand ownership over, to set default
  -- privileges for it, and to keep administering the tables afterwards. A superuser needs nothing.
  IF NOT (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    IF current_setting('server_version_num')::int >= 160000 THEN
      EXECUTE format('GRANT %I TO %I WITH INHERIT TRUE, SET TRUE', migrator_role, current_user);
    ELSE
      EXECUTE format('GRANT %I TO %I', migrator_role, current_user);
    END IF;
  END IF;

  -- 2. Database and schema. The runtime cannot create schemas, temporary tables or any object in `public`.
  --    TEMPORARY is revoked from PUBLIC (it is granted there by default) and given back to the migrator only.
  --    This needs the admin to own the database, which it does for the database it created.
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', this_database, runtime_role, migrator_role);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', this_database);
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', this_database, runtime_role);
  EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', this_database, migrator_role);
  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', this_database, runtime_role);
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM PUBLIC', target_schema);
  EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', target_schema, runtime_role);
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', target_schema, migrator_role);
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', target_schema, runtime_role);

  -- An extension-owned table in `public` cannot be handed over or given a policy by this admin. Stop with a clear
  -- message instead of failing halfway; move the extension to another schema first (with a backup).
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e'
    WHERE c.relnamespace = target_schema::regnamespace AND c.relkind IN ('r', 'p')
  ) THEN
    RAISE EXCEPTION 'An extension owns a table in %. Move that extension to another schema before running this file.', target_schema;
  END IF;

  -- 3. Ownership: the migrator owns everything in `public`. Identity and serial sequences follow their
  --    table, and extension members are never touched.
  FOR item IN
    SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND c.relowner <> (SELECT oid FROM pg_roles WHERE rolname = migrator_role)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e')
      )
    ORDER BY CASE c.relkind WHEN 'S' THEN 3 WHEN 'v' THEN 2 ELSE 1 END, c.relname
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      target_schema, item.relname, migrator_role);
  END LOOP;
  FOR item IN
    SELECT p.oid::regprocedure::text AS signature
    FROM pg_proc p
    WHERE p.pronamespace = target_schema::regnamespace
      AND p.prokind IN ('f', 'p')
      AND p.proowner <> (SELECT oid FROM pg_roles WHERE rolname = migrator_role)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I',
      CASE WHEN EXISTS (SELECT 1 FROM pg_proc q WHERE q.oid = item.signature::regprocedure AND q.prokind = 'p') THEN 'PROCEDURE' ELSE 'FUNCTION' END,
      item.signature, migrator_role);
  END LOOP;

  -- 4. Runtime grants: rebuilt from nothing on every run so a stale or widened grant cannot survive.
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', target_schema, runtime_role);
  EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', target_schema, runtime_role);
  FOR item IN
    SELECT c.relname, c.relkind FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm')
  LOOP
    IF item.relkind IN ('v', 'm') THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO %I', target_schema, item.relname, runtime_role);
    ELSIF item.relname = 'schema_migrations' THEN
      EXECUTE format('GRANT SELECT ON %I.%I TO %I', target_schema, item.relname, runtime_role);
    ELSIF item.relname = 'audit_events' THEN
      EXECUTE format('GRANT SELECT, INSERT ON %I.%I TO %I', target_schema, item.relname, runtime_role);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.%I TO %I', target_schema, item.relname, runtime_role);
    END IF;
  END LOOP;
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', target_schema, runtime_role);

  -- 5. Future objects the migrator creates get the same grants (audit_events-style exceptions and the
  --    per-table policy below still need the re-run described in the header).
  --    Any wider default the runtime role already holds (global or per schema, for example TRUNCATE) is removed first.
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM %I', migrator_role, runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', migrator_role, target_schema, runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
    migrator_role, target_schema, runtime_role);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
    migrator_role, target_schema, runtime_role);
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', migrator_role, target_schema, api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', migrator_role, target_schema, api_role);
    END IF;
  END LOOP;

  -- 6. Row level security: every table stays RLS-enabled (migration 016) and gets one permissive policy for
  --    the runtime role only.
  FOR item IN
    SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target_schema, item.relname);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', policy_name, target_schema, item.relname);
    EXECUTE format('CREATE POLICY %I ON %I.%I AS PERMISSIVE FOR ALL TO %I USING (true) WITH CHECK (true)',
      policy_name, target_schema, item.relname, runtime_role);
  END LOOP;

  -- 7. Fail closed: if the result is not what this file promises, the whole transaction rolls back.
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN (runtime_role, migrator_role)
      AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication OR NOT rolcanlogin)
  ) THEN
    RAISE EXCEPTION 'A CoverSaath role has unexpected attributes.';
  END IF;
  IF has_database_privilege(runtime_role, this_database, 'TEMPORARY') THEN
    RAISE EXCEPTION 'The runtime role can still create temporary tables.';
  END IF;
  IF has_database_privilege(runtime_role, this_database, 'CREATE') THEN
    RAISE EXCEPTION 'The runtime role can still create schemas in this database.';
  END IF;
  IF has_schema_privilege(runtime_role, target_schema, 'CREATE') THEN
    RAISE EXCEPTION 'The runtime role can still create objects in %.', target_schema;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = runtime_role) THEN
    RAISE EXCEPTION 'The runtime role must not be a member of any role.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = migrator_role) THEN
    RAISE EXCEPTION 'The migrator role must not be a member of any role.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace AND c.relkind IN ('r', 'p')
      AND has_table_privilege(runtime_role, c.oid, 'TRUNCATE, REFERENCES, TRIGGER')
  ) THEN
    RAISE EXCEPTION 'The runtime role holds a forbidden table privilege.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace AND c.relkind IN ('r', 'p')
      AND ((c.relname = 'schema_migrations' AND has_table_privilege(runtime_role, c.oid, 'INSERT, UPDATE, DELETE'))
        OR (c.relname = 'audit_events' AND has_table_privilege(runtime_role, c.oid, 'UPDATE, DELETE')))
  ) THEN
    RAISE EXCEPTION 'The runtime role can write schema_migrations or change audit_events.';
  END IF;
END
$roles$;
