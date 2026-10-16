# Exec plan: Section 3 (P1-B) PostgreSQL

- Owner: central integration owner. Branch: `claude/p1-postgres` (stacked slice branches merge into it).
- Risk class: migration-sensitive, data-sensitive, security-sensitive (consent, tenant isolation, audit).
- Decision record: `docs/adr/0004-postgresql-runtime.md`. S3.2 design and decisions: [p1b-s32-async-runtime](p1b-s32-async-runtime.md).
- Runtime choice (owner, 2026-10-16): Homebrew PostgreSQL locally; CI uses a PostgreSQL service container.

## Outcome

All runtime persistence uses PostgreSQL. No `node:sqlite` import and no `DATABASE_PATH` use in production code. Every audit, consent, provenance and tenant invariant that the SQLite schema enforces is enforced in PostgreSQL and proven by a test.

## Non-goals

- No deployment, no Azure resources, no production data.
- No native type changes (`timestamptz`, `boolean`, `jsonb`) in the baseline. See ADR 0004, D3.
- No new tables or columns beyond SQLite migrations 001–006.
- No change to API shapes, workflow semantics or consent rules.

## Slices

| Slice | Content | Gate |
|---|---|---|
| S3.1 Schema foundation | `pg` dependency; PostgreSQL baseline migrations equal to SQLite 001–006; migration runner (advisory lock, checksums, one transaction per file); pool factory with timeouts; test harness (template database, one database per test); CI service container; local runbook. Runtime still SQLite. | Catalog parity test against a freshly migrated SQLite database: every table, column, nullability, primary key, foreign key, unique constraint, index, view and critical trigger accounted for. Every critical trigger has a PostgreSQL behaviour test. |
| S3.2 Async runtime | Async database interface; repositories, coverage-analysis port, tenant service, routes and scripts on `pg`; PostgreSQL error mapping; row locking for claims, idempotency and revocation; full test suite on PostgreSQL; SQLite runtime removed. | Full suite green on PostgreSQL. Concurrency tests: duplicate claims 0, duplicate idempotent commits 0, revocation vs commit race leaves no derived data. Cross-household reads/writes 0. |
| S3.3 Data movement and recovery | SQLite export and PostgreSQL import script with row-count and digest parity; `pg_dump`/`pg_restore` backup and restore runbook with a rehearsal test; forward-fix migration policy; SQLite migrations removed (git history keeps them). | Fixture row parity 100%, orphaned foreign keys 0, restore data loss 0. |

## Acceptance metrics (plan P1-B)

The plan lists 41 tables, 84 foreign keys and 64 indexes. These counts come from the plan, not from the code. S3.1 records the real counts from the SQLite catalog and asserts PostgreSQL matches them; any difference is reported, not silently reconciled.

## Rollback

- S3.1: additive. Revert the merge; SQLite runtime is untouched.
- S3.2: revert the merge to return to SQLite. No production data exists, so no data rollback is needed.
- S3.3: script and docs only.

## Unknowns

- Production PostgreSQL version, host and TLS policy (Azure owner not assigned).
- Pool size and timeouts under real load: no workload numbers exist. Defaults are configuration, not capacity claims.
