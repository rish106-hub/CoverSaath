# Data architecture

Status: describes the repository at the commit that added this file. Companion documents: [system.md](system.md), [security.md](security.md), [../runbooks/local-postgres.md](../runbooks/local-database.md).

## Storage

- Engine: PostgreSQL (Supabase, ADR 0011) through the async interface in `src/backend/database/postgres/` (`createDatabase` over a `pg` pool). The SQLite runtime and its migration files are removed.
- Timestamps are ISO-8601 UTC text. Money is integer minor units (`service_cases.stated_estimate_minor` with `currency`).
- The database stores controlled paths, hashes, derived facts, permissions and audit records. Document bytes live outside the database (`postgres/migrations/001_baseline_schema.sql`).
- PostgreSQL is in progress (Section 3; ADR 0004, `p1b-postgres.md` (deleted 2026-11-11), local setup in [local-postgres](../runbooks/local-postgres.md)). Six PostgreSQL migrations now provide the SQLite-equivalent baseline plus hardening for `TRUNCATE`, function `search_path`, collation validation and pool or runner error boundaries, document intake scheduling (004), evidence fact redaction (005) and its forward fix (006). The runtime now uses PostgreSQL. The port contract in `src/contracts/persistence-ports.js` is the only preparation; routes and `TenantAccessService` still read `workflow_*` tables with direct SQL and are outside that port (ADR 0002, "Consequences and gaps").

## Migrations

Mechanism (`runPostgresMigrations`):

- Files `src/backend/database/postgres/migrations/NNN_snake_case.sql`, applied in sorted order, each in its own transaction. `schema_migrations(version, checksum, applied_at)` stores a sha256 of each applied file.
- A changed applied file is refused and nothing later is applied. Applied migrations are immutable; fix forward with a new numbered file.
- `validatePostgresSchema` checks expected tables, views, critical triggers (enabled), indexes, required columns, foreign-key integrity, `C` collation, a fixed `search_path` on guard functions, row level security on every table and no `anon`/`authenticated` grants. It runs in `npm run db:init` (exit code 1 when `valid` is false) and in `GET /api/v1/ready` (503 when invalid; the detail is returned to loopback callers only).
- Rules for authors are in `src/backend/database/AGENTS.md`: new numbered migration only, expand-only by default, invariant triggers go into `criticalTriggers` with a test, every new table enables row level security.

PostgreSQL migrations live in `src/backend/database/postgres/migrations/`. Migrations 001 and 002 are the merged baseline. Migration 003 adds missing `DELETE` and statement-level `TRUNCATE` guards, fixes project-function `search_path`, revokes the default database `TEMPORARY` privilege from `PUBLIC` and removes `PUBLIC` `TRUNCATE` rights on protected tables. Migrations 004 to 015 add document intake, evidence redaction, policy structuring, stored OCR blocks, evidence-first reasoning, catalogue reviews and signed curated actions. Migration 016 enables row level security on every table and revokes all `anon` and `authenticated` privileges so the Supabase Data API cannot reach the schema (ADR 0011 D10). A dedicated least-privilege runtime role is still open work.

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
| Holdings and memory (048-052) | `policy_holdings`, `household_memory_facts`, `memory_conflicts`, `member_declarations`, `premium_payments`, `premium_dues` | `memory-fact-repository.js` and the holdings repositories | A holding is a thin link (policy, upload, profile), one per upload, no insurer or plan copy. `household_memory_facts` is EAV: one value of one fact key from one tier (`own_pdf`, `ida_wording`, `user_declaration`), each tier with its own closed status set; a new fact key is a line in `src/contracts/policy-facts.js`, not a migration. Values are sealed (enc2, AAD table, column, row id); `value_enc` is NULL exactly when status is unknown. A model never writes `reviewed_reference` or `user_confirmed`. Declaration labels (health data) and premium amounts and agent fields are sealed; amounts keep only a coarse plain band. Dates are plain days. Scope triggers check that every referenced row is in the row's household (ADR 0032). |
| Network hospitals (055) | `network_hospitals` | `network-hospital-repository.js` (sync job) | Public reference data synced from the reference export. No household, member, case or consent column; global like `reference_cache` (033). Pincode lookup; PostGIS only past 100k rows. |
| Provider audit (056) | `provider_calls` | model gateway (`src/features/ai-analysis/`) | One append-only row per gateway call: gate counts, sha256 of the redacted prompt, tokens, cost in paise. No payload, no text. `household_id` NULL for a system task. |
| Memory retrieval (053) | `memory_chunks` | `memory-chunk-repository.js` | Redacted passage sealed; embedding is plaintext (pgvector cannot index ciphertext, ADR 0031 D2). Rows replaced, never edited; one live row per household, holding, scope and source ref. pgvector lives in the `extensions` schema. |
| Chat (054) | `chat_threads`, `chat_turns`, `retrieval_traces` | `chat-v1-service.js` | Turn content and a voice turn's transcript sealed (ADR 0029); audio reference only under `VOICE_AUDIO_RETAIN=true`; assistant turns hold a provider summary and the redacted prompt digest. Traces hold ids and the retrieval method only. |
| Analytics (057) | `analytics_outbox` | `analytics-service.js` | Allowlisted events (closed vocabulary or bounded whole numbers), household id hashed with HMAC under a salt, never sent raw. Enqueued only with `ANALYTICS_ENABLED=true` and an active analytics consent grant (purpose `analytics`, household-wide scope). Sent rows purged after seven days; wording and consent UI **FOR LEGAL REVIEW** (ADR 0033). |
| Audit and retention | `audit_events`, `retention_records` | `audit-repository.js`; none for retention | `audit_events` is append-only by trigger. Each event stores `previous_event_hash` (per household) and `event_hash`. Payloads carry counts, codes and digests, not content. |

