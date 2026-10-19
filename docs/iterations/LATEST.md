# Latest iteration

## Whole-document policy structuring (2026-10-19)

Plan: [policy-document-structuring.xml](../exec-plans/active/policy-document-structuring.xml). Decision: [ADR 0006](../adr/0006-policy-document-structuring.md).

- New `src/modules/policy-structuring/`: deterministic sectioner (drops header, footer, page-number and model-written image blocks; chunks by page, table and section title), Gemini extractor per chunk batch and reconciler per document through an injected call, deterministic validator and conflict decision, counts-only coverage report. Behind `POLICY_STRUCTURING_ENABLED`, default off. No runtime route calls it yet.
- Owner decisions (2026-10-19): every chunk passes the privacy gate text sanitizer before any call and evidence quotes must be literal substrings of the gated text sent; the direct Gemini caller is used only by the opt-in `scripts/structure-policy.mjs`. The sectioner reads block-level pages; stored OCR pages (`knowvia.ocr.v1`) do not keep block boundaries yet.
- Authority: model output is only `extracted_unverified` or `conflicting`. A model-supplied state, unknown registry key, key with model extraction disallowed (identifiers), wrong page or block, or ungrounded quote is rejected with a reason. Values are normalised by code. A key whose values differ is `conflicting`; differences across distinct named subjects carry `per_subject_values`.
- Storage: SQLite `011_policy_structuring.sql`, PostgreSQL `007_policy_structuring.sql` (expand-only): `policy_structuring_runs` and `proposed_parameters` (`pending_review`). `PolicyStructuringRepository.commitStructuring` checks household and case scope, re-checks consent inside the transaction, replays idempotently and rolls back on any failure. Erasure: `ConsentRepository.eraseDerivedRunData` redacts proposals and the run's structuring observations; a document-erasure trigger is the safety net. The model never edits the registry.
- Evidence: `npm run check` passes (architecture 133 files, 628 tests: 580 pass, 48 PostgreSQL skip, 0 fail; build). With a throwaway local PostgreSQL 17, 576 of 586 pass with 0 failures at the storage builder's checkpoint. 19 storage guard mutations each fail a test. Safety eval no failures; `git diff --check` clean. Fake-caller journey test: block pages in, observations and proposals stored, every chunk accounted for, consent withdrawn before commit stores nothing.
- Independent read-only review (Opus): FAIL on one P0, now fixed. Section titles were sent to Gemini without the privacy gate (only chunk text was gated). In the first live run 13 distinct titles were sent ungated; the gate would have masked a person name in 1 of them. Titles are now gated and a test checks that no raw identifier reaches the provider. Also fixed: a value must be grounded in its own quote (P2; an ungrounded value is replaced by the verbatim quote, never stored as model wording); the quote and block are kept on each observation (P2); the script aborts on a malformed identifier file (P2) and prints error codes only (P3); missing structuring erasure fails closed with `ERASURE_NOT_CONFIGURED` (P3); `documentGrantCheck` requires a scope naming this document for `google-gemini` (P3); an already structured document makes no provider call (P3); the reconcile call counts against the document token cap (P3).
- Extractor v2 (owner request: capture everything): every printed fact becomes a registry item or a proposal; Gemini adds a confidence and a one-sentence rationale as review notes only. Household names found by the local rule extractor are passed to the gate as known identifiers; a pre-call check found 0 name, name-part or policy-number matches in the outgoing text.
- Live runs (owner-approved, billable) on the local 20-page sample, Sarvam output reused (same content hash). First run (v1): 8 calls, 67 values, key recall 0.8, C1 only. Final run (v2, `--store` into a fresh local SQLite backend): 15 calls, about 53.9k input and 40.4k output tokens, 8 minutes; 45 chunks: 32 stored, 6 proposals only, 7 skipped (5 refused by the privacy gate as restricted, 2 none returned), 0 unaccounted; 181 observations on 57 registry parameters (31 conflicting), 60 proposals pending review, 4 items rejected; 47 of 181 values were replaced by their verbatim quote; 0 quotes outside the source; key recall 1.0 and conflict recall 2 of 3 (C1, C2) against a draft expected-key list the owner has not verified. C3 cannot be found by design (identifiers are not model-extractable and are masked). Gemini rated every item `high`, so its confidence is not a useful signal. Run-to-run variance is large (the v2 runs stored 145 and 181 values). Billed cost not computed.
- Open: restricted chunks (member and declared-condition tables) are withheld from Gemini and not captured; identity fields are captured only by local rules and not stored (identifier keys forbid model extraction); register the extractor as a `model-gateway.js` task; keep block boundaries in stored OCR pages; owner verification of the expected-key list; PostgreSQL repository; consent wording for the Gemini step needs legal review.
- Follow-up (2026-10-19, after the live run review): the v2 run sent personal data to Gemini that the gate missed: e-card member IDs and dates of birth under a `Member ID | Date Of Birth` table header, ICD-10 code tables and loading reasons for named members, and `Aadhaar Number | ... | PAN | ...` pipe pairs. Privacy gate v4 reads pipe-table headers and row labels: identity columns are minimised by header, health columns in member tables and every cell of an ICD table become `<HEALTH_n>`, and a cell holding a placeholder or a digit is never a label. A no-network sweep of the sample's 40 sent chunks and titles finds 0 dates of birth, member IDs, ICD codes, condition names, Aadhaar tails, PAN, policy number or household names. Known over-redaction: the intermediary name and code row is masked.
- Independent read-only review (Opus) of that first fix: FAIL on three P1s, all addressed. (1) A variation stored as `extracted_unverified` silently resolved to the last subject's value; (2) a model-invented subject could hide a contradiction as a variation; (3) table headers were lost at page breaks, blank lines and chunk-part splits. Gate fixes: headers carry over non-table lines, every table row fails closed on ID-shaped cells and whole-cell dates (product UINs and policy-period dates kept), the sectioner repeats a table's first row in each part, edge pipes are trimmed, box-drawing separators, numbered and abbreviated headers, member tables without a name column, health label pairs, label runs that stop at the next label, and `Pan India`/hospital/customer-care contact labels are not personal. The P2/P3 findings were fixed with tests from the reviewer's probes; tab-separated tables and headers split over two lines are still not handled.
- Conflicts (owner decision, ADR 0006 amended): readings contradict only when comparable (same normalised kind, or both at most 60 characters) and different. Every key whose readings differ gets an entry and stays `conflicting` unless Gemini selects one of that group's own quotes; the selection is stored `extracted_unverified` with reason `model_selected_from_conflict`, every reading is kept, and the household confirms. Per-subject variation needs subjects printed in the chunk sent (`subjectInSource`) and is never resolved to one value; non-comparable readings are `context_differs`. Only contradictions are reported as conflicts. Not re-run live (billable); the selection prompt is untested against Gemini.
- Owner instruction (2026-10-19): merged to `main` without the full check suite, CI or a re-review of the second round. Affected tests ran once (113 pass); `npm run check`, `npm run eval:safety` and PostgreSQL tests were not run on the final state.
- Correction: `fact_conflicts` links evidence facts, not parameter observations, so its 0 rows are by design; a structuring conflict is the record's `conflicting` state and reason with every observation's page and block. Open: identity fields captured by local rules are still not stored (identifier keys forbid model extraction and the database allows `document_extraction` only under model authority; a deterministic extraction method needs a migration and an ADR 0003 decision); stored OCR pages still lose Sarvam blocks; no runtime route calls structuring.
- Repository clean-up: untracked (kept locally, now ignored) LinkedIn and marketing exports, a dated screenshot, the old `waymark` brand files and the Figma plugin zip; none were referenced. `.gitignore` also covers `*.sqlite` files.

