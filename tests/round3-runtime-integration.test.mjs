import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { OcrRepository } from '../src/backend/repositories/index.js';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/modules/ai-analysis/index.js';
import { opaqueSourceId } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { COVERAGE_ANALYSIS_WORKFLOW, createPersistentCoverageAnalysisService } from '../src/modules/coverage-analysis/index.js';
import { POLICY_PARAMETER_REGISTRY_VERSION, getPolicyParameterRegistry } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { auditActions, liveEnv, mockOutput, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';
import { seedParameterWorld } from './support/parameter-fixtures.mjs';

const REGISTRY_SIZE = getPolicyParameterRegistry(POLICY_PARAMETER_REGISTRY_VERSION).parameters.length;
const PROBE_EMAIL = 'asha.synthetic@example.test';
const count = (database, sql, ...params) => database.prepare(sql).get(...params).count;
const runInput = (database, runId) => JSON.parse(database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(runId).input_json);

function acquisitionOf(database, runId) {
  return Object.fromEntries(database.prepare(`SELECT parameter.parameter_key AS key, acquisition.acquisition_state AS state
    FROM coverage_parameter_records parameter
    JOIN coverage_parameter_acquisitions acquisition ON acquisition.parameter_record_id = parameter.id
    WHERE parameter.workflow_run_id = ?`).all(runId).map(row => [row.key, row.state]));
}

// ---------------------------------------------------------------------------
// T1: parameter records are created with every run
// ---------------------------------------------------------------------------

test('T1: a live run pins the registry and creates one record per key with acquisition states from the source intake', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app, { pageText: 'Synthetic schedule: room rent limit is 5000. Co-payment is 10 percent.' });
  const run = await scenario.startLiveRun('t1-live-run');
  assert.equal(run.status, 202, run.raw);
  // The live happy path is unchanged.
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(modelRequests.length, 5);

  const runId = run.data.id;
  const input = runInput(app.database, runId);
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_registry_pins WHERE workflow_run_id = ?', runId), 1);
  assert.equal(app.database.prepare('SELECT registry_version AS version FROM coverage_parameter_registry_pins WHERE workflow_run_id = ?').get(runId).version, POLICY_PARAMETER_REGISTRY_VERSION);
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_records WHERE workflow_run_id = ?', runId), REGISTRY_SIZE);
  assert.equal(input.parameterStates.length, REGISTRY_SIZE);

  // Acquisition states mirror the input exactly; resolution stays unknown.
  const states = acquisitionOf(app.database, runId);
  for (const entry of input.parameterStates) assert.equal(states[entry.parameterKey], entry.acquisitionState, entry.parameterKey);
  const seen = new Set(Object.values(states));
  assert.ok(seen.has('received'), 'at least one key was sent to the model');
  assert.equal(count(app.database, "SELECT count(*) AS count FROM coverage_parameter_resolutions resolution JOIN coverage_parameter_records parameter ON parameter.id = resolution.parameter_record_id WHERE parameter.workflow_run_id = ? AND resolution.resolution_state <> 'unknown'", runId), 0);

  // Scope: the analysis subject member and the run-level unclassified placeholder policy.
  const scope = app.database.prepare(`SELECT DISTINCT household_id, case_id, subject_id, policy_id
    FROM coverage_parameter_records WHERE workflow_run_id = ?`).all(runId);
  assert.equal(scope.length, 1);
  assert.deepEqual({ ...scope[0] }, { household_id: scenario.householdId, case_id: scenario.caseId, subject_id: scenario.ownerMemberId, policy_id: input.groupPolicies[0].policyId });
  assert.match(scope[0].policy_id, /^UNCLASSIFIED:[a-f0-9]{24}$/);
  assert.deepEqual({ ...app.database.prepare('SELECT policy_kind, verification_state FROM policies WHERE id = ?').get(scope[0].policy_id) }, { policy_kind: 'unknown', verification_state: 'unverified' });

  // Audit: counts and registry version only.
  const [event] = auditActions(app.database, 'analysis.parameters_initialized');
  assert.equal(event.resourceId, runId);
  assert.deepEqual(event.payload, {
    registryVersion: POLICY_PARAMETER_REGISTRY_VERSION,
    parameterCount: REGISTRY_SIZE,
    requested: input.parameterStates.filter(entry => entry.acquisitionState !== 'not_requested').length,
    received: input.parameterStates.filter(entry => entry.acquisitionState === 'received').length,
  });
});

