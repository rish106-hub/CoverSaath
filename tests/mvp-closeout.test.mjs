// Evidence-completion MVP close-out: model output recorded as unverified parameter evidence
// (acceptance criteria 7 and 11), observation guards (active document, bound human review),
// run-scoped erasure, and canonical-key decomposition. Every value is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { CoverageParameterRepository } from '../src/backend/repositories/coverage-parameter-repository.js';
import { opaqueSourceId } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { MODEL_EXTRACTED_UNVERIFIED } from '../src/modules/coverage-analysis/agent-contracts.js';
import { modelObservationCandidates } from '../src/modules/coverage-analysis/model-observations.js';
import { CANONICAL_KEY_CRITERIA, POLICY_DECOMPOSITION, decomposePolicySection } from '../src/modules/coverage-analysis/policy-decomposition.js';
import { POLICY_PARAMETER_REGISTRY_VERSION, getPolicyParameterRegistry } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { observationInput, parameterAt as at, parameterReviewerId, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { auditActions, setupLiveCase, startLiveServer } from './support/live-analysis-scenario.mjs';

const v1 = POLICY_PARAMETER_REGISTRY_VERSION;

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });
  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 });
  return { database, repository };
}

const parameter = (repository, key) => repository.createParameter({ registryVersion: v1, parameterKey: key, ...parameterScope(), updatedBy: 'test' });
const entry = (parameterKey, value, overrides = {}) => ({
  parameterKey, value, sourceId: 'page-parameters', documentId: 'document-parameters', version: 'version-1', page: 2, sourceDigest: 'e'.repeat(64), ...overrides,
});
const otherPage = { sourceId: 'page-other', documentId: 'document-other' };

