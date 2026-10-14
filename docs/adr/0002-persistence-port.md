# ADR 0002: Persistence port for the coverage-analysis runtime

- Status: Proposed (P1-A, branch `claude/p1-contracts`)
- Date: 2026-10-15
- Scope: `src/contracts/persistence-ports.js`, `src/contracts/execution-policy.js`

## Context

The runtime persists through `createCoverageAnalysisPort` (SQLite, `src/backend/services/coverage-analysis-port.js`). The port composes `WorkflowRepository`, `CoverageParameterRepository`, `ConsentRepository`, `CaseRepository`, `AuditRepository` and direct SQL. PostgreSQL is planned. A PostgreSQL adapter needs a fixed list of methods and semantics to be checked against. This decision adds no database code and no `pg` dependency.

## Decision

`src/contracts/persistence-ports.js` lists every method the runtime needs, with JSDoc signatures. It also provides runtime shape checks that throw `PORT_CONTRACT_INVALID` and name the missing methods.

| Port | Methods | Check |
|---|---|---|
| Coverage-analysis port (what `createPersistentCoverageAnalysisService` requires) | `getCase, requireCoverageConsent, findIdempotency, recordIdempotency, createRunWithParameters, verifyRunSourcesCurrent, getCoverageSourcePages, loadKnownIdentifiers, getJob, getTask, claimNext, dependencyOutputs, completeTask, failTask, recoverExpiredLeases, isConsentActive, stopForRevocation, persistTaskArtifact, recordModelObservations` | `assertCoverageAnalysisPort` |
| Model dispatch (live only) | `authorizeModelDispatch` | `assertCoverageAnalysisPort(port, { modelDispatch: true })` |
| Workflow repository | `createRun, insertTask, createRunWithTasks, enqueueTask, getRun, getTask, claimNext, completeTask, failTask, recoverExpiredLeases` | `assertWorkflowRepositoryPort` |
| Coverage parameter repository | `initializeRunParameters, setAcquisitionStateForRun, recordModelExtraction, redactObservationsForRun, redactObservationsForDocument` | `assertCoverageParameterRepositoryPort` |
| Consent repository | `requireActive, eraseDerivedRunData` | `assertConsentRepositoryPort` |
| Case / audit repository | `get` / `append` | `assertCaseRepositoryPort` / `assertAuditRepositoryPort` |
| Fixture run store | `createRun, loadRun, replaceRun` | `assertFixtureRunStorePort` (the same list `contracts.js` uses) |

Rules a PostgreSQL adapter must keep:

- **Asynchronous calls.** Every method may return a value or a Promise. The persistent service awaits every port call, and the live runtime awaits `authorizeModelDispatch`. A test runs a full fixture analysis through an adapter whose every method resolves on a later macrotask.
- **Atomic methods.** Each method is one unit of work, and the adapter owns its transaction. In particular:
  - `createRunWithParameters` creates the run, its tasks, the registry pin and every parameter record, or nothing.
  - `stopForRevocation` erases derived data and stops the run in one transaction.
  - `recordModelObservations` checks the lease, writes the observations and appends the audit event together.
  - Callers never hold a transaction across two port calls.
- **Workflow semantics.** Claim, complete, fail, lease, attempt, settlement and idempotency semantics are defined in `src/contracts/execution-policy.js` (see ADR 0001). The SQLite tests in `tests/p1a-execution-policy.test.mjs` are the reference behaviour for a PostgreSQL adapter to reproduce.
- **Data handling.**
  - `loadKnownIdentifiers` output is never persisted.
  - Audit payloads carry counts, codes and digests only.
  - An internal error in a consent or dispatch check denies; it never allows.

## Consequences and gaps

- **Routes and tenant checks are not covered.** The SQLite port uses direct SQL (case subject derivation, source selection, consent checks, dependency outputs). The routes (`v1-backend-routes.js`) and `TenantAccessService` also read `workflow_runs` and `workflow_tasks` with direct SQL. Those read paths are not part of the runtime port. They need their own read port before routes can run on PostgreSQL.
- **Signatures are documentation only.** The shape checks confirm that the methods exist, not their signatures or semantics. Semantics are checked by behaviour tests, which a PostgreSQL adapter must also pass.
- **Exports are not wired yet.** `src/modules/coverage-analysis/index.js` still exports its own `assertCoverageAnalysisPort` (the fixture store check). The new contract exports are listed in the P1-A handoff for the central owner to add.

## Rollback

Revert the commit. These are new, contract-only files, and no runtime code imports them except `contracts.js`, which takes the fixture port list from them; that list is unchanged.
