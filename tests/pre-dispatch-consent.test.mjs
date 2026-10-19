import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/features/ai-analysis/index.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/features/ai-analysis/live-coverage-runtime.js';
import { COVERAGE_ANALYSIS_WORKFLOW, createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import { auditActions, liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';

// Synthetic probe values that must never leave the process once consent is gone.
const PROBE_EMAIL = 'asha.synthetic@example.test';
const PAGE_TEXT = `Synthetic schedule for ${PROBE_EMAIL}: room rent limit is 5000.`;
const MODEL_TASK_KEYS = COVERAGE_ANALYSIS_WORKFLOW.tasks.filter(task => task.owner === 'model_assist').map(task => task.key);

function liveService(app, modelRequests) {
  const services = createBackendServices(app.database);
  const port = createCoverageAnalysisPort({ database: app.database, services });
  const validatorCalls = [];
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver({ modelRequests }),
    knownIdentifierLoader: caseId => port.loadKnownIdentifiers(caseId), preDispatchValidator: request => {
      validatorCalls.push(request);
      return port.authorizeModelDispatch(request);
    },
  })();
  return { services, port, validatorCalls, service: createPersistentCoverageAnalysisService({ port, liveRegistry: registry }) };
}

function runRows(database, runId) {
  return {
    tasks: database.prepare('SELECT agent_name, status, last_error_code, last_error_message, output_json FROM workflow_tasks WHERE workflow_run_id = ?').all(runId),
    run: database.prepare('SELECT status, input_json FROM workflow_runs WHERE id = ?').get(runId),
  };
}

function assertNoProbeLeak(database, runId, extra = []) {
  const { tasks, run } = runRows(database, runId);
  const audit = database.prepare('SELECT event_payload_json FROM audit_events').all();
  const body = JSON.stringify({ tasks, run, audit, extra });
  assert.ok(!body.includes(PROBE_EMAIL), 'probe identifier must not appear in workflow output, run input, audit or errors');
}

for (const [label, revoke] of [
  ['consent revocation through the repository', ({ services, scenario }) => services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic race' })],
  ['a bare revoked_at change without any cascade', ({ app, scenario }) => app.database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), scenario.documentConsentId)],
]) {
  test(`revocation after source selection but before dispatch makes zero provider calls (${label})`, async t => {
    const modelRequests = [];
    const app = await startLiveServer(t);
    const scenario = await setupLiveCase(app, { pageText: PAGE_TEXT });
    const { services, service, validatorCalls } = liveService(app, modelRequests);

    const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: `race-${label}` });
    assert.deepEqual(JSON.parse(job.input_json).authorizedSources, [{ sourceId: scenario.pageId, documentId: scenario.documentId }]);

    revoke({ app, services, scenario });
    const settled = await service.runUntilSettled(job.id);

    assert.equal(modelRequests.length, 0, 'revoked evidence must never be dispatched');
    assert.equal(auditActions(app.database, 'analysis.model_dispatch_authorized').length, 0);
    if (label.startsWith('consent revocation through the repository')) {
      // N3: the repository revocation itself already revoked the run and erased
      // its derived data, so the worker finds a terminal run and never dispatches.
      assert.equal(settled.status, 'revoked');
      assert.equal(validatorCalls.length, 0);
      assertNoProbeLeak(app.database, job.id);
      return;
    }
    assert.ok(validatorCalls.length >= 1, 'the validator must have been consulted');
    const denied = auditActions(app.database, 'analysis.model_dispatch_denied');
    assert.equal(denied.length, validatorCalls.length);
    assert.ok(denied.every(event => event.payload.reasonCode === 'SOURCE_CONSENT_NOT_CURRENT'));

    const { tasks } = runRows(app.database, job.id);
    const modelTaskRows = tasks.filter(task => MODEL_TASK_KEYS.some(key => task.agent_name === `coverage-analysis/${key}`));
    assert.ok(modelTaskRows.every(task => task.status !== 'completed'), 'no model task may complete after revocation');
    const failed = modelTaskRows.filter(task => task.status === 'failed');
    assert.ok(failed.length >= 1);
    assert.ok(failed.every(task => task.last_error_code === 'MODEL_DISPATCH_AUTHORIZATION_FAILED'));
    assert.ok(failed.every(task => task.last_error_message === 'Current evidence authorization could not be verified before model dispatch.'));
    assert.notEqual(settled.status, 'completed');
    assertNoProbeLeak(app.database, job.id);
  });
}