test('guard: observations require an active document, in the repository and in the database', t => {
  const { database, repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-parameters'").run();
  assert.throws(() => repository.appendObservation({ parameterRecordId: record.id, ...observationInput() }), { code: 'OBSERVATION_DOCUMENT_NOT_ACTIVE' });
  assert.throws(() => database.prepare(`INSERT INTO coverage_parameter_observations
    (id, parameter_record_id, source_id, document_id, version, page, extraction_method, review_status, value_json,
     source_digest, observed_at, recorded_by, created_at)
    VALUES ('direct', ?, 'page-parameters', 'document-parameters', 'version-1', '2', 'human_report', 'not_reviewed', '1', ?, ?, 'x', ?)`)
    .run(record.id, 'e'.repeat(64), at, at), /require an active document/);
  // The other, still active document is unaffected.
  assert.ok(repository.appendObservation({ parameterRecordId: record.id, ...observationInput(otherPage) }));
});

test('guard: a human_review observation must be recorded by the reviewer of an open or completed review', t => {
  const { database, repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  const review = overrides => repository.appendObservation({ parameterRecordId: record.id, ...observationInput({ extractionMethod: 'human_review', reviewStatus: 'accepted', ...overrides }) });

  assert.throws(() => review({ recordedBy: 'someone-else' }), { code: 'OBSERVATION_REVIEWER_REQUIRED' });
  assert.ok(review({ recordedBy: parameterReviewerId }));
  for (const status of ['requested', 'declined']) {
    database.prepare('UPDATE human_reviews SET status = ? WHERE id = ?').run(status, 'review-parameters');
    assert.throws(() => review({ recordedBy: parameterReviewerId }), { code: 'OBSERVATION_REVIEWER_REQUIRED' });
  }
  database.prepare("UPDATE human_reviews SET status = 'completed' WHERE id = 'review-parameters'").run();
  assert.ok(review({ recordedBy: parameterReviewerId }));
  // A review bound to a different run does not authorise this run's parameters (database too).
  database.prepare("INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, created_at) VALUES ('run-other', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture', 'queued', ?, '{}', ?)").run('d'.repeat(64), at);
  database.prepare("UPDATE human_reviews SET workflow_run_id = 'run-other' WHERE id = 'review-parameters'").run();
  assert.throws(() => review({ recordedBy: parameterReviewerId }), { code: 'OBSERVATION_REVIEWER_REQUIRED' });
  assert.throws(() => database.prepare(`INSERT INTO coverage_parameter_observations
    (id, parameter_record_id, source_id, document_id, version, page, extraction_method, review_status, value_json,
     source_digest, observed_at, recorded_by, created_at)
    VALUES ('direct-review', ?, 'page-parameters', 'document-parameters', 'version-1', '2', 'human_review', 'accepted', '1', ?, ?, ?, ?)`)
    .run(record.id, 'e'.repeat(64), at, parameterReviewerId, at), /assigned reviewer/);
});

test('recordModelExtraction: agreement is extracted_unverified, disagreement is conflicting, never higher', t => {
  const { repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  const first = repository.recordModelExtraction({ workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', '1% of sum insured')], recordedBy: 'runtime' });
  assert.deepEqual({ ...first }, { observations: 1, parameters: 1, conflicting: 0, skipped: 0 });
  let current = repository.getParameter(record.id);
  assert.equal(current.resolutionState, 'extracted_unverified');
  assert.equal(current.authority, 'model');
  assert.equal(current.resolvedValue, '1% of sum insured');
  const [observation] = repository.listObservations(record.id);
  assert.equal(observation.extractionMethod, 'document_extraction');
  assert.equal(observation.reviewStatus, 'not_reviewed');

  repository.recordModelExtraction({ workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', '1% of sum insured', otherPage)], recordedBy: 'runtime' });
  assert.equal(repository.getParameter(record.id).resolutionState, 'extracted_unverified');

  const conflict = repository.recordModelExtraction({ workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', '2% of sum insured', otherPage)], recordedBy: 'runtime' });
  assert.equal(conflict.conflicting, 1);
  current = repository.getParameter(record.id);
  assert.equal(current.resolutionState, 'conflicting');
  assert.equal(current.resolvedValue, null);
  assert.equal(repository.listObservations(record.id).length, 3, 'every controlling observation is preserved');
});

test('recordModelExtraction: established, model-forbidden and unknown keys are skipped untouched', t => {
  const { repository } = open(t);
  const proven = parameter(repository, 'd.room_rent_limit');
  const review = repository.appendObservation({ parameterRecordId: proven.id, ...observationInput({ extractionMethod: 'human_review', reviewStatus: 'accepted', recordedBy: parameterReviewerId }) });
  repository.setResolution({ parameterRecordId: proven.id, state: 'proven', observationId: review.id, updatedBy: 'reviewer' });
  const forbidden = parameter(repository, 'd.amount_already_used');

  const counts = repository.recordModelExtraction({
    workflowRunId: 'run-parameters',
    entries: [entry('d.room_rent_limit', 'model says otherwise'), entry('d.amount_already_used', 12345), entry('z.not_a_key', 'x')],
    recordedBy: 'runtime',
  });
  assert.deepEqual({ ...counts }, { observations: 0, parameters: 0, conflicting: 0, skipped: 3 });
  assert.equal(repository.getParameter(proven.id).resolutionState, 'proven');
  assert.equal(repository.listObservations(forbidden.id).length, 0);
});

test('recordModelExtraction is atomic: a bad entry leaves no observation behind', t => {
  const { repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  assert.throws(() => repository.recordModelExtraction({
    workflowRunId: 'run-parameters',
    entries: [entry('d.room_rent_limit', 'ok'), entry('d.room_rent_limit', 'bad', { version: 'wrong-version' })],
    recordedBy: 'runtime',
  }));
  assert.equal(repository.listObservations(record.id).length, 0);
  assert.equal(repository.getParameter(record.id).resolutionState, 'unknown');
});

test('redactObservationsForRun erases values of every observation of the run and resets resolutions', t => {
  const { database, repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  repository.recordModelExtraction({ workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', 'SYNTHETIC-RUN-VALUE'), entry('d.room_rent_limit', 'SYNTHETIC-RUN-VALUE', otherPage)], recordedBy: 'runtime' });
  const result = repository.redactObservationsForRun({ workflowRunId: 'run-parameters', reasonCode: 'consent_revoked' });
  assert.equal(result.redactedObservations, 2);
  assert.equal(repository.getParameter(record.id).resolutionState, 'unknown');
  assert.equal(database.prepare('SELECT count(*) AS count FROM coverage_parameter_observations WHERE value_json IS NOT NULL').get().count, 0);
  const [event] = auditActions(database, 'coverage_parameter.run_observations_redacted');
  assert.deepEqual(event.payload, { reasonCode: 'consent_revoked', redactedObservations: 2, affectedParameters: 1 });
  assert.ok(!JSON.stringify(event).includes('SYNTHETIC-RUN-VALUE'));
  assert.equal(repository.redactObservationsForRun({ workflowRunId: 'run-parameters', reasonCode: 'consent_revoked' }).redactedObservations, 0);
});

test('modelObservationCandidates reads only model_extracted_unverified scalar values with citations', () => {
  const source = id => ({ id, page: 1, version: 'v1' });
  const profile = { profile: {
    'd.room_rent_limit': { value: '5000', status: MODEL_EXTRACTED_UNVERIFIED, sources: [source('s1'), source('s1'), source('s2')] },
    'd.deductible': { value: 'UNKNOWN', status: 'unknown', sources: [source('s1')] },
    'd.co_pay_general': { value: { nested: true }, status: MODEL_EXTRACTED_UNVERIFIED, sources: [source('s1')] },
    'd.sum_insured': { value: 500000, status: MODEL_EXTRACTED_UNVERIFIED, sources: [] },
  } };
  assert.deepEqual(modelObservationCandidates('profile', profile), [{ parameterKey: 'd.room_rent_limit', value: '5000', sourceIds: ['s1', 's2'] }]);
  const group = [{ coverageGraph: { nodes: [
    { fact: 'f.ped_waiting_period', value: '36 months', status: MODEL_EXTRACTED_UNVERIFIED, citations: [{ sourceId: 's3' }] },
    { fact: 'f.initial_waiting_period', value: null, status: 'conflicting', citations: [{ sourceId: 's3' }] },
  ] } }];
  assert.deepEqual(modelObservationCandidates('group', group), [{ parameterKey: 'f.ped_waiting_period', value: '36 months', sourceIds: ['s3'] }]);
  const personal = { dimensions: { suitability: { assertions: [{ field: 'd.deductible', value: true, status: MODEL_EXTRACTED_UNVERIFIED, sources: [source('s4')] }] } } };
  assert.deepEqual(modelObservationCandidates('personal', personal), [{ parameterKey: 'd.deductible', value: true, sourceIds: ['s4'] }]);
  for (const key of ['questions', 'primary', 'coverage']) assert.deepEqual(modelObservationCandidates(key, profile), []);
  assert.deepEqual(modelObservationCandidates('group', { not: 'an array' }), []);
});

test('decomposition: every registry key in sections A-J has exactly one criterion', () => {
  const registryKeys = getPolicyParameterRegistry(v1).parameters.map(item => item.key).filter(key => !key.startsWith('k.'));
  const mapped = Object.values(CANONICAL_KEY_CRITERIA).flat();
  assert.equal(new Set(mapped).size, mapped.length, 'no key is mapped twice');
  assert.deepEqual([...mapped].sort(), [...registryKeys].sort());
  const criterionFields = Object.values(POLICY_DECOMPOSITION).flatMap(worker => (worker.criteria ?? []).map(criterion => criterion.field));
  for (const field of Object.keys(CANONICAL_KEY_CRITERIA)) assert.ok(criterionFields.includes(field), field);
});

test('decomposition: a canonical dotted key lands in its criterion instead of a gap', () => {
  const coverage = { facts: [
    { id: 'f1', field: 'd.room_rent_limit', value: '1%', status: MODEL_EXTRACTED_UNVERIFIED, sources: [{ id: 's1', page: 2, version: 'v1' }] },
    { id: 'f2', field: 'd.co_pay_age', value: '20%', status: 'document-backed', sources: [{ id: 's2', page: 3, version: 'v1' }] },
  ] };
  const section = decomposePolicySection('financialRules', coverage);
  const room = section.facts.find(fact => fact.field === 'd.room_rent_limit');
  assert.ok(room, 'room rent is placed');
  assert.equal(room.evidenceState, 'Unknown', 'model output stays Unknown');
  assert.equal(section.facts.find(fact => fact.field === 'd.co_pay_age').evidenceState, 'Proven');
  assert.ok(!section.facts.some(fact => fact.id.includes('gap') && ['room_and_icu_limits', 'copay_basis'].includes(fact.field)));
  // Criteria with no evidence still report an explicit gap.
  assert.ok(section.facts.some(fact => fact.field === 'restoration_rules' && fact.evidenceState === 'Unknown'));
});

test('live run: extracted values become cited unverified observations with a counts-only audit', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: 'Synthetic schedule: room rent limit is 5000.' });
  const run = await scenario.startLiveRun('closeout-live');
  assert.equal(run.status, 202, run.raw);
  const runId = run.data.id;
  const input = JSON.parse(app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(runId).input_json);
  const [page] = input.sourcePages;
  const rows = app.database.prepare(`SELECT observation.* FROM coverage_parameter_observations observation
    JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id
    WHERE parameter.workflow_run_id = ?`).all(runId);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.extraction_method, 'document_extraction');
    assert.equal(row.review_status, 'not_reviewed');
    assert.equal(row.source_id, page.sourceId);
    assert.equal(row.document_id, scenario.documentId);
    assert.equal(row.source_digest, createHash('sha256').update(page.text, 'utf8').digest('hex'));
    assert.equal(JSON.parse(row.value_json), 'model extracted value');
  }
  assert.ok(!input.authorizedSourceIds.includes(opaqueSourceId(page.sourceId)), 'opaque ids are never persisted as sources');
  const events = auditActions(app.database, 'coverage_parameter.model_observations_recorded');
  assert.ok(events.length >= 1);
  assert.ok(events.every(event => event.resourceId === runId && !JSON.stringify(event).includes('model extracted value')));
});

test('live run: revoking the coverage consent erases the run observations', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const run = await scenario.startLiveRun('closeout-revoke');
  const services = createBackendServices(app.database);
  const live = () => app.database.prepare(`SELECT count(*) AS count FROM coverage_parameter_observations observation
    JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id
    WHERE parameter.workflow_run_id = ? AND observation.value_json IS NOT NULL`).get(run.data.id).count;
  assert.ok(live() >= 1);
  services.consents.revoke({ grantId: scenario.coverageConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic' });
  assert.equal(live(), 0);
  assert.equal(auditActions(app.database, 'coverage_parameter.run_observations_redacted').length, 1);
});

test('live run: a document grant revoked during the model call records no observation', async t => {
  let database = null;
  let documentConsentId = null;
  const app = await startLiveServer(t, {
    onGenerate: async () => {
      if (database && documentConsentId) database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), documentConsentId);
    },
  });
  const scenario = await setupLiveCase(app);
  database = app.database;
  documentConsentId = scenario.documentConsentId;
  const run = await scenario.startLiveRun('closeout-race');
  const runId = run.data?.id ?? app.database.prepare('SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1').get().id;
  assert.equal(app.database.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId).status, 'revoked');
  assert.equal(app.database.prepare(`SELECT count(*) AS count FROM coverage_parameter_observations observation
    JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id
    WHERE parameter.workflow_run_id = ? AND observation.value_json IS NOT NULL`).get(runId).count, 0);
});

// ---------------------------------------------------------------------------
// Independent review findings F1, F2, F4, F5, F6, F7 and F8.
// ---------------------------------------------------------------------------

function runningTask(database, { id = 'task-parameters', owner = 'worker-a', status = 'running' } = {}) {
  database.prepare(`INSERT INTO workflow_tasks (id, workflow_run_id, agent_name, task_kind, status, lease_owner, created_at)
    VALUES (?, 'run-parameters', 'coverage-analysis/profile', 'profile_intake', ?, ?, ?)`).run(id, status, owner, at);
  database.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = 'run-parameters'").run();
}

test('F1: a stale worker whose lease moved records nothing; the holder records once with an in-transaction audit', t => {
  const { database, repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  runningTask(database);
  const write = workerId => repository.recordModelExtraction({
    workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', '1%')], recordedBy: 'runtime', taskKey: 'profile', lease: { taskId: 'task-parameters', workerId },
  });
  assert.throws(() => write('worker-b'), { code: 'TASK_LEASE_LOST' });
  assert.equal(repository.listObservations(record.id).length, 0);
  assert.equal(write('worker-a').observations, 1);
  const [event] = auditActions(database, 'coverage_parameter.model_observations_recorded');
  assert.deepEqual(event.payload, { taskKey: 'profile', observations: 1, parameters: 1, conflicting: 0, skipped: 0 });
  database.prepare("UPDATE workflow_runs SET status = 'revoked' WHERE id = 'run-parameters'").run();
  assert.throws(() => write('worker-a'), { code: 'TASK_LEASE_LOST' });
  assert.equal(repository.listObservations(record.id).length, 1);
});

test('F1: the persistent worker skips a result whose lease was lost instead of failing the run', async t => {
  const { MODEL_OBSERVATION_TASK_KEYS } = await import('../src/modules/coverage-analysis/model-observations.js');
  assert.ok(MODEL_OBSERVATION_TASK_KEYS.includes('profile'));
  let completed = 0;
  let failed = 0;
  let recordCalls = 0;
  const leaseLost = Object.assign(new Error('lost'), { code: 'TASK_LEASE_LOST' });
  const { createPersistentCoverageAnalysisService, COVERAGE_ANALYSIS_WORKFLOW } = await import('../src/modules/coverage-analysis/index.js');
  const run = { id: 'run-f1', status: 'running', workflow_name: COVERAGE_ANALYSIS_WORKFLOW.name, workflow_version: COVERAGE_ANALYSIS_WORKFLOW.version, consent_grant_id: 'c', execution_mode: 'live', input_json: '{}' };
  const definition = COVERAGE_ANALYSIS_WORKFLOW.tasks.find(item => item.key === 'profile');
  let claimed = false;
  const registry = Object.fromEntries(COVERAGE_ANALYSIS_WORKFLOW.tasks.map(item => [item.key, async () => ({})]));
  const port = {
    getCase: async () => null, requireCoverageConsent: async () => null, findIdempotency: async () => null, recordIdempotency: async () => null,
    createRunWithParameters: async () => null, verifyRunSourcesCurrent: async () => ({ allowed: true }), getCoverageSourcePages: async () => [],
    loadKnownIdentifiers: async () => [], getTask: async () => null, dependencyOutputs: async () => ({}), recoverExpiredLeases: async () => null,
    isConsentActive: async () => true, stopForRevocation: async () => null, persistTaskArtifact: async () => null,
    getJob: async () => ({ ...run, status: claimed ? 'completed' : 'running' }),
    claimNext: async () => {
      if (claimed) return null;
      claimed = true;
      return { id: 'task-f1', workflow_run_id: run.id, input_json: JSON.stringify({ key: 'profile', inputSchema: definition.inputSchema, outputSchema: definition.outputSchema }) };
    },
    completeTask: async () => { completed += 1; },
    failTask: async () => { failed += 1; },
    recordModelObservations: async () => { recordCalls += 1; throw leaseLost; },
  };
  const liveRegistry = Object.assign({ ...registry }, { executionMode: 'live' });
  const service = createPersistentCoverageAnalysisService({ port, registry, liveRegistry });
  // The registry output is not a valid profile payload, so the envelope fails before recording;
  // drive the commit path directly with a payload the contract accepts instead.
  liveRegistry.profile = async () => ({
    subjectId: 's', profile: {}, affordability: null, provenance: {}, consent: {}, rejectedFields: [],
    boundaries: { policyTermsVerified: false, medicalFactsInferred: false, affordabilityAffectsCoverageTruth: false },
  });
  await service.runUntilSettled(run.id);
  assert.equal(recordCalls, 1, 'the commit path reached observation recording');
  assert.equal(completed, 0, 'a stale result is never completed');
  assert.equal(failed, 0, 'a stale worker never fails a task it no longer holds');
});

test('F2: the profile placeholder UNKNOWN is never recorded as evidence', () => {
  const payload = { profile: { 'd.room_rent_limit': { value: 'UNKNOWN', status: MODEL_EXTRACTED_UNVERIFIED, sources: [{ id: 's1' }] } } };
  assert.deepEqual(modelObservationCandidates('profile', payload), []);
});

test('F5: a state set by a human reviewer is not replaced by model output', t => {
  const { repository } = open(t);
  const record = parameter(repository, 'd.room_rent_limit');
  repository.setResolution({ parameterRecordId: record.id, state: 'unknown', authority: 'human_reviewer', reasonCode: 'reviewer_withheld', updatedBy: 'reviewer' });
  const counts = repository.recordModelExtraction({ workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', '1%')], recordedBy: 'runtime' });
  assert.equal(counts.skipped, 1);
  assert.equal(repository.getParameter(record.id).authority, 'human_reviewer');
  assert.equal(repository.listObservations(record.id).length, 0);
});

test('F6 and F1: the port records a citation only for a page selected for that parameter, under the task lease', async t => {
  const { createBackendServices: services } = await import('../src/backend/services/index.js');
  const { createCoverageAnalysisPort } = await import('../src/backend/services/index.js');
  const { database } = open(t);
  const backend = services(database);
  backend.coverageParameters.initializeRunParameters({ workflowRunId: 'run-parameters', registryVersion: v1, ...parameterScope(), updatedBy: 'test' });
  database.prepare('UPDATE workflow_runs SET input_json = ? WHERE id = ?').run(JSON.stringify({ sourcePages: [{
    sourceId: 'page-parameters', documentId: 'document-parameters', version: 'version-1', page: 2, text: 'Deductible is 10000.', parameterKeys: ['d.deductible'],
  }] }), 'run-parameters');
  runningTask(database);
  const port = createCoverageAnalysisPort({ database, services: backend });
  const cite = key => ({ profile: { [key]: { value: 'cited', status: MODEL_EXTRACTED_UNVERIFIED, sources: [{ id: opaqueSourceId('page-parameters') }] } } });
  const lease = { taskId: 'task-parameters', workerId: 'worker-a' };
  assert.equal(port.recordModelObservations({ runId: 'run-parameters', taskKey: 'profile', payload: cite('d.room_rent_limit'), ...lease }).observations, 0);
  assert.equal(port.recordModelObservations({ runId: 'run-parameters', taskKey: 'profile', payload: cite('d.deductible'), ...lease }).observations, 1);
  assert.throws(() => port.recordModelObservations({ runId: 'run-parameters', taskKey: 'profile', payload: cite('d.deductible'), taskId: 'task-parameters', workerId: 'worker-b' }), { code: 'TASK_LEASE_LOST' });
});

test('F4: erasing run data without a parameter repository fails closed when observations exist', async t => {
  const { ConsentRepository } = await import('../src/backend/repositories/consent-repository.js');
  const { database, repository } = open(t);
  parameter(repository, 'd.room_rent_limit');
  repository.recordModelExtraction({ workflowRunId: 'run-parameters', entries: [entry('d.room_rent_limit', '1%')], recordedBy: 'runtime' });
  const bare = new ConsentRepository(database);
  database.exec('BEGIN IMMEDIATE');
  assert.throws(() => bare.eraseDerivedRunData({ householdId: 'household-parameters', runIds: ['run-parameters'], resourceType: 'workflow_run', resourceId: 'run-parameters' }), { code: 'ERASURE_NOT_CONFIGURED' });
  database.exec('ROLLBACK');
});

test('F7 and F8: values recorded by an earlier batch are erased when a later commit re-check fails', async t => {
  let database = null;
  let documentConsentId = null;
  const app = await startLiveServer(t, {
    onGenerate: async request => {
      if (database && request.agentId.endsWith('question_drafting')) {
        database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(new Date().toISOString(), documentConsentId);
      }
    },
  });
  const scenario = await setupLiveCase(app);
  database = app.database;
  documentConsentId = scenario.documentConsentId;
  await scenario.startLiveRun('closeout-two-batch');
  const runId = app.database.prepare('SELECT id FROM workflow_runs ORDER BY created_at DESC LIMIT 1').get().id;
  const rows = app.database.prepare(`SELECT observation.value_json, observation.redaction_reason_code FROM coverage_parameter_observations observation
    JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id WHERE parameter.workflow_run_id = ?`).all(runId);
  assert.ok(rows.length >= 1, 'the extraction batch recorded observations before the revocation');
  assert.ok(rows.every(row => row.value_json === null && row.redaction_reason_code === 'source_consent_not_current'));
  assert.equal(app.database.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId).status, 'revoked');
});
