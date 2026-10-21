# Household reasoning (Block 4)

Status: implemented and synthetic-tested. Not externally validated. Not production ready. No insurer, TPA, hospital or Insurance Data API source is consulted.

Block 4 turns authorised Block 3 evidence (`decision-handoff/v1`) into a household-level, member-scoped, evidence-grounded preview: what the available documents establish, what they do not, which restrictions are documented, where two policies may overlap, and the smallest set of follow-up questions and actions that would improve the answer. It never decides coverage, money or eligibility.

## Where it sits

```
client ──POST /api/v1/households/{id}/coverage-preview──▶ route (auth, body limit)
   route ─▶ household-preview-service (src/backend/services)
              ├─ validateScenarioInput        (pure, strict)
              ├─ households.requireAccess     (household read)
              ├─ member belongs to household
              ├─ for each source: case ∈ household, source-pack consent gate   ← before any read
              ├─ decision catalogue service .build(...)  → toHandoff            (Block 3, unchanged)
              └─ buildHouseholdCoveragePreview (pure, src/features/household-reasoning)
```

- The request names sources (`caseId`, `answerId`). The server builds every handoff itself, with the same consent, answer-access and document-currency checks as `GET /cases/{id}/decision-catalogue`. A handoff, citation, association, role or amount in the body is refused (`HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD`).
- The independent-reviewer exemption is never used. `documentsUntil` is never passed.
- Stateless (ADR-compatible): nothing is stored, no migration, no new table, no queue. Follow-up context comes back in the next request as `scenario.answers`. A preview writes no row (asserted by a before/after row count over every table).
- No provider call, no network, no log of scenario content.

Rollback: remove the route block and `getHouseholdPreviewService` wiring in `src/server/routes/v1-backend-routes.js` and `src/server/create-server.js`, or delete the route only. Block 3, its data and every existing route are untouched. See "Rollback" in the acceptance record.

## Modules (`src/features/household-reasoning/`)

| File | Responsibility |
| --- | --- |
| `contracts.js` | closed vocabularies, limits, `HouseholdReasoningError`, date helpers, character screen |
| `scenario-input.js` | `validateScenarioInput` (strict, closed schema; merges direct fields with accepted answers and refuses contradictions) |
| `normalize.js` | `normalizeSources`: authority-non-increasing evidence model, deduplication, cross-input conflicts |
| `relevance.js` | which rules matter for which scenario; token topic matching |
| `coverage-map.js` | one position per policy and member |
| `comparison.js` | restrictions, evidence gaps, possible overlap, unresolved coordination |
| `context-gaps.js` | `buildContextGaps` (rules G01 to G10) |
| `question-planner.js` | finite question bank and `selectFollowUpQuestions` |
| `next-actions.js` | next actions and external checks |
| `preview.js` | `buildHouseholdCoveragePreview` and the assessment state |
| `output-contract.js` | `assertHouseholdPreviewContract` (also run before every response) |

The core is pure: no I/O, clock or randomness. Identical inputs give identical output (tested over repeated runs and source orderings).

## Request: `household-scenario/v1`

```json
{
  "contractVersion": "household-scenario/v1",
  "sources": [{ "caseId": "...", "answerId": "..." }],
  "scenario": {
    "scenarioType": "planned_procedure | general_benefit | policy_comparison | emergency_admission | cashless_information",
    "reportedMemberRelation": "self|spouse|father|mother|son|daughter|sibling|parent_in_law|other",
    "memberId": "household member id",
    "procedureText": "free text, 2000 max", "topic": "free text, 160 max",
    "plannedMonth": "YYYY-MM", "plannedDate": "YYYY-MM-DD",
    "reportedPolicyType": "individual|family|group|top_up|super_top_up|not_sure",
    "hospital": { "name": "", "city": "", "branch": "" },
    "answers": { "<answer key>": "value | YES | NO | I_DO_NOT_KNOW | SKIPPED" }
  }
}
```

