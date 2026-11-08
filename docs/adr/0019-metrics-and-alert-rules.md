# ADR 0019: Metrics registry and alert rules

Status: accepted for the prototype (synthetic data only). Builds on ADR 0016.

## Context

M1 gave logs and error reports. There was no way to see latency percentiles, 5xx rate, privacy-gate refusals, model spend, queue depth or pool saturation, and no alert rules. A metrics endpoint is another disclosure channel, so it must carry no personal data and not be public.

## Decisions

**D1. No new dependency.** A small in-process registry (`src/shared/metrics/`): counters, gauges and fixed-bucket histograms rendered as Prometheus text. `prom-client` was not added: the need is six metric families and no measured need for its extras (process collectors, summaries). Revisit if OpenTelemetry metrics are adopted.

**D2. Low cardinality by construction.** Metric and label names are fixed at registration. Each label value must pass a closed-set or narrow-pattern validator, a conservative character set, and be unchanged by the ADR 0016 log scrubber; anything else becomes `other`. Labels are route templates (the closed set of known route words), status classes, HTTP methods, task and outcome words and privacy-gate codes. Each metric holds at most 500 label combinations; extra samples are dropped and counted in `metrics_series_dropped_total`. No id, name, document, prompt, header, query or error message can be passed.

**D3. Protected scrape route.** `GET /api/v1/metrics` requires the existing bootstrap bearer (`requireBootstrap`), runs behind the Host/Origin guard and the rate limiter, and answers 503 when no bootstrap token is configured. No new credential. A separate read-only ops token is a later option if the scraper should not hold the bootstrap secret.

**D4. Scrape-time gauges.** Pool saturation, document work queue depth and budget use are read when scraped (budget from the database ledger when `MODEL_BUDGET_BACKEND=database`, so it is cluster-wide). A collector that fails or exceeds 2 s is skipped.

**D5. Alert rules** are Prometheus-style YAML in `ops/alerts.rules.yml` (5xx above 2%, budget above 80%, refusal spike, pool above 80%), explained in `docs/runbooks/alerts.md`. p50/p95 are recording rules over the histogram. A test checks the rules only use exported metrics. No Grafana, scraper or Fly change is made here.

## Consequences

- Counters are per process and reset on restart; the scraper adds `instance`.
- Rollback: revert the change. Nothing is stored; the route is new.
- Not covered: KMS error alert (KMS not built); chunk-level gate refusals inside a successful structuring run (see runbook); provider-side connection counts.
