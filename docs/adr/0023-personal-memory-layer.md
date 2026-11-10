# ADR 0023: Personal memory layer (household facts correlated from own PDF, insurer wording and declarations)

- Status: Proposed (2026-11-10). Design only: no migration, route or code exists. Not independently reviewed. Owner decisions pending (see Open decisions).
- Synthetic data only. Consent, notice, retention and health-declaration wording below is an engineering reading and is **FOR LEGAL REVIEW**.
- Related: ADR 0006 (structuring), 0008 (evidence-first), 0013 + addendum D2 (column encryption), 0015 (user-data store), 0021 (IDA import-only cache), `docs/architecture/data-lifecycle.md`. Plan: `docs/exec-plans/active/memory-layer-plan.md`.

## Context

Chat, plan and emergency need one household-scoped answer per fact ("sum insured", "PED waiting period", "who is covered") with its source and status. Today the pieces exist but are not joined:

| Store | What it holds | Scope | Fit as memory |
| --- | --- | --- | --- |
| `coverage_parameter_records` / `_observations` / `_resolutions` | Registry facts (`a.`..`k.` keys) from structuring, sealed value, `source_id` page, `resolution_state` incl. `extracted_unverified`, `conflicting` | one workflow run (case) | **Own-PDF tier source.** Run-scoped, no tier, no user or reference states. |
| `proposed_parameters` | Non-registry keys proposed by structuring, sealed value, page + block | one structuring run | Own-PDF tier source (proposals only). |
| `policy_clauses` + `source_pages` | Sealed clause text and page text | document | Evidence spans (citations), not facts. |
| `evidence_facts` + `fact_conflicts` | Generic fact ledger, sealed value, supersession | household | No production writer. Append-only redact-only: a redacted health declaration keeps its `fact_key` forever (residue). States `known/unknown/conflict` do not carry tier or user confirmation. Not reused. |
| `profile_answers` | Seven closed user-stated fields | case | Pattern reused (sealed, user-stated, delete on erasure); vocabulary too small. |
| `reference_cache` | Public IDA responses, no household link | global | IDA tier source. Must never get a household column (033). |

## Decisions

**D1. One new table, sources reused.** Migration `041_household_memory.sql` (expand-only) adds `household_memory_facts`. Own-PDF values are read from the structuring stores above and copied (sealed) into memory rows that point back to their evidence; IDA values are read from `reference_cache` through the ReferenceDataPort. No change to existing tables. `evidence_facts` stays as is (no new writer).

**D2. Row model.** One row = one value of one fact from one tier for one slot.
- Slot: `household_id`, `policy_id` (nullable, FK `policies`), `subject_member_id` (nullable, FK `household_members`), `member_scope` (`policy` | `policyholder` | `dependent` | `household`), `fact_key` + `key_schema` (`policy-parameters/v1` registry or `declarations/v1` taxonomy, validated in the app), `fact_class` (`personal_value` | `product_term` | `household_declaration`, derived from the key by a versioned map).
- Tier and status: `source_tier` (`own_pdf` | `ida_wording` | `user_declaration`), `status`. Machine tiers store only machine states: `own_pdf` in (`extracted_unverified`, `conflicting`, `unknown`); `ida_wording` in (`reviewed_reference`, `conflicting`, `unknown`). `user_declaration` stores only `user_confirmed`. CHECKs enforce the pairing. Machines never write the user tier; users never write machine tiers.
- Value: `value_ciphertext` (`enc2.`, AAD `household_memory_facts.value_ciphertext.<id>`), NULL iff `unknown`. A `conflicting` machine row holds its bounded alternatives (each with provenance) in the same sealed JSON.
- Provenance: `consent_grant_id` (FK, NOT NULL: the grant under which it was written), `source_document_id`, `source_page_id`, `block_index`, `parameter_record_id`, `proposed_parameter_id`, `policy_clause_id` (FKs `ON DELETE CASCADE`), `reference_ref_ciphertext` (sealed `{cacheKey, factId, snapshot/version, evidence sha256s}`; sealed because it links a household to a product), `declared_by_adult_id`, `capture_method` (`typed` | `voice_transcript` | `box_confirm` | `conflict_resolution`), `resolves_fact_ids` (ids only), `derivation_version`. CHECKs: `own_pdf` needs a document and page; `ida_wording` needs `reference_ref_ciphertext` and a document (the upload whose identification led to the product); `user_declaration` needs `declared_by_adult_id`.
- Versioning: append-only with supersession. `supersedes_id` (FK self), `superseded_at`. The only UPDATE allowed stamps `superseded_at` once; everything else is immutable (trigger). DELETE is allowed (erasure only, by repository). TRUNCATE blocked. Timestamps `created_at`, `superseded_at` as `timestamptz`.
- Indexes: partial unique current slot `(household_id, coalesce(policy_id,''), coalesce(subject_member_id,''), fact_key, source_tier) WHERE superseded_at IS NULL`; read `(household_id, policy_id, fact_class) WHERE superseded_at IS NULL`; erasure `(source_document_id)`, `(consent_grant_id)`, `(subject_member_id)`, `(supersedes_id)`.
- Scope trigger on insert: policy, member, document, page and adult belong to the row's household; the document is `active`. RLS on, API roles revoked (016 pattern).

