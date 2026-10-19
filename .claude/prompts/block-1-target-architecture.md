<!--
Status: OWNER PROPOSAL (target architecture), received 2026-10-18. Not implemented. Not a source of truth.
Where it conflicts with AGENTS.md, ADRs or the code, AGENTS.md and the code win; see the
<target_architecture_reconciliation> section of block-1-input-slice.xml for the mapping and conflicts.
Technology recommendations below (FastAPI, Celery, Redis, S3/R2, Supabase/Clerk, Sentry, ClamAV, qpdf,
PyMuPDF, React/TypeScript, Zod, TanStack Query, Uppy) are NOT approved dependencies.
-->

# Knowvia / CoverSaath: Block 1
## Complete Input & Document Ingestion Architecture

**Objective:** Build an input system that can accept multiple insurance documents, securely store them, validate their contents, identify what each document represents, and prepare them for the insurance parsing engine.

Designed from two perspectives:

1. **Software engineering:** Architecture, APIs, databases, storage, queues, workers, security, scalability, reliability, and performance.
2. **Insurance intelligence:** How the product understands which documents belong to which people, policies, insurers, and insurance products.

Goal: something that works for the MVP without forcing a rebuild of the input infrastructure when the product grows.

**Important distinction:** This is the target architecture, not a claim that these components already exist in the repository.

---

## 1. What the input system does

Example household with four documents: father's individual health policy, mother's health policy, the user's corporate group health policy, and a family floater covering multiple members. The input system must establish:

- Who uploaded the documents?
- Which household do they belong to?
- Who is insured under each policy?
- Which documents describe the same policy?
- Is this a policy wording, policy schedule, endorsement, or something else?
- Is the document complete, readable, and authentic enough to process?
- Can we safely extract its information?
- Which version of the document is being processed?
- Where is the original document stored?
- What happens if processing fails?

These are responsibilities of the input system, not the final decision engine.

### The 10 logical boxes

```text
1. USER INPUT                  PDFs | Household | Members | Context
2. CLIENT VALIDATION           File Type | File Size | User Feedback
3. AUTHENTICATION & AUTHZ      Identity | Ownership | Access Control
4. UPLOAD ORCHESTRATION        API | Upload Session | Signed URL
5. OBJECT STORAGE              Original PDFs | Encrypted Storage
6. SERVER-SIDE FILE VALIDATION File Integrity | Malware | PDF Checks
7. DOCUMENT REGISTRATION       Metadata | Document ID | Ownership
8. CLASSIFICATION & ROUTING    Policy Type | Document Type | Priority
9. ASYNCHRONOUS PROCESSING     Queue | Workers | Retries | Status
10. PARSING HANDOFF            Validated PDF + Metadata + Job ID
        -> BLOCK 2: PARSING ENGINE
```

This is the logical sequence, not necessarily 10 independent services. Some operations run in parallel; metadata records are created before upload and updated throughout processing.

**The input layer is complete when a document is securely stored, validated, registered, associated with the correct account, and ready for parsing.** It does not need to understand insurance clauses; that is Block 2.

---

## 2. Box 1: User Input

Purpose: collect documents and the minimum information to associate them with the right user and household. Primarily a frontend and data-modelling problem.

### 2.1 Input categories

| Input category | What it contains | Required for MVP? |
|---|---|---|
| Insurance documents | Policy PDFs, schedules, endorsements | Yes |
| User identity | User ID and authenticated session | Yes |
| Household | Grouping of family members and their policies | Yes |
| Member details | Name, relationship, approximate age where needed | Basic version |
| Insurance context | Corporate, individual, or family coverage | Optional |
| User question | What the user wants to know | Can be collected later |
| Document password | Password for an encrypted PDF | Support safely |
| Consent | Permission to process submitted information | Yes |
| External information | Insurer websites, official policy wordings | Later |

### 2.2 Insurance documents are not all the same

| Document | Meaning |
|---|---|
| Policy wording | General rules governing an insurance product |
| Policy schedule | Specific insured members, dates, limits, and chosen benefits |
| Certificate of insurance | Evidence of coverage, often relevant to group insurance |
| Endorsement | A subsequent change to policy conditions or coverage |
| Rider | An additional benefit or modification |
| Renewal notice | Information about renewing coverage |
| Group insurance booklet | Employer-provided coverage terms |
| Health card | Identification and administrative details |
| Claim document | Information about a particular claim |
| Hospital bill | Medical expenses being claimed |
| Discharge summary | Medical details of hospitalization |

