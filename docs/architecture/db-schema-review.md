# PostgreSQL schema review (migrations 001 to 032)

Status: independent read-only review, 2026-11-07. No code, migration or test was changed. Synthetic data only; no credential appears here. Every migration sketch below is text for discussion, not an applied change, and each new migration still needs its own independent review (AGENTS.md: migration and security changes).

## Scope and method

Sources read: migrations `001` to `032` in `src/backend/database/postgres/migrations/`, `schema-expectations.js`, `validate-schema.js`, `migrate.js`, `src/contracts/data-lifecycle.js`, `docs/architecture/data-lifecycle.md`, ADR 0011 and ADR 0013, `tests/column-audit.test.mjs`, and the repositories in `src/backend/repositories/` (query shapes). The planned 033 and 034 were read from their work-in-progress commits (`38cde69` reference cache, `afe7417` job queue) and the reserved 031 from `3b571a5` (branch `feat/sync-log`).

Catalog facts come from a throwaway local PostgreSQL 17.11 database built from migrations 001 to 032 (C collation, then read-only catalog queries): 65 tables, 2 views, 184 indexes, 115 user triggers, 139 foreign keys (128 `NO ACTION`, 11 `CASCADE`), 0 RLS policies, RLS enabled on every table, 16 `NOT VALID` check constraints.

One measurement: the PL/pgSQL `julianday(text)` port costs about 43 microseconds per call on a column value (100,000 rows: 4.35 s), against about 0.6 microseconds for the plain text comparison of the same ISO-8601 strings (60 ms). This matters wherever `julianday()` sits in a `WHERE` clause over many rows.

## Summary

No P0 found. The schema is unusually defensive (append-only triggers, scope triggers, erasure safety-net triggers, sealed-column checks, Data API lockdown). The main risks are on the erasure paths and the hot paths, where the query shapes do not match the indexes or cannot see sealed data, and in structural tenant scoping, which lives almost entirely in application code and in unlocked trigger reads.

| ID | Priority | Area | Finding |
|---|---|---|---|
| P1-1 | P1 | Erasure | Idempotency records are erased by searching plaintext ids inside `response_json`, which migration 030 now seals, so run and task idempotency records survive erasure until they expire |
| P1-2 | P1 | Erasure, indexes | The document-erasure trigger on `policy_answers` scans and parses every household's answers for each erased document |
| P1-3 | P1 | Hot path | Every sign-in counts all active sessions with a per-row PL/pgSQL `julianday()` under one global lock |
| P1-4 | P1 | FKs, indexes, erasure | 60 foreign keys have no index on the referencing column; erasure's catalog-driven prune and parent deletes seq-scan those tables, including `workflow_events`; `app_events(case_id)` is the known case |
| P1-5 | P1 | Tenant isolation, integrity | The runtime connection owns the tables, so every append-only, scope and erasure trigger can be disabled by the application role; the least-privilege role (ADR 0011 D5) is not applied |
| P2-1 | P2 | Tenant isolation | 39 tables have no `household_id`; the 025 to 028 user-data tables do not check that `member_id` or `adult_user_id` belongs to the row's household |
| P2-2 | P2 | Erasure, concurrency | Insert-guard triggers read the document without a row lock, so a derived row can commit after the erasure triggers ran |
| P2-3 | P2 | Indexes, erasure | Consent revocation scans every `ocr_jobs` row of every household through `CAST(authorization_json AS jsonb)` |
| P2-4 | P2 | Indexes | `julianday()` predicates on queue and sweep paths cannot use their indexes |
| P2-5 | P2 | Constraints | 145 timestamp columns are `text`, most without a format CHECK; 8 newer columns are `timestamptz` |
| P2-6 | P2 | Encryption | Sealed name and text columns have no DB-level sealed check; the 030 checks stay `NOT VALID` on a fresh database |
| P2-7 | P2 | Data API | Functions keep `PUBLIC` execute and the backend lives in the PostgREST-exposed `public` schema |
| P2-8 | P2 | FKs, delete behaviour | Mixed delete semantics (11 `CASCADE`, 128 `NO ACTION`) and the `audit_events` FKs that pin household and case tombstones |
| P2-9 | P2 | Migration hygiene | The runner applies any unapplied file in name order with no out-of-order or duplicate-number guard, and has no path for `CREATE INDEX CONCURRENTLY` |
| P2-10 | P2 | Readiness | 033 and 034 are not registered in the data lifecycle or column audit; 034 has no household or case erasure path |
| P3-* | P3 | Various | Redundant indexes, stale schema expectations, open vocabularies, duplicate-able conflict rows, polymorphic references, unsalted digests, legacy registry tables |

## P1 findings

### P1-1. Idempotency erasure cannot find sealed responses

Evidence:
- `src/backend/repositories/erasure-repository.js:367-377` erases idempotency records by `position(needle IN idempotency_keys.response_json) > 0` for household, case, document, run and task ids, plus two `scope LIKE 'document-upload:...'` patterns.
- Migration `030_seal_remaining_columns.sql:13` and `:55` seal `idempotency_keys.response_json`. Writers seal it: `workflow-repository.js:101-104` (scope `workflow_task`, the stored task includes its input) and `coverage-analysis-port.js:379` and `:482-485`.
- A sealed envelope never contains a plaintext id, so the needle query matches only legacy plaintext rows. Only document-upload records are found reliably, through `document_index` (`document-repository.js:419-429`) and the scope patterns.
- Retention: `workflow-repository.js:84` sets a 24-hour expiry; the row then waits for the purge (`document-repository.js:256-258`) or the sweep.