test('T1: a fixture run also gets a pin and explicit not_requested records', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const response = await app.call(`/api/v1/cases/${scenario.caseId}/analysis-runs`, {
    method: 'POST', token: scenario.token, idempotencyKey: 't1-fixture-run',
    body: { consentGrantId: scenario.coverageConsentId, executionMode: 'fixture' },
  });
  assert.equal(response.status, 202, response.raw);
  const runId = response.data.id;
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_registry_pins WHERE workflow_run_id = ?', runId), 1);
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_records WHERE workflow_run_id = ?', runId), REGISTRY_SIZE);
  assert.deepEqual(new Set(Object.values(acquisitionOf(app.database, runId))), new Set(['not_requested']));
  assert.equal(count(app.database, "SELECT count(*) AS count FROM coverage_parameter_resolutions resolution JOIN coverage_parameter_records parameter ON parameter.id = resolution.parameter_record_id WHERE parameter.workflow_run_id = ? AND resolution.resolution_state <> 'unknown'", runId), 0);
});

test('T1: replaying an Idempotency-Key creates no further run, pin, record, policy or audit event', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const first = await scenario.startLiveRun('t1-replay');
  assert.equal(first.status, 202);
  const snapshot = () => ({
    runs: count(app.database, 'SELECT count(*) AS count FROM workflow_runs'),
    pins: count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_registry_pins'),
    records: count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_records'),
    acquisitions: count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_acquisitions'),
    policies: count(app.database, 'SELECT count(*) AS count FROM policies'),
    initialized: auditActions(app.database, 'analysis.parameters_initialized').length,
  });
  const before = snapshot();
  const replay = await scenario.startLiveRun('t1-replay');
  assert.equal(replay.status, 200, replay.raw);
  assert.equal(replay.data.id, first.data.id);
  assert.deepEqual(snapshot(), before);

  // A second run of the same case reuses the placeholder policy.
  const second = await scenario.startLiveRun('t1-second-run');
  assert.equal(second.status, 202);
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM policies'), before.policies);
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM coverage_parameter_records'), before.records * 2);
});

test('T1: a dependent subject is recorded as its household member; a missing member fails run creation closed', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const now = new Date().toISOString();
  app.database.prepare(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-synthetic-dependent', ?, NULL, 'Synthetic dependent', 'dependent', ?, ?)`).run(scenario.householdId, now, now);
  app.database.prepare('UPDATE service_cases SET subject_member_id = ? WHERE id = ?').run('member-synthetic-dependent', scenario.caseId);
  const run = await scenario.startLiveRun('t1-dependent');
  assert.equal(run.status, 202, run.raw);
  assert.deepEqual(app.database.prepare('SELECT DISTINCT subject_id FROM coverage_parameter_records WHERE workflow_run_id = ?').all(run.data.id).map(row => row.subject_id), ['member-synthetic-dependent']);

  // No subject member and no member row for the opener: nothing to attach records to.
  app.database.prepare('UPDATE service_cases SET subject_member_id = NULL WHERE id = ?').run(scenario.caseId);
  app.database.prepare('DELETE FROM household_members WHERE adult_user_id = ?').run(scenario.ownerId);
  const runsBefore = count(app.database, 'SELECT count(*) AS count FROM workflow_runs');
  const refused = await scenario.startLiveRun('t1-no-member');
  assert.equal(refused.status, 409, refused.raw);
  assert.match(refused.data.error, /no household member to attach coverage parameters/);
  assert.equal(count(app.database, 'SELECT count(*) AS count FROM workflow_runs'), runsBefore);
});