Why it matters: the wording may say a product offers cover up to ₹10 lakh while the schedule says the selected sum insured is ₹5 lakh. The input system must preserve both documents and their relationship. MVP: support policy wording, policy schedules and endorsements first; add other categories when their use cases are ready.

### 2.3 Household-based architecture

```text
USER ACCOUNT -> HOUSEHOLD -> Members A, B, C -> INSURANCE POLICIES
  Policy 1: Policy Wording.pdf, Schedule.pdf, Endorsement.pdf
  Policy 2: Group Cover.pdf, Certificate.pdf
```

Conceptual only. In the database a policy can cover multiple members and a member can have multiple policies (many-to-many).

### 2.4 Frontend technology (proposed)

React, TypeScript, Vite, React Hook Form, Zod, TanStack Query, HTML File API, Web Crypto API, optional Uppy. Not all needed immediately. Preference: React + TypeScript + Vite with a simple custom upload component; Uppy only if requirements justify it.

### 2.5 Frontend acceptance criteria

The user can select several PDFs, see each filename and upload progress, remove a selected file, retry a failed upload, and identify the household the documents belong to. Three distinct states:

- **Uploaded:** the file reached storage.
- **Accepted:** server-side security and structural checks passed.
- **Ready:** the document was registered and queued for parsing.

Never show "Successfully processed" just because the browser finished uploading.

---

## 3. Box 2: Client-Side Validation

Purpose: catch obvious mistakes before wasting bandwidth.

| Check | What it does | Example |
|---|---|---|
| Extension validation | Checks filename extension | `.pdf` allowed |
| MIME check | Checks declared file type | `application/pdf` |
| File size limit | Prevents oversized uploads | Suggested MVP limit: 25 MB |
| File count limit | Controls batch size | Suggested MVP limit: 10 |
| Empty-file check | Detects zero-byte files | Reject |
| Duplicate selection | Detects repeated selections | Warn the user |
| Filename handling | Handles unsafe or unusual names | Display safely |
| Browser compatibility | Checks browser API support | Give a fallback |

Limits are proposed product defaults, revisable against real documents.

Concepts: MIME type; file signature / magic bytes; client vs server validation; checksum; SHA-256. A checksum checks integrity, a hash identifies identical files; neither proves a PDF is safe or authentic.

**Never trust client-side validation as the final security check.** Attackers can bypass the browser; declared MIME can be faked. OWASP recommends layered validation, safe filenames, access controls, storage isolation and malware inspection.

Scale: do not load whole PDFs into memory unnecessarily; do not Base64-encode uploads (size and CPU overhead); use binary uploads. Resumable multipart only for large files or unreliable connections (AWS suggests around 100 MB+).

**Build priority: P0**

---

## 4. Box 3: Authentication and Authorization

Authentication (who are you) vs authorization (what may you access). Concepts: AuthN, AuthZ, OAuth 2.0, OIDC, JWT, session, RBAC, ABAC, tenant isolation, least privilege, IDOR/BOLA. For the MVP a managed authentication provider is preferable to building identity.

Recommended access model: User -> verified household membership -> permission to upload -> permission to access this document. Store `household_id` and `uploaded_by_user_id` on document records. Later add roles (household owner, invited member). An adult member's documents may contain private medical and financial data; household membership alone must not grant unrestricted access. Document ownership, permission to process, and permission to share results are separate concerns.

**Critical rule:** never rely on a browser-sent `user_id` or `household_id` as proof of access. Derive identity from the authenticated session and verify household membership server-side.

**Build priority: P0**

---

## 5. Box 4: Upload Orchestration

Architecture A (through the application server): simple, but the server carries every byte. Architecture B (direct-to-storage with a presigned URL): recommended. The backend authorizes and issues a short-lived (about five minutes) URL for one operation on one object. A presigned URL is not single-use and can overwrite the same key while valid: use unique keys and control acceptance.

Proposed API:

1. `POST /api/v1/uploads/initiate` with household id, filename, content type, size, document type hint. Backend: authn/authz, quota, size/type checks, unique document id and storage key, `INITIATED` upload record, signed URL. Response: document_id, upload_id, upload_url, method PUT, expires_in_seconds 300.
2. Browser PUTs the binary PDF directly to storage.
3. `POST /api/v1/uploads/{upload_id}/complete`: verify the session belongs to the user, the object exists, its stored size is within limits, it can enter validation, and it was not already finalized. Verify stored properties (for S3, a HEAD request; signed checksums where appropriate) rather than trusting the browser.

