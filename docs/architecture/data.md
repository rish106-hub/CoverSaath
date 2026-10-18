# Data architecture

Status: describes the repository at the commit that added this file. Companion documents: [system.md](system.md), [security.md](security.md), [../runbooks/local-database.md](../runbooks/local-database.md).

## Storage

- Engine: `node:sqlite` (`DatabaseSync`), one local file. Default path `.local/knowvia.sqlite` (legacy name), overridden by `DATABASE_PATH`. `.local/` is git-ignored (`.gitignore`).
- `openDatabase` (`src/backend/database/database.js:171`) creates the directory with mode `0700`, sets `foreign_keys = ON`, `busy_timeout = 5000` and, for file databases, `journal_mode = WAL`; `:memory:` is used by tests.
- All tables are `STRICT`. Timestamps are ISO-8601 UTC text. Money is integer minor units (`service_cases.stated_estimate_minor` with `currency`).
- The database stores controlled paths, hashes, derived facts, permissions and audit records. Document bytes live outside SQLite (`001_initial_schema.sql:1-3`).
- PostgreSQL is in progress (Section 3; ADR 0004, `docs/exec-plans/active/p1b-postgres.md`, local setup in [local-postgres](../runbooks/local-postgres.md)). Six PostgreSQL migrations now provide the SQLite-equivalent baseline plus hardening for `TRUNCATE`, function `search_path`, collation validation and pool or runner error boundaries, document intake scheduling (004), evidence fact redaction (005) and its forward fix (006). The runtime still uses SQLite: `pg` is a dependency, but no runtime code imports it yet. The port contract in `src/contracts/persistence-ports.js` is the only preparation; routes and `TenantAccessService` still read `workflow_*` tables with direct SQL and are outside that port (ADR 0002, "Consequences and gaps").

## Migrations

Mechanism (`runMigrations`, `database.js:22`):

- Files `src/backend/database/migrations/NNN_snake_case.sql`, applied in sorted order, each inside `BEGIN IMMEDIATE`. Ten exist: 001 initial schema, 002 integrity and provenance, 003 tenant auth and permissions, 004 OCR contract and provenance, 005 evidence-completion parameters, 006 parameter observation guards, 007 append-only delete guards, 008 document intake scheduling, 009 evidence fact redaction, 010 evidence fact redaction hardening.
- `schema_migrations(version, checksum, applied_at)` stores a sha256 of each applied file.
- A changed applied file throws `Migration failed: <file>: Applied migration changed: <file>` and rolls back. One exception is hard-coded: a known older checksum of `002_integrity_and_provenance.sql` is refreshed instead (`legacyMigrationChecksums`).
- `validateSchema` (`database.js:133`) checks expected tables (42, including `schema_migrations`), views, `criticalTriggers` (53), critical indexes, required columns, `PRAGMA foreign_key_check` and `PRAGMA quick_check`. It is not called when a database is opened. It runs in `npm run db:init` (prints the result; the exit code stays 0 even when `valid` is false) and in `GET /api/v1/ready` (503 when invalid; the detail is returned to loopback callers only).
- Rules for authors are in `src/backend/database/AGENTS.md`: new numbered migration only, expand-only by default, invariant triggers go into `criticalTriggers` with a test.

PostgreSQL migrations live in `src/backend/database/postgres/migrations/`. Migrations 001 and 002 are the merged baseline. Migration 003 adds missing `DELETE` and statement-level `TRUNCATE` guards, fixes project-function `search_path`, revokes the default database `TEMPORARY` privilege from `PUBLIC` and removes `PUBLIC` `TRUNCATE` rights on protected tables. Migrations 004, 005 and 006 mirror SQLite 008, 009 and 010. A dedicated least-privilege runtime role is still S3.2 work.

## Tables by domain

Counts and columns: `repomap db`. "Owner" is the module that writes the table.

