# ADR 0032: Thin policy holdings, memory conflicts, member declarations and premium records

- Status: Accepted (2026-11-11). Schema and repositories only (migrations 048-052); no pipeline, resolver or UI. Not independently reviewed (standing order).
- Synthetic data only. Consent, privacy, declaration and notice wording is an engineering reading and is **FOR LEGAL REVIEW**.
- Related: ADR 0023 (personal memory layer, accepted with changes), 0024 (policy profile), 0025 (policy facts), 0013 (column encryption), 0026 (person records). Plan: `docs/exec-plans/active/complete.md` sections 3.1 and 9.

## Context

The MVP plan asked for a wide `policy_holdings` table (insurer, product, UIN, policy number, sum insured, period), a plaintext EAV `policy_fact_values` with a GIN index and a generated text column, and a `fact_conflicts` table. All three collide with `main`: policy identity already lives in `policy_profiles` (043) and `policies` (001); a plaintext value column and a GIN index would undo ADR 0013 and ADR 0025 D3; and `fact_conflicts` exists since migration 001 (retired ledger, no writer).

## Decisions

**D1. A holding is a thin link (048).** `policy_holdings`: `id, household_id, policy_id, document_id, policy_profile_id, kind, status`, timestamps. It stores no insurer, plan, UIN or policy number. Insurer and plan confirmation is written to `policy_profiles` in state `reported`, never duplicated here. One holding per upload (`UNIQUE (household_id, document_id)`). Status is the holding's own lifecycle (`uploaded, insurer_pending, product_reported, parsed, conflicts, ready`), forward-only in the repository; the plan's word `confirmed` is not used (it would read as a fact status). Erased by the document-erasure trigger, consent revocation and household erasure.

**D2. Memory facts are `household_memory_facts` (049), as in ADR 0023.** Sealed value, tiered statuses, append-only with supersession, no plaintext value, no GIN, no full-text column. The fact-key registry is `src/contracts/policy-facts.js` (61 keys at v1, append-only), mapped onto `fact-types.js` with a drift test.

**D3. Conflicts are `memory_conflicts` (050).** Ids and closed enums only: `holding_id, fact_key, candidate_fact_ids, reason (own_vs_insurer | two_pages | model_disagree | own_vs_declaration), resolution (pending | user_chose | insurer_wins | own_wins | dismissed), resolving_fact_id, resolved_by (user | rule), resolved_by_adult_id, resolved_at`. At most one open conflict per (holding, key). A resolved conflict is closed (trigger). A rule never records `user_chose` (CHECK). The user may resolve any conflict: the choice is a new `user_declaration` fact (`capture_method = conflict_resolution`); machine rows stay. FOR LEGAL REVIEW.

**D4. Member declarations (051).** `member_declarations`: kind (closed enum), `label_enc` sealed (health data), `declared_on`, `declared_to_insurer`, optional holding and document. Guardian rules of ADR 0026 apply in the repository. The plain `kind` column alone tells that a member has, for example, a declared pre-existing disease. That is sensitive metadata; it is plain so lists need no unsealing. **Owner decision requested:** keep plain, or seal and filter in memory.

**D5. Premiums (052).** `premium_payments` and `premium_dues`. Exact amounts are sealed (`amount_enc`) with a coarse plain `amount_band`, like `policy_facts` (ADR 0025 D3). This deviates from the plan sketch (`amount_paise` plain): a premium amount is household money data and 044 seals exact money. Agent name and code are sealed. Dates and enums are plain so reminders and tax reporting read them in SQL. **Owner decision requested:** keep sealed with a band (current), or plain.

**D6. Consent.** Machine tiers need a `coverage_reconstruction` grant of the household; declarations, payments and dues need a `profile_intake` grant of the acting adult. Each row stores its `consent_grant_id`; revoking the grant deletes the rows (`memory-erasure.js`). The profile_intake notice gains a financial item for premiums (FOR LEGAL REVIEW).

**D7. Flag.** `HOLDINGS_ENABLED`, off unless exactly `true`. This slice adds only read-only route stubs (`GET /api/v1/households/{id}/holdings[/{holdingId}]`) to prove ownership at the boundary.

## Consequences

- Positive: no duplicated policy identity; no plaintext values; every new table has `household_id` first in its main index, scope triggers, RLS, an erasure path and tests.
- Cost: a holding deleted by document erasure takes its premium records with it (they hang on the holding). Revisit when the premium desk gets its own consent (ADR 0018 retention questions).
- Hard to reverse: written rows. Rollback: flag off, routes unused; synthetic-only projects may drop the tables (declarations and premiums are lost).
- Not built: the resolver, pipeline jobs, chat reads, the retention sweep of superseded rows, per-key sealed filters.
- Requires the independent review AGENTS.md demands for migration, consent, security and AI changes; the owner's standing order skips it, so the risk is carried knowingly.