- Every object is closed. Unknown keys fail with `HOUSEHOLD_SCENARIO_UNKNOWN_FIELD`; authority-looking keys (`verified`, `citations`, `handoff`, `enrolled`, `sumInsured`, `reviewerRole`, ...) fail with `HOUSEHOLD_SCENARIO_FORBIDDEN_FIELD`. Other codes: `HOUSEHOLD_SCENARIO_INVALID`, `_VERSION_UNSUPPORTED`, `_DUPLICATE_SOURCE`, `_CONTRADICTORY`, `_TOO_LARGE` (400); `HOUSEHOLD_PREVIEW_BOUND_EXCEEDED` (422).
- Limits: 1 to 5 unique sources; at most 20 policies and 1000 items in total across sources (a breach is a coded 422); 50 answers; 2000 characters procedure text; 160 for topic, hospital fields and text answers; 128 for identifiers (`[A-Za-z0-9][A-Za-z0-9._:-]*`); 16 KiB body (the shared reader answers 413). Control characters, line separators, zero-width and bidirectional-override characters, the byte-order mark and lone surrogates are refused.
- Answer keys: `member_id`, `exact_date`, `procedure_detail`, `topic_detail`, `hospital_name`, `hospital_city`, `hospital_branch`, `policy_schedule_available`, `continuity_document_available`, `other_policy_available`, `uninterrupted_cover_reported` (volunteered only).
- Time: `plannedMonth` is a month, never a day. It is not converted. Only a real `plannedDate` (or an `exact_date` answer) is passed to Block 3 as `asOf`. Contradictory dates are refused. A direct field and an answer that disagree are refused.
- `memberId` must belong to the requested household; otherwise a 404 identical for foreign and unknown ids.

## Response: `household-coverage-preview/v1`

Members: `contractVersion`, `scenario` (echo, `provenance: user_reported`), `sourceSummary`, `policies`, `comparisons`, `contextGaps`, `nextQuestions`, `externalChecks`, `nextActions`, `assessmentState`, `completeness`, `limitations`.

Assessment state, evaluated in this order:

1. `source_revalidation_required`: any source is stale, unavailable, an old processing version, built for another member or date, or failed the handoff contract.
2. `conflicting_evidence`: Block 3 or cross-input conflicts.
3. `insufficient_evidence`: no documented (known or explicitly restrictive) term for any policy.
4. `conditional_evidence_summary`: documented terms exist but a blocking gap, an unestablished member or no scenario-relevant documented term remains.
5. `evidence_summary_available`: documented relevant terms, member established, no blocking gap.

Policy entry (`policyId` is an opaque `pol-` reference derived from Block 3's keyed policy id; no policy number, document name or household identifier): `policyType` (Block 3's kind, `unresolved` stays unresolved), `associationState` (`verified | candidate_unverified | unresolved`), `memberApplicability` (`established | not_enrolled | unresolved | member_not_specified`, with citations), `documentedTerms`, `documentedRestrictions`, `uncertainties`, `dynamicChecks` (always `not_performed`), `citations`, `limitations`, `sourceIndexes`.

- A documented entry exists only for `known`, `not_permitted`, `not_selected` or `available_not_selected` Block 3 items with citations and a verified association. Open-ended findings (`finding.*`) are never documented entries: the handoff carries no member scope or effective dates for them, so even a reviewed one is listed only as an uncertainty (`open_ended_finding_member_and_date_scope_not_established`) and never asserts its effect. It carries `provenance: reviewed_contractual_evidence`, its own policy and its conditions, exceptions and overrides.
- `unverified`, `missing`, `conflicting` and `dynamic_check` items appear only as `uncertainties` or `dynamicChecks`. They carry no value. `candidateValue` is never copied (only `candidateAvailable: true`).
- `memberApplicability` is `established` only from a known `member_enrolment: enrolled` item under a verified association. A policy-wide term remains visible but is flagged `appliesToMember: unresolved`.
- Nominal limits (sum insured, sublimit, deductible, co-pay) appear only on their own policy with their own citation. There is no combined, payable or spendable value anywhere; the output contract rejects such keys.
- Quoted contract text (`conditions`, `exceptions`, `overrides`), document-supplied topic labels (which appear in `relatedRuleKeys`, `topic` and uncertainty fields) and the echoed user text are data. They never reach question text, action text, gap reasons or decisions. The claim-wording screen in the output contract covers only the engine's own sentences.
- Merging the same policy across sources is order-independent: choices are made on a canonical ordering, sources that disagree on a waiting-period completion yield `completion_differs_across_sources`, and a completion keeps its continuity citations, start date and counting-rule caveat.

### Comparisons

`possibleOverlap` requires: two distinct policies, member named and established in both, the same rule and a non-empty topic (or an overlap-eligible rule), both known with citations, an exact date, and no known policy period excluding it. It is never confirmed coordination (`unresolvedCoordination` always accompanies two or more policies; a top-up or super-top-up adds a threshold note). `documentedRestrictions` are `scope: this_policy_only`. `evidenceGaps` are absent, unverified or unresolved evidence, not exclusions.

### Gaps, questions and actions

