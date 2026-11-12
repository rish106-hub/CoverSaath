# ADR 0014: Application events and shared runtime limits

Status: accepted for the prototype (synthetic data only). Retention and wording are a draft for legal review.

## Context

The API stored state changes in the `audit_events` hash chain but nothing about its own activity: requests, sign-ins, refusals, rate-limit hits, provider-call latency and cost. The request rate limiter and the model spend cap lived in process memory, so a second machine doubled both and a restart reset the spend cap. The owner asked to store every minute's scale of application data with encryption, and to make rate limiting and provider calls safe to scale.

## Decisions

**D1. `app_events` (migration 022).** Append-only table. Queryable metadata sits in plain columns: event name, time, route template, method, status, duration, provider, outcome, error code, and household, adult, case and grant ids. Everything else sits in `payload_enc`, an `enc1` envelope (AES-256-GCM, AAD `app_events.payload_enc.<row id>`, the format of ADR 0013 / `column-crypto.js`) that a CHECK constraint forces. Payload keys and values are restricted in code to short identifiers and numbers, so e-mail, tokens, document text and query text cannot be stored. The client address is stored only as a 16-hex keyed HMAC (key derived from the data key). Reason: aggregate analysis needs plain columns; anything that could identify content stays sealed or out.

**D2. No foreign keys on `app_events` ids.** Telemetry must not fail or be dropped because a referenced row is missing, and a path id is attributed only when the request succeeded. Erasure is by explicit delete (`eraseForHousehold`, `eraseForAdult`), consent revocation redacts the sealed payload of events carrying that grant id inside the revocation transaction, and `purgeExpired` enforces `APP_EVENTS_RETENTION_DAYS` (default 30, max 3650). A trigger allows an UPDATE only to null the payload and set `redacted_at`.

**D3. Off the request path.** `record()` is synchronous and never throws; a flush loop writes batches of up to 100 every 2 s. The buffer holds 2000 events (oldest dropped and counted), a failed batch is retried once then dropped and counted, and the server flushes before its own pool closes. Cost: a restart can lose the last 2 s of events; accepted for telemetry.

**D4. Shared limits (migration 023), opt-in.** `RATE_LIMIT_BACKEND=database` adds a fixed-window counter in `rate_limit_buckets` (one upsert per request except health probes, key is a keyed hash). The per-process limiter always runs first and is the fallback when the database fails, so an outage never blocks the API. `MODEL_BUDGET_BACKEND=database` keeps the project spend cap in `model_budget_scopes` with one row per reservation; reserve is a single guarded UPDATE, so concurrent machines cannot overspend, settle is idempotent, and spent money survives restarts. Amounts are stored as integer micro-USD, rounded up on reserve and on actual cost (never under-counts). Defaults stay `memory`, so nothing changes until the owner opts in.

**D5. Provider telemetry.** `createModelGateway` takes an optional `onEvent` and emits metadata only (task, outcome, latency, tokens, cost). A throwing listener is ignored.

**D6. Indexes (migration 024).** Only indexes backed by a measured EXPLAIN (see `docs/exec-plans/active/backend-ops.md`).

## Consequences

- With `NODE_ENV=production` the server needs `DATA_ENCRYPTION_KEY_BASE64` (events seal payloads), or `APP_EVENTS_ENABLED=false`. Startup fails closed otherwise.
- Hard to reverse: event rows once written (deleted only by retention or erasure). Everything else is a flag or an additive table; rollback is `APP_EVENTS_ENABLED=false`, `RATE_LIMIT_BACKEND=memory`, `MODEL_BUDGET_BACKEND=memory` and leaving the tables unused.
- Rate-limit and event traffic adds one database write per request when both are on. Not yet measured under load; no capacity claim is made.
- Retention length and the statement that events contain no personal data are for legal review. Route templates are derived from the path; unknown slugs pass through up to 8 segments and 120 characters.
- Not covered: the scan worker and evidence idempotency claim are still per process (duplicate work, and for evidence a second paid model call on another machine), and OCR provider calls are not yet events.

## Merge note with run E1 (ADR 0013)

