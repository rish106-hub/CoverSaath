# Evidence completion MVP intake

## CERT state

CERT = READY

Task class: S2. The change affects document consent, sensitive evidence, AI input, and persisted data contracts.

AI DESIGN = VERIFIED for this MVP slice. AI remains extraction-only. Deterministic code owns consent, parameter identity, evidence admission, redaction, state resolution, and release.

## C: Clarify

Task title: Evidence completion MVP

North Star / business outcome: turn an authorised policy document set into a complete, source-linked list of policy facts and explicit gaps without exposing unnecessary personal data or treating AI output as authoritative.

Primary user and trigger: a household operator starts coverage reconstruction after the subject adult has supplied policy documents and granted the required consent.

Problem today: the product has a broad parameter catalogue, but the runtime uses a separate partial list. OCR pages enter analysis as generic text. The system cannot report acquisition and resolution status for every canonical parameter. Analysis checks a case-level grant, but source selection does not revalidate each document grant. Raw OCR text can reach model input without a deterministic privacy transformation.

Desired customer outcome: every applicable parameter has a stable identity, source trail, acquisition status, resolution status, and safe next action. Documents without current consent never enter analysis. Model input contains only the minimum permitted evidence.

In scope:

- One immutable, versioned canonical policy parameter registry based on `building/policy-parameters.md`.
- Separate per-parameter acquisition and resolution records.
- Deterministic evidence minimisation and redaction before any model request.
- Current, document-level consent enforcement during source selection and immediately before provider dispatch.
- Database support, migrations, runtime adapters, and tests needed for this slice.
- Existing monolith, SQLite, workflow engine, and AI gateway.

Explicit non-goals:

- Redis, Kafka, queues outside the current workflow tables, microservices, Kubernetes, or a cloud migration.
- Claim approval, payment prediction, eligibility decisions, legal conclusions, medical advice, or automated external action.
- Full user-interface redesign.
- New OCR, model, analytics, or infrastructure vendors.
- Treating HRMS, payroll, marketing material, or model output as policy proof.

Acceptance criteria:

1. One registry version identifies every supported parameter with a unique stable key, A-K section, data class, expected source classes, applicability rule, value contract, and whether AI extraction is permitted.
2. Every analysis run pins the registry version. Unknown registry versions fail closed.
3. Every applicable parameter has an acquisition state and a resolution state. Absence is explicit and is never converted to false.
4. Acquisition states distinguish at least `not_requested`, `requested`, `received`, `rejected`, and `not_permitted`.
5. Resolution states distinguish at least `unknown`, `reported`, `extracted_unverified`, `proven`, `calculated`, `dynamic`, `conflicting`, and `not_permitted`.
6. State transitions are validated. A model result cannot create `proven`, `calculated`, or `dynamic` authority.
7. Every non-unknown resolved value carries source ID, document ID, version, page, extraction method, and review status. Conflicts preserve all controlling observations.
8. Before source pages enter analysis, each document must have a current grant for that exact document, subject, purpose, action, data category, and intended model recipient where applicable.
9. Revoked, expired, mismatched, or absent document consent excludes the document and produces a stable blocker. A mixed-consent case does not leak the denied document.
10. A deterministic pre-AI gate classifies fields, removes unnecessary direct identifiers, rejects restricted material, bounds text, and emits only audit-safe metadata plus a digest. Raw identifiers do not appear in model requests, model traces, workflow output, audit payloads, or errors.
11. Model output is schema-validated, source-bound, and stored as unverified evidence until deterministic or human review resolves it.
12. Existing architecture checks, targeted tests, full tests, and build pass. New negative tests cover revocation after OCR and immediately before dispatch.

Known constraints:

- Node `>=22.12.0`; verified with bundled Node `24.19.0`.
- npm lockfile is the application dependency authority. No application dependency is needed for this slice.
- SQLite migrations are expand-only. Existing evidence remains readable.
- Raw secrets and real personal data are not test fixtures.
- Root `AGENTS.md` and `CLAUDE.md` are identical and contain the mandatory procedure. Referenced `docs/CERT.md` and `docs/agent-tooling.md` are absent and should be restored later.

Success metric: 100% of applicable registry parameters receive explicit states; 0 denied documents enter analysis; 0 prohibited identifiers reach model requests in the test corpus; all consent and privacy negative tests fail closed.

## E: Examine

### Repository and map

- Branch: `codex/evidence-completion-mvp`.
- Initial product tree was clean.
- Repository map: 161 files, 133 JavaScript files, 735 symbols, and 963 call edges.
- Affected graph areas: `document-intake` (11 files), `coverage-analysis` (15), backend (19), `insurance-rules` (24), and AI runtime.
- High-impact nodes: `policy-decomposition.js`, document-intake contracts, and `coverage-analysis-port.js`.
- Impact reaches 38 direct callers, 60 symbols, 26 files, and 6 modules.

