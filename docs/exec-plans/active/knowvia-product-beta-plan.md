# Knowvia product app — scoped build plan v2 (data platform, ₹300 AI budget, prompt contracts)

## Context

**Company North Star** (`README.md:6`): no family should have to understand its health insurance for the first time during a medical crisis.

**Product job:** a household uploads its policy PDF once. Knowvia turns it into a source-backed, per-parameter policy record. That record powers:
- the emergency card
- estimates
- procedure checks
- planned-care and emergency tracks

**Business job (new):** learn, privately and in aggregate, which problems customers face. The insight layer turns those signals into 3–4 ranked business scenarios ("next moves").

**Works today, fixtures only:** the backend in commit 095b1d9.
- 16 policy endpoints and 314 parameters across 12 sections.
- 287 tests and a fixture eval at 100%.
- Real Sarvam and Gemini clients exist.

**Gaps:**
- No live run yet. The user will supply keys after setup is complete.
- The UI never calls the breakdown endpoints.
- The server is localhost-locked.
- Jobs run in-process via `setImmediate` with an in-memory Map.
- Storage is SQLite (143 `prepare()` calls in 16 files) and local disk.
- Auth is a bootstrap token only.
- There is no tracking, insight layer, structured logging, E2E or load testing.
- 26 identical `* 2.*` Finder copies exist.

**Cost gap:** the current prompt layout cannot fit ₹300 at scale. Each of the 18 calls per policy (9 extractors + 9 blind verifiers, `pipeline/run-sections.js`) sends the whole pack. The per-section text sits in `system`, ahead of the pages (`agents/prompts.js:51-64`), so Gemini's prefix cache never hits.

## User decisions

| Topic | Decision |
|---|---|
| Surface | Product app first; marketing website deferred |
| Cloud | GCP asia-south1; the user's personal Google account owns the project. Never stored in the repo. |
| Analytics | PostHog installed through `npx -y @posthog/wizard@latest`, plus a first-party events table as source of truth |
| Scale | Stateless design plus measured load tests |
| Keys | Sarvam and Gemini keys arrive only after setup is complete. Every milestone before live smoke runs on fakes. |
| Gemini budget | **₹300 hard cap, Gemini only.** Sarvam gets its own user-set cap. GCP hosting runs on new-account credits, with a billing alert. |
| Gemini route | **Vertex AI in asia-south1** (`@ai-sdk/google-vertex`, service-account auth, no API key in env). Data stays in India and spend falls under the GCP budget. A free-tier AI Studio key never sees real PDFs. |
| Policy size | 20–40 pages |
| Prompts | Prompts are explicit contracts: assume the model knows nothing. Outputs are structured so each agent's output is the next agent's input. |

## Constraints

- **Task class S2.**
  - M0 writes `docs/exec-plans/active/knowvia-product-beta-intake.md` (CERT) and updates the stale `docs/iterations/LATEST.md`.
- **Branch:** new branch `claude/product-beta` off local `main` (095b1d9, not pushed). No commit or push without the user asking.
- **Model mapping** (the contract names GPT-5.6 tiers, which are unavailable):

  | Contract tier | Model used |
  |---|---|
  | Luna | haiku |
  | Terra | sonnet |
  | Sol | opus |

  The central integration agent is opus.
- **Lean:**
  - No Redis, Kafka, K8s, Temporal, ORM or BigQuery until a measured trigger.
  - Keep the vanilla JS + Vite UI and hand-written SQL.
- **Sarvam quota:** 10 requests/min, 10 pages per job, ₹0.5 per page.
  - A 40-page pack is 4 jobs, costing ₹20 and taking about 24 seconds of the rate limit.
  - Job throughput is quota-bound; the UI shows `queued` with a position.
- **Money is stored as integers:**
  - INR in paise (`*_paise`).
  - Model spend in micro-USD (`*_micro_usd`) plus the INR equivalent at a configured rate.
  - The REAL columns `budget_usd`, `spent_usd` and `cost_usd` migrate.
- **Out of scope:** website, WhatsApp, Gnani, Pine Labs, ask-the-policy chat and production launch. Launch stays gated on DPDP/IRDAI legal review, malware scanning and an operator rota.

## Part A — AI cost architecture (₹300 cap)

**Budget math** (the ₹ to USD rate is configurable; about ₹88 per USD, so ₹300 ≈ $3.40).