**Build priority: P0**

---

## 6. Box 5: Object Storage

Object storage holds files; PostgreSQL holds metadata (document id, household id, original filename, storage key, status). Use unpredictable ids; no names, policy numbers or medical data in object keys.

Two zones: **quarantine** (new uploads, only a restricted validation service may read) and **trusted** (validated PDFs, readable by parsing workers). Separate buckets give a clearer boundary than prefixes. The original PDF stays unchanged; parsed text, OCR and normalized documents are stored separately.

Concepts: bucket, object, object key, metadata, ETag (not a universal hash), encryption at rest, TLS, versioning, lifecycle policy, signed GET and PUT URLs.

Provider options: AWS S3, Cloudflare R2, Google Cloud Storage, Supabase Storage. Prefer an S3-compatible interface so the app is not tied to one provider.

MVP: private storage, direct uploads, unique keys, quarantine before processing, server-side encryption, signed downloads, deletion and retention workflows. Later: granular key management, access auditing, lifecycle automation, versioning and recovery, cross-region recovery, cost monitoring.

**Build priority: P0 basic storage and isolation; P1 advanced storage management.**

---

## 7. Box 6: Server-Side File Validation

Pipeline: size -> type -> file signature -> malware scan -> PDF structure -> password/encryption -> resource limits -> integrity -> accept/reject. Order may vary; all must pass before trusted processing.

| Check | Technical approach | Failure behaviour |
|---|---|---|
| File size | Compare actual object size to limits | Reject |
| File type | MIME, extension and signature | Reject mismatch |
| File structure | Parse with a maintained library | Reject or flag |
| Malware | ClamAV or managed scanner | Quarantine |
| Encrypted PDF | qpdf or PDF library | Request password |
| Active content | Scripts, attachments, suspicious actions | Reject or sanitize under a defined policy |
| Page limit | Count pages safely | Reject or flag |
| Decompression risk | Limit memory, CPU, time, expanded data | Stop processing |
| Integrity | Compare checksums where available | Reject mismatch |
| Duplicate file | Compare verified fingerprints | Reuse or register safely |

Tools: qpdf (`--check` finds structural issues, does not prove safety), PyMuPDF, ClamAV, SHA-256, signature-based MIME detection.

Failure classes: **permanent** (not a PDF, over limits, prohibited, unusable: no auto-retry); **recoverable** (scanner down, storage timeout, worker crash: bounded retry); **user-action** (password, incomplete, cannot associate: ask the user).

Password-protected PDFs: encrypted PDF detected -> `PASSWORD_REQUIRED` -> user submits password securely -> worker decrypts -> validate -> continue. Never store passwords in ordinary columns, logs, analytics or queue payloads; use short-lived restricted secret storage if needed. For the first MVP it is reasonable to require an unlocked PDF with a clear error.

Isolation: do not parse arbitrary PDFs inside the privileged process that can reach the database. Run validation/conversion sandboxed: no unnecessary network, minimal filesystem, CPU and memory limits, timeouts, no admin DB credentials, no access to other households' documents.

**Build priority: P0 validation and resource limits; P1 stronger sandbox.**

---

## 8. Box 7: Document Registration and Metadata

Separate four concepts: **file** (binary in storage), **document** (logical insurance document), **policy** (a specific contract or coverage arrangement), **insurance product** (a general offering by an insurer). Two customers can own the same product with different policy conditions.

Target entities: `users`, `households`, `household_memberships`, `insured_persons`, `insurers`, `insurance_products`, `policies`, `policy_members`, `documents`, `document_files`, `policy_documents`, `upload_sessions`, `processing_jobs`, `audit_events`. Some reference tables can stay lightweight or nullable in the MVP.

Relational modelling is required: policies and members are many-to-many through junction tables.

Metadata per file: identity (document, upload, household ids); ownership (uploader, access scope); file properties (filename, MIME, size); storage (bucket, key, version); integrity (SHA-256, validation results); classification (type, possible insurer, classification source); lifecycle (created, uploaded, validated, rejected, deleted); processing (job id, attempts, parser version); provenance (source, upload time, claimed origin); audit.

Provenance: a user saying "this is from HDFC ERGO" is a claim, not verified truth.

