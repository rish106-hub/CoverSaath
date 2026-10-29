# Block 3 final engineering report (2026-10-20)

**Status: BLOCK3_IMPLEMENTED_QA_PENDING.** Not `ENGINEERING_READY`: nothing is merged to `main`, and no real policy has been run through the catalogue. CodeQL remediation is a separate follow-up phase.

## 1. Latest inspected branch and commit
Base `b94c958` (`main`). Work on `block3/decision-catalogue` (`ea53fb3`), merged with `optimistic-kare-0c8f4b` (`b00ea7c`). Later uncommitted fixes are listed in section 5.

## 2. Completed Block 2 security dependency
Privacy gate `v9` went through four independent read-only reviews: FAIL (2 critical), FAIL (5 critical variants), PASS_WITH_FINDINGS (4 medium), PASS_WITH_FINDINGS (3 medium + lows). Every critical and medium finding was fixed with a failing-first test. The latest fixes (section 5) were re-reviewed: PASS_WITH_FINDINGS, lows fixed. Deferred low items: hyphen-split placeholders in regate mode, "Pin code is 560001", lowercase and Devanagari house numbers, glued PAN label, optional `knownIdentifiers` on the model path, "Contact person: Claims desk" over-masking, `Insured persons: A; B` second name after `;`, spaced policy number partial mask, lone known first name in free-text questions. Block 2 human insurance QA and legal consent review are **not** complete.

## 3. Existing capabilities reused
`policy_clauses` (document, version, page, digest), parameter-record resolution vocabulary, `source-hierarchy` version compare, consent re-check and source-pack gate from `/questions`, `ClauseRepository.listClauses` for household and liveness scoping. `evidence_facts` was inspected and rejected (states, `source_pages` dependency, no conditions or selection).

## 4. Defects reproduced
Review-found, each with a regression test: authority claims by candidates, origin/sourceType binding (model could carry contractual types), unenforced official-source claim, fail-open evidence index, dropped member scope, quote copying, plus the gate defects in section 2.

## 5. Exact files changed
`src/features/decision-catalogue/{contracts,facts,applicability,rules,cross-policy,official-sources,catalogue,from-answer,index}.js`; `src/backend/services/{decision-catalogue-service,policy-evidence-service,index}.js`; `src/server/{create-server.js,routes/v1-backend-routes.js}`; gate: `src/features/ai-analysis/{privacy-evidence-gate,live-coverage-runtime}.js`, `src/features/policy-evidence/investigate.js`, `src/features/coverage-analysis/{source-input,persistent-service}.js`, `src/evaluation/{safety-evaluator.js,fixtures/safety-reference-v1.json}`. Tests: `decision-catalogue{,-api,-handoff}.test.mjs`, `privacy-gate-v9-{review,rereview,third-review,final-review}.test.mjs` and updated gate tests. Docs: `docs/architecture/decision-catalogue.md`, `docs/adr/0009-*.md`, `docs/iterations/LATEST.md`. Final fixes: truncated pages excluded (`source-input.js`), natural-language credentials and PINs refused, singular name-list labels, zero-gap known-name match, `sourceDigests` on facts.

## 6. New contracts and migrations
Contract `decision-catalogue/v1`. Route `GET /api/v1/cases/{caseId}/decision-catalogue?answerId=&asOf=&memberId=`. **No migration** (derived on read). ADR 0009 proposes one for reviewer storage; not built.

## 7. Implemented deterministic rules
12 typed rules (integer minor units, INR): sum insured, room rent and ICU limits, co-payment, deductible, sublimits, waiting periods (completion needs a verified `policy_period/continuous_cover` start and `asOf`; month counting is an unverified stated assumption), permanent exclusions, add-ons, restoration/bonus, policy dates and continuity. Statuses: known, unverified, dynamic, conflict, unknown, not_selected, available_not_selected, not_permitted. Missing input never becomes zero or false.

**Gap-audit follow-up (after merge).** Rules now also cover groups A, C, G, H, I (policy identity, member enrolment, network status, claim documents, renewal/portability). Network status can never be `known`; it is `dynamic`. Topic-specific sublimits and waiting periods are evaluated per topic in the policy layer (before, only the general topic was reported). An amount limit carrying `kind` was wrongly rejected as malformed and is fixed. Group J is covered by the official-source record, not a rule. `curated-sources.js` ships empty by design: nothing has been verified against an official publication.

## 8. Policy-specific evidence handling
`factType` and `topic` are open labels; `registryKey` optional. Unusual clauses survive with conditions, exceptions and overrides. Applicability (policy, member, date, supersession, selection) runs before precedence; wording describing an unselected benefit stays `available_not_selected`.

## 9. Cross-policy and version safety
Layers stay separate; `combinedConfirmedCover` is null; kinds include personal, floater, group, top-up, super top-up, unresolved. Superseded schedules cannot control. A source for one policy or member cannot establish another's facts.

## 10. Official-source capabilities and limits
Validator with freshness states and `mayOverrideContract: false`. Official-source batches cannot carry contractual source types. **No curated data, no crawler, no live source.** Network and cashless data are dynamic.

## 11. Test commands and outcomes
Latest own run: `npm run check` 1037 tests, 984 pass, 0 fail, 53 skipped; `npm run eval:safety` no failures; `git diff --check` clean. These are synthetic regression results, not evidence of real-world insurance correctness.

## 12. Independent review findings and resolution
Block 3 diff review: PASS_WITH_FINDINGS, all fixed or documented. Wiring review: 2 high, 2 medium fixed. Gate: section 2. Re-review of the final gate fixes: PASS_WITH_FINDINGS, all low (false refusals on "Password is required" and "Your PIN code is 560001", bare `pwd` value); fixed with a test. Info items left: short two-token known names also match when concatenated; `Insured: Family floater` over-redacted (pre-existing).

## 13. Remaining critical and noncritical risks
Critical: none known open. Noncritical: deferred gate lows (section 2); no live Gemini or real-policy run of the catalogue; the consent purpose fit of the route is pending legal review; waiting-period month counting unverified; large pages over the storage limit are now excluded rather than partly sent (availability cost, fail-closed).

## 14. Block 4 interface readiness
Contract and tests ready (`decision-catalogue-handoff.test.mjs`). Block 4 does not consume it. On the real path every typed rule is `unknown` or `unverified` until a reviewer path exists (ADR 0009, Part 2).

## 15. CodeQL backlog for the next sprint
11 pre-existing open alerts on `main`, none in Block 3: `js/remote-property-injection` (coverage-report, eval-scorer, eval-structuring-accuracy), `js/user-controlled-bypass` (eval and smoke scripts), `js/file-access-to-http`, `js/clear-text-logging` (smoke scripts), `js/sql-injection` and `js/path-injection` (postgres migrate and test support). Re-check after the branch's own CodeQL run. Deferral is not a security waiver.

## 16. Measured engineering completion and outstanding QA
MVP cutline `must_ship`: all nine items met in code and tests, except that "safe persistence" is derive-on-read and "verified policy association" is `unresolved` (ADR 0007 blocked). Outstanding: re-review of final gate fixes, human insurance QA on real documents, legal review of consent wording, reviewer path, findings-to-values mapping, curated official-source data, Block 4 consumption, production readiness (still FAIL).

Gates: G1–G8, G10 met in code and tests. G9: broad checks pass; the final gate re-review returned with lows only, all fixed (the fix to those lows was not reviewed again).
