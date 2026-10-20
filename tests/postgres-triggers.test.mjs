import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalTriggers } from '../src/backend/database/database.js';
import { buildStoredBlocks, serializeStoredBlocks } from '../src/features/input/index.js';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';
import {
  assertTriggerRejects as rejects, at, earlier, hex, insert, later, one, proves, provenTriggers, seedObservation,
  seedParameter, seedWorld,
} from './support/postgres-fixtures.mjs';

// Every trigger gets at least one rejection (or, for AFTER triggers, the side effect) and one allowed path.
// Messages are the SQLite messages. proves() registers a trigger once both halves passed; the last test
// asserts that every critical trigger, and every trigger in the catalog, was proven.

async function worlds(t) {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const b = await seedWorld(pool, 'b');
  return { pool, a, b };
}

async function addAdult(pool, household, key, { role = 'viewer', status = 'active' } = {}) {
  const adult = `adult-${key}`;
  await insert(pool, 'adult_users', { id: adult });
  await insert(pool, 'household_roles', { id: `role-${key}`, household_id: household, adult_user_id: adult, role, status });
  return adult;
}

test('audit events are append only; revocation marks the grant; outbox needs active consent', postgresTestOptions(), async t => {
  const { pool, a } = await worlds(t);

  const event = await insert(pool, 'audit_events', { household_id: a.household, case_id: a.case, event_hash: hex('1') });
  assert.ok(BigInt(event.id) > 0n, 'identity key is assigned');
  await rejects(pool.query("UPDATE audit_events SET action = 'changed'"), 'audit events are append only');
  await rejects(pool.query('DELETE FROM audit_events'), 'audit events are append only');
  await rejects(pool.query('TRUNCATE audit_events'), 'audit events are append only');
  assert.equal((await pool.query('UPDATE audit_events SET action = $1 WHERE false', ['none'])).rowCount, 0, 'row-level: no row, no fire');
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM audit_events')).n, 1);
  proves('audit_events_no_update', 'audit_events_no_delete', 'audit_events_no_truncate');

  await insert(pool, 'consent_grants', { id: 'consent-active', household_id: a.household, subject_adult_id: a.adult });
  await insert(pool, 'consent_grants', { id: 'consent-revoked', household_id: a.household, subject_adult_id: a.adult, revoked_at: later });
  await insert(pool, 'consent_grants', { id: 'consent-expired', household_id: a.household, subject_adult_id: a.adult, expires_at: at });
  await insert(pool, 'consent_grants', {
    id: 'consent-future', household_id: a.household, subject_adult_id: a.adult, expires_at: '2026-10-16T10:00:00.001Z',
  });
  const message = 'active consent is required for an integration action';
  await rejects(insert(pool, 'integration_outbox', { id: 'outbox-revoked', consent_grant_id: 'consent-revoked' }), message);
  await rejects(insert(pool, 'integration_outbox', { id: 'outbox-expired', consent_grant_id: 'consent-expired' }), message);
  await insert(pool, 'integration_outbox', { id: 'outbox-active', consent_grant_id: 'consent-active' });
  await insert(pool, 'integration_outbox', { id: 'outbox-future', consent_grant_id: 'consent-future' });
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM integration_outbox')).n, 2);
  proves('integration_outbox_requires_active_consent');

  await insert(pool, 'consent_grants', { id: 'consent-to-revoke', household_id: a.household, subject_adult_id: a.adult });
  await insert(pool, 'consent_grants', { id: 'consent-untouched', household_id: a.household, subject_adult_id: a.adult });
  await insert(pool, 'consent_revocations', { id: 'revocation-1', consent_grant_id: 'consent-to-revoke', revoked_by_adult_id: a.adult });
  assert.equal((await one(pool, "SELECT revoked_at FROM consent_grants WHERE id = 'consent-to-revoke'")).revoked_at, later);
  assert.equal((await one(pool, "SELECT revoked_at FROM consent_grants WHERE id = 'consent-untouched'")).revoked_at, null);
  await rejects(insert(pool, 'integration_outbox', { id: 'outbox-after-revoke', consent_grant_id: 'consent-to-revoke' }), message);
  proves('consent_revocations_mark_grant');
});

test('consent grants, scopes, cases and participants stay inside their household', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const second = await addAdult(pool, a.household, 'a2');

  const subjectMessage = 'consent subject must belong to the household';
  await rejects(insert(pool, 'consent_grants', { id: 'bad', household_id: a.household, subject_adult_id: b.adult }), subjectMessage);
  await insert(pool, 'consent_grants', { id: 'good', household_id: a.household, subject_adult_id: second });
  await rejects(pool.query('UPDATE consent_grants SET subject_adult_id = $1 WHERE id = $2', [b.adult, 'good']), subjectMessage);
  await pool.query('UPDATE consent_grants SET subject_adult_id = $1 WHERE id = $2', [a.adult, 'good']);
  await pool.query("UPDATE consent_grants SET notice_version = 'v2' WHERE id = 'good'");
  proves('consent_grants_household_subject_insert', 'consent_grants_household_subject_update');

  const resourceMessage = 'consent resource must belong to the grant household';
  const scope = (id, resource_type, resource_id, extra = {}) => insert(pool, 'consent_scopes', {
    id, consent_grant_id: a.consent, resource_type, resource_id, data_category: id, ...extra,
  });
  await rejects(scope('s-case-b', 'case', b.case), resourceMessage);
  await rejects(scope('s-doc-b', 'document', b.document), resourceMessage);
  await rejects(scope('s-policy-b', 'policy', b.policy), resourceMessage);
  await rejects(scope('s-case-missing', 'case', 'case-missing'), resourceMessage);
  await scope('s-case-a', 'case', a.case);
  await scope('s-doc-a', 'document', a.document);
  await scope('s-policy-a', 'policy', a.policy);
  await scope('s-case-null', 'case', null);
  await scope('s-voice-any', 'voice_call', 'anything');
  await scope('s-profile-any', 'profile_field', 'whatever');
  proves('consent_scopes_household_resource_insert');

  const immutable = 'consent scope resource references are immutable';
  await insert(pool, 'service_cases', {
    id: 'case-a2', household_id: a.household, subject_member_id: a.member, opened_by_adult_id: a.adult,
  });
  await rejects(pool.query("UPDATE consent_scopes SET resource_id = 'case-a2' WHERE id = 's-case-a'"), immutable);
  await rejects(pool.query("UPDATE consent_scopes SET resource_type = 'document' WHERE id = 's-case-a'"), immutable);
  await pool.query("UPDATE consent_scopes SET action = 'derive' WHERE id = 's-case-a'");
  await pool.query("UPDATE consent_scopes SET resource_id = resource_id WHERE id = 's-case-a'");
  proves('consent_scopes_resource_immutable');

  const viewerMessage = 'profile field recipient must be an active household viewer';
  const profile = (id, recipient, extra = {}) => scope(id, 'profile_field', null, { recipient, ...extra });
  await rejects(profile('p-outsider', b.adult), viewerMessage);
  await rejects(profile('p-unknown', 'adult-missing'), viewerMessage);
  const pending = await addAdult(pool, a.household, 'pending', { status: 'pending' });
  await rejects(profile('p-pending', pending), viewerMessage);
  await profile('p-viewer', second);
  await profile('p-no-recipient', null);
  await scope('s-doc-institution', 'document', a.document, { recipient: 'institution-x', data_category: 'inst' });
  await profile('p-update-target', null, { data_category: 'upd' });
  await rejects(pool.query('UPDATE consent_scopes SET recipient = $1 WHERE id = $2', [b.adult, 'p-update-target']), viewerMessage);
  await pool.query('UPDATE consent_scopes SET recipient = $1 WHERE id = $2', [second, 'p-update-target']);
  proves('consent_scopes_profile_viewer_insert', 'consent_scopes_profile_viewer_update');

  const caseMessage = 'case participants must belong to the household';
  const newCase = (id, extra) => insert(pool, 'service_cases', {
    id, household_id: a.household, subject_member_id: a.member, opened_by_adult_id: a.adult, ...extra,
  });
  await rejects(newCase('c-bad-member', { subject_member_id: b.member }), caseMessage);
  await rejects(newCase('c-bad-adult', { opened_by_adult_id: b.adult }), caseMessage);
  await newCase('c-good', { opened_by_adult_id: second });
  await rejects(pool.query('UPDATE service_cases SET subject_member_id = $1 WHERE id = $2', [b.member, 'c-good']), caseMessage);
  await rejects(pool.query('UPDATE service_cases SET opened_by_adult_id = $1 WHERE id = $2', [b.adult, 'c-good']), caseMessage);
  await pool.query('UPDATE service_cases SET opened_by_adult_id = $1 WHERE id = $2', [a.adult, 'c-good']);
  await pool.query("UPDATE service_cases SET status = 'closed' WHERE id = 'c-good'");
  proves('service_cases_household_refs_insert', 'service_cases_household_refs_update');

  const participantMessage = 'case participant must be household and consent scoped';
  const participant = extra => insert(pool, 'case_participants', { case_id: a.case, ...extra });
  await rejects(participant({ adult_user_id: b.adult }), participantMessage);
  await rejects(participant({ adult_user_id: second, consent_grant_id: a.consent }), participantMessage);
  await insert(pool, 'consent_grants', { id: 'consent-second', household_id: a.household, subject_adult_id: second });
  await participant({ adult_user_id: second, consent_grant_id: 'consent-second' });
  await participant({ adult_user_id: a.adult, participant_role: 'reviewer' });
  const refs = 'case participant references are immutable';
  await rejects(pool.query('UPDATE case_participants SET adult_user_id = $1 WHERE adult_user_id = $2', [a.adult, second]), refs);
  await rejects(pool.query('UPDATE case_participants SET consent_grant_id = NULL WHERE adult_user_id = $1', [second]), refs);
  await rejects(pool.query("UPDATE case_participants SET case_id = 'c-good' WHERE adult_user_id = $1", [second]), refs);
  await pool.query("UPDATE case_participants SET created_at = $1 WHERE adult_user_id = $2", [later, second]);
  proves('case_participants_household_refs_insert', 'case_participants_refs_immutable');
});

