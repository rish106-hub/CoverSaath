# Direction change: evidence-retrieval-first policy reasoning

Status: accepted by the product owner on 2026-10-20. This document is the canonical direction until ADR 0008 (Phase B, slice B0) records it formally. Where an older plan or ADR assumes registry-first extraction, this direction takes precedence for new work; existing invariants in AGENTS.md still apply.

## Guiding principleFirst, plan out. ya to Bulgaria phir 
> Don't teach CoverSaath every possible insurance policy. Teach it how to investigate any insurance policy, find the applicable clauses, and explain what the evidence does, and does not, establish.

## Why the direction changes
A fixed set of 138 parameters cannot represent every policy. Insurers word benefits, conditions, riders, exceptions and definitions differently. Some examples:

| Policy | What the document says |
|---|---|
| A | Room rent capped at 1% of sum insured |
| B | No room-rent restriction, except for certain room categories |
| C | Unlimited room rent at network hospitals, subject to a specific rider |

A single `room_rent_limit` key cannot hold the conditions in B and C. The same is true of waiting periods, disease-specific exceptions, restoration, cumulative bonus, consumables, co-pay structures and unusual riders. The schema would keep growing, and any policy-specific condition that does not fit would never reach comparison logic. That defeats the product goal of uncovering hidden terms.

**Standardise how CoverSaath interprets and compares policies, not the structure of the policies themselves.**

## Target architecture
1. **Sarvam Document AI** digitises the whole policy: pages, sections, tables and layout.
2. **Policy knowledge base** keeps every original clause, indexed and searchable by document id, policy id, version, page and section.
   - **Common facts:** sum insured, policy dates, premium, insured members and common limits. These are structured, taken from the deterministic schedule layer and the optional registry catalogue.
   - **Open-ended clauses:** custom benefits, exceptions, riders and unusual eligibility conditions. These are stored as evidence, not forced into registry keys.
3. **Question-driven investigation with Gemini.** The pipeline finds the relevant clauses, conditions, exceptions and overrides. For a single policy under the token budget, it reads the whole gated policy; above the budget it uses FTS5 retrieval.
4. **Answer:** a coverage explanation, comparison, limitations, sources and unknowns.

The model is no longer asked to "extract all 138 parameters". It is asked to "understand what the user needs to determine, gather all relevant evidence including exceptions and overrides, and extract the facts required to answer that question".

Example: *"Will my policy cover cataract surgery for my mother?"* The pipeline checks:
- whether the mother is an insured member;
- cataract coverage and any disease-specific caps;
- initial, specific-disease and pre-existing-disease waiting periods;
- relevant exclusions and endorsements;
- network-hospital and cashless conditions, where relevant.

The answer is conditional and cited, and it states explicitly what remains unknown. No cataract clause needs to be predefined in the database.

## What is standardised (only three things)
1. **Document metadata:** policy identity, insurer, document type, version, date, page, section and source.
2. **Evidence structure:** every finding has a source quotation, applicability, conditions, exceptions and an uncertainty state. The kinds of findings stay open-ended.
3. **Answer structure:** every answer states what is covered, what is limited or excluded, which conditions apply, what remains unknown and where the evidence came from.

Policy content stays flexible. The evidence and answer formats stay consistent.

## Risk: one relevant clause is not every relevant clause
- Page 12: cataract surgery covered.
- Page 38: maximum ₹40,000 per eye.
- Page 61: two-year waiting period.
- Endorsement: waiting period waived for an eligible member.

A similarity search could return only page 12 and wrongly conclude the surgery is covered without qualification. The mitigations:
- read the whole policy when it fits the budget;
- check every clause kind on the question's checklist;
- run a **mandatory sweep for overriding or conflicting clauses**;
- evaluate recall, where a missed override is a hard fail.

Money, dates, deductibles and all other arithmetic stay in deterministic code.

## Component changes
| Component | Decision |
|---|---|
| Sarvam OCR | Keep |
| Stored document blocks | Keep (already the clause source) |
| Privacy gate | Keep; extend to every clause sent at question time; fix the card false positive first (Phase A S1) |
| Gemini extraction | Change from exhaustive registry filling to evidence-driven extraction |
| 138-parameter registry | Keep as an optional common-facts catalogue |
| Policy-specific terms | Store as open-ended evidence (findings), not forced registry keys |
| Retrieval | Whole gated policy under the token budget; SQLite FTS5 above it. Embeddings or a vector DB only after measured recall failures |
| Deterministic validation | Keep (quotes, values, money, dates, arithmetic) |
| Human verification | Keep for consequential coverage decisions |

## Constraints this direction must respect (from AGENTS.md)
- Model output stays `extracted_unverified`, `conflicting` or `unknown`. An answer is cited evidence, never a coverage verdict.
- Question-time model use is a new consent purpose, with the wording marked for legal review.
- Every new derived store (clauses, FTS index, findings, answers) needs an erasure path and a test.
- The architecture change needs ADR 0008 before any Phase B code.
- No scale or accuracy claims without measured evidence. Current evidence is from one document.

