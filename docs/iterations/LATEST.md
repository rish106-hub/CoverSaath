# Latest iteration

## CodeQL remediation candidate (2026-10-21, `codex/codeql-alerts-2026-10-21`)

- Prepared fixes for all 10 CodeQL alerts open on `main`: provider smoke scripts no longer read secrets from `.env`; dynamic score maps use `Map`; migration paths reject links and malformed filenames; intentional repository-owned migration DDL has narrow CodeQL suppressions.
- Removed `.github/workflows/codeql.yml` because GitHub default setup is already configured with the extended query suite and the remote-and-local threat model. This avoids the failing default-versus-advanced setup conflict without changing repository settings.
- Added synthetic regression coverage for hostile `__proto__` keys and migration-file links. Independent read-only security review found no blocker; its one low reliability finding was fixed and re-reviewed.
- Checks: `npm run check` passed with 1,081 passed, 74 expected skips and 0 failures; `npm run eval:safety` passed 28/28 with zero network calls; `git diff --check` passed. PostgreSQL integration remained skipped without `TEST_DATABASE_URL`.
- A fresh CodeQL result still requires the branch to be pushed and scanned. Do not claim the GitHub alerts closed until that scan completes.

## Closeout status (2026-10-20, `main`)

- Pushed to `main` with CI green (PostgreSQL 17 suite included: migration 013, parity, runner, trigger tests).
- Done: obfuscated-email privacy fix; typed twins; Phase 3 candidate association; Phase 4 reviewer grants and review API with an independent review (fixed); Phase 5 rules; Phase 7 handoff and journeys; CodeQL script fixes (`smoke-test-gemini` no longer logs key fragments or puts the key in the URL, duplicate function removed; null-prototype score maps).
- CodeQL workflow still fails: "advanced configurations cannot be processed when the default setup is enabled". Fix needs a repository setting (disable default setup, or delete `.github/workflows/codeql.yml`). Not changed without approval. Remaining alerts are in dev scripts, `migrate.js` (runs repo-owned SQL files) and test support; none were dismissed. Status: CODEQL_PARTIALLY_RESOLVED.
- Phase 6: `curated-sources.js` stays empty. No official IRDAI or insurer record was independently verified (no external access used). Nothing invented.
- Still open: fresh independent review of the final privacy gate (BLOCK2_QA_PENDING), holdout evaluation on untouched real policies, multi-insurer accuracy, legal review of consent wording, staff access model for the independent reviewer, full Block 4 engine (out of scope).

## Phase 5: deterministic rule completion (2026-10-20)

- Waiting-period completion needs a verified `continuous_cover` fact (`since`, `uninterrupted`, optional `creditedPriorCover`), a known waiting period and an as-of date. A policy start date, model-reported continuity, an interrupted record or a missing piece gives `unknown` with a reason (`continuity_not_evidenced`, `cover_interrupted`, `as_of_date_missing`, `waiting_period_not_established`). The contract month-counting rule is still unverified.
- Stricter typed values: zero or negative caps, zero percent limits, zero deductibles, bps above 10000, bad restoration and bonus shapes, impossible dates and non-boolean flags never become `known` (they fall back to `unverified` with `value_malformed`).
- Results carry `conditional` when conditions, exceptions or overrides apply (also in the handoff). Top-up layers get a coordination note; limits are still never added.
- Tests: `tests/decision-catalogue-rules-phase5.test.mjs`. One existing test now supplies a `continuous_cover` fact instead of `policy_period/continuous_cover`.
- Not done: network, cashless and claim-document rules were only re-run, not extended; no real-policy evidence; conflicting override evidence is surfaced through `conflict`/`conditional`, not adjudicated.

## Phase 7: Block 4 handoff and journey tests (2026-10-20)

- `handoff.js`: `toHandoff` / `assertHandoffContract`, contract `decision-handoff/v1`; returned by `GET .../decision-catalogue?answerId=&format=handoff`. States: known, unverified, conflicting, missing, not_permitted, not_selected, available_not_selected, dynamic_check. A value exists only when `known` (needs citations and a verified association); a model or unverified value is `candidateValue` only. Open-ended findings, dynamic checks, reviews, conflicts, completeness counts and processing version are included. No recommendation logic.
- `tests/block3-journey.test.mjs`: the nine minimum scenarios at facts -> rules -> handoff level. `tests/catalogue-review-api.test.mjs`: one real-endpoint journey (upload, OCR, question, typed candidate, independent review, handoff, consent revocation erasing clauses and reviews).
- Not covered: multi-document uploads through the API (scenarios 3, 6, 7 use synthetic reviewed batches, not uploaded files), real insurer documents, a Block 4 consumer beyond the contract assertions.

