# complete.md — CoverSaath end-to-end MVP (personal AI insurance tool)

Plan author: Fable (planning only). Builders: Sonnet 5.5 medium. Grunt: Haiku 5.5. Architecture-complex slices, top-down audit, extreme-case review: Opus 5.5 medium. Fable touches nothing after approval.

On approval, step 0 copies this file verbatim to `CoverSaath/docs/exec-plans/active/complete.md` (the only new doc; every other plan doc is deleted or moved per section 1).

---

## 0. Context

**Problem.** Four repos (backend `CoverSaath`, app `Knowvia Frontend`, landing+BFF `Knowvia_website`, reference corpus `insurance-data-api`) each work in isolation. No single journey runs end to end: upload → insurer/policy confirmation → parallel parse (own PDF + insurer reference docs) → conflict review with the user → persistent per-household memory → chat that answers "my surgery is next month, what does my policy cover" → network-hospital lookup.

**Outcome.** One working journey, synthetic data, deployed (Fly backend, Vercel app), with every scale seam marked `SCALE:` in code and in this doc. Security controls that already exist stay on; nothing new blocks the MVP except two non-negotiables: **no secret leaks** and **no personal data reaches any model provider** (redaction gate on every provider call).

**Hard facts the plan is built on (verified in repo state 2026-11-11).**
- Backend: Node 25 ESM, one process, Postgres 17 / Supabase (ADR 0011), Fly app `knowvia-api` (Sydney) running, session-pooler URL. Migrations 001-044 on `main` (`4be1436`); 045 (`feat/auth-jwt`), 046 (`feat/sync-log`), 047 (`feat/person-records`) built, unreviewed, unpushed.
- Existing blocks reused, not rebuilt: `src/features/input` (validate, scan, OCR via Sarvam), `policy-structuring` (jobs, Gemini adapter, currently HTTP 402 no credits), `policy-evidence` (clause retrieval), `insurance-rules` + `household-reasoning` (deterministic), `ai-analysis` (privacy gate, budget), `decision-catalogue`, `coverage-analysis`, `src/integrations/provider-boundary.js`, `job_queue` (mig 037), `reference_cache` (ADR 0021, IDA import-only), `auth-token-repository` (web sessions, mig 039), encryption at rest (`DOCUMENT_ENCRYPTION_KEY_BASE64`, E1 run).
- App: `Knowvia Frontend` Next 16.4.3 / React 19.3 / zod 4, Vercel, beta flow committed (`c6fb79f`), Playwright + Vitest present.
- BFF today: `Knowvia_website` (Next 16.4.3 + `pg`, branch `feat/policy-profile-bff` = proxy routes to backend, waitlist, HSTS, Dockerfile).
- `CoverSaath frontend`: bare Next 16 skeleton + `PRODUCT.md`, `BUILD-SPEC.md`, `RESEARCH.md`, `design/`. Design source, no code worth keeping.
- IDA: Fastify 5 + pg, branch `feat/real-ingest-slice`; has `registry:import`, `register:product`, `pages:load`, `review:cli`, `ingest:local`, `worker`, `FactExtractor` interface (stub + off-by-default Gemini), `source_pages` with `tables_json` (mig 018), docs on "export shape and CoverSaath gap". `ida-private/` = local corpus/models/results, gitignored, never pushed.
- Rules in force: synthetic data only; migrations append-only; no commit/push/merge/deploy unless asked; user merges PRs; no review agents launched by assistant (report "not reviewed") — **overridden by this plan only where section 5 explicitly schedules an Opus audit, which the user has now requested**.
- Blockers owned by user (unchanged): Supabase password rotation (still weak, in Fly secret + `.env.local`), Gemini credits (402), legal review of consent/notice wording, PostHog project key, any paid provider keys (DeepSeek/Kimi/OpenAI/Anthropic).

**Honest timeline.** Everything below is scoped as waves. Wave A+B (vertical slice working on localhost with stub model) is the EOD-today target. Waves C-E land across days 2-3. Anything that needs a paid key or a legal sign-off is built behind a flag and shipped off.

---

## 1. Step 0 — repo hygiene (Haiku, first, 1 agent, ~30 min)

Delete, do not archive. Criterion: a doc is deleted when (a) its work is merged on `main` or abandoned, or (b) it describes infra no longer used, or (c) it is superseded by this file. Each deletion lands in one commit `chore(docs): delete completed and superseded plans` on branch `chore/docs-purge`, PR opened, user merges.

