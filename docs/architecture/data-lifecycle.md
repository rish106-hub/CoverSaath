# Data lifecycle: erasure, export and retention (S3)

Status: implemented locally, uncommitted. Synthetic data only. **Everything here that reads like a retention period, a legal basis or user-facing wording is a placeholder FOR LEGAL REVIEW. It is not legal advice and nothing in it is final.**

Code: `src/contracts/data-lifecycle.js` (registry, the single list), `src/backend/repositories/erasure-repository.js`, `src/backend/services/data-lifecycle-service.js`, `data-export-service.js`, `retention-service.js`, `src/server/routes/data-lifecycle-routes.js`, `scripts/retention-sweep.mjs`.
Proof: `tests/data-erasure-proof.test.mjs` (SQL proof), `tests/data-erasure-api.test.mjs` (routes, authorisation, export, sweep).

## What erasure means here

Deterministic code erases; no model decides. One transaction per request under the household advisory lock: all or nothing. Order inside: withdraw consents (household erasure only), erase documents through the existing document path, erase runs and derived stores, scrub content, delete rows nothing refers to, write the deletion-ledger row, append a counts-only audit event.

Rows that must stay are **content-free tombstones**, for two reasons that exist in the schema today:

1. `audit_events` is append-only and has foreign keys to `households` and `service_cases`. Those two rows (and the adult row a case tombstone names) cannot be deleted without dropping those foreign keys.
2. Append-only tables (`evidence_facts`, parameter observations, structuring runs and jobs, proposed parameters, registry pins) cannot be deleted. Their content is redacted in place through the narrow update their triggers allow. Rows they point at (document, page, policy, member, run, grant) stay as scrubbed tombstones.

A tombstone holds ids, enumerations, digests and timestamps. The proof test checks that every remaining row is content-free and that no canary string appears in any column of any table.

**Open decision for the owner (ADR needed, not done here):** drop the two audit foreign keys so household, case and adult tombstones can be deleted too. That changes an audit-adjacent schema and needs an independent review. Until then the residue above is the floor.

## Operations

| Operation | Who | Route | Notes |
|---|---|---|---|
| Erase case | owner, operator, backup operator, or the case opener with a writing role | `POST /api/v1/cases/{id}/erasure` body `{"confirm":"<case id>"}` | the case answers 404 afterwards (ledger) |
| Erase member | owner or member role | `POST /api/v1/households/{id}/members/{memberId}/erasure` | owner and account holders: 409 `MEMBER_PROTECTED` (use household erasure). Records about the member and cases whose subject is the member go. Text inside uploaded documents that mentions the member is document content: erase the document or the case. |
| Erase household | owner only | `POST /api/v1/households/{id}/erasure` | revokes every grant (audit actor is the owner), erases all cases, user data, sessions and identities of adults who belong to no other household |
| Export | any household role, own data | `GET .../households/{id}/export`, `.../cases/{id}/export`, `.../members/{memberId}/export` | see Export |
| Retention sweep | operator script, not an HTTP route | `npm run retention:sweep [-- --apply]` | dry run by default |

Erasure does not need current processing consent: a person must always be able to erase their data. A foreign or missing id answers 404. Bytes in document storage are removed after the transaction by the document worker; until then the status is `erasure_pending_storage` (HTTP 202), then the tombstones are pruned. A second call is 404.

## Table-by-table map

Kinds: `delete` rows removed; `scrub_prune` content scrubbed, then the row is removed when no other row refers to it (foreign keys are read from the catalog); `redact_only` append-only, redacted in place; `tombstone` row stays by design; `audit_retained` codes and counts only; `ledger` the deletion ledger (`retention_records`); `global` not household data. A test fails when a live table is missing from the registry.

