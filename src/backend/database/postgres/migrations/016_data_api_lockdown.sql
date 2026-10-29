-- Keep the Supabase Data API (PostgREST) away from the backend schema. The backend connects with a
-- direct PostgreSQL role and never uses the Data API, so `anon` and `authenticated` get no access.
-- Two layers: row level security enabled with no policy (deny by default) and every privilege
-- revoked. The table owner and roles with BYPASSRLS (the migrator, the backend connection) are
-- unaffected. `anon` and `authenticated` exist only on Supabase, hence the existence guard; on a
-- plain PostgreSQL server only the RLS part applies. Expand-only and safe to run more than once.
--
-- Each later migration that adds a table must also run ALTER TABLE ... ENABLE ROW LEVEL SECURITY;
-- validatePostgresSchema reports tablesWithoutRls and apiRoleGrants so a miss shows up in db:init
-- and GET /api/v1/ready.
DO $$
DECLARE
  item record;
  api_role text;
BEGIN
  FOR item IN
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = current_schema()::regnamespace
      AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', current_schema(), item.relname);
  END LOOP;

  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', current_schema(), api_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', current_schema(), api_role);
      -- Supabase grants these roles full access to every new object by default; stop that for
      -- objects the current role creates from now on.
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', current_schema(), api_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM %I', current_schema(), api_role);
    END IF;
  END LOOP;
END;
$$;
