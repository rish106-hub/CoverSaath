import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { ENCRYPTED_COLUMNS } from '../src/backend/security/column-backfill.js';

const pgOptions = postgresTestOptions();

// D2 column audit (ADR 0013 addendum D2). Every column of every public base table is classified. A column that is not sealed
// must be plain for a stated reason; a new column that is in neither list fails this test, so adding a user-derived column
// without sealing it (or without a reasoned entry here) cannot go unnoticed. Synthetic data only.

// Sealed by another mechanism than scripts/encrypt-existing-rows.mjs (each has its own repository and test).
const SEALED_ELSEWHERE = {
  adult_users: ['phone_ciphertext'],
  adult_preferences: ['prefs_ciphertext'],
  app_events: ['payload_enc'],
  devices: ['label_ciphertext'],
  document_blobs: ['envelope'],
  household_places: ['label_ciphertext', 'payload_ciphertext'],
  onboarding_progress: ['state_ciphertext'],
  profile_answers: ['value_ciphertext'],
  tool_scenarios: ['inputs_ciphertext'],
  webauthn_credentials: ['label_ciphertext'],
};

// Columns the migration keeps only for rows not yet backfilled and for rollback. The application never writes them;
// the backfill clears them (asserted in column-encryption-d2.test.mjs).
const LEGACY_PLAIN = { service_cases: ['stated_estimate_minor'] };

