// S3.2 WP2: consent revocation and derived-data erasure on PostgreSQL under concurrency
// (design sections 3-5). Forced interleavings use a separate session that holds a lock the
// operations under test need, so the order in which they reach the database is fixed.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { advisoryLockKey, householdLock } from '../src/backend/database/postgres/locks.js';
import { createPostgresPool } from '../src/backend/database/postgres/index.js';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { ConsentRepository } from '../src/backend/repositories/consent-repository.js';
import { CoverageParameterRepository } from '../src/backend/repositories/coverage-parameter-repository.js';
import { HouseholdRepository } from '../src/backend/repositories/household-repository.js';
import { parameterAt as at, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();
const HOUSEHOLD = 'household-parameters';
const ADULT = 'adult-parameters';
const DOCUMENT_GRANT = 'consent-parameters';
const COVERAGE_GRANT = 'consent-coverage';
const RUN = 'run-parameters';
const COVERAGE_RUN = 'run-coverage';
const TASK = 'task-extract';
const WORKER = 'worker-1';
const MARKER = 'zebrafinch quokka synthetic';
const PAGE_TEXT = `Synthetic schedule: room rent limit is 5000 and ${MARKER} applies.`;
const digest = value => createHash('sha256').update(value).digest('hex');

// Policy structuring and clause stores belong to other repositories (covered by their own tests);
// these stand-ins record that revocation asked them to erase.
function derivedStoreStubs() {
  const calls = { structuring: [], clauses: [] };
  return {
    calls,
    policyStructuring: { async eraseDerived(input) { calls.structuring.push(input); return { proposals: 0, observations: 0, runs: 0 }; } },
    clauses: { async eraseDerived(input) { calls.clauses.push(input); return { clauses: 0, answers: 0, reviews: 0 }; } },
  };
}

function repositories(db) {
  const clock = () => new Date(at);
  const audit = new AuditRepository(db, { clock });
  const coverageParameters = new CoverageParameterRepository(db, { clock, audit });
  const stubs = derivedStoreStubs();
  const consents = new ConsentRepository(db, { clock, audit, coverageParameters, policyStructuring: stubs.policyStructuring, clauses: stubs.clauses });
  return { audit, coverageParameters, consents, calls: stubs.calls };
}

const sourcePage = documentId => ({
  sourceId: documentId === 'document-parameters' ? 'page-parameters' : 'page-other',
  documentId, version: 'version-1', page: 2, text: PAGE_TEXT, parameterKeys: ['d.room_rent_limit'],
});

// The parameter world plus: a coverage grant and a run it authorised, run input carrying page
// excerpts, a running leased task with output, an outbox message, a graph snapshot, a policy and
// member sourced from the document, and an evidence fact from its page.
async function seedRevocationWorld(db) {
  await seedParameterWorld(db);
  await db.transaction(async () => {
    await db.run(`INSERT INTO consent_grants
      (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
      VALUES (?, ?, ?, 'knowvia-local', 'coverage_reconstruction', 'v1', 'fixture', ?, ?)`, [COVERAGE_GRANT, HOUSEHOLD, ADULT, at, at]);
    await db.run(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
      VALUES ('scope-coverage', ?, 'case', 'case-parameters', 'derive', 'insurance_document', NULL, ?)`, [COVERAGE_GRANT, at]);
    await db.run("UPDATE workflow_runs SET status = 'running', input_json = ? WHERE id = ?",
      [JSON.stringify({ sourcePages: [sourcePage('document-parameters')] }), RUN]);
    await db.run(`INSERT INTO workflow_runs
      (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, consent_grant_id, created_at)
      VALUES (?, 'case-parameters', 'coverage-reconstruction', 'v2', 'live', 'completed', ?, ?, ?, ?)`,
    [COVERAGE_RUN, 'd'.repeat(64), JSON.stringify({ sourcePages: [sourcePage('document-other')] }), COVERAGE_GRANT, at]);
    for (const [taskId, runId, status, owner] of [[TASK, RUN, 'running', WORKER], ['task-done', RUN, 'completed', null], ['task-coverage', COVERAGE_RUN, 'completed', null]]) {
      await db.run(`INSERT INTO workflow_tasks (id, workflow_run_id, agent_name, task_kind, status, lease_owner, output_json, output_digest, created_at)
        VALUES (?, ?, 'synthetic-agent', 'personal_cover_analysis', ?, ?, ?, ?, ?)`,
      [taskId, runId, status, owner, JSON.stringify({ note: MARKER }), 'f'.repeat(64), at]);
    }
    await db.run(`INSERT INTO integration_outbox
      (id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
      VALUES ('outbox-1', 'sarvam', 'synthetic', '{}', ?, ?, 'pending', ?, ?, ?)`, ['a'.repeat(64), DOCUMENT_GRANT, at, at, at]);
    await db.run(`INSERT INTO coverage_graph_snapshots (id, household_id, case_id, version, status, graph_json, generated_by_run_id, created_at)
      VALUES ('graph-1', ?, 'case-parameters', 1, 'draft', ?, ?, ?)`, [HOUSEHOLD, JSON.stringify({ note: MARKER }), RUN, at]);
    await db.run(`INSERT INTO policies (id, household_id, policy_kind, policy_number_masked, source_document_id, verification_state, created_at, updated_at)
      VALUES ('policy-from-document', ?, 'personal', 'XX-1234', 'document-parameters', 'document_backed', ?, ?)`, [HOUSEHOLD, at, at]);
    await db.run(`INSERT INTO policy_members (policy_id, household_member_id, membership_state, source_page_id, created_at)
      VALUES ('policy-from-document', 'member-parameters', 'document_backed', 'page-parameters', ?)`, [at]);
    await db.run(`INSERT INTO evidence_facts
      (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind, source_page_id,
       source_locator, asserted_by, observed_at, created_at)
      VALUES ('fact-1', ?, 'case-parameters', 'room_rent_limit', ?, 'known', 'document', 'document_page', 'page-parameters',
        'page 2', 'synthetic', ?, ?)`, [HOUSEHOLD, JSON.stringify(MARKER), at, at]);
  });
  const parameters = new CoverageParameterRepository(db, { clock: () => new Date(at) });
  await parameters.initializeRunParameters({
    workflowRunId: RUN, householdId: HOUSEHOLD, caseId: 'case-parameters', subjectId: 'member-parameters', policyId: 'policy-parameters',
  });
}

const modelEntry = () => ({
  parameterKey: 'd.room_rent_limit', value: MARKER, sourceId: 'page-parameters', documentId: 'document-parameters',
  version: 'version-1', page: 2, sourceDigest: digest(PAGE_TEXT),
});

const record = coverageParameters => coverageParameters.recordModelExtraction({
  workflowRunId: RUN, entries: [modelEntry()], recordedBy: 'model-runtime', taskKey: 'personal', lease: { taskId: TASK, workerId: WORKER },
});

const revoke = (consents, grantId = DOCUMENT_GRANT) => consents.revoke({ grantId, revokedByAdultId: ADULT, reason: 'synthetic' });

async function unredactedObservations(db) {
  return (await db.one('SELECT count(*) AS count FROM coverage_parameter_observations WHERE redacted_at IS NULL')).count;
}

async function assertNothingDerivedSurvives(db) {
  assert.equal(await unredactedObservations(db), 0, 'zero unredacted observations');
  for (const [label, sql] of [
    ['run input', 'SELECT input_json FROM workflow_runs'],
    ['task output', 'SELECT output_json FROM workflow_tasks'],
    ['graphs', 'SELECT graph_json FROM coverage_graph_snapshots'],
    ['observations', 'SELECT value_json FROM coverage_parameter_observations'],
    ['resolutions', 'SELECT resolved_value_json FROM coverage_parameter_resolutions'],
    ['facts', 'SELECT value_json FROM evidence_facts'],
    ['pages', 'SELECT extracted_text FROM source_pages'],
    ['audit', 'SELECT event_payload_json FROM audit_events'],
  ]) {
    assert.ok(!JSON.stringify(await db.many(sql)).includes(MARKER), `${label} keeps no derived value`);
  }
}

// A session outside the pool under test that holds `lockSql` until released.
async function holdLock(handle, lockSql, params = []) {
  const client = await handle.pool.connect();
  await client.query('BEGIN');
  await client.query(lockSql, params);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await client.query('COMMIT');
    client.release();
  };
}

// Waits until `count` other sessions of this database are blocked on a lock.
async function waitForWaiters(handle, count) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows: [row] } = await handle.pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (row.waiting >= count) return;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error(`Timed out waiting for ${count} blocked sessions.`);
}

const householdKey = advisoryLockKey(...householdLock(HOUSEHOLD));

test('revocation first: a model write queued behind it is refused and nothing unredacted remains', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents, coverageParameters } = repositories(db);
  const release = await holdLock(handle, 'SELECT pg_advisory_xact_lock($1::bigint)', [householdKey]);
  try {
    const revoking = revoke(consents);
    await waitForWaiters(handle, 1);
    const recording = record(coverageParameters);
    await waitForWaiters(handle, 2);
    await release();
    const [revoked, recorded] = await Promise.allSettled([revoking, recording]);
    assert.equal(revoked.status, 'fulfilled', revoked.reason?.stack);
    assert.equal(recorded.status, 'rejected');
    assert.equal(recorded.reason.code, 'TASK_LEASE_LOST');
  } finally {
    await release();
  }
  assert.equal((await db.one('SELECT count(*) AS count FROM coverage_parameter_observations')).count, 0);
  await assertNothingDerivedSurvives(db);
});

test('model write first: revocation queued behind it erases the observations it committed', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents, coverageParameters } = repositories(db);
  const release = await holdLock(handle, 'SELECT pg_advisory_xact_lock($1::bigint)', [householdKey]);
  try {
    const recording = record(coverageParameters);
    await waitForWaiters(handle, 1);
    const revoking = revoke(consents);
    await waitForWaiters(handle, 2);
    await release();
    const [recorded, revoked] = await Promise.allSettled([recording, revoking]);
    assert.equal(recorded.status, 'fulfilled', recorded.reason?.stack);
    assert.equal(recorded.value.observations, 1);
    assert.equal(typeof recorded.value.observations, 'number');
    assert.equal(revoked.status, 'fulfilled', revoked.reason?.stack);
  } finally {
    await release();
  }
  assert.equal((await db.one('SELECT count(*) AS count FROM coverage_parameter_observations')).count, 1);
  await assertNothingDerivedSurvives(db);
  const [event] = await db.many("SELECT event_payload_json FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'");
  assert.deepEqual(JSON.parse(event.event_payload_json), { affectedParameters: 1, reasonCode: 'consent_revoked', redactedObservations: 1, resetResolutions: 1 });
});

// The task completion path (WorkflowRepository.completeTask, another package) locks the run and
// then the task. Simulated here with the same statements and lock order.
async function completeTaskLike(handle, { pauseAfterRunLock } = {}) {
  const client = await handle.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE', [RUN]);
    await pauseAfterRunLock?.();
    const { rowCount } = await client.query(`UPDATE workflow_tasks SET status = 'completed', output_json = $1, output_digest = $2, finished_at = $3
      WHERE id = $4 AND status = 'running' AND lease_owner = $5`, [JSON.stringify({ note: MARKER }), 'f'.repeat(64), at, TASK, WORKER]);
    await client.query('COMMIT');
    return rowCount;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

test('task completion holding the run lock first: revocation waits, then erases the completed output', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents } = repositories(db);
  let resume;
  const paused = new Promise(done => { resume = done; });
  let locked;
  const runLocked = new Promise(done => { locked = done; });
  const completing = completeTaskLike(handle, { pauseAfterRunLock: () => { locked(); return paused; } });
  await runLocked;
  const revoking = revoke(consents);
  await waitForWaiters(handle, 1);
  resume();
  assert.equal(await completing, 1);
  await revoking;
  const task = await db.one('SELECT status, output_json FROM workflow_tasks WHERE id = ?', [TASK]);
  assert.deepEqual({ ...task }, { status: 'revoked', output_json: null });
  await assertNothingDerivedSurvives(db);
});

test('revocation holding the run lock first: task completion waits and then finds the task revoked', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents } = repositories(db);
  // Stall revocation after it has locked the runs: it next needs the evidence fact row.
  const release = await holdLock(handle, "SELECT id FROM evidence_facts WHERE id = 'fact-1' FOR UPDATE");
  try {
    const revoking = revoke(consents);
    await waitForWaiters(handle, 1);
    const completing = completeTaskLike(handle);
    await waitForWaiters(handle, 2);
    await release();
    await revoking;
    assert.equal(await completing, 0, 'the completion writes nothing to a revoked task');
  } finally {
    await release();
  }
  await assertNothingDerivedSurvives(db);
});

test('revocation erases every derived store this repository owns, audits counts only, and calls the other stores', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents, coverageParameters, calls } = repositories(db);
  await record(coverageParameters);
  const grant = await revoke(consents);
  assert.ok(grant.revoked_at);
  assert.equal((await db.one('SELECT status FROM integration_outbox WHERE id = ?', ['outbox-1'])).status, 'cancelled');
  const runs = await db.many('SELECT id, status, terminal_reason, input_json FROM workflow_runs ORDER BY id');
  for (const run of runs) {
    assert.equal(run.status, 'revoked', run.id);
    assert.equal(run.terminal_reason, 'CONSENT_REVOKED');
    for (const page of JSON.parse(run.input_json).sourcePages) assert.equal(page.redacted, 'consent_revoked');
  }
  assert.ok((await db.many('SELECT status, output_json FROM workflow_tasks')).every(task => task.status === 'revoked' && task.output_json === null));
  assert.deepEqual({ ...(await db.one('SELECT status, graph_json FROM coverage_graph_snapshots')) }, { status: 'superseded', graph_json: '{}' });
  assert.equal((await db.one('SELECT count(*) AS count FROM policy_members')).count, 0);
  assert.equal((await db.one('SELECT policy_number_masked FROM policies WHERE id = ?', ['policy-from-document'])).policy_number_masked, null);
  assert.equal((await db.one('SELECT epistemic_state FROM evidence_facts WHERE id = ?', ['fact-1'])).epistemic_state, 'unknown');
  assert.ok((await db.many('SELECT lifecycle_state FROM document_uploads')).every(row => row.lifecycle_state !== 'active'));
  assert.ok((await db.many('SELECT extracted_text FROM source_pages')).every(row => row.extracted_text === null));
  await assertNothingDerivedSurvives(db);
  assert.deepEqual(calls.structuring.map(call => call.documentIds).flat().sort(), ['document-other', 'document-parameters']);
  assert.deepEqual(calls.clauses.map(call => call.documentIds).flat().sort(), ['document-other', 'document-parameters']);
  const actions = (await db.many('SELECT action FROM audit_events ORDER BY id')).map(row => row.action);
  for (const action of ['consent.revoked', 'analysis.derived_data_erased', 'policy.derived_data_erased', 'evidence.facts_erased', 'coverage_parameter.observations_redacted']) {
    assert.ok(actions.includes(action), action);
  }
  const erasure = JSON.parse((await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'analysis.derived_data_erased'")).event_payload_json);
  // Counts are Numbers (int8 parser), not strings.
  assert.deepEqual(erasure, { reason: 'consent_revoked', runs: 2, tasks: 3, pages: 2, graphs: 1, graphNodes: 0, graphEdges: 0, documents: 2 });
});

test('a failure in a derived store rolls the whole revocation back', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { audit, coverageParameters } = repositories(db);
  const failing = new ConsentRepository(db, {
    clock: () => new Date(at), audit, coverageParameters,
    policyStructuring: { async eraseDerived() { throw new Error('synthetic store failure'); } },
    clauses: { async eraseDerived() { return { clauses: 0, answers: 0 }; } },
  });
  await assert.rejects(revoke(failing), /synthetic store failure/);
  assert.equal((await db.one('SELECT revoked_at FROM consent_grants WHERE id = ?', [DOCUMENT_GRANT])).revoked_at, null);
  assert.equal((await db.one('SELECT count(*) AS count FROM consent_revocations')).count, 0);
  assert.ok((await db.one('SELECT input_json FROM workflow_runs WHERE id = ?', [RUN])).input_json.includes(MARKER));
  // Without injection both derived stores are built on the database: erasure always has a path.
  const defaults = new ConsentRepository(db, { clock: () => new Date(at), audit, coverageParameters });
  assert.ok(defaults.policyStructuring, 'policy structuring erasure is built by default');
  assert.ok(defaults.clauses, 'policy evidence erasure is built by default');
  // A derived store that is missing (it could not be built) fails the erasure closed instead of skipping it.
  for (const missing of ['policyStructuring', 'clauses']) {
    const unconfigured = new ConsentRepository(db, { clock: () => new Date(at), audit, coverageParameters });
    unconfigured[missing] = null;
    await assert.rejects(revoke(unconfigured), { code: 'ERASURE_NOT_CONFIGURED' }, missing);
    assert.equal((await db.one('SELECT count(*) AS count FROM consent_revocations')).count, 0);
    assert.equal((await db.one('SELECT revoked_at FROM consent_grants WHERE id = ?', [DOCUMENT_GRANT])).revoked_at, null);
    assert.ok((await db.one('SELECT input_json FROM workflow_runs WHERE id = ?', [RUN])).input_json.includes(MARKER));
  }
});

test('double revoke, sequential and concurrent, never raises 23505 and erases once', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents } = repositories(db);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => revoke(consents)));
  for (const result of results) assert.equal(result.status, 'fulfilled', result.reason?.stack);
  const again = await revoke(consents);
  assert.ok(again.revoked_at);
  assert.equal((await db.one('SELECT count(*) AS count FROM consent_revocations')).count, 1);
  assert.equal((await db.one("SELECT count(*) AS count FROM audit_events WHERE action = 'consent.revoked'")).count, 1);
  assert.equal((await db.one("SELECT count(*) AS count FROM audit_events WHERE action = 'analysis.derived_data_erased'")).count, 1);
  await assert.rejects(consents.revoke({ grantId: DOCUMENT_GRANT, revokedByAdultId: 'adult-intruder' }), /Only the subject adult/);
  await assert.rejects(consents.revoke({ grantId: 'consent-missing', revokedByAdultId: ADULT }), /not found/);
});

test('revoking the coverage grant erases the runs it authorised', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents } = repositories(db);
  await revoke(consents, COVERAGE_GRANT);
  const run = await db.one('SELECT status, input_json FROM workflow_runs WHERE id = ?', [COVERAGE_RUN]);
  assert.equal(run.status, 'revoked');
  assert.ok(!run.input_json.includes(MARKER));
  assert.equal((await db.one('SELECT output_json FROM workflow_tasks WHERE id = ?', ['task-coverage'])).output_json, null);
  // The document grant's run is untouched.
  assert.ok((await db.one('SELECT input_json FROM workflow_runs WHERE id = ?', [RUN])).input_json.includes(MARKER));
});

test('a model write without a lease is refused on a revoked run', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents, coverageParameters } = repositories(db);
  await revoke(consents, COVERAGE_GRANT);
  await db.run("UPDATE workflow_runs SET status = 'revoked' WHERE id = ?", [RUN]);
  await assert.rejects(coverageParameters.recordModelExtraction({ workflowRunId: RUN, entries: [modelEntry()], recordedBy: 'model-runtime' }), { code: 'RUN_REVOKED' });
  assert.equal(await unredactedObservations(db), 0);
});

// ---------------------------------------------------------------------------
// Fail-closed consent checks
// ---------------------------------------------------------------------------

async function seedViewerGrant(db, { grantId = 'consent-viewer', expiresAt = null } = {}) {
  await db.run(`INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-viewer', 'Viewer', 'active', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-viewer', ?, 'adult-viewer', 'member', 'active', ?)`, [HOUSEHOLD, at]);
  await db.run(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, expires_at, created_at)
    VALUES (?, ?, ?, 'knowvia-local', 'profile_intake', 'v1', 'fixture', ?, ?, ?)`, [grantId, HOUSEHOLD, ADULT, at, expiresAt, at]);
  await db.run(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES (?, ?, 'profile_field', 'date_of_birth', 'read', 'identity', 'adult-viewer', ?)`, [`scope-${grantId}`, grantId, at]);
  await db.run(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES (?, ?, 'case', 'case-parameters', 'read', 'insurance_document', 'adult-viewer', ?)`, [`scope-case-${grantId}`, grantId, at]);
}

const fieldCheck = { householdId: HOUSEHOLD, subjectAdultId: ADULT, viewerAdultId: 'adult-viewer', fieldKey: 'date_of_birth' };
const resourceCheck = {
  householdId: HOUSEHOLD, subjectAdultId: ADULT, viewerAdultId: 'adult-viewer', purpose: 'profile_intake',
  resourceType: 'case', resourceId: 'case-parameters', dataCategory: 'insurance_document',
};

test('consent checks allow a current grant and deny revoked and expired ones', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedParameterWorld(db);
  await seedViewerGrant(db);
  const { consents } = repositories(db);
  assert.equal(await consents.canAccessField(fieldCheck), true);
  assert.equal(await consents.canAccessResource(resourceCheck), true);
  assert.equal(await consents.requireFieldAccess(fieldCheck), true);
  assert.ok(await consents.requireActive('consent-viewer', { subjectAdultId: ADULT }));

  // Expired: the same grant evaluated after its expiry.
  await db.run("UPDATE consent_grants SET expires_at = '2026-10-09T10:30:00.000Z' WHERE id = 'consent-viewer'");
  const later = { at: '2026-10-09T11:00:00.000Z' };
  assert.equal(await consents.canAccessField({ ...fieldCheck, ...later }), false);
  assert.equal(await consents.canAccessResource({ ...resourceCheck, ...later }), false);
  await assert.rejects(consents.requireActive('consent-viewer', later), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(consents.requireResourceAccess({ ...resourceCheck, ...later }), { code: 'FIELD_ACCESS_REQUIRED' });
  // An unparseable expiry counts as expired.
  await db.run("UPDATE consent_grants SET expires_at = 'not-a-time' WHERE id = 'consent-viewer'");
  assert.equal(await consents.canAccessField(fieldCheck), false);

  // Revoked.
  await db.run('UPDATE consent_grants SET expires_at = NULL WHERE id = ?', ['consent-viewer']);
  assert.equal(await consents.canAccessField(fieldCheck), true);
  await consents.revoke({ grantId: 'consent-viewer', revokedByAdultId: ADULT });
  assert.equal(await consents.canAccessField(fieldCheck), false);
  assert.equal(await consents.canAccessResource(resourceCheck), false);
  await assert.rejects(consents.requireFieldAccess(fieldCheck), { code: 'FIELD_ACCESS_REQUIRED' });
  await assert.rejects(consents.requireActive('consent-viewer'), { code: 'CONSENT_REQUIRED' });
});

test('consent and household checks reject (never allow) when the connection is gone', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedParameterWorld(db);
  await seedViewerGrant(db);
  // A second interface on its own pool, which is then closed: every query fails.
  const pool = createPostgresPool({ connectionString: handle.url, max: 1, applicationName: 'coversaath-test-dropped' });
  const dropped = createDatabase(pool);
  const consents = new ConsentRepository(dropped, { clock: () => new Date(at) });
  const households = new HouseholdRepository(dropped, { clock: () => new Date(at) });
  assert.equal(await consents.canAccessField(fieldCheck), true, 'allowed while the connection works');
  await dropped.close();
  for (const check of [
    consents.canAccessField(fieldCheck),
    consents.canAccessResource(resourceCheck),
    consents.requireFieldAccess(fieldCheck),
    consents.requireResourceAccess(resourceCheck),
    consents.requireActive('consent-viewer', { subjectAdultId: ADULT }),
    households.requireAccess(HOUSEHOLD, ADULT),
  ]) {
    await assert.rejects(check, error => error instanceof Error && error !== true);
  }
});

test('a check inside a transaction whose backend is terminated rejects', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedParameterWorld(db);
  await seedViewerGrant(db);
  const { consents } = repositories(db);
  await assert.rejects(db.transaction(async () => {
    const { pid } = await db.one('SELECT pg_backend_pid() AS pid');
    await handle.pool.query('SELECT pg_terminate_backend($1)', [pid]);
    return consents.canAccessField(fieldCheck);
  }), error => error instanceof Error);
  // The pool recovers and the check works again on a new connection.
  assert.equal(await consents.canAccessField(fieldCheck), true);
});

test('household access checks deny missing roles and inactive households', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedParameterWorld(db);
  const households = new HouseholdRepository(db, { clock: () => new Date(at) });
  const { role } = await households.requireAccess(HOUSEHOLD, ADULT, { write: true });
  assert.equal(role.role, 'owner');
  await assert.rejects(households.requireAccess(HOUSEHOLD, 'adult-stranger'), { code: 'HOUSEHOLD_NOT_FOUND' });
  await assert.rejects(households.requireAccess('household-missing', ADULT), { code: 'HOUSEHOLD_NOT_FOUND' });
  assert.deepEqual((await households.listActiveRoles(HOUSEHOLD, ADULT)).map(row => row.role), ['owner']);
});