## Phase 3: candidate document-to-policy association (2026-10-20)

`association.js`: a document is a candidate member of a logical policy (`pol-` + digest) only when its own clauses print exactly one policy number; several numbers is `ambiguous`, none is `unestablished`. The number is never returned and the uploader kind is never used. Facts now sit on their candidate policy (personal and corporate separate); the catalogue returns `documentAssociations`. Association is never verified by this path: a reviewer's `attestsPolicyAssociation` (independent grant) names the fact's own policy. Not built: endorsement/version relationships beyond a shared number, member enrolment evidence, a stored association review, ADR 0007. Tests: `tests/decision-catalogue-association.test.mjs`, API assertions in `decision-catalogue-api.test.mjs`.

## Phase 4: reviewer authority and review API (2026-10-20)

On branch `closeout/block2-block3-codeql`, not pushed. Design and limits: [ADR 0009 part 2](../adr/0009-reviewed-facts-and-decision-catalogue.md).

- Migrations SQLite 017 / PostgreSQL 013: `catalogue_reviewer_grants`, `catalogue_reviews` (immutable, scope trigger, erasure trigger). PostgreSQL side not run locally.
- `CatalogueReviewRepository`, review logic in `decision-catalogue-service.js`, routes `POST .../decision-catalogue/reviews` and `POST /households/{id}/catalogue-reviewers`. Independent reviewers have no route (operator tooling only).
- `tests/catalogue-review-api.test.mjs` (8 tests): forged authority ignored, household confirmer capped at `reported`, independent reviewer reaches `known` only with source and association attestation, rejection/dispute/supersession, idempotency, audit has no fact content, erasure.
- Still open: independent read-only review of this slice, a staff access model (no production holder of the independent grant), PostgreSQL run, legal review, verified document-to-policy association beyond the reviewer attestation.

## Closeout slice: obfuscated email, typed twins, CodeQL hardening (2026-10-20)

Base `main` `be3b102`. No provider call, no migration.

- Privacy: spelled-out emails ("name (at) host (dot) com", "[at]", "{at}") are removed from storage and model payloads (`tests/privacy-gate-obfuscated-email.test.mjs`). A probe of phones, Aadhaar, PAN, names, OTP, card, token, split cards and addresses found no other leak; this is a probe, not a fresh independent review. Block 2 security status: **BLOCK2_QA_PENDING** (fresh independent review of the final gate still required; address detection stays heuristic and fail-open for the residuals listed below).
- Block 3: `typed-candidates.js` adds a typed twin beside a finding only when exactly one cited clause line names the subject and states one unambiguous value (room rent, ICU, copay, waiting period, sublimit, not-opted add-on). `Rs`/`INR`/`₹` is required for money; bare numbers get no twin. Twins stay `extracted_unverified` (model origin) and never become a `known` rule value. API test asserts this through the real endpoint. Status: **BLOCK3_IMPLEMENTED_QA_PENDING**.
- CodeQL: `js/remote-property-injection` objects in `coverage-report.js` and `eval-scorer.js` now null-prototype. Not re-scanned: the separate CodeQL workflow fails with "advanced configurations cannot be processed when the default setup is enabled". Fix needs a repository setting (disable default setup, or drop `codeql.yml`); not changed without approval. 11 alerts open at start (mostly scripts and tests; `migrate.js` runs repo-owned SQL files). Status: **CODEQL_PARTIALLY_RESOLVED**.
- Not built in this slice: authenticated reviewer role and fact storage (needs ADR 0009 schema decision), verified document-to-policy association, curated official-source data (none verified, left empty), Block 4 consumer, multi-insurer holdout evaluation, legal review.

## Block 3 first slice: decision catalogue (2026-10-20)