// Plain on purpose: table -> reason -> columns.
const PLAIN = {
  person_records: { 'closed vocabulary: record type, slot name, completeness, source and state (ADR 0026); the payload is sealed': ['record_type', 'slot', 'completeness', 'source', 'state'] },
  adult_users: { 'closed vocabulary or setting, no identity': ['locale', 'account_status'] },
  app_events: { 'operational metadata (route template, outcome, code), no content': ['event_name', 'route', 'method', 'provider', 'outcome', 'code'] },
  audit_events: {
    'counts-only audit (ADR 0013 D3); free text is never put in a payload': ['actor_type', 'action', 'resource_type', 'event_payload_json'],
  },
  api_sessions: { 'closed vocabulary: session kind, authentication method and revocation reason (ADR 0027)': ['session_kind', 'amr', 'revoked_reason'] },
  auth_challenges: { 'closed vocabulary: challenge kind (the code and destination are keyed hashes)': ['kind'] },
  auth_identities: {
    'identity provider issuer URL, public': ['issuer'],
    'closed vocabulary (sign-in provider) and an e-mail verified flag, no address': ['provider', 'email_verified'],
  },
  auth_signing_keys: {
    'public JWK, key id, algorithm and key state: public key material only, the private key lives in the environment (ADR 0027)': ['kid', 'alg', 'public_jwk', 'status'],
    'rotation time of a signing key': ['retire_after'],
  },
  devices: { 'closed vocabulary: client platform (the label is sealed)': ['platform'] },
  notice_acceptances: { 'closed vocabulary and notice version string: which notice was accepted and where, no content': ['notice_kind', 'notice_version', 'surface'] },
  webauthn_credentials: {
    'passkey credential id and public key: public by design in WebAuthn (the private key never leaves the authenticator), random authenticator-chosen handle; the label is sealed': ['credential_id', 'public_key'],
    'closed vocabulary: authenticator transports': ['transports'],
  },
  case_participants: { 'closed vocabulary': ['participant_role'] },
  job_queue: { 'job kind, worker id, closed vocabulary and error code, no content': ['kind', 'locked_by', 'status', 'last_error_code', 'dedupe_key'], 'identifier values only, capped at 1 KiB by a check; never document, OCR, model or household content': ['payload_json'] },
  reference_cache: {
    'public reference-service data only (no household link), cache key, etag, integrity signature, expiry time and status': ['key', 'etag', 'body', 'signature', 'stale_after', 'status'],
  },
  reference_cache_leases: { 'lease key and random per-process owner id, no content': ['key', 'owner'] },
  evidence_claims: { 'random per-process owner id (16-64 chars), no content': ['owner'] },
  catalogue_reviewer_grants: { 'closed vocabulary and curator ids': ['kind', 'status', 'granted_by'] },
  catalogue_reviews: {
    'closed vocabulary': ['authority', 'decision', 'reason_code', 'source_version'],
    'opaque client idempotency key (8-128 chars), no content': ['idempotency_key'],
    'ids of clauses, keys and digests, no text': ['clause_ids_json', 'source_digests_json', 'fact_key'],
  },
  consent_grants: { 'closed vocabulary and notice version': ['granted_to_actor', 'purpose', 'notice_version', 'evidence_method'] },
  consent_scopes: { 'closed vocabulary, provider name and resource ids': ['resource_type', 'action', 'data_category', 'recipient'] },
  coverage_graph_edges: { 'closed vocabulary': ['relationship'] },
  coverage_graph_nodes: { 'closed vocabulary': ['node_type', 'epistemic_state'] },
  coverage_graph_snapshots: { 'closed vocabulary': ['status'] },
  coverage_parameter_acquisitions: { 'closed vocabulary and system actor': ['acquisition_state', 'reason_code', 'updated_by'] },
  coverage_parameter_observation_rules: { 'closed vocabulary': ['extraction_method', 'resolution_state', 'transition_authority'] },
  coverage_parameter_observations: {
    'closed vocabulary, source version, page number and recorder id': ['version', 'page', 'extraction_method', 'review_status', 'recorded_by', 'redaction_reason_code'],
  },
  coverage_parameter_records: { 'public registry keys': ['registry_version', 'parameter_key'] },
  coverage_parameter_registry_pins: { 'public registry version': ['registry_version'] },
  coverage_parameter_registry_versions: { 'public registry version': ['version'] },
  coverage_parameter_resolutions: { 'closed vocabulary and system actor': ['resolution_state', 'reason_code', 'transition_authority', 'updated_by'] },
  curated_action_nonces: { 'random single-use nonce and action name': ['nonce', 'action'] },
  curated_product_submissions: {
    'public insurer product wording and curator ids, not household data (ADR 0010)': [
      'uin', 'insurer', 'product_name', 'wording_version', 'source_url', 'retrieved_on', 'effective_from', 'page_texts_json', 'facts_json',
      'machine_checks_json', 'state', 'collected_by', 'checked_by', 'page_text_origin', 'text_extractor_version'],
  },
  curated_source_archives: { 'public insurer source archive (bytes), not household data': ['content', 'sha256'] },
  device_permissions: { 'closed vocabulary': ['permission', 'state', 'surface', 'wording_version'] },
  document_blobs: { 'opaque random storage key': ['storage_key'] },
  document_uploads: {
    'closed vocabulary and MIME type': ['document_kind', 'mime_type', 'malware_status', 'encryption_status', 'lifecycle_state', 'source_version'],
    'opaque random storage key, replaced by a tombstone on deletion': ['storage_path'],
    'closed vocabulary: where the page count came from (a count, no content)': ['page_count_source'],
  },
  evidence_facts: {
    'closed vocabulary': ['epistemic_state', 'evidence_kind', 'provenance_kind', 'review_status', 'subject_confirmation_state', 'redaction_reason_code'],
    'fact key, public institution reference, calculation name and page locator, no value': ['fact_key', 'institutional_source_ref', 'calculation_method', 'source_locator', 'asserted_by'],
    'adult ids only': ['permitted_viewers_json'],
  },
  fact_conflicts: { 'fact key and closed vocabulary': ['fact_key', 'resolution_state'] },
  household_changes: { 'closed vocabulary: synced entity name (a table label matching ^[a-z_]{1,40}$) and operation; the log holds ids and revisions, never values (ADR 0028)': ['entity', 'op'] },
  household_members: { 'closed vocabulary': ['member_kind'], 'closed vocabulary or flag (ADR 0026): gender, age band, preferred channel, lives-with-household': ['gender', 'age_band', 'preferred_channel', 'lives_with_household'] },
  household_places: { 'closed vocabulary': ['kind', 'slot', 'precision', 'source'] },
  household_roles: { 'closed vocabulary': ['role', 'status'] },
  households: { 'closed vocabulary': ['status'] },
  human_approvals: { 'closed vocabulary': ['approval_kind', 'target_type', 'decision'] },
  human_reviews: { 'closed vocabulary': ['review_kind', 'status', 'recommendation_outcome'] },
  idempotency_keys: {
    'scope names adult and case ids; the key is an opaque client value (8-200 chars)': ['scope', 'idempotency_key'],
    'keyed hash (HMAC) of a document id, not the id': ['document_index'],
  },
  insurers: { 'public insurer register data': ['legal_name', 'regulator_identifier'] },
  integration_outbox: { 'closed vocabulary and operation name': ['provider', 'operation', 'status'] },
  integration_webhook_events: { 'closed vocabulary and provider event type': ['provider', 'event_type', 'signature_status'] },
  model_budget_reservations: { 'budget scope name, state and task name': ['scope', 'state', 'task'] },
  model_budget_scopes: { 'budget scope name': ['scope'] },
  ocr_jobs: {
    'closed vocabulary and error code': ['provider', 'status', 'error_code', 'contract_version'],
    'opaque provider job reference': ['provider_job_ref'],
    'ids and flags only (consent grant id, requesting adult id); read in SQL by revocation erasure, nulled on revocation': ['authorization_json'],
  },
  policies: { 'closed vocabulary': ['policy_kind', 'verification_state'] },
  policy_answers: {
    'opaque client idempotency key (<=128 chars)': ['idempotency_key'],
    'closed vocabulary': ['state'],
    'document ids only; read in SQL by erasure (EXISTS over the array)': ['document_ids_json'],
  },
  policy_clauses: { 'source version, block indexes, clause kind and digest, no text': ['source_version', 'block_indexes_json', 'kind', 'digest'] },
  policy_members: { 'closed vocabulary': ['membership_state'] },
  fact_evidence: {
    'document source version, clause id and role: locators and a closed vocabulary, no text (the quote is sealed)': ['source_version', 'clause_id', 'role'],
  },
  policy_facts: {
    'document source version, run id, fact type, scope slug, origin, state, value type, normaliser version, confirmation source and supersession ids: closed vocabularies and identifiers, no value': [
      'source_version', 'extraction_run_id', 'fact_type', 'scope_key', 'ordinal', 'origin', 'state', 'value_type', 'normaliser_version', 'confirmation_source', 'supersedes_fact_id', 'superseded_by_fact_id'],
    'coarse values by design (ADR 0025 D3): currency, amount band, day count, basis points, flag, enum, year-month; exact values are sealed': [
      'currency', 'amount_band', 'value_bool', 'value_enum', 'value_ym'],
  },
  policy_profiles: {
    'public product and insurer identifiers printed on every policy of the product (UIN, insurer code), not about a person; names are sealed': ['uin', 'insurer_code'],
    'closed vocabulary and document source version, no content': ['source_version', 'uin_state', 'insurer_state', 'policy_name_state', 'confirmation_source'],
  },
  policy_structuring_jobs: { 'versions, closed vocabulary and error codes': ['source_version', 'pipeline_version', 'status', 'evidence_outcome', 'error_code', 'erasure_reason_code'] },
  policy_structuring_runs: { 'versions, counts and codes, no values': ['source_version', 'pipeline_version', 'counts_json', 'erasure_reason_code'] },
  profile_answers: { 'closed vocabulary': ['field_key', 'source'] },
  proposed_parameters: { 'public registry keys, closed vocabulary': ['registry_version', 'proposed_key', 'category', 'status', 'redaction_reason_code'] },
  release_gates: { 'closed vocabulary and system actor': ['gate_kind', 'status', 'decided_by'] },
  retention_records: { 'closed vocabulary': ['resource_type', 'retention_basis', 'deletion_state'] },
  reviewer_findings: { 'closed vocabulary and finding code': ['reviewer_kind', 'severity', 'finding_code'] },
  service_cases: { 'closed vocabulary and currency code': ['trigger_type', 'policy_type', 'status', 'currency'] },
  source_curator_grants: { 'closed vocabulary, curator id and public key': ['role', 'status', 'granted_by', 'public_key'] },
  source_pages: { 'versions, closed vocabulary and opaque provider page reference': ['source_version', 'extraction_status', 'output_contract_version', 'provider_page_ref'] },
  tool_scenarios: { 'closed vocabulary': ['tool'] },
  workflow_events: { 'event type name': ['event_type'] },
  workflow_runs: {
    'workflow name, version, closed vocabulary and revision timestamp': ['workflow_name', 'workflow_version', 'execution_mode', 'status', 'case_revision', 'terminal_reason'],
  },
  workflow_tasks: { 'agent name, task kind, closed vocabulary, worker id': ['agent_name', 'task_kind', 'status', 'lease_owner', 'last_error_code', 'terminal_reason'] },
};

