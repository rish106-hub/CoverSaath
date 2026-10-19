# S3.2 design: async PostgreSQL runtime

Part of [p1b-postgres](p1b-postgres.md). Source: read-only design analysis at `2ccc891`, checked by the central owner. Line numbers refer to that commit. File:line items are facts; items marked *inference* need a test.

## Decisions (central owner, 2026-10-16)

| # | Decision |
|---|---|
| 1 | Analysis-run idempotency moves inside `createRunWithParameters`: an optional `idempotency` argument; inside the transaction take the idempotency lock, re-read, return `{ existing }` on a hit, else insert the run and the key together. No API change. ADR 0002 gets an amendment. |
| 2 | Transient database errors (40001, 40P01 after retries, 55P03, 57014, 08xxx, 53xxx, pool connect timeout) return 503 with code `DATABASE_UNAVAILABLE`. Today a SQLite busy error returns 400; that is a server condition reported as a client error. All other statuses keep parity. |
| 3 | `julianday(text)` is a PostgreSQL function defined in S3.1 with SQLite semantics (NULL on unparseable input, no `'now'`). Runtime SQL keeps its `julianday` comparisons verbatim. |
| 4 | Close the source-selection vs revocation race: `createRunWithParameters` re-checks source eligibility inside its transaction under the household lock. |
| 5 | One household advisory lock serialises the audit chain and derived-data writes; `NULL` household uses one global key. |
| 6 | Keep `?` placeholders; a tested converter rewrites them to `$n`, skipping quotes, identifiers, comments and dollar quotes. |
| 7 | S3.1 ports trigger and constraint tests to PostgreSQL. SQLite-only schema tests are deleted with the SQLite runtime (WP4). |
| 8 | Pool and timeout defaults are configuration, not capacity claims (ADR 0004 D8); one source of defaults in the S3.1 pool factory. |
| 9 | Without `TEST_DATABASE_URL`, database tests skip with a visible reason; CI requires them. |
| 10 | S3.2 removes the SQLite runtime from `src/`. S3.3 removes the SQLite migration files and keeps the export script under `scripts/` (ADR 0004 D2 updated). |

## 1. Database interface (WP0)

`src/backend/database/postgres/db.js` wraps the S3.1 pool:

```
db.query(sql, params) -> { rows, rowCount }
db.one(sql, params)   -> row | null        // was .get()
db.many(sql, params)  -> row[]             // was .all()
db.run(sql, params)   -> { changes }       // was .run().changes
db.transaction(fn, { locks = [] }) -> result of fn
db.lock(namespace, key)                    // pg_advisory_xact_lock; throws outside a transaction
db.inTransaction                           // was DatabaseSync.isTransaction
db.close()
```

- The transaction client travels in `AsyncLocalStorage`. Queries inside `transaction()` use it; nested `transaction()` becomes a savepoint (this replaces `CoverageParameterRepository.#atomic`, `coverage-parameter-repository.js:170-195`). Repositories keep receiving one `database` object (`backend-services.js:5-17`).
- Guards: concurrent queries on one transaction client throw `TX_CONCURRENT_USE` (no `Promise.all` inside a transaction); queries after release throw; the outermost level retries the whole `fn` up to 3 times on 40001/40P01.
- `lastInsertRowid` (only `audit-repository.js:34`) becomes `INSERT … RETURNING id`. Dynamic `IN (?, …)` (`coverage-analysis-port.js:51-52`) becomes `= ANY(CAST(? AS text[]))`.
- int8 parser per pool: parse OID 20 to Number, throw if not a safe integer. Without it `emergency_mode === 1` (`read-response-policy.js` ~146), `observations === 0` (`coverage-parameter-repository.js:579,730`) and API counts break silently.
- `classifyDatabaseError(error)` maps SQLSTATE: class 23 → 409, P0001 → 400, 22xxx → 400, transient → 503 (decision 2). Never expose `detail`, `table`, `constraint`, `column` or `where`.

## 2. Dialect changes beyond placeholders

