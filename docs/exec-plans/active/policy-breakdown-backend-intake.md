# Policy breakdown backend: CERT intake and execution plan

Branch: `claude/policy-backend` (exclusive to Claude; other agents switch branches before working).
Date: 2026-10-02. Task class: **S2** (sensitive AI extraction, new persistence, new public API surface,
external providers). Central agent: Claude (integration owner).

## CERT-C: clarify

| Item | Record |
|---|---|
| Task title | Policy breakdown backend, end to end |
| North Star | A household uploads its policy PDF once; Knowvia turns it into a source-backed, per-parameter policy record that later powers two tracks: planned-procedure chat and emergency call/chat. "Ask the policy" is optional over the same record. |
| Primary user and trigger | Household operator uploading a policy wording, schedule or e-card. |
| Problem today | Extraction runs only on fixtures. No upload endpoint, no live OCR, no parameter catalogue in code, no lasting policy record, no calculator, no emergency card. |
| Desired outcome | `upload → OCR → 12 section agents → deterministic verification → second-opinion adjudication → assembled policy record → human confirmation of critical fields → ready`, with working HTTP endpoints for a later, very simple frontend. |
| In scope | Backend only: OCR transport (Sarvam), PDF chunking, section catalogue (12 sections), section agents (Gemini), verification, adjudication, record assembly, persistence (migration 005), document upload, breakdown jobs with progress, review/confirmation, readiness gate, emergency card, planned-procedure estimate (bill-to-payout waterfall), evaluation harness, tests. |
| Non-goals | Any frontend change. Real telephony / staffed emergency line. Payment. Purchase recommendation. Insurer-quality data acquisition (section 10 consumes supplied dated disclosures only). Production deployment, Postgres migration, real malware scanning. "Ask the policy" chat is phase 2 of this plan and is built only after the record is verified. |
| Acceptance criteria | See "Acceptance criteria" below. |
| Constraints | Node ≥22.12, ESM, `node:sqlite`, Vercel `ai` v7 + `@ai-sdk/google`. Keys only in `.env.local`. Deterministic code owns money, eligibility, permissions and evidence state. Accuracy is prioritised over cost; budgets remain explicit and capped. |
| Dependencies | Gemini API key (user will attach), Sarvam API key (user will attach). Public insurer policy wordings and user-supplied PDFs for evaluation. |
| Risks | See "Risks". |
| Success metric | On the evaluation set: ≥95% citation validity, ≥90% exact-match on critical parameters, 0 critical parameters marked Proven without a verified citation. |

### Product invariants carried forward

The previous Knowvia-specific `AGENTS.md` was replaced by the generic contract in commit `135acc9`. These
product rules still bind this build and are restated here so they are not lost:

1. Never invent a benefit. A clause proves the rule; an absent clause is an explicit gap, never a silent positive.
2. Every parameter carries one of seven evidence states: Proven, Calculated, Reported, Dynamic, Unknown,
   Conflicting, **NotPermitted**. Unknown and NotPermitted are never collapsed.
3. Never sum every sum insured into one "guaranteed family cover" number.
4. Never report someone as covered because they are eligible — enrolment must be evidenced.
5. Never tell a user to omit or rewrite health history. Declarations are the user's to approve.
6. Emergency access calls a human directly. No AI or voice agent sits in front of the call. The AI only
   prepares a read-only brief. Admit first, optimise later.
7. Payment only after explicit human approval. Not in scope here.
8. A model never decides payment, eligibility, approval or a claim outcome; it proposes extractions only.
9. Interview evidence was consented for case-competition work only and is not used in this build.
10. No real personal policy or medical document is committed. Evaluation PDFs live in ignored `.local/`.

## CERT-E: examine

| Check | Result |
|---|---|
| Git | `claude/policy-backend` created from `main@135acc9`; tree clean |
| Runtime | Node v24.21.0, npm 11.19.0 |
| Package manager | npm with `package-lock.json` |
| Scripts | `test`, `check`, `check:architecture`, `build`, `db:init`, `dev:api`, `eval:safety` |
| Env names (no values) | `DATABASE_PATH`, `KNOWVIA_BOOTSTRAP_TOKEN`, `DOCUMENT_STORAGE_PATH`, `DOCUMENT_ENCRYPTION_KEY_BASE64`, `LLM_PROVIDER`, `GEMINI_API_KEY`, `LLM_MODEL`, `LLM_INPUT_USD_PER_MILLION`, `LLM_OUTPUT_USD_PER_MILLION`, `ORCHESTRATION_*_BUDGET_USD`, `SARVAM_API_KEY` |
| Repository map | `npx -y @sylphx/repomap@1.5.0 map . --json` → `.local/repomap/map.json` (159 files, 377 file edges, 963 call edges). `setup` was **not** run because it edits global Claude/Codex/Cursor configuration. |
| `docs/CERT.md`, `docs/agent-tooling.md` | Referenced by the contract but absent. `docs/agent-tooling.md` is created by this task; AGENTS.md Appendix A serves as the CERT procedure. |