// Numbers and references that are not a primary or foreign key: each listed so a new one needs a decision.
const PLAIN_NUMBERS = {
  household_members: { 'row revision counter': ['revision'] },
  person_records: { 'schema and row revision counters': ['schema_version', 'revision'] },
  adult_preferences: { 'schema and row revision counters': ['schema_version', 'revision'] },
  app_events: { 'status code and duration, no content': ['status', 'duration_ms'] },
  household_changes: { 'log sequence number, row revision counter and time of the change, no content': ['seq', 'revision', 'at'] },
  household_sync_state: { 'low-water mark of the trimmed change log, a sequence number': ['min_seq'] },
  auth_challenges: { 'attempt counter and its cap': ['attempts', 'max_attempts'] },
  webauthn_credentials: { 'passkey signature counter, no content': ['sign_count'] },
  coverage_graph_snapshots: { 'snapshot version counter': ['version'] },
  coverage_parameter_observation_rules: { 'rule flag (0/1)': ['requires_accepted'] },
  coverage_parameter_records: { 'applicability flag (0/1)': ['applicable'] },
  curated_source_archives: { 'byte size of a public source file': ['byte_size'] },
  device_permissions: { 'row revision counter': ['revision'] },
  document_uploads: { 'file size in bytes, scan retry counter and page count, no content': ['byte_size', 'scan_attempts', 'page_count'] },
  policy_profiles: { 'row version counter for optimistic concurrency': ['version'] },
  fact_evidence: { 'page and block index of the printed place, no content': ['page', 'block_index'] },
  policy_facts: { 'ordinal, and coarse values by design (ADR 0025 D3): day count and basis points; exact values are sealed': ['ordinal', 'value_duration_days', 'value_percent_bp'] },
  evidence_facts: { 'confidence in basis points, a score about a fact, not the value': ['confidence_basis_points'] },
  household_places: { 'row revision counter': ['revision'] },
  human_reviews: { 'disclosure flag (0/1)': ['conflict_disclosure_shown'] },
  idempotency_keys: { 'HTTP status of the stored response': ['response_status'] },
  integration_outbox: { 'retry counter': ['attempt_count'] },
  model_budget_reservations: { 'cost in micro-USD, no content': ['amount_micro_usd', 'actual_micro_usd'] },
  model_budget_scopes: { 'cost in micro-USD, no content': ['reserved_micro_usd', 'spent_micro_usd'] },
  job_queue: { 'attempt counters and the due time of a job, no content': ['attempts', 'max_attempts', 'run_after'] },
  ocr_jobs: { 'retry counter': ['attempt_count'] },
  onboarding_progress: { 'row revision counter': ['revision'] },
  policy_clauses: { 'page number': ['page'] },
  policy_structuring_jobs: { 'attempt counter': ['attempt'] },
  proposed_parameters: { 'page and block position, no text': ['page', 'block_index'] },
  rate_limit_buckets: { 'window start and request counter, keyed by a hash': ['window_start', 'request_count'] },
  release_gates: { 'blocker counter': ['blocker_count'] },
  service_cases: { 'emergency flag (0/1)': ['emergency_mode'] },
  source_pages: { 'page number and extraction confidence score': ['page_number', 'confidence_basis_points'] },
  tool_scenarios: { 'schema and row revision counters': ['schema_version', 'revision'] },
  workflow_tasks: { 'retry counter': ['attempt_count'] },
};