| Table | Erasure | Export section | Treatment |
|---|---|---|---|
| `households` | tombstone | household | Name overwritten, status closed; the row stays because audit_events points at it. |
| `adult_users` | scrub_prune | viewer | Reached by adult id. Name, e-mail, phone, ciphertext and hashes cleared; account closed. Stays as a tombstone while a case tombstone names the adult. |
| `household_roles` | delete | - | Deleted. |
| `household_members` | scrub_prune | members | Name, label and date of birth cleared; deleted unless an append-only fact or parameter record names the member. |
| `api_sessions` | delete | - | Reached by adult id. Deleted for adults who belong to no other household. |
| `auth_identities` | delete | - | Reached by adult id. Deleted for adults who belong to no other household. |
| `consent_grants` | scrub_prune | consents | All grants revoked, then deleted unless an append-only structuring job still names the grant. |
| `consent_scopes` | scrub_prune | consents | Deleted with the grant. |
| `consent_revocations` | scrub_prune | consents | Free-text reason cleared; deleted with the grant. |
| `service_cases` | tombstone | cases | Case facts overwritten, status closed; the row stays because audit_events points at it. Hidden through the ledger. |
| `case_participants` | delete | - | Deleted. |
| `workflow_runs` | scrub_prune | runs | Input cleared, run revoked; deleted unless an append-only record names the run. |
| `workflow_tasks` | scrub_prune | - | Input, output and error text cleared; deleted with the run. |
| `workflow_task_dependencies` | delete | - | Deleted. |
| `workflow_events` | delete | - | Deleted. |
| `reviewer_findings` | delete | - | Deleted (messages can quote evidence). |
| `release_gates` | delete | - | Deleted. |
| `human_reviews` | delete | - | Deleted. |
| `human_approvals` | delete | - | Deleted. |
| `integration_outbox` | delete | - | Deleted (payloads are outgoing provider requests). |
| `coverage_graph_snapshots` | scrub_prune | - | Graph cleared; deleted when nothing refers to it. |
| `coverage_graph_nodes` | delete | - | Deleted. |
| `coverage_graph_edges` | delete | - | Deleted. |
| `document_uploads` | scrub_prune | documents | Erased through the document path (bytes removed, name and hash replaced); the row is deleted once the bytes are gone and nothing refers to it. |
| `document_blobs` | delete | - | Encrypted bytes deleted by the document erasure trigger. |
| `ocr_jobs` | scrub_prune | - | Result and authorisation cleared; deleted with the document. |
| `source_pages` | scrub_prune | - | Text and blocks cleared; deleted with the document unless an append-only record names the page. |
| `policy_clauses` | delete | - | Deleted. |
| `policy_answers` | delete | - | Deleted. |
| `catalogue_reviews` | delete | - | Deleted. |
| `catalogue_reviewer_grants` | delete | - | Deleted. |
| `policies` | scrub_prune | policies | Insurer, number, dates cleared; deleted unless a fact or parameter record names the policy. |
| `policy_members` | delete | - | Deleted. |
| `evidence_facts` | redact_only | facts | Append-only. Value, locator and source redacted; key, state and ids stay. |
| `fact_conflicts` | delete | - | Deleted. |
| `coverage_parameter_records` | scrub_prune | - | Identity is immutable; deleted unless an append-only observation names the record. |
| `coverage_parameter_acquisitions` | delete | - | Deleted. |
| `coverage_parameter_resolutions` | delete | - | Deleted (resolved values are derived data). |
| `coverage_parameter_observations` | redact_only | - | Append-only. Value redacted; ids and digests stay. |
| `coverage_parameter_registry_pins` | redact_only | - | Immutable. Holds a run id and a registry version only. |
| `policy_structuring_runs` | redact_only | - | Append-only. Stamped erased; ids and counts stay. |
| `policy_structuring_jobs` | redact_only | - | Append-only. Stamped erased; ids and status stay. |
| `proposed_parameters` | redact_only | - | Append-only. Label and value cleared. |
| `profile_answers` | delete | profileAnswers | Deleted. |
| `device_permissions` | delete | userData | Deleted. |
| `household_places` | delete | userData | Deleted. |
| `adult_preferences` | delete | userData | Deleted. |
| `onboarding_progress` | delete | userData | Deleted. |
| `tool_scenarios` | delete | userData | Deleted. |
| `app_events` | delete | - | Deleted by household, case and adult id. |
| `idempotency_keys` | delete | - | Reached by the ids a response mentions. Responses can carry document names and job content. |
| `retention_records` | ledger | - | The deletion ledger. Reason code and times only. |
| `audit_events` | audit_retained | audit | Append-only hash chain; codes and counts only. |
| `insurers` | global | - | Reference data shared by every household. |
| `integration_webhook_events` | global | - | Provider events without a household key (operator data). |
| `model_budget_scopes` | global | - | Process-wide spend counters. |
| `model_budget_reservations` | global | - | Process-wide spend counters. |
| `rate_limit_buckets` | global | - | Keyed request counters; the key is a keyed hash. |
| `schema_migrations` | global | - | Migration ledger. |
| `coverage_parameter_registry_versions` | global | - | Registry reference data. |
| `coverage_parameter_observation_rules` | global | - | Rule reference data. |
| `curated_source_archives` | global | - | Public insurer wording collected by operators; no household link. |
| `curated_product_submissions` | global | - | Operator-curated public product data; names the curator adult only. |
| `curated_action_nonces` | global | - | Operator signed-action nonces. |
| `source_curator_grants` | global | - | Operator role grants; names the curator adult only. |