### Graph findings (repomap)

| Area | Finding | Impact |
|---|---|---|
| `src/modules/document-intake/*` | Validation, AES-256-GCM storage, OCR service and contracts exist; only a memory repository exists for documents; no HTTP route | Reuse; add SQLite document repository and routes |
| `src/integrations/sarvam/ocr-provider.js` | Fail-closed boundary that requires an injected verified transport | Implement the transport against the documented Doc AI API |
| `src/modules/ai-analysis/*` | Gemini via `ToolLoopAgent` + `Output.object`; budget ledger; gateway capped at 96 KB input / 4k output / 60 s | Reuse budget and concurrency patterns; breakdown needs its own larger, separately capped limits |
| `src/modules/coverage-analysis/policy-decomposition.js` | 50 keyword criteria in A–J over case facts | Superseded for policy records by the 12-section catalogue; left in place for the case workflow |
| `src/modules/insurance-rules/*` | Orphaned rules (copay, room rent, sub-limit, waiting period) | Waterfall calculator is new; reuse money helpers only where they fit |
| `src/server/routes/v1-backend-routes.js` | Single handler, regex routing, `services.access` auth, idempotency header | New routes live in a separate route module plugged into the same handler |
| DB | `document_uploads`, `ocr_jobs`, `source_pages` with activation/consent triggers; `document_kind` CHECK lacks `employer_benefit_booklet` | Reuse; new migration 005 for policy records |

### Sarvam Doc AI contract (verified from official docs on 2026-10-02)

- `POST https://api.sarvam.ai/doc-ai/v1/job/digitise`, multipart: `file` (repeatable) or `upload_ids`,
  `language` (BCP-47, e.g. `en-IN`), `output_format` (`html` | `md` | `json`), `content_type`, `model`.
  Header `api-subscription-key`. Response `201 { job_id, status, run_id }`.
- `GET /doc-ai/v1/job/{job_id}/status` → `status` ∈ pending, running, completed, partially_completed,
  failed, rejected; `usage { pages_total, pages_processed, pages_succeeded, pages_failed }`.
- `GET /doc-ai/v1/job/{job_id}/download-url` → `{ method, url }` to a ZIP: primary file,
  `metadata/page_NNN.json` per page, `manifest.json`.
- **Limits:** 10 pages per PDF or ZIP (400 otherwise), 200 MB, 10 requests/minute.
- **Not yet verified:** the exact JSON shape of `metadata/page_NNN.json` and the `json` output blocks. The
  transport therefore parses defensively and is marked `contract_partially_verified` until a live smoke test
  with the user's key confirms page mapping.

## CERT-R: resolve

### Design

```text
POST documents ──► validate (magic bytes, size) ──► encrypt at rest ──► structural PDF check ──► active
                                                                                       │
POST policy-records ──► breakdown job (persisted steps, resumable, idempotent) ◄──────┘
   step 1  OCR        split PDF into ≤10-page chunks → Sarvam digitise per chunk → page-tagged text
   step 2  index      page text stored in source_pages with hashes and locators
   step 3  extract    9 document section agents (sections 1–9) in parallel, each with its own
                      expertise prompt, its own parameter list and the full page-tagged text
   step 4  verify     deterministic: schema, units, value ranges, quote-on-page check per citation
   step 5  adjudicate second-opinion agent on every critical parameter; disagreement → Conflicting
   step 6  analyse    sections 10–12 deterministic analysers (insurer quality from supplied dated data
                      only; household portfolio; regulatory floor comparison)
   step 7  assemble   cross-section consistency rules → one policy record, per parameter state
   step 8  gate       record status `needs_review`; critical parameters need human confirm/correct
                      → `ready`
Consumers (deterministic, read the record only):
   emergency card     per member, precomputed when the record becomes ready
   estimate           planned-procedure bill-to-payout waterfall with a stated reducer order
   ask (phase 2)      record-grounded answers with citations; money questions route to estimate
```

**Why this order.** Models only read text and propose values with quotes. Deterministic code checks every
quote against the stored page text before a value can be Proven. A second, independent model pass must
agree on every critical parameter. A human confirms critical parameters before anything is used in an
emergency. Accuracy is bought with extra passes, not with trust.

