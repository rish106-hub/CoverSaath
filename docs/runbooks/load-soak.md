# Runbook: load and soak plan for the upload, scan, OCR and structuring workflow

Scope: a plan, not a result. Nothing here has been run; no capacity or latency number exists. Decision record: [ADR 0022](../adr/0022-production-upload-scan-and-scale-path.md). Synthetic data only. Run against a **staging** Fly app and a **staging** database, never production data. The owner has approved paid runs; each stage below still states its spend ceiling, and a stage is not started without the previous stage's recorded numbers.

The existing HTTP script is `scripts/load/k6-50rps.js` (steady read traffic, no uploads). Stages L1 onward need an upload driver that does not exist yet: build it as `scripts/load/upload-soak.mjs` (Node, no new dependency, `fetch` + the synthetic PDF generator pattern from `tests/document-upload-api.test.mjs`).

## What to record every stage

Machine memory and CPU (`fly machine status`, `fly logs`), OOM kills, p50/p95/p99 per route, error codes by count, pending-document count over time, scan latency (upload `201` to `status: accepted`), `job_queue` stats, database connections in use, database size and egress, provider spend. Compare against the pass lines; if a line is missing, set it from the previous stage, write it down, and only then continue.

## Stages

| Stage | Question | Load | Providers | Spend ceiling | Pass when (set from L0, then fixed) |
| --- | --- | --- | --- | --- | --- |
| L0 Baseline | Does the image scan at all? | 1 upload at a time, 20 synthetic PDFs of 50 KB, 1 MB, 10 MB, 15 MB | none | 0 | every document reaches `accepted`; EICAR upload is `rejected`; `/api/v1/ready` ready; clamd resident memory and scan seconds per size recorded |
| L1 Upload concurrency | Where does memory go? | ramp 1, 2, 4, 8, 16, 32 concurrent uploads of 5 to 15 MB, 5 min each | none | 0 | no OOM; machine memory below 85 percent; `5xx` rate 0; `429`/`503` only with the documented codes |
| L2 Scan backlog | How fast does the backlog clear and does it survive a clamd stop? | 500 uploads in 5 min across 50 households (stay under `MAX_PENDING_DOCUMENTS_PER_HOUSEHOLD`), then `fly machine restart` of one machine mid-run | none | 0 | backlog clears; no document lost or duplicated in `document_uploads`; no document marked `clean` that was not scanned (query `scan_attempts`, audit events) |
| L3 Queue behaviour | Do claims, leases, retries and dead letters behave? | enqueue 10 000 no-op `load.noop` jobs through `JobQueueRepository.enqueue`, run 1, 2, 4 `npm run worker` processes with `WORKER_CONCURRENCY` 1 to 8; kill workers with SIGKILL mid-run | none | 0 | every job ends `succeeded` or `dead` exactly once per attempt fence; no job runs concurrently under two workers; expired leases are re-claimed within `WORKER_LEASE_MS` + `WORKER_POLL_MS` |
| L4 Paid pipeline | Does scan to OCR to structuring hold under parallel households? | 20 households x 2 documents (3 to 10 pages), full path, `SARVAM_OCR_MAX_CONCURRENT` and `LLM_MAX_CONCURRENT_CALLS` raised stepwise from 2 | Sarvam, Gemini (real) | set before the run: `ORCHESTRATION_PROJECT_BUDGET_USD` (the server refuses calls past it) and a page cap via `SARVAM_OCR_MAX_DOCUMENT_PAGES` | cost per document recorded from provider usage, within the budget cap; OCR and structuring terminal states reached for every document; no provider call without current consent (spot-check `audit_events`); revoking consent mid-run erases derived data |
| L5 Soak | Does it stay up? | L4 at 25 percent of its peak for 4 to 8 hours | as L4 | 2 x the L4 per-document cost x document count | flat memory (no leak slope), no growth in pending, dead-letter count 0, signature update seen in logs once |

## L3 detail: using the existing `job_queue`

`job_queue` is already built and hardened (migrations 034, 037, `JobQueueRepository`, `createJobWorker`) but has no handler. L3 proves the claim/lease/fence behaviour at volume before any real work depends on it:

1. Register a throw-away `load.noop` handler through the `handlers` option of `startWorker({ handlers })` in the driver script (do not add it to `jobHandlers` in `src/server/worker.js`). The handler sleeps a random 10 to 200 ms, fails 5 percent of attempts with `retryable: true`, and fails 1 percent with `retryable: false`.
2. Enqueue rows with identifier-only payloads and `dedupeKey`s; assert a second enqueue of the same key while queued is a no-op.
3. Run workers as separate processes against the staging database. Poll `queue.stats()` each second.
4. Kill a worker with SIGKILL while it holds jobs. Expected: those jobs return to `queued` (or `dead` if attempts are used up) after the lease expires, and no completion from the killed worker is accepted (the attempt number fences it).
5. Record claims per second per worker count and the database CPU while workers poll (`WORKER_POLL_MS`).

## Test data and clean-up

Synthetic PDFs only (the generator in the upload API test; EICAR only as a raw non-PDF file, which the upload route rejects before scanning, so use it directly against clamd as `tests/clamd-integration.test.mjs` does). Create households through the bootstrap token on staging, raise `MAX_ACTIVE_SESSIONS`, `MAX_ACTIVE_CASES` and `API_RATE_LIMIT_PER_MINUTE` on the staging app only, and end every run by revoking consent and deleting documents through the API so the erasure path is exercised, then reset the staging database. Never point this at production.

## Open items before L1

The upload driver script, an upload concurrency cap (ADR 0022 D6, so L1 measures the cap and not an OOM), and a staging Fly app with its own database. All need the owner's go-ahead.