E1 is merged into local main (PR #53). `src/backend/security/column-crypto.js` here is a verbatim copy so this branch ran standalone; on merge take main's file (this branch uses only `readDataEncryptionConfig`, `createColumnCrypto`, `sealJson`, `openJson`). One difference: the development key seed text said `coversaath`, which `tests/product-contract.test.mjs` forbids in `src`; this branch changed it to `cover-saath` (dev-only key), so main needs the same one-line fix. Migrations 018 to 020 are E1's, 021 is reserved for an E1 review fix, and this work uses 022 to 024.

## Addendum (run B1): shared limits on by default, evidence claim as a database lease

Status: accepted for the prototype. Supersedes D4's "opt-in" and the "Not covered" line about the evidence claim.

**D7. Defaults flip to the database.** `RATE_LIMIT_BACKEND`, `MODEL_BUDGET_BACKEND` and the new `EVIDENCE_CLAIM_BACKEND` default to `database`. `memory` is the explicit off switch, meant for tests and a throwaway local process, never for a deployment with more than one machine. A typo in any of the three fails startup. Behaviour when the database is unavailable (amended by D11): the request limiter fails closed; the model budget fails closed (no database, no reservation, no paid call); the evidence claim needs the database for the rest of the question anyway.

**D8. Evidence claim lease (migration 032, `evidence_claims`).** One row per in-flight question, keyed by a SHA-256 of (household, case, idempotency key) (the idempotency key is client text and is not stored; an HMAC with the document key is not used because that key is random per process in development and every machine must derive the same hash). Acquire is one `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`, so of any number of racing processes exactly one is granted a free or expired lease. The holder renews every third of the lease term (default 120 s) and releases in `finally`; release and renew match on a random owner token, so a process that was slow or paused cannot free or extend a lease another process now holds. A crashed holder stops renewing and the lease expires; the next `ask` takes it over, and an hourly sweep deletes expired rows. Expiry uses database time, so machine clock skew does not matter. The per-process set stays as the fast path and the only guard when the backend is `memory`.

Failure mode worth knowing: a holder paused longer than the lease term loses the claim, and a second process may run the same question. That costs a duplicate model call, never a duplicate answer, because `saveAnswer` is idempotent on the key. The in-flight cap (`MAX_IN_FLIGHT = 4`) stays per process on purpose: it protects one process's memory and concurrency, not money.

Data and erasure: the table holds a hash, a random token and times, no household content, and a row lives at most one lease term beyond the work. It is deleted on release, taken over or purged on expiry, so it needs no revocation path; nothing derived from a document is stored in it.

Rollback: set the three variables to `memory` (behaviour of D4 defaults). Migration 032 is additive and can stay unused.

Still per process after B1: the scan worker, the user-data write limiter (`user-data-service.js`), the PDF child processes, and the in-flight cap above.

## Addendum (O-F4, two machines in production)

**D9. Per-adult service limits are shared too.** The session-call and refresh limits (`auth-token-service.js`), user-data writes, sync reads and pushes, and person-record writes now use `createSharedWindowLimiter` (`src/backend/services/shared-window-limiter.js`). It counts in the existing `rate_limit_buckets` table (no migration): the per-process window runs first, then one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` per check, keyed by a truncated SHA-256 of a namespaced opaque key (adult id or refresh-token hash, never an address or household content). The window follows the service clock. A database failure fails closed (503, see D11); the call it guards needs the database anyway. `RATE_LIMIT_BACKEND=memory` keeps them per process. Rows are pruned by the existing hourly `purgeRequestWindows` sweep.

**D10. Run budget released on a ledger failure.** If the project ledger throws (database down), `createRunBudget` releases its per-run reservation and rethrows, so the model gateway never dispatches and the run cap is not leaked. The project cap itself still fails closed.

Rollback: revert the change; the table and the request limiter are unchanged. Not hard to reverse, so no new ADR. Still per process: the scan worker, the PDF child processes and the evidence in-flight cap (memory protection, not money).

**D11. Limiters fail closed.** If the shared counter errors, the request limiter (`shared-rate-limiter.js`) and the per-adult limiter (`shared-window-limiter.js`) refuse with 503 and tell `onFallback`; neither lets a call through on a per-process count alone. Health probes use `{ shared: false }` and are unaffected. The counters are single atomic upserts in plain transactions, with no session state and no session advisory locks, so they are safe behind the Supabase transaction-mode pooler (:6543). No migration was needed (tables from 023 and 032); 060 stays unused.