**CoverSaath — delete**
- `docs/exec-plans/active/`: `block-2-closeout-audit.md`, `block-2-closeout.xml`, `block-2-sarvam-document-ai.md`, `block-3-acceptance.md`, `block4-acceptance.md`, `block4-household-reasoning.xml`, `block5-decisions.md`, `block5-frontend-audit.md`, `block5-merge-and-commit-plan.xml`, `codeql-alert-remediation.md` (alert dismissal is a UI click, tracked in section 7), `demo-ui.md`, `direction-change.md` (pivot done 2026-10-20, ADR 0008 records it), `evidence-facts-erasure.md`, `handoff-codex.md`, `p1b-handoff.md`, `p1b-postgres.md`, `p1b-s32-async-runtime.md`, `policy-document-structuring.xml`, `policy-structuring-hardening.xml`, `production-hardening.xml`, `retrieval-hardening.xml`, `sarvam-gemini-parse-validation.xml`.
- `docs/exec-plans/completed/` — whole directory (git history keeps it).
- `docs/runbooks/azure-staging.md` (Fly is the target, ADR 0011).
- `docs/runbooks/curated-sources.md` — delete only if `grep -r curated-sources docs src` returns nothing else; otherwise keep.
- `docs/research/2026-10-20-source-data-catalogue-reviewer-access.md` — fold the one decision it holds into ADR 0021 footnote, then delete.
- Root clutter (untracked, gitignored or not): `idap.md`, `idap-archive.md`, `skl.md`, `.jtbd-archive/` — delete locally (not in git, no commit). `jtbd.md` + `jtbd-prompts.md` stay (local handover) but section 0 gets a one-line pointer to `complete.md`.
- `.env.local.bak-pre-pooler` — delete after password rotation (user step), not before.

**CoverSaath — keep**: `AI.md`, `AGENTS.md`, `docs/adr/*`, `docs/architecture/*`, `docs/runbooks/{fly-deploy,local-postgres,clamav,policy-structuring}.md`, `docs/iterations/LATEST.md`, `docs/agent-tooling.md`, `docs/exec-plans/active/{app-data-plan.md,user-data-store-spec.md}` (both get merged into section 3 of this file, then deleted in Wave B once their tables exist).

**Worktrees — prune** (`git worktree remove`, branches kept): every `CoverSaath.worktrees/*` whose branch is merged into `origin/main` (`git branch --merged origin/main`): expected `b1-limiter, b2-live-prep, b3-reference-port, d2-encrypt-rest, d3-reference-cache, m1-logging, m2-metrics, p1-erasure-scope, p1-flytoml, p1-idempotency, p1-sessions, q1-ci, s1-roles, s2-gatedtext, s3-erasure, s5-notices, s6-breach, import-main (detached), capture-design, x1-ida-audit`, plus `CoverSaath-policy-facts`, `CoverSaath-policy-facts-s2`, `.claude/worktrees/agent-*`. Haiku prints the merged list first; anything **not** merged is left alone and listed in the report. Keep: `auth-jwt, sync-log, person-records, docs-sync, b4-worker-queue, ida-integration`.

**Knowvia_website — delete**: `email.md` (if it is a scratch note; verify), `playwright.app.config.ts` once the app moves out (Wave B).
**Knowvia Frontend — delete**: `docs/` entries already reflected in `AGENTS.md` (Haiku lists, lead confirms in PR).
**CoverSaath frontend — archive whole repo**: move to `CoverSaath-archive-2026-10-20/frontend-design-2026-11/` after copying `PRODUCT.md`, `BUILD-SPEC.md`, `design/` into `Knowvia Frontend/design/spec/`. No git deletion of a repo; the folder move is reversible.
**insurance-data-api — delete**: `CODEX_BUILD_BRIEF.xml` (superseded), any `docs/*` whose plan is in `main`. Haiku lists; lead confirms.

Success: `git status` clean after PR, `npm run check:architecture` passes, `docs/exec-plans/active/` holds only `complete.md` + the two data docs. Failure: any deletion of a file referenced by `AI.md`, `AGENTS.md`, or `src/**` — grep guard before `git rm`.

---

## 2. MECE decomposition

Product (P) and Engineering (E) personas each own one side of every segment. Segments are mutually exclusive by **data ownership**; together they cover the whole journey.