Notes:

- No code verifies the audit hash chain; it is written only.
- `retention_records` is created and listed in `expectedTables`, but no source file reads or writes it.
- Expired `api_sessions` rows are rejected at authentication; no code deletes them. Expired `idempotency_keys` are purged by `DocumentRepository.purgeExpiredIdempotency` (called by the document upload service); nothing purges them when the server starts.

## Erasure and revocation

| Trigger | Path | Effect |
|---|---|---|
| Consent revocation | `ConsentRepository.revoke` (`consent-repository.js:141`), one transaction | Writes `consent_revocations`; cancels pending outbox rows and unfinished OCR jobs; redacts parameter observations of covered documents; calls `eraseDerivedRunData` (which also redacts evidence facts of covered documents); blanks `source_pages` text, digests and provenance; sets documents to `deletion_requested`; revokes tasks, runs and graph snapshots of the grant; audits. |
| Derived run data | `eraseDerivedRunData` (`:236`) | Replaces source page excerpts in `workflow_runs.input_json` with ids plus `redacted: consent_revoked`; nulls task outputs; revokes runs; supersedes graph snapshots; redacts observations per run; one counts-only audit event. Redacts evidence facts sourced from pages of the affected documents (household-scoped when known) with a separate counts-only `evidence.facts_erased` event. Idempotent in effect (a repeat call changes no data, but one that finds referencing runs audits their counts again); bounded to 5,000 runs per call. Fails closed (`ERASURE_NOT_CONFIGURED`) if observations exist and the parameter repository is not wired. |
| Observations by run / document | `redactObservationsForRun`, `redactObservationsForDocument` (`coverage-parameter-repository.js`) | Null `value_json`, record `redacted_at` and a reason; audit counts. |
| Document deletion request | Trigger `coverage_parameter_observations_redact_on_document_erasure` (`005`) | Any move to `deletion_requested` or `deleted` redacts that document's observations, even if the repository is bypassed. |
| Evidence facts by document | `eraseDerivedRunData`; trigger `evidence_facts_redact_on_document_erasure` (`009`) | Null `value_json`, `source_page_id`, `source_locator`, `institutional_source_ref`, `calculation_method`, `permitted_viewers_json`, `effective_at`; set `epistemic_state` UNKNOWN, `redacted_at` and a reason. The trigger redacts on any move to `deletion_requested` or `deleted`, even if the repository is bypassed; migration `010` backfills documents already in those states. |
| Commit-time stop | `stopForRevocation(runId, { reason: 'source_consent_not_current' })` | Runs `eraseDerivedRunData` and stops the run in one transaction; rolls back if erasure fails. |

### Holdings, memory, chat and analytics (048-057)

