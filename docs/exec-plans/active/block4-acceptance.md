# Block 4 acceptance record (household reasoning)

Branch `block4/household-reasoning` (PR #45), cut from `origin/main` at `1308e818` (the Block 3 merge); the first commit is `9722b5b`, followed by review-fix commits. Nothing is deployed. Synthetic data only. No provider call, no network, no migration, no new dependency, no frontend.

Labels used below, never interchangeable: IMPLEMENTED (code exists), AUTOMATED_TESTED (automated tests pass), SYNTHETIC_ACCEPTED (all synthetic gates pass), EXTERNALLY_VALIDATED (real insurer documents, real reviewers, legal sign-off: none), PRODUCTION_READY (no).

Design and schemas: `docs/architecture/household-reasoning.md`. Implementation map: `docs/exec-plans/active/block4-household-reasoning.xml`.

## Status

**BLOCK4_SYNTHETIC_ENGINEERING_ACCEPTED** (SYNTHETIC_ACCEPTED only). Release gates R0 to R7 pass on synthetic evidence. Not EXTERNALLY_VALIDATED, not PRODUCTION_READY: no real insurer document, real reviewer, legal approval, live network check or Insurance Data API was involved.

## Work packages

| WP | Result | Evidence |
| --- | --- | --- |
| WP0 preflight | PASS | `block4-household-reasoning.xml` names the real paths and methods; baseline `npm test` 1246 tests, 1171 pass, 0 fail, 75 skipped |
| WP1 contracts and validators | PASS | `tests/household-reasoning-contracts.test.mjs` (13) |
| WP2 evidence normaliser | PASS | `tests/household-reasoning-evidence.test.mjs` (21), incl. a property test over generated handoffs |
| WP3 coverage map | PASS | `tests/household-coverage-map.test.mjs` (17) |
| WP4 cross-policy comparison | PASS | `tests/household-policy-comparison.test.mjs` (14) |
| WP5 context-gap resolver | PASS | `tests/context-gap-resolver.test.mjs` (20) |
| WP6 question planner | PASS | `tests/context-question-planner.test.mjs` (15) |
| WP7 scenarios and next actions | PASS | `tests/household-scenario-analysis.test.mjs` (12) |
| WP8 authorised backend integration | PASS | `tests/household-coverage-preview-api.test.mjs` (13), real app: upload, OCR (mocked), Gemini (mocked), consents |
| WP9 synthetic evaluation | PASS | `tests/household-golden-matrix.test.mjs` (55 tests, 51 labelled cases); `npm run eval:household` |
| WP10 privacy, security, adversarial review | see below | `tests/household-security-adversarial.test.mjs` (22) and the independent review |
| WP11 integration and performance | PASS | see Checks |
| WP12 documentation | PASS | this file, the architecture document, `LATEST.md` |

## Checks run

- `npm run check` (architecture boundary + `npm test` + `node --check`), run after the last fix: 1459 tests, 1384 pass, 0 fail, 75 skipped (the same 75 as the baseline: PostgreSQL, real clamd and live-provider suites without their environment). Block 4 adds 203 tests (202 plus the latency baseline).
- PostgreSQL regression (project-local PostgreSQL 17.11 per `docs/runbooks/local-postgres.md`, `TEST_DATABASE_URL` set, `REQUIRE_POSTGRES=1`, server stopped afterwards), run after the last fix: 1449 tests, 1439 pass, 0 fail, 10 skipped (real clamd and live providers). Block 4 touches no SQL, schema or migration; the run shows no regression.
- `npm run eval:safety`: 28 cases, score 1, passed.
- `git diff --check`: clean; new files have no trailing whitespace.
- `npm run eval:household`: see the next section.
- Skipped, with reason: real clamd and live Sarvam, Gemini and Insurance Data API runs (no real provider, no network by design); a manual `npm run dev` smoke (the server with only a bootstrap token answers 400 on `/api/v1/health` at the baseline commit as well, because document storage and scanning are not configured; the same server is started with full synthetic configuration by every API test).
- Mutation sanity: seven deliberate engine breaks (association check removed, member requirement removed from overlap, repeat-question guard removed, conflict detection removed, month turned into a day, three questions per turn, limits summed) each fail between 1 and 14 tests; the engine was restored and the suite is green.

## Synthetic evaluation (51 labelled cases)

Result: PASS, 51 of 51 (48 accepted inputs, 3 rejected inputs). Measures the engine against hand-written expectations; it is not model accuracy, OCR or retrieval recall, insurer-data coverage or real-policy claim accuracy.

| Metric | Count |
| --- | --- |
| Critical gaps detected / labelled | 24 / 24 (missed 0) |
| Questions asked (48 accepted cases) | 17, max 2 per response; unnecessary 0 (0.0%, target at most 10%); duplicates 0 |
| Blocking non-user gaps delegated to a document, review or external check | 60 / 60 |
| Unsupported documented conclusions | 0 |
| Cross-member or cross-policy contamination | 0 |
| Illegal authority upgrades | 0 |
| Uncited documented conclusions | 0 |
| Cross-policy summations | 0 |
| Forbidden-text disclosures (engine level) | 0 |
| Unhandled exceptions on accepted inputs | 0 |
| Determinism mismatches (3 runs per case, plus source-order reversal) | 0 |

Groups A to AN are all present (every mandatory group in the brief). Unauthorised-disclosure, revoked-consent, expired-consent, deleted-document, foreign-household, foreign-case, foreign-answer, mixed-source and forged-body cases are exercised through the real HTTP route in `household-coverage-preview-api.test.mjs`.

Local latency baseline (mocked providers, in-process HTTP, SQLite, Node 26, 25 samples; not a production claim): one source median 1.75 ms, p95 3.62 ms; five sources median 3.97 ms, p95 5.85 ms. Pure engine build over the 51 golden inputs: median 0.40 ms, p95 0.89 ms (138 samples). Capped input (5 sources, 20 policies each) builds well inside the 2 s test ceiling.

## Demonstrated journeys (synthetic)

- Planned cataract surgery, nothing reviewed: `insufficient_evidence`, questions `Q_MEMBER` and `Q_POLICY_SCHEDULE`, a document request and a review request, the hospital shown as unresolved and user-reported, a pending (not performed) network check.
- Same journey after the member is named and enrolment is documented: `Q_EXACT_DATE` and `Q_HOSPITAL_BRANCH`; the missing cataract term is an evidence gap, not an exclusion.
- Family policy, personal plus corporate policy, base plus super-top-up, multi-policy overlap and the missing-evidence, stale-source and consent-revoked scenarios: golden cases F1, G1, S1, T1, Y1, AF1 and the API tests.
- Real-application chain with reviewed evidence: upload, OCR, question, independent review, preview showing the room rent limit as a cited documented restriction with the member still unresolved, then revocation giving 404 and no content.

## Known limits and residual risk

- The consent purpose and wording behind the source-pack gate are the decision-catalogue route's, pending legal review.
- Real known evidence needs Block 3 review (independent reviewers and staff identity are separate, unbuilt work); through the ordinary path every extraction is unreviewed, so previews are mostly `insufficient_evidence` or `conditional_evidence_summary`.
- Block 3 policy kinds are `unresolved` today (the service does not classify them), so Block 4 preserves `unresolved`.
- Topic matching is a plain token match against Block 3 item topics; a differently worded topic is reported as an evidence gap, never guessed.
- Output field `memberId` and the user's hospital text are echoed back to their owner as user-reported data.

## Rollback

Disable: remove the `coverage-preview` route block in `src/server/routes/v1-backend-routes.js` (and the `getHouseholdPreviewService` argument), or make it return 404. Revert: delete `src/features/household-reasoning/`, `src/backend/services/household-preview-service.js`, the `createHouseholdPreviewService` export in `src/backend/services/index.js`, the wiring in `src/server/create-server.js`, the new tests and `scripts/eval-household-reasoning.mjs`, and the `eval:household` script entry. Block 3 code, contracts, data, migrations, consents and every existing route are unchanged, and no row is written by this feature, so there is nothing to migrate back or erase.

## Remaining dependencies (none implemented here)

Insurance Data API (no contract exists); real insurer documents and real-policy validation; independent human reviewers and staff identity controls; legal approval of consent and notice wording; final privacy assessment; production deployment and capacity measurement; any frontend.

## Independent review (WP10)

Reviewer: a separate read-only agent (no repository edits; probes in a scratch directory), adversarial brief covering forged sources and authority fields, prototype keys, Unicode tricks, cross-household and mixed-household requests, consent changes, stale evidence, prompt injection, dynamic-check spoofing, oversized and nested input, determinism and cost. Two rounds plus a final re-verify of the last fixes.

Round 1: 0 P0, 2 P1, 5 P2, 5 P3. All P1 and P2 fixed, each with a regression test:

| Finding | Disposition |
| --- | --- |
| P1 reviewed open-ended finding shown as known on an unverified association | Fixed: open-ended findings are never documented terms (no member or date scope in the handoff); uncertainty only |
| P1 contradictory open-ended findings not conflicted | Fixed by the same change: nothing is asserted from them |
| P2 result depended on source order (579 of 1488 fuzz cases differed) | Fixed: canonical ordering, completion disagreement made explicit; fuzz mismatch 0 on four seeds |
| P2 waiting-period completion lost its continuity citations and caveat | Fixed: completion keeps citations, start date, caveat |
| P2 exact date outside a documented policy period gave a clean summary | Fixed: blocking gap `planned_date_outside_policy_period` |
| P2 claim-wording check could fail the preview on document topic text | Fixed: scan limited to the engine's own sentences |
| P2 open-ended findings ignored member scope and dates | Fixed by the P1 change |
| P3 invisible and tag characters accepted; >20 policies across sources gave a generic 400; cost bound loose | Fixed (character screen, coded 422, `itemsTotal` 1000) |
| P3 foreign versus unknown case latency differs slightly; question budget lives in client answers | Accepted and documented (local authenticated API; stateless by design) |

Round 2 (re-review of the fixes): no new P0 or P1. One new P2 (the character screen refused legitimate Indic and Arabic-script names containing ZWNJ or ZWJ and emoji variation selectors) and four P3 (completed waiting period could lose its basis; completion disagreement not surfaced as a gap; wrong provenance label on a reviewed finding; policy-period gap ignored a month-only plan). All fixed: joiners are allowed only after a letter or mark, the emoji selector only after a pictographic character, a digit, # or *; completion without citable continuity is reported unknown; new review gap `waiting_period_completion_unresolved`; provenance `unavailable`; month-level period check.

Final re-verify (third pass): the character-screen and gap fixes hold; no crash and no order mismatch (reversed-order fuzz, 1500 cases, three seeds). One P3 remained (invisible letters such as U+034F and the Hangul fillers could carry hidden text beside a joiner); fixed by refusing those characters, with a regression test.

Unresolved findings after the fixes: none at P0, P1 or P2.

Attacks attempted with no defect found: forged handoff, citations, verified, role and reviewer fields; `__proto__` and `constructor` keys; arrays and primitives in place of objects; lone surrogates, bidi, control and zero-width characters; duplicate JSON keys, huge numbers, deep nesting, wrong content type, other methods; foreign, unknown and mixed household, case, answer and member references (identical 404 bodies, no foreign ids); source-pack consent revocation; the independent-reviewer exemption (never used); value leakage from unverified or model items; summed limits; month-to-day conversion; dynamic-check spoofing; question text injection; non-determinism from time, randomness or key order.


## Pull request review round (PR #45)

Automated reviewers (Codex, CodeRabbit, cubic) raised 36 inline comments. Fixed, each with a regression test where behaviour changed: conflicting `topic_detail` / `procedure_detail` answers are rejected; uncertainty phrases and filler words stay nonspecific; a documented policy period makes the exact date material; unrelated dated terms no longer do; waiting-period gaps follow scenario relevance; a known value with identity or contact keys, or nested too deeply, is narrowed; a stricter state (`unverified`, `dynamic_check`) wins over a known value from another source; invisible format characters (category Cf) are refused; the output contract checks policy-level association, resolvers and `policies.N.limitations` wording; a cited `not_selected` term is not reported as "not stated"; the curated product archives are verified once per request; the request cap comes from `LIMITS.requestBytes`. Evaluation, fixtures and harness: unknown `expect` keys fail a case, accepted/rejected counts follow the expected outcome, the unnecessary-question rate is over labelled cases, `tableCounts` fails loudly, the injected-amount assertion is path-based.
