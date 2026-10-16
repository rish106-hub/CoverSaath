# Database (local rules)

Applies to `src/backend/database/` and `src/backend/repositories/`. Root `AGENTS.md` still applies.

- Add a migration as the next `NNN_snake_case.sql`. Never edit, rename or reorder a merged migration; `openDatabase` rejects a changed checksum.
- Expand-only by default. A contracting change (drop, rename, tighten) needs an exec plan with a compatibility window and a forward-fix or restore path.
- A trigger or constraint that protects an invariant goes into `criticalTriggers` in `database.js`, with a test that it fires.
- Adding a migration updates the migration count and list tests (`tests/database-schema.test.mjs`, `tests/database-integrity-v2.test.mjs`, `tests/evidence-completion-persistence.test.mjs`).
- Note any SQLite-only construct in the migration header; PostgreSQL parity is planned (ADR 0002).
- Repositories: parameterised and bounded queries, multi-row invariants in one transaction, audit event in that same transaction, counts-only audit metadata (no document text or identifiers).
- Every table holding household-derived data needs an erasure path called from consent revocation, with a test.