All of these are derived or household-linked. Code: `src/backend/repositories/memory-erasure.js`, `erasure-repository.js`; `ConsentRepository.revoke` calls `eraseMemoryForConsentGrant` in its transaction (ADR 0032).

| Store | Erased with | Method |
|---|---|---|
| `policy_holdings` | Source document, household | Trigger and `eraseMemoryForDocuments` (deleted with its upload); `eraseMemoryForHousehold` |
| `household_memory_facts`, `member_declarations`, `premium_payments`, `premium_dues` | Consent grant, source document or holding, member (facts and declarations by subject, payer cleared on payments), household | Deleted by the memory-erasure functions; rows carry the grant id they were written under |
| `memory_conflicts` | Holding, household | Deleted |
| `memory_chunks` | Holding, source document, consent grant, household | Deleted, never redacted (plaintext embedding) |
| `chat_threads`, `chat_turns`, `retrieval_traces` | Household, holding, document, consent revocation | A thread whose trace names an erased holding, fact or chunk is deleted whole; turns and traces cascade. A deleted audio document nulls `audio_document_id` |
| `provider_calls` | Household | `DELETE` in `erasure-repository.js` |
| `analytics_outbox` | Household; consent withdrawal | `DELETE` in `erasure-repository.js`; the drain re-checks the grant and deletes unsent rows when it is gone |
| `network_hospitals` | Not applicable | Public reference data, no personal data |

User-data tables from migrations 025 to 029 (device permissions, places, preferences, onboarding, tool scenarios, adult contacts) are described in ADR 0015: values are sealed, every write is audited with ids only, location is stored at about 1 km and expires after 24 hours, and revoking the location permission deletes it. Their wording is a draft **FOR LEGAL REVIEW**.

Gaps:

- Encrypted document bytes: consent revocation marks uploads `deletion_requested`; the document worker (started with the server whenever encrypted storage is configured) removes the bytes and marks the row `deleted` with filename `[deleted]` and a counts-only `document.bytes_deleted` audit event (`document-upload-service.js` `processDocument`, `document-repository.js` `completeDeletion`). A malware hit, tampered ciphertext or a missing object follows the same path. The row stays as a tombstone with the content hash and storage reference replaced by random values. An hourly sweep removes ciphertext and temporary files with no live row once they are an hour old.
- Revocation of a grant does not delete `document_uploads` rows, `consent_*` rows or audit events.
- Evidence facts without a document source (adult statements, institutional replies, calculations) carry no consent grant link, so revocation does not reach them, and a commit-time stop that erases a whole run (no attributable document) does not reach facts either. Redacting a fact does not close open `fact_conflicts` rows that reference it. Revoking a grant erases facts from documents uploaded under it and documents named by id in its scopes, including one another grant also covers (same as observations). A document scope with no `resource_id` is not expanded to every household document. No production code writes evidence facts yet.

### Not built

Planned in the deleted app data plan and still absent from the schema: `claims`, `household_dates`, `reminders`, `household_invites`, desk threads and messages, wallet passes, notification preferences. Each would need sealed columns for personal text, RLS, an erasure path with a test, and (for contacting anyone) a `contact` consent scope through `integration_outbox`. Derived numbers (health score, gaps, projections) are computed in code at read time, not stored.

## Retention

| Item | Status |
|---|---|
| Idempotency keys | Decided: 24 hours (`execution-policy.js`). |
| Sessions | Lifetime from `SESSION_TTL_SECONDS` (default 3600, max 86400). Rows are not purged. |
| Audit events | Kept; no retention period decided. |
| Derived data after consent revocation | Decided: erased (above). |
| Derived data after consent expiry | Open owner decision (review F3, listed in `docs/iterations/LATEST.md` open gaps). Expiry blocks new use but does not erase observations, run excerpts or task outputs. |
| `retention_records` policy, legal holds, deletion SLAs | Not decided. No source names a retention period. |
| `docs/evidence/` in git history | Open owner decision (purge or private repository; `p0-baseline-intake.md` (deleted 2026-11-11)). |

## Backup and restore

Backups and point-in-time recovery follow the Supabase plan; no restore drill has run (ADR 0011, Consequences). Local PostgreSQL: [local-postgres runbook](../runbooks/local-postgres.md). Recovery targets (RPO/RTO): Not decided.
