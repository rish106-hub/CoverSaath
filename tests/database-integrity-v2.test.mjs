// Database integrity on PostgreSQL (S3.2). Synthetic data only.
//
// SQLite-only tests removed with the SQLite runtime (design decisions 7 and 10), each with its
// PostgreSQL equivalent:
// - "v1 data migrates to v2 without losing evidence or foreign-key integrity": the SQLite v1 -> v2
//   migration chain has no PostgreSQL counterpart (PostgreSQL starts from the final schema).
//   Schema equivalence: postgres-catalog-parity "PostgreSQL catalog equals the final SQLite
//   catalog ..."; fresh migration: postgres-runner "a fresh database migrates, records checksums,
//   validates, and a repeat run is a no-op".
// - "core records reject cross-household references": postgres-triggers "consent grants, scopes,
//   cases and participants stay inside their household".
// - "document inserts are quarantined until validation and protected storage pass":
//   postgres-triggers "documents, policies and evidence are household and consent scoped"
//   (document_uploads_activation_guard).
// - "schema validation detects a missing critical index": postgres-runner "validatePostgresSchema
//   reports a dropped, disabled or missing critical object" (drops workflow_tasks_claim_idx).
import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceRepository, WorkflowRepository } from '../src/backend/repositories/index.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pg = postgresTestOptions();
const baseAt = '2026-09-18T10:00:00.000Z';

async function seedHousehold(database, suffix) {
  const householdId = `household-${suffix}`;
  const adultId = `adult-${suffix}`;
  const memberId = `member-${suffix}`;
  await database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(householdId, `Household ${suffix}`, baseAt, baseAt);
  await database.prepare(`INSERT INTO adult_users
    (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
    .run(adultId, `Adult ${suffix}`, baseAt, baseAt);
  await database.prepare(`INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, starts_at, created_at)
    VALUES (?, ?, ?, 'owner', 'active', ?, ?)`).run(`role-${suffix}`, householdId, adultId, baseAt, baseAt);
  await database.prepare(`INSERT INTO household_members
    (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'adult', ?, ?)`).run(memberId, householdId, adultId, `Adult ${suffix}`, baseAt, baseAt);
  return { householdId, adultId, memberId };
}

async function seedCase(database, identity, caseId = `case-${identity.householdId}`) {
  await database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'renewal', 'processing', ?, ?)`)
    .run(caseId, identity.householdId, identity.memberId, identity.adultId, baseAt, baseAt);
  return caseId;
}

test('explicit provenance stores statements, replies and calculations without fake document pages', pg, async t => {
  const { db: database } = await freshDatabase(t);
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
  // A document-page claim without a cited page violates the provenance CHECK (SQLSTATE 23514).
  await assert.rejects(evidence.append({
    householdId: identity.householdId, caseId, factKey: 'room_limit', value: 5000,
    epistemicState: 'known', provenanceKind: 'document_page', assertedBy: 'extractor',
  }), error => error.code === '23514' && /check constraint/.test(error.message));
  assert.equal((await database.prepare("SELECT count(*) AS count FROM evidence_facts WHERE fact_key = 'room_limit'").get()).count, 0);
});

test('workflow claims wait for every dependency and persist recoverable inputs and outputs', pg, async t => {
  const { db: database } = await freshDatabase(t);
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
  assert.equal((await database.prepare("SELECT count(*) AS count FROM workflow_task_dependencies WHERE workflow_task_id = 'task-join'").get()).count, 2);
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

test('scoped workflow claims never take tasks from another run or workflow', pg, async t => {
  const { db: database } = await freshDatabase(t);
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

test('expired leases recover, exhausted attempts do not claim, and expired idempotency keys are reusable', pg, async t => {
  const { db: database } = await freshDatabase(t);
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
  await database.prepare("UPDATE workflow_tasks SET attempt_count = 5 WHERE id = 'task-recovery'").run();
  assert.equal(await workflows.claimNext({ workerId: 'worker' }), null);
  assert.equal((await workflows.getTask('task-recovery')).status, 'failed');
  assert.equal((await workflows.getRun('run-recovery')).status, 'failed');

  const expired = new Date(now.getTime() - 1).toISOString();
  const first = await workflows.enqueueTask({ runId: run.id, agentName: 'other', taskKind: 'work', idempotencyKey: 'expired-key', expiresAt: expired });
  const second = await workflows.enqueueTask({ runId: run.id, agentName: 'other', taskKind: 'work', idempotencyKey: 'expired-key' });
  assert.notEqual(first.id, second.id);
});

test('task claiming and household audit lookup use their covering indexes', pg, async t => {
  const { db: database } = await freshDatabase(t);
  // Empty tables make a sequential scan cheapest; disabling it asks whether an index can serve
  // the query at all, and in the requested order (no Sort node).
  const plans = await database.transaction(async () => {
    await database.run('SET LOCAL enable_seqscan = off');
    const plan = async (sql, params) => (await database.many(`EXPLAIN ${sql}`, params)).map(row => row['QUERY PLAN']).join('\n');
    return {
      task: await plan(`SELECT * FROM workflow_tasks
        WHERE status = 'pending' AND (retry_available_at IS NULL OR retry_available_at <= ?)
        ORDER BY created_at, id LIMIT 1`, [baseAt]),
      audit: await plan('SELECT event_hash FROM audit_events WHERE household_id = ? ORDER BY id DESC LIMIT 1', ['household-index-check']),
    };
  });
  assert.match(plans.task, /workflow_tasks_claim_idx/);
  assert.match(plans.audit, /audit_events_household_chain_idx/);
  assert.doesNotMatch(plans.task, /\bSort\b/);
  assert.doesNotMatch(plans.audit, /\bSort\b/);
});
