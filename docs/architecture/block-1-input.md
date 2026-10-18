# Block 1: Input

Status: maps the owner's Block 1 target architecture (`.claude/prompts/block-1-target-architecture.md`, untracked, owner-held, a proposal and not a source of truth) onto the repository. "This slice" means branch `claude/block1-input`. Anything not in this slice is a proposal or planned. Where the proposal conflicts with `AGENTS.md`, ADRs or code, those win. No capacity numbers exist. User-facing consent and privacy wording is pending legal review. Companion: [pipeline-blocks.md](pipeline-blocks.md), [ADR 0005](../adr/0005-document-intake-validation-and-scanning.md).

The proposal's technology list (FastAPI, Celery, Redis, S3 or R2, Supabase or Clerk, React, TypeScript, Zod, TanStack Query, Uppy, qpdf, PyMuPDF) is not approved. The proposal itself says not to rewrite a working Node backend.

## The ten boxes

| # | Box | Repository mapping | Status |
|---|---|---|---|
| 1 | User input | Tables `households`, `adult_users`, `household_members`, `consent_grants`, `service_cases`. Upload panel in `src/ui/`. | Implemented in this slice (panel). |
| 2 | Client validation | Plain JavaScript checks in the upload panel (type, size, name). The server re-checks everything. | Implemented in this slice. No Zod, React or Uppy. |
| 3 | AuthN and AuthZ | `api_sessions`, household ownership in `tenant-access-service.js`, per-adult consent. The uploader comes from the session. | Implemented. A managed identity provider is Phase 2. |
| 4 | Upload orchestration | Bytes go through the API (Architecture A) into the byte-storage port. One request per file. No signed URLs, no `upload_sessions`. | Implemented as a temporary decision. Signed-URL direct upload is planned. |
| 5 | Object storage | AES-256-GCM local store (document id as AAD) under `DOCUMENT_STORAGE_PATH`, key from `DOCUMENT_ENCRYPTION_KEY_BASE64`. Quarantine is a database state, not a bucket. | Implemented locally. Azure Blob is planned, owner decision open. |
| 6 | Server validation | Filename sanitizing, magic bytes, MIME and extension agreement, 15 MiB cap while streaming, SHA-256, duplicate detection, `pdf-inspection.js`, ClamAV via `clamd-scanner.js` and `scan-worker.js`. | Implemented in this slice. Sandbox is planned. |
| 7 | Document registration | `document_uploads` (id, household, case, uploader, consent grant, kind, filename, storage path, SHA-256, MIME, size, malware, lifecycle, logical document id, source version), `audit_events`, `idempotency_keys`. | Implemented. `insurance_products`, `policy_documents` and `upload_sessions` are planned. |
| 8 | Classification and routing | Only the user-supplied `X-Document-Kind` (`policy_wording`, `policy_schedule`, `endorsement`). | Minimal. Rules-first classification is planned. Model output would be `extracted_unverified` and never sets a trusted type. |
| 9 | Async processing | The `document_uploads` row is the durable queue. `scan-worker.js` rescans pending rows after restart. | Implemented for scanning only. Classification and OCR jobs are planned (milestone 3). |
| 10 | Parsing handoff | `OcrRepository.getReadyDocument` and `knowvia.ocr.v1`. No second handoff schema. | The activation condition is implemented. The live handoff is milestone 4. |

## The four milestones

| Milestone | Proposal scope | Status |
|---|---|---|
| 1 Trustworthy upload | Boxes 1-5 and basic 7. Done when five PDFs survive a refresh, in the right household, and another user cannot see them. | Implemented in this slice (upload route, list routes, UI panel). |
| 2 Secure acceptance | Box 6 and rest of 7. Server checks, structure inspection, malware scan, quarantine to trusted. | Mostly implemented in this slice. Gaps: process sandbox (2b), single-document user deletion. |
| 3 Independent processing | Boxes 8-9. Queue, worker, classification, retries, stuck-job recovery. | Planned. The existing task queue (`workflow_tasks`, leases) is the intended base. S3.2 adds `SKIP LOCKED`. |
| 4 Parsing interface | Box 10. Versioned handoff, job identity, structured errors. | Planned. Uses `knowvia.ocr.v1`. |

## What this slice implements

- `POST /api/v1/cases/{caseId}/documents`. Raw `application/pdf` body. Headers: `Idempotency-Key`, `X-Document-Kind` (`policy_wording`, `policy_schedule` or `endorsement`), `X-Consent-Grant-Id`, `X-Filename`. No personal data in the URL.
- The uploader comes from the session. The case household is checked. The uploader needs a current `document_processing` consent with the collect scope.
- The 15 MiB cap is enforced while streaming. Magic bytes, MIME and extension must agree.
- `pdf-inspection.js` (bounded, pure Node) rejects encrypted PDFs (`PDF_PASSWORD_REQUIRED`), active content (`/JavaScript`, `/JS`, `/Launch`, embedded files, XFA, RichMedia and similar), more than 500 pages, and deflate bombs in object streams.
- Bytes are stored AES-256-GCM encrypted. The row, audit event and idempotency record are written in one transaction. The new document is `quarantined` with malware status `pending`.
- `GET /api/v1/cases/{caseId}/documents` and `GET /api/v1/documents/{id}` return user-facing statuses: `received_pending_checks`, `accepted`, `rejected`, `deletion_pending`, `deleted`. The UI never says "processed" after upload.
- `clamd-scanner.js` speaks clamd INSTREAM over TCP. `scan-worker.js` retries. `DOCUMENT_SCAN_MODE` is `clamd` or `disabled`. The default is `disabled`: documents stay quarantined (fail closed).
- Clean result: document becomes `active`. This is the Block 2 handoff condition. Malware found: bytes are removed and the document is deleted.
- Upload panel with client validation in `src/ui/`.

