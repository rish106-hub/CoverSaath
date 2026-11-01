# Backend ops: audit, ranking and slices (run backend-ops, 2026-11-01)

Branch `feat/backend-ops` (from main f50eeaa). Synthetic data only. Owner goals: (1) store every minute's scale of application data with encryption, (2) backend efficiency, (3) rate limiter, deployment, provider calls, latency, migration and distribution. Run E1 (profile answers, column encryption, DB document bytes, ADR 0013) is built elsewhere; nothing here duplicates it.

Line numbers refer to main f50eeaa before this run's edits.

## 1. Audit

### (a) Activity that is NOT persisted today

`audit_events` is a tamper-evident hash chain for state changes only (`src/backend/repositories/audit-repository.js:34-48`). Its actions are `consent.granted`, `consent.revoked`, `document.uploaded`, `case.created`, `auth_identity.created` and similar. Not recorded anywhere in the database:

| Activity | Evidence | Today |
| --- | --- | --- |
| Every request (route, status, duration) | `src/server/create-server.js:200-215` handles requests and only sends the response | nothing |
| Sign-in attempts and failures | `src/backend/repositories/auth-identity-repository.js:31` audits only first creation (`auth_identity.created`); `last_used_at` is one column; refusals (401/503) leave no trace | counts at best |
| Consent views, read-back queries (`read-facts`, `passages`) | read routes in `v1-backend-routes.js:490-520`; reads write no audit event | nothing |
| Upload attempts that fail (415/413/409/503) | only the success path audits `document.uploaded` | nothing |
| Errors | `publicError` maps and discards (`src/shared/http/errors.js`) | nothing |
| Rate-limit hits | `security.js:41` throws 429 | nothing |
| Provider call outcome, latency, tokens, cost | `model-gateway.js:107-123` returns metadata to the caller; structuring `onCall` is `() => {}` in evidence service (`policy-evidence-service.js:357`) | not stored; lost on return |
| Worker events (scan exhausted, sweep failed) | `create-server.js:226-240` `console.warn` only | stdout only |
| Session use | `auth-repository.js:55` writes `last_seen_at` per request (one HOT update) | last value only |

Decision: a new append-only `app_events` table (migration 022), written off the request path in batches, with route templates and keyed hashes only and the rest sealed (ADR 0014).

### (b) Per-process state that breaks with more than one machine

| State | Evidence | Failure with N machines or a restart |
| --- | --- | --- |
| Request rate limiter | `src/shared/http/security.js:34-50` (Map), built at `create-server.js:60` | each machine allows the full limit, so N times the limit; reset on restart |
| Model spend cap | `live-coverage-runtime.js:56-70` `createBudgetScope`, `createSharedProjectBudget` (one scope per process) | the cap multiplies by N and **resets on every restart or deploy**, so `ORCHESTRATION_PROJECT_BUDGET_USD` is not a real cap even on one machine |
| Evidence-claim guard and in-flight cap | `policy-evidence-service.js:205-206`, `:286`, `:446-448` (`claims` Set, `inFlight`) | two machines can run the same idempotency key at once; `saveAnswer` is idempotent on the key (database) so the cost is a duplicate model call, not a duplicate answer. Not changed (see section 4) |
| Document scan worker | `document-repository.js:197-211` `listWorkDocumentIds` has no claim (`FOR UPDATE SKIP LOCKED` appears nowhere in `src`) | two machines scan and delete the same document; `processDocument` is idempotent by state, so duplicate work only. Not changed |
| Document bytes | `fly.toml` `[[mounts]]` single volume; `DOCUMENT_STORAGE_PATH` filesystem | one machine only; E1 slice E1c moves bytes into PostgreSQL and removes this blocker |
| PDF inspector / segmenter child processes | `create-server.js:50-60` per process | fine, local by design |

Fixes built: Postgres-backed rate limiter and spend ledger (migration 023), opt-in by env, in-memory stays default and fallback.

### (c) Hot paths, N+1, indexes (EXPLAIN ANALYZE on a scratch database cloned from the migrated template, 2000 households, 200000 consent grants and documents, 400000 audit rows)

| Query | Plan before | After |
| --- | --- | --- |
| Audit append `WHERE household_id = ? ORDER BY id DESC LIMIT 1` | already uses `audit_events_household_chain_idx`, 0.02 ms | no change needed |
| Revoke: documents by `consent_grant_id` (`consent-repository.js:243`) | full scan of `document_uploads_household_consent_idx` (non-leading column), 9.5 ms | new `document_uploads_consent_grant_idx`, 0.06 ms |
| Consent list `WHERE household_id = ? AND subject_adult_id = ? ORDER BY granted_at DESC` (`consent-repository.js:91`) | bitmap scan + sort, 1.3 ms | new `consent_grants_household_subject_idx`, index-only, 0.2 ms |
| Foreign keys without a leading index (36 found) | e.g. `evidence_facts.household_id`, `case_participants.consent_grant_id`, `workflow_events.workflow_task_id` | **not indexed**: no measured query uses them; listed as a follow-up to measure when those routes see load |

No N+1 found in the routes read (`listForSubject` is two bounded queries). `authenticate` costs one SELECT plus one UPDATE per request (`auth-repository.js:43-57`); the UPDATE is also the revocation race check, so it was left alone.