Impact: after a case or household erasure, sealed run and task idempotency responses (task inputs can carry document excerpts) stay in the database until expiry plus the next purge. They are ciphertext, but the key is live, so this is retained personal data and contradicts invariant 3 and the `idempotency_keys` row of the lifecycle registry. The needle query is also a full scan of the whole table across households inside the erasure transaction. The proof test's canary check cannot see this, because a canary inside ciphertext never appears as plaintext.

Fix: give the table real scope columns, written on insert, and erase by them.

```sql
-- 03x_idempotency_scope_columns.sql (expand-only)
ALTER TABLE public.idempotency_keys ADD COLUMN IF NOT EXISTS household_id text;
ALTER TABLE public.idempotency_keys ADD COLUMN IF NOT EXISTS case_id text;
-- No FK on purpose (same reasoning as app_events): a key must never block an erasure.
CREATE INDEX IF NOT EXISTS idempotency_keys_household_idx ON public.idempotency_keys (household_id) WHERE household_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idempotency_keys_case_idx ON public.idempotency_keys (case_id) WHERE case_id IS NOT NULL;
-- Application: every INSERT sets household_id (and case_id when known); erasure deletes
-- WHERE household_id = ? / case_id = ?. Rows written before this have a 24 h expiry, so no backfill is needed:
-- deploy, wait one TTL, then drop the needle query. Later: a CHECK (household_id IS NOT NULL) NOT VALID for new rows.
```

Add a proof test that seals a `workflow_task` idempotency response, erases the case, and asserts the row count is zero.

### P1-2. The `policy_answers` erasure trigger scans every household

Evidence: `012_policy_evidence.sql:102-110`:

```sql
DELETE FROM public.policy_answers
WHERE EXISTS (SELECT 1 FROM json_array_elements_text(policy_answers.document_ids_json::json) AS cited(value) WHERE cited.value = NEW.id);
```

There is no `household_id` predicate and no index can serve it, so each document that enters `deletion_requested` or `deleted` reads and parses `document_ids_json` of every answer in the database, inside the erasure transaction that holds the household lock. The cost grows with total answers across all tenants, not with the household being erased.

Fix, smallest step: scope the trigger to the document's household. The existing `policy_answers_case_idx (household_id, case_id, created_at)` serves that predicate, so the scan shrinks to one household's answers.

```sql
-- 03x_policy_answers_erasure_scope.sql
CREATE OR REPLACE FUNCTION public.policy_evidence_erase_on_document_erasure_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  DELETE FROM public.policy_answers
  WHERE policy_answers.household_id = NEW.household_id
    AND EXISTS (SELECT 1 FROM json_array_elements_text(policy_answers.document_ids_json::json) AS cited(value)
                WHERE cited.value = NEW.id);
  DELETE FROM public.policy_clauses WHERE document_id = NEW.id;
  RETURN NULL;
END;
$$;
```

Normalised follow-up: a `policy_answer_documents (answer_id, document_id, household_id)` join table with `PRIMARY KEY (answer_id, document_id)`, an index on `document_id` and `ON DELETE CASCADE` from `policy_answers`, filled on insert; the trigger then deletes by `document_id` through the index.

### P1-3. Sign-in counts every active session with PL/pgSQL per row under a global lock

Evidence: `auth-repository.js:26-28`

```sql
SELECT count(*) FROM api_sessions WHERE revoked_at IS NULL AND julianday(expires_at) > julianday(?)
```

runs inside `issueSession`, serialised by `sessionCapacityLock('global')` (`auth-repository.js:8`, `:40`; `locks.js:61`). No index covers it (`api_sessions_token_status_idx` and `api_sessions_adult_status_idx` both lead with another column), and `julianday()` is evaluated for every non-revoked row, expired ones included until the sweep removes them. At the measured 43 microseconds per call, 10,000 live or not-yet-swept sessions cost about 0.4 s per sign-in, with every other sign-in waiting on the same lock. `authenticate` (`:46-51`) is fine: it is driven by the unique `token_sha256`.

Fix: make the predicate sargable and index it. The writer always stores `toISOString()` (fixed width, UTC, `Z`), so with a format CHECK a text comparison is exact under the C collation (ADR 0004 D4).

```sql
-- 03x_session_capacity_index.sql
ALTER TABLE public.api_sessions ADD CONSTRAINT api_sessions_expires_at_format_check
  CHECK (expires_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$') NOT VALID;
-- then, in a separate statement or a later file: ALTER TABLE ... VALIDATE CONSTRAINT api_sessions_expires_at_format_check;
CREATE INDEX IF NOT EXISTS api_sessions_live_expiry_idx ON public.api_sessions (expires_at) WHERE revoked_at IS NULL;
-- Application: WHERE revoked_at IS NULL AND expires_at > ?   (no julianday)
```

