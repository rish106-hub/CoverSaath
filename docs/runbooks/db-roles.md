# Runbook: least-privilege database roles (S1)

Decision: [ADR 0011](../adr/0011-supabase-master-database.md) D5 and D10. Status: prepared and tested on local PostgreSQL 17 only. **Nothing here has been applied to Supabase.** Synthetic data only. Wording about residency and access is a draft for legal review.

## How the app connects today (from code, config and docs only)

- The API and every script read one variable, `DATABASE_URL` (`src/backend/database/postgres/pool.js`). The Fly secret of the same name is the Supabase session-pooler URL for the Supabase `postgres` user (ADR 0011 D3, D5). That user created the schema, so it **owns every table** and, on Supabase, has `BYPASSRLS`. ADR 0011 D10 says so: "The connection role owns the tables and bypasses RLS."
- So the running API holds the same power as the migrator: it can `ALTER`, `DROP`, `TRUNCATE` and disable triggers. `db:init` is the only code that needs DDL; the API needs only DML.
- The pool sets session timeouts and TLS itself and strips URL overrides. The password is in `DATABASE_URL` only; it was pasted into chat twice (ADR 0011 D9, `fly-deploy.md`) and must be treated as exposed.
- Row level security is on for every table with no policy, which only blocks `anon` and `authenticated` (Supabase Data API). The owner and `BYPASSRLS` roles ignore it.

## Target

| Role | Used by | Can do | Cannot do |
|---|---|---|---|
| `knowvia_runtime` | the running API (Fly `DATABASE_URL`) | SELECT, INSERT, UPDATE, DELETE on application tables; `schema_migrations` read-only; `audit_events` insert-only; USAGE on sequences | CREATE, ALTER, DROP, TRUNCATE, REFERENCES, TRIGGER, create schemas or roles, `SET ROLE`, read `pg_authid`, bypass RLS |
| `knowvia_migrator` | `npm run db:init`, `scripts/postgres-migrate.mjs`, owner-only scripts | owns every object in `public`, runs DDL | superuser, create databases or roles, bypass RLS (it is the owner, so RLS does not apply to it) |
| Supabase `postgres` | the owner, by hand, in the dashboard or `psql` | runs `db-roles.sql` and the rollback | nothing changes for this account except that the app stops using it |

Both roles are `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`. Because the runtime role is neither owner nor `BYPASSRLS`, `db-roles.sql` adds one permissive policy per table, `coversaath_runtime_access`, for that role only. This does not widen access (the role already had full DML as owner); household isolation is still enforced by the backend. `anon` and `authenticated` still have no policy and no grant.

Files:

- `scripts/sql/db-roles.sql` creates and tightens the roles. Idempotent. No password in it, ever.
- `scripts/sql/db-roles-rollback.sql` returns ownership to the running admin and removes the runtime grants and policies. Roles are left in place.
- `scripts/verify-db-roles.mjs` (library `scripts/lib/db-role-probe.mjs`) proves the result from the outside, and proves that the old password is dead.
- `tests/db-roles.test.mjs` runs all of it on a local PostgreSQL 17 under throwaway role names.

## Environment split

| Variable | Holder | Meaning |
|---|---|---|
| `DATABASE_URL` | Fly secret, `.env.local` | `knowvia_runtime` URL. The only database variable the API reads. |
| `MIGRATION_DATABASE_URL` | owner's shell or `.env.local` only; **never a Fly secret** | `knowvia_migrator` URL. Read by `npm run db:init` and `scripts/postgres-migrate.mjs` (`migrationPoolOptionsFromEnv`); falls back to `DATABASE_URL` when unset, so local development is unchanged. |
| `DATABASE_SSL_CA_PATH` | both | unchanged (ADR 0011 D4) |

Owner-only scripts that disable triggers or alter rows as the table owner (`scripts/encrypt-existing-rows.mjs`, `scripts/backfill-adult-contacts.mjs`) still read `DATABASE_URL`: run them with `DATABASE_URL="$MIGRATION_DATABASE_URL"` for that one command. Operator scripts that only read or write rows (`scripts/curated-source.mjs`) work with the runtime URL.

