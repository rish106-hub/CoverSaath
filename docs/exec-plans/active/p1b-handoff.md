# Handoff: Section 3 (P1-B PostgreSQL), for the next agent

- Written: 2026-10-16 by the central owner (Claude). Next owner: Codex or any agent.
- Read first: `AGENTS.md`, `docs/iterations/LATEST.md`, [ADR 0004](../../adr/0004-postgresql-runtime.md), [p1b-postgres](p1b-postgres.md) (slices and gates), [p1b-s32-async-runtime](p1b-s32-async-runtime.md) (S3.2 design, decisions 1–10, work packages).

## 1. Where to start

| Item | Value |
|---|---|
| Base branch | `claude/p1-postgres` (pushed; PR into `main` is open) |
| Start S3.2 on | a new branch cut from `claude/p1-postgres`, e.g. `codex/p1b-s32-wp0` |
| `main` | at `494fed7` (PR #7 merged). Do not commit to `main` directly. |
| Done so far | S3.1 schema foundation merged into `claude/p1-postgres` (commit `d79bb25`, merge on top). Runtime is still SQLite. |
| Not done | S3.2 (async runtime on PostgreSQL, SQLite removed from `src/`), S3.3 (export/import, backup/restore, forward-fix policy). |

```bash
git fetch origin
git switch claude/p1-postgres
git pull --ff-only
git switch -c codex/p1b-s32-wp0
npm ci
```

If the S3.1 PR receives review changes, rebase or merge `claude/p1-postgres` into your branch before continuing.

## 2. Local PostgreSQL (Homebrew, no Docker)

Full runbook: `docs/runbooks/local-postgres.md`. Summary:

```bash
LC_ALL=C.UTF-8 /opt/homebrew/opt/postgresql@17/bin/pg_ctl -D .local/postgres -l .local/postgres.log -o "-p 54329 -k /tmp -c listen_addresses=localhost" start
```

```bash
export TEST_DATABASE_URL=postgres://coversaath@localhost:54329/postgres REQUIRE_POSTGRES=1
```

- Without `LC_ALL` the server fails with `FATAL: postmaster became multithreaded during startup`.
- Cluster lives in `.local/postgres` (git-ignored), trust auth on loopback, `C` locale. If it does not exist, run `initdb` from the runbook.
- Without `TEST_DATABASE_URL`, 31 PostgreSQL tests skip with "TEST_DATABASE_URL not set". CI sets `REQUIRE_POSTGRES=1` and runs a `postgres:17.11` service (`.github/workflows/ci.yml`).
- The harness keeps one cached template database `coversaath_tpl_<digest>` and creates and drops one clone per test. A stale template is harmless; a new migration set gets a new digest.
- The owner may later replace Homebrew with a light Docker alternative. Tests only need `TEST_DATABASE_URL`, so nothing in code depends on Homebrew.

## 3. What S3.1 delivered (use it, do not rewrite it)

`src/backend/database/postgres/`:

- `migrations/001_baseline_schema.sql`, `002_baseline_triggers.sql`: equal to the final state of SQLite migrations 001–006. Never edit them after merge; add `003_…` instead (checksums are enforced).
- `migrate.js`: `runPostgresMigrations` (session advisory lock, one transaction per file, SHA-256 checksums; codes `POSTGRES_MIGRATION_CHECKSUM_CHANGED`, `POSTGRES_MIGRATION_FAILED`).
- `pool.js`: `createPostgresPool` (from `DATABASE_URL`; sets `statement_timeout`, `lock_timeout`, `idle_in_transaction_session_timeout`, `application_name` = `cover_saath`; coded errors `DATABASE_URL_REQUIRED`, `DATABASE_URL_INVALID`, `DATABASE_POOL_OPTION_INVALID`; never logs the URL).
- `validate-schema.js`: `validatePostgresSchema` (same shape as SQLite's `validateSchema` plus collation, disabled triggers, foreign-key orphan scan).
- `errors.js`: `PostgresDatabaseError`.
- `julianday(text)` and `coversaath_utc_now()` are SQL functions in 001. `julianday` ports SQLite's parser, returns NULL on bad input and on `'now'`, never raises. Parity: 107 inputs, 0 differences.

Tests: `tests/postgres-{catalog-parity,triggers,constraints,julianday,runner,pool}.test.mjs`, harness `tests/support/postgres.mjs`, seeds `tests/support/postgres-fixtures.mjs`.

Measured catalog (both engines): 41 tables + `schema_migrations`, 404 columns, 85 foreign keys (the plan said 84; the code has 85), 64 indexes (48 named + 16 unique), 2 views, 56 triggers, 126 CHECKs, 47 critical triggers. 14 of 14 mutation checks detected.

### Open from S3.1

- An independent read-only review (Opus) of S3.1 was started and had not reported when this handoff was written. Its findings, if any, go on the S3.1 PR. Fix P0/P1 findings before starting WP1.
- Known accepted deviations: `julianday('now')` returns NULL (use `coversaath_utc_now()`); `strftime('now')` truncates milliseconds; PostgreSQL fires same-event triggers alphabetically; 9 non-critical guard triggers are not in `criticalTriggers` in `database.js` (consider adding them in S3.2).
- Guard triggers read other rows without locks. That was safe under SQLite's single writer. S3.2 must add the locks in section 4 below.

## 4. S3.2: what to build

The design is binding: [p1b-s32-async-runtime.md](p1b-s32-async-runtime.md). Key points:

- **Database interface (WP0):** `query`, `one`, `many`, `run`, `transaction`, `lock`, `inTransaction`, `close`. Transactions are carried in `AsyncLocalStorage`; nested `transaction` calls become savepoints. A `?`→`$n` placeholder converter. A per-pool int8 type parser (bigint flags and counts must come back as numbers, or `emergency_mode` reads false and `count === 0` never holds). `classifyDatabaseError`: `P0001` (trigger) and class `23` (constraint) map to the existing coded client errors; transient errors (`40001`, `40P01`, `55P03`, `57014`, `53300`, connection loss) map to 503 `DATABASE_UNAVAILABLE`. Never expose driver messages.
- **Lock order (everywhere, to avoid deadlocks):** household advisory lock (global key when household is NULL) → `consent_grants … FOR UPDATE` → `workflow_runs` → `workflow_tasks` → everything else. Isolation READ COMMITTED. The current revocation path takes locks in the reverse order from task completion; fix it.
- **Races SQLite hid, each needs a concurrency test:** audit hash chain (per-household lock), task claims (`FOR UPDATE SKIP LOCKED`), idempotency (fold into `createRunWithParameters`; amend ADR 0002), revocation vs commit and vs document/OCR/outbox inserts, source selection vs revocation (re-check consent at run creation).
- **Missed `await` is the top risk:** at least three consent checks become fail-open if a promise is treated as a truthy value. Section 4 of the design lists the sites; each needs a test. Make unhandled rejections fail the test run.
- **Dialect:** `LIKE` keeps SQLite's ASCII case-insensitivity (use `ILIKE` or `lower()` explicitly), `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, `changes()` → `rowCount`, `json_*` → PostgreSQL JSON operators on `text::json`, `julianday`/`strftime` → the S3.1 functions. See design section 2.

### Work packages and file ownership

| WP | Files | Depends on | Notes |
|---|---|---|---|
| WP0 Foundation | `src/backend/database/{index.js,database.js}`, `postgres/{db,placeholders,locks,errors}.js`, `repositories/audit-repository.js`, `tests/support/{pg.mjs,parameter-fixtures.mjs}`, `tests/db-interface.test.mjs`, `tests/audit-chain-concurrency.test.mjs` | S3.1 | First, alone |
| WP1 Workflow, auth, case | `repositories/{workflow,case,auth}-repository.js`, `tests/{p1a-execution-policy,backend-persistence}.test.mjs`, `tests/workflow-concurrency.test.mjs` | WP0 | Parallel with WP2 |
| WP2 Consent, parameters, intake | `repositories/{consent,coverage-parameter,household,evidence,ocr}-repository.js`, `tests/{coverage-parameter-authority,coverage-source-consent,ocr-pipeline,model-evidence-state,round4-runtime}.test.mjs`, `tests/revocation-concurrency.test.mjs` | WP0 | Parallel with WP1 |
| WP3 Port, routes, server | `services/*`, `server/routes/v1-backend-routes.js`, `server/policies/read-response-policy.js`, `server/create-server.js`, `scripts/database.mjs`, `modules/coverage-analysis/persistent-service.js`, `contracts/persistence-ports.js`, remaining DB tests, `tests/{idempotency-concurrency,tenant-isolation-matrix}.test.mjs` | WP0; tests after WP1+WP2 | |
| WP4 Integration | Remove `node:sqlite` from `src/` (today only `src/backend/database/database.js` imports it); add an architecture rule banning it under `src/`; docs; ADR 0002 amendment | WP1–WP3 | Last |

Suggested branches: one per WP from `claude/p1-postgres` (`codex/p1b-s32-wp0`, then `-wp1`, `-wp2`, `-wp3`, `-wp4`), each merged back into `claude/p1-postgres` after its checks pass. Two writers never touch the same files.

### S3.2 gate (from the plan)

Full suite green on PostgreSQL; duplicate task claims 0; duplicate idempotent commits 0; revocation racing a commit leaves no derived data; cross-household reads or writes 0; production `node:sqlite` imports 0; production `DATABASE_PATH` use 0.

## 5. S3.3 after S3.2

SQLite export → PostgreSQL import script under `scripts/` with row-count and digest parity (100%) and 0 orphaned foreign keys; `pg_dump`/`pg_restore` backup and restore runbook with a rehearsal test (0 data loss); forward-fix migration policy in `docs/architecture/data.md`; delete `src/backend/database/migrations/*.sql` (SQLite), keeping git history.

## 6. Rules that bite

- Commands come only from `package.json` and `.github/workflows/`. Do not invent them.
- Synthetic data only. No secrets, no real names, phones, policies or medical data, anywhere.
- Never weaken a consent, tenant or audit control, or a trigger, to make a test pass.
- Model output is never authoritative (`src/contracts/ai-authority.js`).
- `tests/product-contract.test.mjs` forbids the string `coversaath` in `src/**/*.js`. Use `cover_saath` or `CoverSaath` in identifiers where needed.
- `tests/p1a-persistence-ports.test.mjs` allows `pg` as the only database package: no ORM or query builder.
- Ask the owner before destructive data changes, deployment, paid services or GitHub repository settings.

## 7. How to wrap up each work package

1. Run, with PostgreSQL started and the env vars from section 2 set:
   ```bash
   npm run check
   ```
   then the same without `TEST_DATABASE_URL` (PostgreSQL tests must skip visibly, not fail, until WP4 makes PostgreSQL mandatory), then:
   ```bash
   npm run eval:safety
   ```
   ```bash
   git diff --check
   ```
2. Mutation-check every new concurrency or consent test: break the fix, confirm the test fails, restore.
3. Get an independent read-only review for consent, locking or migration changes. Fix P0/P1 before merging.
4. Update `docs/iterations/LATEST.md` (state block, evidence with real counts, open risks). Update this handoff's section 1 table.
5. Commit with a conventional message (`feat(db): …`, `test(db): …`), merge the WP branch into `claude/p1-postgres`, push.
6. When S3.2 is complete, open or update the PR from `claude/p1-postgres` into `main`. Report: what changed, evidence, what is unverified, security and data impact, rollback (revert the merge; no production data exists), follow-ups.

## 8. Waiting on the owner (do not do these yourself)

- CodeQL: switch from default setup to advanced (the two conflict). Secret scanning and push protection.
- P1-C governance: second maintainer, `main` ruleset, protected `v*` tags, squash-only, Actions allowlist, read-only default token. Files an agent may draft: `CODEOWNERS`, PR template, `CONTRIBUTING.md`.
- Confirm the 503 `DATABASE_UNAVAILABLE` change (transient database errors used to return 400).
- Retention policy for consent expiry (review F3), `docs/evidence/` history purge, Azure owner, Phase 0 gate approval, deleting `.local/runs`.
- Dependabot Docker ecosystem is commented out in `.github/dependabot.yml`, so the CI `postgres` image is never bumped. Enabling it is an agent task once the owner agrees.

## 9. After Section 3

Phase 1 remaining: P1-C governance, P1-D leftovers (controlled vulnerable-dependency, fake-secret and fork PR tests). Then Phases 2–6 per the production plan: identity, document storage and OCR; live insurer sources; treatment rules and multi-policy; product journey and pilot; Azure staging and release. Backlog: `coverage-orchestrator` has no caller; no security-header or 429 test; retention and audit chain never verified end to end; Knowvia → CoverSaath rename needs a compatibility plan; npm audit high on `source-map-js` (build-time only, via `vite`).