If a text comparison is not wanted, `julianday` is `IMMUTABLE`, so `CREATE INDEX ... ON api_sessions (julianday(expires_at)) WHERE revoked_at IS NULL` serves the query unchanged. Product question: a per-adult cap (`api_sessions_adult_status_idx` already fits it) may be the intended limit; a global cap is a cheap denial-of-service lever.

### P1-4. Unindexed foreign keys on the erasure and prune paths

PostgreSQL does not index the referencing side of a foreign key. The catalog shows 60 such FKs (query in the appendix). Two code paths turn them into sequential scans:

1. `erasure-repository.js:464-471` (`#pruneOne`) builds `DELETE ... WHERE <scope> AND NOT EXISTS (SELECT 1 FROM <child> WHERE <fk cols> = t.<pk>)` for every FK read from `pg_constraint`, and repeats the pass until nothing changes (`#pruneItems`, `:451-462`).
2. Every deleted parent row triggers the FK check on each referencing table.

Both run in one erasure transaction under the household advisory lock (`data-lifecycle.md:10`). The ones on erasure paths that matter most, by expected size:

| Referencing column | Parent deleted by erasure | Why it matters |
|---|---|---|
| `workflow_events.workflow_task_id` | `workflow_tasks` | events are the largest workflow table; one scan per pruned task |
| `reviewer_findings.workflow_task_id`, `workflow_tasks.parent_task_id` | `workflow_tasks` | same prune |
| `coverage_parameter_observations.source_id`, `proposed_parameters.source_page_id`, `policy_members.source_page_id` | `source_pages` | per page pruned |
| `policies.source_document_id`, `source_pages.blocks_upgrade_job_id` | `document_uploads`, `ocr_jobs` | document tombstone prune (also the retention sweep) |
| `evidence_facts.household_id`, `evidence_facts.subject_member_id` | household and member erasure | `UPDATE evidence_facts ... WHERE household_id = ?` (`erasure-repository.js:182`) has no usable index; `evidence_facts_case_idx` leads with `case_id` |
| `integration_outbox.case_id`, `human_approvals.case_id` | case erasure deletes by `case_id` (`erasure-repository.js:323-324`) | `human_approvals_consent_case_idx` leads with `consent_grant_id` |
| `policy_structuring_jobs.consent_grant_id`, `case_participants.consent_grant_id` | `consent_grants` prune | |
| `service_cases.opened_by_adult_id`, `document_uploads.uploaded_by_adult_id`, `consent_revocations.revoked_by_adult_id`, `human_reviews.reviewer_adult_id`, `policy_answers.requested_by_adult_id`, `profile_answers.adult_user_id`, `catalogue_reviews.reviewer_adult_id`, `retention_records.requested_by_adult_id`, `household_members.adult_user_id`, `household_roles.adult_user_id` | `adult_users` prune and the "is the adult still referenced" check (`erasure-repository.js:395-398`) | about 15 referencing tables are checked per adult |
| `app_events.case_id` (no FK, known gap, `data-lifecycle.md:130`) | `DELETE FROM app_events WHERE case_id = ?` (`app-event-repository.js:122-124`) | full scan of the telemetry table, which grows with all traffic |

Fix: one index-only migration. Each `CREATE INDEX` takes a `SHARE` lock that blocks writes to that table for the build; on today's synthetic volumes that is milliseconds. For a large production table, use `CREATE INDEX CONCURRENTLY` (needs the runner change in P2-9).

```sql
-- 03x_fk_and_erasure_indexes.sql (expand-only, re-runnable)
CREATE INDEX IF NOT EXISTS workflow_events_task_idx ON public.workflow_events (workflow_task_id) WHERE workflow_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS reviewer_findings_task_idx ON public.reviewer_findings (workflow_task_id) WHERE workflow_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS workflow_tasks_parent_idx ON public.workflow_tasks (parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS coverage_parameter_observations_source_idx ON public.coverage_parameter_observations (source_id);
CREATE INDEX IF NOT EXISTS proposed_parameters_source_page_idx ON public.proposed_parameters (source_page_id);
CREATE INDEX IF NOT EXISTS policy_members_source_page_idx ON public.policy_members (source_page_id) WHERE source_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS policies_source_document_idx ON public.policies (source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS source_pages_blocks_upgrade_job_idx ON public.source_pages (blocks_upgrade_job_id) WHERE blocks_upgrade_job_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_facts_household_idx ON public.evidence_facts (household_id, subject_member_id);
CREATE INDEX IF NOT EXISTS integration_outbox_case_idx ON public.integration_outbox (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS human_approvals_case_idx ON public.human_approvals (case_id);
CREATE INDEX IF NOT EXISTS policy_structuring_jobs_grant_idx ON public.policy_structuring_jobs (consent_grant_id);
CREATE INDEX IF NOT EXISTS case_participants_grant_idx ON public.case_participants (consent_grant_id) WHERE consent_grant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS service_cases_opener_idx ON public.service_cases (opened_by_adult_id);
CREATE INDEX IF NOT EXISTS document_uploads_uploader_idx ON public.document_uploads (uploaded_by_adult_id);
CREATE INDEX IF NOT EXISTS household_members_adult_idx ON public.household_members (adult_user_id) WHERE adult_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS household_roles_adult_idx ON public.household_roles (adult_user_id);
CREATE INDEX IF NOT EXISTS app_events_case_idx ON public.app_events (case_id) WHERE case_id IS NOT NULL;
-- Remaining adult_users referencers (consent_revocations, human_reviews, policy_answers, profile_answers, catalogue_*,
-- retention_records, curated_*) are small today; index them in the same file if the adult prune shows up in a profile.
-- Add the new names to schema-expectations.js criticalIndexes.
```