| Step | Today (uncached) | Plan |
|---|---|---|
| OCR | Sarvam on every page (₹15 for 30 pages) | Read the PDF text layer locally first. Sarvam only for scanned or low-quality pages. Reuse pages already in the public wording library. |
| Model calls | 18 × ~30k tokens ≈ 540k input tokens per policy | Shared prefix: fixed system rules, then the pages, then the section brief. 1 full read + 17 cache reads at 10% price. |
| Verifiers | 9 per policy | Only sections that have critical parameters. A deterministic check runs first. |
| Not-found params | Verbose objects | `{key, found:false}` only, to save output tokens. |
| Model choice | `LLM_MODEL` unset | Default is the cheapest Flash-Lite that is served on Vertex asia-south1 and passes the eval. Escalate to Flash only for critical parameters where extractor and verifier disagree. |
| Cache hits | 9 extractors fan out at once, so implicit cache mostly misses | Explicit `cachedContent` per job (short TTL, deleted on job end). If the provider does not expose it, run one warm call, then fan out. |
| Thinking | Not set | Set the thinking budget to 0 or minimal explicitly. Thinking tokens bill as output. |
| Metadata | — | The model emits only `items` and `open_questions`. Code fills `job_id`, `model`, `prompt_version`, `usage` and `next`. |

**Estimated cost per 30-page policy with 2.5 Flash-Lite pricing:**

| Item | Cost |
|---|---|
| Full input | ≈ $0.003 |
| Cached input | ≈ $0.005 |
| Output (~36k tokens) | ≈ $0.015 |
| **Total** | **≈ $0.025 ≈ ₹2.2** |

Before tuning, the same policy costs about ₹6. At ₹2.2, ₹300 covers about 100 policies after the eval reserve.

These figures are a **hypothesis** taken from third-party pricing pages.
- M0 re-prices every model from Google's official Vertex pricing page and confirms that each model is served in asia-south1.
- M8 measures real cost from the usage metadata: `cachedContentTokenCount`, thinking tokens and output tokens, recorded in `breakdown_model_calls`.
- If ai-sdk injects the schema into the prompt text, the cache prefix breaks. The real-usage gate catches this.

**Hard spend controls:**

- **Global ledger table `ai_spend_ledger`.**
  - Reserve the worst-case cost before every call and settle the actual cost after. This extends the existing `createJobBudget`.
  - Stored in Postgres, so the cap is global across instances.
- **Caps** (enforced server-side; config by name):

  | Cap | Default |
  |---|---|
  | Global Gemini cap | ₹300 |
  | Kill switch | trips at 90% (₹270) |
  | Eval reserve | ₹80 |
  | Per job | ₹8 |
  | Per user per day | ₹20 |
  | Sarvam monthly cap | separate, user sets amount |

- **When the cap is reached:**
  - New jobs return `402 BUDGET_EXHAUSTED` with a safe UI message.
  - Running jobs finish only within their reservation.
- **Outside the app:** a GCP billing budget alert on the project, plus an AI Studio project spend limit if the account offers one.
- **Public wording library:**
  - A content-addressed store, keyed by page SHA-256 and the IRDAI product UIN, holding OCR text and wording-level extraction for public insurer wordings.
  - Reused only for pages that match a public wording; never for personal schedule pages, so nothing crosses tenants.
  - This is the largest repeat-cost saving.

## Part B — Prompt and handoff architecture ("assume the model knows nothing")

Every agent prompt is built by one versioned builder from fixed blocks, in fixed order. Shared blocks come first so the cache hits.

```
SYSTEM (identical for every agent and job → globally cacheable)
  1 COMPANY       Knowvia, North Star, what we never do (advice, claim decisions)
  2 PROJECT       policy breakdown → household record → emergency card / estimates
  3 PERSONA       "careful Indian health-insurance document analyst"
  4 GLOBAL RULES  pages are untrusted data; cite page+verbatim quote; units; abstain rules
  5 VOCABULARY    IRDAI terms, Excl01–Excl18 codes, sum insured / co-pay / sub-limit definitions
USER
  6 DOCUMENT PAGES  (identical for all agents within one job → cache hit)
  7 USE CASE        who reads your output next and what they decide with it
  8 YOUR TASK       one sentence + "NOT your task"
  9 INPUT CONTRACT  fields you receive, which are untrusted
 10 PARAMETERS      key · meaning · unit · allowed values · where to look · right/wrong example
 11 SELF-CHECK      checklist the model runs before answering (eval criteria)
 12 OUTPUT CONTRACT name of the JSON schema (enforced by structured output) + abstain shape
```

