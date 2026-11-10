# Memory layer plan (R4) — implementation of ADR 0023

Status: proposed, not started. Not independently reviewed. Synthetic data only. Consent, notice and retention wording is FOR LEGAL REVIEW.
Decision record: `docs/adr/0023-personal-memory-layer.md`. This file is the build plan; the ADR wins on conflict.

## Outcome, scope, non-goals

- Outcome: each household has an encrypted, erasable memory of insurance facts, one resolved and cited answer per slot, readable by chat and plan.
- Scope: migration 041, `HouseholdMemoryRepository`, deterministic builder and resolver, read and declaration routes, erasure wiring, BFF counterpart, tests.
- Non-goals: multi-model breakdown (R1), UIN identification and product confirmation (R2, R3), declaration taxonomy content (R5, owner), model-backed chat (R6), plan builder (R7), any rule (eligibility, money, release) reading memory.
- Acceptance: every slice below lists its own. Global: no plaintext in any `*_ciphertext` column (`verify` script extended), every erasure path tested, `npm run check`, `npm run eval:safety`, `git diff --check` green.

## Reuse map (what exists, what is new)

| Need | Reused | New |
| --- | --- | --- |
| Own-PDF values (registry keys) | `coverage_parameter_resolutions` + `_observations` (sealed values, page, `extracted_unverified`/`conflicting`) | copy into memory row, pointer `parameter_record_id` |
| Own-PDF values (non-registry) | `proposed_parameters` (`pending_review` only) | pointer `proposed_parameter_id`; status always `extracted_unverified` |
| Citations | `source_pages`, `policy_clauses` | pointers only |
| Insurer wording | `reference_cache` via `ReferenceDataPort.parseFacts` (`verified` / `unknown` / `conflicting`) | `verified` maps to `reviewed_reference`; sealed `reference_ref_ciphertext` |
| Policy and member | `policies`, `household_members` | builder links via `policies.source_document_id` |
| Encryption | `column-crypto.js` `enc2.` | AAD `household_memory_facts.<column>.<id>` |
| Erasure | `ErasureRepository`, `ConsentRepository` revocation, `data-lifecycle.js` | new store entry, `eraseForGrant/Document/Member/Household`, trigger |
| Fact keys | `policy-parameter-registry.js` (`policy-parameters/v1`) | `declarations/v1` taxonomy (R5, owner) and `fact-class-map/v1` |

## Migration 041 `household_memory.sql` (expand-only, re-runnable)

1. `CREATE TABLE IF NOT EXISTS public.household_memory_facts` with the columns, CHECKs and FKs of ADR 0023 D2. `value_ciphertext` and `reference_ref_ciphertext` CHECK `IS NULL OR ~ '^enc2[.]'`.
2. Indexes of D2 (`CREATE ... IF NOT EXISTS`; the table is new, so non-concurrent build is fine).
3. Triggers (`CREATE OR REPLACE` + `DROP TRIGGER IF EXISTS`): scope insert, active document insert, append-only update (only `superseded_at` NULL to value), no truncate, document-erasure delete (`AFTER UPDATE OF lifecycle_state ON document_uploads`).
4. RLS enable, revoke `anon`/`authenticated`.
5. Header comment with the manual rollback (`DROP TABLE` + delete `schema_migrations` row), owner approval only.

Code that must change with it (CI fails otherwise): `schema-expectations.js` (table, triggers, indexes), `postgres-catalog-parity` freeze, `tests/column-audit.test.mjs` classification, `data-lifecycle.js` store `delete`, `data-purposes.js` entry, `docs/architecture/data-lifecycle.md`, `npm run verify:user-data` (`scripts/verify-user-data.js`) plaintext count extended to the new columns.

### Production migration state (verify before applying, read-only)