test('documents, policies and evidence are household and consent scoped', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const second = await addAdult(pool, a.household, 'a2');

  const docMessage = 'document must be household and active-consent scoped';
  const consent = (id, extra = {}) => insert(pool, 'consent_grants', { id, household_id: a.household, subject_adult_id: a.adult, ...extra });
  await consent('c-payment', { purpose: 'payment' });
  await consent('c-revoked', { revoked_at: later });
  await consent('c-expired', { expires_at: earlier });
  await consent('c-boundary', { expires_at: at });
  await consent('c-future', { expires_at: '2026-10-16T10:00:00.001Z' });
  await consent('c-garbage-expiry', { expires_at: 'not-a-date' });
  await consent('c-offset', { expires_at: '2026-10-16T15:30:00+05:30' });
  const doc = (id, consent_grant_id, extra = {}) => insert(pool, 'document_uploads', {
    id, household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult, consent_grant_id, ...extra,
  });
  await rejects(doc('d-purpose', 'c-payment'), docMessage);
  await rejects(doc('d-revoked', 'c-revoked'), docMessage);
  await rejects(doc('d-expired', 'c-expired'), docMessage);
  await rejects(doc('d-boundary', 'c-boundary'), docMessage);
  await rejects(doc('d-garbage', 'c-garbage-expiry'), docMessage);
  await rejects(doc('d-offset', 'c-offset'), docMessage);
  await rejects(doc('d-other-consent', b.consent), docMessage);
  await rejects(doc('d-other-case', a.consent, { case_id: b.case }), docMessage);
  await rejects(doc('d-missing-consent', 'consent-missing'), docMessage);
  await doc('d-future', 'c-future');
  await doc('d-no-case', a.consent, { case_id: null });
  proves('document_uploads_household_refs_insert');

  const pending = await doc('d-quarantined', a.consent, { malware_status: 'pending', encryption_status: 'required' });
  assert.equal(pending.lifecycle_state, 'active', 'RETURNING shows the row before the AFTER trigger');
  assert.equal((await one(pool, "SELECT lifecycle_state FROM document_uploads WHERE id = 'd-quarantined'")).lifecycle_state, 'quarantined');
  await doc('d-unencrypted', a.consent, { encryption_status: 'required' });
  assert.equal((await one(pool, "SELECT lifecycle_state FROM document_uploads WHERE id = 'd-unencrypted'")).lifecycle_state, 'quarantined');
  await doc('d-pending-scan', a.consent, { malware_status: 'pending' });
  assert.equal((await one(pool, "SELECT lifecycle_state FROM document_uploads WHERE id = 'd-pending-scan'")).lifecycle_state, 'quarantined');
  assert.equal((await one(pool, `SELECT lifecycle_state FROM document_uploads WHERE id = '${a.document}'`)).lifecycle_state, 'active');
  await doc('d-already-deleted', a.consent, { malware_status: 'pending', lifecycle_state: 'deleted' });
  assert.equal((await one(pool, "SELECT lifecycle_state FROM document_uploads WHERE id = 'd-already-deleted'")).lifecycle_state, 'deleted');
  proves('document_uploads_quarantine_after_insert');

  const immutable = 'document household and consent references are immutable';
  await rejects(pool.query('UPDATE document_uploads SET household_id = $1 WHERE id = $2', [b.household, a.document]), immutable);
  await rejects(pool.query('UPDATE document_uploads SET case_id = NULL WHERE id = $1', [a.document]), immutable);
  await rejects(pool.query('UPDATE document_uploads SET consent_grant_id = $1 WHERE id = $2', ['c-future', a.document]), immutable);
  await rejects(pool.query('UPDATE document_uploads SET uploaded_by_adult_id = $1 WHERE id = $2', [second, a.document]), immutable);
  await pool.query('UPDATE document_uploads SET case_id = case_id WHERE id = $1', [a.document]);
  await pool.query("UPDATE document_uploads SET original_filename = 'renamed.pdf' WHERE id = $1", [a.document]);
  proves('document_uploads_household_refs_immutable');

  const activation = 'document cannot activate before validation and protected storage';
  await rejects(pool.query("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'd-quarantined'"), activation);
  await rejects(pool.query("UPDATE document_uploads SET lifecycle_state = 'active', malware_status = 'clean' WHERE id = 'd-quarantined'"), activation);
  await rejects(pool.query("UPDATE document_uploads SET lifecycle_state = 'active', malware_status = 'blocked', encryption_status = 'fixture_only' WHERE id = 'd-quarantined'"), activation);
  await pool.query(`UPDATE document_uploads SET malware_status = 'not_scanned_fixture', encryption_status = 'fixture_only',
    lifecycle_state = 'active' WHERE id = 'd-quarantined'`);
  assert.equal((await one(pool, "SELECT lifecycle_state FROM document_uploads WHERE id = 'd-quarantined'")).lifecycle_state, 'active');
  proves('document_uploads_activation_guard');

  const policyMessage = 'policy source document must belong to the household';
  const policy = (id, extra) => insert(pool, 'policies', { id, household_id: a.household, ...extra });
  await rejects(policy('pol-bad', { source_document_id: b.document }), policyMessage);
  await rejects(policy('pol-missing', { source_document_id: 'document-missing' }), policyMessage);
  await policy('pol-good', { source_document_id: a.document });
  await policy('pol-none', {});
  proves('policies_household_source_insert');
  const policyImmutable = 'policy household and source references are immutable';
  await rejects(pool.query('UPDATE policies SET household_id = $1 WHERE id = $2', [b.household, 'pol-good']), policyImmutable);
  await rejects(pool.query('UPDATE policies SET source_document_id = $1 WHERE id = $2', ['d-future', 'pol-good']), policyImmutable);
  await pool.query("UPDATE policies SET verification_state = 'document_backed' WHERE id = 'pol-good'");
  await pool.query('UPDATE policies SET source_document_id = source_document_id WHERE id = $1', ['pol-good']);
  proves('policies_household_source_immutable');

  await insert(pool, 'household_members', { id: 'member-a2', household_id: a.household, member_kind: 'dependent' });
  const memberMessage = 'policy member references must belong to the household';
  const policyMember = extra => insert(pool, 'policy_members', { policy_id: a.policy, ...extra });
  await rejects(policyMember({ household_member_id: b.member }), memberMessage);
  await rejects(policyMember({ household_member_id: a.member, source_page_id: b.page }), memberMessage);
  await policyMember({ household_member_id: a.member, source_page_id: a.page });
  await policyMember({ household_member_id: 'member-a2' });
  proves('policy_members_household_refs_insert');
  const memberImmutable = 'policy member references are immutable';
  await rejects(pool.query("UPDATE policy_members SET household_member_id = 'member-a2' WHERE household_member_id = $1", [a.member]), memberImmutable);
  await rejects(pool.query('UPDATE policy_members SET source_page_id = NULL WHERE household_member_id = $1', [a.member]), memberImmutable);
  await pool.query("UPDATE policy_members SET membership_state = 'document_backed' WHERE household_member_id = $1", [a.member]);
  proves('policy_members_refs_immutable');

  const evidenceMessage = 'evidence references must belong to the household';
  const fact = (id, extra) => insert(pool, 'evidence_facts', { id, household_id: a.household, ...extra });
  await rejects(fact('f-case', { case_id: b.case }), evidenceMessage);
  await rejects(fact('f-policy', { policy_id: b.policy }), evidenceMessage);
  await rejects(fact('f-member', { subject_member_id: b.member }), evidenceMessage);
  await rejects(fact('f-page', { source_page_id: b.page }), evidenceMessage);
  await rejects(fact('f-adult', { statement_adult_id: b.adult }), evidenceMessage);
  await rejects(fact('f-supersedes-other-household', { supersedes_fact_id: b.fact }), evidenceMessage);
  await rejects(fact('f-supersedes-other-key', { supersedes_fact_id: a.fact, fact_key: 'different_key' }), evidenceMessage);
  await fact('f-superseding', { supersedes_fact_id: a.fact, case_id: a.case, policy_id: a.policy, subject_member_id: a.member, statement_adult_id: second });
  await fact('f-known', {
    case_id: a.case, epistemic_state: 'known', value_json: '5000', provenance_kind: 'document_page',
    evidence_kind: 'document', source_page_id: a.page,
  });
  proves('evidence_facts_household_refs_insert');
  const appendOnly = 'evidence facts are append only; add a superseding fact';
  await rejects(pool.query("UPDATE evidence_facts SET review_status = 'reviewed' WHERE id = 'f-known'"), appendOnly);
  await rejects(pool.query('UPDATE evidence_facts SET fact_key = fact_key'), appendOnly);
  await rejects(pool.query("DELETE FROM evidence_facts WHERE id = 'f-known'"), appendOnly);
  await rejects(pool.query('TRUNCATE evidence_facts CASCADE'), appendOnly);
  assert.equal((await pool.query('UPDATE evidence_facts SET fact_key = fact_key WHERE false')).rowCount, 0);
  proves('evidence_facts_provenance_immutable', 'evidence_facts_no_delete', 'evidence_facts_no_truncate');

  const conflictMessage = 'conflict facts must share a household and fact key';
  await fact('f-other-key', { fact_key: 'other_key' });
  await rejects(insert(pool, 'fact_conflicts', { id: 'x1', left_fact_id: a.fact, right_fact_id: b.fact }), conflictMessage);
  await rejects(insert(pool, 'fact_conflicts', { id: 'x2', left_fact_id: a.fact, right_fact_id: 'f-other-key' }), conflictMessage);
  await rejects(insert(pool, 'fact_conflicts', { id: 'x3', left_fact_id: a.fact, right_fact_id: 'f-superseding', fact_key: 'other_key' }), conflictMessage);
  await insert(pool, 'fact_conflicts', { id: 'x-ok', left_fact_id: a.fact, right_fact_id: 'f-superseding' });
  proves('fact_conflicts_same_fact_insert');

  const snapshotMessage = 'coverage graph case must belong to the household';
  await rejects(insert(pool, 'coverage_graph_snapshots', { id: 'snap-bad', household_id: a.household, case_id: b.case }), snapshotMessage);
  await insert(pool, 'coverage_graph_snapshots', { id: 'snap-1', household_id: a.household, case_id: a.case, version: 1 });
  await insert(pool, 'coverage_graph_snapshots', { id: 'snap-2', household_id: a.household, case_id: a.case, version: 2 });
  proves('coverage_graph_snapshots_household_case_insert');
  const snapshotImmutable = 'coverage graph household references are immutable';
  await rejects(pool.query("UPDATE coverage_graph_snapshots SET household_id = $1 WHERE id = 'snap-1'", [b.household]), snapshotImmutable);
  await rejects(pool.query("UPDATE coverage_graph_snapshots SET case_id = $1 WHERE id = 'snap-1'", [b.case]), snapshotImmutable);
  await pool.query("UPDATE coverage_graph_snapshots SET status = 'reviewed' WHERE id = 'snap-1'");
  proves('coverage_graph_snapshots_refs_immutable');

  const nodeMessage = 'graph source fact must belong to the snapshot household';
  const node = (id, snapshot_id, extra) => insert(pool, 'coverage_graph_nodes', { id, snapshot_id, ...extra });
  await rejects(node('n-bad', 'snap-1', { source_fact_id: b.fact }), nodeMessage);
  await node('n1', 'snap-1', { source_fact_id: a.fact });
  await node('n2', 'snap-1', {});
  await node('n3', 'snap-2', {});
  proves('coverage_graph_nodes_snapshot_fact_insert');
  const edgeMessage = 'graph edge references must belong to the snapshot';
  const edge = (id, extra) => insert(pool, 'coverage_graph_edges', { id, snapshot_id: 'snap-1', from_node_id: 'n1', to_node_id: 'n2', ...extra });
  await rejects(edge('e-cross', { to_node_id: 'n3' }), edgeMessage);
  await rejects(edge('e-wrong-snapshot', { snapshot_id: 'snap-2' }), edgeMessage);
  await rejects(edge('e-fact', { source_fact_id: b.fact }), edgeMessage);
  await edge('e-ok', { source_fact_id: a.fact });
  proves('coverage_graph_edges_snapshot_nodes_insert');

  const runMessage = 'workflow consent must belong to the case household';
  const run = (id, extra) => insert(pool, 'workflow_runs', { id, case_id: a.case, ...extra });
  await rejects(run('r-bad', { consent_grant_id: b.consent }), runMessage);
  await run('r-good', { consent_grant_id: a.consent });
  await run('r-none', {});
  proves('workflow_runs_household_consent_insert');
  const runImmutable = 'workflow case and consent references are immutable';
  await rejects(pool.query("UPDATE workflow_runs SET case_revision = 'r2' WHERE id = 'r-good'"), runImmutable);
  await rejects(pool.query("UPDATE workflow_runs SET consent_grant_id = NULL WHERE id = 'r-good'"), runImmutable);
  await rejects(pool.query("UPDATE workflow_runs SET case_id = $1 WHERE id = 'r-good'", [b.case]), runImmutable);
  await pool.query("UPDATE workflow_runs SET status = 'running' WHERE id = 'r-good'");
  await pool.query("UPDATE workflow_runs SET consent_grant_id = consent_grant_id WHERE id = 'r-good'");
  proves('workflow_runs_refs_immutable');

  const dependencyMessage = 'workflow dependency must belong to the same run';
  const task = (id, workflow_run_id) => insert(pool, 'workflow_tasks', { id, workflow_run_id });
  await task('t1', 'r-good');
  await task('t2', 'r-good');
  await task('t3', 'r-good');
  await task('t-other-run', 'r-none');
  const dependency = (child, parent) => insert(pool, 'workflow_task_dependencies', { workflow_task_id: child, depends_on_task_id: parent });
  await rejects(dependency('t1', 't-other-run'), dependencyMessage);
  await dependency('t1', 't2');
  await rejects(pool.query("UPDATE workflow_task_dependencies SET depends_on_task_id = 't-other-run' WHERE workflow_task_id = 't1'"), dependencyMessage);
  await pool.query("UPDATE workflow_task_dependencies SET depends_on_task_id = 't3' WHERE workflow_task_id = 't1'");
  proves('workflow_task_dependencies_same_run_insert', 'workflow_task_dependencies_same_run_update');
});

