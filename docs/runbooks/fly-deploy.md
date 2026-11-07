# Runbook: Fly.io deployment (knowvia-api)

Decision record: ADR 0011 D9 (amended 2026-11-06). Synthetic data only until the residency decision (D8) is made.

Every step marked **OWNER APPROVAL REQUIRED** deploys, changes a remote system, changes a secret, or can cost money. An agent prepares these steps and does not run them. Steps without the marker are read-only or local.

## State (2026-11-06, plan P1)

- Prepared, not deployed. `fly.toml` now describes the target: region `sin` (owner decision: Fly has no Mumbai region and Singapore is the nearest), two `shared-cpu-1x` machines with 1 GB each, no volume, no document file path.
- Document bytes live in PostgreSQL (ADR 0013 D8, `DOCUMENT_STORAGE_BACKEND=database`, which is also the code default). Verified in code: `src/server/create-server.js` builds the database store as the primary and the filesystem store only as a read fallback, and `src/features/input/encrypted-local-storage.js` creates its directory only on a write. With the volume gone, nothing is written to disk.
- The request limit and the model spend cap are in PostgreSQL (`RATE_LIMIT_BACKEND=database`, `MODEL_BUDGET_BACKEND=database`, migration 023), so two machines share them.
- Still per process (duplicate work, never corruption): the evidence claim guard and in-flight cap in `policy-evidence-service.js`, and the document scan worker. The scanner is off, so uploads stay quarantined.
- App `knowvia-api` and volume `coversaath_data` (1 GB, syd) exist from October; no machine has ever run, so the volume holds nothing. Secrets staged on the app: `DATABASE_URL`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `KNOWVIA_BOOTSTRAP_TOKEN`. Not yet set: `DATA_ENCRYPTION_KEY_BASE64` (required in production; without it the server stops at startup), `KNOWVIA_IDENTITY_TOKEN`, `IDENTITY_ISSUERS`.
- The Dockerfile has never been built. Every October `fly deploy` failed with a Fly API 503.

## Prerequisites

- The `fly` binary is at `~/.fly/bin/fly` (not on PATH). `fly auth whoami` must succeed.
- Run from a clean checkout of the branch. Do not put secrets in `fly.toml`.
- Migrations 001 to 029 are applied to the target database first (see Database connections). A deploy against an unmigrated database fails `/ready`.

## Database connections

Two different URLs, two different jobs.

| Job | Connection | Why |
| --- | --- | --- |
| API runtime (`DATABASE_URL` Fly secret) | Supabase transaction pooler, port **6543**, user `postgres.<project_ref>` | Two machines with a pool of 10 each (`pool.js` default) stay well under direct-connection limits. |
| Migrations (`npm run db:init`) | Direct host, or the session pooler on port **5432** | `migrate.js` takes a session-level `pg_advisory_lock` and runs `set_config(..., false)`; both break on a transaction pooler. The direct host is IPv6-only (ADR 0011 D3), so from an IPv4-only machine use the session pooler. |

Why the runtime may use the transaction pooler: every runtime advisory lock is `pg_advisory_xact_lock` inside a transaction (`locks.js`, `db.js`), the pool uses no named prepared statements, no `LISTEN` or `NOTIFY`, and no session state. ADR 0011 D3 required session mode because of earlier lock designs; the migration lock is now the only session lock.

One risk is not yet proven: `pool.js` sets `statement_timeout`, `lock_timeout` and `idle_in_transaction_session_timeout` as connection startup options (`-c ...`). A pooler may ignore or reject startup options, which would silently remove those timeouts. The probe checks this:

```bash
# OWNER APPROVAL REQUIRED (connects to a hosted database; read-only: SHOW and one empty transaction)
DATABASE_URL='<pooler URL, port 6543>' DATABASE_SSL_CA_PATH=docker/supabase-ca.crt node scripts/probe-pooler.mjs
```

