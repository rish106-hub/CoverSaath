# Security, privacy and consent model

Status: describes controls present in the repository at the commit that added this file; it is not a certification. Vulnerability disclosure: [SECURITY.md](../../SECURITY.md). Companion documents: [system.md](system.md), [data.md](data.md).

## Assets

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Insurance documents and OCR page text | `document_uploads`, `source_pages` (bytes in the encrypted store, written only by the authenticated upload route) | RESTRICTED: personal and medical content |
| Household identity: names, dates of birth, contact details | `adult_users`, `household_members` | Personal data |
| Consent grants, scopes, revocations | `consent_*` | Authority for every disclosure |
| Derived data: excerpts in run input, task outputs, parameter observations, document-sourced evidence facts | `workflow_runs`, `workflow_tasks`, `coverage_parameter_observations`, `evidence_facts` | Derived from consented documents; erased on revocation |
| Session tokens, bootstrap token | token digests in `api_sessions`; bootstrap token in server environment | Credentials |
| Provider keys, document encryption key | `.env.local` (git-ignored), server environment | Credentials; never `VITE_` variables |
| Audit events | `audit_events` | Integrity |

## Trust boundaries and entry points

- Browser to API: only `127.0.0.1:8787`, directly or through the Vite proxy on `127.0.0.1:5173`. Every `/api/v1` route except `/health`, `/live`, `/ready` and household bootstrap requires a bearer session. `/ready` returns only `{ status, checks }` (booleans) unless the caller is loopback (see below).
- API to database: in-process SQLite; no database network surface. PostgreSQL is test-only until S3.2.
- API to model provider: Google Gemini only, through the model gateway. This is the one outbound path with household-derived content.
- Integrations (Sarvam, Gnani, Pine Labs, email): no network call is implemented.
- OCR text, documents and model output: untrusted evidence, never instructions (`AGENTS.md`, `src/modules/ai-analysis/prompts.js:7`). The model has no tools (`ai-sdk-runner.js`, `tools: {}`).
- Document upload: `POST /api/v1/cases/{caseId}/documents` (raw `application/pdf`, ADR 0005). Uploaded PDFs are untrusted input until inspected and scanned.
- Not present: public hosting, webhook receiver, admin UI, outbound email.

## Implemented controls

