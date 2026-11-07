# Runbook: logs and error reporting

Decision record: ADR 0016. Synthetic data only. Retention and consent wording are drafts for legal review.

## What is logged

JSON, one object per line on standard output: `time`, `level`, `service`, `event`, then metadata. Never a request or response body, header, document, OCR text, prompt, model output or error message.

| Event | Fields |
| --- | --- |
| `http_request` | `requestId`, `method`, `route` (known route words; ids `:id`, anything else `:x`), `status`, `durationMs`, `errorCode`, `aborted` (client left; no status) |
| `request_failed` | `requestId`, `errorType`, `errorCode`, `status`, `frames` (5xx only; repo-relative V8 frames) |
| `startup_failed` | `errorType`, `errorCode`, `setting` (for "Invalid NAME.") |
| `audit_event` | `action`, `resourceType`, `resourceId`, `actorType`, `householdId`, `caseId` |
| `provider_call` | `provider`, `task`, `outcome`, `errorCode`, `latencyMs`, `inputTokens`, `outputTokens`, `costMicroUsd` |
| operational | `server_listening`, `rate_limit_store_unavailable`, `app_event_write_failed`, `document_*`, `pdf_inspection_*`, `policy_structuring_failed` |

Latency percentiles, 5xx rate, gate refusals, spend, queue depth and pool saturation are metrics, not log fields: see `alerts.md` (ADR 0019). No percentile is computed in the process; the scraper derives p50/p95 from the histogram.

## Configuration

| Variable | Effect |
| --- | --- |
| `LOG_LEVEL` | `fatal`, `error`, `warn`, `info` (default), `debug`, `trace`, `silent`. Anything else stops startup. |
| `SENTRY_DSN` | `https://<key>@<host>/<project>`. Unset = error reporting off, SDK not loaded. Treat as a secret (`fly secrets set`), never in `fly.toml`. A malformed value stops startup with `SENTRY_DSN_INVALID`. |
| `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` | Optional labels (letters, digits, `_ . : -`). |

A Sentry project is created by the owner, not by this repository. Only 500s and 5xx without an application code are reported; an expected 503 (provider not configured, database unavailable) is logged only. Event messages are removed unless they are a trusted code, so look up the exact code in the log line with the same `requestId`.

## Finding one failed request

Take `X-Request-Id` from the response (or from the client's error report), then filter the log on that `requestId`: the `http_request` line gives route, status and duration; the `request_failed` line gives the error class, code and top frames. The same id is the `requestId` tag on the Sentry event. The error message is deliberately absent: reproduce with the code and frames.

## Rules for new code

- Use `logger.info/warn/error(eventName, fields)` with a fixed lower_snake event name; only the scalar keys listed in `FIELD_SHAPES` (`src/shared/logging/logger.js`) are kept, others are dropped and counted in `droppedFields` (add a key there, with a narrow shape, if you need one); or `logger.request/failure/audit/provider`. Do not log `error.message`, `req.body`, a header, a URL with a query string, a document or a model output.
- A new API route word goes into `KNOWN_ROUTE_SEGMENTS` (`src/server/http/event-context.js`); a test fails until it does.
- Do not add `console.*` under `src/`. Scripts under `scripts/` that print to a terminal are separate.
- A new provider or background path passes its events to `logger.provider` or `logger.warn` with codes and counts.
- Re-run `node --test tests/logging-leak.test.mjs` after touching `src/shared/logging/`.

## Retention

Draft: keep application logs 30 days, then delete. The host (Fly) holds stdout only briefly; if a log sink is added, configure 30-day expiry and mark it for legal review. Do not ship logs to a third party before that review.

## Checks

- Sentry off: start with `SENTRY_DSN` unset; no network calls to Sentry, `initSentry().enabled === false`.
- Sentry on (staging only, with a project the owner created): trigger a 5xx; the event should show the error code and frames but `[message removed]`, no user, no request data, no breadcrumbs.