## Tradeoff
This approach gains flexibility but does not guarantee completeness. Retrieval recall and override coverage must be measured (Phase B, slice B5) before the answers are relied on.

---

# Execution plan

## Context
The live run on 2026-10-20 (`.local/live-backend-run-2026-10-20T04-15-44-884Z/`) parsed and stored a 20-page policy, but only 38 of 138 registry parameters were filled. Few of the 18 golden fields came out correct. Requirement from the user: **every data point that is useful to a human or to the AI must be stored**.

Read-only diagnosis in this session found the root causes. None of them is "the model can't read". They are pipeline bugs:
1. **Privacy gate false positive.** All 5 `privacy_gate_refused` chunks contain the same 19-digit policy number. It happens to pass the Luhn check and starts with a digit that matches the broad `CARD_NETWORK_PREFIX = /^[2-68]/`, so the gate treats it as a payment card and refuses the whole chunk (`privacy-evidence-gate.js:290,314-341`). These chunks are the schedule pages 1, 2, 3 and 10. With that number masked, all 5 pass.
2. **Ambiguous-target rejection.** 64 items were rejected because both `registry_key` and `proposed` were filled. 60 of them carry a valid, model-allowed registry key, including `d.sum_insured`, `b.policy_period`, `a.product_uin_and_version`, `d.room_rent_limit` and `d.icu_charge_limit`. The other 4 had a `proposed` object with empty strings. Cause: `validator.js:130` uses `present()`, and the schema leaves both fields optional.
3. **Scorer faults.** The two "wrong" waiting periods are correct: the readings contain "30 days" and "24 months", but the value is a whole clause, so `normalizeValue('duration')` returns null (`validator.js:40-45`). `co_payment`'s golden value is "unknown", but the scorer marks it `missed`.
4. **An existing deterministic extractor is unused for storage.** `src/features/ai-analysis/eval-extractor.js` `extractFields` matches **17/18 golden fields** on this document (co_payment correctly unknown), each on the correct page. Today it is only used to collect names for redaction (`policy-structuring-service.js:26`). It was written against this one document, so overfitting is likely.
5. **Malformed response.** One Gemini call (pages 1–2, chunks of 35, 43 and 417 characters) raised `AI_NoObjectGeneratedError`. There is no retry, and tiny chunks waste calls.
6. **Ops bugs.** `openDatabase` resolves `'.local/knowvia.sqlite'` under `resolve('.local')`, which produces `.local/.local/` (`database.js:192-196`). The PDF inspector over-counts pages: 28 found against 20 real (`pdf-inspection.js:182-184`, documented as "can only over-count"), and that count goes into document metadata (`document-intake-service.js:99`).
7. **Cost.** About 25k of the 66.7k output tokens are reasoning, plus about 15k characters of rationale.

## Revised direction (after user's evidence-first proposal)

I accept the direction: **standardise evidence and answers, not policy content.** Three corrections, each based on what this session measured:
1. **The failures were pipeline bugs, not the registry's rigidity.** The gate false positive, the ambiguous targets and the scorer faults would hurt an evidence-first system just as much: a RAG chunk carrying the policy number would be refused by the same gate. So Phase A fixes stay, as prerequisites.
2. **For documents this size, read the whole policy, not top-k.** This policy is about 17k tokens of OCR text, or about 69k characters. Retrieval recall, the "page 12 found, page 38 cap missed" risk, mostly goes away if every question gets the whole gated policy with clause ids. Use FTS5 retrieval (available in node:sqlite, verified) only when the document set exceeds a token budget, for example comparing many policies or very long wordings. Both paths share the same evidence contract.
3. **Answers stay conditional, not verdicts.** AGENTS.md says deterministic code owns eligibility and money decisions. "Will cataract be covered for my mother" therefore returns cited findings, conditions, overrides and unknowns, with model output capped at extracted_unverified. Arithmetic (caps, co-pay, deductibles) is done by deterministic code from extracted values. Any coverage conclusion needs deterministic rules or human verification.

Other things the proposal needs:
- An **ADR 0008**, because this is a hard-to-reverse architecture change.
- **Consent scope.** Question-time Gemini use is a new purpose (`answer`, not `derive`); the wording needs legal review.
- **Erasure.** Every new derived store (clause index, FTS table, answers, findings) needs an erasure path and a test.
- **A recall eval.** A golden question set listing the clauses each question must cite, including the overrides.
- **Naming.** The product name is CoverSaath per AGENTS.md; "Knowvia" stays only in legacy identifiers.

