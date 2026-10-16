# Latest iteration

## Objective

Phase 0 of the production plan of action: close the unfinished evidence-completion work and establish a verified baseline. Intake and corrections: [p0-baseline-intake.md](../exec-plans/completed/p0-baseline-intake.md). Original slice intake: [evidence-completion-mvp-intake.md](../exec-plans/completed/evidence-completion-mvp-intake.md).

## Classification and state

```text
TASK CLASS = S2
CERT = READY (code gate green)
PHASE 0 GATE = REVIEW 3 PASS (no P0/P1; P2 fixed); pending owner approval
PRODUCTION READINESS = FAIL (Phases 1–6 not started)
```

## Verification evidence (review 3 fixes on top of 04db540)

- `npm run check`: architecture passed (105 source files); `npm test` 330 tests, 330 pass, 0 fail; build passed.
- `npm run eval:safety`: no failures. `git diff --check`: clean.
- `tests/review3-fixes.test.mjs`: 4 of 5 tests fail against the unfixed source and pass with the fixes (the fifth guards against over-redaction).

Earlier evidence (branch tip d042e88):


- `npm run check:architecture`: passed, 105 source files.
- `npm test`: 325 tests, 325 pass, 0 fail, 0 skipped, 0 todo, 0 cancelled. Stable across repeated runs.
- `npm run build`: passed.
- `git diff --check 135acc9 HEAD`: clean.
- QA (at 5c238fb): `npm ci` with no lockfile drift; tests pass with provider keys unset and with outbound network blocked; offline safety eval 23/23; no secrets in `dist/`.
- Starting baseline was 172 tests, 171 pass, 1 fail (`0 !== 22`).

## What was built

- Live parameter policy resolves only through the canonical registry, against the run's pinned registry version. Legacy aliases and unknown keys fail closed.
- Pre-dispatch consent validator, wired by default: before every provider call the database is re-checked for exact document, subject, household, action, category and the named model recipient (`google-gemini`). A NULL recipient never authorises model disclosure. Decisions are audited without content.
- Commit-time re-check: a model result is discarded and the run stopped if any document's consent changed during the call.
- Analysis subject derived once (`analysis_subject_adult_id`) and used for consent, selection and dispatch.
- Privacy gate v3: Unicode and whitespace normalisation, an extended identifier pattern set, member-table rows, per-request placeholders (`<PHONE_1>`), known-value redaction of the household's own names, dates of birth, phones and emails loaded server-side for every call and never persisted, a 16 KB scan cap with linear-time patterns, and narrower card detection.
- Allowlist excerpts: only parameter-matched lines (plus a numeric follow-on line without names) are sent. Pages are selected within 30 sources and 48 KB, and unsent pages are reported. A restricted page is excluded on its own with a per-document blocker.
- Model output is always unverified: `model_extracted_unverified` maps to Unknown, and release is blocked with `HUMAN_REVIEW_REQUIRED`. The certainty filter rejects guarantee and approval language (English and Hindi) in model assertions but allows questions and verbatim policy quotes.
- Citations map one-to-one to authorised per-page sources, including drafted questions. Look-alike ids are rejected.
- Parameter records: each run is pinned to a registry version, and every registry key gets a record in the same transaction as the run. Authority is derived server-side, and DB constraints stop model authority from reaching proven, calculated or dynamic. An erasure path exists for observations, and registry versions live in a table.
- Revocation erases derived run data (page excerpts and task outputs), marks the runs revoked and writes a counts-only audit event.
- OCR pages are immutable after completion.
- Docs: restored `docs/CERT.md` and `docs/agent-tooling.md`. `docs/evidence/` is untracked and ignored.

## Graph impact

53 files changed against `135acc9`, about 9,500 insertions. Affected modules: coverage-analysis, ai-analysis, backend services and repositories, database migration 005, server wiring, tests (41 test files).

## Tools, models and efforts

Claude models per the POA: Opus 5.5 high (central, privacy, reviews), Sonnet 5.5 high (runtime, data, QA), Haiku 5.5 medium (CERT). No application dependencies were added. Agent tooling: repomap MCP. Two rate-limit interruptions were resumed from preserved worktrees with no lost work.

## Review findings