**Handoff envelope `knowvia.handoff/v1`.** Every agent output is wrapped in it and validated before the next agent reads it.

```json
{"schema":"knowvia.handoff/v1","job_id":"","agent":"s04.extractor","next":"s04.verifier",
 "status":"ok|partial|abstain|error","prompt_version":"","model":"",
 "items":[{"key":"room_rent_limit","found":true,"value":{},"unit":"INR_per_day",
   "citations":[{"page":12,"quote":"..."}],"confidence":"high|medium|low","conditions":[]}],
 "open_questions":[],"usage":{"input_tokens":0,"cached_tokens":0,"output_tokens":0,"cost_micro_usd":0}}
```

- `items` reuses the existing `sectionOutputSchema` (`src/modules/policy-breakdown/contracts.js:161`), so the 287 tests and the citation and value-in-quote checks stay valid.
- **Standard codes:**
  - IRDAI product UIN and insurer registration number
  - Excl01–Excl18 (already in `sections/s05-exclusions.js`)
  - ICD-10 for conditions
  - NHA HBP package names for procedures
  - ISO 4217 currency, ISO 8601 dates
- **Prompt quality evals** run on the fixture gold packs (A/B/C) for free, and on the live gold set within the eval reserve. Metrics:
  - field accuracy
  - citation validity
  - abstention correctness
  - schema pass rate
  - tokens, cached share, ₹ per policy
- Any change to a prompt, model or schema re-runs the evals. A version bump is required.

## Part C — Data platform (Postgres, private by design, insight-ready)

One Cloud SQL Postgres 16. Schemas separate trust levels, so data moves inside one database with no extra copy pipeline.

| Schema | Holds | Privacy |
|---|---|---|
| `identity` | Phone, email, display names, DOB | Envelope-encrypted with Cloud KMS. The only place direct identifiers live. Other schemas use `subject_key` (HMAC-SHA256). |
| `app` | The current 42 OLTP tables: households, consent, policy records, parameters, jobs, audit | Tenant-scoped by `household_id`; no raw contact fields |
| `documents` | OCR page text and the document index (blobs in GCS with CMEK) | Encrypted. Retention 180 days by default, then purge (from `retention_records`). |
| `events` | `product_events`, partitioned monthly, BRIN index on `occurred_at` | Pseudonymous. Allowlisted properties only. Old partitions are dropped. |
| `analytics` | Redacted facts per subject and per policy | No names, DOB, policy numbers or document text. Values are bucketed. |
| `insights` | Aggregates and the scenario output | k-anonymity: any cohort under 10 subjects is suppressed |

**Redacted fact tables.** Each is written in the same transaction as the domain change (outbox pattern, already in place with `integration_outbox`) and is idempotent on `(source_id, derivation_version)`.

- **`analytics.policy_profile`**, one row per ready policy:
  - insurer and product (public), UIN
  - policy type (individual, floater, group, top-up)
  - sum-insured band
  - room-rent cap present and band
  - co-pay band
  - PED wait in months, specific-disease wait in months
  - restoration (yes/no)
  - city tier
  - household-size band, member age bands
- **`analytics.coverage_gap`**: `subject_key`, policy, `gap_code` (a closed taxonomy, e.g. `ROOM_RENT_CAP_BELOW_CITY_MEDIAN`, `PED_WAIT_ACTIVE`, `NO_RESTORATION`, `COPAY_SENIOR`), severity and section. Derived from the existing deterministic consumers (`consumers/estimate.js`, `procedure-check.js`, `policy-status.js`).
- **`analytics.customer_concern`**: what the user asked about.
  - Procedure category, estimate amount band, emergency-card use, review corrections.
  - Concerns are fixed-choice chips ("What worries you most?"), not free text, which keeps them private, deterministic and free of model cost.
- **`analytics.funnel_step`**: derived from `events.product_events`.

**Insight engine.** A nightly Cloud Scheduler job runs on the worker.

1. `REFRESH MATERIALIZED VIEW CONCURRENTLY`:
   - `insights.gap_prevalence` by insurer, product and city tier
   - `insights.concern_frequency_weekly`
   - `insights.funnel_daily`