test('revocation of a document grant while a model call is in flight discards the result and stops the run over HTTP', async t => {
  const modelRequests = [];
  let revokeOnFirstCall = () => {};
  const app = await startLiveServer(t, { modelRequests, onGenerate: (_request, count) => { if (count === 1) revokeOnFirstCall(); } });
  const scenario = await setupLiveCase(app, { pageText: PAGE_TEXT });
  const services = createBackendServices(app.database);
  revokeOnFirstCall = () => services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic mid-run revocation' });

  const response = await scenario.startLiveRun('mid-run-revocation');
  assert.equal(response.status, 202);

  const revokedAt = auditActions(app.database, 'consent.revoked').at(-1);
  assert.ok(revokedAt, 'revocation happened during the run');
  const authorized = auditActions(app.database, 'analysis.model_dispatch_authorized');
  const denied = auditActions(app.database, 'analysis.model_dispatch_denied');
  assert.ok(authorized.length >= 1);
  assert.ok(authorized.every(event => event.id < revokedAt.id), 'no dispatch may be authorized after revocation');
  assert.ok(denied.every(event => event.id > revokedAt.id));
  // The repository revocation already revoked and erased the run, so later
  // checks see a run that is no longer dispatchable.
  assert.ok(denied.every(event => ['SOURCE_CONSENT_NOT_CURRENT', 'RUN_NOT_DISPATCHABLE'].includes(event.payload.reasonCode)));
  // Every provider call was preceded by its own allowed check, made before revocation.
  assert.equal(modelRequests.length, authorized.length);
  assert.ok(modelRequests.length < MODEL_TASK_KEYS.length);
  // The in-flight results were discarded and the run stopped on the revocation path.
  const run = app.database.prepare('SELECT status, terminal_reason FROM workflow_runs WHERE id = ?').get(response.data.id);
  assert.deepEqual({ ...run }, { status: 'revoked', terminal_reason: 'CONSENT_REVOKED' });
  assert.ok(auditActions(app.database, 'analysis.task_completed').every(event => event.id < revokedAt.id), 'nothing may be committed after revocation');
  const stopped = auditActions(app.database, 'analysis.revoked');
  assert.equal(stopped.length, 1);
  assert.equal(stopped[0].payload.reason, 'source_consent_not_current');
  assert.ok(['SOURCE_CONSENT_NOT_CURRENT', 'RUN_NOT_DISPATCHABLE'].includes(stopped[0].payload.reasonCode));
  assert.ok(!response.raw.includes(PROBE_EMAIL));
  assertNoProbeLeak(app.database, response.data.id, [modelRequests]);
});

test('source selection excludes NULL-recipient and wrong-recipient documents, so a mixed-consent case leaks nothing', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app);
  const nullRecipient = scenario.addDocument({ suffix: 'null-recipient', text: `Denied page for ${PROBE_EMAIL} room rent limit ROOMLIMIT-NULLRECIP`, scopeRecipient: null });
  const wrongRecipient = scenario.addDocument({ suffix: 'wrong-recipient', text: `Other model page ${PROBE_EMAIL} room rent limit ROOMLIMIT-WRONGRECIP`, scopeRecipient: 'openai-gpt' });

  const response = await scenario.startLiveRun('mixed-consent');
  assert.equal(response.status, 202);
  assert.equal(response.data.tasks.filter(task => task.status === 'completed').length, 22);
  const input = JSON.parse(app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(response.data.id).input_json);
  assert.deepEqual(input.authorizedSourceIds, [scenario.pageId]);
  assert.deepEqual(input.authorizedSources, [{ sourceId: scenario.pageId, documentId: scenario.documentId }]);
  const providerBody = JSON.stringify(modelRequests);
  for (const forbidden of [PROBE_EMAIL, 'ROOMLIMIT-NULLRECIP', 'ROOMLIMIT-WRONGRECIP', nullRecipient.pageId, wrongRecipient.pageId, nullRecipient.documentId, wrongRecipient.documentId]) {
    assert.ok(!providerBody.includes(forbidden), 'a denied document must not reach the provider');
  }
  assert.equal(auditActions(app.database, 'analysis.model_dispatch_authorized').length, modelRequests.length);
});