Pooler user names on Supabase take the form `<role>.<project_ref>` (the existing `postgres.<project_ref>` pattern). **Unverified for custom roles**; the verify step below proves it.

## Adding a table later

A migration run as the migrator creates tables owned by the migrator. Default privileges give the runtime role DML on them, but with row level security on and no policy the runtime sees nothing (this is tested). After any migration that adds a table, view or sequence, and before deploying code that uses it:

1. `npm run db:init` with `MIGRATION_DATABASE_URL` set.
2. Re-run `db-roles.sql` as the admin (same command as step 3 below).
3. Run `scripts/verify-db-roles.mjs`; it reports `policy_on_every_table` if step 2 was missed.

Tables that must not be fully writable by the API (append-only or read-only) need their own line in `db-roles.sql`, as `audit_events` and `schema_migrations` have.

## Owner checklist (cutover)

Do these in order. Keep passwords out of chat, shell history and files in the repo: use a password manager and the prompts below. The agent that prepared this never touched Supabase or Fly.

0. **Before you start.** `fly status -a knowvia-api` (ADR 0011 says no machine runs; if one does, expect a short outage at step 7). Check which other things use the `postgres` password: the website repos (`Knowvia_website*`) and their Vercel environment variables for the `knowvia_web` schema (names only: look for a database URL variable), local `.env.local`, any CI secret. They break at step 1 and are out of this repo's reach. Take a dump of the `coversaath` database as a rollback point (synthetic data): `pg_dump "$ADMIN_DATABASE_URL" -Fc -f <path outside the repo>`.
1. **Rotate.** Supabase dashboard, Project Settings, Database, reset the database password. Use a long random value; if it contains URL-special characters, percent-encode it in URLs. The exposed password stops working here. Put the new admin URL in a local shell variable only (`ADMIN_DATABASE_URL`, pooler session mode, database `coversaath`).
2. **Update the other holders** of the old URL found in step 0, or accept they are down until you do.
3. **Create the roles** (admin URL, `coversaath` database, never `postgres`):
   `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/db-roles.sql`
   It runs in one transaction and rolls back by itself if a role ends up with the wrong attributes.
4. **Set passwords** with the psql prompt, not SQL text: `psql "$ADMIN_DATABASE_URL"` then `\password knowvia_runtime` and `\password knowvia_migrator`. Do not use the SQL editor for this (it keeps query history).
5. **Build the two URLs** (`RUNTIME_DATABASE_URL`, `MIGRATION_DATABASE_URL`) in your shell, with `DATABASE_SSL_CA_PATH` pointing at the Supabase CA.
6. **Verify**, with the exposed old URL as `OLD_DATABASE_URL` for this one command only (do not save it):
   `node scripts/verify-db-roles.mjs`
   Expect `"passed": true`, every runtime check `ok`, and `old_credential_rejected` with `"result": "rejected"` (code `28P01`). `inconclusive` means the failure was not an authentication failure (network, TLS, pooler wording): look at the code and retry. `accepted` means the old password still works; stop and rotate again.
7. **Cut over.** `fly secrets set DATABASE_URL=<runtime url> -a knowvia-api` (type it from your shell, not into chat). Do not set `MIGRATION_DATABASE_URL` on Fly. Update `.env.local` the same way. Deploy only when you decide to (this change does not deploy anything).
8. **Smoke.** `GET /api/v1/health` and `GET /api/v1/ready` (the ready check runs the schema validator as the runtime role) and one household create with the bootstrap token.
9. **Run migrations** from now on as `MIGRATION_DATABASE_URL=... npm run db:init`, then the re-run described above.

## Rollback