2. Deterministic scenario rules are kept in a versioned table, `insights.scenario_rules`. They map signal thresholds to business scenarios. Starter set:
   - **Top-up / sum-insured upgrade demand:** a high share of members are under-insured against city procedure costs.
   - **Waiting-period navigator demand:** many PED or specific-disease waits are still active while users run procedure checks.
   - **Cashless / claim-assist desk demand:** emergency-card views and paid-first deadlines.
   - **Group-to-retail continuity demand:** group-policy users with no retail cover.
3. The output is `insights.scenario_snapshot`. Each scenario has evidence counts, trend, confidence and a suppression flag. A weekly brief goes to a protected `/api/v1/admin/insights` endpoint.
4. An optional weekly model summary reads aggregates only, never rows. It costs about ₹1 per run and stays off by default within the budget.

**DPDP Act 2023 / Rules 2025:**

- **Consent per purpose:** `service` and `product_insights` are separate. The existing `consent_grants.purpose` supports this.
  - Analytics facts are derived only with `product_insights` consent.
  - Aggregates use only k-anonymous cohorts.
- **Erasure:** delete the `identity` row, crypto-shred its key, then cascade-delete rows keyed by `subject_key` in `analytics` and `events`. Aggregates stay, because they are k-anonymous.
- **Children's data:** members under 18 are recorded with the adult operator's consent. This needs legal review.
- **Where data lives:**
  - asia-south1 for Postgres, GCS and Gemini on Vertex.
  - Sarvam is an Indian provider; confirm where it processes data in CERT.
  - PostHog has no India region, so it receives pseudonymous IDs and allowlisted properties only (EU cloud).
- **Beta insight scope:** about 100 beta policies under k=10 suppression would hide almost every insurer × product × city cohort. During the beta, scenario rules run on population-level, coarse-dimension aggregates (policy type, sum-insured band, gap code). Finer cuts unlock as the number of subjects grows.
- **Breach:** audit and access logs, plus a runbook.
- Legal text stays a placeholder until legal review.

**Scale path (measured triggers only):**
- Read replica for `insights` and `admin`.
- Datastream to BigQuery when analytics queries harm OLTP latency.
- PgBouncer / managed pooling sized as instances × pool size ≤ the connection limit.

## Part D — Platform (GCP asia-south1)

For the beta, Cloud Run's built-in HTTPS load balancing and autoscaling front the API.
- The global ALB, Cloud Armor and Cloud CDN together cost about ₹2k a month. They move to a launch milestone, triggered by measured abuse or latency need.
- Until then, abuse limits are enforced in Postgres:
  - per-IP and per-phone counters
  - Cloud Run max-instances as a hard ceiling

```
Browser ── Cloud Run knowvia-api (serves the Vite static build + API; stateless, autoscale, SIGTERM drain)
       ├─ Cloud SQL Postgres 16 (private IP, PITR backups)
       ├─ GCS (CMEK) ← browser upload via V4 signed resumable URL (replaces 22 MB base64 JSON)
       ├─ Cloud Tasks: ocr-queue (rate = Sarvam quota) · model-queue (max concurrent = budgeted)
       │     └─ Cloud Run knowvia-worker (idempotent steps, lease + resume)
       ├─ Cloud Scheduler → nightly insights refresh, retention purge
       ├─ Vertex AI Gemini (asia-south1) · Sarvam Doc AI
       ├─ Secret Manager · Cloud KMS · Identity Platform (phone OTP)
       └─ Cloud Logging / Trace / Error Reporting · PostHog (consent-gated, same-origin proxy)
Launch milestone (measured trigger): Global ALB + Cloud Armor + Cloud CDN in front.
```

## Milestones and agents

Dependency order:

```
M0 ─┬─ M1a Postgres 1:1 port ─ M1b schema split ─ M2 server ─ M3 jobs/spend ─┐
    ├─ UI track: M5-frontend on fakes (src/ui/**) ───────────────────────────┤
    ├─ QA track: fakes + Playwright happy path (tests/fakes, tests/e2e) ─────┤
    └─ AI track: M4 prompt contract v2 (agents/prompts.js, sections text) ───┴─ M5-auth ─ M6 ─ M7 ─ M8 ─ M9
```

- The UI, QA and AI tracks start right after M0. They use files disjoint from M1–M3, so the Postgres port runs with an end-to-end safety net.
- M4's `model-runner.js` changes wait until after M3, because M3 owns that file.
- The central agent (opus) integrates each step and runs its gate.
- Test suites grow every milestone.