Gaps follow G01 to G10 (see `context-gaps.js`), plus `planned_date_outside_policy_period` when a documented policy period excludes the exact date. Each has `gapKey`, `sourceClass`, `reason`, `impact`, `priority` (P0 to P2), `currentState`, `expectedResolver` (USER, DOCUMENT, VERIFIED_SOURCE, DYNAMIC_EXTERNAL, REVIEW, NOT_PERMITTED), `blocking`, `eligibleQuestionId`, `relatedPolicyIds`, `relatedRuleKeys`. Conflicts and stale sources go to review or a document, never to the user. G10 (consent missing, expired or revoked) is enforced before the engine: the source is not read and the existing coded error is returned.

Question ranking: priority level (P0=3, P1=2, P2=1), then impact (applicability=3, major restriction or dynamic-check readiness=2, clarification=1), then effort (short answer=1, document=2), then question id. At most 2 questions per response (1 for an emergency, and never required); at most 5 distinct questions per journey, counted from the keys present in `scenario.answers` (the journey is stateless: a client that omits earlier answers resets its own budget, and nothing is stored to prevent that) (an answered, skipped or "I do not know" key retires its question; `completeness.questionBudget` reports the count). The bank is finite (10 questions, static text, no document or user text). Documents, reviews and external confirmations are separate `nextActions` (`provide_context`, `identify_existing_document`, `upload_document`, `independent_review`, `insurer_or_tpa_confirmation`, `hospital_confirmation`, `no_further_context_needed`), each with a reason and `status: pending`. Nothing reports completion.

## Provenance and trust guarantees

- Authority only narrows: known to unverified (incomplete citation, unverified association, non-plain value), a conflict can appear, nothing becomes known. Tested by property over generated handoffs and by mutation.
- Stable origin vocabulary on every entry: `reviewed_contractual_evidence`, `unverified_extraction`, `user_reported`, `dynamic_external_confirmation_required`, `unavailable`.
- User answers are `user_reported` and never alter a policy fact.
- `retrievalComplete` is always `false`.

## Endpoint access

Authenticated bearer session; household read role (`requireAccess`, a foreign or unknown household is the same 404 `HOUSEHOLD_NOT_FOUND`); every case in the requested household (`CASE_NOT_FOUND` 404 otherwise, identical for foreign and unknown) and the source-pack field consent for that case, all before any source is read; Block 3 answer access (consent expiry gives `CONSENT_REQUIRED` 403; revocation or deletion erases the answer, giving 404 `POLICY_EVIDENCE_NOT_FOUND`). A stale answer (`POLICY_EVIDENCE_ANSWER_STALE`) becomes a `revalidation_required` source, not an error.

## Known security boundaries

- Only the consent purpose and wording already used by the decision-catalogue route apply. That wording is pending legal review.
- Real known evidence reaches a preview only through Block 3 review (independent reviewer or accepted source). Staff identity and reviewer operations are separate work.
- A foreign case and an unknown case give identical bodies but slightly different latency (an extra lookup on the foreign path); this is not treated as an enumeration oracle for this local, authenticated API.
- The preview is derived on every call. Nothing is cached, so revoking consent or deleting a document removes the conclusions on the next call.

## Synthetic journeys and measurements

See `docs/exec-plans/active/block4-acceptance.md` for the matrix, test counts and the local latency baseline.

## Failure behaviour

A source that cannot be used degrades to `source_revalidation_required` with a document request. Authorisation failures are coded errors with no partial result. A bound breach is a coded 422; evidence is never silently truncated. A defect that would break the output contract throws before the response is sent (fail closed), surfacing as a generic coded error.

## Future insurer-source integration checklist (not implemented)

The separate Insurance Data API is not integrated and nothing here assumes its endpoints, schema, authentication or availability. When it exists, its data must enter through Block 3, not Block 4, and must supply at least:

1. a stable insurer, product and version identity and an effective-date range;
2. the source document identity, retrieval time and a content digest;
3. an authority statement (insurer-issued versus derived) that Block 3 can map to a contractual source type;
4. per-term applicability (plan variants, member types, policy kinds) and explicit conditions, exceptions and overrides;
5. citations to page or clause that Block 3 can verify against the stored source;
6. a verification record (who or what verified it, when, with what method), so Block 3 can decide `proven` without trusting the transport;
7. explicit supersession and withdrawal signals;
8. a way to state "not offered" separately from "not found";
9. for hospital or network data, a freshness timestamp and a statement that it is operational information (Block 3 keeps it `dynamic`).

Provenance, authority, source version, applicability and trust state must be established before a value can become a known Block 3 fact. An internal service is not trusted by being internal.