**D3. Deterministic join (read-time resolver, nothing model-made).** For each slot the resolver takes the current row of each tier and applies:

| Fact class | Own PDF | IDA wording | Declaration | Result |
| --- | --- | --- | --- | --- |
| `personal_value` (sum insured, period, insured list, deductible, riders opted) | primary | ignored (write refused) | fills a gap only | PDF only: `extracted_unverified`. Declaration only: `user_confirmed`. Equal: `user_confirmed` citing both. Differ: `conflicting`, ask user. |
| `product_term` (waiting periods, exclusions, sub-limits, co-pay, room rent, claim steps) | corroborates | primary | refused (`MEMORY_KEY_NOT_DECLARABLE`) | IDA only: `reviewed_reference`. PDF only: `extracted_unverified`. Equal: `reviewed_reference` citing both. Differ: `conflicting`, shown with both quotes; not user-resolvable (endorsement or wording-version gap); answer says "check with insurer". |
| `household_declaration` (dependents, relationship, PED, prior claims, nominee, other cover) | candidate | ignored | primary | Declaration only: `user_confirmed`. PDF only: `extracted_unverified` (shown as a box to confirm). Equal: `user_confirmed`. Differ: `conflicting`, ask user. |

Rules: `unknown` never conflicts with a value; any in-tier `conflicting` makes the slot `conflicting`; equality uses a typed normaliser (money in minor units, durations in days, ISO dates, exact enums, case-folded trimmed text). A user resolution is a new `user_declaration` row (`capture_method = conflict_resolution`, `resolves_fact_ids`); a later machine row with a different value makes the slot `conflicting` again. Nothing is overwritten silently. Memory is context: no consent, eligibility, money or release rule reads it in this ADR; any future rule input needs its own ADR and maps `user_confirmed` to the registry state `reported`, never `proven`.

**D4. Consent.** Building own-PDF and IDA rows reuses the document's `coverage_reconstruction` grant (`derive`), re-checked in the write transaction (as `commitStructuring`). Declarations need a `profile_intake` grant with data category `household_memory_declaration` (and `voice_intake` for voice capture). Recommended over a new purpose because a new purpose alters the `consent_grants.purpose` CHECK; owner decides (O1). Wording FOR LEGAL REVIEW.

**D5. Erasure.** Rows are deleted, never redacted (no key residue). Paths: (a) consent revocation deletes `WHERE consent_grant_id = <revoked>`; (b) trigger on `document_uploads` entering `deletion_requested`/`deleted` deletes rows with that `source_document_id` (safety net, same as 007); (c) member erasure by `subject_member_id`; (d) household erasure all rows; (e) user deletes a declaration (whole chain); (f) retention sweep purges superseded rows after 30 days (placeholder, FOR LEGAL REVIEW). Audit events `memory.built`, `memory.declaration_confirmed`, `memory.conflict_resolved`, `memory.erased`: ids, reason codes and counts only, never keys of declarations, values or categories. No crypto-erase: one key ring (ADR 0013), backups keep ciphertext until backup expiry (FOR LEGAL REVIEW); per-household keys wait for ADR 0020.

**D6. API.** Read: `GET /api/v1/households/{id}/memory` (filters `policyId`, `memberId`, `keys` max 50, cursor, limit 100) returns resolved slots `{factKey, factClass, memberScope, status, value|null, sourceTier, sources[], alternatives?, revision}`; internal `MemoryReadPort.lookup` gives chat and plan the same. Chat order: memory, then IDA wording (port), then parsed PDF clauses; every answer names its tier; no tier answers `unknown`. Writes: `POST .../memory/declarations/capture` (model proposes, stores nothing), `PUT .../memory/declarations` (user-confirmed write, `Idempotency-Key`, `If-Match`), `POST .../memory/conflicts/resolve`, `DELETE .../memory/declarations/{factId}`. Owner and member write; viewer reads; foreign household is 404. Flags `MEMORY_ENABLED`, `MEMORY_CAPTURE_ENABLED` off unless exactly `true`.

## Consequences

- Positive: one cited, status-honest answer per fact; source stores unchanged; deletes leave no content.
- Cost: resolver decrypts every current row of a household per read (bounded: 2,000 current rows per household, refused beyond); per-process limits still assume one machine. No capacity claim.
- Hard to reverse: written rows and the table. Rollback: flags off, routes unused; drop only with owner approval (declarations are lost).
- Depends on: R2 policy-type tag (`policies.policy_kind` lacks `term_life`), R3 product confirmation (IDA tier), R5 declaration taxonomy approval.
- Requires the independent review AGENTS.md demands for migration, consent, security and AI changes; the owner's standing order skips it, so the risk is carried knowingly.

## Open decisions (owner)

O1 consent purpose (reuse vs new). O2 `declarations/v1` taxonomy and whether PED and prior claims are in MVP. O3 fact-class map for registry sections C and K. O4 `product_term` conflict stays unresolvable (recommended) vs own PDF wins. O5 superseded retention period. O6 IDA rows erased with their source document (recommended). O7 apply 041 to Supabase.
