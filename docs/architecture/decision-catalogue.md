# Decision catalogue (Block 3)

Status: implemented on synthetic data; not accepted on real insurer policies. Code: `src/features/decision-catalogue/` (pure), `src/backend/services/decision-catalogue-service.js`, `src/backend/repositories/catalogue-review-repository.js`, `src/backend/repositories/curated-product-repository.js`. Contracts `decision-catalogue/v1` and `decision-handoff/v1`. Decisions: [ADR 0009](../adr/0009-reviewed-facts-and-decision-catalogue.md). Reviewer and curator authority: [reviewer-security.md](reviewer-security.md). Acceptance status: [block-3-acceptance.md](../exec-plans/active/block-3-acceptance.md). Not legal review.

## Decision

Standardise the evidence and decision contracts, not insurer language. `factType` and `topic` are open labels; `registryKey` is optional. A clause with no registry key still becomes a fact with its conditions, exceptions and overrides. Deterministic code owns every status; a model only proposes.

## Data flow

Stored policy answer (ADR 0008) -> `answerToCandidates` (open-ended `finding.*` facts, model origin, `user_statement` source type) + `typedTwins` (typed twin when one cited line states one unambiguous value) -> `associateDocuments` (candidate policy per document) -> `ingestFacts` per batch (model batch, plus one batch per current review) -> `resolveApplicable` (policy, member, date, supersession, contractual layer, selection) -> `evaluateRules` -> `separatePolicies` -> `buildDecisionCatalogue` -> optional `toHandoff`.

Derived on every read from live clauses. Revoking consent or erasing a document removes its clauses, so the next build drops its facts; reviews are erased with the clauses (`ClauseRepository.eraseDerived`, document trigger). No catalogue snapshot is stored.

## Fact states and authority