test('T1: an unknown registry version or a failed initialisation leaves no run behind', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database);
  const port = createCoverageAnalysisPort({ database, services });
  const create = parameters => port.createRunWithParameters({
    id: 'run-atomic', caseId: 'case-parameters', workflowName: COVERAGE_ANALYSIS_WORKFLOW.name,
    workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version, executionMode: 'fixture', input: {},
    tasks: [{ key: 'profile', agentName: 'coverage-analysis/profile', taskKind: 'profile_intake', dependsOn: [], input: { key: 'profile' } }],
    parameters,
  });
  const good = {
    registryVersion: POLICY_PARAMETER_REGISTRY_VERSION, householdId: 'household-parameters', caseId: 'case-parameters',
    subjectId: 'member-parameters', policyId: 'policy-parameters', requestedKeys: [], receivedKeys: [],
  };
  const runsBefore = count(database, 'SELECT count(*) AS count FROM workflow_runs');
  const untouched = () => {
    assert.equal(count(database, 'SELECT count(*) AS count FROM workflow_runs'), runsBefore);
    assert.equal(count(database, "SELECT count(*) AS count FROM workflow_tasks WHERE workflow_run_id = 'run-atomic'"), 0);
    assert.equal(count(database, 'SELECT count(*) AS count FROM coverage_parameter_registry_pins WHERE workflow_run_id = ?', 'run-atomic'), 0);
    assert.equal(count(database, 'SELECT count(*) AS count FROM coverage_parameter_records WHERE workflow_run_id = ?', 'run-atomic'), 0);
    assert.equal(database.isTransaction, false);
  };
  assert.throws(() => create({ ...good, registryVersion: 'policy-parameters/v999' }), /registryVersion is not supported/);
  untouched();
  assert.throws(() => create({ ...good, subjectId: 'member-from-nowhere' }));
  untouched();
  assert.throws(() => create({ ...good, requestedKeys: ['z.not_a_key'] }));
  untouched();
  assert.throws(() => create({ ...good, requestedKeys: ['d.room_rent_limit'], receivedKeys: ['a.document_set'] }), /Received parameters must also be requested/);
  untouched();
  assert.throws(() => create(undefined), /Parameter record scope is required/);
  untouched();
  // A service without the parameter repository cannot create runs at all.
  const bare = createCoverageAnalysisPort({ database, services: { ...services, coverageParameters: undefined } });
  assert.throws(() => bare.createRunWithParameters({ id: 'run-atomic', parameters: good }), { code: 'PARAMETER_RECORDS_NOT_CONFIGURED' });
  untouched();

  // The control: valid input creates run, tasks, pin and all records together.
  const run = create(good);
  assert.equal(run.id, 'run-atomic');
  assert.equal(count(database, 'SELECT count(*) AS count FROM coverage_parameter_records WHERE workflow_run_id = ?', 'run-atomic'), REGISTRY_SIZE);
  assert.equal(count(database, "SELECT count(*) AS count FROM workflow_tasks WHERE workflow_run_id = 'run-atomic'"), 1);
});

test('T1: a service refuses a port that cannot create parameter records', () => {
  const methods = ['getCase', 'requireCoverageConsent', 'findIdempotency', 'recordIdempotency', 'getCoverageSourcePages', 'getJob', 'getTask', 'claimNext',
    'dependencyOutputs', 'completeTask', 'failTask', 'recoverExpiredLeases', 'isConsentActive', 'stopForRevocation', 'persistTaskArtifact'];
  const legacy = Object.fromEntries(methods.map(method => [method, () => null]));
  assert.throws(() => createPersistentCoverageAnalysisService({ port: { ...legacy, createRunWithTasks: () => null } }), /createRunWithParameters/);
  assert.throws(() => createPersistentCoverageAnalysisService({ port: { ...legacy, createRunWithParameters: () => null } }), /verifyRunSourcesCurrent/);
});