| Domain | Tables | Owner | Key invariants |
|---|---|---|---|
| Households and auth | `households`, `adult_users`, `household_roles`, `household_members`, `api_sessions` | `household-repository.js`, `auth-repository.js` | Roles: owner, member, operator, backup_operator, viewer. An adult member needs `adult_user_id`; dependents may have none (`001:36-47`). `api_sessions.token_sha256` is unique, 64 hex chars; the bearer token is never stored (`003`). |
| Consent | `consent_grants`, `consent_scopes`, `consent_revocations`, view `active_consent_grants` | `consent-repository.js` | Subject must belong to the household and a scope resource must belong to the grant household (triggers in `002`). Revocation marks the grant (`consent_revocations_mark_grant`). A NULL `recipient` never authorises disclosure to a named recipient. |
| Documents and OCR | `document_uploads`, `ocr_jobs`, `source_pages` | `ocr-repository.js`; `document-intake` module | Lifecycle: quarantined, active, deletion_requested, deleted. A document cannot activate before malware status and encryption status are acceptable (`document_uploads_activation_guard`). OCR pages must match their document (`004`). Only `knowvia.ocr.v1` pages are eligible for analysis. |
| Cases, runs, tasks | `service_cases`, `case_participants`, `workflow_runs`, `workflow_tasks`, `workflow_task_dependencies`, `workflow_events`, `idempotency_keys` | `case-repository.js`, `workflow-repository.js`, `coverage-analysis-port.js` | Case states follow `case-state-machine.js`; stale `expectedRevision` is rejected. Run/task states are CHECK-constrained (`execution-policy.js`). Dependencies must be in the same run. A run carries its consent grant and pinned workflow version; run refs are immutable. |
| Evidence and graph | `policies`, `policy_members`, `insurers`, `evidence_facts`, `fact_conflicts`, `coverage_graph_snapshots/_nodes/_edges`, view `unresolved_evidence` | `evidence-repository.js` | Household references checked by trigger. `evidence_facts` provenance is immutable: facts are append-only except one redaction update (value and locators nulled, state set to UNKNOWN, `redacted_at` and reason set; every other column unchanged), cannot be inserted redacted, and cannot cite a page of a document whose erasure has started (`010`). UNKNOWN is distinct from false; a redacted fact reads as UNKNOWN in `unresolved_evidence`. |
| Parameters and observations | `coverage_parameter_registry_versions`, `_registry_pins`, `_records`, `_acquisitions`, `_observations`, `_resolutions`, `_observation_rules` | `coverage-parameter-repository.js` | Each run pins one registry version; records are immutable in identity. Observations are append-only except one redaction update (value nulled, `redacted_at` set). Resolution state and authority must match a row of `_observation_rules`. Model authority yields only unknown, extracted_unverified or conflicting. Redacting an observation resets any resolution that used it. Observations need an active document (006); `human_review` observations need a matching review row (006). |
| Reviews, release, outbox | `reviewer_findings`, `release_gates`, `human_reviews`, `human_approvals`, `integration_outbox`, `integration_webhook_events` | schema only; the outbox is touched on revocation | An outbox row needs an active consent (`integration_outbox_requires_active_consent`). No code enqueues provider work. |
| Audit and retention | `audit_events`, `retention_records` | `audit-repository.js`; none for retention | `audit_events` is append-only by trigger. Each event stores `previous_event_hash` (per household) and `event_hash`. Payloads carry counts, codes and digests, not content. |

Notes:

- No code verifies the audit hash chain; it is written only.
- `retention_records` is created and listed in `expectedTables`, but no source file reads or writes it.
- Expired `api_sessions` rows are rejected at authentication; no code deletes them. Expired `idempotency_keys` are purged on every `openDatabase` (`purgeExpiredIdempotencyKeys`).

## Erasure and revocation

