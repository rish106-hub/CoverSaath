# ADR 0009: Decision catalogue and reviewed facts

- Status: Part 1 implemented. Part 2 **implemented 2026-10-20 on the owner's instruction ("continue with Phase 4"), pending independent read-only review and legal review**. The owner's four open decisions were settled with the defaults below; revisit them if the review disagrees.
- Date: 2026-10-20
- Scope: `src/features/decision-catalogue/`, `src/backend/services/decision-catalogue-service.js`, `GET /api/v1/cases/{caseId}/decision-catalogue`; Part 2 would add a reviewer role, a fact store and write routes.
- Related: [ADR 0003](0003-ai-authority.md), [ADR 0008](0008-evidence-first-reasoning.md), [decision-catalogue.md](../architecture/decision-catalogue.md). ADR 0007 is reserved for document-to-policy association (S6, blocked).

## Context

Block 2 answers questions with cited clauses, but every finding is `extracted_unverified`. Block 4 needs decision inputs (sum insured, room-rent cap, selected riders, waiting periods) with applicability and authority. No component can today raise a fact above `extracted_unverified`, so typed rules on the live path stay `unknown` or `unverified`. That is correct, and it is also the limit of what is useful.

## Part 1: decided and implemented

1. Standardise evidence and decision contracts, not insurer language. `factType` and `topic` are open labels. `registryKey` is optional.
2. The catalogue is derived on every read from live clauses. No table, no migration. Revocation or erasure removes the clauses, so the next build drops the facts. There is no derived store to erase.
3. Authority is a per-batch attestation by the calling channel: `origin` (`model`, `human_review`, `official_source`) and `reviewStatus`. A candidate cannot assert its own authority. Only a `human_review` batch may carry contractual source types. Model and official-source batches cannot, so neither can control a contract rule.
4. Applicability (policy, member, date, supersession, selection) is resolved before precedence. Non-contractual sources never control; they surface as discrepancies.
5. Rules use integer minor units. Missing input is `unknown`, never zero or false. Cross-policy cover is never summed (`combinedConfirmedCover` is null).
6. Official-source records are validated and labelled with freshness. They never override a contract (`mayOverrideContract: false`).

Consent purpose fit for the route is **pending legal review**.

## Part 2: proposed, not built

Goal: let an authorised person confirm a fact, so a typed rule can reach `known` on the live path.

### Proposal

1. **Role.** Add a `reviewer` household-scoped permission, separate from the household owner and from any model channel. A reviewer acts on facts of households they are explicitly granted. The grant is audited.
2. **Fact store.** One additive table `catalogue_reviewed_facts` (SQLite and PostgreSQL parity, expand-only migration): `id`, `household_id`, `case_id`, `policy_id`, `fact_type`, `topic`, `value_json`, `unit`, `subject_json`, `selection`, `conditions_json`, `exceptions_json`, `effective_from`, `effective_to`, `clause_ids_json`, `document_id`, `source_version`, `reviewer_id`, `review_status`, `created_at`, `superseded_by`. Quotes are not copied; clause ids link to `policy_clauses`.
3. **Read path.** The catalogue service loads reviewed facts for the case and passes them as a `human_review` batch. Facts whose cited clauses are no longer live are dropped at read time (same liveness check as today).
4. **Erasure.** Consent revocation and document erasure delete reviewed facts that cite the erased document. Each derived store gets an erasure test (AGENTS.md invariant). Reviewer identity and audit events survive as non-content records.
5. **Write route.** `POST .../reviewed-facts` with Idempotency-Key, server-side validation through `ingestFacts` (so the same authority rules apply), household ownership check, audit event in the same transaction. The reviewer cannot set `proven` for a clause that is not live and household-scoped.
6. **Findings mapping.** A separate, later step: a deterministic mapper that proposes typed values from Block 2 findings for the reviewer to accept. It never auto-accepts.

### Alternatives considered

- Reuse `evidence_facts`: rejected. It allows only known/unknown/conflict, requires a `source_pages` row, and cannot hold conditions or selection.
- Let the model raise facts: rejected by ADR 0003.
- Keep deriving only: leaves Block 4 with `unknown` for every typed rule on real data.

### Decisions the owner must make

1. Who is a reviewer in the MVP: the policyholder confirming their own policy, a CoverSaath staff member, or both? Self-confirmation is not independent review; label it `reported`, not `proven`.
2. Is `proven` reachable at all in the MVP? If only staff can reach it, a staff access model and audit policy are needed first.
3. Legal review of the confirmation wording and the consent purpose.
4. Approval of the additive migration (014-series number to be taken at implementation time).

### Consequences

- Hard to reverse once data exists: a new derived store, a new role, a new consent-adjacent purpose.
- Needs an independent read-only review of authority, tenant isolation and erasure before merge.
- Until accepted and built, typed rules stay `unknown` or `unverified` on the live path. A reviewer batch passed in-process already reaches `known` (tested), but no product path supplies one.

## Part 2: as implemented (SQLite 017, PostgreSQL 013, expand-only)

Differences from the proposal, with reasons:

1. **No `reviewer` household role.** Widening `household_roles.role` needs the CHECK rebuild that U2 blocks. A new table `catalogue_reviewer_grants` carries the authority instead. Two kinds:
   - `household_confirmer`: the owner designates a household adult (`POST /api/v1/households/{id}/catalogue-reviewers`). This is self confirmation (owner decision 1): the result is `reported` and never `proven`, and the source stays `user_statement`, so it can never control a contract rule.
   - `independent_reviewer`: granted by operator tooling only (`CatalogueReviewRepository.grantIndependentReviewer`). There is deliberately **no route** for it, so no request can mint it. Owner decision 2: `proven` is reachable only this way. No staff access model exists yet; until one does, nobody holds this grant in production.
2. **`catalogue_reviews` is immutable and stores no quote.** One row per decision (`accepted`, `rejected`, `disputed`) with a fixed `reason_code` list (no free text, so no personal data in reasons), clause ids and the clause digests seen at review time, and the typed fact. A later review of the same fact supersedes an earlier one at read time; nothing is updated.
3. **The server rebuilds the fact.** `POST /api/v1/cases/{caseId}/decision-catalogue/reviews` takes `answerId`, `factId`, `decision`, `reasonCode`, optional `attestedSourceType` and `attestsPolicyAssociation`, plus `Idempotency-Key`. The value, clauses and digests come from the live catalogue after the consent and currency re-check. Authority comes from the stored grant; `authority`, `reviewStatus` and similar body fields are ignored.
4. **What an independent acceptance can do.** It yields `proven`. The fact reaches `known` in a rule only if the reviewer also attests a contractual `attestedSourceType` (the uploader's label is never trusted) and `attestsPolicyAssociation: true` (a reviewer attestation for that answer's policy, which is the interim form of ADR 0007). Without either, the value stays `unverified` or `unknown`.
5. **Currency.** A review counts only while every cited clause is live with the same document, version and digest. A replaced or erased clause makes the review `stale` and it stops supporting anything. Rejected proposals leave the rule pool; disputed ones stay and force `reviewRequired` plus a `review_disputed/...` conflict. Original model facts stay visible.
6. **Erasure.** `ClauseRepository.eraseDerived` (consent revocation and document erasure) and a document-lifecycle trigger delete reviews. Reviewer grants and audit events survive as non-content records. Audit payloads hold decision, reason code and authority only.
7. **Independent reviewer read access (disabled by default).** With the flag on, an active independent grant lets that adult read the catalogue of that household's cases without a household role. This skips the household source-pack field check; the answer's own consent re-check still applies. Revisit with the staff access model.

Independent review of the first Phase 4 commit (read-only, static): 0 P0, 5 P1, 8 P2. Fixed with tests: reviews of a revoked grant stop counting (`reviewer_revoked`); a household confirmation can no longer supersede an independent review; independent reads and writes require an active household; a household confirmer's write now passes the same source-pack field gate as the read; the independent path is **off unless `CATALOGUE_INDEPENDENT_REVIEW_ENABLED=true`** because it reads without the subject's source-pack consent (no consent purpose or staff access model exists, and legal review is pending, so do not enable it in production); `asOf` and `attestedSourceType` are validated; an adult with any household role cannot be granted as independent; grants and reviews write their audit event in the same transaction, with correct actor types; oversize facts return 400. The new triggers are now in `criticalTriggers` with PostgreSQL behaviour tests; migration 013 ran against a local PostgreSQL 17 with catalog parity, runner and trigger tests passing. Left open: on PostgreSQL two concurrent identical POSTs could return 500 instead of a replay (the SQLite runtime serialises them).

Rollback: stop calling the routes; the tables are additive and can stay empty. Dropping them needs a new migration; there is no down path.

PostgreSQL 013 was run against PostgreSQL 17 (parity, runner and trigger tests pass). The runtime is still SQLite.

## Addendum 2026-10-21: bounded reviewer grants and verified curated products

- Independent grants now carry `expires_at` (at most 30 days) and `case_id`; both are enforced in the repository on every call, and an independent grant without them is inactive. Triggers still check only status; expiry and case are repository-level (a gap to close with a trigger).
- Curated insurer wording has its own checked-and-published workflow (migration 018 / PostgreSQL 014). It informs and never overrides a household contract; `verified` exists only for published rows and never comes from a record's own fields. Details in `docs/iterations/LATEST.md`.
- Pending independent read-only review and legal review of the reviewer purpose.

## Addendum 2026-10-21 (b): synthetic acceptance fixes

- Logical policy ids are now HMAC-SHA-256 of the printed number under a server key (from `DOCUMENT_ENCRYPTION_KEY_BASE64`, random per process when unset), prefix `pol-`, 32 hex characters. The unkeyed digest let anyone holding an id confirm a guessed policy number. Consequence: ids change once on upgrade and with any key change; reviews recorded against old ids read as `stale` (fail closed). Deployments must keep the key stable.
- An independent grant covers only documents uploaded at or before its `granted_at`. A later upload needs an operator regrant, which also starts a new review window.
- Applicability: an undated query cannot be answered from a lower layer when a dated contract fact could control (`as_of_required`); the newest version of a document family is judged across all of the policy's facts; enrolment always needs a member-scoped fact and a named member's continuity must be their own (`member_scope_missing`).
- Curated products: every read re-checks the archived bytes and quotes of each published product.
- Evidence: [block-3-acceptance.md](../exec-plans/active/block-3-acceptance.md).

## Unverified

No real policy has been run through the catalogue. A green test suite is not evidence of real-world insurance correctness. The month-counting rule for waiting periods is an unverified assumption stated in each result.