Pass means `ok: true` with all three settings `applied: true` and `advisoryTransactionLock: true`. If any setting is not applied, do not use port 6543: keep the API on the session pooler (port 5432) and open a change to set the timeouts per transaction (`SET LOCAL`) before revisiting. Connection limits of the Supabase plan are not measured; two machines at pool size 10 is 20 pooler client connections.

Never run `fly ssh console -C "npm run db:init"`: inside the app `DATABASE_URL` is the 6543 URL. Run migrations from an operator machine, passing the direct or session-pooler URL only for that command:

```bash
# OWNER APPROVAL REQUIRED (changes the hosted schema; migrations are expand-only)
DATABASE_URL='<direct or session pooler URL, port 5432>' DATABASE_SSL_CA_PATH=docker/supabase-ca.crt npm run db:init
```

The URL is typed into the command and not saved to a file; `database.mjs` prints no connection string.

## Staging app plan (nothing created yet)

Aim: prove the Dockerfile, the two-machine behaviour, the pooler and the k6 script before production. All creation steps need **OWNER APPROVAL REQUIRED** (a new Fly app and a new database can cost money).

1. Separate Fly app `knowvia-api-staging`, region `sin`, a copy of `fly.toml` kept outside git or as `fly.staging.toml` with only these differences: `app`, `PUBLIC_HOSTS = "knowvia-api-staging.fly.dev"`, the health check `Host` header, and `API_RATE_LIMIT_PER_MINUTE = "6000"` so the 50 requests per second k6 run is not answered 429 (default is 600 per client address).
2. Separate database, never the production one: a second database in the same Supabase project created like `coversaath` (libc `C` collation, ADR 0011 D2), for example `coversaath_staging`, or a separate project. Same project is cheaper but shares pooler and compute with production; separate is safer. Owner chooses.
3. Separate secrets, generated fresh: `DATABASE_URL`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `DATA_ENCRYPTION_KEY_BASE64`, `KNOWVIA_BOOTSTRAP_TOKEN`. Never reuse a production secret.
4. Deploy staging with the command below (`-a knowvia-api-staging -c fly.staging.toml`), run Verify, run the pooler probe, then the k6 script (`scripts/load/k6-50rps.js`, Q2).
5. Destroy or stop staging machines when idle: `fly apps destroy` is destructive and needs explicit approval.

## Deploy

```bash
# OWNER APPROVAL REQUIRED (creates two machines; a paid resource)
~/.fly/bin/fly deploy --remote-only -a knowvia-api
```

Do not pass `--ha=false`: the first deploy then creates one machine and `min_machines_running = 2` is not met. Check `fly status` afterwards for exactly two machines in `sin`. On a 5xx from the Fly API wait about 60 s and retry once. If it fails the same way twice, stop and report the error. Edit the Dockerfile or `fly.toml` only for a build failure, and only after reading the exact error.

The remaining step to change region: no machine exists, so nothing moves. The `syd` volume `coversaath_data` is unused; removing it (`fly volumes destroy`, **OWNER APPROVAL REQUIRED**, destructive) is optional and should wait until document upload to the database has been verified.

## Verify

1. `fly status -a knowvia-api`: two machines started in `sin`, checks passing on both.
2. `GET https://knowvia-api.fly.dev/api/v1/health` returns 200 (no database).
3. `GET /api/v1/ready` returns 200 with `checks.database` and `checks.authentication` true (database schema valid, bootstrap token set). A 503 means the schema is behind or the database is unreachable.
4. `curl -H 'Host: evil.example' https://knowvia-api.fly.dev/api/v1/health` returns 403.
5. `fly logs -a knowvia-api --no-tail`: both machines logged server start, no stack traces, no `DATA_ENCRYPTION_KEY_REQUIRED`.
6. Shared limits: send a few authenticated requests, then check that `rate_limit_buckets` rows exist (migration 023) rather than relying on one machine's memory.
7. Do not upload real documents: the scanner is off, so uploads stay quarantined. A synthetic upload checks the database store: the response succeeds and `document_blobs` gains a row.

### `/ready` review