test('household writes commit with their audit event in one transaction', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const clock = () => new Date(at);
  const households = new HouseholdRepository(db, { clock, audit: new AuditRepository(db, { clock }) });
  const adult = await households.createAdult({ displayName: ' Synthetic adult ' });
  assert.equal(adult.display_name, 'Synthetic adult');
  const household = await households.createHousehold({ displayName: 'Synthetic home', ownerAdultId: adult.id });
  const member = await households.addMember({ householdId: household.id, adultUserId: adult.id, displayName: 'Synthetic adult' });
  assert.equal(member.member_kind, 'adult');
  assert.equal((await households.listMembers(household.id)).length, 1);
  assert.equal((await households.getActiveRole(household.id, adult.id)).role, 'owner');
  const actions = (await db.many('SELECT action FROM audit_events ORDER BY id')).map(row => row.action);
  assert.deepEqual(actions, ['adult.created', 'household.created', 'household_member.added']);
  // A failed insert leaves no audit event behind.
  await assert.rejects(households.addMember({ householdId: 'household-missing', displayName: 'Nobody' }), /violates foreign key constraint/);
  assert.equal((await db.one('SELECT count(*) AS count FROM audit_events')).count, 3);
  await assert.rejects(households.createHousehold({ id: household.id, displayName: 'Duplicate' }), { code: '23505' });
  assert.equal((await db.one('SELECT count(*) AS count FROM audit_events')).count, 3);
});