- **Fast (seconds):** set `DATABASE_URL` back to the admin URL with the rotated password. The admin keeps working: it is made a member of `knowvia_migrator` with inherit, and on Supabase it also has `BYPASSRLS`. Nothing else needs undoing.
- **Full:** point `DATABASE_URL` at the admin first, then `psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f scripts/sql/db-roles-rollback.sql`. Ownership returns to the admin, the policies and runtime grants go. Drop the roles with the commented lines at the end of that file once nothing connects as them.
- The old password cannot be restored and should not be: rotation is not reversible by design. Restore data from the dump in step 0 if something was damaged.

## Evidence and what is not proven

Proven on local PostgreSQL 17 (`tests/db-roles.test.mjs`, and a throwaway password-authenticated cluster that was deleted afterwards):

- A role created by the SQL cannot CREATE/ALTER/DROP/TRUNCATE tables, create schemas or roles, write `schema_migrations`, update or delete `audit_events`, disable triggers or RLS, `SET ROLE`, or read `pg_authid`; it has no `BYPASSRLS` and no memberships; it holds DML only.
- The migrator builds the whole schema from an empty database (every migration, non-superuser), a second `db:init` applies nothing, and the schema validator passes as both roles.
- The API journey (household, case, consents, upload, OCR, question, revocation, `/ready`) runs as the runtime role.
- The SQL is idempotent, and the rollback restores ownership and removes grants and policies.
- After a password change the old password is refused (`28P01`) and the new one works; `scripts/verify-db-roles.mjs` reports both, and fails when given a still-valid credential as "old".

Not proven, needs the owner's run:

- Supabase specifics: that the `postgres` user can `ALTER ... OWNER` and `ALTER DEFAULT PRIVILEGES FOR ROLE knowvia_migrator` (it needs the membership the SQL grants itself; Supabase's `postgres` is not a superuser), the `<role>.<project_ref>` pooler user form, and Supavisor session-mode behaviour for new roles.
- The full test suite and every route under the runtime role. Only the journey above ran as it. A route that needs a privilege the SQL withholds would fail with SQLSTATE `42501`; watch the Fly logs after step 7.
- Other databases and roles in the cluster:
  - `CONNECT` on other databases (`postgres`, `template1`) is inherited from `PUBLIC`, so `knowvia_runtime` can open a session there. It has no table grants in them, but check them if you add data to any. Revoking `CONNECT` from `PUBLIC` elsewhere is a separate, reviewed change.
  - Supabase's `service_role`, `anon`, `authenticated` and `supabase_*` roles are not covered by this SQL or by the probe, apart from the default-privilege revokes for `anon` and `authenticated`. `service_role` bypasses RLS by design; its key must stay out of the app and out of logs (see `docs/runbooks/secret-hygiene.md`).
- The SQL sets only the role attributes a non-superuser admin may change (`LOGIN`, `NOCREATEDB`, `NOCREATEROLE`). `SUPERUSER`, `REPLICATION` and `BYPASSRLS` can be changed only by a superuser, and Supabase `postgres` is not one: `ALTER ROLE ... NOSUPERUSER` fails there with "Only roles with the SUPERUSER attribute may change the SUPERUSER attribute". New roles default to the safe values, and step 7 of the SQL aborts the whole run (rolling it back) if either role carries any of them. If that happens a role already existed with drifted attributes: drop and recreate it, or have a superuser fix it. Tested locally with a non-superuser admin that holds `CREATEDB CREATEROLE REPLICATION BYPASSRLS`.
- `TEMPORARY` is revoked from `PUBLIC` on the database and granted back only to the migrator (and the owner keeps it). This needs the admin to own the database; if it does not, the `REVOKE` is a no-op with a warning and step 7 aborts the run because the runtime role still has `TEMPORARY`. It also removes `TEMPORARY` from every other role that relied on `PUBLIC` (Supabase service roles included); the app creates no temp tables (`grep -ri "create temp"` in `src/` finds none). The rollback restores the default.
- `SECURITY DEFINER` functions in `public` are flagged by the probe (`no_security_definer_functions`); there are none today. A new one needs a review of its `search_path` and who can execute it.
- Follow-ups, not done here: revoke `CONNECT` from `PUBLIC` on the other databases; extend the probe to `service_role`; pooler-side connection limits for the runtime role.
