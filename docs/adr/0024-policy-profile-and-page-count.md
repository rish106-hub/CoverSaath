# ADR 0024: Policy profile and document page count (policy facts, slice 1)

- Status: Proposed (build complete, not independently reviewed). Synthetic data only. Wording about consent, privacy and confirmation below is an engineering reading and is **FOR LEGAL REVIEW**.
- Numbering: 0023 is the highest existing ADR on `main` and the remote branches; 0007 is skipped (see `AI.md`).
- Related: ADR 0003 (AI authority), 0008 (evidence-first), 0009 (reviewed facts; household confirmation is `reported`, never `proven`), 0013 + addendum D2 (column encryption), 0014 (limits), `src/backend/AGENTS.md`, `src/backend/database/AGENTS.md`.
- Scope: migrations `042_document_page_count.sql` and `043_policy_profiles.sql`, `GET` and `POST /api/v1/documents/{id}/policy-profile[/confirm]`. Slice 2 (`policy_facts`, `fact_evidence`, migration 044) is separate and not started.

## Context

After an upload and scan the app wants to show the owner what the document is: how many pages, which product (UIN), which insurer and the policy name, and to let the owner confirm them. Document bytes are already stored encrypted (`document_blobs`, migration 020). Nothing recorded a page count, and nothing recorded a confirmed policy identity.

## Decisions

**D1. Page count, expand-only (042).** `document_uploads.page_count` (1..5000) and `page_count_source` (`source_pages` < `ocr` < `image_single` in trust). One conditional UPDATE (`setPageCountOnce`) writes a count only when none exists or the new source is more trusted, so the scan and OCR writers cannot race to a worse value. The scan path sets 1 for an image and never reads bytes (`markScanClean` still has none). A PDF count comes from OCR completion (`OcrRepository.completeJob`, the provider page count) and from the stored page rows after a blocks upgrade. The inspector's object count is never used (it over-counts). A count is a number, not personal data: no erasure path.

**D2. Policy profile (043).** One row per (document, source version). Plaintext: `uin` (public product id, `^[A-Z0-9]{8,24}$`), `insurer_code` (public insurer code, the three letters that open a UIN). Sealed (`enc2`, AAD `policy_profiles.<column>.<row id>`): `insurer_name_enc`, `policy_name_enc`. Row level security on, no policy, no grant to `anon`, `authenticated` or `PUBLIC`.

**D3. No pre-confirm persistence of names.** The policy name and the insurer name proposed from a document or the curated catalogue are returned in the `GET` response only. A CHECK allows either sealed column only in the state `reported`, which needs `confirmed_at`, `confirmed_by_adult_id` and `confirmation_source = 'user_statement'`. There is no `policy_name_proposed` column.

**D4. `reported`, not `user_confirmed`.** The owner's confirmation is a household statement: state `reported`, source `user_statement` (ADR 0009). It is never `proven`, and no `user_confirmed` or `user_entered` state is added (ADR 0003 and `ai-authority.js` forbid a model from writing `reported`; only the confirm path does). Other states: `unknown`, `extracted_unverified`, `conflicting`. No model or provider call exists in this slice; proposals are deterministic (`extractUins` over the consent-gated stored OCR text, plus a curated-product lookup that is empty today).

**D5. Plaintext UIN rationale.** A UIN and an insurer code are printed product identifiers shared by every policyholder of a product; they identify the product, not the person. Storing them plaintext allows the proposal to be stored as `extracted_unverified` and supports later product-level analytics without a decryption key. A policy name can combine with other fields to point at a person's specific cover, so names stay sealed and confirmed-only. A UIN printed twice with different values is stored as `conflicting` with no value; confirming then needs an explicit choice (409 `POLICY_PROFILE_CONFLICTING_FACTS` otherwise).

**D6. Confirm flow.** `POST .../confirm` with `{ uin?, insurerCode?, insurerName?, policyName?, expectedVersion }` and a required `Idempotency-Key`. One transaction under the household lock: the document is still active and its `document_processing` consent is still current (re-checked in the transaction), the key was not used for another statement, `expectedVersion` equals the stored version (0 when no row; 409 otherwise), no conflict is left unaddressed, then the row is written and a counts-and-field-names audit event is appended. The idempotency record keeps only the new version number (sealed), so no value is cached. Owner adult only; a missing document, another household's document and a non-owner member answer the same 404 `POLICY_PROFILE_NOT_FOUND`. Off unless `POLICY_FACTS_ENABLED` is exactly `true`.

**D7. Erasure.** The database deletes a document's profile when the document enters `deletion_requested` or `deleted` (trigger, migration 012 pattern). Application paths delete by case, by household (and so by member, which erases its cases) and, with the withdrawn documents, in `ConsentRepository.eraseDerivedRunData`. The store is listed in `data-lifecycle.js`, `data-purposes.js`, `data-purpose-registry.js` and `schema-expectations.js`. Key rotation: `column-backfill.js` re-seals both columns (`--unseal` skips the table because its CHECK refuses plaintext).

## Consequences and open points

- A profile stays after the OCR (`sarvam`) reading grant is withdrawn if the `document_processing` collection grant is still current; only the proposals stop (they re-check the reading grant on every read). Whether withdrawing the reading grant alone must also erase a confirmed profile is an owner and legal decision (FOR LEGAL REVIEW).
- `insurer_code` is the first three letters of the UIN, an unverified reading until the owner confirms it.
- No TRUNCATE guard (mutable-table neighbours have none; runtime roles cannot TRUNCATE).
- Rollback: expand-only. Turn the flag off and revert the code; a synthetic-only database may drop `policy_profiles` and the two columns. An applied migration is never edited; fix forward with the next number.