| # | Segment | Owns (data) | P-persona question | E-persona question |
|---|---|---|---|---|
| S1 | Identity & household | people, sessions, consents, declarations (PED, prior conditions, nominee, agent/advisor name+ID) | What must a user tell us once so we never ask again? | Which tables are per-household partitions; what is the erasure path? |
| S2 | Holdings intake | uploaded PDFs (retail health, group/employer, others), OCR pages, detected insurer+plan candidates | How do we confirm insurer + policy name with zero jargon (no UIN asked)? | Parallel fan-out: own-PDF parse ‖ IDA reference fetch; idempotent jobs. |
| S3 | Reference corpus (IDA) | insurer docs keyed by UIN: policy wording, T&C, brochure, CIS, network-hospital lists | Which insurer docs change the user's answer; how fresh must they be? | Export shape IDA → `reference_cache`; versioning; no PII ever in IDA. |
| S4 | Normalised policy facts | `policy_facts` (typed, sourced, confidence), conflicts, user confirmations | What are the 40 facts a worried person asks about first? | Messy-input strategy: facts as EAV+JSONB with provenance, not a 138-column schema. |
| S5 | Personal memory | per-household memory: facts + declarations + premiums + confirmed resolutions + chunk embeddings | What makes the answer feel "mine"? | pgvector in Supabase now; seam to external vector store later. |
| S6 | Chat & planning | threads, turns, retrieval traces, tool calls | Planned surgery flow: coverage, waiting periods, sub-limits, cashless hospital near me. | RAG over S4+S5+S3; deterministic eligibility; model only summarises; redaction gate. |
| S7 | Money & declarations ledger | premium payments (amount, date, channel, via agent?), dues, agent/advisor record | Renewal, GST, tax proof, "did my agent actually pay?" | Append-only ledger; reconciliation later. |
| S8 | Network hospitals & location | hospital ↔ insurer/TPA network, geo | "Cashless near me for this surgery." | IDA ingest of network lists; PostGIS later; cache per insurer. |
| S9 | Multi-model gateway & redaction | provider adapters, redaction gate, budget, audit of every outbound payload | Which model per task; cost per user. | `provider-boundary.js` extended: Anthropic, Gemini, DeepSeek, Kimi, OpenAI adapters, one interface. |
| S10 | Analytics & telemetry | PostHog events, voice transcripts (opt-in), product metrics | What do we learn in 6-10 months? | Event schema, server-side capture, no PII in properties, transcript store erasable. |
| S11 | App + BFF | Next app, server-side calls only, sessions | Fewest screens to value. | BFF stateless, backend is the only DB writer. |
| S12 | Platform | deploy, secrets, queues, scale seams | — | Fly + Vercel + Supabase now; marked seams for workers, Redis, object store, read replicas. |

Out of scope (explicitly): claims filing, TPA coordination, wallet passes, WhatsApp/SMS sends, payments collection, any non-synthetic data.

---

## 3. Target architecture (E-persona)

```
Browser ──► Knowvia Frontend (Next 16, Vercel)
              │  server actions / route handlers = BFF (no browser→API)
              ▼
         CoverSaath API (Node 25, Fly knowvia-api)  ── /api/v1/*
              │                      │
              │ pg (pooler)          │ job_queue (mig 037)  ──► SCALE: worker process (b4-worker-queue branch)
              ▼                      ▼
         Supabase Postgres 17 ◄── reference_cache ◄── IDA export (pull, versioned)
           ├ household data (encrypted cols)        insurance-data-api (Fastify, own PG)
           ├ policy_facts (EAV+JSONB, provenance)     ├ UIN registry, source_pages, tables_json
           ├ memory_chunks (pgvector)                 └ network_hospitals (new ingest)
           ├ chat_threads / chat_turns / retrieval_traces
           ├ premium_payments, member_declarations
           └ analytics_outbox ──► PostHog (server-side)
         Model gateway: provider-boundary ─► redaction gate ─► {anthropic | gemini | deepseek | kimi | openai}
```

### 3.1 Data model additions (migrations 048+, append-only, all `household_id` scoped, all in `data-purposes` registry, all with erasure test)

Reuse first: `app-data-plan.md` already specifies `premium_payments`, `premium_dues`, `claims`, `household_dates`, `reminders`, `household_invites`, `adult_email_index`; `user-data-store-spec.md` specifies profile answers. Check which of 025-047 already created them (Haiku: `grep -l "CREATE TABLE" migrations/0{25..47}*`); create only the missing ones.