| Control | Where |
|---|---|
| Loopback only: server binds `127.0.0.1`; Host must be a local allowlisted value, Origin must be `localhost:5173`/`127.0.0.1:5173`, `Sec-Fetch-Site: cross-site` is rejected. No CORS headers are emitted. | `src/server/server.js:7`, `src/shared/http/security.js:6`, `create-server.js:64` |
| Readiness detail is loopback only: `GET /api/v1/ready` returns the schema validation result (`database`) and `externalProviderCalls` only when the TCP peer is a loopback address, no proxy forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `X-Client-IP`, `X-Original-Host`) is present and `assertLocalRequest` passes; Host or Origin headers alone never qualify. A proxy that strips all forwarding headers and rewrites Host would defeat this, so a public deployment must keep forwarding headers. Everyone else gets `{ status, checks }` with booleans. Abuse test: `tests/ready-detail.test.mjs`. | `src/shared/http/security.js` `isLoopbackRequest`, `v1-backend-routes.js:175` |
| Rate limit per client address (default 600 per minute, max 100,000), session cap, case cap, per-case active-run cap, 16 KiB JSON body cap | `security.js:14`, `config.js`, `request.js:3`, `v1-backend-routes.js:104` |
| Security headers on every JSON response: `no-store`, `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, restrictive CSP and Permissions-Policy | `src/shared/http/request.js:19` |
| Bearer sessions: 32 random bytes, only the sha256 digest stored, expiry and revocation checked, capped session count | `auth-repository.js:13-47` |
| Bootstrap token (`KNOWVIA_BOOTSTRAP_TOKEN`, 32-256 chars) creates the first household; constant-time comparison; readiness fails if unset | `tenant-access-service.js:19-37`, `v1-backend-routes.js:148` |
| Tenant access: every case, run and task read joins to its household and requires an active role; write routes require a writing role; non-members get 404 | `tenant-access-service.js:45-74`, `household-repository.js` `requireAccess` |
| Field-level read consent: case, source pack, audit and analysis reads need a subject-granted `read` scope for the viewer and purpose; DTOs are redacted (no payloads, hashes, leases, actor ids) | `read-response-policy.js:1-30`, `consent-repository.js:93-129` |
| Consent derivation: analysis subject is derived once in SQL (`analysis_subject_adult_id`); a foreign or missing subject matches no consent | `coverage-analysis-port.js:20-41` |
| Model disclosure consent: a page is eligible only if its document is active, clean, encrypted, OCR-succeeded and covered by a current `document_processing` grant from the subject with scope `document`, action `derive`, category `insurance_document` and recipient exactly `google-gemini`. A NULL recipient never matches. | `coverage-analysis-port.js:51-85`, `privacy-evidence-gate.js:14` |
| Pre-dispatch validator, wired by default and not replaceable through the server: re-checks run, subject, grant and every source immediately before each provider call; any internal error denies | `coverage-analysis-port.js:138-195`, `create-server.js:31`, `live-coverage-runtime.js:307-340` |
| Commit-time re-check: after a call returns, consent and all sources are re-checked; on change results are discarded, the run stops and derived data is erased in one transaction | `persistent-service.js:129-143`, `coverage-analysis-port.js:446-480` |
| Privacy evidence gate (`knowvia-privacy-evidence-v3`): normalisation, per-request placeholders such as `<PHONE_1>`, redaction of the household's own known names, dates of birth, phones and emails (loaded per call, never persisted), rejection of RESTRICTED data and payment cards, limits of 30 sources, 4,000 bytes per source, 48,000 bytes total, 16,000-byte scan cap, 240 structured items | `privacy-evidence-gate.js:9-32,336-348`, `coverage-analysis-port.js:236` |
| Model authority limits: five model tasks, all `propose`; model output maps only to Unknown or Conflicting and to unknown, extracted_unverified or conflicting; never proven, calculated, dynamic or release; the database enforces the same rules by trigger (migration 005) | `src/contracts/ai-authority.js`, `docs/adr/0003-ai-authority.md`, `005_evidence_completion_parameters.sql:250-326` |
| Output safety: schema validation, unsupported-certainty and approval language rejected, citations must match an authorised opaque source id | `schemas.js:37-90`, `tests/model-boundary-safety.test.mjs` |
| Cost and abuse bounds on model calls: per-run and process-lifetime project budget, per-call reservation, 30 s default timeout (max 60 s), no retries, concurrency cap; a refused call releases its reservation | `live-coverage-runtime.js:33-60`, `model-gateway.js:6,74-115` |
| Error redaction: only UPPER_SNAKE application codes carry their message; driver, Node `ERR_*` and uncoded errors return `BACKEND_REQUEST_FAILED` with a generic message | `errorResponse`, `v1-backend-routes.js:69-87` |
| Fail-closed integrations: keys alone yield `configured_not_verified`; every action throws without verified transport and authorization | `src/integrations/shared/provider-boundary.js`, `src/integrations/AGENTS.md` |
| Encrypted document storage: AES-256-GCM, 32-byte key, document id as AAD, tag failure raises `STORAGE_TAMPERED`; filename sanitising, signature/MIME/extension agreement, 15 MiB cap | `encrypted-local-storage.js`, `file-validation.js`, `contracts.js` |
| Upload authorization: session-derived uploader; case household check before any body byte is read; current `document_processing` grant from the uploader with document `collect` scope in the case household; foreign document ids answer exactly like missing ones; list and status reads require the source-pack field grant. The UI asks for this grant with an explicit action (document `collect` plus case `source_pack_metadata` read for the uploader only) and never reuses the coverage grant; its wording is draft pending legal review | `v1-backend-routes.js` (documents routes), `document-upload-service.js`, `workspace-controller.js` (`grantDocumentConsent`) |
| Upload validation before storage: 415 for any type but `application/pdf`; declared length and streamed bytes capped at 15 MiB; magic bytes, MIME and extension agreement; bounded PDF inspection rejects encrypted PDFs, JavaScript, Launch, embedded files, XFA, RichMedia, over 500 pages and deflate bombs in object streams; per-case and per-household pending caps (429) | `shared/http/request.js` (`readBinaryBody`), `pdf-inspection.js`, `document-upload-service.js` |
| Upload integrity: row, counts-only audit event and idempotency record in one transaction; same key and bytes replay, changed bytes 409; bytes removed if the insert fails; storage keys must be 64 hex characters before any filesystem access | `document-repository.js`, `document-intake-service.js`, `encrypted-local-storage.js` |
| Quarantine and malware scanning: uploads stay `quarantined`/`pending` until a ClamAV clamd scan marks them clean; `DOCUMENT_SCAN_MODE` defaults to `disabled` (nothing activates); infected or tampered bytes are deleted and the document is `rejected`; guarded transitions never resurrect a rejected or deleted document; the worker also deletes bytes of documents whose deletion was requested (revocation) | `clamd-scanner.js`, `scan-worker.js`, `document-repository.js`, ADR 0005 |
| Database invariants: household cross-references, consent-required outbox, append-only audit and observations, immutable provenance (with one redaction update) and registry pins | migrations 001-009; `criticalTriggers` in `database.js:77` |
| Database schema hardening: append-only and immutable facts, pins and audit relations reject deletion; PostgreSQL also rejects `TRUNCATE`, fixes project function `search_path`, validates compatible `C` ordering and redacts migration driver detail | SQLite migration 007; PostgreSQL migrations 002-003; `postgres/validate-schema.js`; `postgres/migrate.js` |
| Revocation erasure | [data.md](data.md#erasure-and-revocation) |
| CI security: required `CI / verify` (check, tests, build, safety eval), CodeQL (push, PR, weekly), dependency review failing on high, Dependabot weekly, actions pinned by commit SHA, read-only token, no secrets | `.github/workflows/*.yml`, `.github/dependabot.yml` |

## Threats, controls and tests

| Threat | Control | Test |
|---|---|---|
| Cross-household read or write | Tenant access service; 404 for non-members | `tests/backend-api.test.mjs` |
| Unauthenticated or wrong-purpose read | Bearer session plus field-level consent | `tests/backend-api.test.mjs` |
| Disclosure after revocation or expiry | Source selection, pre-dispatch check, commit re-check | `tests/pre-dispatch-consent.test.mjs`, `tests/coverage-source-consent.test.mjs`, `tests/analysis-subject-consent.test.mjs` |
| Revoked data lingering in derived stores | Revocation transaction and erasure | `tests/backend-persistence.test.mjs`, `tests/mvp-closeout.test.mjs`, `tests/round3-runtime-integration.test.mjs`, `tests/round4-runtime.test.mjs`, `tests/evidence-fact-redaction.test.mjs` |
| Identifiers or restricted text reaching the model | Privacy gate and known-value redaction | `tests/privacy-evidence-gate.test.mjs`, `tests/privacy-gate-r2.test.mjs`, `tests/privacy-gate-r4.test.mjs`, `tests/known-identifier-e2e.test.mjs`, `tests/model-boundary-safety.test.mjs`, `tests/review3-fixes.test.mjs` |
| Prompt injection in OCR text | Untrusted evidence, schema, citation and certainty checks | `tests/model-boundary-safety.test.mjs`, `tests/certainty-filter.test.mjs` |
| Model output treated as authority | Authority matrix, DB triggers | `tests/p1a-ai-authority.test.mjs`, `tests/coverage-parameter-authority.test.mjs` |
| Internal error detail leaks | `errorResponse` | `tests/p1-error-redaction.test.mjs` |
| Request flood | Rate limiter and capacity caps | `tests/http-security.test.mjs` (limiter), `tests/server-config.test.mjs` |
| Spend exhaustion by repeated denials | Reservation release | `tests/review3-fixes.test.mjs` (R3-1) |
| Tampered or malformed stored document | AEAD, validation | `tests/document-intake.test.mjs` |
| Unsafe, oversized or foreign uploads | Upload validation, inspection, authorization, quarantine | `tests/document-upload-api.test.mjs`, `tests/pdf-inspection.test.mjs`, `tests/clamd-scanner.test.mjs`, `tests/clamd-integration.test.mjs` (opt-in, real clamd), `tests/scan-worker.test.mjs` |
| Provider call without verified contract | Fail-closed boundary | `tests/integrations.test.mjs` |
| Audit rewrite | Append-only triggers | `tests/database-schema.test.mjs` |
| Duplicate or replayed run request | Idempotency key and digest | `tests/p1a-analysis-run-api.test.mjs`, `tests/p1a-execution-policy.test.mjs` |
| DNS rebinding, foreign Origin, cross-site browser call | Host/Origin/Sec-Fetch-Site checks | `tests/local-request-guard.test.mjs` |

## Known gaps

- No identity provider or MFA. Bootstrap token plus self-issued bearer sessions only (`README.md`).
- PDF inspection runs in the API process, not a sandbox; it is bounded and dependency-free but is still parsing untrusted bytes in a process that can reach the database (ADR 0005).
- Malware scanning was exercised against a real local clamd (ClamAV 1.5.4, runbook settings) by the opt-in `tests/clamd-integration.test.mjs` and one manual upload run. ClamAV's EICAR signature matches only at offset 0, so the blocked path cannot be driven end to end through the PDF upload route; it is covered at scanner level (real clamd) and through the API with a fake clamd. With `DOCUMENT_SCAN_MODE=disabled` no upload ever reaches OCR.
- No user-facing single-document delete route; deletion happens through consent revocation or a malware hit.
- The PDF inspection is a bounded heuristic, not a full parser; malware scanning is the required second layer. clamd must use the settings in [the ClamAV runbook](../runbooks/clamav.md) or over-limit files are reported clean.
- Upload capacity counts and inserts are not atomic, so the per-case and per-household caps can be exceeded slightly under concurrency.
- The OCR service is still not wired to a route.
- No observability: no structured logs, metrics, tracing or alerting; no incident process. Audit events are written but the hash chain is never verified.
- No dedicated least-privilege PostgreSQL runtime role exists yet. PostgreSQL remains test-only until S3.2.
- No managed secrets or KMS; keys come from environment variables.
- Provider keys are server-side, but no live provider call has been exercised (`README.md`).
- Process-lifetime state: the project model budget and the rate limiter reset on restart.
- Consent expiry does not erase derived data; retention policy is an owner decision (review F3, `docs/iterations/LATEST.md`).
- `docs/evidence/` remains in git history until the owner decides to purge it (`docs/exec-plans/completed/p0-baseline-intake.md`).
- Conflict detection reads at most 500 observations per parameter (`docs/iterations/LATEST.md`).
- Over-redaction and known-name limits of the gate are listed in `docs/iterations/LATEST.md` under accepted risks.
- Not decided: who approves legal and privacy review, data residency, and the named security owner. The intake lists these as open owner decisions.