**M0 — Baseline and CERT** (central; intake by haiku)
- Delete the 26 identical ` 2` copies, `tests/fixtures/policy-breakdown 2/` and `docs/exec-plans/active 2/`.
- Create the branch.
- Write the CERT intake. It covers:
  - the data classification table
  - budget caps
  - environment variable names
  - the dependency matrix
  - rollback
- **Repository map:** the connected repomap MCP for every map and impact gate.
  - CERT records which package backs it: the user named cyanheads/repo-map, and the earlier pin was `@sylphx/repomap@1.5.0`.
  - Never run a `setup` that edits global configuration.
- Re-price models from the official Vertex pricing page and confirm which are available in asia-south1.
- **Gate:** `npm run check` is green (287 tests and the build).

**M1a — Postgres 1:1 port** (data agent, sonnet high; opus review)
- **Owns:** `src/backend/database/**`, `src/backend/repositories/**`.
- Add an async DB adapter (`query`, `transaction`). Port the repositories one file at a time with tests green after each.
- Mechanical port only: same tables and the same logic.
- Type mapping:

  | SQLite | Postgres |
  |---|---|
  | text timestamps | `timestamptz` |
  | 0/1 integers | `boolean` |
  | `*_json` text | `jsonb` |
  | REAL money | integers |

- Tests run on `@electric-sql/pglite`. CI integration also runs against `postgres:16` in docker compose.
- **Gate:**
  - All 287+ tests are green on PGlite and on Postgres.
  - No `DatabaseSync` remains outside the dev path.

**M1b — Trust-level schema split** (data agent; opus review)
- Split into the `identity`, `app`, `documents`, `events`, `analytics` and `insights` schemas; new code in `src/modules/insights/**`.
- This is a logic change, not a port. Moving DOB into encrypted `identity` changes the inputs to the age co-pay and estimate consumers (`consumers/estimate.js`, `record-values.js`). Those consumers read through a decrypting accessor, covered by tests.
- Envelope encryption for identity. The KMS adapter uses a local key in dev.
- Analytics fact tables are written through the outbox.
- **Gate:**
  - The suite is green.
  - The erasure test cascades with no orphans.
  - Consumer outputs are unchanged on fixture packs A/B/C.

**M2 — Stateless server** (backend agent, sonnet)
- **Owns:** `src/server/**`, `src/shared/http/**`.
- `PORT`/`HOST` env vars; configurable allowed hosts and origins.
- SIGTERM drain.
- `/live` does not touch the DB; `/ready` does.
- Unknown errors return 500 with a safe body and a `request_id`.
- JSON logs in Cloud Logging format (own small logger, no dependency) and request IDs / `traceparent`.
- `Buffer[]` body reading.
- Throttled `last_seen_at`.
- Legacy demo state isolated.
- **Gate:** new tests pass; a two-instance run behind a proxy works.

**M3 — Jobs, storage and spend control** (jobs agent, sonnet)
- **Owns:** `src/modules/policy-breakdown/service.js`, `pipeline/**`, `agents/model-runner.js`, `src/modules/document-intake/*storage*`, `src/integrations/sarvam/**`.
- Job queue port: Cloud Tasks driver plus an in-process driver for dev. Lease and resume replace `markInterrupted` and the `running` Map.
- GCS signed-URL upload: `POST /documents/upload-url` → `POST /documents/{id}/complete`.
- Text-layer extraction before Sarvam, using `pdfjs-dist` (Apache-2.0) after a dependency review. A per-page quality score decides which pages go to OCR.
- `ai_spend_ledger` and `sarvam_spend_ledger`, with global caps, kill switch, and per-job and per-user caps.
- Public wording library (page hash + UIN).
- **Gate:**
  - Killing a worker mid-job resumes with no duplicate paid calls.
  - The cap test blocks the call that would exceed it.
  - Text-layer PDFs make zero Sarvam calls.

**M4 — Prompt contract v2 and evals** (AI agent, opus for design; sonnet for edits)
- **Owns:** `src/modules/policy-breakdown/agents/prompts.js`, `sections/*` text blocks, `contracts.js` (envelope), `scripts/eval-breakdown.mjs`.
- Implement the 12-block builder with cache-friendly order, the `knowvia.handoff/v1` envelope with its validator, the compact not-found shape, verifier gating and the Flash escalation cascade.
- Write `docs/ai/prompt-contract.md` and the AI design record required by the contract:
  - baseline
  - eval set
  - thresholds
  - kill switch
  - cost budget