Relationship lifecycle: file uploaded -> document registered -> classified -> policy information extracted -> possible policy match -> relationship verified -> document linked to policy. **Never guess relationships from a shared surname or insurer name.** Use reliable identifiers and evidence; ask the user when ambiguous.

PostgreSQL concepts: primary key, foreign key, index, constraint, transaction, ACID, migration, connection pooling, row-level security.

Priority: document identity, ownership, upload records, storage references and processing status first; enough household/policy modelling to avoid a rewrite; no comprehensive product master database in the first cycle.

**Build priority: P0 document records; P1 complete insurance relationship modelling.**

---

## 9. Box 8: Document Classification and Routing

Classification (what kind of document) differs from parsing (what exact information). Categories: policy documents (wording, schedule), coverage documents (card, certificate), claim documents (bill, summary), plus `UNKNOWN`, `MIXED`, `UNSUPPORTED`. One PDF can contain both wording and schedule.

Techniques: user label (first signal), filename heuristics (weak), metadata inspection, rule-based patterns, ML, LLM on limited safely extracted content, human confirmation. Recommendation: hybrid; user hints and deterministic rules first, AI only on limited content when needed. Do not send whole PDFs to an LLM to identify type.

Output example: document id, document type, classification method, confidence, requires_review, processing route. A model confidence is not a calibrated probability; validate thresholds on labelled examples.

Routing examples: searchable PDF -> native extraction; scanned PDF -> OCR; schedule -> member and benefit extraction; wording -> clause extraction; hospital bill -> billing extraction; unsupported -> user notification. OCR need may require a lightweight page inspection as the first parsing step.

**Build priority: P0 basic routing; P2 advanced AI classification.**

---

## 10. Box 9: Asynchronous Processing

Separate accepting a document from processing it. The API registers the document, returns an id, creates a background job; a worker processes it; status is updated; the user sees progress.

Components: queue (messages describing work), worker (process that executes jobs), broker (Redis-backed queues, RabbitMQ, SQS; a queue can also live in an existing database).

Options: Celery + Redis, BullMQ + Redis, SQS, RabbitMQ, Temporal, Kafka (unnecessary here). For a Node backend, BullMQ + Redis is the suggested alternative.

Job types: `VALIDATE_FILE -> SCAN_FILE -> INSPECT_DOCUMENT -> CLASSIFY_DOCUMENT -> PREPARE_FOR_PARSING`, initially in one worker application.

Concepts: concurrency vs parallelism, horizontal vs vertical scaling, CPU-bound (PDF rendering, OCR) vs I/O-bound (storage).

Retries with exponential backoff and jitter. Permanent failures are not retried.

**Idempotency:** repeating an operation must not create extra effects (e.g. a completion request arriving three times creates one document). Implement with unique document and upload ids, client idempotency keys, uniqueness constraints, atomic status transitions, logical job ids such as `doc_456:VALIDATE:v1`, and guards against committing a stage twice. Queues and storage events can redeliver or reorder.

**Transactional outbox:** write the pending job event in the same transaction as the document update; a publisher transfers it to the queue. A periodic reconciliation task is a simpler first option for recovering stuck documents.

**Dead letter queue:** after repeated failure, move the job aside for inspection or manual retry. MVP equivalent: a `FAILED` status and a retryable failed-job table.

**Build priority: P0 background jobs and retries; P1 durable recovery, outbox, DLQ.**

---

## 11. Box 10: Handoff to the Parsing Engine

The parser needs: document id, secure reference to the original file, owner or processing scope, file type and properties, validation status, integrity information, classification if available, processing version. It must not need to know the upload component, browser library or storage provider.

Example handoff: schema_version, document_id, household_id, storage {bucket, object_key}, file {mime_type, size_bytes, sha256}, validation {status, malware_scan, pdf_structure}, classification {document_type, requires_review}, processing {job_id, parser_version}. The queue message can carry only document id and processing version; the worker loads trusted metadata from the database, avoiding sensitive data in the queue.

| Input system guarantees | Parsing system responsibility |
|---|---|
| File exists in trusted storage | Extract text and tables |
| User and household access were checked | Interpret document content |
| File passed security validation | Identify policy details |
| File has a unique document ID | Produce structured insurance data |
| Original PDF has been preserved | Maintain page and clause references |
| Processing status can be tracked | Report extraction failures |
| Document type is known or marked unknown | Resolve or flag ambiguous content |