// ---------------------------------------------------------------------------
// T2: per-document revocation is re-checked at commit time
// ---------------------------------------------------------------------------

function liveService(app, modelRequests) {
  const services = createBackendServices(app.database);
  const port = createCoverageAnalysisPort({ database: app.database, services });
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver({ modelRequests }),
    preDispatchValidator: request => port.authorizeModelDispatch(request),
  })();
  return { services, port, service: createPersistentCoverageAnalysisService({ port, liveRegistry: registry }) };
}

for (const [label, revoke] of [
  ['an expired grant', (database, grantId) => database.prepare('UPDATE consent_grants SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00.000Z', grantId)],
  ['a revoked_at change', (database, grantId) => database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), grantId)],
]) {
  test(`T2: ${label} on one document while a model call is in flight discards the result and stops the run`, async t => {
    const modelRequests = [];
    let revokeNow = () => {};
    const app = await startLiveServer(t, { modelRequests, onGenerate: (_request, calls) => { if (calls === 1) revokeNow(); } });
    const scenario = await setupLiveCase(app, { pageText: `Synthetic schedule for ${PROBE_EMAIL}: room rent limit is 5000.` });
    // A second, separately granted document: only this one is revoked in flight.
    const second = await app.call('/api/v1/consents', {
      method: 'POST', token: scenario.token,
      body: { householdId: scenario.householdId, subjectAdultId: scenario.ownerId, purpose: 'document_processing', scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }] },
    });
    const other = scenario.addDocument({ suffix: 'second', text: 'Synthetic second page: co-payment is 10 percent.', grantId: second.data.id });
    revokeNow = () => revoke(app.database, second.data.id);

    const run = await scenario.startLiveRun(`t2-${label}`);
    assert.equal(run.status, 202, run.raw);
    const input = runInput(app.database, run.data.id);
    assert.ok(input.authorizedSources.some(source => source.documentId === other.documentId), 'both documents were selected for the run');

    const row = app.database.prepare('SELECT status, terminal_reason FROM workflow_runs WHERE id = ?').get(run.data.id);
    assert.deepEqual({ ...row }, { status: 'revoked', terminal_reason: 'CONSENT_REVOKED' });
    // The in-flight results were not committed: nothing completed, no artifact audit, no output.
    const tasks = app.database.prepare('SELECT task_kind, status, output_json FROM workflow_tasks WHERE workflow_run_id = ?').all(run.data.id);
    assert.equal(tasks.filter(task => task.status === 'completed').length, 0);
    assert.ok(tasks.every(task => task.output_json === null));
    assert.equal(auditActions(app.database, 'analysis.task_completed').length, 0);
    const [stopped] = auditActions(app.database, 'analysis.revoked');
    assert.deepEqual(stopped.payload, { reason: 'source_consent_not_current', reasonCode: 'SOURCE_CONSENT_NOT_CURRENT' });

    // No later provider call is made once the run is stopped.
    const callsAtStop = modelRequests.length;
    assert.ok(callsAtStop >= 1 && callsAtStop < 5);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(modelRequests.length, callsAtStop);

    // No raw text in rows or audit.
    const everything = JSON.stringify({
      tasks, audit: app.database.prepare('SELECT event_payload_json FROM audit_events').all(),
      run: app.database.prepare('SELECT input_json, terminal_reason FROM workflow_runs WHERE id = ?').get(run.data.id), response: run.raw,
    });
    assert.ok(!everything.includes(PROBE_EMAIL));
  });
}