Leave out FKs whose child table is tiny or global (`insurers`, `coverage_parameter_registry_versions`, curated operator tables) unless measured.

### P1-5. The runtime role owns the tables, so every trigger guard is bypassable

Evidence: ADR 0011 D5 and D10 ("The connection role owns the tables and bypasses RLS"); ADR 0013 D7 shows the backfill legitimately doing `ALTER TABLE ... DISABLE TRIGGER`; `LATEST.md` lists the least-privilege role as open. `scripts/sql/db-roles.sql` prepares `knowvia_runtime` but it is not applied.

Impact: the append-only ledgers (`audit_events`, `evidence_facts`, observations, structuring runs and jobs), the scope triggers that are the only database-level tenant check for most derived tables, and the erasure safety-net triggers can all be disabled, dropped or truncated by whoever holds the application connection string. A SQL-injection or a compromised process gets DDL. `REVOKE TRUNCATE ... FROM PUBLIC` (003, 007, 010) does not affect the owner.

Fix (no schema change; infrastructure-sensitive, owner approval needed): apply `db-roles.sql` so `knowvia_migrator` owns the schema and `knowvia_runtime` has DML only, no `BYPASSRLS`, no `TRIGGER`, no `TRUNCATE`; point `DATABASE_URL` at the runtime role and `MIGRATION_DATABASE_URL` at the migrator. Once that holds, ADR 0013 D11 can be re-opened: per-household RLS policies become possible (see P2-1). Add a `validatePostgresSchema` check that `current_user` does not own the tables in production.

## P2 findings

### P2-1. Tenant scope is structural only at the top of the tree

Evidence: 39 of 65 tables have no `household_id` (catalog). Household-owned children without it include `ocr_jobs`, `source_pages`, `workflow_runs`, `workflow_tasks`, `workflow_events`, `human_reviews`, `human_approvals`, `integration_outbox`, `release_gates`, `reviewer_findings`, `case_participants`, `consent_scopes`, `consent_revocations`, `fact_conflicts`, `coverage_graph_nodes`, `coverage_graph_edges`, `policy_members`, `idempotency_keys` and the `coverage_parameter_*` children. Isolation for them is a join chain in each repository plus insert-time scope triggers (002) that read parents without locks (002 header, lines 17-19).

The newer user-data tables carry `household_id` but nothing ties their other references to it: `household_places` (`026:12-14`) accepts a `member_id` of another household; `device_permissions`, `adult_preferences`, `onboarding_progress` and `tool_scenarios` (`025`, `027`, `028`) accept any `adult_user_id` with any `household_id`; `profile_answers` checks case against household (`018:25-36`) but not the adult. `document_blobs.household_id` is not checked against the document.

Impact: a single repository bug (a missing `household_id` predicate or a wrong id from a request) is not caught by the database. RLS cannot help (no policies, owner bypass).

Fix, in order of value:
1. Composite FKs on the new tables (expand-only, cheap):

```sql
ALTER TABLE public.household_members ADD CONSTRAINT household_members_household_id_id_key UNIQUE (household_id, id);
ALTER TABLE public.household_places
  ADD CONSTRAINT household_places_member_same_household_fkey
  FOREIGN KEY (household_id, member_id) REFERENCES public.household_members (household_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.household_places VALIDATE CONSTRAINT household_places_member_same_household_fkey;
-- adult_user_id vs household: an adult can belong to several households, so use a BEFORE INSERT OR UPDATE trigger
-- that requires a household_roles row (same shape as catalogue_reviewer_grants_scope_insert_fn, 013:80-95).
```

2. For the large children (`ocr_jobs`, `source_pages`, `workflow_runs`, `workflow_tasks`, `workflow_events`), add a nullable `household_id`, write it in the application, backfill in batches from the parent, then `CHECK (household_id IS NOT NULL) NOT VALID` plus `VALIDATE`, then a composite FK `(household_id, document_upload_id) REFERENCES document_uploads (household_id, id)`. This also gives erasure a direct index instead of nested `IN (SELECT ...)` scopes (`data-lifecycle.js:52-55`).
3. After P1-5, per-household RLS policies keyed on a transaction-local setting (`current_setting('app.household_id', true)`) as a second wall. Decision for the owner (ADR 0013 D10 and D11).

### P2-2. Insert guards race with erasure

Evidence: guards such as `policy_clauses_scope_insert_fn` (`012:24-40`), `proposed_parameters_active_document_insert_fn` (`007:197-208`), `policy_structuring_runs_active_document_insert_fn` (`007:105-116`), `catalogue_reviews_scope_insert_fn` (`013:41-63`) and `evidence_facts_erased_document_insert_fn` (`006:7-19`) check `document.lifecycle_state = 'active'` with a plain `SELECT`. Under READ COMMITTED, a transaction that inserts a clause and a concurrent erasure that flips the document to `deletion_requested` can both commit: the erasure's AFTER triggers delete the clauses they can see, and the new clause commits afterwards, pointing at an erased document. The application closes this by taking the household advisory lock on both paths; a direct SQL writer, a script, or a future worker that forgets the lock does not.