## Block 2 Sarvam Document AI implementation (2026-10-19)

- Added a modern Sarvam `/doc-ai/v1` digitise transport behind `SARVAM_OCR_ENABLED`, which defaults off.
- Clean PDFs are split in a permission-restricted child into batches of at most 10 pages. Tests cover
  1, 10, 11, 47 and 100 pages and verify exact original-page order.
- Live OCR requires a separate, document-specific consent grant for recipient and actor `sarvam`.
  Consent is re-checked before page persistence. Revocation erases derived pages without deleting the upload.
- Added authenticated OCR start and refresh routes. Duplicate starts return the existing active or completed job.
  Polling defaults to a two-second minimum and a 15-minute deadline. Durable jobs resume after restart.
- Provider POST calls are never retried. Explicit job retry is limited to failures proven to occur before
  dispatch. Consent is re-checked immediately before every segment POST.
- Sarvam HTTP 403 is classified as a neutral provider refusal because current documentation uses it for both
  invalid credentials and other forbidden requests. HTTP 402 remains the separate credits or entitlement failure.
- Provider results that hit a transient local transaction failure retain their provider reference and can be
  reconciled by refresh without another billable submission. OCR lifecycle audits contain no job ID or text.
- Raw provider payloads are not stored. Partial, missing, duplicate or reordered results fail closed. Required
  terminal usage counters must also report every segment page processed successfully with zero failed pages.