- Review 1: FAIL with 4 P1 (identifier leaks, hash tokens, card false positives, model output marked Proven) and 9 P2. All addressed in rounds 2–3.
- Review 2: FAIL with 2 P1 (whitespace digit runs; member tables and head-of-page excerpts) and 1 P2 (document revocation left derived data). Addressed in round 4.
- Review 3: PASS, no P0/P1. Fixed: R3-1 (P2) a call refused by the pre-dispatch consent check, or one that never got a concurrency slot, kept its budget reservation forever, so repeated consent denials drained the process-lifetime project budget and blocked all live analysis until restart; such calls now release the reservation (`model-gateway.js`, `live-coverage-runtime.js`). R3-2 (P2 privacy) structured upstream numbers skipped the gate, so a phone or Aadhaar sent as a JSON number reached the model raw; numbers under identifier or sensitive keys are minimised, other integers are scanned as text, and a card number is rejected (`privacy-evidence-gate.js`). R3-4 (P3) `stopForRevocation` now uses the injected clock. Accepted: R3-3 (P3) source input falls back to the case opener when the analysis subject is NULL; this is covered by an existing test and is fail-closed, because coverage consent and the dispatch validator both deny the mismatch.

## Section 1: evidence-completion MVP close-out

Closes the open items of [evidence-completion-mvp-intake.md](../exec-plans/completed/evidence-completion-mvp-intake.md), implementation step 7 and acceptance criteria 7 and 11.

- Model-extracted values become parameter evidence at commit time only, after the consent re-check. Each value cited to a sent page that was selected for that key is stored as a `document_extraction` / `not_reviewed` observation (source id, document id, version, page, excerpt digest). Agreeing values resolve to `extracted_unverified` and disagreeing values to `conflicting`, both under model authority, and all observations are kept. States set by a human reviewer, an official source or a calculation are never replaced. Writes are bound to the task lease and the run status, with a counts-only audit in the same transaction (`model-observations.js`, `recordModelObservations`, `recordModelExtraction`).
- Migration 006 (expand-only): observations require an active document, and `human_review` observations require an in-progress or completed `human_reviews` row whose reviewer is the recorder. The repository enforces the same rules.
- Erasure: every run whose derived data is erased also has its observation values redacted (`redactObservationsForRun`). This covers coverage-consent revocation, document-consent revocation and the commit re-check stop. If observations exist but erasure is not wired, it fails closed.
- Decomposition: `CANONICAL_KEY_CRITERIA` places all 129 registry keys in sections A-J under exactly one criterion, so live sections are no longer all gaps.
- Verification: `npm run check` passes (architecture, 349/349 tests, build). Safety eval has no failures and `git diff --check` is clean. The lease-skip test was mutation-checked: it fails when the fix is removed.
- Independent review (Opus, read-only): PASS, with no P0/P1 and no privacy P2. Integrity P2s F1 (lease) and F2 (`UNKNOWN` placeholder) and P3s F4-F8 are fixed with tests. Open owner decision F3: consent expiry (as opposed to revocation) does not erase observations, run excerpts or task outputs. Retention policy is needed.

## Accepted risks and known limitations

- Consent expiry (as opposed to revocation) keeps observations, run excerpts and task outputs until a retention policy is decided (review F3, owner decision).
- Conflict detection reads at most 500 observations per parameter.

- Owner-accepted: the hardcoded `+91` handoff fallback in `src/orchestration/index.js` is the owner's own number.
- `docs/evidence/` still exists in public git history until the owner decides on a purge.
- npm audit high: `source-map-js` (GHSA-68fv-2mgg-jv7q), reached only through `vite` at build time. Handled in Phase 1 (P1-D).
- Over-redaction: claim or admission dates on member rows are treated as dates of birth; capitalised two-word phrases before relationship words may be over-redacted.
- A lone known first name is kept by design. Lower-case names in tables are caught only when they are known household values; third-party names (for example a non-member nominee) depend on pattern rules.
- At most 40 parameters per model request. Further matched keys stay `requested`.
- Parameter records point at a placeholder `UNCLASSIFIED:<hex>` policy and cannot be re-pointed. A classified policy gets new records (Phase 4 design item).
- No UI flow grants a document `derive` scope naming `google-gemini`. Live analysis is reachable through the API only (Phase 2, P2-D).

## Next action

1. Commit the review 3 fixes on `claude/p0-integration`.
2. Owner approval of the PR from `claude/p0-integration` to `main`.
3. Before Phase 1: resolve the open decisions in the intake (history purge, broken evidence links, second maintainer, Azure and residency owner, legal/privacy approver).
