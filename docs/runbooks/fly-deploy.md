# Runbook: Fly.io deployment (knowvia-api)

Decision record: ADR 0011 D9. Synthetic data only until the residency decision (D8) is made.

## State (2026-10-29)

- App `knowvia-api` exists in `syd`. Volume `coversaath_data` (1 GB, encrypted) exists.
- Secrets staged, not applied to a machine: `DATABASE_URL`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `KNOWVIA_BOOTSTRAP_TOKEN`. Before the website sign-in goes live, also set `KNOWVIA_IDENTITY_TOKEN` (a secret, different from the bootstrap token) and `IDENTITY_ISSUERS` (exact issuer strings, one canonical form each); both are names only here.
- No machine is running. Every `fly deploy` failed with a Fly API 503 (builder creation and organisation lookup). Config validation passed. The Dockerfile has never been built, so it is untested.
- Nothing is pushed. The deploy files are on local branch `feat/supabase-postgres` (3abaa9f).

## Prerequisites

- The `fly` binary is at `~/.fly/bin/fly` (not on PATH). `fly auth whoami` must succeed.
- Fly API health is not reflected on the status page; test with `fly auth whoami` or a deploy.
- Run from a clean checkout of the branch. Do not put secrets in `fly.toml`.

## Deploy

```bash
~/.fly/bin/fly deploy --remote-only --ha=false -a knowvia-api
```

On a 5xx from the Fly API wait about 60 s and retry once. If it fails the same way twice, stop and report the error. Edit the Dockerfile or `fly.toml` only for a build failure, and only after reading the exact error.

## Verify

1. `fly status -a knowvia-api`: one machine started, checks passing.
2. `GET https://knowvia-api.fly.dev/api/v1/health` returns 200.
3. `GET /api/v1/ready` reports `database` and `authentication` true.
4. `curl -H 'Host: evil.example' https://knowvia-api.fly.dev/api/v1/health` returns 403.
5. `fly logs -a knowvia-api --no-tail`: server started, no stack traces.
6. Do not upload documents: the scanner is off, so uploads stay quarantined.

## Not verified yet

Dockerfile build, entrypoint behaviour, live health, ready and host guard, real HTTP concurrency for the per-case run cap, the ranking change from bm25 to `ts_rank_cd`.

## Operate

- One machine only (volume, scan worker and user-data write limiter are per process). Do not run `--ha` or scale out.
- Enable the scanner: 2 GB machine, `DOCUMENT_SCAN_MODE=clamd`, `CLAMD_HOST=127.0.0.1`.
- Rotate the Supabase password (it was pasted into chat twice), update `DATABASE_URL` in `.env.local` and with `fly secrets set`, then move the runtime to a least-privilege role. The prepared steps, ordered checklist and rollback are in [db-roles.md](db-roles.md); history and file secret findings are in [secret-hygiene.md](secret-hygiene.md).
- Abandon: `fly apps destroy knowvia-api` removes the app, volume and secrets. Destructive; needs explicit owner approval.

## Activity events and shared limits (ADR 0014)

- Production (`NODE_ENV=production` in the Dockerfile) needs the secret `DATA_ENCRYPTION_KEY_BASE64` (32 bytes, base64; name only) because activity events seal their payloads. Without it the server stops at startup. To boot without it, set both `APP_EVENTS_ENABLED=false` and `RATE_LIMIT_BACKEND=memory` (the database rate limiter also needs the key).
- `APP_EVENTS_RETENTION_DAYS` (default 30) sets how long events live; the server purges expired rows hourly. Retention is a draft for legal review.
- `RATE_LIMIT_BACKEND`, `MODEL_BUDGET_BACKEND` and `EVIDENCE_CLAIM_BACKEND` default to `database` (migrations 023 and 032, ADR 0014 addendum): the request limit, the model spend cap and the evidence-question claim (an expiring lease) hold across machines and restarts. `memory` turns one off and is for tests only. The scan worker and the user-data write limiter are still per process (duplicate work, not corruption).
- Run `npm run db:init` against the hosted database before the first deploy that includes migrations 022 to 024, then check `GET /api/v1/ready`.

## Rollback

`fly deploy` with the previous image or `fly machine stop`. The database schema is expand-only, so no data rollback is needed; no real data exists.
