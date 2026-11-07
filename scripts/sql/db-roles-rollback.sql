-- Reverses scripts/sql/db-roles.sql inside the current database. Run as the same admin (Supabase: `postgres`)
-- that ran db-roles.sql, with the application pointed back at an admin URL FIRST so nothing is connected as the
-- runtime role:
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/db-roles-rollback.sql
-- Ownership returns to the current user, the runtime policies and grants are removed, and the default
-- privileges are reset. The two roles are left in place (they own nothing afterwards); drop them with the
-- commented lines only once nothing connects as them.
-- Like db-roles.sql it takes ACCESS EXCLUSIVE locks until the transaction ends (policy drops and ownership changes
-- touch every table): run it with the API drained. lock_timeout is 5 seconds, so a busy table makes it roll back.
-- TEMPORARY stays revoked from PUBLIC: migration 003 revokes it, so that is the database's own state, not something
-- db-roles.sql introduced. CREATE on schema public is not restored: PostgreSQL 15 and later (the supported 17) does
-- not grant it to PUBLIC by default.
DO $rollback$
DECLARE
  runtime_role  constant text := 'knowvia_runtime';
  migrator_role constant text := 'knowvia_migrator';
  policy_name   constant text := 'coversaath_runtime_access';
  target_schema constant text := 'public';
  item record;
BEGIN
  PERFORM set_config('client_min_messages', 'warning', true);
  PERFORM set_config('lock_timeout', '5s', true);
  IF current_database() = 'postgres' THEN
    RAISE EXCEPTION 'Refusing to run in the default postgres database; connect to the coversaath database.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = migrator_role) THEN
    RETURN;
  END IF;

  FOR item IN
    SELECT c.relname FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', policy_name, target_schema, item.relname);
  END LOOP;

  FOR item IN
    SELECT c.oid, c.relname, c.relkind
    FROM pg_class c
    WHERE c.relnamespace = target_schema::regnamespace
      AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
      AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = migrator_role)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype IN ('a', 'i', 'e')
      )
    ORDER BY CASE c.relkind WHEN 'S' THEN 3 WHEN 'v' THEN 2 ELSE 1 END, c.relname
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO %I',
      CASE item.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,
      target_schema, item.relname, current_user);
  END LOOP;
  FOR item IN
    SELECT p.oid::regprocedure::text AS signature, p.prokind
    FROM pg_proc p
    WHERE p.pronamespace = target_schema::regnamespace
      AND p.prokind IN ('f', 'p')
      AND p.proowner = (SELECT oid FROM pg_roles WHERE rolname = migrator_role)
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend d
        WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e'
      )
  LOOP
    EXECUTE format('ALTER %s %s OWNER TO %I', CASE item.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END, item.signature, current_user);
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', target_schema, runtime_role);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', target_schema, runtime_role);
    EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', target_schema, runtime_role);
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), runtime_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', migrator_role, target_schema, runtime_role);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', migrator_role, target_schema, runtime_role);
  END IF;
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', target_schema, migrator_role);
  -- TEMPORARY stays revoked from PUBLIC (migration 003); only the migrator's own grants are removed.
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM %I', current_database(), migrator_role);
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), migrator_role);
END
$rollback$;

-- Only after nothing connects as these roles (run in each database that granted them anything first):
-- DROP OWNED BY knowvia_runtime;
-- DROP OWNED BY knowvia_migrator;
-- DROP ROLE knowvia_runtime;
-- DROP ROLE knowvia_migrator;