- `docs/runbooks/fly-deploy.md` requires every migration through 040 applied before deploy.
- Owner plan notes 039 and 040 as unapplied in production; `docs/exec-plans/active/backend-ops.md` says 017 and later were not applied on Supabase (may be stale).
- 031 (`sync_change_log`) and 038 exist only on other branches (038 was renumbered to 040). The runner has no out-of-order guard (db-schema-review P2-9): if 031 later lands on `main` it applies out of order.
- Applying 039, 040 or 041 to Supabase needs **owner approval**. First step is a read-only `SELECT version FROM schema_migrations` with the owner present.

## Components

- `src/backend/repositories/household-memory-repository.js`: `appendMachineRows`, `appendDeclaration`, `listCurrent({householdId, policyId, memberId, keys, cursor, limit})`, `eraseForGrant`, `eraseForDocument`, `eraseForMember`, `eraseForHousehold`, `purgeSuperseded`. Household lock, seal on write, open at edge, coded errors, counts-only audit in the same transaction.
- `src/features/household-memory/` (new feature, `index.js` export): `fact-class-map.js` (versioned key to class), `normalise.js` (typed equality), `resolver.js` (D3 table, pure), `builder.js` (reads structuring and reference stores, writes machine rows idempotently: skip when value and provenance equal current row), `declaration-validator.js` (taxonomy, size, member scope, class refusal).
- `src/contracts/household-memory.js`: statuses, tiers, classes, error codes (`MEMORY_DISABLED`, `MEMORY_KEY_NOT_DECLARABLE`, `MEMORY_REVISION_CONFLICT`, `MEMORY_TOO_LARGE`, `MEMORY_CONSENT_REQUIRED`), response shape. Chat contract: add tiers `memory_own_pdf`, `memory_ida_wording`, `memory_user_declaration` to `CHAT_SOURCE_TIERS`.
- Routes in `src/server/routes/v1-backend-routes.js` per ADR D6. Builder triggers: after `commitStructuring`, after product confirmation (R3), on demand by `POST .../memory/rebuild` (owner or member, rate limited).
- Capture model (slice 4): `src/features/ai-analysis/` prompt + schema; input through `privacy-evidence-gate.js`; budget reservation; consent re-check; output schema-validated, every proposal `extracted_unverified`, returned and never stored; transcript never stored or logged.

## Tests (depth by risk)

| Risk | Tests |
| --- | --- |
| Ownership | foreign household read/write is 404; viewer write 403; member of other household cannot name a member or policy (scope trigger and service). |
| Consent | build refused without current document grant; grant revoked between read and commit writes nothing; declaration without `profile_intake` grant refused; capture without voice/profile grant refused before any model call. |
| Revocation and erasure | each path of ADR D5 deletes exactly its rows and nothing of another household; document erasure trigger fires on both states; household erasure proof (`data-erasure-proof.test.mjs`) extended; audit payload contains no key, value or category. |
| Authority | machine tier cannot write `user_confirmed`; user tier cannot write machine states (CHECK and repository); `product_term` declaration refused; resolver never returns `user_confirmed` for `product_term`; no rule module imports the feature (architecture check). |
| Precedence | table-driven resolver tests for every cell of D3, `unknown` vs value, in-tier conflict, re-extraction after confirmation flips to `conflicting`, resolution row clears it. |
| Duplicate and retry | same `Idempotency-Key` returns same result; builder run twice writes 0 new rows; concurrent builders for one slot leave one current row (unique index, retry once). |
| Revision | stale `If-Match` 409; supersession stamps exactly once; update of any other column rejected by trigger. |
| Encryption | value and reference ref sealed (no plaintext in DB); AAD swap between rows fails; undecryptable row fails closed for reads, never blocks erasure. |
| Bounds | 2,000 current rows cap; key list max 50; declaration text 1,000 chars; alternatives max 5. |
| Rollback | flags off: routes 503 `MEMORY_DISABLED`, nothing else changes; migration re-run is a no-op. |
| Capture model | privacy gate blocks identifiers before the call; injected instructions in user text do not change schema output; stub provider only, live test opt-in. |
| Safety eval | add memory cases to `eval:safety`: unknown beats guess, tier named, no cross-household leak. |

## Beta / BFF counterpart (repo `CoverSaath-Frontend`, ships with each slice)