### (d) Provider calls: timeouts, retries, breaking

| Call | Timeout | Retry | Gap |
| --- | --- | --- | --- |
| Gemini via gateway (`model-gateway.js:5`) | `timeoutMs` 30 s (analysis), 240 s (structuring, `structuring-runtime.js:13`) via `AbortSignal.timeout` | `maxRetries` 0 on purpose (a retry pays twice) | none; correct |
| Sarvam doc-ai (`sarvam/doc-ai-transport.js:87-124`) | 30 s per request (1 to 120 s bound) | status and result GETs only, up to 3, exponential delay; job create never retried | none |
| PostgreSQL pool (`pool.js`) | statement 30 s, lock 5 s, idle-in-tx 30 s, connect 10 s | serialization and deadlock retries x3 (`db.js`) | none |
| Circuit breaker | absent everywhere | | **not built**: with zero retries and live flags off there is nothing to open; revisit when a provider is enabled (needs owner approval to enable) |
| Outcome, latency and cost telemetry | absent | | built: gateway `onEvent` becomes `provider_call` events |

### (e) Fly deploy blockers (runbook `docs/runbooks/fly-deploy.md`, `fly.toml`, `Dockerfile`)

1. `Dockerfile:5` sets `NODE_ENV=production`. The new column-encryption module (E1) and app events require `DATA_ENCRYPTION_KEY_BASE64` in production; without it the server refuses to start. Owner must stage that secret (name only) or set `APP_EVENTS_ENABLED=false` for the first boot.
2. Migrations 017 and later are not applied on Supabase (jtbd F13). `npm run db:init` must run against Supabase after review; this run did not touch hosting.
3. `KNOWVIA_IDENTITY_TOKEN` and `IDENTITY_ISSUERS` secrets are still unset (F13).
4. The Fly API returned 503 on every deploy in October; the Dockerfile has never been built (runbook). Not retried here (no deploy allowed).
5. `fly.toml` health check sends `Host: knowvia-api.fly.dev`; fine. The check now skips the database-backed rate limiter by design.
6. One machine until E1c lands (filesystem volume). With `RATE_LIMIT_BACKEND=database`, `MODEL_BUDGET_BACKEND=database` and DB document bytes, `--ha` becomes possible; the scan worker and evidence claim guard are the remaining per-process items (duplicate work, not corruption).

### (f) Migration and distribution risks

- All new migrations are expand-only and re-runnable (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP TRIGGER IF EXISTS`); the runner applies any unapplied file by name, so 021 to 023 can land before or after E1's 018 to 020 (verified: runner iterates files, no contiguity check, `migrate.js:128-130`).
- The migration checksum guard means a merged file must never be edited after it is applied anywhere.
- Hardcoded migration lists in three tests and `schema-expectations.js` are the expected merge conflicts with E1.
- Data residency (ADR 0011 D8) is unchanged: events hold no personal data, but any move to real data needs the owner's residency decision.

## 2. Ranking (value / risk)

1. App events table with sealed payloads, request recorder, provider events, erasure on revocation (goal 1, high value, medium risk: new table, no change to existing rows). Built.
2. Database-backed spend ledger (a real cap that survives restarts; fixes a money control). Built, opt-in.
3. Database-backed rate limiter (multi-machine safety). Built, opt-in.
4. Two measured indexes. Built.
5. Gateway and Sarvam timeouts and retries: already correct. No change.
6. Circuit breaker, scan-worker claim, evidence-claim guard in DB: deferred (section 4).

## 3. Slices

| Slice | Status | Files |
| --- | --- | --- |
| S1 `app_events` migration, repository, recorder, request and provider hooks, revoke redaction | done, tests pass | `022_app_events.sql`, `app-event-repository.js`, `app-event-recorder.js`, `event-context.js`, `create-server.js`, `consent-repository.js` |
| S2 `rate_limit_buckets`, `model_budget_*`, shared limiter, ledger scope | done, tests pass | `023_runtime_limits.sql`, `runtime-limits-repository.js`, `shared-rate-limiter.js`, `live-coverage-runtime.js` |
| S3 indexes | done | `024_hot_path_indexes.sql` |
| S4 latency metrics as events | done (request duration, provider latency) | same as S1 |
| ADR 0014 | done | `docs/adr/0014-app-events-and-shared-runtime-limits.md` |

## 4. Deferred or needs the owner

- Owner: stage `DATA_ENCRYPTION_KEY_BASE64` as a Fly secret before any production boot; decide `RATE_LIMIT_BACKEND` and `MODEL_BUDGET_BACKEND` values for hosting; apply migrations to Supabase (deploy, not done); retention length (`APP_EVENTS_RETENTION_DAYS`, default 30) is a privacy decision to mark for legal review.
- Deferred, no owner approval needed: scan-worker claim (`FOR UPDATE SKIP LOCKED`), database-backed evidence idempotency claim, circuit breaker, indexes for the 34 unmeasured foreign keys, F5 per-household page cap, F6 per-grant `result_json` erasure, F14 identity revoke route, OCR provider (Sarvam) events (the Sarvam transport is not behind the gateway).
