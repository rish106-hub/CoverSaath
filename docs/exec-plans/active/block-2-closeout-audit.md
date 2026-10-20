# Block 2 final close-out: baseline audit (A1)

Phase B2-0, read-only. Date 2026-10-20. No code, data or provider was touched to produce this report.
Counts and identifiers only; no policy text, member data or provider payloads appear here.

## Repository state

| Item | Value |
|---|---|
| Branch | `codex/backend-first-layout` |
| HEAD | `5b31739` (evidence retrieval hardening) |
| `origin/main` | `fee77db` = merge of `5b31739` (the brief's baseline). No newer remote commits. |
| Working tree | clean before this file |
| Node | v26.11.1 |

## Checks run (local, offline, no provider calls)

| Command | Result |
|---|---|
| `npm run check` (architecture + test + build) | PASS. 761 tests, 708 pass, 0 fail, 53 skipped |
| Skips | PostgreSQL suites (no `TEST_DATABASE_URL`) and opt-in live Sarvam/Gemini tests |
| `npm run eval:safety` | PASS. 23 cases, `failures: []`. Synthetic regression only |

## Live evidence that already exists (not re-run)

`.local/live-backend-run-2026-10-20T04-15-44-884Z/run-summary.json` (local, mode 700):

- One real 20-page policy (sanitised derivative) went through the backend: upload, Sarvam OCR (6 HTTP calls), Gemini
  **structuring** (15 calls, 50.6k in / 66.7k out tokens, $0.288, 464 s wall clock incl. resume).
- 20 of 20 pages stored, all with layout blocks. 0 known names in the Gemini trace; 0 secrets in the provider trace.
- This is the old registry-structuring path. **No question-time (evidence) call has ever run live.**
- The run DB is the legacy `.local/.local/knowvia.sqlite`: 14 migrations, no `policy_clauses`, no question consent scope.

## Status by phase

| Phase | Implemented | Tested offline | Live / measured | Status |
|---|---|---|---|---|
| B2-1 OCR completeness | Yes (10-page segments, remap, fail-closed partials, durable jobs, revocation) | Yes (1/10/11/47/100-page splits, partial/dup/reorder) | 1 doc, 20/20 pages | PASS offline; live corpus NOT TESTED |
| B2-2 Canonical evidence | Yes (deterministic clauses, digests, FTS triggers, erasure) | Yes | Not run | FAIL: superseded-version defect (D1) |
| B2-3 Retrieval / investigation | Yes (whole-policy vs FTS, budgets, sweep, grounding, completeness) | Yes, fixture provider | Not run | NOT TESTED live; recall unmeasured |
| B2-4 Policy identity | Unknown-note only when >1 document | Partial | n/a | FAIL (D1, D2); ADR 0007 blocked by U2 |
| B2-5 Golden corpus | Evaluator exists (`recall-eval.js`, `eval:retrieval`) | Yes | No golden file (`.local/eval/retrieval-golden.json` absent) | BLOCKED: owner data |
| B2-6 Live journey | Routes exist | Mocked API tests | Never run | BLOCKED: approval, DB move |
| B2-7 Security / lifecycle | Consent, gate, household scope, erasure on revoke/delete | Yes | Not run | Open question D3 |
| B2-8 Close-out | — | — | — | NO-GO today |

## Defects and open findings

**D1. Superseded document versions are read as current (B2-2, B2-4). Severity: high (can mislead).**
Uploads carry `logicalDocumentId` + `version`; `findVersion` only blocks an exact duplicate
(`document-intake-service.js:71`). Version 1 stays `active` when version 2 is uploaded. The question service reads
every active document the grant names (`policy-evidence-service.js:72`), with no logical-version filter. Both versions
reach the model; the answer only says "2 documents were read together", never "one is superseded". Evidence: code
path; no test covers it (`grep` of `tests/policy-evidence-*`). Reproducing test to be written first.

*D1 fixed 2026-10-20 (uncommitted).* `policy-evidence-service.js` reads only the latest active version per logical
document in the case, even when the grant names only an older one. Authorised superseded versions are reported as
`documentsExcluded` reason `superseded_version` and in `unknowns`, and do not use document-limit slots. All
authorised documents superseded gives `POLICY_EVIDENCE_SUPERSEDED` (409). A non-integer version gives
`POLICY_EVIDENCE_VERSION_INVALID`, and a case listing over 1,000 rows gives `POLICY_EVIDENCE_CASE_TOO_LARGE`. Both fail closed.
Tests: `tests/policy-evidence-document-versions.test.mjs` (8; 3 red before the fix). Service-level with stubs, not
through the real API. Independent read-only review: no consent or household bypass. Open items from the review:
- **D1a (gap):** `logicalDocumentId` is household-scoped, so a v2 uploaded to another case does not supersede v1 in
  this case. Needs a household-wide version lookup or an owner decision.
- **D1b (gap):** answer replay is keyed on case, question and grant only. A replayed answer can predate a newer version.
  Same family as D3.
- **D1c (accepted):** a newer active version the grant does not name still supersedes the old one. The 409 and the
  unknown reveal that it exists. It is the same household's own case document, already listable by them.

**D1a, D1b, D2, D3 fixed 2026-10-20** per owner decisions (all recommended options); see `LATEST.md` for behaviour.
Tests: `tests/policy-evidence-document-versions.test.mjs` (19, service level), persistence round trip of `access`
and `latestActiveVersions` on SQLite, and API assertions (`current`, no access leak). Second independent review: no
blocker. Fixes applied from it: fail-closed version lookup, case check on currency, `not_named` completeness, and
currency re-checked at commit. Owner questions remain on cross-adult reads and version rollback.

**D2. Multi-document answers merge findings with a warning only (B2-4). Severity: medium.**
`assembleAnswer` (`investigate.js:244-245`) adds one unknown when >1 document is read but still pools findings from
documents whose policy association is unknown. Not silent, and state is forced to `conditional`, but a schedule of
policy A plus wording of policy B in one case yields one combined answer. Conservative MVP option: answer per
document, or refuse >1 unassociated logical document unless the request names one.

**D3. Answers survive consent expiry (B2-7). Owner decision, not yet a defect.**
Revocation and document erasure delete answers (`consent-repository.js:250,429`). Expiry does not: the replay
(`policy-evidence-service.js:66-68`) and `GET` read stored answers without a consent check. No data reaches a provider
on replay, so it is retention, not disclosure. Needs a rule: erase on expiry, block reads after expiry, or keep.

**D4. Docs out of date.** `LATEST.md` has no entry for commits `523ccd1`/`5b31739` and says `/docs` is gitignored
while the files are tracked (the ignore rule only stops new files). `direction-change.md:20` has stray text in a
heading. `pipeline-blocks.md` Block 2 section predates ADR 0008. `block-2-sarvam-document-ai.md` says no live call
was made; the 2026-10-20 run did make one.

**D5. Ops blocker.** Live DB at `.local/.local/knowvia.sqlite`; the server refuses to start (`DATABASE_LEGACY_PATH`).
Moving it is a manual, owner-approved step (runbook `local-database.md`). Migrations 015/016 then need `db:init`.

No defect found in: page limits (500 everywhere, 10-page Sarvam segments), FTS query construction (operators
stripped, `clause-repository.js:24`), household scoping of clause and answer reads, prompt-injection instructions
(`structuring-contract.js:27,37`), gate on every clause and on the question.

## Blocked on the owner

1. **Golden corpus (B2-5).** 3 to 5 real policy sets and 30 to 50 human-verified questions with required clauses and
   overrides. I can draft candidate questions from stored clause ids, but human verification cannot be done by me.
2. **Paid calls (B2-6).** Question-time Gemini on the stored 20-page policy: estimate about $0.01 to $0.03 per question
   (about 17k input tokens whole-policy, unmeasured). 15 to 50 questions: under $2. Needs explicit approval and a budget.
   No new Sarvam call is needed for the existing document; new corpus documents each need OCR (paid).
3. **DB move** (D5) and a document-specific `insurance_question` grant for the test household.
4. **Decision on D2 and D3.**

## Proposed execution order (smallest path to GO)

1. D1: red test (v1 + v2 same logical id, both active, grant names both) then filter to the latest active version per
   logical document and report superseded versions in `completeness`. Narrow tests, independent review.
2. D2: implement the chosen conservative boundary. Red test first.
3. D3: implement the chosen expiry rule if any.
4. Docs: LATEST, Block 2 plan status, pipeline-blocks.
5. With approval: move DB, `db:init`, run the live question journey (B2-6) on the stored policy with owner-written
   questions; record tokens, cost, latency, citations checked by the owner.
6. With the owner's corpus: `npm run eval:retrieval`, recall report (A4).
7. Close-out report (A7) with GO/NO-GO.

Today's decision: **NO-GO.** Live question journey never run, recall unmeasured, D1 open.

## Live backend acceptance (A5), 2026-10-20

Approved by the owner ("do all"), capped at $2. Providers: Gemini `gemini-3.8-flash` **live**. Sarvam not called (the
policy's 20 OCR pages were already stored from the earlier live run). Database: the owner's local SQLite, backed up and
moved from `.local/.local/` (migrations 015 and 016 applied, valid). Scripts and raw outputs are local only
(`.local/live-question-run*.mjs`, `.local/live-question-run-*/`, mode 700/600). No policy text is in this report.

Corpus: **1 real policy set** (schedule plus customer information sheet; no full policy wording). **34 candidate
questions, 62 expected quotes, AI-drafted, not owner-verified** (`.local/eval/golden-questions.draft.json`). This is
a pilot measurement, not a labelled-corpus result.

| Measure | Result |
|---|---|
| Questions answered | 34 of 34. The first attempt stopped at question 7 because the Google project hit its monthly spend cap. The owner raised it and the rest ran. |
| Context path | `whole_policy` for all (45 clauses, about 42 KB, under the 64 KB gateway limit) |
| Answer states | 33 `conditional`, 1 `insufficient_evidence` (co-payment: no clause, correct abstention), 0 verdicts |
| Expected quotes cited (exact match) | 56 of 62 (90.3%) |
| Expected clauses cited (manual re-score, same clause or same row elsewhere) | 60 of 62 (96.8%). Misses: q09 Parenthood add-on "Not Opted" status (the maternity exclusion itself was cited) and q20 cashless 1-hour authorisation time |
| Critical exclusions or overrides missed | 0 exclusions. 1 critical-labelled status line (q09 add-on), which does not change that maternity is excluded |
| Citation integrity, 191 sources | 183 verbatim. 7 privacy-redacted at the correct clause and page. 1 gate-normalised (table pipes) at the correct clause. 0 wrong page, 0 fabricated. Non-verbatim sources carry `verbatim: false` (added after the first run). |
| Override sweep | Completed on 32 of 34. 2 not completed (provider error, spend cap), both reported in `unknowns` |
| Prompt injection (q33) | Resisted: conditional answer, exclusion cited, injected text only in the echoed question |
| Replay / key reuse / GET | 200 replay with 0 provider calls / 409 `IDEMPOTENCY_KEY_REUSED` / 200 `current: true`, no access metadata returned |
| Consent expiry (D3) | After expiry: replay 403 `CONSENT_REQUIRED`, GET 403 `CONSENT_REQUIRED`, 0 provider calls |
| Privacy | 0 of 4 locally detected names in any prompt; 0 secrets in traces. **P1:** the locality and PIN after a masked address reach Gemini. The other digit runs are public insurer numbers (UIN, helplines, stamp references) |
| Cost | About $1.56 total (about $0.045 per question average, $0.02 to $0.07 range). 2 Gemini calls per question, about 30k input and 3 to 9k output tokens each |
| Latency | p50 38 s, max 114 s per question (two sequential model calls) |

Manually spot-checked values (q01 to q06): sum insured and floater basis, policy period, room rent and ICU "At
Actuals", PED 3 years with fresh waiting on enhanced sum insured, 30-day initial wait except accidents. All correct and cited.

### Findings from the live run

- **Fixed (pushed):** sources marked `verbatim`; false "No limit clause was found" unknowns removed on the whole-policy path.
- **F-B (open, medium):** findings are bucketed by the cited clause's keyword label. The page-6 benefits table is
  labelled `exclusion`, so "Room Rent | At Actuals" (no limit) appears under `limited_or_excluded`. The fix needs a
  model-reported effect per finding (schema change, AI-authority review).
- **F-C (open, medium):** q08 (cataract) gives no unknown saying cataract is not named in the documents read. The
  answer stays `conditional` and cites the waiting periods and member exclusions, but does not say the wording was not uploaded.
- **P1 (open, medium):** the privacy gate leaves locality and PIN after `<ADDRESS_n>`.
- **R1 (open, risk):** forced retrieval recall on this policy is 52% at a 16 KB budget and 18% at 8 KB (clauses up to
  4,000 characters). It does not affect this policy, which is read whole, but long policy wordings will take the retrieved path.

### Hard gates

| Gate | Status |
|---|---|
| All supported pages accounted for | PASS (20 of 20, one document) |
| No undetected page-order or mapping failure | PASS (one document) |
| No unauthorised cross-household retrieval | PASS in tests; NOT TESTED live |
| No fabricated quotations | PASS (191 of 191 at the correct clause) |
| No wrong document or policy attribution | PASS (single document) |
| No missed critical exclusion or override | PASS on the draft set; NOT owner-verified |
| No wrong critical value accepted as verified | PASS (findings capped at `extracted_unverified`; q01 to q06 spot-checked) |
| No silently excluded documents | PASS |
| No incomplete evidence presented as complete | PASS (sweep failures reported) |
| No unapproved paid call | PASS ($1.56 of the $2 approval) |

### Decision: NO-GO for freeze, single-policy pipeline PASS

The live single-policy journey works end to end with traceable citations. Block 2 cannot be frozen because:
1. The question set is AI-drafted (owner verification required) and covers 1 policy, not 3 to 5.
2. F-B can present "no limit" under `limited_or_excluded`. This can mislead.
3. P1 privacy residue.

Smallest path to GO: owner verifies the 34 questions and answers; fix F-B and P1 (each with independent review);
add F-C (an unknown when the asked subject is not named in the read text); run 2 to 4 more policies including one
long wording (measures R1).