- **048 `policy_holdings`**: `id, household_id, member_id, kind (retail_health|group_health|top_up|critical_illness|other), insurer_id (ref), product_id (ref, nullable until confirmed), uin (nullable, internal only), policy_number_ciphertext, sum_insured_paise, period_start, period_end, status (uploaded|insurer_pending|confirmed|parsed|conflicts|ready), document_id, created_at`. Index `(household_id, status)`.
- **049 `policy_fact_values`** (EAV + JSONB — the messy-input answer): `id, holding_id, household_id, fact_key (text, from registry in `src/contracts/policy-facts.js`), value_json, value_text (generated, for FTS), unit, source_kind (own_pdf|insurer_doc|user_confirmed|rule_derived), source_ref (document_id/page/bbox or reference_cache id), model_provider, status (extracted_unverified|conflicting|unknown|confirmed), confidence numeric, superseded_by, created_at`. Index `(holding_id, fact_key, status)`, GIN on `value_json`. **Never a column per fact.** Fact keys are an append-only registry (start ~40: room rent cap, co-pay, waiting periods ×3, PED list, maternity, day-care, pre/post hospitalisation days, restoration, NCB, sub-limits by procedure, network type, TPA, cashless rules, exclusions list, zone, deductible, grace period, free-look, portability, claim intimation window …).
- **050 `fact_conflicts`**: `id, holding_id, fact_key, candidate_ids[] , reason (own_vs_insurer|two_pages|model_disagree), resolution (pending|user_chose|insurer_wins|own_wins|dismissed), chosen_fact_id, resolved_by (user|rule), resolved_at`. Powers the "loop in the end user" step.
- **051 `member_declarations`**: `id, household_id, member_id, holding_id, kind (pre_existing_disease|prior_condition|habit|occupation|nominee|other), label_ciphertext, declared_on, declared_to_insurer bool, document_id?, created_at`. Encrypted label (health data).
- **052 `premium_payments`** (if not already in 028): `id, household_id, holding_id, amount_paise, paid_on, channel (upi|card|netbanking|cheque|cash|salary_deduction), paid_via (self|agent|employer|bank), agent_name_ciphertext, agent_code_ciphertext, receipt_document_id?, created_at`. + `premium_dues`.
- **053 `memory_chunks`** (pgvector): `id, household_id, holding_id?, scope (own_pdf|insurer_doc|confirmed_fact|declaration|chat_summary), chunk_text_ciphertext, embedding vector(1024), token_count, source_ref, created_at`. `CREATE EXTENSION IF NOT EXISTS vector`. HNSW index `(embedding vector_cosine_ops)` partial `WHERE scope <> 'insurer_doc'`; insurer chunks shared by `reference_cache` id, not per household. **SCALE:** at >10M rows move insurer chunks to dedicated store; household chunks stay partitioned by `household_id` hash.
- **054 `chat_threads`, `chat_turns`, `retrieval_traces`**: turn stores `role, content_ciphertext, redacted_prompt_hash, provider, model, tokens_in/out, cost_paise, latency_ms`; trace stores chunk ids + fact ids used. Transcripts of voice notes = a turn with `input_kind='voice'`, `transcript_ciphertext`, `audio_document_id` (store audio only if `VOICE_AUDIO_RETAIN=true`). Erasable with the household. (`app-data-plan.md` D4 recommended not storing transcripts; user has now chosen to store them — record in ADR 0027.)
- **055 `network_hospitals`** (reference, no PII): `id, insurer_id, tpa_id, name, address, city, pincode, lat, lng, cashless bool, source_ref, valid_from, valid_to`. Index `(insurer_id, pincode)`. **SCALE:** PostGIS + geohash when > 100k rows or radius queries > 50 rps.
- **056 `provider_calls`** (audit, every outbound model call): `id, household_id?, purpose, provider, model, redaction_report_json (counts only), payload_sha256, tokens, cost_paise, status, created_at`. This is the "no PII reached the provider" evidence.
- **057 `analytics_outbox`**: `id, event, distinct_id_hash, properties_json (allowlisted keys), created_at, sent_at`. Worker drains to PostHog.

Everything derived (049, 050, 053, 054, 056 household rows) is covered by the existing erasure path (`data-erasure-proof.test.mjs` pattern); each migration adds its table to the erasure classification.

### 3.2 Pipeline (S2→S4), as jobs on `job_queue`
1. `document.uploaded` → existing scan+OCR → emits `holding.detect_insurer` (regex + fuzzy match on OCR page 1-3 against IDA insurer/product registry; returns ≤3 candidates with product names, **never shows UIN**).
2. UI: user confirms insurer + plan name (mandatory gate). On confirm, backend resolves `uin` server-side from the registry.
3. Fan-out, parallel: `holding.parse_own_pdf` (structuring service, redaction gate, provider via gateway) ‖ `holding.fetch_reference` (IDA export for that UIN → `reference_cache` upsert → chunk+embed insurer docs once per UIN version).
4. `holding.collate`: deterministic merge in `src/features/insurance-rules/collate.js`: for each fact_key pick candidates; identical → `confirmed` (source=rule_derived); differing → `fact_conflicts` row; missing → `unknown`.
5. UI: conflict review screen; user chooses → `user_confirmed`. Non-blocking: unresolved conflicts stay, chat flags them.
6. `holding.memorise`: embed confirmed facts + own-PDF chunks into `memory_chunks`; status `ready`.