- **Gate:**
  - Fixture eval stays at 100%, with citation validity at 100%.
  - The fake provider reports the cached prefix as identical across all calls in a job.
  - Estimated ₹ per policy is ≤ ₹3 at Flash-Lite prices.

**M5 — UI on the real flow + auth + cookies** (frontend agent and auth agent, sonnet, in parallel)
- **Frontend owns** `src/ui/**` and `index.html`.
  - The real journey: sign in → household → members → consent (service and insights shown separately) → upload → queued/progress → 12 sections → review → ready → emergency card, estimate, procedure check, and concern chips.
  - Every state is handled: loading, empty, validation, auth, network, partial, retry, queued, budget-exhausted.
- **Auth owns** `src/backend/services/auth*` and `src/server/routes/auth*`.
  - Identity Platform phone OTP, with the ID token verified using `jose` against Google JWKS.
  - A `__Host-knowvia_session` cookie: HttpOnly, Secure, `SameSite=Lax`, a Postgres-backed hashed token, rotation on login.
  - A `knowvia_csrf` double-submit token plus an Origin check.
  - OTP abuse limits.
  - The bootstrap token is kept for dev only.
- **Gate:**
  - Playwright runs the full journey against fake Sarvam and Gemini.
  - Auth negative tests pass.

**M6 — Tracking and insights** (tracking agent, sonnet)
- **Owns:** `src/modules/product-events/**`, the consent banner and `src/modules/insights/**` jobs.
- **PostHog wizard.** The user runs `npx -y @posthog/wizard@latest` interactively; it logs in and detects the framework.
  - Choose the EU region when asked.
  - Decline any global MCP or editor-config install.
  - If the wizard does not support vanilla Vite, install `posthog-js` by hand with the same settings.
  - Review the diff on a scratch commit before keeping it.
- The strict CSP in `src/shared/http/request.js` blocks PostHog. Route PostHog through a same-origin reverse proxy at `/ingest`, so `connect-src` stays `'self'`.
- After review, constrain the configuration:

  | Setting | Value |
  |---|---|
  | `opt_out_capturing_by_default` | `true` |
  | `autocapture` | `false` |
  | Session replay | off |
  | `persistence` | `memory` until consent |
  | `person_profiles` | `identified_only` |

  The wizard's code is untrusted until reviewed. The PostHog MCP it may offer goes in agent tooling, not the app.
- `POST /api/v1/events` takes a batch of up to 20 events. Each event has a schema; unknown names or properties are rejected.
- Server-side lifecycle events are written in the domain transaction.
- `posthog-node` forwards events only when `analytics=granted`.
- **Cookies:**
  - Essential: `__Host-knowvia_session`, `knowvia_csrf`, `knowvia_consent`.
  - `knowvia_aid` (13 months) is set only after consent.
  - First-touch `utm_*` values are stored on the first event.
- **Events** (`object_action` naming):

  | Area | Events |
  |---|---|
  | Landing | `landing_viewed` |
  | Sign-in | `signup_started`, `otp_requested`, `otp_verified` |
  | Setup | `household_created`, `member_added`, `consent_granted`, `consent_revoked` |
  | Upload | `document_upload_started`, `document_upload_completed`, `document_upload_failed` |
  | Breakdown | `breakdown_queued`, `breakdown_started`, `breakdown_completed`, `breakdown_failed` |
  | Review | `review_parameter_confirmed`, `policy_ready` |
  | Outputs | `emergency_card_viewed`, `estimate_requested`, `procedure_check_requested`, `concern_selected` |
  | Budget | `budget_exhausted_shown` |

- Nightly insights refresh, the scenario rules and the admin brief.
- **Gate:**
  - With consent denied, the network capture shows zero PostHog requests.
  - The funnel built from `product_events` matches the E2E run.
  - The scenario snapshot is produced from seeded synthetic cohorts, and k-suppression is verified.

**M7 — Test pyramid: stress, soak, chaos** (QA/perf agent, sonnet)
- **Owns:** `tests/e2e/**`, `tests/fakes/**`, `load/**`, `.github/workflows/**`.
- Contract tests come from `docs/api`.
- Playwright runs at 360, 768 and desktop widths with axe checks. Paths covered:
  - OCR fail
  - model timeout
  - partial section failure and resume
  - consent revoked
  - session expired
  - budget exhausted