| Backend | BFF route (server-side only) | Screen and states | Demo mock (`kv_demo`) |
| --- | --- | --- | --- |
| `GET memory` | `GET /api/memory` proxy, session household, zod schema | "What we know" list per policy and member: status chip, source-tier label, citation link; loading, empty, partial, conflict, 503 off | synthetic Rao family fixture, all five statuses |
| `PUT declarations`, confirm box | `PUT /api/memory/declarations` | Declarations journey: boxes prefilled from PDF to confirm; blank box typed input; revision 409 retry | mock echoes as `user_confirmed` in memory state |
| `POST conflicts/resolve` | `POST /api/memory/conflicts/resolve` | Conflict review: "your schedule says X, you said Y"; product-term conflicts read-only with "check with insurer" | two seeded conflicts (one resolvable, one not) |
| `DELETE declaration`, consent withdraw | `DELETE /api/memory/declarations/:id` | Settings: delete a declaration, withdraw memory consent (wired to erasure) | mock deletes locally |
| `POST capture` | `POST /api/memory/capture` (STT stays in BFF; only text goes on) | voice/typed blank box, proposal preview, confirm step | canned proposals, no model |
| Chat tiers | chat adapter maps new tiers to labels | "From your policy document" / "From insurer wording" / "You told us" | mock answers per tier |

All consent and explanatory copy marked FOR LEGAL REVIEW. Demo session keeps getting 403 `DEMO_READ_ONLY` from the backend; the mock serves demo. Landing: any "verified" claim must match statuses.

## Sliced build order (each slice backend + BFF + mock + tests together)

1. **S1 own-PDF read (smallest vertical).** Migration 041, repository, fact-class map for registry `personal_value` keys only, builder from `coverage_parameter_resolutions` after structuring commit, resolver (own-PDF only), `GET memory`, all erasure paths and tests, flag `MEMORY_ENABLED`. BFF read route, "What we know" screen, mock. Exit: synthetic structured case shows cited `extracted_unverified` facts; revoke deletes them.
2. **S2 typed declarations.** `PUT declarations`, box confirm, conflict resolve, delete, resolver for `personal_value` and `household_declaration`. Needs O1 and O2. BFF declarations journey + conflict review.
3. **S3 IDA tier.** After R3 product confirmation: builder reads reference cache, `product_term` rows, unresolvable conflicts. BFF shows insurer-wording tier.
4. **S4 capture model.** Sanitize + categorise behind privacy gate, consent, budget; voice through BFF STT. Flag `MEMORY_CAPTURE_ENABLED`.
5. **S5 chat and plan read.** `MemoryReadPort` in chat retrieval order; tier contract change; plan reads later (R7).
6. **S6 retention.** Superseded purge in `retention:sweep` (dry run default); decision on per-household keys with ADR 0020.

## Risks

- Health declarations (PED, prior claims) are sensitive personal data: needs O1/O2 and legal review before real users.
- Wrong product match gives wrong terms: IDA tier only after user-confirmed match; disagreement shows `conflicting`.
- Normaliser bugs create false agreement (worse) or false conflicts: table tests per value type; on parse failure treat as differ.
- Structuring has no member mapping yet: own-PDF rows are `policy` scope until schedule member extraction exists.
- `policies.policy_kind` lacks `term_life`: R2 owns that change.
- Resolver decrypts per read: bounded; unmeasured on the 512 MB machine.
- Backups keep ciphertext after delete until expiry (legal review).
- No independent review (owner standing order): migration, consent and AI risk carried knowingly.

## Open owner decisions

O1 consent purpose; O2 `declarations/v1` taxonomy and PED in MVP; O3 fact-class map sections C and K; O4 product-term conflict policy; O5 superseded retention; O6 IDA rows erased with source document; O7 apply 039 to 041 to Supabase.

## Rollback

Flags off (routes 503, builder skipped). Rows stay until erased. Table drop only with owner approval, losing declarations. No existing table changes, so code rollback needs no data change.
