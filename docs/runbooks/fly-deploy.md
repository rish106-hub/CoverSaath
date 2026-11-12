# Runbook: Fly.io deployment (knowvia-api)

Decision record: ADR 0011 D9 (amended 2026-11-06). Synthetic data only until the residency decision (D8) is made.

Every step marked **OWNER APPROVAL REQUIRED** deploys, changes a remote system, changes a secret, or can cost money. An agent prepares these steps and does not run them. Steps without the marker are read-only or local.

## State (2026-11-06, plan P1)

- Prepared, not deployed. `fly.toml` now describes the target: region `sin` (owner decision: Fly has no Mumbai region and Singapore is the nearest), two `shared-cpu-2x` machines with 3 GB each (clamd on, see Real workflow), no volume, no document file path.
- Document bytes live in PostgreSQL (ADR 0013 D8, `DOCUMENT_STORAGE_BACKEND=database`, which is also the code default). Verified in code: `src/server/create-server.js` builds the database store as the primary and the filesystem store only as a read fallback, and `src/features/input/encrypted-local-storage.js` creates its directory only on a write. With the volume gone, nothing is written to disk.
- Shared through PostgreSQL, so two machines enforce one limit (ADR 0014 D7 to D9, migrations 023 and 032): the request limit, the per-adult session, user-data, sync and person-record limits, the model spend cap (fails closed when the database is down) and the evidence claim guard.
- Still per process (duplicate work, never corruption): the evidence in-flight cap in `policy-evidence-service.js` (memory protection, not money) and the document scan worker. The scanner is now on in `fly.toml` (ADR 0022); before that change every upload stayed quarantined.
- App `knowvia-api` and volume `coversaath_data` (1 GB, syd) exist from October; no machine has ever run, so the volume holds nothing. Secrets staged on the app: `DATABASE_URL`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `KNOWVIA_BOOTSTRAP_TOKEN`. Not yet set: `DATA_ENCRYPTION_KEY_BASE64` (required in production; without it the server stops at startup), `KNOWVIA_IDENTITY_TOKEN`, `IDENTITY_ISSUERS`.
- The Dockerfile has never been built. Every October `fly deploy` failed with a Fly API 503.

## Prerequisites

- The `fly` binary is at `~/.fly/bin/fly` (not on PATH). `fly auth whoami` must succeed.
- Run from a clean checkout of the branch. Do not put secrets in `fly.toml`.
- All migrations (the highest file in `src/backend/database/postgres/migrations/`, 040 at the time of writing) are applied to the target database first (see Database connections). A deploy against an unmigrated database fails `/ready`.

## Database connections

Two different URLs, two different jobs.

| Job | Connection | Why |
| --- | --- | --- |
| API runtime (`DATABASE_URL` Fly secret) | Supabase transaction pooler, port **6543**, user `postgres.<project_ref>` | Two machines with a pool of 10 each (`pool.js` default) is 20 pooler client connections; the Supabase plan limit is not measured. |
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
4. Deploy staging, then run Verify, the pooler probe and the k6 script (`scripts/load/k6-50rps.js`, Q2). Staging deploy command (never the production one below):

   ```bash
   # OWNER APPROVAL REQUIRED (creates two machines; a paid resource)
   ~/.fly/bin/fly deploy --remote-only -a knowvia-api-staging -c fly.staging.toml
   ```

   Run Verify, run the pooler probe, then the k6 script (`scripts/load/k6-50rps.js`, Q2).
5. Destroy or stop staging machines when idle: `fly apps destroy` is destructive and needs explicit approval.

## Deploy

```bash
# OWNER APPROVAL REQUIRED (creates two machines; a paid resource)
~/.fly/bin/fly deploy --remote-only -a knowvia-api
```

Do not pass `--ha=false`: the first deploy then creates one machine and `min_machines_running = 2` is not met. `min_machines_running` does not create machines while auto-stop is off, so check `fly status` afterwards for exactly two machines in `sin`, and run `fly scale count 2 -a knowvia-api` (OWNER APPROVAL REQUIRED) if there are fewer. On a 5xx from the Fly API wait about 60 s and retry once. If it fails the same way twice, stop and report the error. Edit the Dockerfile or `fly.toml` only for a build failure, and only after reading the exact error.