- **k6 targets** (confirmed in M0), all against the fakes:

  | Scenario | Target |
  |---|---|
  | Reads | p95 < 300 ms at 200 RPS on 2 instances |
  | Writes | p95 < 500 ms at 50 RPS |
  | Error rate | < 0.1% |
  | Burst | 10× for 2 minutes; expect queued backpressure, not errors |

- **Soak:** 2 hours. RSS and heap growth stay under 5% after warm-up, checked by comparing heap snapshots (`--heapsnapshot-signal`). This is the measurable "0 memory leaks" proof.
- **Chaos:** Postgres, GCS, Sarvam and Gemini each go down in turn; the system must degrade safely and recover.
- **Gate:** every threshold passes; reports go in `docs/evidence/load/`.

**M8 — GCP staging and live smoke** (platform agent, sonnet; opus review)
- **Owns:** `infra/**` (OpenTofu), `Dockerfile`, `cloudbuild.yaml`.
- Stand up the Part D beta topology: no ALB, Armor or CDN.
  - One image runs as two services.
  - One least-privilege service account per service.
  - Budget alerts and uptime checks.
  - Alerts on p95, 5xx rate, queue age, DB connections and spend.
- Rollback: revision traffic split plus forward-only migrations.
- **Cost:** about ₹1–2k per month for the smallest config (Cloud SQL is most of it). New-account GCP credits cover the beta. The cost is recorded in CERT.
- **Then live smoke:**
  1. The user adds the Sarvam key to Secret Manager. The worker service account is granted Vertex AI User.
  2. One public wording runs through the pipeline.
  3. The live gold-set eval runs within the ₹80 reserve.
  4. Real ₹ per policy is measured from the ledger.
- **Gate:**
  - `tofu plan` is reviewed.
  - The staging smoke test passes.
  - The k6 re-run on staging passes.
  - A backup restore drill succeeds.
  - Spend matches the ledger.
  - Real usage metadata shows `cachedContentTokenCount` > 0 on every fan-out call and the thinking tokens are as configured.
  - Measured ₹ per policy is reported against the ₹300 cap.
  - No production apply without explicit user approval.

**M9 — Independent review and handoff** (review agent, opus)
- Run `/code-review high` and `/security-review` against this plan and the CERT record.
- Fix the findings, re-run the gates, re-map with repomap and update `LATEST.md`.
- The final report says READY, PARTIAL or BLOCKED.

## Dependencies to add (each needs a CERT record before install)

| Package | Use | Milestone |
|---|---|---|
| `pg` | Postgres | M1 |
| `@electric-sql/pglite` (dev) | Postgres in tests | M1 |
| `@google-cloud/kms` | Envelope encryption | M1b |
| `@ai-sdk/google-vertex` | Gemini on Vertex asia-south1; replaces the `@ai-sdk/google` key path for live runs | M3/M4 |
| `@google-cloud/storage` | Document storage | M3 |
| `@google-cloud/tasks` | Job queue | M3 |
| `pdfjs-dist` | Text-layer extraction | M3 |
| `jose` | ID token verification | M5 |
| Firebase Auth modular | Client OTP only | M5 |
| `posthog-js` (from the wizard) | Client analytics, consent-gated | M6 |
| `posthog-node` | Server-side forwarding | M6 |
| `@playwright/test` (dev) | Browser E2E | M7 |
| `@axe-core/playwright` (dev) | Accessibility checks | M7 |
| k6 (binary) | Load tests | M7 |
| OpenTofu (binary) | Infrastructure | M8 |

## User inputs, by milestone

| Milestone | Input |
|---|---|
| M6 | PostHog account (the wizard logs in interactively) |
| M8 | GCP project on the personal Google account, with billing and new-account credits; enable the Vertex AI API (Gemini needs no key, only the service account); the Sarvam key and its monthly cap; 3–5 real policy PDFs for the gold set |

## Verification (end to end)

1. `npm run check` is green: architecture, unit tests on PGlite, build.
2. Postgres integration tests pass.
3. `npm run test:e2e` passes: Playwright on fakes, with axe.
4. Fixture eval and live gold eval meet thresholds, and ₹ per policy is reported.
5. k6 load, burst, soak and chaos reports are saved.
6. Consent network capture shows no PostHog requests before consent.
7. Erasure cascade test passes.
8. Insight snapshot is produced from synthetic cohorts.
9. Full journey works on the Cloud Run staging environment.
10. Independent review is closed.