- Local end-to-end proof uses a mocked Sarvam HTTP boundary. A real Sarvam call, accuracy corpus, billed-cost
  check, account rate-limit check and retention confirmation are still unverified.
- Current `main` is not green on GitHub. CI run `39209055663` fails the pre-existing PostgreSQL/SQLite
  `julianday` parity case for `2026-01-01T24:01`. CodeQL run `39226432972` completes analysis but GitHub
  rejects the SARIF upload because CodeQL default setup and the advanced workflow are both enabled. These
  failures are outside this Sarvam slice and are not evidence against the local Sarvam checks.
- Sarvam's public docs expose no cancellation or deletion endpoint. Local invalidation is implemented and
  unresolved remote cancellation is recorded. This is not proof of provider-side deletion.
- Active plan: [block-2-sarvam-document-ai.md](../exec-plans/active/block-2-sarvam-document-ai.md).

## Block 1 audit work in progress (2026-10-19)

- Based on `fd2a105`. The upload panel supports per-file document types, editable filename-based suggestions and drag-and-drop. These suggestions do not inspect document contents or link policies.
- File-backed test fixtures use the allowed `.local` directory without changing the production database path restriction. The PostgreSQL date-parity regression remains open.
- No checks or tests were run for these changes, at the owner's request. This is not evidence that the changes work or that Block 1 is complete.
- Azure staging, private scanning, PostgreSQL runtime migration, backup and restore, broader document compatibility, policy linking and production readiness remain open.

## Objective

Phase 0 of the production plan of action: close the unfinished evidence-completion work and establish a verified baseline. Intake and corrections: [p0-baseline-intake.md](../exec-plans/completed/p0-baseline-intake.md). Original slice intake: [evidence-completion-mvp-intake.md](../exec-plans/completed/evidence-completion-mvp-intake.md).

## Classification and state

