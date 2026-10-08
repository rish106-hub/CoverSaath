# Knowvia product beta — CERT intake

**Date:** 2026-10-07
**Owner:** central integration agent (Claude Opus)
**Task class:** S2. The work covers production infrastructure, auth, a data migration, consent, analytics and sensitive AI.
**Plan:** [knowvia-product-beta-plan.md](knowvia-product-beta-plan.md)
**Branch:** `claude/product-beta`, cut from local `main` at 095b1d9. That commit is not yet pushed to origin.
**CERT state:** **CERT = READY for the M0 gate and the tracks that use fakes (M1a, UI, QA, AI).**
- **BLOCKED:** live provider work (M8) and cloud deploy. Both wait on user inputs, listed below.

## CERT-C: what we are building

| Field | Record |
|---|---|
| North Star | No family should have to understand its health insurance for the first time during a medical crisis (`README.md:6`). |
| Business outcome | A household uploads its policy once and gets a source-backed policy record. That record drives the emergency card, estimates and procedure checks. Separately, aggregated and redacted signals tell the business which customer problems lead to which next moves. |
| Primary user | The household operator, an adult managing family health cover, often while facing a planned expense. |
| In scope | <ul><li>Postgres data platform: identity, app, documents, events, analytics and insights schemas</li><li>A stateless server</li><li>Durable jobs on Cloud Tasks</li><li>GCS uploads</li><li>Spend caps</li><li>Prompt contract v2 and the handoff envelope</li><li>The UI on the real flow</li><li>Phone OTP auth with cookie sessions</li><li>First-party events plus PostHog</li><li>The insight engine</li><li>The test pyramid: unit, contract, E2E, load, soak, chaos</li><li>GCP staging</li></ul> |
| Non-goals | <ul><li>Marketing website (branch `knowvia-website`)</li><li>WhatsApp, Gnani, Pine Labs and email rails</li><li>Ask-the-policy chat</li><li>Production launch</li><li>Redis, Kafka, K8s, Temporal, ORM and BigQuery</li></ul> |
| Acceptance | Every milestone gate in the plan passes. The full journey runs on fakes in Playwright, and on staging with live providers. Gemini spend stays within ₹300. |
| Constraints | <ul><li>₹300 hard cap on Gemini.</li><li>Sarvam has a separate cap set by the user.</li><li>GCP runs on new-account credits.</li><li>Region is asia-south1.</li><li>Policies are 20–40 pages.</li><li>Sarvam limits: 10 requests/min and 10 pages per job.</li></ul> |
| Open decisions | <ul><li>Sarvam monthly cap amount</li><li>Gold-set PDFs</li><li>PostHog project</li><li>GCP project ID</li><li>DPDP/IRDAI legal review of consent text and of PostHog in the EU</li></ul> |

## CERT-E: environment evidence (2026-10-07)

- **Runtime:** Node v26.10.0 locally; `engines` is `>=22.12.0`. npm and npx are available. Package manager is npm with `package-lock.json`.
- **Baseline gate on `claude/product-beta`:** `npm run check` passed.
  - architecture check passed
  - 287 of 287 tests passed
  - the Vite build passed
- **Hygiene:**
  - Removed 26 untracked Finder copies (`* 2.*`), each verified byte-identical with `cmp`.
  - Removed 9 empty `* 2` directories.