Idempotency: job key = `(holding_id, step, input_sha)`. Retries: 3, backoff. **SCALE:** same job table drained by N workers (`FOR UPDATE SKIP LOCKED` already in 037); split per-step queues only when a step's p95 > 30 s.

### 3.3 Chat (S6)
`POST /api/v1/chat/threads/:id/turns`: (1) classify intent deterministically (keyword + small model, labelled unverified); (2) retrieve: top-k `memory_chunks` for household ∪ insurer chunks for the holding's UIN ∪ all `confirmed` facts for the holding ∪ declarations ∪ open conflicts; (3) rules engine answers eligibility/waiting-period/sub-limit arithmetic in code and emits a `facts_used` block; (4) redaction gate strips names, policy numbers, DOB, phone, email, addresses, IDs, replacing with stable tokens `{{PERSON_1}}`; (5) model drafts prose over redacted context, citing fact ids; (6) backend re-hydrates tokens, stores turn + trace. Planned-surgery flow = intent `procedure_planning`: pulls procedure sub-limit, waiting period vs policy start, room-rent cap, co-pay, cashless flag, then `network_hospitals` by pincode. Streaming via SSE from backend → BFF → browser.

### 3.4 Model gateway & redaction (S9) — non-negotiable
- One interface in `src/integrations/model-gateway/`: `complete({purpose, messages, schema?, budget})`; adapters `anthropic` (default, `claude-sonnet-5-5`; `claude-haiku-5-5` for classification), `gemini` (existing, 402 now), `deepseek`, `kimi`, `openai` (stubs with same contract, enabled by `MODEL_PROVIDERS=anthropic,...`). Routing table by `purpose` in config, not code.
- Redaction gate = existing privacy gate in `src/features/ai-analysis` hardened: structured-field scrub (every ciphertext column is never decrypted into a prompt), regex set (Aadhaar, PAN, phone, email, DOB, policy no., member id, pincode kept at 3 digits), name tokeniser seeded from household member names. Gate output logged as counts into `provider_calls`. Test: fixture with synthetic PII → assert zero matches in outbound payload. **Any provider call that bypasses the gate fails `check:architecture`** (add import rule: only `model-gateway` may import provider SDKs).
- Budget: per household per day tokens; existing budget module.

### 3.5 Scale seams (marked `// SCALE:` in code; listed here so nobody re-derives them)
- Per-process rate limit + budget → Redis/Upstash when >1 Fly machine.
- `job_queue` in-DB → separate worker machine first (branch `patch/b4-worker-queue`), SQS/pgmq later.
- PDF bytes in DB (E1) → Supabase Storage / S3 with KMS when avg doc > 5 MB or > 100k docs.
- pgvector HNSW → dedicated vector service at >10M chunks or p95 > 200 ms.
- Insurer chunks shared across households by UIN version (already dedup) → CDN-cacheable reference answers.
- Read replica for chat retrieval; writes stay primary.
- BFF stateless on Vercel Fluid Compute; sticky nothing.
- PostHog via outbox, batched, never inline on request path.
- Partitioning key everywhere = `household_id`; keep every new table with it as a leading index column so Citus/sharding is mechanical.

---

## 4. Product plan (P-persona)

**Screens (Knowvia Frontend), in order of value:**
1. Sign-in (existing beta flow) → household + members (reuse person-records 047).
2. **Add cover**: drop PDF(s); progress; "We think this is *Star Health – Comprehensive*. Correct?" with ≤3 choices + "something else" (type insurer, pick plan). No UIN shown.
3. **Declarations & money** (skippable, nudged): PEDs per member, prior conditions, nominee; premium paid, date, how, via whom (agent name/code).
4. **Review**: facts grid grouped (Limits, Waiting, Exclusions, Cashless, Money); conflict cards "Your document says X, insurer's wording says Y — which is right?"; unresolved shown amber.
5. **Chat**: thread per household; suggested prompts ("Planned knee surgery in Jan — covered?", "Cashless hospitals near 400053"); answer shows facts used + source pages; voice note button (transcript stored, audio optional).
6. **Hospitals**: list by pincode for the holding's network.

**10x levers (recorded for quarters ahead, not built now):** family graph (invites exist), renewal + claims ledger (tables exist), employer group-cover channel (one HR upload → N households), advisor portal (agent name/code already captured), aggregate anonymised fact stats per product (which plan actually pays for X), TPA coordination desk. Every one of these only needs new consumers of `policy_fact_values` + `memory_chunks`; no schema rewrite.

