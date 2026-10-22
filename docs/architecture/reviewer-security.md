# Reviewer and curator security (Block 3)

Two separate authority systems. Household reviewers judge facts derived from one household's documents. Source curators and checkers judge public insurer wording. Neither grants the other, and neither is a household role. Code: `src/backend/repositories/catalogue-review-repository.js`, `src/backend/repositories/curated-product-repository.js`, `src/backend/services/decision-catalogue-service.js`, routes in `src/server/routes/v1-backend-routes.js`. Migrations SQLite 017/018, PostgreSQL 013/014. Not legal review.

## Authentication assumptions

- Every route identifies the caller by the bearer session (`principal.adultId`). No body field names a reviewer, checker or authority; such fields are ignored.
- Sessions are self-issued bearer tokens after a bootstrap token. There is no identity provider, no MFA and no staff directory (`security.md`, Known gaps). So "authenticated" here means "holds a session for that adult id", not "is a verified person".
- Operator tooling (`scripts/curated-source.mjs`, `CatalogueReviewRepository.grantIndependentReviewer`) runs with database access. Its `operatorId` argument is a label written to the audit trail, **not** authentication. Whoever can run it can grant roles. This is the main production identity gap.
- Curated check and publish have no route. They need an Ed25519 signature by the key registered on the checker's live grant ([ADR 0010](../adr/0010-signed-curated-actions-and-derived-text.md)); a checker id typed by the operator is never sufficient. The operator can still register a key they hold, so signing narrows but does not close the gap above.

## Role and permission matrix

| Actor | Granted by | Scope | Lifetime | May | May not |
|---|---|---|---|---|---|
| Household owner | household creation | own household | role lifetime | read own catalogue (with source-pack consent), designate a household confirmer | review without a confirmer grant |
| Household confirmer | owner, `POST /households/{id}/catalogue-reviewers` | own household | until revoked or household role ends | accept/reject/dispute a fact; result `reported` | reach `proven`; attest a contractual source |
| Independent reviewer | operator tooling only | one case of one household; documents uploaded at or before `granted_at` | at most 30 days | read that case's catalogue (only when `CATALOGUE_INDEPENDENT_REVIEW_ENABLED=true`), review with `independent` authority | hold any role in that household; see documents uploaded after the grant; self-grant |
| Source curator | operator CLI `grant-role` | all curated submissions | at most 90 days | register, propose facts, revalidate own submission | check or publish |
| Source checker | operator CLI `grant-role` with the checker's public key | all curated submissions | at most 90 days | read, sign check (accept/reject) and publish actions applied by the CLI, revalidate unchanged bytes | check or publish a submission they collected; act without their private key |
| Operator | database access | everything | n/a | grant/revoke roles, invalidate a published product | self-grant (refused by id comparison only) |

## Resource-scoped authorisation

- Every catalogue read and review write re-reads the grant and the case. An independent grant answers only for its `case_id`; the household must be active.
- An independent grant covers the documents its case held when it was issued: an answer that reads a document uploaded after `granted_at` is not found (404) until an operator regrants. A regrant resets the window and does not revive reviews made under an earlier window.
- Foreign households, unknown answers and missing grants all return 404, never 403, so case existence is not disclosed.
- Household confirmer writes pass the same source-pack field gate as the read route.
- Curated submission reads need a live curator or checker role and never return archived bytes or the content digest (the checker must hash their own copy).

## Separation of duties

- Curated sources: the checker must differ from the collector (database CHECK plus service check, in the write transaction). One person holding both roles is still refused on their own submission. Publication needs a live checker grant and re-runs every machine check against the archive.
- Household facts: a household confirmation can never supersede an independent review; only an independent review can reach `proven`.
- No route can mint an independent reviewer or a source role, and no route can check or publish a curated product.
- Curated machine checks compare against page text derived from the archived PDF bytes, never curator-supplied text.

## Review state transitions

- Household facts: each review is an immutable row (`accepted`, `rejected`, `disputed`) with a fixed reason code. The latest live review of the strongest authority wins at read time. Read-time states: `accepted`, `rejected`, `disputed`, `superseded`, `stale` (cited clause changed or erased), `reviewer_revoked` (grant revoked or expired).
- Curated products: `collected -> candidate -> checked -> published`, plus `rejected`, `needs_revalidation`, `superseded`. Allowed transitions are enforced by a trigger; content columns are immutable once written; rows and archives are never deleted. See [the runbook](../runbooks/curated-sources.md).

## Expiry and revocation

- Household reviews: an expired or revoked grant makes that reviewer's reviews count for nothing on the next read (by design: authority over a household's data ends with the grant).
- Curated products: grant expiry or revocation stops new actions only. A product published by a checker whose grant later ended stays published, because publication is a recorded act. To withdraw it, an operator runs `invalidate` (checker compromised, review found wrong, source superseded), which moves it to `needs_revalidation`.
- A role revoked between request and commit is seen inside the write transaction. A signed action is verified inside that transaction too, so revocation, expiry or a regrant with a new key between signing and applying refuses it.

## Consent dependency

- The catalogue is built from a stored answer whose question grant is re-checked on every read; revocation erases clauses and reviews, and the catalogue returns 404.
- The independent reviewer path skips the household source-pack field check (no consent purpose for staff review exists). It is off by default and must stay off in production until a consent purpose and staff access model are approved.

## Audit requirements

- An independent reviewer's `catalogue_reviewer.viewed` event is written before the read is served, so a read later refused (for example a document newer than the grant) is still recorded as an attempt.
- Grants, regrants, revocations, every review, every curated transition, digest-mismatch attempts (written after rollback) and every independent reviewer read (`catalogue_reviewer.viewed`, written before serving; a failed audit write fails the read) are audited.
- Audit payloads hold ids, decisions, reason codes, authority, digests and public UINs. They never hold clause text, quotes, fact values, member data or document bytes (asserted in `tests/catalogue-review-api.test.mjs` and `tests/curated-product-workflow.test.mjs`).
- Audit rows cannot be updated or deleted (triggers). The hash chain is not verified by any job.

## Archive classification

`curated_source_archives` holds public insurer wording only, collected by a curator from an allowlisted insurer host. It is not household data and is not encrypted at rest beyond the database file. Household documents live in encrypted document storage and have no path into this table: registration is CLI-only from a local file. The residual risk is an operator registering a household's file by mistake; it is procedural (download only from the insurer host), not enforced in code. Encrypting the archive is not needed for public wording; revisit if any non-public source is ever accepted.

## Known production identity gaps

1. No trusted operator model: operator ids are labels. Curated approvals are signed by the checker's key, but the operator registers that key.
2. No staff directory or MFA for independent reviewers, curators or checkers; nobody holds these roles.
3. No consent purpose or legal review for independent review.
4. Grant expiry for independent reviewers is repository-enforced; the database trigger checks only that an expiry and case exist.
5. PostgreSQL concurrent identical review POSTs may return 500 instead of a replay (SQLite serialises them).
6. Reviews stored before the keyed policy ids keep the old unkeyed ids inside immutable `fact_json`; only synthetic data exists today, but a re-key or erasure path is needed before real data if that changes.