test('OCR jobs need an active protected document and current consent; pages match their job', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const ocrMessage = 'OCR requires an active protected document and current processing consent';
  const doc = (id, consent_grant_id, extra = {}) => insert(pool, 'document_uploads', {
    id, household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult, consent_grant_id, ...extra,
  });
  const consent = (id, extra = {}) => insert(pool, 'consent_grants', { id, household_id: a.household, subject_adult_id: a.adult, ...extra });
  const job = (id, document_upload_id, extra = {}) => insert(pool, 'ocr_jobs', { id, document_upload_id, ...extra });

  await doc('d-quarantined', a.consent, { malware_status: 'pending' });
  await rejects(job('j-quarantined', 'd-quarantined'), ocrMessage);
  await consent('c-later-revoked');
  await doc('d-revoked-consent', 'c-later-revoked');
  await job('j-before-revoke', 'd-revoked-consent');
  await pool.query("UPDATE consent_grants SET revoked_at = $1 WHERE id = 'c-later-revoked'", [later]);
  await rejects(job('j-revoked', 'd-revoked-consent'), ocrMessage);
  await consent('c-expiring', { expires_at: later });
  await doc('d-expiring', 'c-expiring');
  await rejects(job('j-after-expiry', 'd-expiring', { requested_at: later }), ocrMessage);
  await rejects(job('j-after-expiry-offset', 'd-expiring', { requested_at: '2026-10-16T17:00:00+05:30' }), ocrMessage);
  await job('j-before-expiry', 'd-expiring', { requested_at: '2026-10-16T10:59:59.999Z' });
  await consent('c-purpose-changed');
  await doc('d-purpose-changed', 'c-purpose-changed');
  await pool.query("UPDATE consent_grants SET purpose = 'payment' WHERE id = 'c-purpose-changed'");
  await rejects(job('j-purpose', 'd-purpose-changed'), ocrMessage);
  await rejects(job('j-missing-doc', 'document-missing'), ocrMessage);
  await job('j-fixture-doc', a.document);
  proves('ocr_jobs_document_ready_insert');

  const pageMessage = 'source page OCR job must belong to its document';
  const page = (id, document_upload_id, ocr_job_id, number) => insert(pool, 'source_pages', {
    id, document_upload_id, ocr_job_id, page_number: number, source_version: `v-${id}`,
  });
  await rejects(page('p-cross', a.document, b.ocr, 10), pageMessage);
  await page('p-ok', a.document, 'j-fixture-doc', 11);
  await page('p-no-job', a.document, null, 12);
  await rejects(pool.query("UPDATE source_pages SET ocr_job_id = $1 WHERE id = 'p-ok'", [b.ocr]), pageMessage);
  await rejects(pool.query("UPDATE source_pages SET document_upload_id = $1 WHERE id = 'p-ok'", [b.document]), pageMessage);
  await pool.query("UPDATE source_pages SET ocr_job_id = NULL WHERE id = 'p-ok'");
  await pool.query("UPDATE source_pages SET ocr_job_id = 'j-fixture-doc' WHERE id = 'p-ok'");
  await pool.query("UPDATE source_pages SET extraction_status = 'failed' WHERE id = 'p-ok'");
  proves('source_pages_ocr_document_match_insert', 'source_pages_ocr_document_match_update');
});

async function parameterWorld(t) {
  const { pool, a, b } = await worlds(t);
  await seedParameter(pool, a, 'one');
  let sequence = 0;
  const makeParameter = async () => {
    sequence += 1;
    const row = await insert(pool, 'coverage_parameter_records', {
      id: `parameter-extra-${sequence}`, workflow_run_id: a.run, household_id: a.household, case_id: a.case,
      subject_id: a.member, policy_id: a.policy, parameter_key: `a.extra_${sequence}`,
    });
    return row.id;
  };
  return { pool, a, b, makeParameter, first: 'parameter-one' };
}