**PostHog event spec (server-side, allowlisted props):** `cover_uploaded{kind,pages}`, `insurer_confirmed{candidate_rank,manual}`, `parse_completed{facts,conflicts,ms}`, `conflict_resolved{choice}`, `declaration_added{kind}`, `premium_recorded{channel,via}`, `chat_turn{intent,provider,tokens,ms,facts_used}`, `voice_turn{seconds}`, `hospital_search{results}`. `distinct_id` = sha256(household_id + salt). No free text ever.

---

## 5. Agent roster (model routing per user instruction)

Max 4 concurrent. Each agent runs in its own worktree, on its own branch, opens a PR, never merges. Caveman full in all agent prompts. Every agent prompt starts with: "Read AI.md, AGENTS.md, docs/exec-plans/active/complete.md §<n>. Synthetic data only. Never read .env*. Do not commit/push beyond your branch."

Common success gate for every builder: `npm run check:architecture` green; new tests for its own tables (erasure + ownership) green in isolation; `git diff --check` clean; `gitleaks git .` clean on branch; PR body lists unverified items. Common failure: touches files outside its owned paths; adds a dependency without ADR line; decrypts a ciphertext column into any prompt; shows UIN to the user.

### Wave 0 (today, hour 0-1) — Haiku
**H0 docs-purge** — Persona: janitor. Objective: section 1 exactly. Capabilities: Bash, git, grep. Approach: list → grep-guard → `git rm` → PR. Scaffold: branch `chore/docs-purge`. Versions: none. Success: `docs/exec-plans/active` = 3 files; no broken links (`grep -r "exec-plans/active" AI.md AGENTS.md docs`). Failure: deletes a kept file.
**H1 branch-landing prep** — Objective: rebase `feat/auth-jwt`, `feat/sync-log`, `feat/person-records` sequentially onto `main`, fix migration-count test at each step (`migrationCount` 42→43→44→45), push branches, open PRs #91-#93 in that order with merge-order note. Success: each PR CI green. Failure: any conflict beyond count tests → stop, report. (User merges.)

### Wave A (today, hours 1-6) — Sonnet medium ×3 + Opus medium ×1
**S-A1 facts schema + registry** (Sonnet) — Persona: data engineer. Objective: migrations 048-052, `src/contracts/policy-facts.js` registry (≥40 keys with type, unit, group, question-form label), repositories `policy-holding-repository.js`, `policy-fact-repository.js`, `declaration-repository.js`, `premium-repository.js`, erasure classification + tests, `data-purposes` entries. Approach: copy pattern from `person-record-repository.js` (047) and `coverage-parameter-repository.js`. Scaffold: worktree `facts-schema`, branch `feat/facts-schema`. Versions: pg 8.x as pinned, Postgres 17. Success: `db:init` applies cleanly on fresh local DB; erasure proof test includes 5 new tables; ownership test per route stub. Failure: column-per-fact design; any table without `household_id`.
**S-A2 model gateway + redaction** (Sonnet) — Persona: platform engineer. Objective: §3.4. Anthropic adapter live (`@anthropic-ai/sdk`, latest, ADR 0028 line), Gemini wrapped, 3 stub adapters, routing config, redaction gate hardening, `provider_calls` (056), architecture rule, redaction fixture test. Capabilities: Context7 for Anthropic SDK docs (`/anthropics/anthropic-sdk-typescript`), `claude-api` skill. Scaffold: `src/integrations/model-gateway/{index,anthropic,gemini,deepseek,kimi,openai,redact}.js`. Versions: SDK latest, `claude-sonnet-5-5`, `claude-haiku-5-5`. Success: redaction test = 0 leaks on synthetic-PII fixture; `check:architecture` fails on a deliberate direct import in a scratch test, then passes after removal; stub providers return typed `unknown`. Failure: gate bypassable; key read from anywhere but env.
**S-A3 IDA export + reference fetch + insurer detection** (Sonnet) — Persona: integration engineer, works across `insurance-data-api` and `CoverSaath`. Objective: IDA `GET /v1/products/by-uin/:uin/export` (docs + `source_pages` + `tables_json`, versioned ETag) and `GET /v1/products/search?insurer=&q=` (name match, returns product id/name, UIN only to service caller); CoverSaath `reference-import` job filling `reference_cache` (ADR 0021 shape), `detect-insurer` job (fuzzy match OCR text vs registry names), route `POST /holdings/:id/confirm-product`. Scaffold: IDA branch `feat/export-by-uin`; CoverSaath branch `feat/ida-reference-fetch` (continue from `feat/ida-integration` worktree). Versions: Fastify 5.6, existing openapi lint. Success: with one synthetic UIN seeded in IDA, confirm → `reference_cache` row + chunks present; detection returns the seeded product top-1 for its own brochure. Failure: UIN in any UI payload; IDA stores anything household-derived.
**O-A4 collate + conflicts + pipeline orchestration** (Opus medium — architecturally complex) — Persona: principal engineer. Objective: §3.2 steps 3-6: fan-out jobs, `collate.js` deterministic merge, `fact_conflicts` lifecycle, status machine on `policy_holdings`, routes `GET /holdings/:id/facts`, `GET/POST /holdings/:id/conflicts/:cid/resolve`, idempotency keys, retry semantics, `holding.memorise` stub (embedding call via gateway). Depends on A1 contracts (coordinate via shared `src/contracts/policy-facts.js` landed first by A1 within hour 1). Success: integration test: two synthetic sources with one disagreement → exactly one conflict, user resolve → fact `confirmed`, status `ready`; re-running jobs is a no-op. Failure: model output ever written as `confirmed`.

