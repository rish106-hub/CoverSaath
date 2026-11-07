# Runbook: metrics and alerts

Decision record: ADR 0017. Synthetic data only. Rules live in `ops/alerts.rules.yml`; this page explains them. Thresholds are first guesses with no measured traffic behind them (no capacity numbers exist): tune after the first hosted week.

## Metrics endpoint

`GET /api/v1/metrics` returns Prometheus text. It needs `Authorization: Bearer <KNOWVIA_BOOTSTRAP_TOKEN>` (the existing server-to-server credential), passes the same Host/Origin guard and rate limiter as every route, and answers 401 without the token and 503 when no token is configured. It is not a public status page. Store the token in the scraper's secret store, never in a dashboard or a repository. Counters are per process (one series set per machine); the scraper adds `instance`.

| Metric | Type | Labels | Notes |
| --- | --- | --- | --- |
| `http_requests_total` | counter | `method`, `route`, `status_class` | `route` is the logged route template (ids `:id`, unknown words `:x`). `status_class` is `2xx` to `5xx`, `aborted` (client left) or `other`. |
| `http_request_duration_seconds` | histogram | `route` | p50 and p95 come from `histogram_quantile` (recording rules `coversaath:http_request_duration_seconds:p50` and `:p95`). Aborted requests are not timed. |
| `model_calls_total` | counter | `task`, `outcome` | Outcome `ok`, `budget_refused`, a lower-case error code, or `other`. |
| `model_call_duration_seconds` | histogram | `task` | |
| `model_cost_micro_usd_total` | counter | none | Spend in millionths of a dollar. |
| `model_budget_used_ratio`, `model_budget_max_usd` | gauge | none | Read at scrape time from the project budget (database ledger when `MODEL_BUDGET_BACKEND=database`, so it is cluster-wide). Absent until `ORCHESTRATION_PROJECT_BUDGET_USD` is set. |
| `privacy_gate_refusals_total` | counter | `code` | Closed set of gate codes (`restricted_evidence`, `privacy_gate_malformed`, ...), counted where a refusal reaches an HTTP error or a failed structuring job. |
| `document_work_queue_depth` | gauge | none | Documents waiting for a malware scan or byte deletion (the database row is the queue). |
| `db_pool_connections`, `db_pool_waiting_clients`, `db_pool_max_connections`, `db_pool_utilisation_ratio` | gauge | `state` (`in_use`, `idle`) on the first | Pool of this process. |
| `metrics_series_dropped_total` | counter | `metric` | Non-zero means a label tried to exceed the series cap (500 per metric). Treat as a bug. |

Rules for new metrics: register in `src/shared/metrics/server-metrics.js`; labels are route templates, status classes or closed-set words; never an id, name, document, prompt, error message or any request text. A label value that is not allowed, or that the log scrubber would change, is recorded as `other`. Re-run `node --test tests/metrics.test.mjs`.

## Alerts

### CoverSaathHigh5xxRate
More than 2% of requests are 5xx for 5 minutes (and more than 3 requests per minute). Find the failing route: `sum by (route) (rate(http_requests_total{status_class="5xx"}[5m]))`. Take a `requestId` from a failing response and follow it in the logs and Sentry (see `observability.md`). Common causes: database unavailable (`DATABASE_UNAVAILABLE`), a bad deploy (roll back per `fly-deploy.md`), a provider outage.

### CoverSaathModelBudgetHigh
Reserved plus spent model budget is above 80% of the project cap. Check `model_calls_total` and `model_cost_micro_usd_total` for the task that grew. The cap is a hard stop (`budget_refused`), so at 100% live model work fails closed. Raising the cap is a paid-service change: ask the owner first.

### CoverSaathPrivacyRefusalSpike
Gate refusals rose at least threefold over the 6-hour baseline, minimum 10 in 15 minutes. Either a new document shape is tripping the gate (inspect the `code` split) or something is sending restricted evidence. Never loosen the gate to quiet the alert: fail-closed is the intended behaviour. Read the refusal count by code, then the matching `policy_structuring_failed` or `http_request` log lines (codes only, no content).

### CoverSaathDbConnectionsHigh
Connections in use above 80% of the pool (default 10) on one machine for 5 minutes. Check `db_pool_waiting_clients` and slow routes (`coversaath:http_request_duration_seconds:p95`). Raise the pool only if the database pooler has room; the provider-side connection count is not measured here.

## Known gaps

- Chunk-level gate refusals inside a structuring run that still succeeds are stored in the run's coverage counts, not in this counter; only refusals that fail a request or a job are counted. A follow-up would add a callback from `gateChunks`.
- The KMS error alert in the plan waits for KMS (not built). No latency or error SLO is defined; no capacity numbers exist.
- Counters reset when a machine restarts; PromQL `rate` and `increase` handle that. Gauges of the budget and queue are read at scrape, so a database outage drops them from the scrape rather than reporting zero.
- No log shipping, Grafana or OpenTelemetry is set up here; the owner chooses the scraper (for example Grafana Agent on Fly) and stores the bearer secret there.

## Rollback

Revert the M2 change: the route disappears, nothing else depends on it (`/api/v1/metrics` is new). Metrics live in memory only; there is no data to migrate or erase.
