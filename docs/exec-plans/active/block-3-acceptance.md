# Block 3 acceptance: decision catalogue on synthetic data

Date 2026-10-21. Base `main` `0922fa4`, branch `block3/synthetic-acceptance` (uncommitted). Contract: [decision-catalogue.md](../../architecture/decision-catalogue.md). Authority: [reviewer-security.md](../../architecture/reviewer-security.md). Operations: [curated-sources runbook](../../runbooks/curated-sources.md).

Status sought: **BLOCK3_SYNTHETIC_ENGINEERING_ACCEPTED**. Not claimed: real-insurer accuracy, genuine independent source verification, regulatory compliance, production reviewer authorisation, production readiness, claim-decision accuracy.

## Scope and non-goals

In scope: every Block 3 capability that can be exercised with fictional insurers, UINs, policy numbers, members and synthetic reviewers in temporary databases. Out of scope: real insurer PDFs, real households, Block 4 reasoning, deployment, CodeQL cleanup (separate worktree `codex/codeql-alerts-2026-10-21`, no file overlap with this branch), repository settings.

## Feature inventory and completion matrix

Classification: `already_complete` (existing code and tests), `fix_required` (defect found and fixed here), `test_required` (behaviour existed, test added here), `externally_blocked`.

| Work package | Status | Evidence |
|---|---|---|
| P1 Synthetic evidence framework | test_required, done | `tests/support/synthetic-policies.mjs` (real pdf-lib PDFs, deterministic, banner on every page, manifest `SCENARIOS`), `tests/block3-synthetic-matrix.test.mjs` |
| P2 Exact-byte digest, mismatched digest, UIN, version, quotes, no-page-text human review, host allowlist | already_complete | `tests/curated-product-workflow.test.mjs` (evidence, collection, allowlist, extraction tests) |
| P2 Registration with real PDF bytes, idempotent repeat, conflicting submission | test_required, done | `tests/curated-source-integrity.test.mjs` |
| P2 Corrupted, missing or edited archive after publication still produced trusted facts | **fix_required, fixed** | `listVerified` re-runs archive checks; `verifyPublishedArchives`, CLI `verify-archives`; `tests/curated-source-integrity.test.mjs` (red before the fix) |
| P2 Changed PDF, supersession, manual revalidation, stale evidence | already_complete | `curated-product-workflow.test.mjs` maintenance and journey tests |
| P3 State machine, self-check/self-publish refused, grants, expiry, revocation, facts digest, own-copy digest, replay, audit, immutability | already_complete | `curated-product-workflow.test.mjs` (13 tests incl. API session test) |
| P3 Successful CLI journey | test_required, done | `curated-source-integrity.test.mjs` CLI test (grant, register, propose, verify-archives; no check/publish command exists) |
| P3 Production operator identity | externally_blocked | operator id is a label; see reviewer-security.md |
| P4 Unauthenticated, foreign household, confirmer cap, independent authority, rejection/dispute/supersession, idempotency, revocation, audit without content, erasure | already_complete | `tests/catalogue-review-api.test.mjs` |
| P4 Independent grant silently covered documents uploaded after it | **fix_required, fixed** | `documentsUntil` in `decision-catalogue-service.js`; new test in `catalogue-review-api.test.mjs` (red before the fix) |
| P5 One/none/several policy numbers, same number across documents, personal vs corporate, uploader kind ignored | already_complete | `tests/decision-catalogue-association.test.mjs` |
| P5 Policy ids were an unkeyed hash of the policy number (reversible by enumeration) | **fix_required, fixed** | HMAC key in `association.js` and the service; keyed-id test in the association tests |
| P5 Endorsements, revised schedules, member applicability | test_required, done | matrix S06, S09, R03, R11 |
| P5 Member enrolment and per-member continuity from a policy-wide fact | **fix_required, fixed** (U03) | `applicability.js` `member_scope_missing`; matrix U03, `decision-catalogue-rules-phase5.test.mjs` |
| P6 Rule matrix (co-pay, room rent, ICU, deductible, sublimits, waiting periods, continuity, exclusions, restoration, bonus, not opted, top-up) | test_required, done | matrix S01-S14, R01-R11; existing `decision-catalogue-rules-phase5.test.mjs`, `block3-journey.test.mjs` |
| P6 Undated call answered from a lower layer when a dated endorsement could control | **fix_required, fixed** (U01) | `applicability.js` `dateDecides`; matrix U01 |
| P6 Older wording version answered a term the newer version no longer states | **fix_required, fixed** (U02) | `applicability.js` family-wide newest version; matrix U02 |
| P7 Multi-document upload-to-handoff journey through the API | test_required, done | `tests/block3-multi-document-api.test.mjs` |
| P7 Handoff states, candidateValue isolation, version refusal | already_complete + hardened | `assertHandoffContract` now refuses a foreign catalogue version, missing arrays and a non-boolean association; test in `decision-catalogue-handoff.test.mjs` |
| P8 SQLite triggers, immutability, atomic writes | already_complete | `curated-product-workflow.test.mjs` database test, `catalogue-review-api.test.mjs` |
| P8 PostgreSQL 17 | not run locally | no `TEST_DATABASE_URL`; tests skip with a reason. No migration changed on this branch; CI last ran PostgreSQL 013/014 green |
| P8 Archive classification | documented | reviewer-security.md, Archive classification |
| Independent read-only review of this branch | done | 1 P1, 4 P2, 7 P3. Fixed: P1 newer not-yet-effective family version collapsed a real conflict into `known` (version check now uses only applicable facts; regression test in `decision-catalogue-rules-phase5.test.mjs`); P2 no-member query completed a waiting period from a policy-wide continuity record (continuity is now always member-scoped); P2 malformed stored facts could throw on every catalogue read (guarded, test added); P3 `verify-archives` exit status and DB close; P3 doc mismatches. Recorded, not fixed: P2 outward clause digests are unkeyed SHA-256 (Block 2 `clauses.js`, follow-up); P2 per-request archive hashing cost (documented, empty catalogue today); P3 conservative `as_of_required`; P3 refused independent reads audited as views; P3 old reviews keep unkeyed ids (synthetic only). No re-review of the fixes. |
| P9 Documentation | done, **needs `git add -f` on commit** (`/docs` is gitignored; ADR 0009, `decision-catalogue.md` and the 2026-10-20 research note were never committed, so LATEST.md links to them are broken on `main`) | this file, decision-catalogue.md (rewritten), reviewer-security.md (new), curated-sources runbook (new), ADR 0009 addendum, LATEST.md |
| No test data in the shipped catalogue | test_required, done | `tests/curated-sources-empty.test.mjs` |