Merged to `main` (PR #37, `be3b102`) with the privacy gate fixes from `optimistic-kare-0c8f4b`. No provider call, no migration. Design: [decision-catalogue.md](../architecture/decision-catalogue.md).

- `src/features/decision-catalogue/`: facts bridge, applicability, 12 typed rules, cross-policy separation, official-source validator, `decision-catalogue/v1` handoff. Derived on read from live clauses, so erasure needs no derived-store path.
- Authority is a batch attestation (`origin`, `reviewStatus`, `verifiedPolicyIds` set by the calling channel). A candidate cannot claim its own authority. Deterministic facts are never ingested.
- Two independent read-only reviews: 15 then 10 findings, all fixed with tests. The final fixes (round two) had no third review.
- Checks: `npm run check` 905 tests, 852 pass, 0 fail, 53 skipped; `eval:safety` 0 failures; `git diff --check` clean.
- Wiring (same day): `GET /api/v1/cases/{caseId}/decision-catalogue?answerId=&asOf=&memberId=` (`decision-catalogue-service.js`, `readForCatalogue` in the evidence service). Read only, no model call, no write. Same consent re-check, currency check and 404 rules as `/questions`; gated by the source-pack field (same as `/questions`, consent purpose pending legal review; owner chose to keep it). Adapter `from-answer.js`: facts are `model` origin, `user_statement` source type (the upload label is requester-set and kept only as `declaredSourceType`), policy `unresolved`, association unverified. Tests: `tests/decision-catalogue-api.test.mjs`. Wiring review: 2 high, 2 medium fixed. Typed rules stay unknown on this path (findings are open-ended `finding.*` facts); mapping findings to typed values is not built.
- Not done: official-source curated data, reviewer role and fact storage (proposed in [ADR 0009](../adr/0009-reviewed-facts-and-decision-catalogue.md)), Block 4 consumption, findings-to-typed-values mapping. Facts now carry `sourceDigests` taken from the evidence index. (Superseded by Phase 5: the waiting-period rule no longer assumes a policy start date is continuity; see below.)

## Address residuals R1-R3 and review gaps: privacy gate v9 (2026-10-20)

Uncommitted on `codex/backend-first-layout`. No provider call.

- Gate `knowvia-privacy-evidence-v9` (v8 plus the review-gap fixes below). R1: a capitalised place word right before a contiguous 6-digit PIN ("Sample Nagar, Testville 560001") is an address. R2/R3: `redactAddressFragments` redacts a comma-chained run of address-shaped pieces that holds a house-number start (Flat/House/Door/H.No; Plot/Shop need 3+ pieces), a landmark with a place noun (Near ... Temple), a locality/street name (Nagar, Colony, Road, Heights...) or a bare number start with 3+ pieces. A state line after a run is absorbed.
- Decision: a standalone state or city name is kept (zone and territorial wording needs it; it does not identify a person). Not legal review.
- Version pins edited in `privacy-gate-address-closure` and `privacy-gate-r4` tests (v7 to v9). No control weakened.
- Independent read-only review: no blocker. v9 closes most of its gaps: an inline pass (`redactInlineLocalities`) redacts a locality name inside a sentence or on a long comma-less line (Nagar, Colony, Heights, Gali, Mohalla...; optional house number before and up to two capitalised place words after); hospital/insurer wording is judged per piece, and only a cell or line that OPENS with it (first two words, e.g. "Registered Office:") stays whole, so "Admitted at Sample Hospital, Sample Nagar, Testville" loses the locality; `;` splits runs like `,`; "Sector N, City" qualifies; Gali/Mohalla/Bazaar/Bazar added; a bare house-number line above a redacted address goes with it. Trade-off: an insurer address that does not open with public wording is now redacted (safe side).
- v9 second pass (same gate version): lowercase/OCR-lowercase lines get a stricter rule (strong suffix or house keyword + number + comma piece; only on lines with no capital letter); Devanagari locality words (नगर, कॉलोनी, विहार, मार्ग, गली...) with optional house keyword/number; spaced PIN "Testville 560 001" (not when amount or benefit words like copay/limit/sum/premium sit in the run); comma-less "Flat 12 Example Apartments Testville"; glued suffixes (Samplepur, ...halli) count only in a 3+ piece run that also holds a digit, because bare city names (Hyderabad, Ahmedabad) must stay for zone wording.
- Still open (fail-open, by design or unsolved): a comma-less line with no suffix word, no house keyword and no PIN ("12 Foo Bar Testville") is indistinguishable from prose; a bare city or glued-suffix locality with no digit in the run; mixed-case OCR lines with lowercase localities; Devanagari addresses without a listed locality word. Known false positive: "Basic Plan 123456" is redacted.
- Checks: `npm run check` 881 tests, 828 pass, 0 fail; `eval:safety` 0 failures, `check:architecture`, `git diff --check` clean. The G4 timing test sits near its 200 ms limit under full-suite load (flaked once at ~500 ms from a real O(n^2) in the new inline regex, fixed with a word-start lookbehind; later runs pass).

## Block 2 delta close-out: privacy v7, answer guards, retrieval tuning (2026-10-20)

Uncommitted on `codex/backend-first-layout`, base `d34c44d`. No provider call, no commit.

- Privacy gate `knowvia-privacy-evidence-v7`: PIN with irregular spacing or a "PIN:" label; address-shaped tails with no anchor; up to eight continuation lines; unlabelled "Flat..., City - PIN" lines and table cells; house-number forms ("Plot No 5") are not policy wording. Address-shaped text past the scan limits throws `PRIVACY_ADDRESS_UNCERTAIN` (a clause is withheld; `sanitizeEvidenceForModel` callers fail closed as for other restricted text). Tests: `tests/privacy-gate-address-closure.test.mjs`. Residual (not fixed): an unlabelled address with one comma, no dash, no house number and no PIN-adjacent digits context ("Sample Nagar, Testville 560001" alone); an unlabelled address whose locality has no PIN; non-Latin tails after an unlabelled address.
- Answer guards: a `covers` finding is demoted to conditions when its own row states a restriction or opt-out, or another row read says the named thing is "Not Opted"; the row is cited. v1 stored answers are served as stored (`pipelineVersion` v1, `pipelineCurrent: false`). Tests: `tests/policy-evidence-answer-regression.test.mjs`.
- Retrieval: `RETRIEVAL_TUNING` (stop words dropped, insurance synonyms, best hit of each list ahead of endorsement/schedule fill) is the default; `{}` restores the old behaviour. `npm run eval:retrieval -- --tuning '<json>'` measures a variant. Numbers in `retrieval-terms.js`. Tuned on the same 34-question set it was measured on (no untouched holdout).
- Master policy ingestion (local DB, read-only copy): 20 of 20 pages stored, 45 clauses, 45 FTS rows, one document and version. Only boilerplate header/footer/page-number and image descriptions are dropped. The live gateway limit (64,000) reads the whole policy; 48,000 would not.
- Checks: `npm run check` 862 tests, 809 pass, 0 fail, 53 skipped. `eval:safety` pass. `check:architecture` pass. `git diff --check` clean.

## Evidence answers: effect bucketing F-B and unnamed-subject unknown F-C (2026-10-20)

First-pass findings now carry a model-reported `effect` (covers, limits, excludes, conditions, informs), validated in code (unknown or missing becomes `conditions`; a `covers` quote that itself states a restriction is routed to `conditions`). Answers bucket by effect, not by the cited clause's keyword kind, so "Room Rent At Actuals" from a table labelled `exclusion` is covered. A deterministic unknown now says when a subject word from the (gated) question is named in no clause read. `INVESTIGATION_VERSION` is `v2`. Tests: `tests/policy-evidence-effect.test.mjs`; the B3 fixture in `policy-evidence-investigate.test.mjs` now supplies `effect` (strictly more accurate than kind-based bucketing). Independent read-only review done; findings resolved. Unverified: no live provider call, so real model effect labelling is unmeasured. Stored answers from `v1` have no `effect`. Subject check is noisy on the retrieved path and ignores words under 5 letters.

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
- Block 3 close-out: handoff/adversarial tests added (`tests/decision-catalogue-handoff.test.mjs`), CodeQL baseline recorded in `docs/architecture/decision-catalogue.md` (11 pre-existing alerts, none in Block 3). Reviewer role/storage and Block 4 consumption remain unbuilt, pending an ADR.

## Curated insurer products and reviewer view audit (2026-10-20)

- Research: [docs/research/2026-10-20-source-data-catalogue-reviewer-access.md](../research/2026-10-20-source-data-catalogue-reviewer-access.md). Most circular details there are secondary-sourced and need a read of the IRDAI primaries.
- Built: `src/features/decision-catalogue/curated-products.js`. Strict record (UIN, wording version, https URL, SHA-256, retrieval and check dates, page and quote per fact, curator and a different checker). Loads fail closed. `compareToCurated` compares a household's own facts with the curated terms for the one UIN its document prints; output is `curatedComparison` (informs only, never changes a fact or rule result). Tests: `tests/curated-products.test.mjs`.
- Superseded by the next section: curated records now also live in a checked-and-published workflow table (migration 018). The static list in `curated-sources.js` stays empty and its records can never be `verified`.
- `CURATED_PRODUCT_RECORDS` is still empty. Nothing was seeded: that needs a person to read each insurer's wording and a second to check it, plus a terms-of-use check per insurer.
- Independent-reviewer reads now write a `catalogue_reviewer.viewed` audit event before serving (no case content). If the audit write fails the read fails.
- Not done: redacted evidence packet for reviewers, staff access model, legal review of the reviewer purpose, change-detection fetcher.

## Trusted insurer sources and bounded reviewer access (2026-10-21, uncommitted, pending independent review)

- Verification is no longer derived from record fields. `validateCuratedProduct` always returns `verified: false`. A product is `verified` only when `CuratedProductRepository.listVerified()` reads it from a **published** submission: collected -> candidate -> checked -> published, each a separate state (SQLite 018, PostgreSQL 014, expand-only).
- Evidence: `source-verification.js` (pure, no network). SHA-256 of the exact bytes, one printed UIN that equals the record's, wording version printed, every quote on its stated page. Page text is curator-asserted, so the checker must also supply the SHA-256 of their own copy and state they read each quotation. Without page text nothing is machine-checked and the record says so.
- Authority: roles `curator` and `checker` live in `source_curator_grants` (operator tooling only, no route, at most 90 days, re-read on every request). The checker must differ from the collector (DB CHECK plus service check), so one human holding both roles is still refused. Routes: `GET /api/v1/curated-products/{id}`, `POST .../check`, `POST .../publish`; identity is the session, never a body field. Bytes are never returned.
- Maintenance: `revalidate` takes bytes a person downloaded (no fetcher exists, so no SSRF path). Same digest records the check. A different digest moves the old wording to `needs_revalidation` (it stops informing at once), opens a new collected submission, and needs a new proposal, a different checker and publication. Rows and archived bytes are never deleted (triggers).
- Reviewer grants: `catalogue_reviewer_grants` gained `expires_at` and `case_id`. An independent grant needs a case of that household and at most 30 days; expiry, revocation and case are re-checked on every read and write and inside the write transaction; an expired or revoked reviewer's past reviews count for nothing. A legacy independent grant with no expiry or case is inactive.
- Tests: `tests/curated-product-workflow.test.mjs` (13), additions to `catalogue-review-api.test.mjs` (3), PostgreSQL trigger test. Synthetic data only.
- Independent review (2026-10-21) found 1 P0 and 4 P1; fixed: digest withheld from reads, approval bound to the facts read (`factsSha256`), UIN/version attestation when no page text, PDF magic check, role re-checked inside the write transaction, state-transition and wider immutability triggers, reason/decision pairing, mismatch attempt audited after rollback, only the collector can open a changed-source submission. Also closed: a regranted independent reviewer no longer revives earlier reviews (`granted_at`); database triggers refuse an active independent grant without expiry and household case; optional `CURATED_SOURCE_HOSTS` allowlist; operator CLI `scripts/curated-source.mjs` (grant/revoke role, register, propose, revalidate; local files only, no network). Open by decision: a published product stays verified after its checker's grant ends (publication is a signed historic act; withdraw by revalidating).
- Not done: nobody holds a role; no curated record exists; register/revalidate are CLI-only, no route; page text is not extracted from the PDF by the server; secure archive is a DB table, not encrypted storage; legal review of the reviewer purpose; the IRDAI primaries are unread; real insurer terms-of-use checks.
- Rollback: stop using the routes and `curatedProducts`; tables are additive and can stay empty. Dropping them needs a new migration.
