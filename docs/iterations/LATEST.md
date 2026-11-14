# Latest iteration

State of `origin/main` at 36474bb (PR #125 merged), updated 2026-11-12 (first written 2026-11-11). Earlier iteration notes (blocks 1 to 5, S3 erasure, app data routes, Supabase) were replaced by this file; they remain in git history. Plan of record: `docs/exec-plans/active/complete.md`, run state `docs/exec-plans/active/complete-run-state.md`. Prototype, synthetic data only. **Not deployed**: Fly app `knowvia-api` is not running and no migration after the baseline has been applied to Supabase (runbook: [fly-deploy](../runbooks/fly-deploy.md)).

## Merged in this run

| PR | What | Where |
|---|---|---|
| #97 | IDA reference fetch and insurer detection for a holding | `src/backend/services/holding-product-service.js`, [ida-sync runbook](../runbooks/ida-sync.md) |
| #98 | Model gateway: provider routing, Anthropic adapter, redaction gate, `provider_calls` (056) | ADR 0030, `src/features/ai-analysis/` |
| #99 | Collate, conflicts and pipeline orchestration | `src/backend/services/holding-pipeline.js` |
| #96, #104 | Holdings, memory facts, conflicts, declarations, premium payments and dues (048-052) and their routes; a holding is created when OCR completes | ADR 0032, `src/server/routes/holding*-routes.js` |
| #102 | `memory_chunks` with pgvector, Voyage embeddings through the gateway, chat v1 threads, SSE turns and traces (053-054), procedure planning | ADR 0029, ADR 0031, [chat-and-memory runbook](../runbooks/chat-and-memory.md) |
| #105 | `network_hospitals` (055), sync job, `GET /api/v1/holdings/{id}/hospitals?pincode=` | [ida-sync runbook](../runbooks/ida-sync.md) |
| #106 | Consent-gated `analytics_outbox` (057) and PostHog drain in the worker | ADR 0033 |
| #108 | CI verify job uses a pinned pgvector PostgreSQL 17 image (merged) | [ci-gates](../runbooks/ci-gates.md) |
| #109 | Gitleaks allowlist for the secret-scan false positive (merged) | `.gitleaks.toml` |

Merged after that (#110 to #125, 2026-11-11 to 2026-11-12), all on main:

| PR | What | Where |
|---|---|---|
| #110, #112 | Wave D current-state docs; Wave E audit of the complete.md run | [audit](../audits/2026-11-13-complete-audit.md) |
| #111 | Holdings consent on PUT and pay routes, drain shutdown (S-D4) | `src/server/routes/holding-records-routes.js` |
| #113 | Hospital lookup filters by the holding's insurer (audit F3) | `src/server/routes/holding-hospitals-routes.js` |
| #114 | Current exact consent before chat and embed provider calls (audit F1, 058) | `src/backend/services/provider-consent.js` |
| #115 | Chat integrity: registry recipients, number check, owner-only facts, wording sources (audit F2, F5, F7) | [chat-and-memory runbook](../runbooks/chat-and-memory.md) |
| #116 | Shared per-adult limits in PostgreSQL, fail closed (ADR 0014 D9, D10) | `src/backend/services/shared-window-limiter.js` |
| #117 | Job worker runs inside the Fly container; prod journey test | `docker/entrypoint.sh`, `tests/prod-journey.test.mjs` |
| #118, #122, #125 | Main CI repairs after the merges above | CI |
| #119 | No-key chat funnel (deterministic wording search) and per-provider consent failover | `src/integrations/model-routing/` |
| #120 | Grounded XML prompt pack for every model purpose | `src/features/ai-analysis/prompt-pack.js` |
| #121 | Two-document holding: wording linked to a holding, chat cites the wording page (065) | `src/server/routes/holding-documents-routes.js` |
| #123 | Provider SDK adapters (OpenAI, DeepSeek, Kimi, Anthropic) and SDK upgrades | `src/integrations/` |
| #124 | README refresh | `README.md` |

How to run the P0 journey (two PDFs, one holding, facts, chat): [demo-journey runbook](../runbooks/demo-journey.md); not run against live providers.

Earlier in the same run (already on main): sessions and JWT (045, ADR 0027), sync change log (046, ADR 0028), person records (047, ADR 0026). Migrations now run 001 to 065 (057 analytics outbox, 058 chat turn consent grant, 065 holding documents; numbers 059 to 064 are not used); the schema is in [data.md](../architecture/data.md).

## Live run and target flow (2026-11-14)

First live run (real ClamAV and Sarvam OCR, stub FSS, synthetic PDFs): [audit](../audits/2026-11-14-live-run.md), [runbook](../runbooks/live-run.md). Found and fixed: the Sarvam layout tag `reference` failed OCR for every document. Chat on the product path: 47/80 correct, 19/20 expected-unknown questions answered anyway (trust is the top gap). Owner's target architecture and its map to code: [target flow](../architecture/target-flow-2026-11-14.md). Real-data rule change, PDF sanitising and the memory document need owner sign-off and ADRs.

## Feature flags

Every flag is off unless the value is exactly `true`.

| Flag | Gates |
|---|---|
| `HOLDINGS_ENABLED` | Holdings, declarations, premiums, dues, hospitals routes and the holdings worker jobs (parse, fetch reference, collate, detect insurer, `reference.import`) |
| `MEMORY_ENABLED` | Memory writes and retrieval, chat v1 threads and turns |
| `CHAT_MODEL_ENABLED` | The model wording step of a chat turn; without it chat answers from code and stored facts only |
| `ANALYTICS_ENABLED` | Analytics enqueue and drain; also needs `ANALYTICS_DISTINCT_ID_SALT`, `POSTHOG_API_KEY`, `POSTHOG_HOST` and an active analytics consent grant |
| `VOICE_AUDIO_RETAIN` | Keeps a voice note's audio document (ADR 0029); the transcript is stored either way, sealed |

Related and pre-existing: `REFERENCE_DATA_ENABLED` (reference import), `SARVAM_OCR_ENABLED`, `POLICY_EVIDENCE_ENABLED`, `POLICY_STRUCTURING_ENABLED`, `POLICY_FACTS_ENABLED`, `CHAT_ENABLED` (chat v0).

## Open gaps

- Chat procedure planning (`planProcedure`) is not wired to `network_hospitals`: a procedure answer does not list hospitals.
- Analytics events `voice_turn` and `hospital_search` are in the allowlist (`src/contracts/analytics-events.js`) but no code emits them.
- Analytics consent: no consent UI exists and the consent and notice wording is a draft. **FOR LEGAL REVIEW.**
- Retention for expired (not revoked) consent is an open owner decision (review F3): expiry blocks new use but does not erase derived data.
- Voice transcript storage, cross-border model calls (Anthropic, Voyage) and all consent, privacy and notice wording are drafts. **FOR LEGAL REVIEW.**
- Not verified against live providers or a hosted database: tests use local stubs and a local PostgreSQL 17 with pgvector.
- Migrations 048-065 are applied nowhere hosted; applying them to Supabase needs owner approval.
- Per-process limits still hold (rate limit, model budget): one Fly machine only.
- Not reviewed: docs and code of this run were built without independent review agents (owner standing order).

## Resume

1. `AI.md`, `AGENTS.md`, this file, then `docs/exec-plans/active/complete-run-state.md`.
2. Demo journey: [demo-journey runbook](../runbooks/demo-journey.md). Wave D remaining work: deploy (explicit owner "deploy now" per environment), secret sweep.
3. Checks before claiming done: `npm run check`, `npm run eval:safety`, `git diff --check`, `gitleaks git .`.
