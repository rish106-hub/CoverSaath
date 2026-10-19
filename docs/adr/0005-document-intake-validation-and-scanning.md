# ADR 0005: Document intake validation and malware scanning

- Status: Accepted (owner chose ClamAV clamd, an encrypted local store and a 15 MiB cap, before S3.2, on 2026-10-18)
- Date: 2026-10-18
- Scope: Block 1 (`src/modules/document-intake/`), see [block-1-input.md](../architecture/block-1-input.md)
- Builds on: ADR 0002 (persistence port)

## Context

Block 1 had validation and encrypted storage code but no route, no scanner and no persistent repository. Documents are RESTRICTED data. A document must not reach OCR or a model before it is checked. The code already has a byte-storage port (`put`, `read`, `remove`), AES-256-GCM storage and a 15 MiB cap. The runtime is SQLite; PostgreSQL arrives in S3.2. No object storage and no deployment target exist. The owner's proposal suggested signed-URL upload, S3 or R2, qpdf or PyMuPDF and Redis. None are approved dependencies.

## Decision

- **(a) Upload path.** Uploads go through the API (Architecture A) as a raw `application/pdf` body. Bytes are stored in the existing AES-256-GCM local store behind the byte-storage port. The cap is 15 MiB, enforced while streaming. The route accepts PDF only. The port lets object storage replace the local store later without changing routes.
- **(b) PDF inspection.** A bounded, pure-Node inspection (`pdf-inspection.js`) runs before storage, in a restricted child process since Amendment 1 (originally in the API process). It rejects encrypted PDFs (`PDF_PASSWORD_REQUIRED`), active content (`/JavaScript`, `/JS`, `/Launch`, embedded files, XFA, RichMedia and similar, including inside object streams with or without `/Type /ObjStm`), objects or trailers hidden inside skipped stream bodies, comments or strings, more than 500 pages, and deflate bombs. No password is accepted or stored. It is a bounded heuristic, not a full PDF parser: it can reject a legitimate file whose raw streams or strings contain object syntax, and it does not prove a file is safe. Malware scanning is a separate, required layer before activation.
- **(c) Malware scanning.** ClamAV `clamd` over TCP with the INSTREAM command, written without an npm dependency (`clamd-scanner.js`). Scanning is asynchronous. `DOCUMENT_SCAN_MODE` is `clamd` or `disabled`; the default is `disabled`, which keeps documents quarantined (fail closed). A clean result activates the document. An infected or tampered object removes the bytes and marks the document deleted; so does an object confirmed missing over three attempts while the storage root exists (an absent root is an outage and defers), and a scan that fails with a non-retryable scanner error ten times (`SCAN_FAILED_REPEATEDLY`). clamd must be configured so that "clean" means fully scanned: see [the ClamAV runbook](../runbooks/clamav.md) (`AlertExceedsMax yes`, `AlertEncrypted yes`, PDF scanning on, `StreamMaxLength` at least 16M). With clamd defaults, files over its scan limits are reported clean.
- **(d) Work queue.** The database row (`quarantined`, `malware_status = pending`) is the durable work queue. Scan attempts and the next due time are stored on the row (`scan_attempts`, `next_scan_at`, migration 008 / PostgreSQL 004). A scanner or transient storage failure defers the scan with capped exponential backoff (30 s doubling, at most one hour, retried indefinitely), so an outage never strands a document. Deletion work (revocation, malware hits) is always listed before scans. `scan-worker.js` adds in-process single-flight and concurrency limits. Unique indexes make duplicate-content and immutable-version checks hold under concurrent uploads. Deleted rows keep a tombstone without the content hash or a usable storage reference, and an hourly sweep removes ciphertext and temporary files that have no live row. No Redis, Celery or BullMQ. S3.2 can add `SKIP LOCKED` claims.

## Consequences

- Parsing untrusted PDFs in the API process is a risk. The inspection is bounded and rejects early, but it is not a sandbox. Amendment 1 moves it into a permission-restricted child process (milestone 2b); see its residual risks.
- Scanning depends on clamd being reachable. If it is down, documents stay quarantined and are retried. Users see "Received, waiting for checks".
- Attempt counters reset on restart. This is safe because the row stays pending and is scanned again.
- Azure needs a clamd container or a different scanner. Any `DOCUMENT_SCAN_MODE` other than `disabled` or `clamd` is a startup error (unknown modes fail closed); check the deployed setting before deploying (see the Azure staging runbook, Step 1).
- The local encryption key in `DOCUMENT_ENCRYPTION_KEY_BASE64` is a stopgap. Key Vault and managed identity are planned for Azure.
- Deduplication stays inside one household. Identical bytes in another household are stored separately.
- Upload and consent wording shown to users is pending legal review.

