import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations, validateSchema } from '../src/backend/database/index.js';
import { EvidenceRepository, WorkflowRepository } from '../src/backend/repositories/index.js';

const baseAt = '2026-09-18T10:00:00.000Z';

function seedHousehold(database, suffix) {
  const householdId = `household-${suffix}`;
  const adultId = `adult-${suffix}`;
  const memberId = `member-${suffix}`;
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(householdId, `Household ${suffix}`, baseAt, baseAt);
  database.prepare(`INSERT INTO adult_users
    (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(adultId, `Adult ${suffix}`, baseAt, baseAt);
  database.prepare(`INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, starts_at, created_at)
    VALUES (?, ?, ?, 'owner', 'active', ?, ?)`).run(`role-${suffix}`, householdId, adultId, baseAt, baseAt);
  database.prepare(`INSERT INTO household_members
    (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'adult', ?, ?)`).run(memberId, householdId, adultId, `Adult ${suffix}`, baseAt, baseAt);
  return { householdId, adultId, memberId };
}

function seedCase(database, identity, caseId = `case-${identity.householdId}`) {
  database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'renewal', 'processing', ?, ?)`)
    .run(caseId, identity.householdId, identity.memberId, identity.adultId, baseAt, baseAt);
  return caseId;
}

test('v1 data migrates to v2 without losing evidence or foreign-key integrity', t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-v1-v2-'));
  const v1Directory = join(directory, 'migrations');
  mkdirSync(v1Directory);
  copyFileSync(
    new URL('../src/backend/database/migrations/001_initial_schema.sql', import.meta.url),
    join(v1Directory, '001_initial_schema.sql'),
  );
  const database = new DatabaseSync(':memory:');
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  database.exec('PRAGMA foreign_keys = ON');
  runMigrations(database, { directory: v1Directory });
  const identity = seedHousehold(database, 'one');
  const caseId = seedCase(database, identity, 'case-v1');
  database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, subject_member_id, fact_key, value_json, epistemic_state,
     evidence_kind, asserted_by, observed_at, created_at)
    VALUES ('fact-v1', ?, ?, ?, 'cashless_status', NULL, 'unknown', 'adult_statement', ?, ?, ?)`)
    .run(identity.householdId, caseId, identity.memberId, identity.adultId, baseAt, baseAt);

  assert.deepEqual(runMigrations(database), ['002_integrity_and_provenance.sql']);
  assert.equal(validateSchema(database).valid, true);
  const migrated = database.prepare("SELECT provenance_kind FROM evidence_facts WHERE id = 'fact-v1'").get();
  assert.equal(migrated.provenance_kind, 'adult_statement');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
});

test('core records reject cross-household references', () => {
  const database = openDatabase({ path: ':memory:' });
  const first = seedHousehold(database, 'first');
  const second = seedHousehold(database, 'second');
  assert.throws(() => database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method,
     granted_at, created_at) VALUES ('bad-consent', ?, ?, 'local', 'document_processing', 'v1', 'fixture', ?, ?)`)
    .run(first.householdId, second.adultId, baseAt, baseAt), /consent subject must belong/);
  assert.throws(() => database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('bad-case', ?, ?, ?, 'renewal', 'created', ?, ?)`)
    .run(first.householdId, second.memberId, first.adultId, baseAt, baseAt), /case participants must belong/);
  database.close();
});

test('explicit provenance stores statements, replies and calculations without fake document pages', () => {
  const database = openDatabase({ path: ':memory:' });
  const identity = seedHousehold(database, 'evidence');
  const caseId = seedCase(database, identity, 'case-evidence');
  const evidence = new EvidenceRepository(database, { clock: () => new Date(baseAt) });
  const statement = evidence.append({
    householdId: identity.householdId, caseId, subjectMemberId: identity.memberId,
    factKey: 'preferred_operator', value: 'Adult evidence', epistemicState: 'known',
    provenanceKind: 'adult_statement', statementAdultId: identity.adultId, assertedBy: identity.adultId,
  });
  const reply = evidence.append({
    householdId: identity.householdId, caseId, factKey: 'enrolment_status', value: 'confirmed',
    epistemicState: 'known', provenanceKind: 'institutional_reply',
    institutionalSourceRef: 'reply-fixture-1', assertedBy: 'institution-fixture',
  });
  const calculation = evidence.append({
    householdId: identity.householdId, caseId, factKey: 'premium_total_minor', value: 120000,
    epistemicState: 'known', provenanceKind: 'calculation', calculationMethod: 'sum-confirmed-premiums-v1',
    assertedBy: 'rules-engine',
  });
  assert.equal(statement.source_page_id, null);
  assert.equal(reply.institutional_source_ref, 'reply-fixture-1');
  assert.equal(calculation.value, 120000);
  assert.throws(() => evidence.append({
    householdId: identity.householdId, caseId, factKey: 'room_limit', value: 5000,
    epistemicState: 'known', provenanceKind: 'document_page', assertedBy: 'extractor',
  }), /CHECK constraint failed/);
  database.close();
});

test('document inserts are quarantined until validation and protected storage pass', () => {
  const database = openDatabase({ path: ':memory:' });
  const identity = seedHousehold(database, 'document');
  const caseId = seedCase(database, identity, 'case-document');
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method,
     granted_at, created_at) VALUES ('consent-document', ?, ?, 'local', 'document_processing', 'v1', 'fixture', ?, ?)`)
    .run(identity.householdId, identity.adultId, baseAt, baseAt);
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, uploaded_at)
    VALUES ('document-1', ?, ?, ?, 'consent-document', 'policy_schedule', 'fixture.pdf',
      'fixture/document-1', ?, 'application/pdf', 100, ?)`)
    .run(identity.householdId, caseId, identity.adultId, 'a'.repeat(64), baseAt);
  assert.equal(database.prepare("SELECT lifecycle_state FROM document_uploads WHERE id = 'document-1'").get().lifecycle_state, 'quarantined');
  assert.throws(() => database.exec("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'document-1'"), /cannot activate/);
  database.exec(`UPDATE document_uploads SET malware_status = 'not_scanned_fixture',
    encryption_status = 'fixture_only', lifecycle_state = 'active' WHERE id = 'document-1'`);
  assert.equal(database.prepare("SELECT lifecycle_state FROM document_uploads WHERE id = 'document-1'").get().lifecycle_state, 'active');
  database.close();
});

test('workflow claims wait for every dependency and persist recoverable inputs and outputs', () => {
  const database = openDatabase({ path: ':memory:' });
  const identity = seedHousehold(database, 'workflow');
  const caseId = seedCase(database, identity, 'case-workflow');
  const workflows = new WorkflowRepository(database, { clock: () => new Date(baseAt) });
  const run = workflows.createRunWithTasks({
    id: 'run-dag', caseId, workflowName: 'coverage-reconstruction', caseRevision: baseAt,
    input: { caseId, sourceVersion: 'fixture-v1' },
    tasks: [
      { key: 'profile', id: 'task-profile', agentName: 'profile', taskKind: 'analyse', input: { part: 'profile' } },
      { key: 'policy', id: 'task-policy', agentName: 'policy', taskKind: 'analyse', input: { part: 'policy' } },
      { key: 'join', id: 'task-join', agentName: 'coverage', taskKind: 'join', dependsOn: ['profile', 'policy'], input: { part: 'join' } },
    ],
  });
  assert.equal(JSON.parse(run.input_json).sourceVersion, 'fixture-v1');
  assert.equal(database.prepare("SELECT count(*) AS count FROM workflow_task_dependencies WHERE workflow_task_id = 'task-join'").get().count, 2);
  const first = workflows.claimNext({ workerId: 'worker' });
  assert.notEqual(first.id, 'task-join');
  workflows.completeTask(first.id, { workerId: 'worker', output: { done: first.id } });
  const second = workflows.claimNext({ workerId: 'worker' });
  assert.notEqual(second.id, 'task-join');
  workflows.completeTask(second.id, { workerId: 'worker', output: { done: second.id } });
  const join = workflows.claimNext({ workerId: 'worker' });
  assert.equal(join.id, 'task-join');
  const completed = workflows.completeTask(join.id, { workerId: 'worker', output: { status: 'joined' } });
  assert.deepEqual(JSON.parse(completed.output_json), { status: 'joined' });
  assert.equal(workflows.getRun('run-dag').status, 'completed');
  database.close();
});

test('expired leases recover, exhausted attempts do not claim, and expired idempotency keys are reusable', () => {
  const database = openDatabase({ path: ':memory:' });
  const identity = seedHousehold(database, 'recovery');
  const caseId = seedCase(database, identity, 'case-recovery');
  let now = new Date(baseAt);
  const workflows = new WorkflowRepository(database, { clock: () => new Date(now), leaseDurationMs: 1_000 });
  const run = workflows.createRun({ id: 'run-recovery', caseId, workflowName: 'recovery', input: { caseId } });
  workflows.enqueueTask({ id: 'task-recovery', runId: run.id, agentName: 'worker', taskKind: 'work', idempotencyKey: 'recovery-key' });
  assert.equal(workflows.claimNext({ workerId: 'worker' }).status, 'running');
  now = new Date(now.getTime() + 2_000);
  assert.equal(workflows.recoverExpiredLeases(), 1);
  assert.equal(workflows.getTask('task-recovery').status, 'pending');
  database.prepare("UPDATE workflow_tasks SET attempt_count = 5 WHERE id = 'task-recovery'").run();
  assert.equal(workflows.claimNext({ workerId: 'worker' }), null);
  assert.equal(workflows.getTask('task-recovery').status, 'failed');
  assert.equal(workflows.getRun('run-recovery').status, 'failed');

  const expired = new Date(now.getTime() - 1).toISOString();
  const first = workflows.enqueueTask({ runId: run.id, agentName: 'other', taskKind: 'work', idempotencyKey: 'expired-key', expiresAt: expired });
  const second = workflows.enqueueTask({ runId: run.id, agentName: 'other', taskKind: 'work', idempotencyKey: 'expired-key' });
  assert.notEqual(first.id, second.id);
  database.close();
});

test('schema validation detects a missing critical index', () => {
  const database = openDatabase({ path: ':memory:' });
  assert.equal(validateSchema(database).valid, true);
  database.exec('DROP INDEX workflow_tasks_claim_idx');
  const result = validateSchema(database);
  assert.equal(result.valid, false);
  assert.ok(result.missingIndexes.includes('workflow_tasks_claim_idx'));
  database.close();
});

test('task claiming and household audit lookup use their covering indexes', () => {
  const database = openDatabase({ path: ':memory:' });
  const taskPlan = database.prepare(`EXPLAIN QUERY PLAN
    SELECT * FROM workflow_tasks
    WHERE status = 'pending' AND (retry_available_at IS NULL OR retry_available_at <= ?)
    ORDER BY created_at, id LIMIT 1`).all(baseAt).map(row => row.detail).join(' ');
  const auditPlan = database.prepare(`EXPLAIN QUERY PLAN
    SELECT event_hash FROM audit_events WHERE household_id = ? ORDER BY id DESC LIMIT 1`)
    .all('household-index-check').map(row => row.detail).join(' ');
  assert.match(taskPlan, /workflow_tasks_claim_idx/);
  assert.match(auditPlan, /audit_events_household_chain_idx/);
  assert.doesNotMatch(taskPlan, /TEMP B-TREE/);
  database.close();
});