test('T2: the commit-time check is the dispatch eligibility rule and denies on any source change', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const { port, service } = liveService(app, []);
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 't2-port' });
  assert.deepEqual({ ...port.verifyRunSourcesCurrent(job.id) }, { allowed: true, reasonCode: null });
  assert.deepEqual({ ...port.verifyRunSourcesCurrent('run-does-not-exist') }, { allowed: false, reasonCode: 'DISPATCH_REQUEST_INVALID' });

  // A document that leaves the active lifecycle is no longer eligible.
  app.database.prepare("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = ?").run(scenario.documentId);
  assert.deepEqual({ ...port.verifyRunSourcesCurrent(job.id) }, { allowed: false, reasonCode: 'SOURCE_CONSENT_NOT_CURRENT' });
  // Fixture runs have no model-bound sources and are not affected by the live check.
  assert.equal(auditActions(app.database, 'analysis.model_dispatch_authorized').length, 0, 'a commit-time check is never audited as a dispatch');
});

// ---------------------------------------------------------------------------
// T3: OCR completion never deletes evidence pages
// ---------------------------------------------------------------------------

function ocrWorld(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const at = '2026-10-09T10:00:00.000Z';
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES ('document-ocr3', 'household-parameters', 'case-parameters', 'adult-parameters',
      'consent-parameters', 'policy_schedule', 'fixture.pdf', 'fixture/document-ocr3', ?,
      'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'v3')`).run('9'.repeat(64), at);
  database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, status, attempt_count, requested_at, updated_at)
    VALUES ('ocr-fresh', 'document-ocr3', 'fixture', 'processing', 1, ?, ?)`).run(at, at);
  const repository = new OcrRepository(database);
  const pages = [1, 2].map(pageNumber => ({
    documentUploadId: 'document-ocr3', pageNumber, sourceVersion: 'v3', textSha256: `${pageNumber}`.repeat(64), text: `Synthetic page ${pageNumber}`,
    extractionStatus: 'extracted', confidenceBasisPoints: 9000, createdAt: at, outputContractVersion: 'knowvia.ocr.v1',
    providerPageRef: `fixture-${pageNumber}`, provenance: {},
  }));
  const changes = digest => ({
    status: 'succeeded', providerJobRef: 'fixture-ref', result: { pages: 2 }, resultDigest: digest, completedAt: at, updatedAt: at,
    errorCode: null, errorMessage: null,
  });
  return { database, repository, pages, changes };
}

test('T3: completing an already-completed OCR job is an idempotent no-op for the same digest and a stable error otherwise', t => {
  const { database, repository, pages, changes } = ocrWorld(t);
  const completed = repository.completeJob('ocr-fresh', pages, changes('a'.repeat(64)));
  assert.equal(completed.status, 'succeeded');
  const pageRows = () => database.prepare('SELECT id, extracted_text FROM source_pages WHERE ocr_job_id = ? ORDER BY page_number').all('ocr-fresh').map(row => ({ ...row }));
  const original = pageRows();
  assert.equal(original.length, 2);

  // Evidence references a page, as parameter observations do.
  const parameters = createBackendServices(database).coverageParameters;
  parameters.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: POLICY_PARAMETER_REGISTRY_VERSION });
  const record = parameters.createParameter({
    registryVersion: POLICY_PARAMETER_REGISTRY_VERSION, parameterKey: 'd.room_rent_limit', workflowRunId: 'run-parameters',
    householdId: 'household-parameters', caseId: 'case-parameters', subjectId: 'member-parameters', policyId: 'policy-parameters', updatedBy: 'test',
  });
  const observation = parameters.appendObservation({
    parameterRecordId: record.id, sourceId: original[0].id, documentId: 'document-ocr3', version: 'v3', page: 1,
    extractionMethod: 'human_report', value: { amountMinor: 500000 }, sourceDigest: 'e'.repeat(64), recordedBy: 'test',
  });

  // Identical digest: no-op, the very same job and the very same pages.
  assert.deepEqual(repository.completeJob('ocr-fresh', pages, changes('a'.repeat(64))), completed);
  assert.deepEqual(pageRows(), original);
  // A different result, or a missing digest, is rejected without touching any page.
  for (const digest of ['b'.repeat(64), undefined]) {
    assert.throws(() => repository.completeJob('ocr-fresh', pages, changes(digest)), { code: 'OCR_JOB_ALREADY_COMPLETED' });
    assert.deepEqual(pageRows(), original);
  }
  assert.equal(database.isTransaction, false);
  // The referencing evidence is intact.
  assert.equal(parameters.getObservation(observation.id).sourceId, original[0].id);
  assert.deepEqual(parameters.getObservation(observation.id).value, { amountMinor: 500000 });
});

test('T3: first completion inserts pages once and a mismatching job or version is still rejected', t => {
  const { database, repository, pages, changes } = ocrWorld(t);
  assert.throws(() => repository.completeJob('ocr-missing', pages, changes('a'.repeat(64))), /OCR job was not found/);
  repository.completeJob('ocr-fresh', pages, changes('a'.repeat(64)));
  assert.equal(count(database, 'SELECT count(*) AS count FROM source_pages WHERE ocr_job_id = ?', 'ocr-fresh'), 2);
  // Another job for the same immutable document version cannot add or replace pages.
  database.prepare(`INSERT INTO ocr_jobs (id, document_upload_id, provider, status, attempt_count, requested_at, updated_at)
    VALUES ('ocr-second', 'document-ocr3', 'fixture', 'processing', 1, ?, ?)`).run('2026-10-09T10:00:00.000Z', '2026-10-09T10:00:00.000Z');
  assert.throws(() => repository.completeJob('ocr-second', pages, changes('a'.repeat(64))), { code: 'OCR_PAGES_ALREADY_EXIST' });
  assert.equal(count(database, 'SELECT count(*) AS count FROM source_pages WHERE document_upload_id = ?', 'document-ocr3'), 2);
  // The page rows keep their original ids: nothing was deleted and recreated.
  assert.equal(count(database, "SELECT count(*) AS count FROM source_pages WHERE ocr_job_id = 'ocr-second'"), 0);
});

// ---------------------------------------------------------------------------
// T4: question citations resolve to authorised sources
// ---------------------------------------------------------------------------

const outputsByKind = (database, runId) => Object.fromEntries(database.prepare('SELECT task_kind, output_json FROM workflow_tasks WHERE workflow_run_id = ?').all(runId)
  .map(row => [row.task_kind, JSON.parse(row.output_json ?? 'null')?.payload ?? null]));

test('T4: question citations are the single opaque id of an authorised source, never a double hash', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app);
  const run = await scenario.startLiveRun('t4-questions');
  assert.equal(run.status, 202, run.raw);
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(modelRequests.length, 5);

  const input = runInput(app.database, run.data.id);
  const authorised = new Set(input.authorizedSourceIds.flatMap(rawId => [rawId, opaqueSourceId(rawId)]));
  const opaque = opaqueSourceId(scenario.pageId);
  const doubleHashed = opaqueSourceId(opaque);

  const request = modelRequests.find(entry => entry.agentId.endsWith('question_drafting'));
  const sent = JSON.parse(request.prompt);
  assert.ok(sent.sources.length >= 1);
  assert.ok(sent.sources.every(source => source.id === opaque), 'question sources are opaqued exactly once');
  assert.ok(!request.prompt.includes(doubleHashed));
  assert.ok(!request.prompt.includes(scenario.pageId));

  const { question_drafting: questions, evidence_review: evidence, privacy_review: privacy } = outputsByKind(app.database, run.data.id);
  assert.ok(questions.questions.length >= 1);
  for (const citation of [...questions.questions.flatMap(question => question.citations), ...questions.unresolvedSourceIds]) {
    assert.ok(authorised.has(citation), 'every question citation maps to an authorised source');
    assert.notEqual(citation, doubleHashed);
  }
  assert.equal(privacy.status, 'passed');
  assert.ok(evidence.findings.every(finding => finding.code === 'HUMAN_REVIEW_REQUIRED'));
});

test('T4: look-alike question citations still fail closed', async t => {
  const wrong = [
    ['double hash', id => opaqueSourceId(id)],
    ['uppercase', id => id.toUpperCase()],
    ['padded', id => ` ${id}`],
    ['prefix', id => id.slice(0, -2)],
  ];
  for (const [label, mutate] of wrong) {
    const app = await startLiveServer(t, {
      output: (agentId, input) => {
        const output = mockOutput(agentId, input);
        if (agentId.endsWith('question_drafting')) {
          output.questions = output.questions.map(question => ({ ...question, citations: question.citations.map(mutate) }));
          output.unresolvedSourceIds = output.unresolvedSourceIds.map(mutate);
        }
        return output;
      },
    });
    const scenario = await setupLiveCase(app, { suffix: `t4-${label.replace(/\W/g, '')}` });
    const run = await scenario.startLiveRun(`t4-lookalike-${label}`);
    assert.notEqual(run.data.status, 'completed', label);
    const questionTask = run.data.tasks.find(task => task.taskKind === 'question_drafting' || task.agentName?.endsWith('questions'));
    assert.notEqual(questionTask?.status, 'completed', label);
    assert.notEqual(outputsByKind(app.database, run.data.id).deterministic_release_gate?.status, 'released', label);
    assert.ok(!run.raw.includes(scenario.pageId));
  }
});

// ---------------------------------------------------------------------------
// T5: consent revocation audits observation redaction
// ---------------------------------------------------------------------------

test('T5: revoking a document grant redacts its observations with an explicit counts-only audit event', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: `Synthetic schedule for ${PROBE_EMAIL}: room rent limit is 5000.` });
  const services = createBackendServices(app.database);
  const run = await scenario.startLiveRun('t5-revocation');
  assert.equal(run.status, 202);

  const valueProbe = 'SYNTHETIC-OBSERVATION-VALUE-4711';
  const records = services.coverageParameters.listForRun(run.data.id);
  const observe = (key, id) => services.coverageParameters.appendObservation({
    id, parameterRecordId: records.find(record => record.parameterKey === key).id, sourceId: scenario.pageId, documentId: scenario.documentId,
    version: scenario.sourceVersion, page: scenario.pageNumber, extractionMethod: 'human_report', value: { text: valueProbe }, sourceDigest: 'e'.repeat(64), recordedBy: 'test',
  });
  observe('d.room_rent_limit', 'observation-t5-a');
  observe('a.document_set', 'observation-t5-b');
  const before = auditActions(app.database, 'coverage_parameter.observations_redacted').length;

  services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic' });

  const events = auditActions(app.database, 'coverage_parameter.observations_redacted');
  assert.equal(events.length, before + 1);
  const event = events.at(-1);
  assert.equal(event.resourceId, scenario.documentId);
  assert.deepEqual(event.payload, { reasonCode: 'consent_revoked', redactedObservations: 2, affectedParameters: 2, resetResolutions: 0 });
  assert.ok(!JSON.stringify(event).includes(valueProbe));
  // The explicit path ran inside the revocation: the reason is consent_revoked, not the trigger's document_erasure.
  const rows = app.database.prepare('SELECT value_json, redacted_at, redaction_reason_code FROM coverage_parameter_observations ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.value_json === null && row.redacted_at && row.redaction_reason_code === 'consent_revoked'));
  const actor = app.database.prepare('SELECT actor_type, actor_id FROM audit_events WHERE id = ?').get(event.id);
  assert.deepEqual({ ...actor }, { actor_type: 'adult_user', actor_id: scenario.ownerId });

  // Revoking again changes nothing and appends no further redaction event.
  services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic again' });
  assert.equal(auditActions(app.database, 'coverage_parameter.observations_redacted').length, before + 1);
});

test('T5: a revocation that has nothing to redact appends no redaction event and still completes', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const services = createBackendServices(app.database);
  services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic' });
  assert.equal(auditActions(app.database, 'coverage_parameter.observations_redacted').length, 0);
  assert.equal(auditActions(app.database, 'consent.revoked').length, 1);
  assert.equal(app.database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(scenario.documentId).lifecycle_state, 'deletion_requested');
});