## Alternatives

- **S3, R2 or Azure Blob with signed URLs.** Better for large files and direct upload. Needs a provider choice (Azure is the planned target, owner decision open) and new infrastructure. Deferred behind the port.
- **Microsoft Defender for Storage.** Fits Azure Blob, but there is no blob store yet. Revisit with the Azure decision.
- **qpdf or PyMuPDF in a sandbox.** Stronger parsing. Adds a native or Python runtime and a sandbox to build. Planned as milestone 2b if a measured need appears.
- **Redis queues.** Duplicates the database-backed task queue. Not approved without measured need.

## Amendment 1 (2026-10-18): PDF inspection in a restricted child process (milestone 2b, S1)

Owner decision: a Node child process with the Node permission model. No qpdf, no new dependency. This supersedes "runs in the API process" in decision (b) and the first Consequences bullet.

- **What runs where.** The API process no longer parses PDF structure. `sandboxed-pdf-inspection.js` spawns `process.execPath` on `pdf-inspection-child.mjs` for each PDF upload, writes the bytes to stdin and reads one JSON object from stdout. The child runs the unchanged `inspectPdf`. `inspectPdf` stays importable in-process for unit tests.
- **Flags.** `--permission`, `--allow-fs-read` for exactly three files (the child entry, `pdf-inspection.js`, `contracts.js`), `--max-old-space-size=128`, `--disallow-code-generation-from-strings`. No `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi`, `--allow-inspector` or `--allow-net`. The runner refuses to start unless the Node runtime exposes the network permission scope. The environment is empty, so no key or setting reaches the child. stderr is discarded.
- **Self-check.** Before importing the inspector, the child checks `process.permission` and refuses (exit 78) if the model is off or if write, child process, worker, WASI, addon, inspector or (where the scope exists) network access is granted, or if a root, parent-directory or module-directory read is granted. The parent maps that exit to `PDF_INSPECTION_UNAVAILABLE`.
- **Limits.** 5 s wall clock, then `SIGKILL`. Output over 4 KiB kills the child. Input over 15 MiB is refused in the parent and again in the child. Two children at a time, eight queued. These are code constants, not measured capacity.
- **Fail closed.** The parent accepts only exit 0 with a strictly shaped result (`pageCount` 1 to 500, `objectStreamCount`, `pdfVersion`) or one of the six existing `PDF_*` rejection codes. Messages come from the parent, never from the child. Every other outcome rejects the upload: timeout, crash, signal, non-zero exit (even after a valid-looking result), oversized, empty or malformed output → `PDF_INSPECTION_FAILED` (422, not retryable); spawn error, inactive sandbox, shutdown → `PDF_INSPECTION_UNAVAILABLE` (503, retryable); full queue → `PDF_INSPECTION_BUSY` (429, retryable, like `UPLOAD_CAPACITY_REACHED`). Logs carry the event type, reason, exit code and signal only.
- **Consent.** Inspection is now asynchronous and can take seconds, so the intake service re-checks consent after inspection and stores nothing if the grant was revoked meanwhile. The existing short window between that re-check and the row commit (encrypted write) remains.

**Residual risk (this is not an OS sandbox).**

- It is process isolation plus the Node permission model. There is no seccomp, namespace, chroot, cgroup or rlimit. Node documents the permission model as a guard for trusted code, not a boundary against code that has gained execution. A memory-safety bug in V8, zlib or Node that gives an attacker code execution in the child is not contained by it.
- Node 25 is the supported floor because earlier permission models cannot deny network access. CI and staging use Node 26. Startup and tests fail closed when the network permission scope is unavailable.
- `--max-old-space-size` caps the V8 heap, not Buffers or other external memory. Inflation inside the child is bounded by `inspectPdf` itself (8 MiB per stream, 64 MiB total). There is no RSS limit.
- If the API process is killed with `SIGKILL`, a running child is not killed by the parent. It finishes its bounded scan and exits.
- The child self-check probes known paths. It catches broad grants, not every possible narrow grant; the parent's fixed flag builder is the control that keeps grants narrow.
- Each upload starts a Node process. No throughput has been measured.

A stronger boundary (container with seccomp, gVisor, or qpdf in a separate service) stays an option when a deployment target exists.

## Rollback

Reverting the amendment slice restores in-process inspection (`inspectPdf` in `create-server.js`); no data or schema changes are involved.

Set `DOCUMENT_SCAN_MODE=disabled` to stop scanning; documents stay quarantined. Reverting the slice removes the routes. Encrypted files under `DOCUMENT_STORAGE_PATH` and any `document_uploads` rows created through the route remain and are removed by the existing deletion path.
