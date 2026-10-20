# Latest iteration

## 2026-10-20 — Privacy finding P1 (address tail)

- Privacy gate `knowvia-privacy-evidence-v6`: `<ADDRESS_n>` now absorbs the locality, "CITY-PIN", state and partially masked phone that follow it (same line and up to four continuation lines), but only when anchored by a 6-digit PIN or masked phone. Public insurer numbers (UIN, helplines, stamp references) and policy wording are kept. The change only removes text after a placeholder; it never adds raw data.
- Evidence: `tests/privacy-gate-address-tail.test.mjs` (red first), three `eval:safety` cases (dataset `2026-10-20.1`, 26 cases), `npm run check` 753 pass, `check:architecture`, `git diff --check`.
- Existing test edits (pins only, no control weakened): version assertion in `tests/privacy-gate-r4.test.mjs` v5 to v6; case count 23 to 26 in `tests/evals/safety-evaluator.test.mjs`.
- Independent read-only review found one blocking item (exponential backtracking in the masked-phone pattern); fixed with a regression test.
- Known residual (not fixed, fail-open recall gaps): tails with no PIN or masked-phone anchor, Devanagari tails, PIN with odd spacing, table-cell tails, tails over 24 words or five lines. Not legal review. No live provider call made.

## Block 2 close-out: baseline audit and document boundaries D1, D1a, D1b, D2, D3 (2026-10-20)

Base: HEAD `5b31739`, equal to `origin/main` `fee77db`.
Audit: [block-2-closeout-audit.md](../exec-plans/active/block-2-closeout-audit.md). Block 2 decision: **NO-GO** for freeze; single-policy live pipeline PASS.

Live findings fixed (first live question run, 2026-10-20):
- Every source carries `verbatim`. The model reads gated text, so a quote can hold privacy placeholders (and the
  gate can normalise the adjacent label). Such a quote cites the right clause and page but is not verbatim source text.
- Clause-kind "absence" unknowns are no longer emitted when the whole policy was read. On the retrieved path they say
  only that no clause with that keyword label was retrieved. Kinds are ranking hints, never evidence of absence.
- Ops: the local DB was backed up (`.local/backups/`), moved from `.local/.local/` to `.local/knowvia.sqlite` and
  migrated to 16 migrations (valid).
- Live question run (Gemini live, Sarvam not called, about $1.56): 34 of 34 answered on one real policy. 56 of 62
  expected quotes exact; 60 of 62 clause-equivalent. 0 fabricated citations in 191. Consent expiry blocks replay and
  GET (403). 0 names in prompts. p50 38 s. Draft questions are not owner-verified. Detail: audit, section A5.
- Open from live review: F-B, a finding bucketed by its cited clause's keyword label (the benefits table is labelled
  `exclusion`, so "At Actuals" lands in `limited_or_excluded`). P1, the privacy gate leaves locality and PIN after
  a masked address.

Owner decisions applied (all "recommended" options):
- D1/D1a: a question reads only the latest active version of each logical document. The version is household-wide
  (`DocumentRepository.latestActiveVersions`), so a newer version in another case still supersedes. Authorised
  superseded versions are reported (`superseded_version`) and never read. A bad version number or a case over
  1,000 documents fails closed.
- D2: with more than one current authorised document, POST must carry `documentIds` (1 to 10). Otherwise it fails
  with 409 `POLICY_EVIDENCE_DOCUMENTS_REQUIRED`. Every named document must be active in the case (404), granted (403)
  and current (409). The answer carries `documentAssociation {basis: requester_named, verified: false}`. Granted
  documents that were not named are reported (`not_named`). `documentIds` is part of the idempotency digest.
- D3: answers store `access` (grant, subject, read documents) in `answer_json`. It is never returned. Replay and GET
  re-check the question grant (expired: `CONSENT_REQUIRED`). A row without `access` is never served.
- D1b: a replay whose documents are no longer active or current gives 409 `POLICY_EVIDENCE_ANSWER_STALE`, with no
  model call. GET returns `current: false`. Currency is also re-checked at commit, as consent already is.
- Owner questions from review: a household member may read another adult's answer through the case (pre-existing).
  An older version becomes current again if the newer one is removed. Pre-change answer rows are refused
  (no live rows exist: the live DB lacks migration 015).
- Not done: live question journey, retrieval recall (no golden file), DB still at `.local/.local/`. PostgreSQL has
  no `latestActiveVersions` (SQLite runtime only).