| Construct | Sites | Translation |
|---|---|---|
| `julianday(x)` | `database.js:168`; `auth-repository.js:21,42`; `household-repository.js:71-72`; `ocr-repository.js:45`; `consent-repository.js:53,85,109`; `workflow-repository.js:78,148,156,243`; `coverage-analysis-port.js:77,280,442` | Unchanged (decision 3). |
| Untyped `? IS NULL` (42P18) | `workflow-repository.js:134-135,150-151,203`; `audit-repository.js:21` | `CAST(? AS text) IS NULL`; audit splits into `household_id = ?` / `IS NULL` queries. |
| `CASE WHEN ? = 'requested'` | `coverage-parameter-repository.js:414-415` | `CAST(? AS text)`. |
| camelCase aliases folded to lower case | `coverage-parameter-repository.js:230-231`; `tests/coverage-parameter-authority.test.mjs:142-143` | Quote them. Otherwise idempotent `pinRegistry` re-pins throw. |
| `INSERT OR IGNORE` | `coverage-analysis-port.js:326` | `ON CONFLICT (id) DO NOTHING`. |
| `sqlite_schema` / PRAGMA reads | `database.js:134-176` | S3.1 `validatePostgresSchema` (async; `/ready` at `v1-backend-routes.js:154`). |
| Duplicate result column names | `coverage-parameter-repository.js:143-151`; `auth-repository.js:38` | *Inference:* last wins as in node:sqlite. Pin with a test. |

Valid as written: `WITH RECURSIVE … UPDATE` (`workflow-repository.js:287-298`), `||`, `UNION … ORDER BY 1`, `count(DISTINCT …)`, `LIMIT ?`.

## 3. Locking

Lock order for every transaction: household advisory lock → `consent_grants` row `FOR UPDATE` → `workflow_runs` rows `FOR UPDATE` by id → `workflow_tasks` rows → the rest. Isolation stays READ COMMITTED. Lock keys live in `postgres/locks.js`.

| Site | Design |
|---|---|
| `AuditRepository.append` (`audit-repository.js:17-35`) | Transaction + household lock, read previous hash, insert `RETURNING id`. Without the lock concurrent appends fork the chain. |
| `WorkflowRepository.claimNext` (`:119-189`) | Pick a candidate, lock its run, conditional `UPDATE … WHERE status='pending' AND attempt_count<5`; on 0 rows retry selection up to 3 times so `runUntilSettled` does not stop early (`persistent-service.js:92`). |
| `completeTask` / `failTask` / `refreshRunStatus` (`:191-284`) | Lock run, then task. *Inference:* without the run lock two sibling completions leave the run `running` forever. |
| `recoverExpiredLeases` (`:239-261`) | Per run: lock run, conditional task updates. |
| `enqueueTask` idempotency (`:74-99`) | Idempotency lock first. |
| `createRunWithParameters` (`coverage-analysis-port.js:296-354`) | Household lock; idempotency inside (decision 1); source re-check (decision 4). |
| `ConsentRepository.revoke` (`:141-221`) | Household lock, grant `FOR UPDATE`, return if already revoked (else 23505 from `UNIQUE consent_grant_id`), then runs by id, then tasks. Today it updates tasks before runs (`:202-213`): deadlock against `completeTask`. |
| `eraseDerivedRunData` (`:235-327`) / `stopForRevocation` (`port:445-490`) | Same order; audit inside the transaction. |
| `recordModelObservations` (`port:497-526`, `coverage-parameter-repository.js:630-706`) | Household lock, run and task `FOR UPDATE`, re-check lease. Serialises with revoke. |
| `CoverageParameterRepository` | `pinRegistry` → `ON CONFLICT DO NOTHING` then compare; `#applyAcquisition` / `setResolution` lock the row first; `setAcquisitionStateForRun` `keys.map` (`:396-402`) → sequential loop. |
| `AuthRepository.issueSession` (`:13-33`) | Session-capacity lock. `authenticate` `last_seen_at` update adds `AND revoked_at IS NULL`. |
| `OcrRepository.completeJob` / `updateJob` (`:82-153`) | Job row `FOR UPDATE`. |
| `CaseRepository.create`, `HouseholdRepository.*` inserts + audit | One transaction each. |

## 4. Async ripple: silent-failure sites (each needs a test)

| Pattern | Sites | Effect if an `await` is missing |
|---|---|---|
| `Boolean(db…)` | `coverage-analysis-port.js:440-442`; `consent-repository.js:75,98` | Check fails open. |
| Sync `try/catch → deny` around an async call | `port:182-186, 237-272, 361-376, 394` | Rejection escapes; check passes or rejection is unhandled. |
| Spreading a Promise | `v1-backend-routes.js:136` | `{}`. |
| `promise?.household_id` | `port:461,482,529` | `null`: audit goes to the global chain. |
| Array callbacks with DB calls | `tenant-access-service.js:78-119`; `coverage-parameter-repository.js:396` | Use `for…of`. |
| Un-awaited `audit.append` in a transaction | all repositories | Commit before audit insert. |