Fix: lock the parent row in the guard so the two transactions serialise. `FOR SHARE` conflicts with the `UPDATE` of `lifecycle_state` (`FOR KEY SHARE` does not).

```sql
CREATE OR REPLACE FUNCTION public.policy_clauses_scope_insert_fn() RETURNS trigger LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM public.document_uploads WHERE id = NEW.document_id FOR SHARE;
  IF NOT EXISTS ( ...unchanged predicate... ) THEN
    RAISE EXCEPTION 'policy clause must match an active document of its case and household';
  END IF;
  RETURN NEW;
END;
$$;
-- Same one-line addition in each "active document" guard listed above. Same function names, so the catalog-parity
-- test and trigger names do not change.
```

### P2-3. Revocation scans every OCR job of every household

Evidence: `consent-repository.js:262` and `:295` select and update `ocr_jobs WHERE CAST(authorization_json AS jsonb) ->> 'consentGrantId' = ?`. No index can serve it, each row's JSON is parsed, and the scan is cross-tenant inside the revocation transaction.

Fix: promote the id to a column.

```sql
ALTER TABLE public.ocr_jobs ADD COLUMN IF NOT EXISTS consent_grant_id text REFERENCES public.consent_grants (id) NOT VALID;
CREATE INDEX IF NOT EXISTS ocr_jobs_consent_grant_idx ON public.ocr_jobs (consent_grant_id) WHERE consent_grant_id IS NOT NULL;
-- Application writes it with authorization_json; backfill from authorization_json in batches; then query by the column.
-- Interim alternative without app change: CREATE INDEX ON ocr_jobs ((CAST(authorization_json AS jsonb) ->> 'consentGrantId'));
```

### P2-4. `julianday()` predicates defeat the queue and sweep indexes

Evidence (all `julianday(column) <op> julianday(?)`):
- `document-repository.js:230` and `:235` (scan and deletion work list) against `document_uploads_work_idx (lifecycle_state, malware_status, next_scan_at)`: the leading equality columns are used, the time filter is evaluated per row.
- `document-repository.js:258` and `retention-service.js:86` (idempotency purge and its count) cannot use `idempotency_keys_expiry_idx (expires_at)` at all.
- `workflow-repository.js:157`, `:181`, `:269`, `:278` (task claim and lease recovery) evaluate it per candidate row.
- `household-repository.js:92-103`, `auth-identity-repository.js:67-68`, `consent-repository.js:99-189` are per-row checks on already-selected rows (fine).

Fix: the same pattern as P1-3, one column at a time: add a format CHECK (`NOT VALID`, then `VALIDATE`), then compare text, or add an expression index on `julianday(col)` where changing the query is not wanted. Start with `idempotency_keys.expires_at` and `workflow_tasks.lease_expires_at`.

### P2-5. Timestamps are untyped text, mostly without a format check

Evidence: 145 `*_at`/`*_on` columns are `text`; 8 are `timestamptz` (`app_events`, `evidence_claims`, `model_budget_*`). Format checks exist only on redaction and erasure stamps (`005:13`, `006:30`, `007:26`, `010:40`). `api_sessions` and `auth_identities` CHECKs (`001:629-630`, `017:16`) pass when `julianday()` returns NULL for garbage. Ordering such as `ORDER BY coalesce(next_scan_at, uploaded_at)` (`document-repository.js:231`) is only correct if every writer uses the same format.

Impact: correctness depends on every writer calling `toISOString()`; comparisons need P1-3 and P2-4 workarounds; two time models now coexist (text ISO strings and `timestamptz` with `now()`), which makes joins and lease logic across them error-prone.

Fix: short term, a domain and `NOT VALID` checks, validated afterwards:

```sql
CREATE DOMAIN public.utc_ms_text AS text
  CHECK (VALUE ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$');
-- Changing a column's type to the domain rewrites nothing but takes ACCESS EXCLUSIVE and checks every row;
-- for big tables prefer per-column CHECK ... NOT VALID + VALIDATE CONSTRAINT.
```

Long term (ADR needed): new tables use `timestamptz` (as 022, 023, 032 and the 033/034 drafts already do); old columns move by expand and contract (add `*_ts timestamptz`, dual-write, backfill, switch reads, drop later).

### P2-6. Sealed text columns have no database-level guarantee

Evidence: `021:5-7` and `030:22-23`: name and free-text columns (`adult_users.display_name`, `contact_email`, `contact_phone`, `households.display_name`, `household_members.display_name`, `relationship_label`, `date_of_birth`, `source_pages.extracted_text`, `policy_clauses.title`, `policy_clauses.text`, `document_uploads.original_filename`, `policies.policy_number_masked`, `starts_on`, `ends_on`, `policy_members.member_reference_masked`, `ocr_jobs.error_message`, `workflow_tasks.last_error_message`, `integration_outbox.last_error`, `integration_webhook_events.processing_error`, `coverage_graph_nodes.label`, `entity_ref`, `reviewer_findings.message`, `resolution_note`, `consent_revocations.reason`) accept plaintext. JSON columns accept `enc` or valid JSON, so plaintext JSON is also still writable. `tests/column-audit.test.mjs` proves classification, not that values are sealed.

