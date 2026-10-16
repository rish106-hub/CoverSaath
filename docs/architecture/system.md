# System architecture

Status: describes the repository at the commit that added this file. Anything not stated here is not decided. Companion documents: [data.md](data.md), [security.md](security.md), [../runbooks/local-database.md](../runbooks/local-database.md).

## Purpose

CoverSaath helps a household understand its health-insurance cover from consented, source-linked documents. A case is analysed by a fixed 22-task workflow that separates deterministic decisions from bounded model assistance. Model output is evidence to review, never an authority (`docs/adr/0003-ai-authority.md`). It is a local, synthetic-data prototype: `README.md` says not to enter real personal or medical records.

Naming: CoverSaath is the canonical product name. Some `knowvia` identifiers remain as legacy names until a planned rename: the package name (`package.json`), the OCR contract `knowvia.ocr.v1`, `KNOWVIA_BOOTSTRAP_TOKEN`, `knowvia-agent-contract-v1`, `knowvia-privacy-evidence-v3` and the default database file `.local/knowvia.sqlite`. Do not rename one without a compatibility plan (`AGENTS.md`).

The earlier in-memory demo API was removed. The authenticated `/api/v1` API is the only API.

## Module map (`src/`)

| Area | Responsibility |
|---|---|
| `server/` | Node `http` server (`create-server.js`), config (`config.js`), `routes/v1-backend-routes.js` (all `/api/v1` routes and `errorResponse`), `policies/read-response-policy.js` (consent-checked, redacted read DTOs). |
| `shared/http/` | Framework-free request parsing (16 KiB JSON body cap), security headers, Host/Origin check, rate limiter. `server/http/*` re-exports it. |
| `backend/database/` | `node:sqlite` open, SQL migrations 001-006, `validateSchema`. See [data.md](data.md). |
| `backend/repositories/` | Persistence per aggregate: household, auth, consent, case, workflow, OCR, evidence, coverage parameters, audit. |
| `backend/services/` | `backend-services.js` composes repositories; `tenant-access-service.js` authenticates and checks household ownership; `coverage-analysis-port.js` is the SQLite port the analysis runtime uses (source selection, dispatch check, revocation stop). |
| `backend/state/` | Case state machine (`case-state-machine.js`). |
| `modules/coverage-analysis/` | Workflow definition (v6), task registry, envelopes, parameter registry (`policy-parameters/v1`), persistent service and fixture runtime. |
| `modules/ai-analysis/` | Model eligibility matrix, prompts, output schemas, privacy evidence gate, model gateway, Gemini runtime. |
| `modules/document-intake/` | File validation, AES-256-GCM local byte storage, OCR contracts and service, in-memory fixtures. Not reachable from any route. |
| `modules/insurance-rules/` | Deterministic policy, continuity, cash-exposure and route rules. |
| `agents/` | Domain specialists the fixture task registry calls: profile, group health, personal health, decision. `coverage-orchestrator.js` (`buildCoverageGraph`) has no runtime caller since the legacy engine was removed; only its own test uses it. |
| `contracts/` | Frozen cross-module contracts: task shapes, workflow graph and checksum, execution policy, error codes, API schemas, persistence ports, AI authority. |
| `integrations/` | Sarvam OCR, Gnani voice, Pine Labs payment and email boundaries. All fail closed (`provider-boundary.js`); no provider network call is implemented. |
| `evaluation/` | Offline safety evaluator and reference dataset (`npm run eval:safety`). |
| `ui/` | Browser workspace: `api/` client, `state/` controller, `components/`, `app.js`. |

## Enforced import boundaries

`npm run check:architecture` (`scripts/check-architecture.mjs`) scans every `.js` file under `src/` for relative imports and fails on:

- Any `src/` directory or `.js` file name that is not lowercase kebab-case (`index.js` allowed).
- `shared/` importing anything outside `shared/`.
- `integrations/` importing anything outside `integrations/`.
- `agents/` importing `backend`, `integrations`, `server` or `ui`.
- `backend/` importing `server` or `ui`.
- `ui/` importing `backend`, `integrations` or `server`.
- Code outside `integrations/` importing it other than through `src/integrations/index.js`.