Phase A is the XML below. Run S5 as the "common facts" layer, not as registry-first. Phase B, evidence-first, is the second XML block. Step 1 of BUILD is to save both as `docs/exec-plans/active/policy-data-capture.xml` and `docs/exec-plans/active/evidence-first-reasoning.xml`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<implementation_prompt id="coversaath-policy-data-capture" version="1.0" created="2026-10-20" status="planned">
  <title>Policy data capture: fix gate false positive, target ambiguity, value shape, scorer; add deterministic schedule layer; ops fixes</title>
  <base_branch>codex/backend-first-layout (working tree, uncommitted hardening work present)</base_branch>
  <decision_record>docs/adr/0006-policy-document-structuring.md addendum (deterministic schedule layer, gate card rule)</decision_record>
  <risk_class>security-sensitive (privacy gate), AI-authority, data-sensitive (RESTRICTED identifiers stored), cost-sensitive (paid Gemini re-run)</risk_class>

  <persona>
    Implementation owner of a consent-first insurance extraction backend. Skeptical of own output and of eval numbers.
    Treats the gate as a security control: a fix may change refusal into minimisation, never into sending a raw identifier.
    Deterministic code decides; models propose. One slice per PLAN/BUILD/FEEDBACK loop, red test first.
    Spends no money without a recorded explicit approval. Synthetic data only in code, tests, fixtures, commits.
    Never prints document values, the policy number or member names in logs, reports or chat; counts and field names only.
    Terse reports with evidence.
  </persona>

  <user_outcome>
    Every data point in a policy that is useful to a person or to the AI is stored with page and evidence:
    all applicable registry parameters, out-of-registry facts as proposals, and RESTRICTED identifiers
    (policy number, named members) via deterministic extraction that never reaches a model.
  </user_outcome>

  <start_here>
    <read>AGENTS.md, src/features/input/AGENTS.md, src/integrations/AGENTS.md, docs/iterations/LATEST.md</read>
    <read>docs/exec-plans/active/policy-structuring-hardening.xml: in progress and uncommitted. It touches outcome.js, coverage-report.js, index.js, the service and the repository. Read its slice status first, build on top of the working tree, revert nothing.</read>
    <read>docs/adr/0003-ai-authority.md, docs/adr/0006-policy-document-structuring.md, docs/runbooks/policy-structuring.md</read>
    <read>src/features/ai-analysis/privacy-evidence-gate.js:247-375 (RESTRICTED_PATTERNS, luhnValid, cardClassification, containsPaymentCard), 1136-1172 (redactText, sanitizeEvidenceTextForStorage)</read>
    <read>src/features/policy-structuring/index.js (gateChunks, structurePolicyDocument), extractor.js, validator.js:40-46,120-205, reconciler.js (decideStates), sectioner.js, coverage-report.js:97-200</read>
    <read>src/features/ai-analysis/structuring-contract.js (EXTRACTION_SCHEMA, STRUCTURING_INSTRUCTIONS), eval-extractor.js (FIELD_SPECS, extractFields)</read>
    <read>src/backend/services/policy-structuring-service.js, src/backend/repositories/policy-structuring-repository.js (commitStructuring, MODEL_REPLACEABLE_AUTHORITIES), coverage-parameter-repository.js:421-470,502-560,630-714</read>
    <read>src/backend/database/database.js:192-215, scripts/database.mjs, src/server/create-server.js:97</read>
    <read>src/features/input/pdf-inspection.js:182-241,420-449, document-intake-service.js:99, sandboxed-pdf-segmentation.js</read>
    <note>Run repomap impact on each shared file before editing. Use Context7 for any AI SDK (generateObject / NoObjectGeneratedError / thinking config) API question.</note>
  </start_here>

  <confirmed_facts>
    <fact id="F1">All 5 refused chunks (pages 1, 1, 2, 3 and 10) contain one 19-digit run that passes Luhn and matches CARD_NETWORK_PREFIX /^[2-68]/. Masking runs of 13 or more digits makes all 5 pass. Evidence: local read-only run of sanitizeEvidenceTextForStorage on the stored chunks.</fact>
    <fact id="F2">64 of 233 raw items are ambiguous_target: 60 have a valid model-allowed registry_key plus a filled proposed; 4 have proposed {proposed_key:"",category:"",label:""}. Evidence: provider-trace.json item shapes.</fact>
    <fact id="F3">The initial and specified-disease waiting-period readings contain the golden durations inside whole clauses. duration() returns null when the text holds more than one number (Code-Excl03 adds a digit), so normalized is null and the scorer says "wrong".</fact>
    <fact id="F4">The golden co_payment value is the string "unknown"; scoreCriticalFields reports it as missed.</fact>
    <fact id="F5">eval-extractor extractFields on the stored blocks gives 17 extracted_unverified plus co_payment unknown. All 18 match the golden value and page. The rules were authored against this document; generalisation is unmeasured.</fact>
    <fact id="F6">The observation path already supports authority 'deterministic' with extraction_method 'document_extraction'. The model-forbidden check fires only for authority 'model' (coverage-parameter-repository.js:532). Redaction covers document_extraction rows (:674). No migration is needed to store deterministic readings.</fact>
    <fact id="F7">Gemini call 0 raised AI_NoObjectGeneratedError on chunks of 35, 43 and 417 characters. The extractor records provider_error with no retry (extractor.js:100-104).</fact>
    <fact id="F8">openDatabase resolves the path against resolve('.local'). The default and .env DATABASE_PATH '.local/knowvia.sqlite' therefore land in .local/.local/knowvia.sqlite. Tests pass absolute paths, so they are unaffected.</fact>
    <fact id="F9">The inspector's pageCount over-counts by design (raw /Type /Page objects) and is written to upload metadata. Segmentation uses pdf-lib getPageCount, which is authoritative.</fact>
    <fact id="F10">The stored run is policy-structuring/v2. alreadyStored() replays any live run of the same version, so a re-run needs a POLICY_STRUCTURING_VERSION bump.</fact>
  </confirmed_facts>

  <blocking_unknowns>
    <unknown id="U1" slice="S6">Where the Gemini call sets the thinking budget and whether the schema supports maxLength (find the gateway that calls generateObject; check with Context7). If not configurable: cap rationale in validator only.</unknown>
    <unknown id="U2" slice="S5">Whether GET /api/v1/documents/:id/structuring-runs masks RESTRICTED values. Read v1-backend-routes.js before storing identifiers. Default per D2.</unknown>
    <unknown id="U3" slice="S5">How general the eval-extractor label rules are. Resolve by measuring against synthetic schedules with label variants; generalisation to other insurers stays unverified until a second owner-verified policy exists.</unknown>
  </blocking_unknowns>

  <decisions default_applies_unless_user_overrides="true">
    <decision id="D1">One retry per batch, only for a malformed or unparseable response (AI_NoObjectGeneratedError, missing items array). The retry counts against maxCallsPerDocument and the token budget, consent is re-checked first, and there is never a retry on budget_stop, timeout or provider_error. Reason: the "no retries" rule in the hardening plan targeted unbounded paid retries; this one is bounded and counted.</decision>
    <decision id="D2">RESTRICTED values (policy number, named members) are stored and returned only to an authorised household member through the existing protected route. They never go into audit metadata, logs, model prompts or eval output.</decision>
    <decision id="D3">The S9 live run costs about $0.30 per run (about $0.90 with the repeatability runs). It needs explicit user approval at that time.</decision>
    <decision id="D4">No commit, push or deploy unless asked.</decision>
  </decisions>

  <scope>
    <in>
      <path>src/features/ai-analysis/privacy-evidence-gate.js</path>
      <path>src/features/ai-analysis/structuring-contract.js</path>
      <path>src/features/ai-analysis/eval-extractor.js (export reuse only; no behaviour change except added label variants backed by synthetic tests)</path>
      <path>src/features/policy-structuring/{index,extractor,validator,reconciler,sectioner,coverage-report}.js and new schedule-layer.js</path>
      <path>src/backend/services/policy-structuring-service.js, src/backend/repositories/policy-structuring-repository.js</path>
      <path>src/backend/database/database.js, scripts/database.mjs</path>
      <path>src/features/input/document-intake-service.js (page count source)</path>
      <path>scripts/eval-structuring-accuracy.mjs, new scripts/replay-structuring.mjs (offline, local-only)</path>
      <path>tests: listed per slice; evals/safety cases</path>
      <path>docs/adr/0006 addendum, docs/runbooks/policy-structuring.md, docs/iterations/LATEST.md</path>
    </in>
    <out>
      Sanitising active-content PDFs in product (separate plan). Encrypting OCR text at rest (needs an ADR). Vendor retention
      verification (contract task). Promoting proposals into the registry. Registry growth. UI. Deployment. Accuracy claims beyond n=1.
      Renaming knowvia. Final legal or consent wording.
    </out>
  </scope>

  <metrics baseline_run=".local/live-backend-run-2026-10-20T04-15-44-884Z" sample="1 sanitized 20-page document, 18 owner-verified fields; provisional, not an accuracy claim">
    <metric id="M1" name="privacy_gate_refused chunks" baseline="5/45" pass="0 caused by an unlabelled Luhn digit run" fail="any refusal of a policy-labelled or unlabelled number; any card-labelled number NOT refused"/>
    <metric id="M2" name="ambiguous_target rejections" baseline="64/233" pass="&lt;= 4" fail="&gt; 4"/>
    <metric id="M3" name="skipped chunks" baseline="15/45 (33%)" pass="&lt;= 3/45 (&lt;= 7%)" fail="&gt; 5/45"/>
    <metric id="M4a" name="critical fields wrong" baseline="2 (scorer artefact)" pass="0" fail="&gt;= 1 (hard block)"/>
    <metric id="M4b" name="critical fields correct incl. correct_unknown" baseline="5/18 after S0 re-score" pass="&gt;= 16/18" fail="&lt; 14/18"/>
    <metric id="M4c" name="conflicting_without_correct" baseline="3" pass="&lt;= 1" fail="&gt; 2"/>
    <metric id="M4d" name="unknown_by_design (identifier fields)" baseline="3" pass="0; filled by the deterministic layer, never by the model" fail="any identifier observation with authority 'model'"/>
    <metric id="M5" name="registry parameters with a reading" baseline="38/138" pass="&gt;= 55/138 (provisional)" fail="&lt; 38 (regression)"/>
    <metric id="M6" name="proposals stored" baseline="56" pass="reported; no target" fail="drop &gt; 30% with no drop reason counted"/>
    <metric id="M7" name="cost per run" baseline="$0.288, 66.7k output tokens" pass="&lt;= $0.30 and &lt;= 60k output tokens" fail="&gt; $0.40"/>
    <metric id="M8" name="identifier leakage" baseline="0" pass="0 occurrences of the policy number and the 4 detected names in Gemini prompts, audit events, logs, eval output" fail="&gt;= 1 (hard block, stop)"/>
    <metric id="M9" name="repeatability (3 runs, if approved)" pass="&gt;= 16/18 fields with identical outcome across runs" fail="&lt; 14/18"/>
    <metric id="M10" name="offline suite" pass="npm run check, eval:safety (23 + new cases), check:architecture, git diff --check all green; 0 failed tests" fail="any red"/>
  </metrics>

  <slices>
    <slice id="S0" title="Measurement correctness first" risk="normal">
      <files>src/features/policy-structuring/coverage-report.js, scripts/eval-structuring-accuracy.mjs</files>
      <change>Golden value "unknown" with no reading gives outcome correct_unknown. typedReadings also scans duration and money fragments, as it already does for dates, and accepts a fragment only when exactly one fragment of the golden type is in the reading. The eval script writes its summary into the run directory and is the single canonical scorer.</change>
      <tests>tests/policy-structuring-critical-fields.test.mjs: red first for F3 (clause with "Code-Excl03 ... 30 days" matches "30 days"; "36 / 24 / 12 months" does NOT match "3 Years"); F4 (golden unknown, no readings, gives correct_unknown; golden unknown with a reading gives wrong); typed matches keep rejecting 5000 vs 50000.</tests>
      <pass>Re-scoring the baseline run gives wrong=0 and initial/specified waiting periods correct. Record the corrected baseline in the plan before S1.</pass>
    </slice>

    <slice id="S1" title="Gate: policy numbers are identifiers, not cards" risk="security-sensitive" review="independent read-only review required">
      <files>src/features/ai-analysis/privacy-evidence-gate.js (cardClassification, containsPaymentCard, ID label set, version bump to knowvia-privacy-evidence-v5)</files>
      <change>A digit run whose 48-character prefix carries an identifier label (policy, certificate, member, proposal, receipt, claim, customer, UIN, e-card + no/number/id) is minimised to a DIRECT_IDENTIFIER placeholder and not classified as a card. An unlabelled Luhn-valid run that matches only on CARD_NETWORK_PREFIX is minimised ('ambiguous' path), not rejected. A card-labelled run (CARD_LABEL) is still RESTRICTED and rejected. The raw digits never survive in gated text.</change>
      <tests>New tests/privacy-gate-policy-numbers.test.mjs with Luhn-valid 13–19 digit numbers generated inside the test (synthetic). Cases: labelled policy number becomes a placeholder; unlabelled number becomes a placeholder; "card number" and "credit card" labelled still throw RESTRICTED_EVIDENCE; grouped 4-4-4-4 card with label still throws; the placeholder never contains digits; the existing privacy-gate-*.test.mjs and privacy-evidence-gate.test.mjs stay green unchanged. Add 3 cases to the eval:safety suite.</tests>
      <offline_evidence>scripts/replay-structuring.mjs --gate: run the gate on the stored chunks of the local DB, printing codes and counts only. Expected M1 = 0.</offline_evidence>
      <fail_stop>Any existing gate test needs editing in order to pass. Stop and report: that would be weakening a control.</fail_stop>
    </slice>

    <slice id="S2" title="Exactly one target per item" risk="AI-authority">
      <files>src/features/policy-structuring/validator.js (checkTarget, present for proposed), src/features/ai-analysis/structuring-contract.js (registry_key and proposed nullable, instruction "fill exactly one; never both"), extractor.js EXTRACTOR_VERSION bump</files>
      <change>A proposed object whose fields are all empty counts as absent. When both are filled and registry_key is valid and model-allowed, accept the registry reading, drop the proposal and count proposal_dropped_registry_match. When registry_key is invalid or forbidden and proposed is valid, record a proposal. If neither is filled, keep ambiguous_target. A forbidden registry_key is never accepted.</change>
      <tests>tests/policy-structuring-validator.test.mjs: one red test per branch above, including forbidden key + proposed gives a proposal (never a reading of a forbidden key); tests/outgoing-payload-structuring.test.mjs checks the schema shape.</tests>
      <offline_evidence>scripts/replay-structuring.mjs --validate: re-validate the saved Gemini outputs from provider-trace.json against the stored chunks, with no paid call. Expected M2 &lt;= 4.</offline_evidence>
    </slice>

    <slice id="S3" title="Atomic values" risk="AI-authority">
      <files>src/features/policy-structuring/validator.js (duration and money normalisation of clause values), structuring-contract.js (value = shortest printed phrase; clause goes in evidence_quote)</files>
      <change>For typed registry keys, when the stored text holds exactly one fragment of the definition's valueType, set normalized from that fragment. Stored text stays verbatim from the document, and model wording is never stored.</change>
      <tests>tests/policy-structuring-validator.test.mjs: "Initial waiting Period (Code-Excl03): 30 days ..." gives {duration 30 day}; two durations give normalized null; a code digit never becomes the amount.</tests>
    </slice>

    <slice id="S4" title="No lost chunks" risk="cost-sensitive">
      <files>src/features/policy-structuring/sectioner.js (merge a chunk under 200 characters into the next same-page chunk within maxChunkChars), extractor.js (D1 single retry)</files>
      <tests>tests/policy-structuring-sectioner.test.mjs (tiny chunks merged; block indexes preserved; never merged across pages); tests/policy-structuring-extractor.test.mjs (malformed then valid is extracted with 2 calls; malformed twice gives skipped malformed_after_retry; retry blocked when the call cap is reached; consent revoked between attempts stops the retry; budget_stop and timeout are not retried).</tests>
    </slice>

    <slice id="S5" title="Deterministic schedule layer" risk="data-sensitive, AI-authority" review="independent read-only review required">
      <files>new src/features/policy-structuring/schedule-layer.js (wraps eval-extractor extractFields, maps fields to registry keys via CRITICAL_FIELD_KEYS, merges policy_period_start and end into b.policy_period and policyholder plus members into c.named_insured_members); index.js (run it on the ungated stored blocks locally, never sent to a model); reconciler.js decideStates; policy-structuring-repository.js commitStructuring (authority 'deterministic', extraction_method 'document_extraction', value metadata extractor 'schedule-rules/v1'); policy-structuring-service.js; POLICY_STRUCTURING_VERSION bump to v3</files>
      <change>Deterministic readings are stored at most extracted_unverified. A model reading that agrees is corroboration. One that disagrees makes the parameter conflicting, keeping both readings. A model reading whose quote defers to the schedule ("as stipulated in the Policy Schedule") is marked context_reference and does not create a conflict when a schedule reading exists; this fixes ped_waiting_period and room_rent_limit. RESTRICTED keys come only from this layer.</change>
      <tests>New tests/policy-structuring-schedule-layer.test.mjs with synthetic schedules: label variants, missing labels give unknown, two disagreeing schedule values give conflicting. tests/policy-structuring-authority.test.mjs: deterministic never above extracted_unverified, and the model never writes a RESTRICTED key. tests/policy-structuring-persistence.test.mjs: deterministic rows erased on consent revocation and on document erase (redaction path :674). New audit no-leak test: synthetic identifiers never in audit_events or workflow_events. tests/policy-structuring-journey.test.mjs: end to end with a fixture provider, where identifier fields are filled and the model payload contains placeholders only.</tests>
      <fail_stop>Storing identifiers would require weakening the tenant or ownership checks, or adding a model path for RESTRICTED keys. Stop.</fail_stop>
    </slice>

    <slice id="S6" title="Cost" risk="cost-sensitive">
      <files>structuring-contract.js (rationale at most 12 words), validator.js (rationale over 160 characters truncated before storage, never a rejection), the gateway thinking config per U1</files>
      <tests>tests/policy-structuring-validator.test.mjs (long rationale is truncated and the item still accepted); outgoing payload snapshot.</tests>
    </slice>

    <slice id="S7" title="Ops bugs" risk="migration-sensitive (local data location)">
      <files>src/backend/database/database.js (a relative path resolves against cwd, then must lie inside resolve('.local'); a legacy .local/.local/knowvia.sqlite present while the target is absent throws coded DATABASE_LEGACY_PATH naming the runbook move step; never move automatically), scripts/database.mjs, document-intake-service.js (store the pdf-lib count as pageCount once segmented; keep the inspector count only as a limit check, named pageObjectCount)</files>
      <tests>New tests/database-path.test.mjs: '.local/x.sqlite' resolves to &lt;cwd&gt;/.local/x.sqlite; '../x' is rejected; an absolute path inside .local is accepted; the legacy-path case throws the coded error. tests/pdf-inspection.test.mjs: a synthetic PDF with orphan /Type /Page objects shows the metadata pageCount equal to the real page count.</tests>
      <runbook>docs/runbooks/policy-structuring.md: manual one-time move of .local/.local/knowvia.sqlite (+ -wal, -shm) after stopping the server. Ask the user before moving.</runbook>
    </slice>

    <slice id="S8" title="Live acceptance (paid, D3)" risk="cost-sensitive, data-sensitive">
      <steps>Get explicit approval and confirm current document-specific consent. Re-run scripts/structure-policy.mjs on the same sanitized derivative. Run scripts/eval-structuring-accuracy.mjs. Fill in the M1–M8 table against the baseline. Optionally run M9 (3 runs). Delete or keep provider-trace.json as the user chooses (mode 600).</steps>
      <pass>All hard-block metrics pass (M1, M4a, M4d, M8) and M3 and M4b meet their pass values.</pass>
    </slice>
  </slices>

  <verification>
    <each_slice>Red test reproducing the defect, then the fix, then the narrow test file(s), then node --test on the touched suites.</each_slice>
    <before_completion>npm run check; npm run eval:safety; npm run check:architecture; npm test; git diff --check; the offline replay script (M1, M2) on the local DB; independent read-only reviews for S1 and S5 (cavecrew-reviewer or /review), with findings recorded.</before_completion>
    <unverified_by_design>Generalisation to other insurers and documents (n=1). Vendor retention. The unsanitised original PDF path.</unverified_by_design>
  </verification>

  <rollback>
    Each slice is a separate revertable change with no schema migration. The version bumps (gate v5, extractor, structuring v3) keep old runs readable; reverting a bump makes the old pipeline replay its stored runs again. The S7 DB path change is reverted by restoring openDatabase; data is never moved automatically.
  </rollback>

  <report_format>
    Per slice: changed files, tests added (red then green), checks run with pass and fail counts, metric deltas versus baseline (counts only),
    security and data impact, what remains unverified, rollback. Final: the M1–M10 table, cost, follow-ups.
  </report_format>

  <follow_ups>
    Active-content PDF sanitisation in product (users' insurer PDFs carry JavaScript). Encrypting OCR text at rest (ADR). Vendor retention and deletion verification.
    A second owner-verified policy from another insurer to measure schedule-rule generalisation. A registry growth path from recurring proposals.
  </follow_ups>
</implementation_prompt>
```

## Phase B: evidence-first reasoning

```xml
<?xml version="1.0" encoding="UTF-8"?>
<implementation_prompt id="coversaath-evidence-first-reasoning" version="1.0" created="2026-10-20" status="planned" depends_on="coversaath-policy-data-capture S0,S1,S2,S7">
  <title>Evidence-first policy reasoning: clause store, whole-policy or retrieved context, override sweep, cited conditional answers</title>
  <decision_record>new docs/adr/0008-evidence-first-reasoning.md (registry becomes an optional common-facts catalogue)</decision_record>
  <risk_class>AI-authority, consent-sensitive (new purpose), data-sensitive (new derived stores), cost-sensitive (per-question model calls)</risk_class>

  <persona>
    Same owner persona as Phase A. Additionally: assumes one retrieved clause is never the whole story. Every answer must show
    which overrides were checked. Prefers reading the whole policy over clever retrieval until measurements prove otherwise.
    A model answer is evidence, never a coverage decision.
  </persona>

  <standardised_contracts>
    <contract name="document_metadata">documentId, policyId (opaque), insurer, documentType (wording|schedule|certificate|endorsement|brochure), sourceVersion, issuedDate when printed, page, sectionPath. Lives in src/contracts/.</contract>
    <contract name="clause">clauseId, documentId, sourceVersion, page, blockIndexes, sectionPath, kind (benefit|limit|condition|exclusion|waiting_period|definition|endorsement|schedule_fact|procedure|other), text (stored as OCR blocks already are), digest. Built deterministically from the stored blocks via sectioner.js. No model needed.</contract>
    <contract name="finding">findingId, clauseIds[] (at least 1), quote (verbatim, validated against the clause), subject, appliesTo (member|plan|rider|hospital-type|open text), conditions[], exceptions[], overrides[] (clauseIds), value (optional, normalised by validator.js), state (extracted_unverified|conflicting|unknown), openKind (free text; optional registryKey).</contract>
    <contract name="answer">question, covered[], limited_or_excluded[], conditions[], overrides_checked[] (clause kinds and ids swept), unknowns[], calculations[] (deterministic only), sources[] (document, page, quote), state, disclaimer marker for legal review. Never a bare yes or no.</contract>
  </standardised_contracts>

  <slices>
    <slice id="B0" title="ADR 0008 + consent scope design" risk="consent-sensitive">
      <files>docs/adr/0008-evidence-first-reasoning.md; src/contracts/ (consent scope action 'answer' for recipient google-gemini, marked for legal review)</files>
      <pass>The ADR records: registry kept as an optional catalogue; whole-policy context below a token budget (provisional 120k gated tokens per question) with FTS5 above it; deterministic arithmetic; findings capped at extracted_unverified; erasure of all derived stores.</pass>
    </slice>
    <slice id="B1" title="Clause store" risk="migration-sensitive, data-sensitive">
      <files>SQLite migration 015_policy_clauses.sql + Postgres 012 with parity test; src/backend/repositories/clause-repository.js; src/features/policy-evidence/ (new feature, index.js) building clauses from sectionStoredDocument output</files>
      <tests>Deterministic clause build (same blocks give the same clause ids and digests); household ownership enforced on every read; erasure on revocation and document erase removes clauses; Postgres catalog parity.</tests>
    </slice>
    <slice id="B2" title="FTS5 index" risk="data-sensitive">
      <files>migration 016 FTS5 virtual table over clauses (porter unicode61), maintained in the repository transaction; Postgres equivalent tsvector, or an ADR note deferring it</files>
      <tests>Recall on synthetic clauses; erasure removes FTS rows (FTS tables have no triggers by default; test explicitly); no cross-household match.</tests>
    </slice>
    <slice id="B3" title="Investigation pipeline" risk="AI-authority, cost-sensitive">
      <files>src/features/policy-evidence/investigate.js: (1) plan the question with a deterministic checklist of clause kinds per question type (coverage question means benefit + limit + waiting_period + exclusion + definition + endorsement + schedule_fact for the member); (2) context = whole gated policy if under budget, else FTS top-k per checklist kind plus all endorsement and schedule clauses; (3) Gemini returns findings referencing clauseIds; (4) mandatory override sweep: a second pass asking only for clauses that limit, exclude, waive or override the findings; (5) deterministic validator checks quotes, clause ids, values and arithmetic; (6) answer assembled by code</files>
      <tests>Fixture provider: a finding citing a non-existent clause is rejected; a quote not in the clause is rejected; an override sweep that finds a cap moves the answer into limited; consent revoked mid-question stops it; payload contains gated text only (privacy gate on every clause); budget caps per question.</tests>
    </slice>
    <slice id="B4" title="Answer API" risk="security-sensitive">
      <files>src/server/routes/v1-backend-routes.js: POST /api/v1/cases/:caseId/questions (idempotency key, household ownership, coded errors), GET answer by id; answers stored with erasure path</files>
      <tests>Permission (other household gets 404), duplicate request replays, revocation erases answers, client-safe errors.</tests>
    </slice>
    <slice id="B5" title="Recall eval" risk="normal">
      <files>.local/eval/golden-questions.json (owner-authored, gitignored): question, required clause pages (including overrides), expected conditions; scripts/eval-evidence-recall.mjs</files>
      <metrics>
        <metric id="R1" name="required-clause recall" pass="&gt;= 95% of required pages cited across questions; 100% of override/exception pages" fail="any missed override is a hard block"/>
        <metric id="R2" name="unsupported findings" pass="0 findings without a valid clause and quote" fail="&gt;= 1"/>
        <metric id="R3" name="answer has unknowns when evidence missing" pass="100% of questions designed with missing evidence" fail="any confident answer without evidence"/>
        <metric id="R4" name="cost per question" pass="&lt;= $0.03 provisional (about 17k input tokens whole-policy)" fail="&gt; $0.10"/>
        <metric id="R5" name="privacy" pass="0 identifiers in prompts, audit, logs" fail="&gt;= 1 hard block"/>
      </metrics>
      <sample>Start with 15 owner-written questions on the current policy (e.g. cataract for a member, room rent at a network hospital, maternity, PED claim in year 2). n=1 document. Not an accuracy claim.</sample>
    </slice>
  </slices>

  <out>UI. Vector DB or embeddings (only after R1 fails measurably on FTS). Automated coverage verdicts. Multi-insurer comparison ranking. Deployment.</out>
  <verification>Same broad checks as Phase A, plus independent read-only review for B0, B3 and B4. B5 paid runs need explicit approval.</verification>
</implementation_prompt>
```

## Order and dependencies
S0 runs first so every later number is trustworthy. S1 and S2 can each be proven offline, for free, with the replay script. S3, S4 and S6 are small. S5 is the biggest gain and needs review. S7 is independent. S8 is the only paid step and is gated on approval.

**User decisions (2026-10-20):** lean sequencing. Run Phase A S0, S1, S2 and S7 only. Defer S3, S4, S5, S6 and S8, and keep them as backlog. For a single policy, the whole gated policy is the context while under budget, with FTS5 only above the budget.

Phase B starts once Phase A's S0, S1, S2 and S7 are done; it does not need S5 or S8. B0, the ADR and consent scope, comes before any Phase B code. B1, B2 and B3 can reuse the stored blocks immediately, with no OCR re-run. If you want to pivot faster, cut Phase A to S0, S1, S2 and S7 and skip S5, S6 and S8.