**This contract matters more than the programming language.**

---

## 12. Document lifecycle

One authoritative source of state (the database):

```text
INITIATED -> UPLOADING -> UPLOADED -> VALIDATING
  VALIDATING -> REJECTED | PASSWORD_REQUIRED | VALIDATED
VALIDATED -> CLASSIFYING -> READY_FOR_PARSING -> PARSING
  PARSING -> PARSING_FAILED | PARSED
Any -> DELETION_PENDING -> DELETED (separate controlled deletion workflow)
```

Keep upload attempts and processing runs as separate records even if the UI shows one status.

User-facing text: UPLOADING "Uploading your document"; VALIDATING "Checking your document"; PASSWORD_REQUIRED "This PDF needs a password"; CLASSIFYING "Identifying the document"; READY_FOR_PARSING "Document accepted"; PARSING "Reading your insurance policy"; PARSED "Policy information extracted"; REJECTED "This file could not be accepted". MVP: poll `GET /documents/{id}/status`; later Server-Sent Events. WebSockets not needed.

---

## 13. Proposed technology stack

MVP proposal: React + TypeScript + Vite, Zod, TanStack Query, Supabase Auth or Clerk, FastAPI, Pydantic, PostgreSQL, SQLAlchemy, Alembic, S3 or R2, Boto3, Redis + Celery, PyMuPDF + qpdf, ClamAV or managed scanner, Sentry, structured logging, Docker + managed hosting, Pytest.

**If the existing backend works well in Node.js, do not rewrite it for FastAPI.** Keep Node, use a Node queue for orchestration, and introduce Python workers for document processing only if needed. The decision depends on the current repository.

Scale path (not a mandatory roadmap): API replicas behind a load balancer; independently scalable worker pools; managed queue; storage lifecycle and encryption controls; database pooling, replicas, partitioning when justified; container hosting; stronger identity; OpenTelemetry, Prometheus, Grafana; sandboxing, WAF; infrastructure as code. Scale components independently; do not replace technologies unnecessarily.

---

## 14. Eventual production shape

Frontend (file selection, validation, progress) -> API layer (authn, authz, upload management, rate limiting, document access control) -> database (users, households, documents, upload sessions, processing jobs) and object storage (quarantine, trusted, original PDFs) -> processing queue -> worker layer (security validation, PDF inspection, classification; restricted environment) -> handoff -> parsing engine. The browser uploads bytes directly to storage via a signed URL.

---

## 15. 100 users vs 100,000 users

Load drivers: API, object storage, database, queue, PDF validation, OCR, AI processing, network, logging. The upload itself is unlikely to be the hardest scaling problem; processing, security checks, OCR and AI inference are.

Backpressure: limit concurrent processing, prioritise, let the rest wait (queue length limits, per-user quotas, worker concurrency, load-based throttling). Rate limiting: upload initiations per account per minute, active uploads per user, documents per batch, simultaneous jobs per household; values chosen through usage testing. Rate limits and file-size limits are both needed.

Not needed yet: Kafka, Kubernetes, microservices, distributed event architecture, dedicated load balancing.

---

## 16. Security and privacy

| Area | Requirement |
|---|---|
| Authentication | Only authorized users can initiate uploads |
| Authorization | Users cannot access another household's files |
| Data transfer | HTTPS/TLS |
| Data storage | Encryption at rest |
| Storage access | Private buckets, least-privilege credentials |
| File security | Malware scans and structural validation |
| Logging | No raw PDFs, passwords or unnecessary personal information |
| Retention | Clear retention policies |
| Deletion | Remove original and derived data where required |
| AI access | Control what document information reaches model providers |
| Auditing | Record sensitive document access and deletion events |
| Household access | Prevent unintended access between family members |

India: the Digital Personal Data Protection Act 2023 and DPDP Rules 2025 have phased commencement; design now for notices, consent or other lawful grounds, safeguards, deletion and access controls. Family documents: uploading a relative's policy does not prove permission to disclose everything in it. Health information: collect only when needed. Third-party AI: know where data is processed and retained. Deletion: delete originals and derived data. Formal legal review before real customers.

---

## 17. Reliability scenarios to test