test('consent grants commit atomically and reject documents of another household', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedParameterWorld(db);
  const { consents } = repositories(db);
  await db.run("INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-other', 'Other', ?, ?)", [at, at]);
  await assert.rejects(consents.grant({
    householdId: 'household-other', subjectAdultId: ADULT, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', resourceId: 'document-parameters', action: 'derive', dataCategory: 'insurance_document' }],
  }), { code: 'DOCUMENT_NOT_FOUND' });
  const grant = await consents.grant({
    householdId: HOUSEHOLD, subjectAdultId: ADULT, purpose: 'document_processing',
    scopes: [
      { resourceType: 'document', resourceId: 'document-parameters', action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' },
      { resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' },
    ],
  });
  assert.equal(grant.scopes.length, 2);
  assert.equal((await db.one("SELECT count(*) AS count FROM audit_events WHERE action = 'consent.granted'")).count, 1);
  await assert.rejects(consents.grant({ householdId: HOUSEHOLD, subjectAdultId: ADULT, purpose: 'x', scopes: [] }), /At least one consent scope/);
});

// ---------------------------------------------------------------------------
// Deadlock stress
// ---------------------------------------------------------------------------

test('stress: concurrent revocations, model writes, task completions and erasures surface no 40P01', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  await seedRevocationWorld(db);
  const { consents, coverageParameters } = repositories(db);
  const operations = [];
  for (let round = 0; round < 6; round += 1) {
    operations.push(record(coverageParameters));
    operations.push(completeTaskLike(handle));
    operations.push(consents.eraseDerivedRunData({
      householdId: HOUSEHOLD, runIds: [RUN], reason: 'source_consent_not_current', resourceType: 'workflow_run', resourceId: RUN,
    }));
    operations.push(coverageParameters.redactObservationsForRun({ workflowRunId: RUN, reasonCode: 'consent_revoked' }));
  }
  operations.push(revoke(consents), revoke(consents, COVERAGE_GRANT), revoke(consents));
  const outcomes = await Promise.allSettled(operations);
  const deadlocks = outcomes.filter(outcome => outcome.status === 'rejected' && outcome.reason?.code === '40P01');
  assert.equal(deadlocks.length, 0, 'no deadlock reaches the caller');
  for (const outcome of outcomes) {
    if (outcome.status === 'rejected') assert.equal(outcome.reason.code, 'TASK_LEASE_LOST', outcome.reason.stack);
  }
  await assertNothingDerivedSurvives(db);
});
