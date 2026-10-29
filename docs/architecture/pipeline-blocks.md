# Pipeline blocks

Status: map of the owner's seven-block diagram onto the repository. Statuses describe the code at the commit that added this file, plus the Block 1 slice on branch `claude/block1-input` (marked "this slice"). Items not built are marked proposal or planned. No capacity or scale numbers exist. Consent wording is pending legal review. Companion documents: [system.md](system.md), [block-1-input.md](block-1-input.md), [data.md](data.md), [security.md](security.md).

CoverSaath is the canonical name. The diagram says Knowvia. Legacy `knowvia` identifiers stay until a planned rename.

## The seven blocks

| # | Block | Role |
|---|---|---|
| 1 | Input | Accept and protect documents |
| 2 | Insurance parsing | Turn documents into source pages |
| 3 | Decision catalogue | Rules, parameters and insurer facts |
| 4 | Analysis and reasoning | Workflow v6, bounded model help, deterministic decisions |
| 5 | Output | What the household sees and exports |
| 6 | Data and knowledge | Persistence and stored knowledge |
| 7 | System services | Audit, errors, health, CI, identity, governance |

Consent, privacy and household ownership cross every block. They are not a block.

## Block 1: Input

- Purpose: let an authenticated adult add a policy PDF to a case, store it encrypted, check it, and release it to Block 2 only when it is safe.
- Owning paths: `src/features/input/` (`file-validation.js`, `encrypted-local-storage.js`, `document-intake-service.js`, `memory-document-repository.js`, `contracts.js`, `pdf-inspection.js`, `clamd-scanner.js` and `scan-worker.js`). Route and repository wiring live in `src/server/routes/v1-backend-routes.js`, `src/server/create-server.js`, `src/server/config.js` and `src/backend/repositories/`.
- Input seam: `POST /api/v1/cases/{caseId}/documents` (raw `application/pdf`, session auth, `Idempotency-Key`, `document_processing` consent). Detail in [block-1-input.md](block-1-input.md).
- Output seam: `OcrRepository.getReadyDocument` (`src/backend/repositories/ocr-repository.js`) returns a document only when it is active, clean, encrypted and consented. This is the entry condition of `knowvia.ocr.v1` (`src/features/input/ocr-contracts.js`).
- Status: real for upload, inspection, encrypted storage and listing (this slice). Scanning is real code but off by default, so documents stay quarantined. Classification beyond the user-supplied kind is missing.
- Stub to real: set `DOCUMENT_SCAN_MODE=clamd` with a reachable clamd. Later: sandboxed inspection and object storage behind the byte-storage port.
- Owning phase: Block 1 slices. S3.2 converts the repository to the async PostgreSQL port.

## Block 2: Insurance parsing

- Purpose: turn a clean document into immutable, page-level source text with provenance.
- Owning paths: `src/features/input/ocr-contracts.js`, `ocr-service.js`, `fixture-ocr-provider.js`; `src/backend/repositories/ocr-repository.js`; `src/integrations/sarvam/`; `src/features/coverage-analysis/policy-decomposition.js` (sections A-J) and `policy-parameter-registry.js` (129 keys).
- Input seam: `OcrRepository.getReadyDocument`, version `knowvia.ocr.v1`.
- Output seam: `source_pages` rows with `output_contract_version = 'knowvia.ocr.v1'`, read by `src/backend/services/coverage-analysis-port.js`. OCR pages are immutable once complete.
- Status: local Block 1 to Block 2 journey is implemented and tested against a mocked modern Sarvam
  `/doc-ai/v1` boundary. The live feature flag is off by default. No real provider call or OCR quality claim exists.
- Provider boundary: permission-restricted 10-page PDF splitting, explicit language, JSON output, bounded
  polling, exact page remapping and fail-closed partial-result handling.
- Owning phase: Block 2 implementation. Real-account corpus evaluation and retention confirmation remain open.

## Block 3: Decision catalogue

- Purpose: deterministic rules, the pinned parameter registry and, later, insurer facts.
- Owning paths: `src/features/insurance-rules/`; `src/features/coverage-analysis/policy-parameter-registry.js` and `parameter-records.js`. Registry version `policy-parameters/v1`.
- Input seam: parameter records and observations (`coverage_parameter_*` tables) with an authority and an evidence state.
- Output seam: rule results used by `src/agents/decision-agent.js` and the workflow tasks.
- Status: real for rules and the registry on synthetic data. Live insurer sources and treatment rules are missing.
- Stub to real: add reviewed insurer sources and rules one parameter group at a time, each with a registry version bump.
- Owning phase: Phase 3 (insurer sources), Phase 4 (treatment rules, multi-policy). Planned.

