# ADR 0011: Supabase PostgreSQL as the master database

- Status: Proposed (owner chose Sydney and Fly.io for synthetic data; real-data residency, D8, still needs legal sign-off)
- Date: 2026-10-29
- Builds on: ADR 0004 (PostgreSQL runtime). Supersedes the ADR 0004 D1 line "The production version is decided with the Azure owner" and the Azure assumption in `production-hardening.xml`.

## Context

The owner chose one PostgreSQL master database on Supabase for every CoverSaath surface. Today the backend runs on SQLite and the marketing website keeps its own Postgres table (`knowvia_waitlist`). The Supabase project is `nxvxkcazzijctusszcjf` in `ap-southeast-2` (Sydney). Indian health-insurance data is in scope, so residency is a real question, not a detail.

## Decisions

- **D1 Master database.** Supabase PostgreSQL 17 is the single runtime database for the backend and, in a later step, the website waitlist and voice notes. The SQLite runtime is removed from `src/` by S3.2 (ADR 0004 D2).
- **D2 Separate `coversaath` database.** Supabase's default `postgres` database uses an `en_US.UTF-8` ICU collation, which fails ADR 0004 D4 (`'B' < 'a'` must hold) and the schema validator. The validator is not relaxed. CoverSaath data lives in a second database, `coversaath`, created with libc `C` collation in the same project. Supabase's REST and GraphQL APIs serve only `postgres`, so these tables are not exposed through them. Row-level security is not the access boundary; the backend is, through a server-only connection.
- **D3 Connection.** The runtime uses the Supavisor session pooler (`aws-0-<region>.pooler.supabase.com:5432`, user `postgres.<project_ref>`) because the direct host is IPv6-only. Session mode is required: advisory locks (ADR 0004 D7 and the S3.2 locking design) and session settings do not survive transaction-mode pooling.
- **D4 TLS.** The pool verifies the server certificate against the pinned Supabase Root 2021 CA (`DATABASE_SSL_CA_PATH`, expires 2031). `rejectUnauthorized` is always true when a CA is given, and also for any non-loopback host without one (verified against system roots, so a hosted database without its CA fails closed instead of connecting in plaintext). Only loopback and Unix-socket databases run without TLS, and `ssl` is always set explicitly so `PGSSLMODE` cannot change it. URL parameters `sslmode`, `ssl*` and `uselibpqcompat` are stripped so a connection string cannot weaken TLS. The CA file is public and stays out of git; the password never enters code, logs or commits.
- **D5 Credentials.** `DATABASE_URL` is a server-only secret in the host's secret store. The `postgres` superuser password is for migrations only; the runtime moves to a least-privilege role in a follow-up.
- **D6 Tests never touch Supabase.** `TEST_DATABASE_URL` points at local or CI PostgreSQL 17. The harness creates many databases and must not run against the shared project.
- **D7 Backend host.** The backend needs a container host: ClamAV daemon scanning, per-process in-flight claims and rate limits, and background OCR and structuring jobs do not fit pure serverless. Fly.io hosts the backend (see D9); the website stays on Vercel. The earlier Mumbai (`bom`) candidate is withdrawn: Fly no longer offers that region.
- **D8 Region and residency.** Sydney is accepted only for synthetic data. Real user data waits for a decision between moving the project to Mumbai (`ap-south-1`) and legal advice that cross-border storage is acceptable. Marked for legal review.

