import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSchema } from '../src/backend/database/index.js';
import { EvidenceRepository, WorkflowRepository } from '../src/backend/repositories/index.js';
import { createTestDatabase, sql } from './helpers/test-database.js';

const baseAt = '2026-09-18T10:00:00.000Z';

async function seedHousehold(database, suffix) {
  const householdId = `household-${suffix}`;
  const adultId = `adult-${suffix}`;
  const memberId = `member-${suffix}`;
  await sql.run(database, 'INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    householdId, `Household ${suffix}`, baseAt, baseAt);
  await sql.run(database, `INSERT INTO adult_users
    (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`,
  adultId, `Adult ${suffix}`, baseAt, baseAt);
  await sql.run(database, `INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, starts_at, created_at)
    VALUES (?, ?, ?, 'owner', 'active', ?, ?)`, `role-${suffix}`, householdId, adultId, baseAt, baseAt);
  await sql.run(database, `INSERT INTO household_members
    (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'adult', ?, ?)`, memberId, householdId, adultId, `Adult ${suffix}`, baseAt, baseAt);
  return { householdId, adultId, memberId };
}

async function seedCase(database, identity, caseId = `case-${identity.householdId}`) {
  await sql.run(database, `INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'renewal', 'processing', ?, ?)`,
  caseId, identity.householdId, identity.memberId, identity.adultId, baseAt, baseAt);
  return caseId;
}

async function fresh(t) {
  const database = await createTestDatabase();
  t.after(() => database.close());
  return database;
}

test('core records reject cross-household references', async t => {
  const database = await fresh(t);
  const first = await seedHousehold(database, 'first');
  const second = await seedHousehold(database, 'second');
  await assert.rejects(sql.run(database, `INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method,
     granted_at, created_at) VALUES ('bad-consent', ?, ?, 'local', 'document_processing', 'v1', 'fixture', ?, ?)`,
  first.householdId, second.adultId, baseAt, baseAt), /consent subject must belong/);
  await assert.rejects(sql.run(database, `INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('bad-case', ?, ?, ?, 'renewal', 'created', ?, ?)`,
  first.householdId, second.memberId, first.adultId, baseAt, baseAt), /case participants must belong/);
});

test('explicit provenance stores statements, replies and calculations without fake document pages', async t => {
  const database = await fresh(t);
  const identity = await seedHousehold(database, 'evidence');
  const caseId = await seedCase(database, identity, 'case-evidence');
  const evidence = new EvidenceRepository(database, { clock: () => new Date(baseAt) });
  const statement = await evidence.append({
    householdId: identity.householdId, caseId, subjectMemberId: identity.memberId,
    factKey: 'preferred_operator', value: 'Adult evidence', epistemicState: 'known',
    provenanceKind: 'adult_statement', statementAdultId: identity.adultId, assertedBy: identity.adultId,
  });
  const reply = await evidence.append({
    householdId: identity.householdId, caseId, factKey: 'enrolment_status', value: 'confirmed',
    epistemicState: 'known', provenanceKind: 'institutional_reply',
    institutionalSourceRef: 'reply-fixture-1', assertedBy: 'institution-fixture',
  });
  const calculation = await evidence.append({
    householdId: identity.householdId, caseId, factKey: 'premium_total_minor', value: 120000,
    epistemicState: 'known', provenanceKind: 'calculation', calculationMethod: 'sum-confirmed-premiums-v1',
    assertedBy: 'rules-engine',
  });
  assert.equal(statement.source_page_id, null);
  assert.equal(reply.institutional_source_ref, 'reply-fixture-1');
  assert.equal(calculation.value, 120000);
  await assert.rejects(evidence.append({
    householdId: identity.householdId, caseId, factKey: 'room_limit', value: 5000,
    epistemicState: 'known', provenanceKind: 'document_page', assertedBy: 'extractor',
  }), /violates check constraint/);
  // The failed insert is a constraint error, not a driver code leaking to API clients.
  await evidence.append({
    householdId: identity.householdId, caseId, factKey: 'room_limit', value: 5000,
    epistemicState: 'known', provenanceKind: 'document_page', assertedBy: 'extractor',
  }).catch(error => { assert.equal(error.code, undefined); assert.equal(error.sqlState, '23514'); });
});

test('document inserts are quarantined until validation and protected storage pass', async t => {
  const database = await fresh(t);
  const identity = await seedHousehold(database, 'document');
  const caseId = await seedCase(database, identity, 'case-document');
  await sql.run(database, `INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method,
     granted_at, created_at) VALUES ('consent-document', ?, ?, 'local', 'document_processing', 'v1', 'fixture', ?, ?)`,
  identity.householdId, identity.adultId, baseAt, baseAt);
  await sql.run(database, `INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, uploaded_at)
    VALUES ('document-1', ?, ?, ?, 'consent-document', 'policy_schedule', 'fixture.pdf',
      'fixture/document-1', ?, 'application/pdf', 100, ?)`,
  identity.householdId, caseId, identity.adultId, 'a'.repeat(64), baseAt);
  assert.equal((await sql.get(database, "SELECT lifecycle_state FROM document_uploads WHERE id = 'document-1'")).lifecycle_state, 'quarantined');
  await assert.rejects(database.exec("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = 'document-1'"), /cannot activate/);
  await database.exec(`UPDATE document_uploads SET malware_status = 'not_scanned_fixture',
    encryption_status = 'fixture_only', lifecycle_state = 'active' WHERE id = 'document-1'`);
  assert.equal((await sql.get(database, "SELECT lifecycle_state FROM document_uploads WHERE id = 'document-1'")).lifecycle_state, 'active');
});

test('workflow claims wait for every dependency and persist recoverable inputs and outputs', async t => {
  const database = await fresh(t);
  const identity = await seedHousehold(database, 'workflow');
  const caseId = await seedCase(database, identity, 'case-workflow');
  const workflows = new WorkflowRepository(database, { clock: () => new Date(baseAt) });
  const run = await workflows.createRunWithTasks({
    id: 'run-dag', caseId, workflowName: 'coverage-reconstruction', caseRevision: baseAt,
    input: { caseId, sourceVersion: 'fixture-v1' },
    tasks: [
      { key: 'profile', id: 'task-profile', agentName: 'profile', taskKind: 'analyse', input: { part: 'profile' } },
      { key: 'policy', id: 'task-policy', agentName: 'policy', taskKind: 'analyse', input: { part: 'policy' } },
      { key: 'join', id: 'task-join', agentName: 'coverage', taskKind: 'join', dependsOn: ['profile', 'policy'], input: { part: 'join' } },
    ],
  });
  assert.equal(JSON.parse(run.input_json).sourceVersion, 'fixture-v1');
  assert.equal((await sql.get(database, "SELECT count(*) AS count FROM workflow_task_dependencies WHERE workflow_task_id = 'task-join'")).count, 2);
  const first = await workflows.claimNext({ workerId: 'worker' });
  assert.notEqual(first.id, 'task-join');
  await workflows.completeTask(first.id, { workerId: 'worker', output: { done: first.id } });
  const second = await workflows.claimNext({ workerId: 'worker' });
  assert.notEqual(second.id, 'task-join');
  await workflows.completeTask(second.id, { workerId: 'worker', output: { done: second.id } });
  const join = await workflows.claimNext({ workerId: 'worker' });
  assert.equal(join.id, 'task-join');
  const completed = await workflows.completeTask(join.id, { workerId: 'worker', output: { status: 'joined' } });
  assert.deepEqual(JSON.parse(completed.output_json), { status: 'joined' });
  assert.equal((await workflows.getRun('run-dag')).status, 'completed');
});

test('scoped workflow claims never take tasks from another run or workflow', async t => {
  const database = await fresh(t);
  const identity = await seedHousehold(database, 'claim-scope');
  const caseId = await seedCase(database, identity, 'case-claim-scope');
  const workflows = new WorkflowRepository(database, { clock: () => new Date(baseAt) });
  await workflows.createRunWithTasks({
    id: 'run-other-coverage', caseId, workflowName: 'coverage-analysis',
    tasks: [{ id: 'task-other-run', agentName: 'coverage', taskKind: 'analyse', input: {} }],
  });
  await workflows.createRunWithTasks({
    id: 'run-other-workflow', caseId, workflowName: 'document-intake',
    tasks: [{ id: 'task-other-workflow', agentName: 'document', taskKind: 'extract', input: {} }],
  });
  await workflows.createRunWithTasks({
    id: 'run-requested', caseId, workflowName: 'coverage-analysis',
    tasks: [{ id: 'task-requested', agentName: 'coverage', taskKind: 'analyse', input: {} }],
  });

  const claimed = await workflows.claimNext({
    workerId: 'coverage-worker',
    runId: 'run-requested',
    workflowName: 'coverage-analysis',
  });
  assert.equal(claimed.id, 'task-requested');
  assert.equal((await workflows.getTask('task-other-run')).status, 'pending');
  assert.equal((await workflows.getTask('task-other-workflow')).status, 'pending');

  assert.equal(await workflows.claimNext({
    workerId: 'coverage-worker',
    runId: 'run-other-workflow',
    workflowName: 'coverage-analysis',
  }), null);
  assert.equal((await workflows.getTask('task-other-workflow')).status, 'pending');
});

test('expired leases recover, exhausted attempts do not claim, and expired idempotency keys are reusable', async t => {
  const database = await fresh(t);
  const identity = await seedHousehold(database, 'recovery');
  const caseId = await seedCase(database, identity, 'case-recovery');
  let now = new Date(baseAt);
  const workflows = new WorkflowRepository(database, { clock: () => new Date(now), leaseDurationMs: 1_000 });
  const run = await workflows.createRun({ id: 'run-recovery', caseId, workflowName: 'recovery', input: { caseId } });
  await workflows.enqueueTask({ id: 'task-recovery', runId: run.id, agentName: 'worker', taskKind: 'work', idempotencyKey: 'recovery-key' });
  assert.equal((await workflows.claimNext({ workerId: 'worker' })).status, 'running');
  now = new Date(now.getTime() + 2_000);
  assert.equal(await workflows.recoverExpiredLeases(), 1);
  assert.equal((await workflows.getTask('task-recovery')).status, 'pending');
  await sql.run(database, "UPDATE workflow_tasks SET attempt_count = 5 WHERE id = 'task-recovery'");
  assert.equal(await workflows.claimNext({ workerId: 'worker' }), null);
  assert.equal((await workflows.getTask('task-recovery')).status, 'failed');
  assert.equal((await workflows.getRun('run-recovery')).status, 'failed');

  const expired = new Date(now.getTime() - 1).toISOString();
  const first = await workflows.enqueueTask({ runId: run.id, agentName: 'other', taskKind: 'work', idempotencyKey: 'expired-key', expiresAt: expired });
  const second = await workflows.enqueueTask({ runId: run.id, agentName: 'other', taskKind: 'work', idempotencyKey: 'expired-key' });
  assert.notEqual(first.id, second.id);
});

test('schema validation detects a missing critical index', async t => {
  const database = await fresh(t);
  assert.equal((await validateSchema(database)).valid, true);
  await database.exec('DROP INDEX workflow_tasks_claim_idx');
  const result = await validateSchema(database);
  assert.equal(result.valid, false);
  assert.ok(result.missingIndexes.includes('workflow_tasks_claim_idx'));
});

test('task claiming and household audit lookup use their covering indexes', async t => {
  const database = await fresh(t);
  // Postgres plans tiny tables as sequential scans, so force index use to prove the index can serve each query.
  const explain = (statement, params) => database.transaction(async tx => {
    await tx.exec('SET LOCAL enable_seqscan = off');
    return (await tx.query(`EXPLAIN ${statement}`, params)).map(row => row['QUERY PLAN']).join(' ');
  });
  const taskPlan = await explain(`SELECT * FROM workflow_tasks
    WHERE status = 'pending' AND (retry_available_at IS NULL OR retry_available_at <= $1::timestamptz)
    ORDER BY created_at, id LIMIT 1`, [baseAt]);
  const auditPlan = await explain('SELECT event_hash FROM audit_events WHERE household_id = $1 ORDER BY id DESC LIMIT 1', ['household-index-check']);
  assert.match(taskPlan, /workflow_tasks_claim_idx/);
  assert.match(auditPlan, /audit_events_household_chain_idx/);
  assert.doesNotMatch(taskPlan, /Sort/);
});