### Wave B (today evening / day 2 morning) — Sonnet ×3 + Haiku ×1
**S-B1 memory + chat backend** (Sonnet) — Objective: 053, 054, embeddings via gateway (Anthropic has no embeddings → use `voyage-3` via Voyage adapter *or* Gemini embeddings; decision D3 below), retrieval, `POST /chat/threads`, `POST /chat/threads/:id/turns` SSE, intent classification, procedure-planning rules in `insurance-rules`, `retrieval_traces`, voice transcript turn (`input_kind=voice`, transcript via Sarvam STT already integrated). Success: synthetic holding ready → question about room rent returns answer citing the confirmed fact id; redaction counts > 0 logged; erasure wipes threads. Failure: answer with no `facts_used`; decrypted names in prompt.
**S-B2 app screens 2-4** (Sonnet, repo `Knowvia Frontend`) — Objective: BFF route handlers (server-only, bearer from session) for holdings/confirm/facts/conflicts/declarations/premiums + screens Add cover, Declarations & money, Review. Reuse existing beta auth + fetch wrapper; mock adapter updated for every new backend route (memory rule: backend change ships with BFF + mock). Scaffold: `src/app/(app)/covers/...`, `src/server/api/*.ts`. Versions: Next 16.4.3, React 19.3, zod 4.6. Success: `npm run typecheck && npm run build` green; Playwright smoke: upload fixture PDF → confirm → review renders facts grid. Failure: any `fetch` to the API from a client component.
**S-B3 BFF consolidation** (Sonnet) — Objective: move `Knowvia_website` `feat/policy-profile-bff` proxy routes into `Knowvia Frontend` (three-repo split memory: backend / app+BFF / landing). Website keeps landing + waitlist only. Success: website `npm run check` green with routes removed; app has all routes; no `pg` dependency in the app (backend is the only DB writer). Failure: two BFFs alive.
**H-B4 seeds + fixtures** (Haiku) — Objective: synthetic fixtures: 2 insurers, 3 products, one brochure + one wording PDF each (generated text, not real insurer docs), one group-cover PDF, synthetic household with 2 adults 1 child, declarations, 3 premium rows, 30 hospitals across 3 pincodes; `npm run seed:demo`. Success: seed idempotent; zero real names (grep against a denylist of real insurer brand names → replace with `Acme Health`, `Northstar General`). Failure: any real policy text.

### Wave C (day 2) — Sonnet ×3
**S-C1 chat + hospitals UI** (Sonnet, app) — screens 5-6, SSE consumer, voice button (MediaRecorder → BFF → backend STT), hospital list. Success: Playwright: ask seeded question → streamed answer with facts chips.
**S-C2 network hospitals ingest** (Sonnet, IDA + backend) — 055, IDA `network_hospitals` table + CSV/HTML ingest command + export endpoint; backend sync job; route `GET /holdings/:id/hospitals?pincode=`. Success: seeded pincode returns ≥1 cashless hospital. SCALE note: PostGIS.
**S-C3 PostHog + analytics outbox** (Sonnet, backend + app) — 057, outbox worker, `posthog-node` (ADR line), event spec §4, app-side `posthog-js` only with the allowlisted props, consent-gated. Success: events visible in PostHog test project with no free text; `ANALYTICS_ENABLED` default false. Failure: any prop not in allowlist (test).