test('coverage parameter records, observations and registry metadata are guarded', postgresTestOptions(), async t => {
  const { pool, a, b, first } = await parameterWorld(t);

  const scopeMessage = 'coverage parameter must match its workflow case and household';
  const record = (id, key, extra) => insert(pool, 'coverage_parameter_records', {
    id, workflow_run_id: a.run, household_id: a.household, case_id: a.case, subject_id: a.member, policy_id: a.policy,
    parameter_key: key, ...extra,
  });
  await rejects(record('r-case', 'a.k1', { case_id: b.case }), scopeMessage);
  await rejects(record('r-member', 'a.k2', { subject_id: b.member }), scopeMessage);
  await rejects(record('r-policy', 'a.k3', { policy_id: b.policy }), scopeMessage);
  await rejects(record('r-household', 'a.k4', { household_id: b.household }), scopeMessage);
  await record('r-ok', 'a.k5', {});
  proves('coverage_parameter_records_scope_insert');
  const identity = 'coverage parameter identity is immutable';
  await rejects(pool.query("UPDATE coverage_parameter_records SET parameter_key = 'a.changed' WHERE id = 'r-ok'"), identity);
  await rejects(pool.query('UPDATE coverage_parameter_records SET case_id = case_id WHERE id = $1', ['r-ok']), identity);
  await pool.query('UPDATE coverage_parameter_records SET applicable = 0, updated_at = $1 WHERE id = $2', [later, 'r-ok']);
  proves('coverage_parameter_records_identity_immutable');

  const sourceMessage = 'parameter observation source must match its case and document page';
  const observation = (id, extra = {}) => insert(pool, 'coverage_parameter_observations', {
    id, parameter_record_id: first, source_id: a.page, document_id: a.document, ...extra,
  });
  await insert(pool, 'document_uploads', {
    id: 'document-a2', household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult,
    consent_grant_id: a.consent, storage_path: 'fixture/document-a2',
  });
  await rejects(observation('o-version', { version: 'version-9' }), sourceMessage);
  await rejects(observation('o-page', { page: '3' }), sourceMessage);
  await rejects(observation('o-page-text', { page: '02' }), sourceMessage);
  await rejects(observation('o-document', { document_id: 'document-a2' }), sourceMessage);
  await rejects(observation('o-other-source', { source_id: b.page }), sourceMessage);
  await observation('o-ok');
  proves('coverage_parameter_observations_source_insert');

  const activeMessage = 'parameter observations require an active document';
  await insert(pool, 'document_uploads', {
    id: 'document-quarantined', household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult,
    consent_grant_id: a.consent, malware_status: 'pending',
  });
  await insert(pool, 'source_pages', { id: 'page-quarantined', document_upload_id: 'document-quarantined' });
  await rejects(observation('o-quarantined', { source_id: 'page-quarantined', document_id: 'document-quarantined' }), activeMessage);
  await rejects(observation('o-missing-document', { document_id: 'document-missing' }), activeMessage);
  proves('coverage_parameter_observations_active_document_insert');

  const reviewMessage = 'human review observations must be recorded by the assigned reviewer';
  await rejects(observation('o-review-stranger', { extraction_method: 'human_review', recorded_by: 'stranger' }), reviewMessage);
  await observation('o-review-ok', { extraction_method: 'human_review', recorded_by: a.adult });
  await pool.query("UPDATE human_reviews SET status = 'requested' WHERE id = $1", [a.review]);
  await rejects(observation('o-review-not-started', { extraction_method: 'human_review', recorded_by: a.adult }), reviewMessage);
  await pool.query("UPDATE human_reviews SET status = 'completed' WHERE id = $1", [a.review]);
  await observation('o-review-completed', { extraction_method: 'human_review', recorded_by: a.adult });
  await pool.query('UPDATE human_reviews SET reviewer_adult_id = NULL WHERE id = $1', [a.review]);
  await rejects(observation('o-review-no-reviewer', { extraction_method: 'human_review', recorded_by: a.adult }), reviewMessage);
  await observation('o-not-review-method', { recorded_by: 'anyone' });
  proves('coverage_parameter_observations_human_review_insert');

  const appendOnly = 'coverage parameter observations are append only';
  const redaction = "value_json = NULL, redacted_at = '2026-10-16T12:00:00.000Z', redaction_reason_code = 'requested'";
  await rejects(pool.query("UPDATE coverage_parameter_observations SET review_status = 'accepted' WHERE id = 'o-ok'"), appendOnly);
  await rejects(pool.query("UPDATE coverage_parameter_observations SET value_json = '1' WHERE id = 'o-ok'"), appendOnly);
  await rejects(pool.query(`UPDATE coverage_parameter_observations SET ${redaction}, source_digest = '${hex('f')}' WHERE id = 'o-ok'`), appendOnly);
  await rejects(pool.query(`UPDATE coverage_parameter_observations SET ${redaction}, recorded_by = 'someone' WHERE id = 'o-ok'`), appendOnly);
  await rejects(pool.query("UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = '2026-10-16T12:00:00.000Z' WHERE id = 'o-ok'"), appendOnly);
  await pool.query(`UPDATE coverage_parameter_observations SET ${redaction} WHERE id = 'o-ok'`);
  await rejects(pool.query("UPDATE coverage_parameter_observations SET redacted_at = NULL, redaction_reason_code = NULL WHERE id = 'o-ok'"), appendOnly);
  await rejects(pool.query("UPDATE coverage_parameter_observations SET redaction_reason_code = 'other' WHERE id = 'o-ok'"), appendOnly);
  proves('coverage_parameter_observations_no_update');
  await rejects(pool.query('DELETE FROM coverage_parameter_observations'), appendOnly);
  await rejects(pool.query('TRUNCATE coverage_parameter_observations CASCADE'), appendOnly);
  assert.equal((await pool.query("DELETE FROM coverage_parameter_observations WHERE id = 'nothing'")).rowCount, 0);
  proves('coverage_parameter_observations_no_delete', 'coverage_parameter_observations_no_truncate');

  await rejects(pool.query("UPDATE coverage_parameter_registry_pins SET pinned_at = '2026-10-16T12:00:00.000Z'"), 'registry pins are immutable');
  await rejects(pool.query('UPDATE coverage_parameter_registry_pins SET registry_version = registry_version'), 'registry pins are immutable');
  await rejects(pool.query('DELETE FROM coverage_parameter_registry_pins WHERE workflow_run_id = $1', [a.run]), 'registry pins are immutable');
  await insert(pool, 'workflow_runs', { id: 'run-second', case_id: a.case });
  await insert(pool, 'coverage_parameter_registry_pins', { workflow_run_id: 'run-second' });
  await rejects(pool.query('TRUNCATE coverage_parameter_registry_pins CASCADE'), 'registry pins are immutable');
  proves(
    'coverage_parameter_registry_pins_immutable', 'coverage_parameter_registry_pins_no_delete',
    'coverage_parameter_registry_pins_no_truncate',
  );
  await rejects(pool.query("UPDATE coverage_parameter_registry_versions SET registered_at = 'x'"), 'registry versions are immutable');
  await rejects(pool.query('DELETE FROM coverage_parameter_registry_versions'), 'registry versions are immutable');
  await pool.query("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('policy-parameters/v2', $1)", [at]);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM coverage_parameter_registry_versions')).n, 2);
  await rejects(pool.query('TRUNCATE coverage_parameter_registry_versions CASCADE'), 'registry versions are immutable');
  proves(
    'coverage_parameter_registry_versions_immutable', 'coverage_parameter_registry_versions_no_delete',
    'coverage_parameter_registry_versions_no_truncate',
  );
  await rejects(pool.query('UPDATE coverage_parameter_observation_rules SET requires_accepted = 0'), 'observation rules are immutable');
  await rejects(pool.query('DELETE FROM coverage_parameter_observation_rules'), 'observation rules are immutable');
  await pool.query(`INSERT INTO coverage_parameter_observation_rules
    (extraction_method, resolution_state, transition_authority, requires_accepted)
    VALUES ('human_report', 'unknown', 'deterministic', 0)`);
  await rejects(pool.query('TRUNCATE coverage_parameter_observation_rules'), 'observation rules are immutable');
  proves(
    'coverage_parameter_observation_rules_immutable', 'coverage_parameter_observation_rules_no_delete',
    'coverage_parameter_observation_rules_no_truncate',
  );
});

test('temporary tables cannot replace relations used by guard functions', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const client = await pool.connect();
  try {
    const world = await seedWorld(client, 'search-path');
    await client.query('UPDATE public.consent_grants SET revoked_at = $1 WHERE id = $2', [later, world.consent]);
    await client.query('CREATE TEMP TABLE consent_grants AS SELECT * FROM public.consent_grants');
    await client.query('UPDATE pg_temp.consent_grants SET revoked_at = NULL WHERE id = $1', [world.consent]);
    await rejects(insert(client, 'document_uploads', {
      id: 'document-temp-shadow', household_id: world.household, case_id: world.case,
      uploaded_by_adult_id: world.adult, consent_grant_id: world.consent,
    }), 'document must be household and active-consent scoped');
    assert.equal((await one(client, "SELECT count(*)::int AS n FROM public.document_uploads WHERE id = 'document-temp-shadow'")).n, 0);
  } finally {
    client.release();
  }
});