The remaining step to change region: no machine exists, so nothing moves. The `syd` volume `coversaath_data` is unused; removing it (`fly volumes destroy`, **OWNER APPROVAL REQUIRED**, destructive) is optional and should wait until document upload to the database has been verified.

## Verify

1. `fly status -a knowvia-api`: two machines started in `sin`, checks passing on both.
2. `GET https://knowvia-api.fly.dev/api/v1/health` returns 200 (no database).
3. `GET /api/v1/ready` returns 200 with `checks.database`, `checks.authentication` and `checks.documentScanner` true (database schema valid, bootstrap token set, clamd answers PING; the scanner key is absent when `DOCUMENT_SCAN_MODE=disabled`, and with `DOCUMENT_SCAN_REQUIRED=true` a dead scanner makes the answer 503). A 503 means the schema is behind or the database is unreachable.
4. `curl -H 'Host: evil.example' https://knowvia-api.fly.dev/api/v1/health` returns 403.
5. `fly logs -a knowvia-api --no-tail`: both machines logged server start, no stack traces, no `DATA_ENCRYPTION_KEY_REQUIRED`.
6. Shared limits: send a few authenticated requests, then check that `rate_limit_buckets` rows exist (migration 023) rather than relying on one machine's memory.
7. Do not upload real documents. A synthetic upload checks the database store (the response succeeds and `document_blobs` gains a row) and, with the scanner on, the scan: see Real workflow, step 4.

### `/ready` review

- Behaviour: 200 `ready` or 503 `not_ready` with `checks: { database, authentication }`. `database` is `validatePostgresSchema` (migrations applied, tables, row level security, triggers, API-role grants), not a bare `SELECT 1`. Callers other than loopback get no schema detail.
- It goes through the shared (database-backed) rate limiter, unlike `/health` and `/live`, and runs about ten catalogue queries. Do not poll it every few seconds; use it as a deploy gate and for occasional checks.
- Why the Fly check stays on `/api/v1/health`: it needs no database, so a database or pooler blip does not take both machines out of rotation. Restarting machines would not fix a database outage, and the proxy would answer 503 anyway.
- Not checked by `/ready` (recorded, not changed here): `DATA_ENCRYPTION_KEY_BASE64` presence (production startup already refuses without it), `KNOWVIA_IDENTITY_TOKEN` and `IDENTITY_ISSUERS` (sign-in answers `AUTH_NOT_CONFIGURED` 503 instead), the document store and the provider keys. Add a check only when an outage shows the need.

## Not verified yet

Dockerfile build (including clamd, the signature download and `docker/entrypoint.sh` as PID 1), clamd memory on a 3 GB machine, entrypoint behaviour without a volume, live health, ready and host guard, whether the transaction pooler applies the timeouts (probe above), behaviour of two machines under load, real HTTP concurrency for the per-case run cap, the Singapore to Sydney query latency, Supabase pooler connection limits, and the ranking change from bm25 to `ts_rank_cd`.

`docker/entrypoint.sh` still runs `mkdir -p "${DOCUMENT_STORAGE_PATH:-/data/documents}"` and `chown -R node:node /data` at start. Without a volume `/data` is an empty directory in the image (the Dockerfile creates it), so both are harmless; the read fallback never writes. Tidy later with a build that can be tested.

## Operate

- Two machines is the supported shape. Do not scale past two before the scan worker moves to the database (the request limit, the per-adult service limits, model budget and evidence claim guard are already shared through the database, migrations 023 and 032, ADR 0014 D9).
- The scanner is enabled in `fly.toml` (3 GB machines, `DOCUMENT_SCAN_MODE=clamd`, `DOCUMENT_SCAN_REQUIRED=true`). Redeploy at least weekly so the baked-in signatures never age past what the runtime updater (freshclam) can replace; watch `fly logs` for `freshclam_stopped` loops.
- Rotate the Supabase password (it was pasted into chat twice), update `DATABASE_URL` in `.env.local` and with `fly secrets set` (**OWNER APPROVAL REQUIRED**), then move the runtime to a least-privilege role.
- Abandon: `fly apps destroy knowvia-api` removes the app, volume and secrets. Destructive; needs explicit owner approval.