- Checks: `npm run check` 782 tests, 729 pass, 0 fail, 53 skipped (PostgreSQL without `TEST_DATABASE_URL`, live
  services). `eval:safety` 23/23. `git diff --check` clean. Two independent read-only reviews: no blocker. No provider call made.
- Commits `523ccd1` and `5b31739` (grounding, sweep, budgets, completeness, discoverability) are on `main`.

## Evidence-first review fixes (2026-10-20)

Uncommitted on `codex/backend-first-layout`.

- Claim grounding: finding conditions, exceptions, value and appliesTo must be verbatim in a cited clause or are dropped and counted.
- Independent sweep: `selectSweepContext` runs fresh FTS searches from the findings and adds unseen clauses to the sweep call (retrieved path only).
- Document limit (10) now applies after consent filtering.
- Several documents in one answer add an unknown: document-to-policy association is still unestablished (ADR 0007 blocked by U2). Wire clauses carry `document_id`.
- `npm run eval:retrieval` and `evaluateRecall` measure retrieval recall from `.local/eval/retrieval-golden.json` (owner-written, not yet created). No numbers exist.
- `/docs` is gitignored: ADR 0008 and direction-change.md need `git add -f` to be committed.
- Unverified: live Sarvam -> Gemini -> question journey; recall on real policies; semantic/hybrid comparison.

## Direction change: Phase A S0/S1/S2/S7 and Phase B B0/B1 start (2026-10-20)

Plan: [direction-change.md](../exec-plans/active/direction-change.md). ADR: [0008](../adr/0008-evidence-first-reasoning.md) (Proposed).
Uncommitted on `codex/backend-first-layout`.

- S0: `correct_unknown` outcome for golden "unknown"; a single duration inside a clause matches.
- S1: gate v5. Identifier-labelled or non-network-shaped lone digit runs are minimised; card-labelled and real
  network-shaped runs are still rejected. Existing gate tests unchanged except the version string.
- S2: exactly one target per item; valid registry key wins over a filled proposal; forbidden key never accepted.
  Extractor version v4.
- S7: relative DB path resolves against cwd (no more `.local/.local/`); legacy copy raises `DATABASE_LEGACY_PATH`.
  Upload metadata field renamed `pageObjectCount` (inspector over-count).
- B0: ADR 0008, `src/contracts/policy-evidence.js`. Question consent uses `derive` + `insurance_question`
  (no `answer` action: CHECK rebuild blocked by U2). Wording needs legal review.
- B1: clause builder, `policy_clauses` + `policy_answers` (SQLite 015, PostgreSQL 012), `ClauseRepository`, erasure on
  consent revocation (including question-only grants), document erasure and a DB safety-net trigger.
- B2: FTS5 `policy_clauses_fts` (SQLite 016, trigger-maintained; parity test ignores it; PostgreSQL tsvector deferred).
- B3: `investigate.js` (checklist, whole-policy or FTS context, privacy gate per clause, mandatory override sweep, code-assembled answer).
  Two new model tasks registered in the AI authority matrix.
- B4: `POST/GET /api/v1/cases/:caseId/questions`, `POLICY_EVIDENCE_ENABLED` (default off), idempotent, 404 across households.
- Not done: B5 recall eval (needs owner-written golden questions and approval for paid calls); S1 eval:safety cases;
  S3-S6, S8 (deferred by owner); independent read-only review of S1, B3, B4 (required by AGENTS.md).
- Checks: with a local PostgreSQL 17 (`TEST_DATABASE_URL`) `npm run check` 734 tests, 724 pass, 0 fail, 10 skipped (live services);
  without it 681 pass, 52 skipped. `eval:safety` pass, `check:architecture` pass, `git diff --check` clean.
- No live Gemini or Sarvam call was made. Retrieval recall, cost per question and accuracy are unmeasured.
- Action for owner: live DB sits at `.local/.local/knowvia.sqlite`; the server will refuse to start until moved (runbook).

## Policy structuring hardening S1 to S5 (2026-10-20)

Active plan: [policy-structuring-hardening.xml](../exec-plans/active/policy-structuring-hardening.xml). Decisions:
ADR 0006 addendum (2026-10-20). Uncommitted on `codex/backend-first-layout`; no commit, push, PR or deployment.

### Done

- S1 typed accuracy evaluator: no substring matching; typed comparison through the validator normalisers.
- S2 run-scoped proposals with provenance (`structuringRunId`, `pipelineVersion`, `registryVersion`, `sourceVersion`).
- S3 processing status separated from evidence outcome (`complete`, `partial_review_required`, `failed`); failed
  outcomes are never committed; provisional thresholds 1 and 0.5, unmeasured. The result no longer says `completed`.