Relevant current flow:

```text
document upload -> quarantine and scan -> OCR pages
-> case source-page query -> generic unclassified evidence
-> coverage workflow -> AI-eligible extraction tasks
-> deterministic evidence/privacy/safety checks -> release gate
```

Observed strengths:

- Upload and OCR require scoped consent.
- Documents are quarantined, scanned, encrypted, versioned, and source-linked.
- Revocation cancels pending work and clears derived OCR text.
- AI schemas are bounded and reject unsupported certainty.
- Evidence, privacy, safety, and release checks are deterministic.

Observed gaps:

- `building/policy-parameters.md` is not an executable versioned contract.
- `policy-decomposition.js` duplicates only part of that catalogue.
- `source-input.js` represents OCR pages as `unclassified_policy_text`.
- `getCoverageSourcePages` does not join and revalidate every document's consent.
- Live request builders can include OCR-derived text before deterministic PII minimisation.

### Runtime and dependencies

- Node: `24.19.0` from the bundled workspace runtime.
- pnpm: `11.25.0`, used only for readiness inspection. The repository remains npm-lockfile based.
- Existing dependencies were sufficient. No new package, framework, skill, plugin, MCP server, CLI, service, or environment variable is required.
- Existing live configuration names remain unchanged: `LLM_PROVIDER`, `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY`, `LLM_MODEL`, `LLM_MODEL_VERSION`, model cost and limit variables, orchestration budgets, and existing server limits.

## R: Resolve design

### Canonical registry

Create a data-only registry module with an explicit schema and version constant. Each entry contains:

- `key`, `section`, `label`, `dataClass`, and `valueType`
- `expectedSources`, `applicability`, and `authorityOwner`
- `modelExtraction` allow or deny
- permitted resolution states and any deterministic calculation owner

The registry is append-only within a version. Meaning changes require a new version. Startup validation rejects duplicate keys, invalid sections, incomplete entries, and unknown state names.

### Parameter status contract

Keep acquisition and resolution separate:

```text
ParameterRecord
  registryVersion
  parameterKey
  subject and policy scope
  acquisitionState
  resolutionState
  observations[]
  resolvedValue or null
  reasonCode
  updatedAt
```

Acquisition reports whether evidence was permitted and obtained. Resolution reports what that evidence establishes. `not_permitted` is not `unknown`. Conflict resolution reuses the current source hierarchy and preserves all controlling observations.

### Consent boundary

Source selection must join `document_uploads`, `consent_grants`, and `consent_scopes`. It must validate household, subject, exact document resource, purpose, action, data category, recipient, expiry, and revocation at selection time. The same check runs immediately before a model provider call to close the revocation race. Denied pages never enter source input or logs.

Document collection consent and model-processing consent remain distinct. Existing broad case consent does not silently authorise every document for a model.

### Privacy-safe evidence gate

Insert a deterministic gate between authorised OCR source selection and all AI request builders:

1. Accept only registry-requested parameters and authorised source pages.
2. Classify evidence as PUBLIC, INTERNAL, CONFIDENTIAL, or RESTRICTED.
3. Remove or tokenise direct identifiers that are not required for the parameter.
4. Deny RESTRICTED data and parameters whose registry entry disallows model extraction.
5. Bound page excerpts, source count, and byte size.
6. Return typed safe evidence, redaction reason codes, source digests, and permitted citations.
7. Audit digests, counts, registry version, and decisions only. Do not audit raw text.

The model may propose `extracted_unverified`, `unknown`, or `conflicting`. Deterministic code or an authorised reviewer promotes evidence to higher-authority states.

### Data and migration

Use expand-only tables for registry-version pins and parameter records, with check constraints and foreign keys. Do not rewrite old evidence. Backfill only explicit `unknown` records for runs created under the new workflow version. Rollback disables the new workflow version and leaves new tables unused.

### AI design record

- Business benefit: reduce missed clauses and make every evidence gap visible.
- Baseline: manual review plus generic OCR text; completion and privacy cannot be measured per canonical parameter.
- Improvement hypothesis: complete registry coverage with fewer manual searches and zero prohibited model inputs.
- Harm if wrong: privacy disclosure or an incorrect coverage conclusion. Therefore AI has extraction-only authority.
- Allowed sources: currently consented, authorised, clean, protected policy documents after the privacy gate.
- Tenant boundary: household and subject enforced before source retrieval and model dispatch.
- Provider/model: existing configured Google Gemini adapter and pinned environment version. No provider change.
- Prompt owner/version: existing versioned prompt module; requests are generated only from safe typed evidence.
- Structured output: existing exact schemas extended with registry keys and unverified state validation.
- Tools: no external write tool and no irreversible action.
- Fallback: deterministic unknown/not-permitted states and human review.
- Evaluation: synthetic and redacted fixtures for normal, missing, conflicting, malicious, revoked, expired, mixed-consent, and identifier-heavy documents.
- Budget and latency: existing hard request, token, timeout, concurrency, and spend limits.
- Traces: metadata and digests only; no raw document text or identifiers.
- Kill switch: disable live model execution and retain deterministic registry/status output.
- Rollout: fixture tests, local migration, live-mode negative tests with stub transport, then gated preview.
- Rollback: disable the new workflow version, stop model dispatch, and retain append-only records for audit.