## Real workflow: scan, OCR (Sarvam), structuring (Gemini)

Decision record: [ADR 0022](../adr/0022-production-upload-scan-and-scale-path.md). Load plan: [load-soak.md](load-soak.md). Every command below is **OWNER APPROVAL REQUIRED** (secrets, deploys, paid resources); an agent prepares them and does not run them.

What an upload goes through, in order:

1. `POST /api/v1/cases/:id/documents` (PDF, at most 15 MiB, headers `Idempotency-Key`, `X-Document-Kind`, `X-Consent-Grant-Id`, `X-Filename`). Needs a signed-in session, write access to the case, a current household-wide `document_processing` collect consent from the uploader, and room under `MAX_DOCUMENTS_PER_CASE` (50) and `MAX_PENDING_DOCUMENTS_PER_HOUSEHOLD` (20). Without `DOCUMENT_ENCRYPTION_KEY_BASE64` it answers `503 DOCUMENT_STORAGE_NOT_CONFIGURED`.
2. Sandboxed PDF inspection (child process: structure, page limit, no active content, no password), duplicate and version checks, then the bytes are encrypted and stored in PostgreSQL. Response `201`, status `received_pending_checks` (`lifecycle_state=quarantined`, `malware_status=pending`).
3. Scan: the in-process worker streams the bytes to clamd (`INSTREAM`). `clean` makes the document `active`/`accepted`; a hit deletes the bytes and marks it `rejected`; an outage defers with backoff (30 s doubling to 1 h). **If `DOCUMENT_SCAN_MODE=disabled` nothing scans: the document stays pending for ever, OCR answers `DOCUMENT_NOT_OCR_READY`, and after 20 pending uploads the household gets `503 DOCUMENT_SCANNER_NOT_CONFIGURED`.**
4. OCR: `POST /api/v1/documents/:id/ocr-jobs` with `consentGrantId` of a consent whose recipient is `sarvam`. Needs `SARVAM_OCR_ENABLED=true` and `SARVAM_API_KEY`, else `503 OCR_PROVIDER_DISABLED`. The caller polls `POST /api/v1/ocr-jobs/:id/refresh`.
5. Structuring: `POST /api/v1/documents/:id/structuring-runs` with a `workflowRunId`, a `consentGrantId` and the Gemini settings below. Needs `POLICY_STRUCTURING_ENABLED=true`; question answering additionally needs `POLICY_EVIDENCE_ENABLED=true`. Output is only `extracted_unverified` or `conflicting`.

Required settings:

| Stage | Plain env (fly.toml) | Secrets |
| --- | --- | --- |
| Scan | `DOCUMENT_SCAN_MODE=clamd`, `CLAMD_HOST=127.0.0.1`, `DOCUMENT_SCAN_REQUIRED=true` (already set) | none |
| Upload | `DOCUMENT_STORAGE_BACKEND=database` (already set) | `DOCUMENT_ENCRYPTION_KEY_BASE64` (set), `DATA_ENCRYPTION_KEY_BASE64` (not yet set) |
| OCR | `SARVAM_OCR_ENABLED=true`; optional `SARVAM_OCR_MAX_DOCUMENT_PAGES` (default 100), `SARVAM_OCR_MAX_CONCURRENT` (2) | `SARVAM_API_KEY` |
| Structuring | `POLICY_STRUCTURING_ENABLED=true`, `LLM_PROVIDER=google`, `LLM_MODEL`, `LLM_INPUT_USD_PER_MILLION`, `LLM_OUTPUT_USD_PER_MILLION`, `ORCHESTRATION_RUN_BUDGET_USD`, `ORCHESTRATION_PROJECT_BUDGET_USD` | `GEMINI_API_KEY` |

`LLM_MODEL` and the two rates have no default by design: take them from Google's current pricing page for a model the key can use. Wrong rates make every budget cap wrong.

Apply, in this order:

```bash
# 1. Secrets (values are typed on the operator machine, never committed)
~/.fly/bin/fly secrets set DATA_ENCRYPTION_KEY_BASE64='<32 random bytes, base64>' -a knowvia-api --stage
~/.fly/bin/fly secrets set SARVAM_API_KEY='<key>' GEMINI_API_KEY='<key>' -a knowvia-api --stage

# 2. Provider flags and Gemini settings as staged secrets (they are plain values; keeping them out of fly.toml means the
#    paid features stay a separate, reversible owner step)
~/.fly/bin/fly secrets set SARVAM_OCR_ENABLED=true POLICY_STRUCTURING_ENABLED=true LLM_PROVIDER=google \
  LLM_MODEL='<model>' LLM_INPUT_USD_PER_MILLION='<rate>' LLM_OUTPUT_USD_PER_MILLION='<rate>' \
  ORCHESTRATION_RUN_BUDGET_USD=0.25 ORCHESTRATION_PROJECT_BUDGET_USD=5 -a knowvia-api --stage

# 3. Deploy the image with the scanner (builds clamd into the image; first build downloads signatures)
~/.fly/bin/fly deploy --remote-only -a knowvia-api
~/.fly/bin/fly status -a knowvia-api            # two machines in sin, checks passing
~/.fly/bin/fly logs -a knowvia-api --no-tail    # expect clamd_ready within about three minutes, no document_scanner_unreachable after that
```

Verify (synthetic documents only):

1. `GET /api/v1/ready` returns 200 with `checks.documentScanner: true` on both machines (repeat; the proxy chooses a machine).
2. Upload a synthetic PDF through the BFF or the API: status moves from `received_pending_checks` to `accepted` within a minute.
3. Scanner detection is proven by `tests/clamd-integration.test.mjs` (EICAR, run locally per [clamav.md](clamav.md)); clamd listens on loopback inside the machine, so it cannot be reached from outside and nothing here exposes it. In production, a hit shows as a `rejected` document and a `document.scan_blocked` audit event.
4. OCR job on the accepted document, then a structuring run. Check `fly logs` for no `policy_structuring_failed`, and provider spend against `ORCHESTRATION_PROJECT_BUDGET_USD`.
5. Watch memory for a day: `fly machine status <id> -a knowvia-api`, and any OOM kill in `fly logs`. If a machine is OOM-killed, raise `[[vm]] memory` before raising load.

Rollback of this step: `fly secrets unset SARVAM_OCR_ENABLED POLICY_STRUCTURING_ENABLED -a knowvia-api` turns the paid features off; reverting `fly.toml` to `DOCUMENT_SCAN_MODE=disabled`, removing `DOCUMENT_SCAN_REQUIRED` and redeploying turns the scanner off (pending documents stay quarantined).

## Activity events and shared limits (ADR 0014)

- Production (`NODE_ENV=production` in the Dockerfile) needs the secret `DATA_ENCRYPTION_KEY_BASE64` (32 bytes, base64; name only) because activity events seal their payloads. Without it the server stops at startup. To boot without it, set both `APP_EVENTS_ENABLED=false` and `RATE_LIMIT_BACKEND=memory` (the database rate limiter also needs the key).
- `APP_EVENTS_RETENTION_DAYS` (default 30) sets how long events live; the server purges expired rows hourly. Retention is a draft for legal review.
- `RATE_LIMIT_BACKEND`, `MODEL_BUDGET_BACKEND` and `EVIDENCE_CLAIM_BACKEND` default to `database` (migrations 023 and 032, ADR 0014 addendum): the request limit, the model spend cap and the evidence-question claim (an expiring lease) hold across machines and restarts. `RATE_LIMIT_BACKEND` also covers the per-adult service limits (sessions, user data, sync, person records; ADR 0014 D9). If the database errors, these limiters refuse (fail closed, ADR 0014 D11). `memory` turns one off and is for tests only. The scan worker is still per process (duplicate work, not corruption).
- Run `npm run db:init` against the hosted database before the first deploy that includes migrations 022 to 024, then check `GET /api/v1/ready`.

## Job worker in the same container (2026-11-12)