### Wave D (day 3) — Sonnet ×2 + Haiku ×1
**S-D1 deploy** — Fly: run 048-057 via `db:init` on Supabase (user approves before), set secrets (user provides keys), deploy, verify `/ready`, run smoke against prod with synthetic household. Vercel: app project env, preview → production. Hard rule: assistant deploys only on explicit "deploy now" per environment.
**S-D2 docs** — `docs/iterations/LATEST.md` rewrite to current state; ADR 0027 (voice transcripts stored, erasable), 0028 (model gateway + Anthropic default + redaction evidence), 0029 (pgvector memory), 0030 (EAV facts); `docs/architecture/data.md` updated; runbooks `chat-and-memory.md`, `ida-sync.md`. Delete `app-data-plan.md`, `user-data-store-spec.md` (absorbed).
**H-D3 secret sweep** — `gitleaks git .` on all four repos + worktrees, grep for the known weak password pattern (hash only, never printed), CodeRabbit/Cubic/CodeQL comments triaged on every open PR, list to user. Success: zero findings or each one addressed in a follow-up commit.

### Wave E (day 3, end) — Opus medium ×1
**O-E1 top-down audit** — Persona: staff engineer, read-only. Scope: every PR of this plan. Checks: invariants 1-7 of AI.md; redaction evidence (`provider_calls` sample); erasure proof covers all new tables; ownership check on every new route; scale seams present and commented; synthetic data only; no secret; UIN never in UI payloads. Output: one `docs/audits/2026-11-13-complete-audit.md` with pass/fail per check and file:line evidence. User merges after. Opus also reviews only these two items flagged "extreme": redaction gate code, collate/conflict state machine.

---

## 6. Decisions (recommendations applied unless user objects at approval)

- **D1 canonical app = `Knowvia Frontend`**, BFF lives inside it; `Knowvia_website` = landing + waitlist only; `CoverSaath frontend` archived (design spec copied in).
- **D2 default model provider = Anthropic** (`claude-sonnet-5-5` extraction/chat, `claude-haiku-5-5` classify); Gemini stays as second adapter pending credits; DeepSeek/Kimi/OpenAI stubs now. Needs `ANTHROPIC_API_KEY` from user (paid, user provides).
- **D3 embeddings = Voyage `voyage-3-large` via Anthropic-recommended adapter** behind the gateway (same redaction gate); fallback Gemini `text-embedding-004` if Voyage key absent. Dim 1024.
- **D4 voice transcripts stored** (user's call), encrypted, erasable; audio retained only behind `VOICE_AUDIO_RETAIN`.
- **D5 facts = EAV+JSONB with provenance** (§3.1 049), not wide tables. Reason: messy, insurer-specific, append-only keys.
- **D6 PostHog server-side via outbox**, consent-gated, allowlisted props; `ANALYTICS_ENABLED=false` until S5 notices name analytics as a purpose (legal).
- **D7 security posture for MVP**: keep every existing control (host guard, ownership, consent gate, encryption, rate limit). Add nothing new except redaction evidence table. Nothing is removed. "Negate for MVP" is interpreted as *no new hardening work*, never as switching controls off.
- **D8 nothing merges without the user**; no deploy without "deploy now".

---

## 7. User-owned blockers (unchanged, need action for Wave D)
Rotate Supabase password (then delete `.env.local.bak-pre-pooler`); provide `ANTHROPIC_API_KEY` (+ Voyage or Gemini credits); PostHog project key; approve running migrations 045-057 on Supabase; approve stray `postgres` DB cleanup (table list first); dismiss CodeQL #72; legal read of `notices-v1` + new consent copy for declarations/health data/voice.

---

## 8. Verification (end-to-end, after Wave C)
1. Fresh local DB: `npm run db:init` → `valid:true`, `migrationCount` = 55 (42 + 045-057). `npm run check`, `npm run eval:safety`, `git diff --check`, `gitleaks git .` all green per repo.
2. `npm run seed:demo` → start backend + app → browser: sign in → upload synthetic group-cover PDF → see 2 insurer candidates → confirm → progress → Review shows ≥25 facts, ≥1 conflict → resolve → status `ready`.
3. Chat: "Knee replacement planned Feb, am I covered, which hospital near 400053 cashless?" → streamed answer, facts chips (waiting period, sub-limit, room rent, co-pay), 2 hospitals, trace row stored, `provider_calls.redaction_report_json` shows name/phone counts > 0, outbound `payload_sha256` payload (captured in test) contains no fixture PII.
4. Voice: record 5 s → transcript turn stored encrypted.
5. Revoke consent / delete household → every new table has 0 rows for that household (erasure proof test).
6. PostHog test project shows the 9 events with only allowlisted props.
7. Fly `/api/v1/ready` 200 after deploy; Vercel preview runs the same journey against Fly.

Not verified by this plan (stated): legal wording, real insurer documents (none used), load beyond one machine, provider cost at scale.
