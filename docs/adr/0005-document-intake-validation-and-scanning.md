# ADR 0005: Document intake validation and malware scanning

- Status: Accepted (owner chose ClamAV clamd, an encrypted local store and a 15 MiB cap, before S3.2, on 2026-10-18)
- Date: 2026-10-18
- Scope: Block 1 (`src/modules/document-intake/`), see [block-1-input.md](../architecture/block-1-input.md)
- Builds on: ADR 0002 (persistence port)

## Context

Block 1 had validation and encrypted storage code but no route, no scanner and no persistent repository. Documents are RESTRICTED data. A document must not reach OCR or a model before it is checked. The code already has a byte-storage port (`put`, `read`, `remove`), AES-256-GCM storage and a 15 MiB cap. The runtime is SQLite; PostgreSQL arrives in S3.2. No object storage and no deployment target exist. The owner's proposal suggested signed-URL upload, S3 or R2, qpdf or PyMuPDF and Redis. None are approved dependencies.

## Decision

- **(a) Upload path.** Uploads go through the API (Architecture A) as a raw `application/pdf` body. Bytes are stored in the existing AES-256-GCM local store behind the byte-storage port. The cap is 15 MiB, enforced while streaming. The route accepts PDF only. The port lets object storage replace the local store later without changing routes.
- **(b) PDF inspection.** A bounded, pure-Node inspection (`pdf-inspection.js`) runs in the API process before storage. It rejects encrypted PDFs (`PDF_PASSWORD_REQUIRED`), active content (`/JavaScript`, `/JS`, `/Launch`, embedded files, XFA, RichMedia and similar, including inside object streams with or without `/Type /ObjStm`), objects or trailers hidden inside skipped stream bodies, comments or strings, more than 500 pages, and deflate bombs. No password is accepted or stored. It is a bounded heuristic, not a full PDF parser: it can reject a legitimate file whose raw streams or strings contain object syntax, and it does not prove a file is safe. Malware scanning is a separate, required layer before activation.
- **(c) Malware scanning.** ClamAV `clamd` over TCP with the INSTREAM command, written without an npm dependency (`clamd-scanner.js`). Scanning is asynchronous. `DOCUMENT_SCAN_MODE` is `clamd` or `disabled`; the default is `disabled`, which keeps documents quarantined (fail closed). A clean result activates the document. An infected or tampered object removes the bytes and marks the document deleted; so does an object confirmed missing over three attempts while the storage root exists (an absent root is an outage and defers), and a scan that fails with a non-retryable scanner error ten times (`SCAN_FAILED_REPEATEDLY`). clamd must be configured so that "clean" means fully scanned: see [the ClamAV runbook](../runbooks/clamav.md) (`AlertExceedsMax yes`, `AlertEncrypted yes`, PDF scanning on, `StreamMaxLength` at least 16M). With clamd defaults, files over its scan limits are reported clean.
- **(d) Work queue.** The database row (`quarantined`, `malware_status = pending`) is the durable work queue. Scan attempts and the next due time are stored on the row (`scan_attempts`, `next_scan_at`, migration 008 / PostgreSQL 004). A scanner or transient storage failure defers the scan with capped exponential backoff (30 s doubling, at most one hour, retried indefinitely), so an outage never strands a document. Deletion work (revocation, malware hits) is always listed before scans. `scan-worker.js` adds in-process single-flight and concurrency limits. Unique indexes make duplicate-content and immutable-version checks hold under concurrent uploads. Deleted rows keep a tombstone without the content hash or a usable storage reference, and an hourly sweep removes ciphertext and temporary files that have no live row. No Redis, Celery or BullMQ. S3.2 can add `SKIP LOCKED` claims.

## Consequences

- Parsing untrusted PDFs in the API process is a risk. The inspection is bounded and rejects early, but it is not a sandbox. A sandboxed process is planned (milestone 2b).
- Scanning depends on clamd being reachable. If it is down, documents stay quarantined and are retried. Users see "Received, waiting for checks".
- Attempt counters reset on restart. This is safe because the row stays pending and is scanned again.
- Azure needs a clamd container or a different scanner. The Azure staging setting `DOCUMENT_SCAN_MODE=structural_only` is now a startup error (unknown modes fail closed). Change it to `disabled` or `clamd` before deploying this code.
- The local encryption key in `DOCUMENT_ENCRYPTION_KEY_BASE64` is a stopgap. Key Vault and managed identity are planned for Azure.
- Deduplication stays inside one household. Identical bytes in another household are stored separately.
- Upload and consent wording shown to users is pending legal review.

## Alternatives

- **S3, R2 or Azure Blob with signed URLs.** Better for large files and direct upload. Needs a provider choice (Azure is the planned target, owner decision open) and new infrastructure. Deferred behind the port.
- **Microsoft Defender for Storage.** Fits Azure Blob, but there is no blob store yet. Revisit with the Azure decision.
- **qpdf or PyMuPDF in a sandbox.** Stronger parsing. Adds a native or Python runtime and a sandbox to build. Planned as milestone 2b if a measured need appears.
- **Redis queues.** Duplicates the database-backed task queue. Not approved without measured need.

## Rollback

Set `DOCUMENT_SCAN_MODE=disabled` to stop scanning; documents stay quarantined. Reverting the slice removes the routes. Encrypted files under `DOCUMENT_STORAGE_PATH` and any `document_uploads` rows created through the route remain and are removed by the existing deletion path.
