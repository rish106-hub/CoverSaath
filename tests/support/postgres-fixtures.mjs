// Synthetic fixtures for the PostgreSQL schema tests. No real data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const at = '2026-10-16T10:00:00.000Z';
export const later = '2026-10-16T11:00:00.000Z';
export const earlier = '2026-10-16T09:00:00.000Z';
export const hex = character => character.repeat(64);

const defaults = {
  households: id => ({ id, display_name: `Household ${id}`, created_at: at, updated_at: at }),
  adult_users: id => ({ id, display_name: `Adult ${id}`, account_status: 'active', created_at: at, updated_at: at }),
  household_roles: id => ({ id, role: 'owner', status: 'active', created_at: at }),
  household_members: id => ({ id, display_name: `Member ${id}`, member_kind: 'adult', created_at: at, updated_at: at }),
  consent_grants: id => ({
    id, granted_to_actor: 'coversaath-local', purpose: 'document_processing', notice_version: 'v1',
    evidence_method: 'fixture', granted_at: at, created_at: at,
  }),
  consent_scopes: id => ({ id, resource_type: 'profile_field', action: 'read', data_category: 'profile', created_at: at }),
  consent_revocations: id => ({ id, revoked_at: later, created_at: later }),
  service_cases: id => ({
    id, trigger_type: 'renewal', status: 'processing', created_at: at, updated_at: at,
  }),
  case_participants: () => ({ participant_role: 'operator', created_at: at }),
  document_uploads: id => ({
    id, document_kind: 'policy_schedule', original_filename: 'fixture.pdf', storage_path: `fixture/${id}`,
    // Distinct per document: live content is unique per household (migration 004).
    content_sha256: createHash('sha256').update(String(id)).digest('hex'), mime_type: 'application/pdf', byte_size: 100, malware_status: 'clean',
    encryption_status: 'encrypted_local', lifecycle_state: 'active', uploaded_at: at,
  }),
  ocr_jobs: id => ({ id, provider: 'fixture', status: 'succeeded', attempt_count: 1, requested_at: at }),
  source_pages: id => ({
    id, page_number: 2, source_version: 'version-1', page_sha256: hex('b'), extraction_status: 'extracted', created_at: at,
  }),
  policies: id => ({ id, policy_kind: 'personal', verification_state: 'unverified', created_at: at, updated_at: at }),
  policy_members: () => ({ membership_state: 'stated', created_at: at }),
  evidence_facts: id => ({
    id, fact_key: 'room_limit', value_json: null, epistemic_state: 'unknown', evidence_kind: 'adult_statement',
    provenance_kind: 'adult_statement', asserted_by: 'adult', observed_at: at, created_at: at,
  }),
  fact_conflicts: id => ({ id, fact_key: 'room_limit', created_at: at }),
  coverage_graph_snapshots: id => ({ id, version: 1, status: 'draft', graph_json: '{}', created_at: at }),
  coverage_graph_nodes: id => ({
    id, node_type: 'policy', label: id, epistemic_state: 'known', created_at: at,
  }),
  coverage_graph_edges: id => ({ id, relationship: 'covers', created_at: at }),
  workflow_runs: id => ({
    id, workflow_name: 'coverage-reconstruction', workflow_version: 'v2', execution_mode: 'fixture', status: 'queued',
    input_digest: hex('d'), created_at: at,
  }),
  workflow_tasks: id => ({
    id, agent_name: 'profile', task_kind: 'analyse', status: 'pending', created_at: at,
  }),
  workflow_task_dependencies: () => ({ created_at: at }),
  workflow_events: () => ({}),
  human_reviews: id => ({ id, review_kind: 'ambiguity', status: 'in_progress', started_at: at, created_at: at }),
  human_approvals: id => ({
    id, approval_kind: 'share_data', target_type: 'case', target_id: 'target', decision: 'approved',
    approved_payload_digest: hex('e'), decided_at: at, created_at: at,
  }),
  release_gates: id => ({ id, gate_kind: 'external_action', status: 'passed', decided_by: 'reviewer', created_at: at }),
  integration_outbox: id => ({
    id, provider: 'sarvam', operation: 'ocr.submit', payload_json: '{}', payload_digest: hex('f'), status: 'pending',
    available_at: at, created_at: at, updated_at: at,
  }),
  audit_events: () => ({
    actor_type: 'system', actor_id: 'test', action: 'case.created', resource_type: 'case', resource_id: 'case',
    event_payload_json: '{}', occurred_at: at,
  }),
  api_sessions: id => ({
    id, token_sha256: hex('1'), issued_at: at, expires_at: later, created_at: at,
  }),
  coverage_parameter_registry_pins: () => ({ registry_version: 'policy-parameters/v1', pinned_at: at, created_at: at }),
  coverage_parameter_records: id => ({
    id, registry_version: 'policy-parameters/v1', parameter_key: 'd.room_rent_limit', created_at: at, updated_at: at,
  }),
  coverage_parameter_observations: id => ({
    id, version: 'version-1', page: '2', extraction_method: 'document_extraction', review_status: 'not_reviewed',
    value_json: '{"amountMinor":500000}', source_digest: hex('c'), observed_at: at, recorded_by: 'extractor', created_at: at,
  }),
  policy_structuring_runs: id => ({
    id, source_version: 'version-1', pipeline_version: 'policy-structuring/v1', counts_json: '{"proposals":1}', created_at: at,
  }),
  proposed_parameters: id => ({
    id, registry_version: 'policy-parameters/v1', proposed_key: 'synthetic_benefit', category: 'unassigned',
    label: 'Synthetic benefit', value_json: '{"text":"Rs. 100","normalized":null,"subject":"policy","evidenceQuote":"Rs. 100"}',
    page: 2, block_index: 0, status: 'pending_review', created_at: at,
  }),
  coverage_parameter_resolutions: () => ({
    resolution_state: 'unknown', transition_authority: 'deterministic', updated_by: 'test', updated_at: at,
  }),
};