Callers that already await: `persistent-service.js:74-292`, `live-coverage-runtime.js:334,373`, `ocr-service.js:36-120`. `privacy-evidence-gate.js` and `source-input.js` do not touch the database. `create-server.js:44-52,78`: memoised backend promise, async validator/loader closures, `pool.end()` on close, `DATABASE_URL` replaces `DATABASE_PATH`.

## 5. Tests

- `tests/support/pg.mjs` (WP0): `const { db, services } = await freshDatabase(t, { clock })`; a test-only `db.prepare(sql).get/all/run` facade returning Promises; `assertDbError(promise, { sqlstate, message })`; fail on `unhandledRejection`.
- `assert.throws` → `assert.rejects` (147 sites). `seedParameterWorld` and `live-analysis-scenario.mjs:61-63` become async.
- Delete: `round4-runtime.test.mjs:403-490` (SQLite transaction internals). Rewrite: `p1-error-redaction` test 1 with a pg error whose `detail` holds a value; `isTransaction` → `db.inTransaction`.
- New PostgreSQL tests (gates): concurrent claims (each task once); sibling completions settle the run; 10 concurrent `createAnalysisRun` and `enqueueTask` with one key (one run); lease expiry vs claim; revocation vs `recordModelObservations`/`completeTask` with forced interleaving (zero unredacted observations); 50 concurrent audit appends (linear chain); double revoke; session capacity; cross-household matrix on every route and port method; fail-closed consent checks with revoked, expired and dropped connections; int8 parser; deadlock stress (zero 40P01 after retries).

## 6. Work packages

| WP | Owned files | Depends on | Parallel |
|---|---|---|---|
| WP0 Foundation | `src/backend/database/{index.js,database.js}`, `postgres/{db,placeholders,locks,errors}.js`, `repositories/audit-repository.js`, `tests/support/{pg.mjs,parameter-fixtures.mjs}`, `tests/db-interface.test.mjs`, `tests/audit-chain-concurrency.test.mjs` | S3.1 | First |
| WP1 Workflow, auth, case | `repositories/{workflow,case,auth}-repository.js`, `tests/{p1a-execution-policy,backend-persistence}.test.mjs`, `tests/workflow-concurrency.test.mjs` | WP0 | With WP2 |
| WP2 Consent, parameters, intake | `repositories/{consent,coverage-parameter,household,evidence,ocr}-repository.js`, `tests/{coverage-parameter-authority,coverage-source-consent,ocr-pipeline,model-evidence-state,round4-runtime}.test.mjs`, `tests/revocation-concurrency.test.mjs` | WP0 | With WP1 |
| WP3 Port, routes, server | `services/*`, `server/routes/v1-backend-routes.js`, `server/policies/read-response-policy.js`, `server/create-server.js`, `scripts/database.mjs`, `modules/coverage-analysis/persistent-service.js`, `contracts/persistence-ports.js`, remaining DB tests, `tests/{idempotency-concurrency,tenant-isolation-matrix}.test.mjs` | WP0; test gate after WP1+WP2 | Code in parallel |
| WP4 Integration (central owner) | Remove SQLite from `src/`; architecture rule banning `node:sqlite` under `src/`; docs; ADR 0002 amendment; full checks | WP1–WP3 | Last |

## 7. Top risks

| Rank | Risk | Catching test |
|---|---|---|
| P0 | Missed `await` makes a consent check fail open | Fail-closed matrix + unhandled-rejection hook |
| P0 | Revocation race leaves derived data | Forced-interleaving revocation test |
| P0 | Transaction context leaks onto another connection | `db.transaction` tests (same backend pid, savepoint rollback) |
| P1 | Run never settles; duplicate idempotent commits; audit chain forks; int8 as strings; lock-order deadlocks; timestamp checks throw instead of deny | The matching concurrency and parity tests above |
| P2 | camelCase aliases; untyped `? IS NULL`; error `detail` leak; 23505 where idempotent behaviour is expected | Re-pin twice; existing tests on PostgreSQL; redaction rewrite; double revoke |