| Origin (batch attestation, never the candidate's claim) | Review | State | Can make a rule `known` |
|---|---|---|---|
| `model` | any | `extracted_unverified` | never |
| `human_review`, household confirmer | `self_confirmed` | `reported` | never (source stays `user_statement`) |
| `human_review`, independent reviewer | `accepted` | `proven` | only with an attested contractual source type and an attested policy association |
| `official_source` | accepted / not | `proven` / `dynamic` | not used on the live path (`CURATED_OFFICIAL_SOURCES` is empty) |
| `deterministic` | n/a | `calculated` | produced by rules, never ingested |

A candidate whose `claimedState` disagrees with the derived state, or a model/official batch carrying a contractual source type, is rejected with `FACT_AUTHORITY_EXCEEDED`. Contractual sources rank `endorsement` 700 > `issued_schedule` 600 > `policy_wording` 500 > `certificate_of_insurance` 450 > `group_benefit_booklet` 400. `customer_information_sheet`, `authorised_institution_reply`, `user_statement` and `marketing_material` are advisory only. The uploader's document kind is kept as `declaredSourceType` and never used as authority.

## Policy association

- A document is a candidate member of a logical policy only when its own clauses print exactly one policy number (`association.js`). Several numbers: `ambiguous`. None: `unestablished`. Neither is a negative coverage finding; both read as unknown.
- The logical policy id is `pol-` + HMAC-SHA-256 of the normalised number under a server key (derived from `DOCUMENT_ENCRYPTION_KEY_BASE64`; random per process when unset). A client cannot confirm a guessed number by hashing the id. The number itself is never returned. Residual: clause `sourceDigests` in facts and handoff citations are plain SHA-256 of clause text (Block 2 `clauses.js`); a very short clause holding little more than a policy number could be confirmed by guessing. Keying outward clause digests is an open follow-up. Changing the key changes every policy id and makes reviews recorded against the old ids `stale`.
- Association is never verified by this path. It becomes verified for one fact only when an independent reviewer attests `attestsPolicyAssociation: true` for that fact's policy.
- Not built: endorsement or version relationships beyond a shared printed number, member enrolment evidence, a stored association review (ADR 0007 still blocked).

## Applicability and conflicts

Facts are excluded, with a reason, for `unassociated_policy`, `other_policy`, `other_member`, `member_scope_missing` (an enrolment or continuity fact not tied to one member), `as_of_required` (dated fact, no `asOf`), `not_in_effect`, `superseded`, `older_version`. The newest version of a document family is judged across all of the policy's facts that apply to the member and date, so a term the newer version no longer states is not answered from the older one, and a newer version not yet in effect does not displace the current one. Among the remaining contractual facts the highest-ranked layer controls. When no `asOf` is given and a dated contract fact of the same or a higher layer was set aside for that reason, the result is `unknown/as_of_required` (conservative: this also applies when that dated fact would later have been superseded). Two controlling facts with different values give `conflict` (`controlling_sources_disagree`) with both sides listed. Advisory facts are listed as `discrepancies` and never control.

## Rule statuses

Rules: `sum_insured`, `room_rent_limit`, `icu_limit`, `copay`, `deductible`, `sublimit`, `waiting_period`, `exclusion`, `add_on`, `restoration`, `bonus`, `policy_identity`, `member_enrolment`, `network_status` (dynamic), `claim_documents`, `renewal_portability`, `continuous_cover`, `policy_period`.

| Status | Meaning | Value |
|---|---|---|
| `known` | verified (`proven`/`calculated`), applicable, controlling, association verified, well-formed | `value` |
| `unverified` | a candidate exists but is not verified or its association is not (`value_not_verified`, `policy_association_unverified`, `value_malformed`) | `candidateValue` only |
| `dynamic` | needs current confirmation from insurer, TPA or hospital (`needs_current_confirmation`) | `candidateValue` only |
| `conflict` | controlling sources disagree | none; `conflicting` lists both |
| `unknown` | `no_applicable_evidence`, `only_non_contractual_sources`, `as_of_required`, `fact_unknown`, waiting-period reasons below | none |
| `not_selected` / `available_not_selected` | the schedule says not opted / offered but not selected | none |
| `not_permitted` | explicitly not permitted by a non-model source | none |

Unknown, conflict and not-permitted never collapse into each other or into zero or false. Zero or negative caps, zero percentages, basis points above 10000, impossible dates and non-boolean flags are `value_malformed`. Waiting-period completion needs a verified, member-scoped `continuous_cover` fact for the queried member (so completion is only ever answered for a named member), a known waiting period and an `asOf`; otherwise `continuity_not_evidenced`, `cover_interrupted`, `as_of_date_missing` or `waiting_period_not_established`. Month counting is an unverified assumption stated in each result. `conditional: true` marks a value with conditions, exceptions or overrides. Limits are never added: `combinedConfirmedCover` is always `null`, and a top-up layer carries a coordination note.

## Citations and digests

Every fact cites clause ids. Document, version, page and the SHA-256 digest of each cited clause come from the evidence index (live `policy_clauses` rows of the same household), never from the candidate. A review stays current only while every cited clause is live with the same document, version and digest; otherwise it is `stale` and supports nothing.

## Curated insurer products (informing only)

Published curated products (see [the runbook](../runbooks/curated-sources.md)) can be compared with a household's facts for a document that prints exactly one UIN (`compareToCurated`, output `curatedComparison`). A comparison is information: it never changes a fact, a rule status or an association. Every catalogue read re-hashes the archived bytes of each published product and, when page text was supplied, re-runs the UIN, version and quote checks; a product that fails is left out (reads as `no_curated_record`). A product published without page text gets only the byte checks; its quotes rest on the checker's attestation. Cost: one SHA-256 per published archive (up to 20 MB) per catalogue request, synchronous; acceptable while the catalogue is empty or small, to be cached or moved to a periodic check before it grows. `CURATED_PRODUCT_RECORDS` and the database workflow are empty in the shipped catalogue.

## Catalogue to handoff mapping (`decision-handoff/v1`)

| Catalogue status | Handoff state | `value` | `candidateValue` |
|---|---|---|---|
| `known` | `known` | set | null |
| `unverified` | `unverified` | null | set |
| `conflict` | `conflicting` | null | null (sides in `conflicting`) |
| `unknown` | `missing` | null | null |
| `not_permitted` | `not_permitted` | null | null |
| `not_selected` | `not_selected` | null | null |
| `available_not_selected` | `available_not_selected` | null | null |
| `dynamic` | `dynamic_check` | null | set |
| anything else | `missing` | null | null |

The handoff also carries per-policy association status (`verified`, document statuses), open-ended findings with citations, conflicts, unassociated facts, reviews, dynamic checks, coordination notes, `combinedConfirmedCover: null`, `spendableCash: false`, completeness counts (`retrievalComplete: false` always) and limitations. No recommendation, eligibility, claim approval or payable amount is produced.

## Versioning and consumers

- `toHandoff` refuses any catalogue version other than `decision-catalogue/v1`.
- `assertHandoffContract` refuses a handoff or catalogue version it does not know, missing `policies` or `items`, summed cover, spendable limits, unknown states, a `known` item without a value, citations or a boolean-true association, and any `candidateValue` outside `unverified`/`dynamic_check`. A consumer must call it and fail closed on a throw.
- A breaking change gets a new version string; v1 consumers must not read v2.
- Consumer limits: `candidateValue` is never a number to calculate with; `missing` is not "not covered"; `dynamic_check` needs a current confirmation; a curated comparison is not a contract term.

## API

`GET /api/v1/cases/{caseId}/decision-catalogue?answerId=&asOf=&memberId=[&format=handoff]`. Read only, no model call. Same consent re-check, currency check and 404 rules as `/questions`, gated by the source-pack field (consent purpose pending legal review). Reviews: `POST .../decision-catalogue/reviews` (see [reviewer-security.md](reviewer-security.md)).

## CodeQL baseline (2026-10-20, `main`)

11 open alerts, all pre-existing and outside Block 3 (scripts, migrate runner, test support). The CodeQL workflow itself fails until the repository's default setup is disabled; that is a repository setting and is not changed here.