// insert(pool, 'households', { id: 'h1' }) fills the required columns of the table from the defaults.
export async function insert(pool, table, row) {
  const build = defaults[table];
  assert.ok(build, `no fixture defaults for ${table}`);
  const full = { ...build(row.id), ...row };
  const columns = Object.keys(full);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const result = await pool.query(
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    columns.map(column => full[column]),
  );
  return result.rows[0];
}

export async function one(pool, sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

// One household with an owner who is also a member, a processing consent, a case and a policy, a clean
// active document with an OCR job and a page, a run with an in-progress human review, and one fact.
export async function seedWorld(pool, key) {
  const ids = {
    household: `household-${key}`, adult: `adult-${key}`, member: `member-${key}`, consent: `consent-${key}`,
    case: `case-${key}`, policy: `policy-${key}`, document: `document-${key}`, ocr: `ocr-${key}`, page: `page-${key}`,
    run: `run-${key}`, review: `review-${key}`, fact: `fact-${key}`,
  };
  await insert(pool, 'households', { id: ids.household });
  await insert(pool, 'adult_users', { id: ids.adult });
  await insert(pool, 'household_roles', { id: `role-${key}`, household_id: ids.household, adult_user_id: ids.adult });
  await insert(pool, 'household_members', { id: ids.member, household_id: ids.household, adult_user_id: ids.adult });
  await insert(pool, 'consent_grants', { id: ids.consent, household_id: ids.household, subject_adult_id: ids.adult });
  await insert(pool, 'service_cases', {
    id: ids.case, household_id: ids.household, subject_member_id: ids.member, opened_by_adult_id: ids.adult,
  });
  await insert(pool, 'policies', { id: ids.policy, household_id: ids.household });
  await insert(pool, 'document_uploads', {
    id: ids.document, household_id: ids.household, case_id: ids.case, uploaded_by_adult_id: ids.adult,
    consent_grant_id: ids.consent,
  });
  await insert(pool, 'ocr_jobs', { id: ids.ocr, document_upload_id: ids.document });
  await insert(pool, 'source_pages', { id: ids.page, document_upload_id: ids.document, ocr_job_id: ids.ocr });
  await insert(pool, 'workflow_runs', { id: ids.run, case_id: ids.case, consent_grant_id: ids.consent });
  await insert(pool, 'human_reviews', {
    id: ids.review, case_id: ids.case, workflow_run_id: ids.run, reviewer_adult_id: ids.adult,
  });
  await insert(pool, 'evidence_facts', {
    id: ids.fact, household_id: ids.household, case_id: ids.case, statement_adult_id: ids.adult,
  });
  return ids;
}

// Registry pin, parameter record and one observation for a seeded world.
export async function seedParameter(pool, ids, key = ids.case) {
  await insert(pool, 'coverage_parameter_registry_pins', { workflow_run_id: ids.run });
  const record = await insert(pool, 'coverage_parameter_records', {
    id: `parameter-${key}`, workflow_run_id: ids.run, household_id: ids.household, case_id: ids.case,
    subject_id: ids.member, policy_id: ids.policy,
  });
  return { record: record.id };
}

export async function seedObservation(pool, ids, parameterId, overrides = {}) {
  const row = await insert(pool, 'coverage_parameter_observations', {
    id: overrides.id ?? `observation-${parameterId}`, parameter_record_id: parameterId, source_id: ids.page,
    document_id: ids.document, ...overrides,
  });
  return row.id;
}

// SQLSTATE of a trigger RAISE EXCEPTION.
export const TRIGGER_RAISE = 'P0001';

export async function assertTriggerRejects(promise, message) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, TRIGGER_RAISE, `expected a trigger exception, got ${error.code}: ${error.message}`);
    assert.equal(error.message, message);
    return true;
  });
}

export async function assertConstraintRejects(promise, sqlState) {
  await assert.rejects(promise, error => {
    assert.equal(error.code, sqlState, `expected SQLSTATE ${sqlState}, got ${error.code}: ${error.message}`);
    return true;
  });
}

// Trigger coverage registry: a test calls proves(name) after it showed the rejection and the allowed
// path for that trigger. The last test of postgres-triggers.test.mjs asserts nothing is missing.
const proven = new Set();
export const proves = (...names) => names.forEach(name => proven.add(name));
export const provenTriggers = () => new Set(proven);