## Verified versus synthetic evidence

Everything above is proved on synthetic evidence only. Synthetic curators and checkers exercised the full state machine in temporary databases; that is not independent human verification. Synthetic PDFs prove the byte and digest path; their page texts come from the generator, so nothing here proves text extraction from real insurer PDFs. No real policy, household or insurer record was used. The shipped catalogue is empty.

## Synthetic test matrix

Command: `node --test tests/block3-synthetic-matrix.test.mjs` (also part of `npm test`). Fixtures: `tests/support/synthetic-policies.mjs`.

| ID | Scenario | Expected (asserted) |
|---|---|---|
| S01 | Single policy, schedule + wording | sum insured, room rent, co-pay, ICU known; maternity add-on `not_selected`; waiting period known, completion `continuity_not_evidenced`; deductible and enrolment missing; source check clean |
| S02 | Two unrelated policies | separate `pol-` ids and sums insured; coordination unresolved |
| S03 | Personal + group certificate | separate layers; group values stay on group policy |
| S04 | Family floater | enrolment known per member; no member named gives missing |
| S05 | Top-up with deductible | deductible known; coordination note; sums never added |
| S06 | Schedule, endorsement, wording | endorsement controls from its date, schedule before; discrepancy kept |
| S07 | Schedule vs wording co-pay | schedule controls; wording kept as discrepancy |
| S08 | Unknown continuity | `continuity_not_evidenced` / `as_of_date_missing`; model continuity ignored |
| S09 | Member-specific limits | per-member values; conflicting co-pay for one member |
| S10 | Wrong UIN | `uin_mismatch` |
| S11 | Several printed UINs | `several_uins`; curated comparison `several_uins`; association unestablished |
| S12 | Missing quote or page, tampered bytes, non-PDF | `quote_not_on_page:0`, `page_out_of_range:1`, human-review codes without page text, `digest_mismatch`, `not_a_pdf` |
| S13 | Superseded wording | v2 controls, v1 `older_version`; freshness `superseded` |
| S14 | Outdated evidence | `not_in_effect` outside dates; curated freshness `stale` |
| R01-R11 | Contradictory co-pay, room-rent differences, missing member, interrupted cover, exclusion with exception, invalid restoration, malformed money, missing deductible, repeated citations, model vs not opted, two policies' applicability | conflicting / per-policy / missing / `cover_interrupted` / conditional / `value_malformed` / `fact_unknown` / collapsed or conflicting / `not_selected` / per member and date |
| U01-U03 | Regressions for the three applicability defects | missing with `as_of_required`; missing; missing with `member_scope_missing` |

Results: see "Checks" below. Limitations: fixtures were written by the same team that wrote the rules; expected outputs follow the code's documented behaviour, not an external oracle; no real insurer language variety; no OCR noise.

## Checks (2026-10-21, this branch)

- `npm run check`: architecture check passed (162 source files); `npm test` 1197 tests, 1123 pass, 0 fail, 74 skipped; build passed.
- Skipped: 64 PostgreSQL tests (`TEST_DATABASE_URL` not set; no local PostgreSQL), 10 opt-in live or clamd tests (Sarvam, Gemini, clamd, parse eval). PostgreSQL 17 was **not** run for this branch; no migration changed.
- `npm run eval:safety`: 0 failures. `git diff --check`: clean.
- `tests/block3-synthetic-matrix.test.mjs`: 30 pass, 0 fail, 0 todo.
- Known flake: `G4: worst-case inputs at the scan cap finish in bounded time` (`tests/privacy-gate-r2.test.mjs`) failed once under full-suite load in an earlier run and passed 3 of 3 alone; it is timing-sensitive and untouched here.

## Remaining external dependencies (open)

1. Real insurer-policy evidence: genuine wordings and schedules from several insurers, with terms-of-use and reuse rights checked per insurer.
2. A genuine independent checker, and a curator, as real people with authenticated identities.
3. A trusted operator model (who may run the CLI and grant roles), staff directory and MFA.
4. Source publication and reuse rights for archived public wording.
5. Legal review of consent purposes (catalogue read, independent review) and all user-facing wording.
6. Real-policy holdout evaluation on untouched policies, multi-insurer.
7. A final independent privacy assessment (Block 2 gate still BLOCK2_QA_PENDING).
8. Production deployment, PostgreSQL runtime and operational validation (none exists).

## Production acceptance prerequisites

All eight dependencies above closed; `CATALOGUE_INDEPENDENT_REVIEW_ENABLED` stays off until 2, 3 and 5 are closed; a configured `DOCUMENT_ENCRYPTION_KEY_BASE64` so policy ids and reviews are stable; PostgreSQL suite green in CI for the deployed schema.