Not covered by the check:

- `modules/`, `contracts/`, `evaluation/` and `server/` as importers have no rule. `backend/` importing `modules/` is allowed and happens (`coverage-analysis-port.js`).
- Bare side-effect imports (`import './x.js'`) and non-relative specifiers are not inspected. Only `from '...'` (including re-exports) and `import('...')` are matched.
- Files outside `src/` (`tests/`, `scripts/`) and non-`.js` files are not scanned.
- Behaviour boundaries (consent, tenancy, model authority) are enforced by code and tests, not by this script.

## Request path of an analysis run

`POST /api/v1/cases/:caseId/analysis-runs`

1. `create-server.js`: Host/Origin/`Sec-Fetch-Site` check, per-client rate limit, then the lazily opened database.
2. `handleV1BackendRoute`: bearer session via `TenantAccessService.authenticate`, then `requireCase(..., { write: true })` (household role check; non-members get 404).
3. `createAnalysisRun`: active-run cap per case (`MAX_RUNS_PER_CASE`), required `Idempotency-Key` header, `executionMode` defaults to `fixture`; `live` needs `modelPermission: true`.
4. `persistent-service.js` `createAnalysisRun`: case status must be `processing`; coverage consent from the analysis subject; idempotency replay or `IDEMPOTENCY_CONFLICT`; for `live`, source pages selected only under exact per-document `derive` consent naming `google-gemini` and sanitised by the privacy gate; `createRunWithParameters` creates the run, 22 tasks, registry pin and parameter records together.
5. `runUntilSettled`: claim tasks under a lease (`workflow-repository.js`), run each through the fixture or live registry, re-check consent before and after each batch.
6. Live model tasks (`live-coverage-runtime.js`, `model-gateway.js`): privacy gate with the household's known identifiers, pre-dispatch consent validation, budget reservation, 30 s default timeout, no retries.
7. Commit: for live runs, `verifyRunSourcesCurrent` re-checks every source; on failure the results are discarded and the run is stopped with erasure. Otherwise model values are recorded as unverified observations and the task completes.
8. The response is a redacted job DTO (`read-response-policy.js`).

## Workflow version and graph

- `COVERAGE_ANALYSIS_WORKFLOW` is name `coverage-analysis`, version `6`, 22 tasks (`src/modules/coverage-analysis/workflow-definition.js`). The module refuses to load if the graph, schema ids or model ownership violate ADR 0001 rules.
- Graph checksum `39384121ec4e1002c1dc9820ffd0ee49143fecf8566307b1e2c421812e0e9fa1` is computed by `src/contracts/workflow-graph.js` and pinned in `tests/p1a-workflow-contracts.test.mjs`. It covers key, kind, owner, model task, dependencies and schema ids, not the retry policy.
- Runs pinned to another version stay readable but are not executed; v5 output is refused with `WORKFLOW_VERSION_MISMATCH` (ADR 0001).
- Lease 60 s, 5 attempts, retry only on lease expiry, a thrown task error is terminal (`src/contracts/execution-policy.js`, which documents behaviour and does not drive it).

## Runtime and deployment

- Node `>=22.16.0` (`package.json` engines), `node:sqlite`, Vite 8.3.0 for the UI build; `ai` and `@ai-sdk/google` are the runtime dependencies.
- One process. `src/server/server.js` listens on `127.0.0.1:8787` only; `npm run dev` also starts Vite on `127.0.0.1:5173` and proxies `/api`.
- Storage is one local SQLite file. Analysis work runs inside the API process; there is no queue, worker fleet, cache or container.
- No deployment target, infrastructure code, hosting, observability stack or capacity numbers exist. CI (`.github/workflows/`) only checks and scans. Scale claims are unsupported (`AGENTS.md`).
- PostgreSQL is planned (ADR 0002), not built.

## Decisions

- [ADR 0001](../adr/0001-workflow-v6-contracts.md): workflow v6 and frozen task contracts.
- [ADR 0002](../adr/0002-persistence-port.md): persistence port for a future PostgreSQL adapter.
- [ADR 0003](../adr/0003-ai-authority.md): AI authority matrix.

All three are marked `Proposed` in their headers; no source records acceptance.