test('coverage parameter resolutions derive authority from the observation', postgresTestOptions(), async t => {
  const { pool, a, makeParameter } = await parameterWorld(t);
  const observe = (parameter, extra = {}) => seedObservation(pool, a, parameter, extra);
  const resolve = (parameter, extra) => insert(pool, 'coverage_parameter_resolutions', { parameter_record_id: parameter, ...extra });
  const supported = 'resolution state and authority are not supported by the observation';
  const own = 'resolved observation must belong to the parameter';

  // Observation must belong to the parameter.
  const p1 = await makeParameter();
  const p2 = await makeParameter();
  const o2 = await observe(p2, { id: 'o-p2' });
  await rejects(resolve(p1, {
    resolution_state: 'extracted_unverified', transition_authority: 'model', resolved_value_json: '1', resolved_observation_id: o2,
  }), own);
  const o1 = await observe(p1, { id: 'o-p1' });
  await resolve(p1, {
    resolution_state: 'extracted_unverified', transition_authority: 'model', resolved_value_json: '1', resolved_observation_id: o1,
  });
  await rejects(pool.query('UPDATE coverage_parameter_resolutions SET resolved_observation_id = $1 WHERE parameter_record_id = $2', [o2, p1]), own);
  await pool.query('UPDATE coverage_parameter_resolutions SET resolved_value_json = $1 WHERE parameter_record_id = $2', ['2', p1]);
  proves('coverage_parameter_resolutions_observation_insert', 'coverage_parameter_resolutions_observation_update');

  // Authority is a property of the evidence.
  const p3 = await makeParameter();
  const modelObservation = await observe(p3, { id: 'o-model' });
  const unreviewedHuman = await observe(p3, { id: 'o-human-unreviewed', extraction_method: 'human_review', recorded_by: a.adult });
  const acceptedHuman = await observe(p3, {
    id: 'o-human-accepted', extraction_method: 'human_review', recorded_by: a.adult, review_status: 'accepted',
  });
  const rejectedHuman = await observe(p3, {
    id: 'o-human-rejected', extraction_method: 'human_review', recorded_by: a.adult, review_status: 'rejected',
  });
  const attempt = (state, authority, observation) => resolve(p3, {
    resolution_state: state, transition_authority: authority, resolved_value_json: '1', resolved_observation_id: observation,
  });
  await rejects(attempt('proven', 'human_reviewer', modelObservation), supported);
  await rejects(attempt('calculated', 'deterministic', modelObservation), supported);
  await rejects(attempt('extracted_unverified', 'deterministic', modelObservation), supported);
  await rejects(attempt('proven', 'human_reviewer', unreviewedHuman), supported);
  await rejects(attempt('reported', 'human_reviewer', rejectedHuman), supported);
  await attempt('reported', 'human_reviewer', unreviewedHuman);
  await pool.query('DELETE FROM coverage_parameter_resolutions WHERE parameter_record_id = $1', [p3]);
  await attempt('proven', 'human_reviewer', acceptedHuman);
  proves('coverage_parameter_resolutions_authority_insert');

  await rejects(pool.query(
    'UPDATE coverage_parameter_resolutions SET resolution_state = $1, resolved_observation_id = $2 WHERE parameter_record_id = $3',
    ['proven', unreviewedHuman, p3],
  ), supported);
  await pool.query(
    'UPDATE coverage_parameter_resolutions SET resolution_state = $1, resolved_observation_id = $2 WHERE parameter_record_id = $3',
    ['reported', unreviewedHuman, p3],
  );
  proves('coverage_parameter_resolutions_authority_update');

  // A model cannot replace an established resolution.
  const noDowngrade = 'model authority cannot replace an established resolution';
  await pool.query(
    'UPDATE coverage_parameter_resolutions SET resolution_state = $1, resolved_observation_id = $2 WHERE parameter_record_id = $3',
    ['proven', acceptedHuman, p3],
  );
  await rejects(pool.query(
    'UPDATE coverage_parameter_resolutions SET resolution_state = $1, transition_authority = $2, resolved_observation_id = $3 WHERE parameter_record_id = $4',
    ['extracted_unverified', 'model', modelObservation, p3],
  ), noDowngrade);
  const p4 = await makeParameter();
  await resolve(p4, { resolution_state: 'not_permitted', transition_authority: 'deterministic' });
  await rejects(pool.query(
    "UPDATE coverage_parameter_resolutions SET resolution_state = 'unknown', transition_authority = 'model' WHERE parameter_record_id = $1", [p4],
  ), noDowngrade);
  const p5 = await makeParameter();
  const o5 = await observe(p5, { id: 'o-p5' });
  await resolve(p5, {
    resolution_state: 'extracted_unverified', transition_authority: 'model', resolved_value_json: '1', resolved_observation_id: o5,
  });
  await pool.query(
    "UPDATE coverage_parameter_resolutions SET resolution_state = 'unknown', resolved_value_json = NULL, resolved_observation_id = NULL WHERE parameter_record_id = $1", [p5],
  );
  proves('coverage_parameter_resolutions_model_no_downgrade');

  // not_permitted can only return to unknown.
  const exit = 'not_permitted can only return to unknown';
  await rejects(pool.query("UPDATE coverage_parameter_resolutions SET resolution_state = 'reported' WHERE parameter_record_id = $1", [p4]), exit);
  await rejects(pool.query("UPDATE coverage_parameter_resolutions SET resolution_state = 'conflicting' WHERE parameter_record_id = $1", [p4]), exit);
  await pool.query("UPDATE coverage_parameter_resolutions SET resolution_state = 'not_permitted', reason_code = 'again' WHERE parameter_record_id = $1", [p4]);
  await pool.query("UPDATE coverage_parameter_resolutions SET resolution_state = 'unknown' WHERE parameter_record_id = $1", [p4]);
  proves('coverage_parameter_resolutions_not_permitted_exit');
});

