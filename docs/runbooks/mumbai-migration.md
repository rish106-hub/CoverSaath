# Runbook: move the database to Mumbai (P3 plan, not run)

Plan only. Nothing here has been executed, and no step may be run by an agent. Every step marked **OWNER APPROVAL REQUIRED** creates, changes or deletes a remote resource, or can cost money. Related: ADR 0011 D7, D8 and D9, `docs/runbooks/fly-deploy.md`.

## Why and what

ADR 0011 D8 accepts Sydney (`ap-southeast-2`) for synthetic data only. Real Indian health data waits for a choice between a Mumbai project (`ap-south-1`) and legal advice that cross-border storage is acceptable. This runbook is the Mumbai path. Fly has no Mumbai region, so the API stays in Singapore (`sin`, `fly.toml`), the nearest Fly region. Whether `sin` to Mumbai is fast enough is not measured; measure it in staging before cutover.

Consent, privacy and residency wording is never final: the cutover needs legal review first.

## Scope and non-goals

- In scope: a new Supabase project in `ap-south-1`, the `coversaath` database with `C` collation, schema, secrets, the Fly cutover, rollback.
- Not in scope: copying real data (none exists), the website `knowvia_web` schema (separate repo and runbook; it lives in the same Supabase project today, so it needs its own plan, see Open questions), changing the Fly region again.

## Preconditions

1. Owner decision recorded: Mumbai chosen (update ADR 0011 D8, mark legal review).
2. Legal review of the residency position, the privacy notice and the consent wording is complete or explicitly deferred while data stays synthetic.
3. Staging (see `fly-deploy.md`, Staging app plan) has passed the pooler probe, a two-machine run and the k6 script, against the Sydney database. Re-run the probe and k6 against the Mumbai database before cutover.
4. A current `DATA_ENCRYPTION_KEY_BASE64` and `DOCUMENT_ENCRYPTION_KEY_BASE64` are in the owner's secret store. Losing either loses the sealed columns and document bytes (ADR 0013). They do not change in a region move.
5. Decide data handling. Today all data is synthetic, so the default is a fresh start (no copy). If any data worth keeping exists, take a dump first (Step 5).

## Steps

Each step lists its check and its undo.

### 1. Create the Mumbai project (OWNER APPROVAL REQUIRED, paid resource)

Create a Supabase project in `ap-south-1`, with its own database password. Record the project reference privately (not in the repository). Check: the dashboard shows region `ap-south-1`. Undo: delete the project (destructive, needs approval).

### 2. Create the `coversaath` database with `C` collation (OWNER APPROVAL REQUIRED)

The default `postgres` database has an ICU collation that fails ADR 0011 D2, so create a second database as for Sydney, as the `postgres` role:

```sql
CREATE DATABASE coversaath TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C';
```

Check: `SELECT datcollate FROM pg_database WHERE datname = 'coversaath'` returns `C`. Undo: `DROP DATABASE coversaath` (destructive, empty at this point).

### 3. Apply the schema (OWNER APPROVAL REQUIRED)

From an operator machine, against the new database over the direct host or the session pooler (port 5432), never the transaction pooler (the migration lock is a session lock):

```bash
DATABASE_URL='<new direct or session pooler URL, database coversaath>' DATABASE_SSL_CA_PATH=docker/supabase-ca.crt npm run db:init
```

Check: output has `valid: true` and `tablesWithoutRls` and `apiRoleGrants` empty. Then run the Supabase security advisors for the new project. The CA file `docker/supabase-ca.crt` is the Supabase Root 2021 CA; confirm the new project chains to it (the pool refuses an unverified certificate, so a mismatch fails closed at connect).

### 4. Prove the pooler on the new project (OWNER APPROVAL REQUIRED, read-only)

```bash
DATABASE_URL='<new transaction pooler URL, port 6543>' DATABASE_SSL_CA_PATH=docker/supabase-ca.crt node scripts/probe-pooler.mjs
```

Must print `ok: true`. Otherwise use the session pooler (port 5432) for the API.

### 5. Data (only if needed)

Default: nothing to copy. If something must be kept, dump from Sydney and restore to Mumbai during a write freeze (stop the API machines first so no write lands after the dump), then rerun `db:init` and the schema validation. Sealed columns stay sealed; the same encryption keys must be set on the app. Check row counts per table match. Undo: the Sydney database is untouched until Step 9.

### 6. Stand up a Mumbai staging copy (OWNER APPROVAL REQUIRED)

Point the staging app (`knowvia-api-staging`, `sin`) at the Mumbai database. Run Verify from `fly-deploy.md`, then the k6 script (`scripts/load/k6-50rps.js`) and record p95 latency. Compare with a Sydney-backed run. Do not proceed if the result is worse than the agreed target (no target exists yet; the owner sets one).

### 7. Cutover (OWNER APPROVAL REQUIRED)

1. Announce a short window. Synthetic data only, so no user impact is expected.
2. Stage the production secret without restarting: `fly secrets set --stage DATABASE_URL='<Mumbai transaction pooler URL>' -a knowvia-api`. A plain `fly secrets set` rolls the machines one by one, so one machine would still write Sydney while another writes Mumbai. Stop both machines first (`fly machine stop <id> -a knowvia-api` for each id from `fly status`, OWNER APPROVAL REQUIRED; the machines are kept, so nothing is destroyed and no scale-from-zero is needed), then run `fly deploy --strategy immediate -a knowvia-api` so both machines are replaced together and start on the Mumbai URL. Never use `fly scale count 0`: it destroys the machines.
3. Verify: `fly status` shows both machines passing, `GET /api/v1/ready` is 200, then one synthetic household create and read.
4. Update the website BFF and any other consumer that connects to the database directly, in its own repository (none should; the backend is the only writer to `public`).

### 8. Observe

Watch `fly logs`, `/api/v1/ready` and the activity events for a day. Check `statement_timeout` expiries and pooler errors.

### 9. Retire Sydney (OWNER APPROVAL REQUIRED, destructive)

Only after the owner is satisfied and a backup exists. Pause the Sydney project before deleting it so it can be restored. Update ADR 0011 (D8 closed, region now `ap-south-1`) and `docs/iterations/LATEST.md`.

## Rollback

- Before Step 9: repeat Step 7 with the Sydney pooler URL: stop both machines, `fly secrets set --stage DATABASE_URL=...`, then `fly deploy --strategy immediate` (**OWNER APPROVAL REQUIRED**), and confirm `fly status` shows two passing machines. Writes made on Mumbai after cutover are not copied back; with synthetic data that loss is accepted, with real data it is not, so with real data take a dump of Mumbai first and plan a reverse restore.
- After Step 9 the Sydney data is gone unless a backup was kept; restore from the backup into a new Sydney project.

## Open questions for the owner

1. The website schema `knowvia_web` shares the Sydney project. Move it to the Mumbai project, or leave it?
2. Latency target for API requests from India (none exists).
3. Is a Supabase plan with point-in-time recovery needed before real data (ADR 0011 Consequences)?
4. Residency legal advice: when, and who signs off.