- Behaviour: 200 `ready` or 503 `not_ready` with `checks: { database, authentication }`. `database` is `validatePostgresSchema` (migrations applied, tables, row level security, triggers, API-role grants), not a bare `SELECT 1`. Callers other than loopback get no schema detail.
- It goes through the shared (database-backed) rate limiter, unlike `/health` and `/live`, and runs about ten catalogue queries. Do not poll it every few seconds; use it as a deploy gate and for occasional checks.
- Why the Fly check stays on `/api/v1/health`: it needs no database, so a database or pooler blip does not take both machines out of rotation. Restarting machines would not fix a database outage, and the proxy would answer 503 anyway.
- Not checked by `/ready` (recorded, not changed here): `DATA_ENCRYPTION_KEY_BASE64` presence (production startup already refuses without it), `KNOWVIA_IDENTITY_TOKEN` and `IDENTITY_ISSUERS` (sign-in answers `AUTH_NOT_CONFIGURED` 503 instead), the document store and the provider keys. Add a check only when an outage shows the need.

## Not verified yet

Dockerfile build, entrypoint behaviour without a volume, live health, ready and host guard, whether the transaction pooler applies the timeouts (probe above), behaviour of two machines under load, real HTTP concurrency for the per-case run cap, the Singapore to Sydney query latency, Supabase pooler connection limits, and the ranking change from bm25 to `ts_rank_cd`.

`docker/entrypoint.sh` still runs `mkdir -p "${DOCUMENT_STORAGE_PATH:-/data/documents}"` and `chown -R node:node /data` at start. Without a volume `/data` is an empty directory in the image (the Dockerfile creates it), so both are harmless; the read fallback never writes. Tidy later with a build that can be tested.

## Operate

- Two machines is the supported shape. Do not scale past two before the evidence claim guard and the scan worker move to the database.
- Enable the scanner: 2 GB machines, `DOCUMENT_SCAN_MODE=clamd`, `CLAMD_HOST=127.0.0.1` (**OWNER APPROVAL REQUIRED**, costs more).
- Rotate the Supabase password (it was pasted into chat twice), update `DATABASE_URL` in `.env.local` and with `fly secrets set` (**OWNER APPROVAL REQUIRED**), then move the runtime to a least-privilege role.
- Abandon: `fly apps destroy knowvia-api` removes the app, volume and secrets. Destructive; needs explicit owner approval.

## Activity events and shared limits (ADR 0014)

- Production (`NODE_ENV=production` in the Dockerfile) needs the secret `DATA_ENCRYPTION_KEY_BASE64` (32 bytes, base64; name only) because activity events seal their payloads. Without it the server stops at startup. To boot without events set `APP_EVENTS_ENABLED=false`.
- `APP_EVENTS_RETENTION_DAYS` (default 30) sets how long events live; the server purges expired rows hourly. Retention is a draft for legal review.
- `RATE_LIMIT_BACKEND=database` and `MODEL_BUDGET_BACKEND=database` are now set in `fly.toml` (migration 023), so the limit holds across both machines and restarts. Remaining per-process items are listed under State.

## Rollback

- Code: list releases with `fly releases -a knowvia-api`, then redeploy the previous image with `fly deploy --image <previous image reference> -a knowvia-api` (**OWNER APPROVAL REQUIRED**), or stop machines with `fly machine stop <id>`.
- Configuration: revert `fly.toml` with git and redeploy. Reverting to the old file would also need a volume attached to a machine (`[[mounts]]`), which is why the volume is kept until the database store is verified.
- Documents: an image older than ADR 0013 cannot read blobs stored in the database. Roll back only to an image that has `DOCUMENT_STORAGE_BACKEND`. All data is synthetic.
- Pooler: if the probe or the first deploy shows a pooler problem, set `DATABASE_URL` back to the session pooler (port 5432) with `fly secrets set` (**OWNER APPROVAL REQUIRED**); no code change is needed.
- Data: the database schema is expand-only, so no data rollback is needed; no real data exists.