test('redaction withdraws resolutions and document erasure redacts observations', postgresTestOptions(), async t => {
  const { pool, a, makeParameter } = await parameterWorld(t);
  const observe = (parameter, extra = {}) => seedObservation(pool, a, parameter, extra);
  const resolve = (parameter, extra) => insert(pool, 'coverage_parameter_resolutions', { parameter_record_id: parameter, ...extra });
  const redact = id => pool.query(
    "UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = $2, redaction_reason_code = 'requested' WHERE id = $1",
    [id, '2026-10-16T12:00:00.000Z'],
  );

  const p1 = await makeParameter();
  const o1 = await observe(p1, { id: 'o-r1' });
  const o1b = await observe(p1, { id: 'o-r1b' });
  await resolve(p1, {
    resolution_state: 'extracted_unverified', transition_authority: 'model', resolved_value_json: '1', resolved_observation_id: o1,
  });
  const p2 = await makeParameter();
  const o2 = await observe(p2, { id: 'o-r2' });
  await resolve(p2, {
    resolution_state: 'extracted_unverified', transition_authority: 'model', resolved_value_json: '2', resolved_observation_id: o2,
  });
  const p3 = await makeParameter();
  await observe(p3, { id: 'o-r3' });
  await observe(p3, { id: 'o-r3b' });
  await resolve(p3, { resolution_state: 'conflicting', transition_authority: 'model' });

  await redact(o1b);
  assert.equal((await one(pool, 'SELECT resolution_state FROM coverage_parameter_resolutions WHERE parameter_record_id = $1', [p1])).resolution_state,
    'extracted_unverified', 'redacting an unrelated observation leaves the resolution');
  await redact(o1);
  const reset = await one(pool, 'SELECT * FROM coverage_parameter_resolutions WHERE parameter_record_id = $1', [p1]);
  assert.deepEqual(
    { state: reset.resolution_state, value: reset.resolved_value_json, observation: reset.resolved_observation_id, reason: reset.reason_code,
      authority: reset.transition_authority, by: reset.updated_by, at: reset.updated_at },
    { state: 'unknown', value: null, observation: null, reason: 'source_redacted', authority: 'deterministic',
      by: 'privacy-redaction', at: '2026-10-16T12:00:00.000Z' },
  );
  assert.equal((await one(pool, 'SELECT resolution_state FROM coverage_parameter_resolutions WHERE parameter_record_id = $1', [p2])).resolution_state,
    'extracted_unverified', 'another parameter is untouched');
  await redact('o-r3');
  assert.equal((await one(pool, 'SELECT reason_code FROM coverage_parameter_resolutions WHERE parameter_record_id = $1', [p3])).reason_code,
    'source_redacted', 'a conflict built from the parameter is withdrawn');
  proves('coverage_parameter_observations_redaction_resets_resolution');

  // Document erasure: a deletion request redacts every observation of the document, and chains into the reset.
  await insert(pool, 'document_uploads', {
    id: 'document-erase', household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult,
    consent_grant_id: a.consent, storage_path: 'fixture/erase',
  });
  await insert(pool, 'source_pages', { id: 'page-erase', document_upload_id: 'document-erase' });
  const erased = await observe(p2, { id: 'o-erase', source_id: 'page-erase', document_id: 'document-erase' });
  await pool.query('UPDATE coverage_parameter_resolutions SET resolved_observation_id = $1 WHERE parameter_record_id = $2', [erased, p2]);
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-erase'");
  assert.equal((await one(pool, "SELECT redacted_at FROM coverage_parameter_observations WHERE id = 'o-erase'")).redacted_at, null,
    'quarantine is not erasure');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-erase'");
  const row = await one(pool, "SELECT value_json, redacted_at, redaction_reason_code FROM coverage_parameter_observations WHERE id = 'o-erase'");
  assert.equal(row.value_json, null);
  assert.equal(row.redaction_reason_code, 'document_erasure');
  assert.match(row.redacted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal((await one(pool, 'SELECT resolution_state FROM coverage_parameter_resolutions WHERE parameter_record_id = $1', [p2])).resolution_state,
    'unknown', 'the resolution relying on the erased value is withdrawn');
  const other = await observe(p3, { id: 'o-other-document' });
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-erase'");
  assert.equal((await one(pool, 'SELECT redacted_at FROM coverage_parameter_observations WHERE id = $1', [other])).redacted_at, null,
    'observations of another document are untouched');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deleted' WHERE id = 'document-erase'");
  assert.equal((await one(pool, "SELECT redaction_reason_code FROM coverage_parameter_observations WHERE id = 'o-erase'")).redaction_reason_code, 'document_erasure');
  proves('coverage_parameter_observations_redact_on_document_erasure');
});

test('evidence facts allow only the redaction update; document erasure redacts them', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const appendOnly = 'evidence facts are append only; add a superseding fact';
  const documentFact = id => insert(pool, 'evidence_facts', {
    id, household_id: a.household, case_id: a.case, policy_id: a.policy, subject_member_id: a.member,
    epistemic_state: 'known', value_json: '{"limit":5000}', evidence_kind: 'document', provenance_kind: 'document_page',
    source_page_id: a.page, source_locator: 'page 3, table 2', institutional_source_ref: 'ref-1',
    calculation_method: 'none', permitted_viewers_json: '["adult-a"]', effective_at: at,
    statement_adult_id: a.adult, review_status: 'unreviewed', subject_confirmation_state: 'not_applicable',
  });
  const redaction = {
    epistemic_state: "'unknown'", value_json: 'NULL', source_page_id: 'NULL', source_locator: 'NULL',
    institutional_source_ref: 'NULL', calculation_method: 'NULL', permitted_viewers_json: 'NULL', effective_at: 'NULL',
    redacted_at: `'${later}'`, redaction_reason_code: "'consent_revoked'",
  };
  const erase = (overrides = {}) => Object.entries({ ...redaction, ...overrides }).map(([column, value]) => `${column} = ${value}`).join(', ');
  await documentFact('f-redact');

  // Redaction plus any change to an immutable column is rejected.
  const immutable = {
    id: "'f-renamed'", household_id: `'${b.household}'`, case_id: 'NULL', policy_id: 'NULL', subject_member_id: 'NULL',
    fact_key: "'other_key'", evidence_kind: "'fixture'", provenance_kind: "'fixture'", statement_adult_id: 'NULL',
    asserted_by: "'someone-else'", observed_at: `'${later}'`, retrieved_at: `'${later}'`, confidence_basis_points: '1',
    review_status: "'reviewed'", subject_confirmation_state: "'confirmed'", expires_at: `'${later}'`,
    supersedes_fact_id: `'${a.fact}'`, created_at: `'${later}'`,
  };
  for (const [column, value] of Object.entries(immutable)) {
    await rejects(pool.query(`UPDATE evidence_facts SET ${erase({ [column]: value })} WHERE id = 'f-redact'`), appendOnly);
  }
  // A partial redaction is rejected: every value-bearing column must be erased and the state UNKNOWN.
  const retained = {
    value_json: "'5000'", source_page_id: `'${a.page}'`, source_locator: "'page 3'", institutional_source_ref: "'ref-1'",
    calculation_method: "'none'", permitted_viewers_json: "'[]'", effective_at: `'${at}'`, epistemic_state: "'conflict'",
    redacted_at: 'NULL', redaction_reason_code: 'NULL',
  };
  for (const [column, value] of Object.entries(retained)) {
    await rejects(pool.query(`UPDATE evidence_facts SET ${erase({ [column]: value })} WHERE id = 'f-redact'`), appendOnly);
  }
  for (const value of ["''", "'yesterday'", "'2026-10-18T12:00:00Z'", "'2026-10-18T12:00:00.000Zjunk'", "'2026-13-01T00:00:00.000Z'", "'2026-10-18T25:00:00.000Z'"]) {
    // The 006 format trigger (P0001) runs before the 005 CHECK (23514); either rejects.
    await assert.rejects(pool.query(`UPDATE evidence_facts SET ${erase({ redacted_at: value })} WHERE id = 'f-redact'`),
      error => ['23514', 'P0001'].includes(error.code));
  }
  // A value the 005 CHECK accepts (seconds without milliseconds) is rejected by the 006 trigger.
  await rejects(pool.query(`UPDATE evidence_facts SET ${erase({ redacted_at: "'2026-10-18T12:00:00Z'" })} WHERE id = 'f-redact'`),
    'evidence fact redaction time must be ISO-8601 UTC with milliseconds');
  proves('evidence_facts_redaction_format_update');
  await pool.query(`UPDATE evidence_facts SET ${erase()} WHERE id = 'f-redact'`);
  const redacted = await one(pool, "SELECT * FROM evidence_facts WHERE id = 'f-redact'");
  assert.equal(redacted.epistemic_state, 'unknown');
  assert.equal(redacted.value_json, null);
  assert.equal(redacted.source_page_id, null);
  assert.equal(redacted.redaction_reason_code, 'consent_revoked');
  assert.equal(redacted.fact_key, 'room_limit', 'provenance and identity survive');
  assert.equal(redacted.statement_adult_id, a.adult);
  // A redacted fact is final.
  await rejects(pool.query(`UPDATE evidence_facts SET redacted_at = '${at}' WHERE id = 'f-redact'`), appendOnly);
  await rejects(pool.query("UPDATE evidence_facts SET redaction_reason_code = 'other' WHERE id = 'f-redact'"), appendOnly);
  await rejects(pool.query("DELETE FROM evidence_facts WHERE id = 'f-redact'"), appendOnly);
  proves('evidence_facts_provenance_immutable');

  const insertedRedacted = 'evidence facts cannot be inserted redacted';
  await rejects(insert(pool, 'evidence_facts', {
    id: 'f-born-redacted', household_id: a.household, redacted_at: at, redaction_reason_code: 'consent_revoked',
  }), insertedRedacted);
  await insert(pool, 'evidence_facts', { id: 'f-born-plain', household_id: a.household });
  proves('evidence_facts_redaction_insert');

  // Document erasure redacts facts sourced from the document's pages, and only those.
  await insert(pool, 'document_uploads', {
    id: 'document-fact-erase', household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult,
    consent_grant_id: a.consent, storage_path: 'fixture/fact-erase',
  });
  await insert(pool, 'source_pages', { id: 'page-fact-erase', document_upload_id: 'document-fact-erase' });
  await insert(pool, 'evidence_facts', {
    id: 'f-erase', household_id: a.household, epistemic_state: 'known', value_json: '7', evidence_kind: 'document',
    provenance_kind: 'document_page', source_page_id: 'page-fact-erase', source_locator: 'p1',
  });
  await documentFact('f-other-document');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-fact-erase'");
  assert.equal((await one(pool, "SELECT redacted_at FROM evidence_facts WHERE id = 'f-erase'")).redacted_at, null,
    'quarantine is not erasure');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-fact-erase'");
  const row = await one(pool, "SELECT * FROM evidence_facts WHERE id = 'f-erase'");
  assert.equal(row.value_json, null);
  assert.equal(row.source_page_id, null);
  assert.equal(row.source_locator, null);
  assert.equal(row.epistemic_state, 'unknown');
  assert.equal(row.redaction_reason_code, 'document_erasure');
  assert.match(row.redacted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal((await one(pool, "SELECT redacted_at FROM evidence_facts WHERE id = 'f-other-document'")).redacted_at, null,
    'facts of another document are untouched');
  // A direct move to deleted is erasure too.
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deleted' WHERE id = $1", [a.document]);
  const deleted = await one(pool, "SELECT * FROM evidence_facts WHERE id = 'f-other-document'");
  assert.equal(deleted.value_json, null);
  assert.equal(deleted.source_page_id, null);
  assert.equal(deleted.redaction_reason_code, 'document_erasure');
  proves('evidence_facts_redact_on_document_erasure');

  // Erasure has started: a new fact cannot cite those pages; a live document still can.
  const erasedMessage = 'evidence facts cannot cite an erased document';
  const cite = (id, source_page_id) => insert(pool, 'evidence_facts', {
    id, household_id: a.household, epistemic_state: 'known', value_json: '7', evidence_kind: 'document',
    provenance_kind: 'document_page', source_page_id,
  });
  await rejects(cite('f-after-request', 'page-fact-erase'), erasedMessage);
  await rejects(cite('f-after-delete', a.page), erasedMessage);
  await insert(pool, 'document_uploads', {
    id: 'document-fact-live', household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult,
    consent_grant_id: a.consent, storage_path: 'fixture/fact-live',
  });
  await insert(pool, 'source_pages', { id: 'page-fact-live', document_upload_id: 'document-fact-live' });
  await cite('f-live', 'page-fact-live');
  proves('evidence_facts_erased_document_insert');
});

test('policy structuring runs and proposals stay scoped, append only and erase with their document', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const run = (id, extra = {}) => insert(pool, 'policy_structuring_runs', {
    id, household_id: a.household, case_id: a.case, workflow_run_id: a.run, document_id: a.document, ...extra,
  });
  const runScope = 'policy structuring run must match its workflow case, household and document';
  await rejects(run('sr-other-household', { household_id: b.household }), runScope);
  await rejects(run('sr-other-document', { document_id: b.document }), runScope);
  await rejects(run('sr-other-run', { workflow_run_id: b.run }), runScope);
  await run('sr-1');
  proves('policy_structuring_runs_scope_insert');
  await rejects(run('sr-erased', { pipeline_version: 'policy-structuring/v2', erased_at: later, erasure_reason_code: 'consent_revoked' }),
    'policy structuring runs cannot be inserted erased');
  proves('policy_structuring_runs_erased_insert');
  // The live identity is unique.
  await assert.rejects(run('sr-duplicate'), error => error.code === '23505');

  const proposal = (id, extra = {}) => insert(pool, 'proposed_parameters', {
    id, structuring_run_id: 'sr-1', household_id: a.household, document_id: a.document, source_page_id: a.page, ...extra,
  });
  const proposalScope = 'proposed parameter must match its structuring run, household and document page';
  await rejects(proposal('pp-household', { household_id: b.household }), proposalScope);
  await rejects(proposal('pp-page', { source_page_id: b.page }), proposalScope);
  await rejects(proposal('pp-page-number', { page: 3 }), proposalScope);
  await proposal('pp-1');
  await proposal('pp-2');
  proves('proposed_parameters_scope_insert');
  const initial = 'proposed parameters are inserted pending review and unredacted';
  await rejects(proposal('pp-accepted', { status: 'accepted' }), initial);
  await rejects(proposal('pp-redacted', { label: null, value_json: null, redacted_at: later, redaction_reason_code: 'consent_revoked' }), initial);
  proves('proposed_parameters_initial_state_insert');

  const appendOnly = 'proposed parameters are append only';
  await rejects(pool.query("UPDATE proposed_parameters SET label = 'changed' WHERE id = 'pp-1'"), appendOnly);
  await rejects(pool.query("UPDATE proposed_parameters SET proposed_key = 'other_key', status = 'accepted' WHERE id = 'pp-1'"), appendOnly);
  await rejects(pool.query(`UPDATE proposed_parameters SET label = NULL, value_json = NULL, redacted_at = '${later}',
    redaction_reason_code = 'consent_revoked', status = 'accepted' WHERE id = 'pp-1'`), appendOnly);
  await pool.query("UPDATE proposed_parameters SET status = 'accepted' WHERE id = 'pp-1'");
  await pool.query(`UPDATE proposed_parameters SET label = NULL, value_json = NULL, redacted_at = '${later}',
    redaction_reason_code = 'consent_revoked' WHERE id = 'pp-1'`);
  await rejects(pool.query("UPDATE proposed_parameters SET status = 'rejected' WHERE id = 'pp-1'"), appendOnly);
  await rejects(pool.query("DELETE FROM proposed_parameters WHERE id = 'pp-2'"), appendOnly);
  await rejects(pool.query('TRUNCATE proposed_parameters'), appendOnly);
  proves('proposed_parameters_no_update', 'proposed_parameters_no_delete', 'proposed_parameters_no_truncate');

  const runAppendOnly = 'policy structuring runs are append only';
  await rejects(pool.query("UPDATE policy_structuring_runs SET counts_json = '{}' WHERE id = 'sr-1'"), runAppendOnly);
  await rejects(pool.query(`UPDATE policy_structuring_runs SET erased_at = '${later}', erasure_reason_code = 'consent_revoked',
    counts_json = '{}' WHERE id = 'sr-1'`), runAppendOnly);
  await rejects(pool.query("DELETE FROM policy_structuring_runs WHERE id = 'sr-1'"), runAppendOnly);
  await rejects(pool.query('TRUNCATE policy_structuring_runs CASCADE'), runAppendOnly);
  // An erased identity frees the slot; an erased run takes no proposals.
  await insert(pool, 'document_uploads', {
    id: 'document-structure-live', household_id: a.household, case_id: a.case, uploaded_by_adult_id: a.adult,
    consent_grant_id: a.consent, storage_path: 'fixture/structure-live',
  });
  await insert(pool, 'source_pages', { id: 'page-structure-live', document_upload_id: 'document-structure-live' });
  await run('sr-live', { document_id: 'document-structure-live' });
  await pool.query(`UPDATE policy_structuring_runs SET erased_at = '${later}', erasure_reason_code = 'consent_revoked' WHERE id = 'sr-live'`);
  await rejects(pool.query(`UPDATE policy_structuring_runs SET erased_at = '${at}', erasure_reason_code = 'consent_revoked' WHERE id = 'sr-live'`), runAppendOnly);
  proves('policy_structuring_runs_no_update', 'policy_structuring_runs_no_delete', 'policy_structuring_runs_no_truncate');
  await rejects(proposal('pp-erased-run', {
    structuring_run_id: 'sr-live', document_id: 'document-structure-live', source_page_id: 'page-structure-live',
  }), proposalScope);
  await run('sr-live-2', { document_id: 'document-structure-live' });

  // Document erasure: proposals redacted, runs stamped erased; other documents untouched.
  await proposal('pp-live', { structuring_run_id: 'sr-live-2', document_id: 'document-structure-live', source_page_id: 'page-structure-live' });
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-structure-live'");
  assert.equal((await one(pool, "SELECT redacted_at FROM proposed_parameters WHERE id = 'pp-live'")).redacted_at, null, 'quarantine is not erasure');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-structure-live'");
  const erasedProposal = await one(pool, "SELECT * FROM proposed_parameters WHERE id = 'pp-live'");
  assert.equal(erasedProposal.label, null);
  assert.equal(erasedProposal.value_json, null);
  assert.equal(erasedProposal.redaction_reason_code, 'document_erasure');
  assert.match(erasedProposal.redacted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const erasedRun = await one(pool, "SELECT erased_at, erasure_reason_code FROM policy_structuring_runs WHERE id = 'sr-live-2'");
  assert.equal(erasedRun.erasure_reason_code, 'document_erasure');
  assert.equal((await one(pool, "SELECT erasure_reason_code FROM policy_structuring_runs WHERE id = 'sr-live'")).erasure_reason_code,
    'consent_revoked', 'an earlier erasure stamp is kept');
  assert.equal((await one(pool, "SELECT redacted_at FROM proposed_parameters WHERE id = 'pp-2'")).redacted_at, null, 'other documents untouched');
  proves('policy_structuring_erase_on_document_erasure');

  // Inactive documents take neither runs nor proposals.
  await rejects(run('sr-inactive', { document_id: 'document-structure-live', pipeline_version: 'policy-structuring/v3' }),
    'policy structuring requires an active document');
  proves('policy_structuring_runs_active_document_insert');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = $1", [a.document]);
  await rejects(proposal('pp-inactive'), 'proposed parameters require an active document');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = $1", [a.document]);
  await proposal('pp-active-again');
  proves('proposed_parameters_active_document_insert');
});

test('policy structuring jobs stay scoped, start active, keep identity and final status, and erase with their document', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const job = (id, extra = {}) => insert(pool, 'policy_structuring_jobs', {
    id, household_id: a.household, case_id: a.case, workflow_run_id: a.run, document_id: a.document, consent_grant_id: a.consent, ...extra,
  });
  const scope = 'policy structuring job must start active and match its case, household, document and grant';
  await rejects(job('job-other-household', { household_id: b.household }), scope);
  await rejects(job('job-other-document', { document_id: b.document }), scope);
  await rejects(job('job-other-grant', { consent_grant_id: b.consent }), scope);
  await rejects(job('job-finished', { status: 'committed', finished_at: at }), scope);
  await rejects(job('job-erased', { erased_at: later, erasure_reason_code: 'consent_revoked' }), scope);
  await job('job-1');
  proves('policy_structuring_jobs_scope_insert');
  // One active attempt per (workflow run, document); attempts are unique.
  await assert.rejects(job('job-second-running', { attempt: 2 }), error => error.code === '23505');

  const appendOnly = 'policy structuring jobs are append only';
  await rejects(pool.query("UPDATE policy_structuring_jobs SET attempt = 5 WHERE id = 'job-1'"), appendOnly);
  await rejects(pool.query(`UPDATE policy_structuring_jobs SET document_id = '${b.document}' WHERE id = 'job-1'`), appendOnly);
  await pool.query(`UPDATE policy_structuring_jobs SET status = 'interrupted', finished_at = '${later}', updated_at = '${later}' WHERE id = 'job-1'`);
  await rejects(pool.query(`UPDATE policy_structuring_jobs SET status = 'running', finished_at = NULL WHERE id = 'job-1'`), appendOnly);
  await rejects(pool.query("UPDATE policy_structuring_jobs SET error_code = 'CHANGED' WHERE id = 'job-1'"), appendOnly);
  await pool.query(`UPDATE policy_structuring_jobs SET erased_at = '${later}', erasure_reason_code = 'consent_revoked' WHERE id = 'job-1'`);
  await rejects(pool.query(`UPDATE policy_structuring_jobs SET erased_at = '${at}', erasure_reason_code = 'consent_revoked' WHERE id = 'job-1'`), appendOnly);
  await rejects(pool.query("DELETE FROM policy_structuring_jobs WHERE id = 'job-1'"), appendOnly);
  await rejects(pool.query('TRUNCATE policy_structuring_jobs'), appendOnly);
  proves('policy_structuring_jobs_no_update', 'policy_structuring_jobs_no_delete', 'policy_structuring_jobs_no_truncate');

  await job('job-2', { attempt: 2 });
  await insert(pool, 'policy_structuring_jobs', {
    id: 'job-b', household_id: b.household, case_id: b.case, workflow_run_id: b.run, document_id: b.document, consent_grant_id: b.consent,
  });
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = $1", [a.document]);
  assert.equal((await one(pool, "SELECT erased_at FROM policy_structuring_jobs WHERE id = 'job-2'")).erased_at, null, 'quarantine is not erasure');
  await pool.query("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = $1", [a.document]);
  const erased = await one(pool, "SELECT status, erasure_reason_code FROM policy_structuring_jobs WHERE id = 'job-2'");
  assert.deepEqual(erased, { status: 'running', erasure_reason_code: 'document_erasure' }, 'status kept, stamp set');
  assert.equal((await one(pool, "SELECT erasure_reason_code FROM policy_structuring_jobs WHERE id = 'job-1'")).erasure_reason_code,
    'consent_revoked', 'an earlier erasure stamp is kept');
  assert.equal((await one(pool, "SELECT erased_at FROM policy_structuring_jobs WHERE id = 'job-b'")).erased_at, null, 'other documents untouched');
  proves('policy_structuring_jobs_erase_on_document_erasure');
});