for (const recipient of [null, 'openai-gpt', 'Google-Gemini', 'google-gemini ']) {
  test(`a case whose only document lacks an exact model recipient (${JSON.stringify(recipient)}) cannot start live analysis`, async t => {
    const modelRequests = [];
    const app = await startLiveServer(t, { modelRequests });
    const scenario = await setupLiveCase(app, { recipient });
    const response = await scenario.startLiveRun(`no-recipient-${String(recipient)}`);
    // SOURCE_PACK_REQUIRED: no page is admitted, so the run is never created.
    assert.equal(response.status, 409, response.raw);
    assert.match(JSON.stringify(response.data.error), /at least one authorised, protected OCR source page/);
    assert.equal(app.database.prepare("SELECT count(*) AS count FROM workflow_runs WHERE execution_mode = 'live'").get().count, 0);
    assert.equal(modelRequests.length, 0);
  });
}

async function dispatchFixture(t) {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: PAGE_TEXT });
  const services = createBackendServices(app.database);
  const port = createCoverageAnalysisPort({ database: app.database, services });
  const service = createPersistentCoverageAnalysisService({ port, liveRegistry: createGeminiCoverageRegistryFactory({ env: liveEnv, ...stubModelDriver(), knownIdentifierLoader: () => [], preDispatchValidator: () => false })() });
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'dispatch-fixture' });
  const baseRequest = () => ({
    task: 'profile_extraction',
    runId: job.id,
    caseId: scenario.caseId,
    subjectId: scenario.ownerId,
    authorizedSourceIds: [scenario.pageId],
    authorizedSources: [{ sourceId: scenario.pageId, documentId: scenario.documentId }],
    modelRecipient: GEMINI_MODEL_RECIPIENT,
    sourceDigests: [],
  });
  return { app, scenario, services, port, job, baseRequest, db: app.database };
}

function expectDecision(port, request, reasonCode) {
  const decision = port.authorizeModelDispatch(request);
  if (reasonCode === null) assert.deepEqual({ ...decision }, { allowed: true, reasonCode: null });
  else assert.deepEqual({ ...decision }, { allowed: false, reasonCode });
}