## Block 4: Analysis and reasoning

- Purpose: run the 22-task workflow. Code decides. A model only reads and extracts, under consent and the privacy gate.
- Owning paths: `src/features/coverage-analysis/` (`workflow-definition.js`, `persistent-service.js`, `runtime.js`), `src/features/ai-analysis/` (`live-coverage-runtime.js`, `model-gateway.js`, `privacy-evidence-gate.js`), `src/contracts/` (`workflow-graph.js`, `ai-authority.js`, `persistence-ports.js`), `src/agents/`.
- Input seam: source pages through the coverage-analysis port. Contract `knowvia-agent-contract-v1`. Workflow `coverage-analysis` version 6 (ADR 0001). Privacy gate `knowvia-privacy-evidence-v3`.
- Output seam: parameter states and a release-gated decision. Model values are `extracted_unverified`, `conflicting` or `unknown` only (ADR 0003).
- Status: real, with fixture mode and a consent-gated live mode. API clients must grant document `derive` scope for `google-gemini`.
- Stub to real: already real. A later UI must use the existing consent API without broadening it.
- Owning phase: Phase 1 done. P2-D open.

## Block 5: Output

- Purpose: return a source-linked answer through the backend contract. Presentation and export are deferred.
- Owning paths: `src/server/policies/read-response-policy.js` (redacted read DTOs).
- Input seam: redacted job and parameter DTOs from `/api/v1`.
- Output seam: the API response. There is no four-layer answer screen and no export.
- Status: API responses only. No active UI or export exists.
- Stub to real: build a UI later against the existing DTOs. Export is a separate decision.
- Owning phase: planned, not scheduled.

## Block 6: Data and knowledge

- Purpose: durable, tenant-scoped storage and erasure.
- Owning paths: `src/backend/database/` (frozen SQLite migrations, test reference only; PostgreSQL migrations in `postgres/migrations/`), `src/backend/repositories/`.
- Seam: the persistence port (ADR 0002, `src/contracts/persistence-ports.js`). PostgreSQL runtime plan in ADR 0004.
- Status: PostgreSQL is the runtime (S3.2 async runtime; SQLite removed from `src/`). S3.3 (backup and restore, deleting the SQLite migration files) is open. No vector store.
- Stub to real: S3.2 moves the runtime to PostgreSQL behind the port.
- Owning phase: P1-B. A vector store is not planned (see decisions).

## Block 7: System services

- Purpose: audit, error codes, health, CI, identity, governance.
- Owning paths: `src/backend/repositories/audit-repository.js`, `src/contracts/error-codes.js`, `src/backend/services/tenant-access-service.js`, `src/backend/repositories/auth-repository.js`, health routes (`/api/v1/health`, `/live`, `/ready`) in `src/server/routes/v1-backend-routes.js`, `.github/workflows/`, `scripts/check-architecture.mjs`.
- Seam: bearer session to household ownership check; coded, client-safe errors; audit events written in the same transaction as the change.
- Status: real for sessions, ownership, errors, audit and CI. The audit hash chain is never verified. A managed identity provider is missing.
- Stub to real: identity provider in Phase 2. Governance is P1-C.
- Owning phase: P1-C, Phase 2.

## Walking-skeleton build order

1. Connect every block end to end with the existing fixture stubs. Block 1 now has a real entry point. Blocks 2 to 5 already connect through the fixture path.
2. Keep one end-to-end test green: upload, scan, OCR, analysis, answer.
3. Replace one stub at a time with the real block. After each swap, run the end-to-end test and the checks in `AGENTS.md` before the next swap.
4. Do not start a second swap while the first is unreviewed.

With the scanner off, uploads stay quarantined and cannot reach OCR. That is the intended fail-closed state, and it means the full Block 1 to Block 2 path is only exercised when a scanner is configured.

## Decisions

- Deterministic code owns every decision. Model output is only `extracted_unverified`, `conflicting` or `unknown` (ADR 0003). The diagram's step where an LLM matches rules and returns "Covered / Not Covered" with a confidence score is rejected.
- No vector store or semantic search without measured need and an ADR.
- A feedback loop or fine-tuning on user documents needs a consent and privacy design first. Out of scope.
- Consent, privacy and household ownership are checked at every seam.
- Technology names in the owner's Block 1 proposal (FastAPI, Celery, Redis, S3 or R2, React and others) are not approved dependencies.