- **Repository map:** repomap MCP (`npx -y @sylphx/repomap mcp`, from the user's Claude config).
  - 208 code files, 1,294 symbols, 1,813 call edges.
  - DB map: 42 tables, 83 foreign keys, 65 indexes.
  - The user also named cyanheads/repo-map. The connected server is `@sylphx/repomap`, and that is what the gates use. Never run `setup`.
- **Map findings that drive the design:**
  - SQLite uses `DatabaseSync`, with 143 `prepare()` call sites across 16 files.
  - Jobs run in-process via `setImmediate`, and the `running` Map lives in memory (`src/modules/policy-breakdown/service.js:87,92`).
  - `assertLocalRequest` locks requests to localhost (`src/shared/http/security.js:3-12`).
  - The listener is bound to `127.0.0.1:8787` (`src/server/server.js:7`).
  - The UI does not call any breakdown endpoint (`src/ui/api/v1-client.js`).
  - Each of the 18 model calls per policy carries the whole pack. The per-section system text sits before the pages, so no prefix cache can hit (`agents/prompts.js:51-64`).
- **Environment variable names** come from `.env.example`. Values are never printed.
  - Existing variables: DB path, bootstrap token, limits, `LLM_*`, `BREAKDOWN_*`, `SARVAM_*`, document storage and encryption key, and provider stubs.
  - New variables are added per milestone. Each must be added to `.env.example` in the same change.

## CERT-R: design and capability decisions

### Data classification

| Class | Examples | Prompts | Logs/traces | Analytics/PostHog |
|---|---|---|---|---|
| RESTRICTED | Phone, email, DOB, policy number, raw PDF, OCR text | OCR text only, to Vertex in asia-south1, with `share` consent | Never | Never |
| CONFIDENTIAL | Policy parameters, household members, estimates | Only the minimum excerpt needed | IDs only | Bucketed and redacted facts only, with `product_insights` consent |
| INTERNAL | Job status, costs, token counts | n/a | Yes | Aggregates |
| PUBLIC | Insurer and product names, UIN, public wording text | Yes | Yes | Yes |

### AI design record (summary; the full record goes in `docs/ai/prompt-contract.md` at M4)

- **Baseline and economic gate:** the alternative to AI is a human reading a 30-page wording, about 60–90 minutes per policy. The AI path targets ≤ ₹3 per policy plus human review of critical parameters only.
- **Risk:** Sensitive. The model extracts and proposes only. Deterministic code checks citations, verifies values appear in the quote, and applies the readiness gate. A human confirms every critical parameter.
- **Model and route:** Gemini on Vertex AI in asia-south1. The cheapest Flash-Lite that passes the eval is the default. Flash is used only when the extractor and verifier disagree on a critical parameter.
  - Model prices are re-checked against the GCP billing SKU list once the project exists.
  - The third-party prices used in the plan are a hypothesis.
- **Budgets:**

  | Budget | Amount |
  |---|---|
  | Global hard cap | ₹300 |
  | Kill switch | at ₹270 |
  | Eval reserve | ₹80 |
  | Per job | ₹8 |
  | Per user per day | ₹20 |

  Spend is reserved before each call and settled afterwards in Postgres (`ai_spend_ledger`).
- **Kill switch:** two separate controls.
  - Setting `BREAKDOWN_AI_ENABLED=false` turns the AI path off.
  - The ledger auto-trips when spend reaches the cap.
- **Evaluation:**
  - Fixture packs A, B and C must score 100% with 100% citation validity.
  - A live gold set (3–5 user PDFs) runs within the eval reserve.
  - Any change to the prompt, model or schema requires a version bump and a re-run.

### Capability matrix

| Capability | Need | Decision | Verify at |
|---|---|---|---|
| `pg` | Postgres client | REQUIRED (M1a) | adapter tests and Postgres integration |
| `@electric-sql/pglite` (dev) | Fast tests with the same SQL dialect, no Docker | REQUIRED (M1a) | full suite on PGlite |
| `@google-cloud/kms` | Envelope encryption for `identity` | REQUIRED (M1b) | local-key adapter in dev, KMS on staging |
| `@ai-sdk/google-vertex` | Gemini on Vertex asia-south1 | REQUIRED (M3/M4) | fake runner in tests, live smoke at M8 |
| `@google-cloud/storage` | Signed resumable uploads | REQUIRED (M3) | fake GCS in tests, staging smoke |
| `@google-cloud/tasks` | Durable job queue with rate limits | REQUIRED (M3) | in-process driver in tests, staging |
| `pdfjs-dist` | Read the PDF text layer before Sarvam | REQUIRED (M3) after licence review (Apache-2.0) | zero Sarvam calls on text-layer packs |
| `jose` | Verify Identity Platform ID tokens | REQUIRED (M5) | negative auth tests |
| Firebase Auth modular | Client side of phone OTP | REQUIRED (M5) | staging only; the E2E suite uses a fake OTP |
| `posthog-js` / `posthog-node` | Funnels, gated on consent | REQUIRED (M6). The user runs the wizard and its output is reviewed. | network capture with consent denied |
| `@playwright/test` and `@axe-core/playwright` (dev) | Browser E2E and accessibility checks | REQUIRED (UI/QA tracks) | `npm run test:e2e` |
| k6 (binary) | Load, burst and soak tests | REQUIRED (M7) | reports in `docs/evidence/load/` |
| OpenTofu (binary) | Infrastructure as code | REQUIRED (M8) | `tofu validate` and plan review |
| Redis, Kafka, K8s, Temporal, ORM, BigQuery | — | NOT_APPLICABLE until a measured trigger | — |

### Agent assignments

All agents are Claude models. The contract's GPT-5.6 tiers are unavailable, so this mapping is the recorded fallback:

| Contract tier | Claude model |
|---|---|
| Luna | haiku |
| Terra | sonnet |
| Sol | opus |

| Agent | Scope (exclusive files) | Model |
|---|---|---|
| Central / integration | Plan, docs, gates, merges | opus |
| Data (M1a/M1b) | `src/backend/database/**`, `src/backend/repositories/**`, plus the direct callers needed for async | sonnet, with opus review |
| UI track | `src/ui/**`, `index.html` | sonnet |
| QA track | `tests/fakes/**`, `tests/e2e/**`, `playwright.config.*` | sonnet |
| AI track (M4) | `src/modules/policy-breakdown/agents/prompts.js`, `contracts.js` (envelope only), `docs/ai/**` | opus |
| Server (M2) | `src/server/**`, `src/shared/http/**` | sonnet |
| Jobs (M3) | `service.js`, `pipeline/**`, `model-runner.js`, storage, `src/integrations/sarvam/**` | sonnet |
| Review (M9) | Read-only | opus |

### Workload targets for M7 (hypothesis; confirm when staging exists)

| Measure | Target |
|---|---|
| API reads | p95 < 300 ms at 200 RPS on 2 instances |
| API writes | p95 < 500 ms at 50 RPS |
| Error rate | < 0.1% |
| Burst | 10× load for 2 minutes, absorbed as `queued`, not errors |
| Soak | 2 hours, RSS/heap growth < 5% after warm-up |
| Breakdown throughput | Bound by Sarvam quota: about 2.5 scanned 40-page packs per minute globally. Text-layer packs are bound only by the model queue. |

## CERT-T: readiness

| Item | Result |
|---|---|
| Map exists and the task query succeeds | PASS |
| Requirements and non-goals are explicit | PASS |
| Class and plan are recorded | PASS (S2) |
| Design is coherent | PASS for the tracks that use fakes. Live and cloud work is BLOCKED on user inputs. |
| Baseline gate | PASS (287/287 tests and the build) |
| Dependencies | Installed per milestone. Each is version-pinned through the lockfile, then the gate is re-run. |
| Rollback | Every milestone is a separate change set on `claude/product-beta`. The SQLite path stays available until M1a passes its gate. Migrations only move forward. |

## Rollback

- **Code:** revert the milestone's change set on `claude/product-beta`. `main` stays untouched until the user approves a merge.
- **Data:** only dev data exists today. On staging, every migration is forward-only, with point-in-time-recovery backups and a restore drill at M8.
- **Cloud:** traffic is split between Cloud Run revisions, so rollback means moving traffic back. Each provider has its own kill switch: AI, Sarvam, PostHog and uploads.

## User inputs pending

1. **M6:** the PostHog account. The user runs `npx -y @posthog/wizard@latest`, chooses the EU region and declines any global MCP or editor-config install.
2. **M8:** the following, in this order:
   - A GCP project on the user's personal account, with billing and new-account credits.
   - The Vertex AI API enabled.
   - The Sarvam key added to Secret Manager.
   - The Sarvam monthly cap.
   - 3–5 real policy PDFs for the gold set.