The 16 checks from 030 stay `NOT VALID` on any database where `scripts/encrypt-existing-rows.mjs` has not run (`column-backfill.js:114`), including every fresh environment.

Fix: once every environment is backfilled and `DATA_ENCRYPTION_LEGACY_PLAINTEXT=false`, add one migration per group:

```sql
ALTER TABLE public.household_members ADD CONSTRAINT household_members_display_name_sealed_check
  CHECK (display_name ~ '^enc[12][.]' OR display_name = '[erased]') NOT VALID;   -- ERASED_NAME, data-lifecycle.js:31
ALTER TABLE public.household_members VALIDATE CONSTRAINT household_members_display_name_sealed_check;
-- JSON columns: tighten "IS NULL OR enc OR IS JSON" to "IS NULL OR enc" the same way.
```

And make `db:init` validate pending `NOT VALID` constraints when the table is small (or report them in `/ready`), so a fresh database does not keep unvalidated checks forever.

### P2-7. Data API surface beyond tables

Evidence: `016:25-34` revokes table and sequence privileges and default privileges for `anon` and `authenticated`, and `validate-schema.js:111-121` checks tables and views. Functions keep the default `PUBLIC` execute (ADR 0011 D10). The backend lives in `public`, which Supabase exposes through PostgREST, so `julianday` and `coversaath_utc_now` are callable at `/rest/v1/rpc/...`, and 031 adds `attach_household_sync` and `sync_now_text_fn`. The default-privilege revoke applies only to objects created by the role that ran 016, so a migration run by another role is not covered. Views are not `security_invoker` and run as the owner (bypassing RLS); the revoke is what protects them.

Impact today is low (pure helpers, `SECURITY INVOKER`, no `SECURITY DEFINER` anywhere), but the protection depends on every later migration remembering the revoke.

Fix (owner decision): remove `public` from the Supabase "exposed schemas" setting, or move the backend to a dedicated schema that PostgREST does not expose (ADR 0011 already plans per-service schemas). Cheaper interim: `ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` plus explicit grants to the runtime and migrator roles, and extend `validatePostgresSchema` to report functions executable by `anon`.

### P2-8. Delete behaviour is inconsistent, and audit FKs pin tombstones

Evidence: 128 FKs are `NO ACTION`, 11 are `ON DELETE CASCADE` (`025:9-10`, `026:12-14`, `027:8-9,18-19`, `028:7-8`). Erasure deletes explicitly and reads FKs from the catalog, so the cascades are never the erasure mechanism; they only matter for an ad-hoc `DELETE FROM adult_users`, which the other 120-odd FKs block anyway. `audit_events.household_id` and `case_id` (`001:606-607`) reference `households` and `service_cases`, so those rows can never be deleted (`data-lifecycle.md:12-19`, open owner decision).

Fix: write the rule down in an ADR: "no `CASCADE` on household data; erasure deletes explicitly", and stop adding cascades (or the reverse, consistently). For audit: drop the two `audit_events` FKs and keep the ids as plain references, like `app_events` (022:6-7). That is an append-only audit table, so it needs an independent review, but the DDL is small:

```sql
ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_household_id_fkey;
ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_case_id_fkey;
-- Hash chain and append-only triggers are unaffected. Erasure can then delete household and case tombstones
-- once nothing else refers to them; adult tombstones still need the separate service_cases.opened_by_adult_id decision.
```

### P2-9. Migration ordering and lock-safe DDL