### The 12 sections (source: `building/policy-parameters.md`)

| # | Section | Kind | Runtime agent |
|---|---|---|---|
| 1 | Document and authority | extraction | `section-01-document-authority` |
| 2 | People and eligibility | extraction | `section-02-people` |
| 3 | Time and continuity | extraction | `section-03-time` |
| 4 | Treatment and benefits | extraction | `section-04-treatment` |
| 5 | Exclusions and disclosure | extraction | `section-05-exclusions` |
| 6 | Money: ceiling, reducers, combining | extraction | `section-06-money` |
| 7 | Hospital access and cashless | extraction | `section-07-hospital-access` |
| 8 | Claims process and grievance | extraction | `section-08-claims` |
| 9 | Renewal, portability and change | extraction | `section-09-renewal` |
| 10 | Insurer quality | analyser over supplied dated disclosures | `section-10-insurer-quality` |
| 11 | Household portfolio | deterministic analyser over records + household | `section-11-household` |
| 12 | Regulatory floor | deterministic comparison against a dated, versioned floor table | `section-12-regulatory` |

### Parameter contract (shared by all sections)

Every parameter value is stored in one rule shape so it can be calculated, not only labelled:

```text
{ key, section, value, valueType, unit, basis, effect, scope, conditions, exceptions,
  evidenceState, citations[{ documentId, pageNumber, quote }], confidence,
  extraction{ agent, promptVersion, model }, verification{ quoteMatched, adjudication },
  review{ state, by, at, note } }
```

`effect` ∈ pay | pay_percent | cap_amount | cap_per_day | deduct | exclude | wait_until | require | void |
inform. `basis` ∈ per_claim | per_illness | per_person | per_policy_year | per_lifetime | per_day |
per_eye | per_joint | per_limb | per_trip | per_event | not_applicable.

### Capability decisions

| Capability | Reason | Decision | Verification |
|---|---|---|---|
| `@sylphx/repomap@1.5.0` (npx, not a dependency) | Contract MAP gate | VERIFIED (map + impact ran) | `.local/repomap/map.json` |
| `pdf-lib@1.17.1` (MIT) | Sarvam accepts ≤10 pages per PDF; splitting needs a PDF writer. No existing alternative in the repo. Last release 2022 — stable but unmaintained; encrypted PDFs may fail and are rejected with a clear error. | REQUIRED | install, import smoke test, split test |
| ZIP reading | Sarvam output is a ZIP | Implemented in-repo with `node:zlib` (no dependency) | unit test with a generated ZIP |
| Gemini via existing `@ai-sdk/google` | Section agents and adjudicator | REQUIRED, key pending | fixture-mode tests now; live smoke test once key is in `.env.local` |
| Sarvam Doc AI | OCR | REQUIRED, key pending | fake-transport tests now; live smoke test once key is in `.env.local` |
| Malware scanner | Upload safety | BLOCKED for production. Local build uses a structural PDF check (rejects JavaScript, launch actions, embedded files) recorded as `structural-pdf-check-v1`, never as antivirus | unit tests |

### Model policy note

The contract's model table names GPT-5.6 tiers, which are not available in Claude Code. Recorded fallback:
central integration and independent review on Claude Opus; section specialists on Claude Opus because the
user prioritised accuracy for this work. Runtime extraction uses the user's Gemini model set in `LLM_MODEL`.

### Agent assignments and file ownership

| Agent | Scope | Owns (exclusive) |
|---|---|---|
| Central (Claude) | contracts, pipeline, persistence, routes, calculators, integration | `src/modules/policy-breakdown/{contracts,pipeline,agents,verification,assembly,consumers}/**`, `src/backend/database/migrations/005_*`, `src/backend/repositories/{document,policy-record}-repository.js`, `src/server/routes/policy-routes.js`, `src/integrations/sarvam/*` |
| Section specialist ×12 | one section each: parameter definitions, expertise prompt, section validators, synthetic wording excerpt, gold answers, tests | `src/modules/policy-breakdown/sections/sNN-*.js`, `tests/fixtures/policy-breakdown/sNN-*`, `tests/policy-breakdown-sNN.test.mjs` |
| Independent reviewer | review against this plan | read-only; findings report |

No specialist edits a shared file. The central agent owns `sections/index.js`, the shared synthetic policy
assembly and all cross-section rules.

### Implementation sequence

1. Contracts: parameter schema, section-definition schema and validator, evidence states, output-schema generator.
2. Dispatch 12 section specialists in parallel against the contracts.
3. In parallel (central): migration 005, document + policy-record repositories, PDF chunker, ZIP reader, Sarvam
   transport, upload route, structural PDF check.
