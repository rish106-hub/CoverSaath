# Latest iteration

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