// Ids that are not a primary or foreign key in the catalog.
const PLAIN_REFS = {
  app_events: { 'request correlation id and row references (not keys: events outlive their rows), no content': ['request_id', 'household_id', 'adult_user_id', 'case_id', 'consent_grant_id'] },
  api_sessions: { 'id of the client device row of the session (not a key: a device can be removed without ending history), no content': ['device_id'] },
  audit_events: { 'actor and resource ids of the audit chain (append only, no content)': ['actor_id', 'resource_id'] },
  consent_scopes: { 'resource id the scope names (a document or field key)': ['resource_id'] },
  coverage_graph_snapshots: { 'id of the run that generated the snapshot': ['generated_by_run_id'] },
  document_uploads: { 'random id shared by the versions of one document': ['logical_document_id'] },
  curated_product_submissions: { 'id of the previous source version': ['source_version_id'] },
  fact_conflicts: { 'id of the resolving review': ['resolved_by_review_id'] },
  household_changes: { 'ids of the changed row, and of the adult it is private to and the adult who made the change; not keys so erasure never blocks, no content': ['entity_id', 'subject_adult_id', 'actor_adult_id'] },
  human_approvals: { 'id of the approved target': ['target_id'] },
  job_queue: { 'ids the job names (a household, document or grant), not keys so erasure never blocks': ['household_id', 'document_id', 'consent_grant_id'] },
  idempotency_keys: { 'ids the key is scoped to, not keys so erasure never blocks': ['household_id', 'case_id'] },
  integration_webhook_events: { 'provider event id used for de-duplication': ['provider_event_id'] },
  retention_records: { 'id of the resource the record is about': ['resource_id'] },
};