4. Section agent runner, verifier, adjudicator, analysers wiring, assembler, breakdown pipeline and job runner.
5. Consumers: readiness gate, emergency card, estimate waterfall.
6. Routes and end-to-end fixture tests across all 12 sections.
7. Evaluation harness (`scripts/eval-breakdown.mjs`) over `.local/eval/` (public wordings + user PDFs).
8. Independent review → fixes → `npm run check` → `docs/iterations/LATEST.md`.
9. Live smoke tests when the user adds `GEMINI_API_KEY` and `SARVAM_API_KEY` to `.env.local`.

## Endpoints for the frontend

All under `/api/v1`, bearer session auth, household-scoped authorisation server-side, JSON errors
`{ error: { code, message } }`, `Idempotency-Key` on creating POSTs.

| Method | Path | Purpose |
|---|---|---|
| POST | `/households/{householdId}/documents` | Upload a PDF/JPEG/PNG (JSON with base64 bytes) with a `document_processing` consent |
| GET | `/households/{householdId}/documents` | List documents (metadata only) |
| POST | `/households/{householdId}/policy-records` | Create a policy record from document ids and start the breakdown job |
| GET | `/households/{householdId}/policy-records` | List policy records |
| GET | `/policy-records/{recordId}` | Record status, summary counts per section and per evidence state |
| GET | `/policy-records/{recordId}/sections` | All 12 sections with parameters |
| GET | `/policy-records/{recordId}/sections/{sectionNumber}` | One section |
| GET | `/breakdown-jobs/{jobId}` | Job progress: steps, status, errors, cost |
| POST | `/breakdown-jobs/{jobId}/resume` | Resume an interrupted job |
| POST | `/policy-records/{recordId}/parameters/{parameterKey}/review` | Confirm or correct a parameter |
| POST | `/policy-records/{recordId}/readiness` | Run the readiness gate; returns blockers or marks ready |
| GET | `/policy-records/{recordId}/emergency-card` | Per-member read-only emergency card |
| POST | `/policy-records/{recordId}/estimates` | Planned-procedure bill-to-payout estimate |

## Acceptance criteria

1. Every endpoint above exists, enforces authentication and household scope, and has contract tests for
   success, validation error, auth error and cross-household denial.
2. A fixture run uploads a synthetic multi-page policy PDF, OCRs it through the Sarvam transport against a
   fake server, runs all 12 sections, and produces a record where every parameter has a state.
3. No parameter is Proven unless every citation quote matches the stored page text.
4. Every critical parameter has an adjudication result; disagreement yields Conflicting.
5. A record cannot become `ready` while any critical parameter is unconfirmed, Unknown or Conflicting.
6. The emergency card and estimate consume only the record and state their own Unknowns.
7. The estimate never outputs a single "covered amount"; it outputs a range, steps and the reducer order used.
8. Jobs are idempotent per key, persisted per step, and resumable after interruption.
9. `npm run check` passes. The evaluation harness runs on the fixture set and reports per-section metrics.
10. With live keys present, a smoke test runs one public policy wording end to end (deferred until keys exist).

## Verification commands

```bash
npm test
npm run check
node scripts/eval-breakdown.mjs --set fixtures
node scripts/eval-breakdown.mjs --set local   # after keys and evaluation PDFs exist
```

## Rollback

All work is on `claude/policy-backend`. Migration 005 is additive (new tables only). Rollback = do not merge
the branch; for a local database, delete `.local/knowvia.sqlite` and re-run `npm run db:init`.

## Risks, blockers and open decisions

| Risk | Mitigation |
|---|---|
| Sarvam page-metadata shape unverified | Defensive parser; page mapping smoke test is a launch gate |
| Sarvam 10 req/min and 10 pages/job | Sequential chunk submission with spacing; resumable job |
| Encrypted or malformed PDFs | Reject with `PDF_ENCRYPTED` / `PDF_UNREADABLE`; never silently partial |
| Model invents values | Quote-on-page check, adjudication, human confirmation of critical fields |
| Cost of accuracy-first passes | Separate breakdown budget env vars with hard caps and per-job ledger |
| No antivirus | Structural PDF check locally; production BLOCKED until a scanner is integrated |
| Regulatory values change | Section 12 floor table is versioned and dated; every value is Dynamic |
| DPDP / IRDAI legal review | Not resolved by this build; flagged |

CERT = READY for steps 1–8 (keys are not required for fixture-mode build and tests). Step 9 is BLOCKED until
the user adds the Gemini and Sarvam keys to `.env.local`.