test('stored OCR blocks need page text and a live document, are immutable and erase with text or document', postgresTestOptions(), async t => {
  const { pool, a } = await worlds(t);
  const blocks = page => serializeStoredBlocks(page, buildStoredBlocks([{ text: `text ${page}`, tag: 'paragraph', readingOrder: 1 }], `text ${page}`));
  const page = (id, number, extra = {}) => insert(pool, 'source_pages', {
    id, document_upload_id: a.document, ocr_job_id: a.ocr, page_number: number, source_version: 'version-blocks',
    extracted_text: `text ${number}`, blocks_json: blocks(number), ...extra,
  });
  const insertMessage = 'source page blocks require page text and a live document';
  await rejects(page('pb-no-text', 10, { extracted_text: null }), insertMessage);
  await page('pb-1', 11);
  await page('pb-2', 12);
  await page('pb-v1', 13, { blocks_json: null });
  await page('pb-v1-no-text', 14, { extracted_text: null, blocks_json: null });
  proves('source_pages_blocks_insert');

  const immutable = 'source page blocks are immutable; only erasure may clear them';
  await rejects(pool.query("UPDATE source_pages SET blocks_json = $1 WHERE id = 'pb-1'", [blocks(12)]), immutable);
  await rejects(pool.query("UPDATE source_pages SET blocks_json = $1 WHERE id = 'pb-v1'", [blocks(13)]), immutable);
  await pool.query("UPDATE source_pages SET blocks_json = blocks_json WHERE id = 'pb-1'");
  // Narrowed (014/011): a v1 page takes blocks once, only from a succeeded knowvia.ocr.v2 upgrade job of
  // the same document version, with its text unchanged; the upgrade job is set once with the blocks.
  await pool.query("UPDATE document_uploads SET source_version = 'version-blocks' WHERE id = $1", [a.document]);
  await insert(pool, 'ocr_jobs', { id: 'ocr-upgrade-running', document_upload_id: a.document, status: 'processing', contract_version: 'knowvia.ocr.v2' });
  await insert(pool, 'ocr_jobs', { id: 'ocr-upgrade', document_upload_id: a.document, status: 'succeeded', contract_version: 'knowvia.ocr.v2' });
  const upgradeJob = 'source page blocks upgrade job is set once with its blocks';
  const fill = (job, id = 'pb-v1') => pool.query('UPDATE source_pages SET blocks_json = $1, blocks_upgrade_job_id = $2 WHERE id = $3', [blocks(13), job, id]);
  await rejects(fill(a.ocr), immutable);
  await rejects(fill('ocr-upgrade-running'), immutable);
  await rejects(pool.query("UPDATE source_pages SET blocks_upgrade_job_id = 'ocr-upgrade' WHERE id = 'pb-v1'"), upgradeJob);
  await rejects(pool.query("UPDATE source_pages SET blocks_json = $1, blocks_upgrade_job_id = 'ocr-upgrade', extracted_text = 'changed' WHERE id = 'pb-v1'", [blocks(13)]), immutable);
  await fill('ocr-upgrade');
  await rejects(pool.query("UPDATE source_pages SET blocks_json = $1 WHERE id = 'pb-v1'", [blocks(12)]), immutable);
  await rejects(pool.query("UPDATE source_pages SET blocks_upgrade_job_id = 'ocr-upgrade-running' WHERE id = 'pb-v1'"), upgradeJob);
  proves('source_pages_blocks_immutable', 'source_pages_blocks_upgrade_job_immutable');

  await pool.query("UPDATE source_pages SET extracted_text = NULL WHERE id = 'pb-1'");
  assert.equal((await one(pool, "SELECT blocks_json FROM source_pages WHERE id = 'pb-1'")).blocks_json, null);
  assert.notEqual((await one(pool, "SELECT blocks_json FROM source_pages WHERE id = 'pb-2'")).blocks_json, null, 'other pages untouched');
  await rejects(pool.query("UPDATE source_pages SET blocks_json = $1 WHERE id = 'pb-1'", [blocks(11)]), immutable);
  proves('source_pages_blocks_erase_with_text');

  await pool.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', ['quarantined', a.document]);
  assert.notEqual((await one(pool, "SELECT blocks_json FROM source_pages WHERE id = 'pb-2'")).blocks_json, null, 'quarantine is not erasure');
  await pool.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', ['deletion_requested', a.document]);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM source_pages WHERE blocks_json IS NOT NULL")).n, 0);
  await rejects(page('pb-erased', 15), insertMessage);
  proves('source_pages_blocks_erase_on_document_erasure');
});