`docker/entrypoint.sh` starts `node src/server/worker.js` next to the API, as the `node` user, in the same Fly machine group (no new process group, no extra machine, no paid change). If the API, the worker or clamd exits, the entrypoint kills the others and exits with that status, so Fly restarts the container. SIGTERM stops both; the worker finishes its in-flight job (lease re-claimed by another machine if it cannot). `WORKER_IN_CONTAINER=false` (Fly env) starts the API alone: the kill switch. Allow for one more Node process of memory (the 3 GB machines have room next to clamd; not measured).

- Two machines never run one job twice: `JobQueueRepository.claim` takes one row with `FOR UPDATE SKIP LOCKED` inside a short transaction, and heartbeat, complete and fail are fenced by worker id and attempt (`tests/job-queue.test.mjs`: two and four real parallel workers, every job exactly once; a crashed worker's job is re-claimed after its lease). The worker id defaults to `<hostname>-<pid>`, which differs per machine.
- Transaction pooler (port 6543): the worker uses the same pool as the API (`pool.js`, no named prepared statements, no `LISTEN`, no session lock). `tests/worker-entrypoint.test.mjs` fails if runtime code adds `pg_advisory_lock`, `LISTEN`, `NOTIFY`, `PREPARE` or a session-level `set_config`. Still unmeasured on the real pooler: the startup-option timeouts (run `scripts/probe-pooler.mjs` as above; the worker is no different from the API here).
- Handlers register only for the flags that are exactly `true` (`buildJobHandlers`); with none, the worker claims nothing. Boot log lines: `worker.started` with the kinds, `worker.stopped`.
- Flags and secrets for the one-person journey (upload, OCR, structuring, holdings, memory, chat): see the PR text of this change and `docs/runbooks/chat-and-memory.md`.

## Chat model providers: openai, anthropic, deepseek, kimi (2026-11-12)

Chat answers, intent classification and fact extraction route gemini, then anthropic, openai, deepseek, kimi (`MODEL_ROUTES`). Each has an AI SDK adapter (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/deepseek`, `@ai-sdk/moonshotai`). A provider is called only when it is in `MODEL_PROVIDERS`, its key and both per-million rates are set, `CHAT_MODEL_ENABLED=true`, and the household has a current grant naming that provider; otherwise it answers a typed unavailable and the next one is tried.

- Secrets (names only): `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`. Models and rates have no verified default: set `<P>_MODEL`, `<P>_CLASSIFY_MODEL` and `<P>_INPUT_USD_PER_MILLION`, `<P>_OUTPUT_USD_PER_MILLION` (and `_CLASSIFY_` pairs) with `<P>` one of `OPENAI`, `ANTHROPIC`, `DEEPSEEK`, `KIMI` (Kimi keeps the `KIMI_` prefix for models and rates). A missing rate fails closed (`rates_missing`).
- **FOR LEGAL REVIEW (DPDP cross-border transfer):** DeepSeek and Moonshot (Kimi) are China-hosted processors. Keep `deepseek` and `kimi` out of `MODEL_PROVIDERS` until the owner has a legal decision on transfer, notice and consent wording. The default stays `anthropic`; the recommended set is `gemini,anthropic,openai,voyage`.
- Rollback: remove the provider from `MODEL_PROVIDERS` (or unset its key); no migration is involved.

## Rollback

- Code: list releases with `fly releases -a knowvia-api`, then redeploy the previous image with `fly deploy --image <previous image reference> -a knowvia-api` (**OWNER APPROVAL REQUIRED**), or stop machines with `fly machine stop <id>`.
- Configuration: revert `fly.toml` with git and redeploy. Reverting to the old file would also need a volume attached to a machine (`[[mounts]]`), which is why the volume is kept until the database store is verified.
- Documents: an image older than ADR 0013 cannot read blobs stored in the database. Roll back only to an image that has `DOCUMENT_STORAGE_BACKEND`. All data is synthetic.
- Pooler: if the probe or the first deploy shows a pooler problem, set `DATABASE_URL` back to the session pooler (port 5432) with `fly secrets set` (**OWNER APPROVAL REQUIRED**); no code change is needed.
- Data: the database schema is expand-only, so no data rollback is needed; no real data exists.