## Decided against for now

| Item | Reason |
|---|---|
| Signed-URL direct upload and object storage | None exists. Architecture A sits behind the byte-storage port, so storage can change later without changing routes. Azure Blob is the likely target. |
| Redis, Celery, BullMQ | The database row is the durable queue. S3.2 adds `SKIP LOCKED`. A second queue needs measured need and an ADR. |
| FastAPI or React rewrite | The Node backend works. A rewrite is not justified. |
| Password intake for encrypted PDFs | Passwords must never be accepted, stored or logged. Encrypted PDFs are rejected. |
| Model-based classification | Model output cannot set a trusted type (ADR 0003). |
| 25 MB and 10 files per batch | Code enforces 15 MiB. Batch is several single-file requests. The owner may change the limit. |

## Gaps and planned work

- PDF inspection in a separate restricted process (milestone 2b).
- A single-document user deletion route. Today deletion happens through consent revocation (which marks `deletion_requested`) and malware removal.
- `insurance_products`, `policy_documents` and `upload_sessions` tables, and automatic policy linking.
- `employer_benefit_booklet` is in `DOCUMENT_KINDS` but not in the `document_uploads.document_kind` CHECK. Adding it needs a table rebuild migration on both engines. Deferred. The route does not accept it.
- Classification beyond the user-supplied kind.
- Azure Blob with Defender for Storage as an option, and Key Vault with managed identity for the encryption key.
- Image uploads (JPEG, PNG). The route is PDF only.

## Lifecycle mapping

The existing states are kept. The target states map as follows.

| Target state | Repository state |
|---|---|
| INITIATED, UPLOADING | No equivalent. The upload is one request. |
| UPLOADED, VALIDATING | `lifecycle_state = quarantined`, `malware_status = pending` |
| REJECTED | Not stored (rejected before storage), or `malware_status = blocked` |
| PASSWORD_REQUIRED | Upload rejected with `PDF_PASSWORD_REQUIRED`. Nothing stored. |
| VALIDATED, READY_FOR_PARSING | `lifecycle_state = active`, `malware_status = clean`, encrypted local storage. Reachable only after a real scan. |
| PARSED | OCR job complete and `source_pages` written by Block 2. Not part of Block 1. |
| DELETION_PENDING | `lifecycle_state = deletion_requested` |
| DELETED | `lifecycle_state = deleted` |

User-facing status: `received_pending_checks` (quarantined, pending), `accepted` (active, clean), `rejected`, `deletion_pending`, `deleted`.

## Reliability scenarios (proposal section 17)

"Covered" means a test exists in this slice. The test names are in the slice's test files; this document does not repeat counts. Scenarios marked not covered are either out of scope or untested.

| Scenario | Covered here? |
|---|---|
| Same PDF uploaded twice | Yes: idempotent replay, `IDEMPOTENCY_CONFLICT`, `DUPLICATE_DOCUMENT` |
| Someone else's policy or guessed document id | Yes: same not-found response as a missing id, cross-household read denied |
| Over size limit | Yes: cap enforced while streaming |
| Malware | Yes: scanner and worker with a fake clamd. A real clamd is not tested. |
| Password required | Yes: `PDF_PASSWORD_REQUIRED` |
| Corrupt PDF | Yes for bad magic bytes and malformed structure within the bounded inspection |
| 300-page file | Not covered. The limit is 500 pages; over-limit is covered. |
| Two users, identical files | Yes: stored separately with separate ownership |
| Deletion during processing, consent revocation | Yes: revocation marks the upload `deletion_requested` |
| Browser refresh | Yes: list after a fresh request |
| Storage failing, database transaction failure | Yes: bytes removed when the insert fails, no row when storage fails |
| Worker crash, same job runs twice | Partly: the row stays pending and is rescanned. Counters are in memory. |
| Internet drops mid-upload | Not covered. A partial body is rejected, but no network-fault test exists. |
| No extractable text | Not applicable until Block 2. |
| Queue unavailable | Not applicable. The database is the queue. |
| Expired signed URL | Not applicable. No signed URLs. |

## Block 1 to Block 2 contract

| Item | Contract |
|---|---|
| Entry point | `OcrRepository.getReadyDocument(documentId, at)` in `src/backend/repositories/ocr-repository.js` |
| Version | `knowvia.ocr.v1` (`src/modules/document-intake/ocr-contracts.js`) |
| Document state | `lifecycle_state = active` |
| Scan state | `malware_status = clean` (set only by a real scan) |
| Storage | Encrypted local store, AES-256-GCM, document id as AAD |
| Consent | Current `document_processing` consent for the document |
| Failure | `DOCUMENT_NOT_OCR_READY` for any other state, including quarantined and pending |
| Output | Immutable `source_pages` with `output_contract_version = 'knowvia.ocr.v1'` |

## Open ADRs and owner decisions

| Decision | State |
|---|---|
| Malware scanner | Decided: ClamAV clamd ([ADR 0005](../adr/0005-document-intake-validation-and-scanning.md)). Azure container is open. |
| Upload size | Decided: 15 MiB. Owner may revisit. Batch limits: no batch endpoint. |
| Object storage provider and direct upload | Open. Azure Blob is likely. Needs an ADR. |
| PDF inspection library and sandbox | Open. In-process bounded inspection is the interim. |
| Password-protected PDFs | Decided: reject. |
| Identity provider | Open. Phase 2. |
| Separate queue | Rejected unless measured. |
| Azure staging `DOCUMENT_SCAN_MODE=structural_only` | Not read by the code. Align or remove (see ADR 0005). |
| Retention for expired (not revoked) consent | Open. Owner decision F3 in `docs/iterations/LATEST.md`. |