- S4 durable job state: SQLite 013 / PostgreSQL 010 `policy_structuring_jobs`; restart marks running attempts
  `interrupted`; a new paid attempt needs `restart: true`.
- S5 explicit blocks upgrade for knowvia.ocr.v1 documents: SQLite 014 / PostgreSQL 011, narrowed blocks
  immutability trigger, `mode: blocks_upgrade` with `acknowledgeProviderCharge: true`, per-page text hash check
  (`OCR_UPGRADE_TEXT_CHANGED` fails closed). OCR jobs now record the output contract they stored (v2 with blocks).

### Blocked

- S6 document-to-policy association (ADR 0007) is blocked by U2: the SQLite runner cannot rebuild
  `coverage_parameter_records` inside its per-file transaction with foreign keys on (probe: plain rebuild
  `FOREIGN KEY constraint failed`; deferred rebuild fails on trigger references). Re-plan before Block 3.

### Evidence

- `npm run check` with a local PostgreSQL 17 (`TEST_DATABASE_URL`): pass. 697 tests, 687 pass, 10 skips (live
  services), 0 fail. Catalog parity, PostgreSQL trigger behaviour and runner tests included.
- `npm run eval:safety`: pass, `failures: []`. `npm run check:architecture`: pass, 132 files. `git diff --check`: clean.
- Forward migration 012 to 014 on a populated synthetic SQLite database: page ids kept, schema valid, 0 FK errors.
- Not verified: live Sarvam or Gemini calls (none made), real golden-file accuracy under the typed evaluator,
  whether Sarvam reproduces page text on a re-run.

Production readiness remains **FAIL**.

## Backend-first repository layout (2026-10-20)

Completed plan: [backend-first-layout.md](../exec-plans/completed/backend-first-layout.md).

### State

- Branch: `codex/backend-first-layout`, based on `9cad7d0`.
- No commit, push, merge or deployment was performed.
- The active application is backend-only. `src/ui/`, `index.html`, Vite configuration and UI-only tests were removed.
- `npm run dev` now starts only `src/server/server.js` on `127.0.0.1:8787`.
- `npm run build` validates the backend entry point. It produces no browser bundle.
- Business capabilities moved from `src/modules/` to `src/features/`.
- Document intake moved to `src/features/input/`.
- Source filenames remain lowercase kebab-case. Architectural categories remain in directory names.

### Repository cleanup

- Removed tracked design prototypes, generated Figma tooling, marketing images, communication drafts and historical research from the active tree.
- Removed the obsolete landing-design execution plan.
- Kept product source material in `working/` and `building/`.
- Moved the two still-referenced product answer documents from `docs/strategy/` into `working/`.
- Kept ADRs, architecture docs, runbooks, migrations, contracts, tests and active backend plans.
- Moved untracked design exports and the Figma zip to `/Users/rishavdewan/Developer/Product experiments/CoverSaath-archive-2026-10-20/`.
- Removed generated `dist/`.
- Did not touch `.local/`, `.claude/worktrees/`, environment files, `node_modules/` or Git history.

### Behaviour boundary

No API, database, consent, authorization, model authority, provider, retry or erasure behaviour changed. Legacy `knowvia` identifiers remain until a compatibility plan covers stored data and callers.

### Evidence

- Pre-change `npm run check`: pass. 685 tests, 634 pass, 51 PostgreSQL or live-service skips, 0 fail. Vite build passed.
- Pre-change `npm run eval:safety`: pass, 23 of 23 offline cases, 0 network calls.
- Post-change `npm test` with loopback permission: pass. 666 tests, 615 pass, 51 skips, 0 fail. The 19 removed tests covered only the deleted UI.
- Post-change `npm run check:architecture`: pass for 131 source files.
- Post-change `npm run build`: pass. Backend entry-point syntax validated.
- The first sandboxed post-change test run failed only with `listen EPERM` on loopback sockets. The same suite passed with loopback permission.

### Production state

Production readiness remains **FAIL**.

Open work includes:

- PostgreSQL runtime migration and recovery proof.
- Production identity and secret management.
- Deployment target, observability, backup and restore rehearsal.
- Live provider validation, OCR accuracy evidence and cost checks.
- Retention policy and legal review of consent wording.
- A future UI, only after backend contracts and production boundaries are accepted.