```text
TASK CLASS = S2
CERT = READY (code gate green)
PHASE 0 GATE = REVIEW 3 PASS (no P0/P1; P2 fixed); pending owner approval
PHASE 1 = P1-A + P1-D integrated (Section 2, review PASS); P1-B PostgreSQL: S3.1 merged, review hardening in progress, S3.2/S3.3 open; P1-C governance open
PRODUCTION READINESS = FAIL
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
- Docs: restored `docs/agent-tooling.md` (and `docs/CERT.md`, later folded into `AGENTS.md`). `docs/evidence/` is untracked and ignored.

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

## Section 3 (P1-B PostgreSQL): S3.1 schema foundation

PR #8 merged to `main` at `5b5fef5`. Review hardening branch: `codex/p1b-s31-hardening`. Handoff: [p1b-handoff.md](../exec-plans/active/p1b-handoff.md).

- PostgreSQL 17 baseline migrations equal SQLite 001–006. The runner, pool factory, schema validation, `julianday(text)` port and isolated database test harness are implemented. Runtime is still SQLite.
- The independent S3.1 review failed on one P1 and four P2 issues: `TRUNCATE` bypassed row triggers; temporary tables could shadow guard lookups; an ICU database named `C` could pass validation with incompatible ordering; URL timeout parameters overrode pool policy; a second migration runner leaked a raw lock-timeout error.
- SQLite migration 007 and PostgreSQL migration 003 add missing fact and registry-pin `DELETE` guards. PostgreSQL migration 003 also adds six `TRUNCATE` guards, fixes all project function search paths and revokes default `PUBLIC` temporary-schema and protected-table truncate privileges. Pool settings now reject zero and strip URL overrides. Migration locking waits outside the ordinary lock timeout, redacts driver errors and destroys a connection if unlock or timeout restoration fails. Validation now checks locale provider, ordering and function search paths.
- Catalog: 41 tables + `schema_migrations`, 85 foreign keys, 64 indexes, 58 shared row triggers (49 critical) and 126 CHECKs. PostgreSQL adds six required statement triggers. The original 14 of 14 mutation checks detect their mutations; hardening tests also detect missing guards and unsafe function search path.
- Re-review (Opus, read-only): FAIL on two P2s, both outside the earlier five findings, which are confirmed fixed. P2-1 (fixed): the runner kept `lock_timeout = 0` for every migration statement, not only the advisory-lock wait, so DDL could queue indefinitely; it now restores the pool setting as soon as the lock is held. P2-2 (fixed, see below): `evidence_facts` blocked UPDATE, DELETE and TRUNCATE with no redaction exception and had no erasure path, so revocation could not erase its `value_json` or `source_page_id`. The gap predated S3.1 (UPDATE was already blocked); the new guards made it explicit. P3s fixed: extension-owned functions are excluded from the search-path check; `replication` is stripped from `DATABASE_URL`. Each new test was mutation-checked.
- Current evidence: with PostgreSQL, `npm run check` passes architecture, 398/398 tests and build. Without `TEST_DATABASE_URL`, 362 pass and 36 PostgreSQL tests skip visibly, 0 failures. Safety eval no failures; `git diff --check` clean.
- Remaining P3: `julianday` depends on `standard_conforming_strings` and differs from SQLite on fractions longer than about 310 digits; catalog parity still relies on behaviour tests for most function definitions; `REVOKE TEMPORARY` is a database ACL, not schema, so a restored or cloned database regains defaults and validation does not check it (owners and superusers keep TEMP and TRUNCATE anyway; the S3.2 least-privilege runtime role closes this); the advisory-lock wait is still bounded by `statement_timeout` (default 30 s), so a second runner fails with a generic coded error if the first takes longer.

### P2-2 fix: evidence fact erasure

Owner chose a redaction carve-out over an accepted risk (2026-10-18). Plan: [evidence-facts-erasure.md](../exec-plans/active/evidence-facts-erasure.md).

- SQLite `009_evidence_fact_redaction.sql` and PostgreSQL `005_evidence_fact_redaction.sql` (expand-only) add `redacted_at` and `redaction_reason_code` with a pairing and format CHECK. The UPDATE guard keeps its name and message and exempts one update: value and locators nulled, state UNKNOWN, redaction stamped, every other column unchanged. A redacted fact is final; DELETE and TRUNCATE stay blocked. New critical triggers: `evidence_facts_redaction_insert` (no redacted inserts), `evidence_facts_erased_document_insert` (no fact may cite a document whose erasure has started) and `evidence_facts_redact_on_document_erasure` (safety net on `deletion_requested` or `deleted`, with a migration backfill for documents already in those states). PostgreSQL recreates `unresolved_evidence` so its column list matches SQLite.
- `ConsentRepository.eraseDerivedRunData` redacts facts sourced from pages of the affected documents, household-scoped when known, with a counts-only `evidence.facts_erased` audit event. Revocation and the commit-time stop both reach it; revocation runs it before the lifecycle change, so the audited path wins over the trigger.
- Forward fix: the PR review fixes were pushed after #13 merged and edited the merged migrations 009/005. They were moved, unchanged in effect, into SQLite `010_evidence_fact_redaction_hardening.sql` and PostgreSQL `006_evidence_fact_redaction_hardening.sql` (the stricter timestamp format is a trigger on both engines, because SQLite cannot tighten a column CHECK and the catalogs must match). Merged migrations stay immutable.
- Independent read-only review (Opus): PASS, no P0–P2. Fixed: `redacted_at` must be an ISO UTC timestamp (it only had to be non-NULL; observations keep that gap); `data.md` anchors. PR review (Codex, cubic) then added the erased-document insert guard, the backfill, an exact `YYYY-MM-DDTHH:MM:SS.sssZ` format plus `julianday` validity (day overflow such as Feb 30 still normalises, as everywhere `julianday` is used), the `deleted` transition and full metadata assertions; four more mutations (backfill removed, erased-document guard disabled, `julianday` check removed, format loosened) each fail 1 to 3 tests. The PostgreSQL backfill has no direct test; the SQLite backfill does. Open P3s: redacting a fact leaves open `fact_conflicts` rows open; a whole-run commit-time stop does not reach facts (no run link); the commit-time path is tested through `eraseDerivedRunData` directly, not `stopForRevocation`; no test covers a document named only in a grant's scopes; observations still accept any non-NULL `redacted_at`.
- Not covered: facts without a document source (statements, replies, calculations) have no grant link; consent expiry keeps facts (as F3). No production code writes facts yet.
- Evidence: with PostgreSQL, `npm run check` passes architecture (120 files), 493/493 tests and build. Without `TEST_DATABASE_URL`, 456 pass and 37 PostgreSQL tests skip visibly, 0 failures. Safety eval no failures; `git diff --check` clean. Six mutations (carve-out removed, household column unguarded, `effective_at` retained, safety net removed, repository call removed, insert guard removed) each fail 2 to 7 tests across `tests/evidence-fact-redaction.test.mjs` and `tests/postgres-triggers.test.mjs`.

## Section 4: Block 1 input (document ingestion)

Branch `claude/block1-input`, stacked on the S3.1 hardening PR. Owner decisions (2026-10-18): ClamAV via clamd, encrypted local store behind the byte-storage port, 15 MiB, Block 1 before S3.2. Design: [block-1-input.md](../architecture/block-1-input.md), [pipeline-blocks.md](../architecture/pipeline-blocks.md), [ADR 0005](../adr/0005-document-intake-validation-and-scanning.md).

- Routes: `POST /api/v1/cases/{caseId}/documents` (raw `application/pdf`, `Idempotency-Key`, kind `policy_wording|policy_schedule|endorsement`, uploader grant), `GET /api/v1/cases/{caseId}/documents`, `GET /api/v1/documents/{id}` with user-facing statuses. SQLite migration 008 and PostgreSQL migration 004 (expand-only) add `scan_attempts`, `next_scan_at`, unique indexes for live content and logical versions per household, and a work index.
- Security: authorization before any body byte; 15 MiB cap on declared and streamed length; bounded PDF inspection (encrypted, active content, page limit, deflate bombs); encrypted storage with validated storage keys; row, audit and idempotency in one transaction; quarantine until a clean clamd scan; infected or tampered bytes deleted; revocation now also deletes encrypted bytes through the worker.
- UI: upload panel with client validation, per-file progress, retry with the same idempotency key, polling while checks are pending.
- Builders (worktrees, disjoint files): Opus for PDF inspection; Sonnet for the clamd scanner and worker, UI and docs. Central wiring, repository, service and tests by the central owner.
- Evidence: with PostgreSQL, `npm run check` passes; `tests/document-upload-api.test.mjs` runs the journey over HTTP (five uploads, restart, cross-household denial, validation, idempotency races, clean and malware scans, revocation, capacity, storage faults); six security guards mutation-checked (two gaps found and closed with new tests). A manual run against the real server confirmed five uploads, a rejected JavaScript PDF, cross-household denial, ciphertext at rest and persistence across restart.
- Independent security review round 1 (Opus, read-only): FAIL with two P1 and three P2, all fixed with tests and mutation checks. P1-1: PDF active content and `/Encrypt` could hide inside skipped stream bodies or untyped object streams; the inspector now rejects object syntax in skipped bytes, comments and strings and treats any stream with `/N` and `/First` as an object stream (the reviewer's probe is rejected). P1-2: a scanner outage stranded documents in memory and 50 stranded rows starved revocation erasure; scheduling is now on the row and deletion work comes first. P2-1: unique indexes close the different-key duplicate and version races. P2-2: clamd reports over-limit files as clean by default; required settings are in `docs/runbooks/clamav.md`. P2-3: transient disk errors no longer delete documents. P3s fixed: tombstones drop the content hash and storage reference, orphan sweep, worker stops before the database closes, case 404s normalised on document routes, document-scoped grants cannot collect new documents, replays show current state, long filenames return `INVALID_FILENAME`, scanner and storage codes registered. Accepted P3: capacity caps can be exceeded slightly under concurrency.
- Review round 2: PASS. Residual P3s fixed: failed byte deletions defer on the row instead of exhausting in memory; a missing object is rejected only after three attempts and only when the storage root exists (an unmounted volume defers); a scanner that keeps returning an error is rejected after ten attempts (`SCAN_FAILED_REPEATEDLY`); deletion drops the upload's idempotency records and the hourly sweep purges expired idempotency rows in every scope. Open P2 (documented): the PDF check is a heuristic in the API process (an object header split by a comment inside skipped bytes is not detected); clamd PDF scanning is required and a sandboxed parser is milestone 2b.
- Evidence (final): with PostgreSQL `npm run check` passes (485/485, build); without it 449 pass and 36 skip; safety eval no failures; `git diff --check` clean. Every review fix has a mutation-checked test.
- Not verified at merge: a real ClamAV daemon (fake clamd only); the UI in a browser against the real route; Azure.
- Verification follow-up (branch `claude/block1-verify`, 2026-10-18):
  - Real ClamAV 1.5.4 (Homebrew) with the runbook settings, signatures main 63 / daily 28157 / bytecode 339 (freshclam printed `NULL X509 store` for the `.sign` files; every database test passed). Opt-in `tests/clamd-integration.test.mjs` (skips unless `CLAMD_TEST_HOST`): PING, EICAR `blocked` with `Eicar-Test-Signature`, synthetic PDF `clean`, 15 MiB input `clean`, 17 MiB input `SCANNER_ERROR` non-retryable (clamd logged `INSTREAM: Size limit reached`). 5/5 pass.
  - API with `DOCUMENT_SCAN_MODE=clamd`: two uploads went `Received, waiting for security checks` to `Passed security checks` within 8 s; three uploads left pending under `disabled` were scanned clean after restart (rows `malware_status=clean`, `scan_attempts=0`). ClamAV's EICAR signature matches only at offset 0, so an EICAR string inside a PDF scans clean and a raw EICAR file is rejected as not a PDF before scanning: the blocked path is proven at scanner level with real clamd and through the API with the fake clamd only.
  - Browser (dev server, synthetic PDFs, built-in browser): three defects found and fixed. (1) The panel was pre-filled with the coverage grant, so every upload failed with `CONSENT_REQUIRED` and the list returned 403: the UI now asks for a separate `document_processing` grant (document `collect`, case `source_pack_metadata` read for the uploader) through an explicit "Allow document upload" action (draft copy, legal review). (2) JSON API errors dropped the server code, so list failures showed "The upload failed": the client now keeps a validated `code` and `status`, and list failures get list wording. (3) The list did not reload when consent arrived: it now reloads on case or consent change and is not requested without a grant ID. Verified after the fixes: upload of 6 MB and 347 B PDFs (201), damaged PDF shows the damaged message with Retry, a wrong consent ID fails and Retry with the corrected ID succeeds with the same idempotency key, a duplicate shows 409 wording, the list refreshes and polls to the final status. Progress bars reached 100%; intermediate progress was not observable on loopback.
  - Azure: read-only audit plus `docs/runbooks/azure-staging.md` (Key Vault and managed identity, scan mode, C-collation database, `/api/v1/ready` detail, private clamd, deploy workflow with rollback). Nothing changed in Azure. Audit findings are kept private (this repository is public); the runbook's read-only pre-flight checks reproduce them.
  - Independent read-only review (Sonnet reviewer): fixed a stale document list after switching case, a list error landing on the wrong case, list refreshes wiping file-selection messages, the document grant surviving a new policy case, consent copy that understated the `collect` scope (it covers the subject's insurance documents, not one case), and a possible race in the over-limit clamd test (now accepts `SCANNER_ERROR` or `SCANNER_UNAVAILABLE`, both deferrals, never clean). Runbook fixes: secret files written under `umask 077` without trailing newlines, admin password from a file, `\password` in psql, data-copy step before changing `DATABASE_PATH`, Key Vault private endpoint before disabling public access, NSG before clamd starts, scanner check before switching scan mode, custom deploy role instead of `Website Contributor`. Accepted for now: each page reload asks for a new document grant (UI state is per tab); follow-up to reuse an active grant.
  - Checks: with PostgreSQL `npm run check` passes (492 tests: 487 pass, 5 skip = the opt-in clamd tests), `npm run eval:safety` no failures, `git diff --check` clean.
- Accepted: the grant-household check in the upload service is a second layer behind the consent subject check and the insert trigger, so it is not reachable through the API.

## Accepted risks and known limitations

- Consent expiry (as opposed to revocation) keeps observations, run excerpts and task outputs until a retention policy is decided (review F3, owner decision).
- Conflict detection reads at most 500 observations per parameter.

- The hardcoded `+91` handoff fallback was removed with the legacy demo API (`src/orchestration/` no longer exists).
- `docs/evidence/` still exists in public git history until the owner decides on a purge.
- npm audit high: `source-map-js` (GHSA-68fv-2mgg-jv7q), reached only through `vite` at build time. Handled in Phase 1 (P1-D).
- Over-redaction: claim or admission dates on member rows are treated as dates of birth; capitalised two-word phrases before relationship words may be over-redacted.
- A lone known first name is kept by design. Lower-case names in tables are caught only when they are known household values; third-party names (for example a non-member nominee) depend on pattern rules.
- At most 40 parameters per model request. Further matched keys stay `requested`.
- Parameter records point at a placeholder `UNCLASSIFIED:<hex>` policy and cannot be re-pointed. A classified policy gets new records (Phase 4 design item).
- No UI flow grants a document `derive` scope naming `google-gemini`. Live analysis is reachable through the API only (Phase 2, P2-D).

## Section 2: Phase 1 contracts and CI (P1-A + P1-D integration)

- P1-A (contracts): workflow v6 with graph checksum `39384121…e9fa1`; frozen task invocation, result envelope and persistence-port contracts in `src/contracts/`; one stable error-code registry with a drift test; `WORKFLOW_VERSION_MISMATCH` gate on invocation, write and read (a run with no version is rejected too); ADRs 0001-0003.
- P1-D (CI security): `CI / verify` (npm ci, architecture, tests, build, safety eval on Node 22), CodeQL, dependency review (fails on high), Dependabot for npm and actions; every action pinned to a verified SHA; `SECURITY.md`.
- Central fixes: F-API-1 (analysis-run errors now return coded bodies and their registered status, e.g. `IDEMPOTENCY_CONFLICT` 409). `errorResponse` hides driver, runtime and operating-system messages behind `BACKEND_REQUEST_FAILED`; request-body errors keep coded 415/413/400.
- Verification: `npm run check` passes (114 source files, 397/397 tests, build); safety eval no failures; `git diff --check` clean. New tests were mutation-checked.
- Independent review (Opus, read-only): first pass FAIL on one P2 (driver error messages reached clients) plus doc/test gaps; all fixed. Re-review PASS. Accepted P3: F4 (model-assist execution inferred from model metadata).
- Not verified locally: the GitHub-hosted CodeQL and dependency-review runs (need the repository settings below).
- Known: one unreproduced intermittent failure in `pre-dispatch-consent.test.mjs` (suspected same-millisecond task claim ordering); watch CI.

## Section 2b: lean AGENTS.md and legacy demo API removal

Owner decisions (2026-10-16): apply the lean AGENTS.md model, CoverSaath is the canonical product name, remove the legacy demo API.

- Instructions: the 1,103-line AGENTS.md/CLAUDE.md copies were replaced by a lean root `AGENTS.md`; `CLAUDE.md` is the one-line import `@AGENTS.md`. The current migration removes duplicated backend rules from root, keeps root below 100 lines and adds a 12-line `src/backend/AGENTS.md` above the focused database, AI and integration rules. Product docs stay in `working/` and `building/` (registry v1 cites `building/policy-parameters.md`). Remaining `knowvia` identifiers are renamed later with a compatibility plan.
- New source-of-truth docs: `docs/architecture/{system,data,security}.md`, `docs/runbooks/local-database.md`. No `scale.md` until workload numbers exist.
- Legacy removal: `src/core`, `src/orchestration`, `src/models`, `src/adapters`, `scripts/orchestration-demo.mjs`, `ENABLE_LEGACY_DEMO_API`, the memory-only demo cookie, `@ai-sdk/openai`, `OPENAI_API_KEY` and `HUMAN_HANDOFF_PHONE` are gone. Only `/api/v1/*` is served; other paths return 404 `ROUTE_NOT_FOUND`, also with the old flag set. 38 legacy-only tests deleted; safety-eval assertions retargeted to canonical validators; new tests for removed routes, the loopback guard (Host, Origin, Sec-Fetch-Site; previously covered only by a legacy test) and the integrations HRMS status.
- Agents: Sonnet 5.5 for legacy removal and architecture docs (separate worktrees, no shared files); Opus 5.5 central and read-only review.
- Verification: `npm run check` (108 source files, 360/360 tests, build); safety eval 23/23, no failures; `git diff --check` clean; lockfile in sync; new guard test mutation-checked per guard line.
- Review (Opus, read-only): PASS, no P0-P2. P3s fixed: stale doc facts and line references, the dropped untrusted-text and legal-wording rules restored in `AGENTS.md`, optional live-model env names documented, `.local/runs` cleanup note. Open P3s: `src/agents/coverage-orchestrator.js` has no runtime caller; no integration test for security headers and 429; `retention_records` and the audit hash chain are written or defined but never read or verified; document-intake storage is not wired to a route.

## Next action

1. Finish the S3.1 hardening re-review, then merge its PR before starting S3.2.
2. Start S3.2 WP0 from updated `main`. Follow [p1b-handoff.md](../exec-plans/active/p1b-handoff.md).
3. Owner: repository settings from P1-D. CodeQL default setup is enabled and conflicts with the pinned advanced workflow. Switch CodeQL to advanced. Also configure dependency graph, Dependabot alerts and security updates, secret scanning with push protection, private vulnerability reporting, read-only Actions token, fork approval and a `main` ruleset requiring `CI / verify`.
4. Owner: delete the local `.local/runs/` folder left by the legacy demo store.
5. Owner decisions still open: consent-expiry retention, second maintainer, Azure and residency owner, `docs/evidence/` history purge.