test('pre-dispatch validator denies every wrong-scope or no-longer-current document grant and recovers when restored', async t => {
  const { scenario, port, baseRequest, db } = await dispatchFixture(t);
  const now = new Date().toISOString();
  expectDecision(port, baseRequest(), null);

  const scopeUpdate = (column, value) => db.prepare(`UPDATE consent_scopes SET ${column} = ? WHERE id = ?`).run(value, scenario.scopeId);
  const grantUpdate = (column, value) => db.prepare(`UPDATE consent_grants SET ${column} = ? WHERE id = ?`).run(value, scenario.documentConsentId);

  const mutations = [
    ['wrong recipient', () => scopeUpdate('recipient', 'openai-gpt'), () => scopeUpdate('recipient', GEMINI_MODEL_RECIPIENT)],
    ['NULL recipient', () => scopeUpdate('recipient', null), () => scopeUpdate('recipient', GEMINI_MODEL_RECIPIENT)],
    ['look-alike recipient', () => scopeUpdate('recipient', 'google-gemini-2'), () => scopeUpdate('recipient', GEMINI_MODEL_RECIPIENT)],
    ['wrong action', () => scopeUpdate('action', 'collect'), () => scopeUpdate('action', 'derive')],
    ['wrong data category', () => scopeUpdate('data_category', 'identity'), () => scopeUpdate('data_category', 'insurance_document')],
    ['wrong purpose', () => grantUpdate('purpose', 'coverage_reconstruction'), () => grantUpdate('purpose', 'document_processing')],
    ['expired', () => grantUpdate('expires_at', '2020-01-01T00:00:00.000Z'), () => grantUpdate('expires_at', null)],
    ['revoked', () => grantUpdate('revoked_at', now), () => grantUpdate('revoked_at', null)],
    ['document lifecycle no longer active', () => db.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?").run(scenario.documentId), () => db.prepare("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = ?").run(scenario.documentId)],
    ['page text purged', () => db.prepare('UPDATE source_pages SET extracted_text = NULL WHERE id = ?').run(scenario.pageId), () => db.prepare('UPDATE source_pages SET extracted_text = ? WHERE id = ?').run(PAGE_TEXT, scenario.pageId)],
  ];
  for (const [label, mutate, restore] of mutations) {
    mutate();
    assert.equal(port.authorizeModelDispatch(baseRequest()).allowed, false, `${label} must be denied`);
    expectDecision(port, baseRequest(), 'SOURCE_CONSENT_NOT_CURRENT');
    restore();
    expectDecision(port, baseRequest(), null);
  }

  // Wrong resource: the derive scope names another document in the same household.
  const other = scenario.addDocument({ suffix: 'other-resource', scopeRecipient: 'synthetic-other-recipient' });
  db.prepare('DELETE FROM consent_scopes WHERE id = ?').run(scenario.scopeId);
  db.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-wrong-resource', ?, 'document', ?, 'derive', 'insurance_document', ?, ?)`).run(scenario.documentConsentId, other.documentId, GEMINI_MODEL_RECIPIENT, now);
  expectDecision(port, baseRequest(), 'SOURCE_CONSENT_NOT_CURRENT');
  // A broad (NULL resource) derive scope never stands in for the exact document.
  db.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-broad', ?, 'document', NULL, 'derive', 'insurance_document', ?, ?)`).run(scenario.documentConsentId, GEMINI_MODEL_RECIPIENT, now);
  expectDecision(port, baseRequest(), 'SOURCE_CONSENT_NOT_CURRENT');
  db.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-restored', ?, 'document', ?, 'derive', 'insurance_document', ?, ?)`).run(scenario.documentConsentId, scenario.documentId, GEMINI_MODEL_RECIPIENT, now);
  expectDecision(port, baseRequest(), null);

  // Wrong subject: the grant now belongs to another adult in the same household.
  db.prepare(`INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-synthetic-other', 'Other synthetic adult', 'active', ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES ('role-synthetic-other', ?, 'adult-synthetic-other', 'member', 'active', ?)`).run(scenario.householdId, now);
  grantUpdate('subject_adult_id', 'adult-synthetic-other');
  expectDecision(port, baseRequest(), 'SOURCE_CONSENT_NOT_CURRENT');
  grantUpdate('subject_adult_id', scenario.ownerId);
  expectDecision(port, baseRequest(), null);

  // Wrong household: the grant moves to another household the subject also belongs to.
  db.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('household-synthetic-other', 'Other synthetic household', now, now);
  db.prepare(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES ('role-owner-other', 'household-synthetic-other', ?, 'owner', 'active', ?)`).run(scenario.ownerId, now);
  grantUpdate('household_id', 'household-synthetic-other');
  expectDecision(port, baseRequest(), 'SOURCE_CONSENT_NOT_CURRENT');
  grantUpdate('household_id', scenario.householdId);
  expectDecision(port, baseRequest(), null);

  // The case-level coverage consent must also still be current.
  db.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(now, scenario.coverageConsentId);
  expectDecision(port, baseRequest(), 'COVERAGE_CONSENT_NOT_CURRENT');
  db.prepare('UPDATE consent_grants SET revoked_at = NULL WHERE id = ?').run(scenario.coverageConsentId);
  expectDecision(port, baseRequest(), null);
});

test('pre-dispatch validator rejects look-alike, foreign, re-attributed and malformed source sets', async t => {
  const { scenario, port, baseRequest, job, db } = await dispatchFixture(t);
  const denied = scenario.addDocument({ suffix: 'denied-doc', scopeRecipient: null });
  const zeroWidth = `${scenario.pageId}​`;
  const cases = [
    ['upper-case look-alike', { authorizedSourceIds: [scenario.pageId.toUpperCase()], authorizedSources: [{ sourceId: scenario.pageId.toUpperCase(), documentId: scenario.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['trailing-space look-alike', { authorizedSourceIds: [`${scenario.pageId} `], authorizedSources: [{ sourceId: `${scenario.pageId} `, documentId: scenario.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['zero-width look-alike', { authorizedSourceIds: [zeroWidth], authorizedSources: [{ sourceId: zeroWidth, documentId: scenario.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['prefix look-alike', { authorizedSourceIds: ['page-'], authorizedSources: [{ sourceId: 'page-', documentId: scenario.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['page of a denied document in the same case', { authorizedSourceIds: [denied.pageId], authorizedSources: [{ sourceId: denied.pageId, documentId: denied.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['authorized page plus a denied page', { authorizedSourceIds: [scenario.pageId, denied.pageId], authorizedSources: [{ sourceId: scenario.pageId, documentId: scenario.documentId }, { sourceId: denied.pageId, documentId: denied.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['page re-attributed to another document', { authorizedSources: [{ sourceId: scenario.pageId, documentId: denied.documentId }] }, 'SOURCE_NOT_SELECTED_FOR_RUN'],
    ['missing source-document mapping', { authorizedSources: undefined }, 'AUTHORIZED_SOURCES_INVALID'],
    ['empty source set', { authorizedSourceIds: [], authorizedSources: [] }, 'AUTHORIZED_SOURCES_INVALID'],
    ['duplicate source ids', { authorizedSourceIds: [scenario.pageId, scenario.pageId] }, 'AUTHORIZED_SOURCES_INVALID'],
    ['oversized source set', { authorizedSourceIds: Array.from({ length: 501 }, (_, index) => `page-${index}`) }, 'AUTHORIZED_SOURCES_INVALID'],
    ['wrong model recipient', { modelRecipient: 'openai-gpt' }, 'MODEL_RECIPIENT_MISMATCH'],
    ['missing model recipient', { modelRecipient: undefined }, 'MODEL_RECIPIENT_MISMATCH'],
    ['wrong subject', { subjectId: 'adult-synthetic-other' }, 'SUBJECT_MISMATCH'],
    ['another case', { caseId: 'case-synthetic-other' }, 'RUN_NOT_DISPATCHABLE'],
    ['unknown run', { runId: 'coverage-run-unknown' }, 'RUN_NOT_DISPATCHABLE'],
    ['missing run id', { runId: undefined }, 'DISPATCH_REQUEST_INVALID'],
  ];
  for (const [label, override, reasonCode] of cases) {
    const decision = port.authorizeModelDispatch({ ...baseRequest(), ...override });
    assert.deepEqual({ ...decision }, { allowed: false, reasonCode }, label);
  }
  for (const malformed of [null, undefined, 'allow', [], { allowed: true }]) {
    assert.equal(port.authorizeModelDispatch(malformed).allowed, false);
  }
  // Errors raised while reading the request (or the database) deny.
  const hostile = baseRequest();
  Object.defineProperty(hostile, 'authorizedSourceIds', { get() { throw new Error(`boom ${PROBE_EMAIL}`); }, enumerable: true });
  expectDecision(port, hostile, 'DISPATCH_VALIDATION_ERROR');

  // A run that is no longer active cannot dispatch.
  db.prepare("UPDATE workflow_runs SET status = 'revoked' WHERE id = ?").run(job.id);
  expectDecision(port, baseRequest(), 'RUN_NOT_DISPATCHABLE');

  // Denials are audited with id-free metadata and never echo request content.
  const audit = JSON.stringify(auditActions(db, 'analysis.model_dispatch_denied').map(event => event.payload));
  for (const forbidden of [PROBE_EMAIL, scenario.pageId, scenario.documentId, denied.pageId, 'boom']) assert.ok(!audit.includes(forbidden));
});

test('a validator database failure denies instead of allowing', async t => {
  const { services, baseRequest, db } = await dispatchFixture(t);
  const failingDatabase = { prepare: sql => (/workflow_runs/.test(sql) ? { get() { throw new Error('disk I/O error'); } } : db.prepare(sql)), exec: sql => db.exec(sql) };
  const port = createCoverageAnalysisPort({ database: failingDatabase, services });
  expectDecision(port, baseRequest(), 'DISPATCH_VALIDATION_ERROR');
  const failingAudit = createCoverageAnalysisPort({ database: db, services: { ...services, audit: { append() { throw new Error('audit unavailable'); } } } });
  expectDecision(failingAudit, baseRequest(), 'DISPATCH_AUDIT_FAILED');
});