test('policy clauses and answers stay scoped, immutable and erase with their document', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const scope = 'policy clause must match an active document of its case and household';
  await rejects(insert(pool, 'policy_clauses', { id: 'pc-foreign', household_id: b.household, case_id: b.case, document_id: a.document }), scope);
  await rejects(insert(pool, 'policy_clauses', { id: 'pc-wrong-case', household_id: a.household, case_id: b.case, document_id: a.document }), scope);
  await insert(pool, 'policy_clauses', { id: 'pc-1', household_id: a.household, case_id: a.case, document_id: a.document });
  await insert(pool, 'policy_clauses', { id: 'pc-2', household_id: a.household, case_id: a.case, document_id: a.document, page: 2 });
  proves('policy_clauses_scope_insert');
  await rejects(pool.query("UPDATE policy_clauses SET text = 'changed' WHERE id = 'pc-1'"), 'policy clauses are immutable; erasure deletes them');
  assert.equal((await pool.query("UPDATE policy_clauses SET text = 'x' WHERE false")).rowCount, 0, 'row-level: no row, no fire');
  proves('policy_clauses_immutable');

  const answerScope = 'policy answer must match its case and household';
  await rejects(insert(pool, 'policy_answers', { id: 'pa-wrong', household_id: b.household, case_id: a.case, requested_by_adult_id: b.adult }), answerScope);
  await insert(pool, 'policy_answers', { id: 'pa-1', household_id: a.household, case_id: a.case, requested_by_adult_id: a.adult, document_ids_json: JSON.stringify([a.document]) });
  await insert(pool, 'policy_answers', { id: 'pa-other', household_id: a.household, case_id: a.case, requested_by_adult_id: a.adult, document_ids_json: '["some-other-document"]' });
  proves('policy_answers_scope_insert');
  await rejects(pool.query("UPDATE policy_answers SET question = 'changed' WHERE id = 'pa-1'"), 'policy answers are immutable; erasure deletes them');
  proves('policy_answers_immutable');

  await pool.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', ['quarantined', a.document]);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM policy_clauses')).n, 2, 'quarantine is not erasure');
  await pool.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', ['deletion_requested', a.document]);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM policy_clauses')).n, 0);
  assert.deepEqual((await pool.query('SELECT id FROM policy_answers ORDER BY id')).rows.map(row => row.id), ['pa-other'], 'only answers citing the document go');
  proves('policy_evidence_erase_on_document_erasure');
});

test('catalogue reviews need an active grant, stay immutable and erase with their document', postgresTestOptions(), async t => {
  const { pool, a, b } = await worlds(t);
  const scope = 'catalogue review must match an active document, case, household and active reviewer grant';
  // The grant trigger: a household confirmer must hold a role in that household.
  await insert(pool, 'adult_users', { id: 'adult-outsider' });
  await rejects(insert(pool, 'catalogue_reviewer_grants', { id: 'grant-outsider', household_id: a.household, adult_user_id: 'adult-outsider' }), 'a household confirmer must hold a role in the household');
  await insert(pool, 'catalogue_reviewer_grants', { id: 'grant-independent', household_id: a.household, adult_user_id: 'adult-outsider', kind: 'independent_reviewer', granted_by: 'operator:test' });
  await insert(pool, 'catalogue_reviewer_grants', { id: 'grant-a', household_id: a.household, adult_user_id: a.adult });
  proves('catalogue_reviewer_grants_scope_insert');

  await rejects(insert(pool, 'catalogue_reviews', { id: 'cr-foreign', household_id: b.household, case_id: b.case, document_id: a.document }), scope);
  await rejects(insert(pool, 'catalogue_reviews', { id: 'cr-wrong-authority', document_id: a.document, authority: 'independent' }), scope);
  await pool.query("UPDATE catalogue_reviewer_grants SET status = 'revoked' WHERE id = 'grant-a'");
  await rejects(insert(pool, 'catalogue_reviews', { id: 'cr-revoked', document_id: a.document }), scope);
  await pool.query("UPDATE catalogue_reviewer_grants SET status = 'active' WHERE id = 'grant-a'");
  await insert(pool, 'catalogue_reviews', { id: 'cr-1', document_id: a.document });
  proves('catalogue_reviews_scope_insert');
  await rejects(pool.query("UPDATE catalogue_reviews SET decision = 'rejected' WHERE id = 'cr-1'"), 'catalogue reviews are immutable; erasure deletes them');
  assert.equal((await pool.query("UPDATE catalogue_reviews SET decision = 'rejected' WHERE false")).rowCount, 0, 'row-level: no row, no fire');
  proves('catalogue_reviews_immutable');

  await pool.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', ['quarantined', a.document]);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM catalogue_reviews')).n, 1, 'quarantine is not erasure');
  await pool.query('UPDATE document_uploads SET lifecycle_state = $1 WHERE id = $2', ['deletion_requested', a.document]);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM catalogue_reviews')).n, 0);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM catalogue_reviewer_grants')).n, 2, 'grants are not content and survive');
  proves('catalogue_reviews_erase_on_document_erasure');
});

test('every critical trigger and every catalog trigger has a PostgreSQL behaviour test', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const catalog = (await pool.query("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname")).rows.map(row => row.tgname);
  const proven = provenTriggers();
  assert.deepEqual(criticalTriggers.filter(name => !proven.has(name)), [], 'critical triggers without a test');
  assert.deepEqual(catalog.filter(name => !proven.has(name)), [], 'catalog triggers without a test');
  assert.deepEqual([...proven].filter(name => !catalog.includes(name)), [], 'proven names that are not triggers');
  console.log(`trigger tests: ${proven.size} triggers proven, ${criticalTriggers.length} critical`);
});