For the synthetic fixture the proof test pins the exact residue after a household erasure: household, case, 2 members, 1 grant, 1 run, 1 document with its OCR job and page, 1 policy, 2 facts, 1 parameter record and observation, 1 registry pin, 1 structuring run and job, 1 proposed parameter, 2 ledger rows and the audit chain. All content-free.

## Export

Returns the caller's own data. Other adults' places, preferences, scenarios and answers are never included; a date of birth follows the existing field-consent rule; fact values show only when the caller stated them; the audit trail is included for the owner only. Excluded everywhere (counts only): document bytes, OCR text and clauses, model prompts and outputs, credentials. Each export appends a counts-only audit event. A case export needs the same field permission as reading the case. FOR LEGAL REVIEW: whether this satisfies an access request.

## Retention registry (placeholders, FOR LEGAL REVIEW)

Retention is configuration. An unset variable means not scheduled and the sweep does nothing for it. The placeholder is a suggestion, never a default.

| Variable | Applies to | Action | Placeholder |
|---|---|---|---|
| `RETENTION_CLOSED_CASE_DAYS` | cases that are closed or revoked | erase the case | 365 days |
| `RETENTION_INACTIVE_HOUSEHOLD_DAYS` | households with no activity | erase the household | 730 days |
| `RETENTION_EXPIRED_SESSION_DAYS` | expired or revoked API sessions | delete the session | 30 days |
| `RETENTION_DELETED_DOCUMENT_DAYS` | document tombstones whose bytes are gone | delete the tombstone when nothing refers to it | 0 days |
| `RETENTION_ERASURE_LEDGER_DAYS` | deletion ledger rows | reported only (never deleted by the sweep) | 1825 days |

Always on, from values stored on each row: expired activity events (`APP_EVENTS_RETENTION_DAYS`, default 30), expired idempotency keys, expired current locations. The sweep is bounded (100 per rule per run), idempotent, acts as the system actor `retention-sweep` and reports counts only. It never deletes the ledger. Open question for legal: statutory retention of consent and processing logs may require keeping more than the counts-only audit chain.

## Known gaps

- Free-text consent revocation reasons are stored in `consent_revocations.reason` and in the `consent.revoked` audit payload by the existing revoke route. Erasure clears the table column; the audit payload is append-only and stays. Follow-up: restrict the route to a reason code.
- Account-holder self-erasure (one adult leaving one household) is not built. Household erasure covers adults who belong to no other household.
- Backups and provider-side copies (Supabase backups, Sarvam or Gemini retention) are outside this code. Needs a runbook and legal input.
- No migration was needed: the deletion ledger reuses `retention_records`, and the sentinel name `[erased]` (never a sealed value) marks scrubbed members.
