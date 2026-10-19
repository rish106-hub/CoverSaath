# Database rules

Applies to `src/backend/database/`. Root and `src/backend/AGENTS.md` still apply.

- Add the next `NNN_snake_case.sql` migration in the affected engine directory. Never edit, rename or reorder a merged migration.
- Expand-only by default. Contracting changes need an exec plan, compatibility window and forward-fix or restore path.
- Protect invariants with constraints, foreign keys, triggers and transactions. Add a behaviour test that fails when the guard is removed.
- PostgreSQL functions that read project relations must schema-qualify them or fix `search_path` to `pg_catalog, public, pg_temp`.
- Runtime roles must not own schema objects or have `TRUNCATE`, database `TEMPORARY`, migration or role-management privileges.
- Keep queries bounded and parameterised. Store timestamps in UTC and money in integer minor units with currency.
- Validate migration checksums, required objects, disabled guards, collation assumptions and foreign-key integrity.
- PostgreSQL transition decisions live in ADR 0004 and the active Section 3 exec plan.