- **D9 Fly.io deployment (2026-10-29, owner chose the cheapest option).**
  - App `knowvia-api`, region `syd` (same region as the database), one `shared-cpu-1x` 512 MB machine, 1 GB encrypted volume `coversaath_data` at `/data` for protected documents. Config: `fly.toml`, `Dockerfile`, `docker/`.
  - Single machine only. The volume attaches to one machine, and run claims and the rate limiter are per process. Do not scale out before moving those to the database (see the open risks in `docs/iterations/LATEST.md`).
  - Scanner off (`DOCUMENT_SCAN_MODE=disabled`): `clamd` needs about 1 GB or more of RAM, so every upload stays quarantined. Enabling it needs a 2 GB machine, `DOCUMENT_SCAN_MODE=clamd` and `CLAMD_HOST=127.0.0.1`.
  - Public exposure is an explicit opt-in. The server answers only loopback by default; `PUBLIC_HOSTS` lists exact hostnames (no wildcards) and any other `Host` is refused with 403. `TRUST_FLY_CLIENT_IP=true` keys the rate limit on a valid `Fly-Client-IP`, else on the socket peer. The limiter is in memory per process.
  - Free platform features used: Fly proxy TLS and forced HTTPS, load balancing, connection concurrency limits (soft 40, hard 80) and an HTTP health check on `/api/v1/health`. There is no WAF on this plan.
  - Secrets (`DATABASE_URL`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `KNOWVIA_BOOTSTRAP_TOKEN`) live only in Fly secrets and `.env.local`. The Supabase password was exposed in chat and must be rotated after setup; the runtime then moves to a least-privilege role (D5).
  - Sydney keeps D8: synthetic data only.
  - State at writing: app, volume and secrets exist; no machine is deployed because the Fly API returned 503 on every deploy attempt. The Dockerfile has never been built. See `docs/runbooks/fly-deploy.md`.

## Segment map

One project, one master database (`coversaath`), one schema per segment. Cross-schema references are not allowed between segments; a segment talks to another through the backend API, so any segment can later move to its own database or service without changing the others.

| Segment | Schema | Owner | State |
|---|---|---|---|
| Backend core (households, consent, documents, evidence, workflow, audit, catalogue) | `public` | CoverSaath backend, migrations `src/backend/database/postgres/migrations/` | Deployed, 15 migrations, validated |
| Website (waitlist, voice notes) | `knowvia_web` | Website, migrations `db/migrations/` in the website repo | Deployed |
| Future segments (for example analytics, ingestion) | one new schema each | their own service | Not started |

The backend keeps `public` because its schema validator and migration runner assume it; moving it to a named schema is a separate, reversible change. Separate databases per segment are not used: PostgreSQL cannot join or enforce foreign keys across databases, and the C-collation workaround in D2 is needed only once.

- **D10 Data API lockdown (2026-10-29, owner chose `public` with RLS and revokes).** Supabase exposes `public` through PostgREST. The backend connects directly and never uses the Data API, so migration 016 enables row level security on every table (no policies, so deny by default) and revokes all table and sequence privileges, and default privileges, from `anon` and `authenticated`. `validatePostgresSchema` reports `tablesWithoutRls` and `apiRoleGrants`, so a later migration that forgets RLS fails `db:init` and `/ready`. The connection role owns the tables and bypasses RLS. Functions keep the default `PUBLIC` execute (trigger functions and the pure `julianday` and `coversaath_utc_now` helpers); revoking it could break CHECK evaluation for a non-owner runtime role. The website keeps its own schema `knowvia_web` and must get the same treatment. Service direction: any later split into services gives each service its own schema and its own role with no grants on another service's schema; no service is added without measured need (AGENTS.md).

## Consequences

- Latency from India to Sydney is higher than to Mumbai. No measurement exists; do not claim a number.
- Two databases in one project is a deliberate workaround for Supabase's default collation. Dropping the workaround requires a Supabase project created with `C` collation, which the dashboard does not offer.
- Backups, point-in-time recovery and extension limits follow the Supabase plan. The recovery runbook must be rewritten for Supabase before real data arrives.
- The website waitlist keeps a copy of personal data (email, first name) with no consent record or delete path. Moving it to Supabase must add both.

## Rollback

Application code reads `DATABASE_URL`; pointing it at any PostgreSQL 17 server with a `C`-collation database and running `scripts/postgres-migrate.mjs` reproduces the schema. No data exists yet, so rollback loses nothing.