AI DESIGN = VERIFIED

### Capability decisions

| Need | Existing alternative | Decision | Verification |
|---|---|---|---|
| Canonical registry | Plain JavaScript data modules and validators | REQUIRED, no dependency | Registry validation tests |
| Persistent parameter status | Existing SQLite migrations/repositories | REQUIRED, no dependency | Migration and repository tests |
| Privacy gate | Deterministic local transformation | REQUIRED, no service | Leak and denial tests |
| Document consent | Existing consent repository and schema | EXTEND | Mixed, expired, and revoked tests |
| Redis/Kafka/microservices | No measured need | NOT_APPLICABLE | Architecture boundary check |

## T: Implementation handoff

### Agent assignments and file ownership

Use the lightest available model within the repository ceiling. Luna is unavailable.

| Role | Scope and ownership | Model / effort | Required result |
|---|---|---|---|
| Central integration | contracts, workflow version, integration, docs | GPT-5.6 Sol / high | coherent merged design and final evidence |
| Data/backend | new migration, parameter repository, source query | GPT-5.6 Terra / medium | constraints, access checks, migration tests |
| AI/privacy | privacy gate, live request boundary, schemas | GPT-5.6 Sol / high | no raw restricted input, schema tests |
| Runtime/domain | registry, state machine, source input, decomposition | GPT-5.6 Terra / medium | full registry coverage and state tests |
| Independent review | security, consent race, privacy leakage | GPT-5.6 Sol / high | material-defect review and rerun evidence |

No two specialists edit the same file concurrently. The central agent sequences shared exports and workflow contracts after specialist handoffs.

CERT dispatch used: requirements/CERT agent; graph and affected modules above; GPT-5.6 Sol low as the available fallback for unavailable GPT-5.6 Luna; read-only inspection plus handoff documents; low latency and no new capability cost; verification gate listed below.

### Expected implementation order

1. Add registry and state contracts with pure validation tests.
2. Add expand-only persistence and migration tests.
3. Enforce exact document consent in source selection and pre-dispatch checks.
4. Add the privacy-safe evidence gate and negative fixtures.
5. Replace generic OCR evidence input with registry-scoped candidate observations.
6. Update workflow and schema versions, keeping fixture/live modes explicit.
7. Integrate parameter records into deterministic review and release.
8. Run independent security/privacy review, then full verification.

### Planned affected files

- `src/features/coverage-analysis/policy-decomposition.js`
- `src/features/coverage-analysis/source-input.js`
- `src/features/coverage-analysis/task-registry.js`
- `src/features/coverage-analysis/workflow-definition.js`
- New registry and parameter-status modules under `src/features/coverage-analysis/`
- `src/backend/services/coverage-analysis-port.js`
- `src/backend/repositories/consent-repository.js`
- New parameter repository under `src/backend/repositories/`
- New expand-only migration under `src/backend/database/migrations/`
- `src/features/ai-analysis/live-coverage-runtime.js`
- `src/features/ai-analysis/schemas.js`
- Targeted tests for runtime, OCR, database, backend API, and live AI

### Verification evidence before implementation

- `node --version`: `v24.19.0`
- `pnpm --version`: `11.25.0`
- `pnpm run check:architecture`: passed for 101 source files
- Targeted readiness suite: 54 tests passed, 0 failed
- No network provider call or real personal data was used

### Final verification plan

```text
npm run check:architecture
node --test <new and affected targeted tests>
npm test
npm run build
```

Also inspect model-request fixtures and persisted/audit output for prohibited identifiers. Run a revocation race test at source selection and immediately before provider dispatch.

### Rollout and rollback

Roll out as a new workflow and registry version behind live-model permission. Existing runs keep their pinned workflow. If any consent, privacy, migration, or source-linking check fails, disable the new workflow version and live model path. The old workflow remains available. New tables are append-only and are not dropped during operational rollback.

### Risks and open decisions

- The exact production identifier taxonomy and legal basis require privacy/legal review before production data.
- Registry applicability rules must avoid creating false gaps for irrelevant parameters.
- Consent scope migration must not broaden existing grants.
- Redaction must preserve clause meaning while removing identifiers.
- A revocation between source read and provider dispatch must fail closed.
- `docs/CERT.md` and `docs/agent-tooling.md` should be restored, but their absence does not block this task because the complete mandatory process is present in both root instruction files.

CERT = READY