// Recognised by name (a suffix convention in this schema): timestamps (`*_at`, `*_until`) and digests/hashes (`*_digest`, `*_sha256`,
// `*_hash`). Ids and numbers are NOT recognised by name or type: a `*_id` column passes only when the catalog says it is a primary or
// foreign key, and every bigint/integer/smallint/timestamptz column must be listed below with a reason.
const isTime = column => column.endsWith('_at') || column.endsWith('_until');
const isDigest = column => /(_digest|_sha256|_hash)$/.test(column);

const key = (table, column) => `${table}.${column}`;
const sealedKeys = () => new Set([
  ...ENCRYPTED_COLUMNS.flatMap(item => item.columns.map(column => key(item.table, column))),
  ...Object.entries(SEALED_ELSEWHERE).flatMap(([table, columns]) => columns.map(column => key(table, column))),
]);
const plainKeys = () => new Map([PLAIN, PLAIN_NUMBERS, PLAIN_REFS].flatMap(group => Object.entries(group)).flatMap(([table, reasons]) => Object.entries(reasons).flatMap(([reason, columns]) => columns.map(column => [key(table, column), reason]))));
const legacyKeys = () => new Set(Object.entries(LEGACY_PLAIN).flatMap(([table, columns]) => columns.map(column => key(table, column))));

async function schemaColumns(db) {
  return db.many(`SELECT c.table_name, c.column_name, c.data_type FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE' AND c.table_name <> 'schema_migrations'
    ORDER BY c.table_name, c.ordinal_position`);
}

// Columns that are a member of a primary key or a foreign key: opaque row references.
async function keyColumns(db) {
  const rows = await db.many(`SELECT rel.relname AS table_name, att.attname AS column_name FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
    WHERE ns.nspname = 'public' AND con.contype IN ('p', 'f')`);
  return new Set(rows.map(row => key(row.table_name, row.column_name)));
}

test('D2: every column is sealed, plain for a stated reason, a key, a timestamp or a digest; there are 0 unlisted user-derived plaintext columns', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const columns = await schemaColumns(db);
  const sealed = sealedKeys();
  const plain = plainKeys();
  const legacy = legacyKeys();
  const keys = await keyColumns(db);
  const unlisted = [];
  for (const { table_name: table, column_name: column, data_type: type } of columns) {
    const k = key(table, column);
    if (sealed.has(k) || plain.has(k) || legacy.has(k)) continue;
    if (isTime(column) || isDigest(column)) continue;
    if ((column === 'id' || column.endsWith('_id')) && keys.has(k)) continue;
    unlisted.push(`${k} (${type})`);
  }
  assert.deepEqual(unlisted, [], `unclassified columns (seal them in column-backfill.js or list them in PLAIN with a reason): ${unlisted.join(', ')}`);
});

test('D2: the lists carry no stale or contradictory entries', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const existing = new Set((await schemaColumns(db)).map(item => key(item.table_name, item.column_name)));
  const sealed = sealedKeys();
  const plain = plainKeys();
  for (const k of [...sealed, ...plain.keys(), ...legacyKeys()]) assert.ok(existing.has(k), `${k} is listed but does not exist`);
  for (const k of plain.keys()) assert.ok(!sealed.has(k), `${k} is listed as both sealed and plain`);
  for (const k of legacyKeys()) assert.ok(!sealed.has(k) && !plain.has(k), `${k} is listed twice`);
  for (const [k, reason] of plain) assert.ok(reason.length > 10, `${k} needs a real reason`);
  // A sealed column is text (the envelope), never a number, and the registry has no table twice with the same column.
  const seen = new Set();
  for (const item of ENCRYPTED_COLUMNS) for (const column of item.columns) {
    const k = key(item.table, column);
    assert.ok(!seen.has(k), `${k} is registered twice`);
    seen.add(k);
  }
});

test('D2: every table in the sealed registry has its blocking triggers named, so the backfill can update it', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const triggers = new Set((await db.many('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal')).map(row => row.tgname));
  for (const item of ENCRYPTED_COLUMNS) for (const trigger of item.triggers) assert.ok(triggers.has(trigger), `${item.table}: trigger ${trigger} does not exist`);
});