Internet drops mid-upload; same PDF uploaded twice; someone else's policy uploaded; over size limit; malware; password required; corrupt PDF; no extractable text (route to OCR later); 300-page file; worker crash; queue unavailable; storage temporarily failing; database transaction failure; two users upload identical files (ownership stays isolated); deletion during processing; browser refresh; expired signed URL; guessed document id (deny and record); same job runs twice.

Content deduplication and document ownership are different: two customers can hold identical copies of a policy wording; household associations, permissions, schedules and processing histories stay separate.

---

## 18. Observability

Logs, metrics, traces. MVP: error tracking plus structured logs; later OpenTelemetry.

Metrics: upload success rate, upload abandonment, validation rejection rate, validation latency, upload-to-ready latency, queue wait time, worker failure rate, retry rate, duplicate upload rate, classification accuracy against labels, cost per accepted document. Use P50/P95/P99, not averages.

Example acceptance targets (goals, not claims): zero cross-household access in security tests; uploaded content matches the verified original; no duplicate logical documents; pending jobs recoverable after worker crash; failed uploads show a clear error and retry path; every job has a visible state; every document has an identifiable original file. Correctness and recoverability before milliseconds.

---

## 19. Vocabulary

API, REST, endpoint, GET/POST/PUT/HEAD, status codes, CORS, CDN, load balancer, reverse proxy, stateless API, Redis, cache, queue, worker, broker, pub/sub, event-driven, idempotency, race condition, atomic operation, transaction, retry, timeout, exponential backoff, jitter, circuit breaker, DLQ, checksum, hash, UUID, TTL, horizontal/vertical scaling, autoscaling, container, Docker, orchestration, RLS, WAF, KMS, IaC, schema, data contract, observability, OpenTelemetry, SLO, SLA.

---

## 20. Build order: four milestones (not 10 separate boxes)

**Milestone 1: A trustworthy upload** (boxes 1-5, basic 7). Authentication, household identification, PDF selection, client validation, signed upload URLs, private storage, basic document records, upload status. **Done when:** a user uploads five PDFs, refreshes, and still sees the same five documents in the correct household; another user cannot access them. No AI.

**Milestone 2: Secure document acceptance** (box 6, rest of 7). Server-side checks, PDF structure inspection, malware scanning, hashing, duplicate detection, quarantine-to-trusted workflow, failure handling. **Done when:** every accepted PDF has a stored original, stable id, verified ownership and recorded validation result; invalid or unsafe PDFs cannot enter parsing.

**Milestone 3: Independent document processing** (boxes 8-9). Job queue, worker, inspection, basic classification, retries, idempotency, status API, stuck-job recovery. **Done when:** ten uploads do not block the API and jobs recover from worker failure without duplicate documents.

**Milestone 4: A reliable parsing interface** (box 10). Versioned handoff schema, validated storage references, job identity, structured errors, integration tests with the parser. **Done when:** the parser receives a valid document reference and metadata, processes independently, and reports success or failure.

---

## 21. Whiteboard checklist

| Box | Module | MVP priority | Main technical concern |
|---|---|---|---|
| 1 | User Input | P0 | Correct documents and household context |
| 2 | Client Validation | P0 | File selection and early error detection |
| 3 | AuthN/AuthZ | P0 | Identity and access isolation |
| 4 | Upload Orchestration | P0 | Secure direct uploads |
| 5 | Object Storage | P0 | Private, recoverable file storage |
| 6 | Server Validation | P0 | Malicious and invalid files |
| 7 | Document Registration | P0 | Document identity and metadata |
| 8 | Classification & Routing | P1 | Correct document handling |
| 9 | Async Processing | P0 basic, P1 advanced | Reliability and worker scaling |
| 10 | Parsing Handoff | P0 | Stable input/output contract |

Five rules:

1. **Never trust the browser.** Validate identity, permissions, files and stored object properties on the server.
2. **Every document gets a unique identity** across storage, records, jobs and parsing results.
3. **Preserve original information.** Never overwrite the original PDF with extracted or AI content.
4. **Make processing recoverable.** A failed worker must not leave a document stuck or silently lost.
5. **Keep modules independent.** The parser does not care how the PDF was uploaded; the input system does not care how recommendations are generated.

Architectural decision proposed: **a modular monolith with independently deployable processing workers**: one backend with separated modules, one PostgreSQL database, managed object storage, and an asynchronous worker system.

**Block 1 answers:** is this a valid, authorized, securely stored document that the product can process?
**Block 2 answers:** what insurance information does it contain, how reliable is that extraction, and where is the evidence?