| Trigger | Path | Effect |
|---|---|---|
| Consent revocation | `ConsentRepository.revoke` (`consent-repository.js:141`), one transaction | Writes `consent_revocations`; cancels pending outbox rows and unfinished OCR jobs; redacts parameter observations of covered documents; calls `eraseDerivedRunData` (which also redacts evidence facts of covered documents); blanks `source_pages` text, digests and provenance; sets documents to `deletion_requested`; revokes tasks, runs and graph snapshots of the grant; audits. |
| Derived run data | `eraseDerivedRunData` (`:236`) | Replaces source page excerpts in `workflow_runs.input_json` with ids plus `redacted: consent_revoked`; nulls task outputs; revokes runs; supersedes graph snapshots; redacts observations per run; one counts-only audit event. Redacts evidence facts sourced from pages of the affected documents (household-scoped when known) with a separate counts-only `evidence.facts_erased` event. Idempotent in effect (a repeat call changes no data, but one that finds referencing runs audits their counts again); bounded to 5,000 runs per call. Fails closed (`ERASURE_NOT_CONFIGURED`) if observations exist and the parameter repository is not wired. |
| Observations by run / document | `redactObservationsForRun`, `redactObservationsForDocument` (`coverage-parameter-repository.js`) | Null `value_json`, record `redacted_at` and a reason; audit counts. |
| Document deletion request | Trigger `coverage_parameter_observations_redact_on_document_erasure` (`005`) | Any move to `deletion_requested` or `deleted` redacts that document's observations, even if the repository is bypassed. |
| Evidence facts by document | `eraseDerivedRunData`; trigger `evidence_facts_redact_on_document_erasure` (`009`) | Null `value_json`, `source_page_id`, `source_locator`, `institutional_source_ref`, `calculation_method`, `permitted_viewers_json`, `effective_at`; set `epistemic_state` UNKNOWN, `redacted_at` and a reason. The trigger redacts on any move to `deletion_requested` or `deleted`, even if the repository is bypassed; migration `010` backfills documents already in those states. |
| Commit-time stop | `stopForRevocation(runId, { reason: 'source_consent_not_current' })` | Runs `eraseDerivedRunData` and stops the run in one transaction; rolls back if erasure fails. |

Gaps:

- Encrypted document bytes: consent revocation marks uploads `deletion_requested`; the document worker (started with the server whenever encrypted storage is configured) removes the bytes and marks the row `deleted` with filename `[deleted]` and a counts-only `document.bytes_deleted` audit event (`document-upload-service.js` `processDocument`, `document-repository.js` `completeDeletion`). A malware hit, tampered ciphertext or a missing object follows the same path. The row stays as a tombstone with the content hash and storage reference replaced by random values. An hourly sweep removes ciphertext and temporary files with no live row once they are an hour old.
- Revocation of a grant does not delete `document_uploads` rows, `consent_*` rows or audit events.
- Evidence facts without a document source (adult statements, institutional replies, calculations) carry no consent grant link, so revocation does not reach them, and a commit-time stop that erases a whole run (no attributable document) does not reach facts either. Redacting a fact does not close open `fact_conflicts` rows that reference it. Revoking a grant erases facts from documents uploaded under it and documents named by id in its scopes, including one another grant also covers (same as observations). A document scope with no `resource_id` is not expanded to every household document. No production code writes evidence facts yet.

## Retention

| Item | Status |
|---|---|
| Idempotency keys | Decided: 24 hours (`execution-policy.js`). |
| Sessions | Lifetime from `SESSION_TTL_SECONDS` (default 3600, max 86400). Rows are not purged. |
| Audit events | Kept; no retention period decided. |
| Derived data after consent revocation | Decided: erased (above). |
| Derived data after consent expiry | Open owner decision (review F3 in `docs/iterations/LATEST.md`). Expiry blocks new use but does not erase observations, run excerpts or task outputs. |
| `retention_records` policy, legal holds, deletion SLAs | Not decided. No source names a retention period. |
| `docs/evidence/` in git history | Open owner decision (purge or private repository; `docs/exec-plans/completed/p0-baseline-intake.md`). |

## Backup and restore

Nothing exists beyond copying the SQLite file. There is no backup job, restore test, point-in-time recovery, replica or encryption of the database file (`README.md`: backups are not implemented). Document bytes are not stored by any wired path. Local procedure: [local-database runbook](../runbooks/local-database.md). Recovery targets (RPO/RTO): Not decided.