Evidence:
- `migrate.js:32-34` sorts by file name and `:115-117` applies every file not in `schema_migrations`. There is no check that a pending file is newer than the newest applied one, and no check against two files with the same number (the version key is the whole file name).
- 031 is a deliberate gap reserved by `feat/sync-log` (`3b571a5`, its header says numbers need not be contiguous). If 031 lands after 032, 033 and 034 are applied somewhere, it runs last there and first on a fresh database: the two environments then apply the same files in different orders. 031 attaches triggers to the 025 to 029 tables, so it is order-sensitive. The 033 draft's header still says "migration 032 on its branch".
- Each file runs in one transaction (`migrate.js:55-73`), so `CREATE INDEX CONCURRENTLY` and `VALIDATE CONSTRAINT` outside the DDL transaction are impossible in a migration file. 024 built two indexes non-concurrently (fine at today's size); P1-4's indexes on a large `app_events` or `workflow_events` would block writes.
- Strengths: checksums make applied files immutable; one advisory lock serialises runners; the pool's `lock_timeout` bounds DDL waits; 016 onwards is re-runnable; 030 adds checks `NOT VALID`.

Fix:
1. In the runner, refuse a pending file whose numeric prefix is below the highest applied prefix unless it is listed in an explicit allow-list (for 031), and refuse two files with the same prefix.
2. Support a header such as `-- migrate: no-transaction` that runs the file statement by statement outside a transaction (for `CREATE INDEX CONCURRENTLY IF NOT EXISTS` and `VALIDATE CONSTRAINT`); record it in `schema_migrations` only after the last statement succeeds, and require every statement in such a file to be re-runnable.
3. Rollback story: expand-only plus "old code ignores the new object" is the right default. Write a down note in each file header (as 010, 033 and 034 do) and keep `docs/runbooks/migration-030-rollback.md` as the pattern for anything that changes existing columns.

### P2-10. Readiness of 033 (reference cache) and 034 (job queue)

Both drafts follow house style (expand-only, `IF NOT EXISTS`, RLS on, API roles revoked, `timestamptz`, database-time leases). Gaps before they merge:

- Registry and audit: neither commit touches `src/contracts/data-lifecycle.js` or `tests/column-audit.test.mjs`. `tests/data-erasure-proof.test.mjs` fails a build with an unclassified table, and the column audit fails on unlisted columns (`reference_cache.body`, `etag`, `signature`, `status`; `job_queue.kind`, `payload_json`, `dedupe_key`, `status`, `locked_by`, `last_error_code`, `attempts`, `max_attempts`). They probably pass on their own branches only because those branches predate S3 and D2. Rebase on main and classify: `reference_cache` and `reference_cache_leases` as `global`; `job_queue` as `delete` with scope `household_id = ?`.
- 034 erasure: the header says revocation and document erasure delete jobs (`ConsentRepository`), but household and case erasure (`erasure-repository.js`) are not touched. Add `DELETE FROM job_queue WHERE household_id = ?` to household erasure and a document-id based delete to case erasure, with a proof test. Rows hold identifiers only, so the residue is ids, but invariant 3 requires the path.
- 034 constraints: `payload_json` is only length-checked; add `payload_json IS JSON OBJECT`. Add `CHECK (attempts <= max_attempts)`. `succeeded` and `dead` rows accumulate: add a retention purge and `CREATE INDEX ... (finished_at) WHERE status IN ('succeeded','dead')`. Consider a `case_id` column so case erasure is direct.
- 034 boundaries: the schema would then hold four lease-and-retry mechanisms (`workflow_tasks` leases, `ocr_jobs`, `policy_structuring_jobs`, `job_queue`). Record in an ADR which work moves to `job_queue` and which stays, so the next migration does not add a fifth.
- 033 key shape: the header says the key check "refuses ... anything that looks like a policy number", but `^[a-z0-9][a-z0-9._:/-]*$` accepts `policies/123456789012`. Either reword the comment or enforce the rule in the port with a test; the database cannot tell a public product code from a policy number. Add `CHECK (stale_after > fetched_at)`. `body jsonb` is the first `jsonb` column; fine for public data, keep it out of household tables (sealed columns are text).
- Numbering: 031 (`feat/sync-log`), 033 and 034 are open on three branches. Agree the order before merging (P2-9), and update the 033 header comment.

## P3 findings

- **Redundant indexes.** `coverage_graph_case_idx (case_id, version DESC)` duplicates `UNIQUE (case_id, version)` (`001:400`, `:785`); `coverage_parameter_records_run_idx` duplicates `UNIQUE (workflow_run_id, parameter_key)` (`001:673`, `:825`); `api_sessions_token_status_idx` (`001:819`) adds little over the unique `token_sha256`. Drop them in a later migration after checking `pg_stat_user_indexes` in a real environment.
- **Index shape.** `AppEventRepository` lists a household's events `ORDER BY id DESC` (`app-event-repository.js:107`) while the index is `(household_id, occurred_at)` (`022:37`): order by `occurred_at DESC, id DESC` or index `(household_id, id)`.
- **Stale schema expectations.** `criticalTriggers` misses 23 live triggers, among them the erasure safety net `policy_evidence_erase_on_document_erasure`, `policy_clauses_scope_insert`, `policy_answers_scope_insert` and all `*_no_truncate` guards; `criticalIndexes` and `requiredColumns` stop around 017 to 023. The catalog-parity test freezes the full catalog, so tests catch drift, but `/ready` and `db:init` do not. Add the missing names.
- **Open vocabularies where a closed one is expected.** `document_uploads.mime_type` has no CHECK and `original_filename` no length cap; `consent_scopes.data_category`, `retention_records.retention_basis`, `human_approvals.target_type`, `workflow_events.event_type`, `coverage_graph_edges.relationship` and `integration_outbox.operation` are free text. Add shape checks (`~ '^[a-z0-9_.-]{1,64}$'`) or closed lists, `NOT VALID` then `VALIDATE`.
- **Duplicate-able rows.** `fact_conflicts` allows the same pair twice and both orders (only `left <> right`, `001:388`); add `UNIQUE (least(left_fact_id, right_fact_id), greatest(left_fact_id, right_fact_id))` as an expression index. `coverage_graph_edges` has no uniqueness either.
- **Nullability and coupling.** `service_cases` allows an amount without a currency and the reverse; `currency` is not checked for upper case. `household_members` allows a dependent with an `adult_user_id`. `fact_conflicts.resolved_by_review_id` has no FK.
- **Polymorphic references** without FK: `consent_scopes.resource_id`, `human_approvals.target_id`, `retention_records.resource_id`, `evidence_facts.permitted_viewers_json` (adult ids in JSON, not cleared when an adult is erased), `policy_answers.document_ids_json` (see P1-2), `catalogue_reviews.clause_ids_json`. Known design; erasure must keep reaching them by id.
- **Unsalted digests of document content.** `document_uploads.content_sha256`, `source_pages.page_sha256` and `text_sha256`, `policy_clauses.digest` are plain SHA-256. For short or guessable text a digest confirms content without the key. Low risk for whole PDFs; consider an HMAC for clause and page text digests.
- **Latent erasure gaps in unwritten stores.** `integration_webhook_events` (classified `global`), `coverage_graph_*` and `reviewer_findings` are marked `unwritten` in `column-backfill.js:57-60`. A provider webhook (for example an OCR callback) would carry document-derived data with no household key. Add `household_id` and `document_id` before the first writer ships.
- **Legacy registry tables.** The seven `coverage_parameter_*` tables and `proposed_parameters` belong to the 138-parameter registry that the evidence-first direction (ADR 0008) replaced. Decide whether they are retired (stop writing, keep for erasure, drop later) so new work does not build on them.
- **`document_blobs` has no FK** by design (`020:7-11`, ADR 0013 D8). If intake ever writes the bytes and the row in one transaction, a `DEFERRABLE INITIALLY DEFERRED` FK to `document_uploads` would replace the orphan sweep.
- **Normalisation is otherwise sound.** Tables follow clear aggregate boundaries (household, case, document, run), closed vocabularies are enforced with CHECK lists, JSON is used for payloads rather than for queried attributes (except the cases in P1-2 and P2-3), and append-only stores redact in place instead of deleting.

## Area notes

1. **Normalisation and boundaries.** Good aggregates; the weak spots are id lists in JSON that SQL must search (P1-2, P2-3), the missing `household_id` below the top level (P2-1), and four overlapping job mechanisms (P2-10).
2. **Foreign keys, delete behaviour, orphans, erasure.** Every derived store has an erasure path in the registry; the safety-net triggers on `document_uploads` cover facts, observations, structuring, blocks, clauses, answers, reviews and blobs. `source_pages.extracted_text` and `ocr_jobs.result_json` are cleared by repository code only (`document-repository.js:363-365`, `consent-repository.js:290,336`), not by a trigger; a direct `UPDATE` of `lifecycle_state` would leave OCR text. Consider adding them to a safety-net trigger. Gaps: P1-1, P2-2, P2-8, P2-10, the unwritten stores in P3.
3. **Indexes.** P1-3, P1-4, P2-3, P2-4, the P3 redundancies. No duplicate non-unique indexes beyond the two listed.
4. **Constraints.** Strong closed-vocabulary and state-machine checks; weak on timestamps (P2-5), sealed text (P2-6) and a few free-text vocabularies (P3).
5. **Tenant isolation.** `household_id` is `NOT NULL` with an FK on every table that has it, except `audit_events` (nullable, by design) and `app_events` (no FK, by design). RLS is deny-by-default against the Data API only. Isolation inside the backend is application code plus insert triggers (P1-5, P2-1, P2-2, P2-7).
6. **Encryption.** Column coverage matches ADR 0013 and its D2 addendum; the column audit classifies every column. Gaps are enforcement (P2-6), erasure that searches sealed data (P1-1), and unsalted digests (P3).
7. **Migration hygiene.** Append-only by checksum, serialised, bounded lock waits, expand-only. Gaps: ordering and duplicate guards, no non-transactional path, `NOT VALID` checks left unvalidated on fresh databases (P2-6, P2-9).
8. **Readiness for 033 and 034.** P2-10.

## Suggested order

1. P1-2 (one function replace) and P1-4 (one index-only migration, including `app_events(case_id)`).
2. P1-1 (two columns, application change, proof test).
3. P1-3 and P2-4 (format checks and sargable predicates, starting with sessions, idempotency and leases).
4. P2-9 runner guards before 031, 033 and 034 merge; then P2-10 fixes on those branches.
5. P1-5 role split (owner approval, infrastructure), then the P2-1 composite FKs and the RLS decision.

## Not verified

- No query was run against Supabase or any non-local database. Sizes and costs are reasoned from query shapes plus the one `julianday` micro-benchmark; no `EXPLAIN ANALYZE` on realistic volumes was run.
- The idempotency erasure gap (P1-1) is read from code; no failing test was written.
- The trigger race (P2-2) is reasoned from READ COMMITTED semantics; it was not reproduced.
- The 031, 033 and 034 drafts were read from unmerged commits and may have changed on their branches.

## Appendix: catalog query for unindexed foreign keys

```sql
SELECT c.conrelid::regclass AS tbl, string_agg(a.attname, ',' ORDER BY x.n) AS cols, c.confrelid::regclass AS ref
FROM pg_constraint c
CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS x(attnum, n)
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = x.attnum
WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace
  AND NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = c.conrelid
      AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] @> c.conkey
      AND (i.indkey::int2[])[0:array_length(c.conkey, 1) - 1] <@ c.conkey)
GROUP BY c.oid, c.conrelid, c.confrelid ORDER BY 1, 2;
```
