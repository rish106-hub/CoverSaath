import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';

// Storage for policy document structuring (PostgreSQL 007) and its repository.
// Synthetic data only: every value below is invented.

const pgOptions = postgresTestOptions();
const household = 'household-parameters';
const run = 'run-parameters';
const document = 'document-parameters';
const v1 = 'policy-parameters/v1';
const pipelineVersion = 'policy-structuring-extractor/v1';
const notFound = { code: 'STRUCTURING_SCOPE_NOT_FOUND' };

async function seedOtherHousehold(database) {
  for (const sql of [
    `INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-other', 'Other', '${at}', '${at}')`,
    `INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-other', 'Other', 'active', '${at}', '${at}')`,
    `INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
      VALUES ('role-other', 'household-other', 'adult-other', 'owner', 'active', '${at}')`,
    `INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
      VALUES ('member-other', 'household-other', 'adult-other', 'Other', 'adult', '${at}', '${at}')`,
    `INSERT INTO consent_grants (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
      VALUES ('consent-other', 'household-other', 'adult-other', 'knowvia-local', 'document_processing', 'v1', 'fixture', '${at}', '${at}')`,
    `INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
      VALUES ('case-other', 'household-other', 'member-other', 'adult-other', 'renewal', 'processing', '${at}', '${at}')`,
    `INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename,
      storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
      VALUES ('document-foreign', 'household-other', 'case-other', 'adult-other', 'consent-other', 'policy_schedule', 'fixture.pdf',
      'fixture/document-foreign', '${'9'.repeat(64)}', 'application/pdf', 100, 'clean', 'encrypted_local', 'active', '${at}', 'version-1')`,
    `INSERT INTO source_pages (id, document_upload_id, page_number, source_version, page_sha256, extracted_text, extraction_status, created_at)
      VALUES ('page-foreign', 'document-foreign', 2, 'version-1', '${'8'.repeat(64)}', 'Synthetic clause', 'extracted', '${at}')`,
    `INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, created_at)
      VALUES ('run-foreign', 'case-other', 'coverage-reconstruction', 'v2', 'fixture', 'queued', '${'d'.repeat(64)}', '{}', '${at}')`,
  ]) await database.run(sql);
}

async function open(t) {
  const { db: database, services } = await freshDatabase(t, { clock: () => new Date(at) });
  await seedParameterWorld(database);
  await seedOtherHousehold(database);
  await services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: v1, ...parameterScope(), updatedBy: 'test' });
  return { database, services, structuring: services.policyStructuring };
}

const value = (text, normalized = null, subject = 'policy') => ({ text, normalized, subject });
const decision = (parameterKey, state, observations, reasonCode = state === 'conflicting' ? 'model_observations_conflict' : 'model_extracted_unverified') =>
  ({ parameterKey, state, reasonCode, observations });
const proposal = (proposedKey, overrides = {}) => ({
  kind: 'proposed', proposedKey, category: 'unassigned', label: 'Synthetic benefit',
  value: value('Rs. 2,000 per day', { kind: 'money', amountMinor: 200000, currency: 'INR', per: 'day' }),
  evidenceQuote: 'Synthetic benefit Rs. 2,000 per day', page: 2, blockIndex: 3, chunkId: 'p2-b3', ...overrides,
});

function input(services, overrides = {}) {
  return {
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion,
    registryVersion: v1, recordedBy: 'policy-structuring', at,
    consentCheck: () => services.consents.requireActive('consent-parameters', { subjectAdultId: 'adult-parameters', purpose: 'document_processing' }),
    decisions: [
      decision('a.policy_type', 'extracted_unverified', [{ value: value('Individual'), page: 2, blockIndex: 1 }]),
      decision('a.product_uin_and_version', 'conflicting', [
        { value: value('SYN-UIN-001'), page: 2, blockIndex: 4 },
        { value: value('SYN-UIN-002'), page: 2, blockIndex: 9 },
      ]),
      decision('k.not_in_registry', 'extracted_unverified', [{ value: value('x'), page: 2 }]),
      decision('b.moratorium_date', 'extracted_unverified', [{ value: value('01/01/2026'), page: 2 }]),
    ],
    proposals: [proposal('synthetic_daily_cash'), proposal('synthetic_wellness_credit', { blockIndex: 5 })],
    ...overrides,
  };
}

const count = async (database, sql, ...params) => (await database.prepare(sql).get(...params)).count;
const liveObservations = database => count(database, `SELECT count(*) AS count FROM coverage_parameter_observations
  WHERE redacted_at IS NULL AND recorded_by = 'policy-structuring'`);
const liveProposals = database => count(database, 'SELECT count(*) AS count FROM proposed_parameters WHERE redacted_at IS NULL');
const structuringRuns = database => count(database, 'SELECT count(*) AS count FROM policy_structuring_runs');
const resolution = async (services, key) => (await services.coverageParameters.listForRun(run)).find(record => record.parameterKey === key);
const auditFor = (database, action) => database.prepare('SELECT * FROM audit_events WHERE action = ? ORDER BY id').all(action);

test('commit records observations, resolutions and proposals in one transaction with counts only', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  const result = await structuring.commitStructuring(input(services));
  assert.equal(result.replayed, false);
  assert.deepEqual({ ...result, structuringRunId: undefined }, {
    replayed: false, structuringRunId: undefined, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 2, proposals: 2,
  });
  assert.equal((await resolution(services, 'a.policy_type')).resolutionState, 'extracted_unverified');
  assert.equal((await resolution(services, 'a.policy_type')).authority, 'model');
  assert.deepEqual((await resolution(services, 'a.policy_type')).resolvedValue, { ...value('Individual'), blockIndex: 1 });
  assert.equal((await resolution(services, 'a.product_uin_and_version')).resolutionState, 'conflicting');
  assert.equal((await resolution(services, 'a.product_uin_and_version')).resolutionReasonCode, 'model_observations_conflict');
  assert.equal((await resolution(services, 'b.moratorium_date')).resolutionState, 'unknown', 'model extraction not permitted: skipped');
  const observation = await database.prepare("SELECT * FROM coverage_parameter_observations WHERE recorded_by = 'policy-structuring' LIMIT 1").get();
  assert.equal(observation.extraction_method, 'document_extraction');
  assert.equal(observation.review_status, 'not_reviewed');
  assert.equal(observation.source_id, 'page-parameters');
  assert.equal(observation.source_digest, 'b'.repeat(64), 'the digest is the cited page digest');

  const proposals = await structuring.listProposals({ householdId: household, documentId: document, structuringRunId: result.structuringRunId });
  assert.deepEqual(proposals.map(item => [item.proposedKey, item.status, item.page, item.blockIndex]), [
    ['synthetic_daily_cash', 'pending_review', 2, 3], ['synthetic_wellness_credit', 'pending_review', 2, 5],
  ]);
  assert.equal(proposals[0].value.evidenceQuote, 'Synthetic benefit Rs. 2,000 per day');
  assert.equal(proposals[0].sourcePageId, 'page-parameters');

  const stored = await structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  assert.equal(stored.id, result.structuringRunId);
  assert.deepEqual(stored.counts, { observations: 3, parameters: 2, conflicting: 1, skippedKeys: 2, proposals: 2 });
  assert.equal(stored.erasedAt, null);
  assert.equal(await structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: 'document-other' }), null);

  const [event] = await auditFor(database, 'policy_structuring.committed');
  assert.deepEqual(JSON.parse(event.event_payload_json), {
    structuringRunId: result.structuringRunId, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 2, proposals: 2,
  });
  const audits = JSON.stringify(await database.prepare('SELECT * FROM audit_events').all());
  for (const secret of ['Individual', 'SYN-UIN', 'Rs. 2,000', 'Synthetic benefit']) assert.equal(audits.includes(secret), false, `audit holds no ${secret}`);
});

test('a replayed commit returns the stored counts and writes nothing new', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  const first = await structuring.commitStructuring(input(services));
  const snapshot = async () => ({
    observations: await count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'),
    proposals: await count(database, 'SELECT count(*) AS count FROM proposed_parameters'),
    audits: await count(database, 'SELECT count(*) AS count FROM audit_events'),
  });
  const before = await snapshot();
  const replay = await structuring.commitStructuring(input(services));
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual(await snapshot(), before);
  assert.equal(await structuringRuns(database), 1);
  // A different pipeline version is a new identity.
  assert.equal((await structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring-extractor/v2', decisions: [] }))).replayed, false);
  assert.equal(await structuringRuns(database), 2);
});

// Run-scoped proposals defect: proposals were listed by document only, so a second analysis run on the
// same document showed the first run's proposals as its own.
async function seedSecondRun(database, services) {
  await database.prepare(`INSERT INTO workflow_runs
    (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, created_at)
    VALUES ('run-second', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture', 'queued', ?, '{}', ?)`).run('e'.repeat(64), at);
  await services.coverageParameters.initializeRunParameters({ ...parameterScope(), workflowRunId: 'run-second', registryVersion: v1, updatedBy: 'test' });
}

test('listProposals returns only the proposals of the given structuring run (run-scoped proposals defect)', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  await seedSecondRun(database, services);
  const first = await structuring.commitStructuring(input(services, { decisions: [] }));
  const second = await structuring.commitStructuring(input(services, {
    workflowRunId: 'run-second', decisions: [], proposals: [proposal('synthetic_second_run_benefit')],
  }));
  const keys = async structuringRunId => (await structuring.listProposals({ householdId: household, documentId: document, structuringRunId }))
    .map(item => [item.proposedKey, item.structuringRunId]);
  assert.deepEqual(await keys(first.structuringRunId), [
    ['synthetic_daily_cash', first.structuringRunId], ['synthetic_wellness_credit', first.structuringRunId],
  ]);
  assert.deepEqual(await keys(second.structuringRunId), [['synthetic_second_run_benefit', second.structuringRunId]]);
  // Erase the older run and structure again: only the newest run's proposals are listed.
  await structuring.eraseDerived({ householdId: household, workflowRunIds: [run], reasonCode: 'data_subject_request' });
  const again = await structuring.commitStructuring(input(services, { decisions: [], proposals: [proposal('synthetic_rerun_benefit')] }));
  assert.deepEqual(await keys(again.structuringRunId), [['synthetic_rerun_benefit', again.structuringRunId]]);
  assert.deepEqual(await keys(first.structuringRunId), []);

  const invalidInput = { code: 'STRUCTURING_INPUT_INVALID' };
  await assert.rejects(() => structuring.listProposals({ householdId: household, documentId: document }), invalidInput, 'run id is required');
  await assert.rejects(() => structuring.listProposals({ householdId: household, documentId: document, structuringRunId: "x' OR 1=1" }), invalidInput);
  await assert.rejects(() => structuring.listProposals({ householdId: 'household-other', documentId: document, structuringRunId: first.structuringRunId }), notFound);
});

test('the review result lists only the proposals of its own run and carries provenance', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  await seedSecondRun(database, services);
  const first = await structuring.commitStructuring(input(services, { decisions: [] }));
  await structuring.commitStructuring(input(services, { workflowRunId: 'run-second', decisions: [], proposals: [proposal('synthetic_second_run_benefit')] }));
  const service = createPolicyStructuringService({ services, loadKnownIdentifiers: async () => [], createModelCall: () => () => {}, env: {} });
  const owned = { id: document, householdId: household, caseId: 'case-parameters' };
  const review = await service.result({ document: owned, workflowRunId: run });
  assert.equal(review.structuringRun.id, first.structuringRunId);
  assert.equal(review.structuringRun.sourceVersion, 'version-1');
  assert.deepEqual(review.proposals.map(item => item.proposedKey), ['synthetic_daily_cash', 'synthetic_wellness_credit']);
  for (const item of review.proposals) {
    assert.deepEqual([item.structuringRunId, item.pipelineVersion, item.registryVersion, item.sourceVersion],
      [first.structuringRunId, pipelineVersion, v1, 'version-1']);
  }
  await assert.rejects(async () => service.result({ document: owned, workflowRunId: undefined }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(async () => service.result({ document: { ...owned, householdId: 'household-other' }, workflowRunId: run }), notFound);
});

test('every read and write is household-scoped with one coded error', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  await structuring.commitStructuring(input(services));
  let consentCalls = 0;
  const consentCheck = () => { consentCalls += 1; };
  const snapshot = async () => ({ obs: await liveObservations(database), proposals: await liveProposals(database), runs: await structuringRuns(database) });
  const before = await snapshot();
  for (const overrides of [
    { householdId: 'household-other' },
    { documentId: 'document-foreign' },
    { workflowRunId: 'run-foreign' },
    { householdId: 'household-other', workflowRunId: 'run-foreign' },
    { workflowRunId: 'run-missing' },
  ]) {
    await assert.rejects(() => structuring.commitStructuring(input(services, { ...overrides, consentCheck })), notFound, JSON.stringify(overrides));
  }
  assert.equal(consentCalls, 0, 'scope is checked before consent');
  assert.deepEqual(await snapshot(), before);
  const { id: structuringRunId } = await structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  await assert.rejects(() => structuring.listProposals({ householdId: 'household-other', documentId: document, structuringRunId }), notFound);
  await assert.rejects(() => structuring.listProposals({ householdId: household, documentId: 'document-foreign', structuringRunId }), notFound);
  await assert.rejects(() => structuring.listProposals({ householdId: household, documentId: 'document-missing', structuringRunId }), notFound);
  await assert.rejects(() => structuring.getStructuringRun({ householdId: 'household-other', workflowRunId: run, documentId: document }), notFound);
  await assert.rejects(() => structuring.getStructuringRun({ householdId: household, workflowRunId: 'run-foreign', documentId: document }), notFound);
  await assert.rejects(() => structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: 'document-foreign' }), notFound);
  // An inactive document is out of scope for writes, with the same error.
  await database.prepare("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-other'").run();
  await assert.rejects(() => structuring.commitStructuring(input(services, { documentId: 'document-other', consentCheck })), notFound);
});

test('consent is checked inside the transaction and a failing check writes nothing', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  let insideTransaction = null;
  await structuring.commitStructuring(input(services, {
    decisions: [], proposals: [proposal('synthetic_first')],
    consentCheck: () => { insideTransaction = database.inTransaction; },
  }));
  assert.equal(insideTransaction, true);

  const snapshot = async () => ({
    obs: await liveObservations(database), proposals: await liveProposals(database), runs: await structuringRuns(database),
    audits: await count(database, 'SELECT count(*) AS count FROM audit_events'),
  });
  const before = await snapshot();
  const denied = Object.assign(new Error('Active subject-scoped consent is required.'), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: () => { throw denied; } })), { code: 'CONSENT_REQUIRED' });
  // The check is awaited: an async check that rejects is a denial, never a pass.
  await assert.rejects(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: async () => { throw denied; } })), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: () => Promise.reject(denied) })), { code: 'CONSENT_REQUIRED' });
  await assert.rejects(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: undefined })), { code: 'STRUCTURING_INPUT_INVALID' });
  assert.deepEqual(await snapshot(), before);
  assert.equal((await resolution(services, 'a.policy_type')).resolutionState, 'unknown');
  // Revoked consent through the real check.
  await services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  await assert.rejects(() => structuring.commitStructuring(input(services, { documentId: 'document-other' })), error => ['CONSENT_REQUIRED', 'STRUCTURING_SCOPE_NOT_FOUND'].includes(error.code));
});

test('a failure part-way through rolls back every write', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  // Invalid second proposal: rejected before anything is written.
  await assert.rejects(() => structuring.commitStructuring(input(services, {
    proposals: [proposal('synthetic_ok'), proposal('Bad Key')],
  })), { code: 'STRUCTURING_INPUT_INVALID' });
  // A storage failure on the second proposal insert, after observations and the run row exist.
  await database.run(`CREATE FUNCTION test_fail_second_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (SELECT count(*) FROM public.proposed_parameters) >= 1 THEN RAISE EXCEPTION 'synthetic storage failure'; END IF;
      RETURN NEW;
    END $$`);
  await database.run(`CREATE TRIGGER test_fail_second_proposal BEFORE INSERT ON proposed_parameters
    FOR EACH ROW EXECUTE FUNCTION test_fail_second_proposal()`);
  await assert.rejects(() => structuring.commitStructuring(input(services)), error => {
    assert.equal(error.code, 'STRUCTURING_COMMIT_FAILED');
    assert.equal(error.message.includes('synthetic storage failure'), false, 'driver detail is not returned');
    return true;
  });
  assert.equal(await count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'), 0);
  assert.equal(await count(database, 'SELECT count(*) AS count FROM proposed_parameters'), 0);
  assert.equal(await structuringRuns(database), 0);
  assert.equal((await auditFor(database, 'policy_structuring.committed')).length, 0);
  assert.equal((await resolution(services, 'a.policy_type')).resolutionState, 'unknown');
  assert.equal((await resolution(services, 'a.product_uin_and_version')).resolutionState, 'unknown');
  await database.run('DROP TRIGGER test_fail_second_proposal ON proposed_parameters');
  // A cited page that does not exist also rolls back.
  await assert.rejects(() => structuring.commitStructuring(input(services, { proposals: [proposal('synthetic_ok', { page: 9 })] })), { code: 'STRUCTURING_PAGE_NOT_FOUND' });
  assert.equal(await count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'), 0);
  assert.equal((await structuring.commitStructuring(input(services))).replayed, false, 'the same commit succeeds afterwards');
});

test('the model authority ceiling holds: no proven or calculated, conflicting needs two observations', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  for (const state of ['proven', 'calculated', 'reported', 'dynamic', 'unknown']) {
    await assert.rejects(() => structuring.commitStructuring(input(services, {
      decisions: [decision('a.policy_type', state, [{ value: value('Individual'), page: 2 }], 'model_extracted_unverified')],
    })), { code: 'STRUCTURING_DECISION_INVALID' }, state);
  }
  await assert.rejects(() => structuring.commitStructuring(input(services, {
    decisions: [decision('a.policy_type', 'conflicting', [{ value: value('Individual'), page: 2 }])],
  })), { code: 'STRUCTURING_DECISION_INVALID' });
  await assert.rejects(() => structuring.commitStructuring(input(services, {
    decisions: [decision('a.policy_type', 'extracted_unverified', [{ value: value('A'), page: 2 }]), decision('a.policy_type', 'extracted_unverified', [{ value: value('B'), page: 2 }])],
  })), { code: 'STRUCTURING_DECISION_INVALID' }, 'a key appears once');
  assert.equal(await liveObservations(database), 0);
  for (const row of await database.prepare("SELECT resolution_state FROM coverage_parameter_resolutions WHERE transition_authority = 'model'").all()) {
    assert.ok(['extracted_unverified', 'conflicting', 'unknown'].includes(row.resolution_state));
  }
});

test('keys held by established authority are skipped and counted; a disagreeing prior value makes a conflict', pgOptions, async t => {
  const { services, structuring } = await open(t);
  const coverage = services.coverageParameters;
  const held = await resolution(services, 'a.document_set');
  const reviewed = await coverage.appendObservation({
    parameterRecordId: held.id, sourceId: 'page-parameters', documentId: document, version: 'version-1', page: 2,
    extractionMethod: 'human_review', reviewStatus: 'accepted', value: value('Schedule and wording'),
    sourceDigest: 'b'.repeat(64), recordedBy: 'adult-parameters',
  });
  await coverage.setResolution({ parameterRecordId: held.id, state: 'proven', observationId: reviewed.id, updatedBy: 'adult-parameters' });
  const prior = await resolution(services, 'a.policy_type');
  await coverage.appendObservation({
    parameterRecordId: prior.id, sourceId: 'page-other', documentId: 'document-other', version: 'version-1', page: 2,
    extractionMethod: 'document_extraction', value: value('Floater'), sourceDigest: 'b'.repeat(64), recordedBy: 'earlier-structuring',
  });
  const result = await structuring.commitStructuring(input(services, {
    decisions: [
      decision('a.document_set', 'extracted_unverified', [{ value: value('Schedule only'), page: 2 }]),
      decision('a.policy_type', 'extracted_unverified', [{ value: value('Individual'), page: 2 }]),
    ],
    proposals: [],
  }));
  assert.equal(result.skippedKeys, 1);
  assert.equal(result.conflicting, 1);
  assert.equal((await resolution(services, 'a.document_set')).resolutionState, 'proven', 'human-proven value untouched');
  assert.equal((await resolution(services, 'a.policy_type')).resolutionState, 'conflicting');
});

async function assertBothStoresEmpty(database, label) {
  assert.equal(await liveObservations(database), 0, `${label}: no unredacted structuring observations`);
  assert.equal(await liveProposals(database), 0, `${label}: no unredacted proposals`);
  assert.equal(await count(database, 'SELECT count(*) AS count FROM proposed_parameters WHERE label IS NOT NULL OR value_json IS NOT NULL'), 0);
  assert.equal(await count(database, 'SELECT count(*) AS count FROM policy_structuring_runs WHERE erased_at IS NULL'), 0, `${label}: runs erased`);
}

test('consent revocation (document grant) empties both stores with a counts-only audit', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  await structuring.commitStructuring(input(services));
  assert.equal(await liveObservations(database), 3);
  assert.equal(await liveProposals(database), 2);
  await services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  await assertBothStoresEmpty(database, 'revocation');
  assert.equal((await database.prepare('SELECT DISTINCT redaction_reason_code AS reason FROM proposed_parameters').get()).reason, 'consent_revoked',
    'the repository path ran before the lifecycle safety net');
  const [event] = await auditFor(database, 'policy_structuring.erased');
  const payload = JSON.parse(event.event_payload_json);
  assert.equal(payload.reasonCode, 'consent_revoked');
  assert.equal(payload.proposals, 2);
  assert.equal(payload.runs, 1);
  assert.equal(JSON.stringify(event).includes('Synthetic benefit'), false);
  const { id: structuringRunId } = await structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  assert.deepEqual(await structuring.listProposals({ householdId: household, documentId: document, structuringRunId }), []);
  assert.ok((await structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document })).erasedAt);
});

test('run-scoped erasure (coverage or run grant path) empties both stores while the document stays active', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  await structuring.commitStructuring(input(services));
  const counts = await services.consents.eraseDerivedRunData({
    householdId: household, runIds: [run], reason: 'source_consent_not_current', resourceType: 'workflow_run', resourceId: run,
  });
  assert.equal(counts.structuringProposals, 2);
  assert.equal(counts.structuringRuns, 1);
  assert.equal((await database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(document)).lifecycle_state, 'active');
  await assertBothStoresEmpty(database, 'run erasure');
  assert.equal((await database.prepare('SELECT DISTINCT redaction_reason_code AS reason FROM proposed_parameters').get()).reason, 'source_consent_not_current');
  // Erased identity is free again: a fresh commit is not a replay.
  await database.prepare("UPDATE workflow_runs SET status = 'queued' WHERE id = ?").run(run);
  assert.equal((await structuring.commitStructuring(input(services, { decisions: [] }))).replayed, false);

  // Consent-grant path: a run authorised by its own grant.
  await database.prepare(`INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
    input_json, consent_grant_id, created_at) VALUES ('run-granted', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture',
    'queued', ?, '{}', 'consent-parameters', ?)`).run('d'.repeat(64), at);
  await services.coverageParameters.initializeRunParameters({ workflowRunId: 'run-granted', registryVersion: v1, ...parameterScope({ workflowRunId: 'run-granted' }), updatedBy: 'test' });
  const granted = await structuring.commitStructuring(input(services, { workflowRunId: 'run-granted' }));
  assert.equal(granted.observations, 3);
  assert.ok(await liveObservations(database) >= 3);
  await services.consents.eraseDerivedRunData({ householdId: household, consentGrantId: 'consent-parameters', resourceType: 'consent_grant', resourceId: 'consent-parameters' });
  assert.equal(await count(database, `SELECT count(*) AS count FROM proposed_parameters proposal JOIN policy_structuring_runs structuring
    ON structuring.id = proposal.structuring_run_id WHERE structuring.workflow_run_id = 'run-granted' AND proposal.redacted_at IS NULL`), 0);
  assert.equal(await count(database, `SELECT count(*) AS count FROM coverage_parameter_observations observation JOIN coverage_parameter_records record
    ON record.id = observation.parameter_record_id WHERE record.workflow_run_id = 'run-granted' AND observation.redacted_at IS NULL`), 0);
  assert.equal(await count(database, "SELECT count(*) AS count FROM policy_structuring_runs WHERE workflow_run_id = 'run-granted' AND erased_at IS NULL"), 0);
  assert.equal(await liveProposals(database), 2, 'the unrelated run keeps its proposals');
});

test('a document erasure request empties both stores, and the trigger is a safety net on its own', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  await structuring.commitStructuring(input(services));
  await services.documents.requestDeletion(document, { actorAdultId: 'adult-parameters' });
  await assertBothStoresEmpty(database, 'document deletion');
  assert.equal((await auditFor(database, 'policy_structuring.erased')).length, 1);

  // Safety net alone: a raw lifecycle change with no repository path.
  await structuring.commitStructuring(input(services, { documentId: 'document-other', decisions: [], proposals: [proposal('synthetic_other')] }));
  assert.equal(await liveProposals(database), 1);
  await database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-other'").run();
  await assertBothStoresEmpty(database, 'trigger');
  assert.equal((await database.prepare("SELECT erasure_reason_code FROM policy_structuring_runs WHERE document_id = 'document-other'").get()).erasure_reason_code, 'document_erasure');
});

const CHECK_VIOLATION = { sqlstate: '23514' };
const UNIQUE_VIOLATION = { sqlstate: '23505' };

test('database guards: household, page, active document, initial state, append only, redaction carve-out', pgOptions, async t => {
  const { database, services, structuring } = await open(t);
  const { structuringRunId } = await structuring.commitStructuring(input(services, { decisions: [] }));
  const insertRun = (overrides = {}) => {
    const row = { id: 'sr-x', household_id: household, case_id: 'case-parameters', workflow_run_id: run, document_id: document,
      source_version: 'version-1', pipeline_version: 'guard-test/v1', counts_json: '{}', created_at: at, erased_at: null, erasure_reason_code: null, ...overrides };
    return database.prepare(`INSERT INTO policy_structuring_runs (id, household_id, case_id, workflow_run_id, document_id, source_version,
      pipeline_version, counts_json, created_at, erased_at, erasure_reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...Object.values(row));
  };
  const runScope = { message: /must match its workflow case, household and document/ };
  await assertDbError(insertRun({ household_id: 'household-other' }), runScope);
  await assertDbError(insertRun({ document_id: 'document-foreign' }), runScope);
  await assertDbError(insertRun({ workflow_run_id: 'run-foreign' }), runScope);
  await assertDbError(insertRun({ erased_at: at, erasure_reason_code: 'consent_revoked' }), { message: /cannot be inserted erased/ });
  await assertDbError(insertRun({ pipeline_version: 'Bad Version' }), CHECK_VIOLATION);
  await assertDbError(insertRun({ counts_json: '[1]' }), CHECK_VIOLATION);

  let sequence = 0;
  const insertProposal = async (overrides = {}) => {
    sequence += 1;
    const row = { id: `pp-${sequence}`, structuring_run_id: structuringRunId, household_id: household, document_id: document,
      source_page_id: 'page-parameters', registry_version: v1, proposed_key: 'synthetic_key', category: 'unassigned', label: 'Label',
      value_json: '{"text":"x"}', page: 2, block_index: 0, status: 'pending_review', created_at: at, redacted_at: null, redaction_reason_code: null, ...overrides };
    await database.prepare(`INSERT INTO proposed_parameters (id, structuring_run_id, household_id, document_id, source_page_id, registry_version,
      proposed_key, category, label, value_json, page, block_index, status, created_at, redacted_at, redaction_reason_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(row));
    return row.id;
  };
  const scope = { message: /must match its structuring run, household and document page/ };
  await assertDbError(insertProposal({ household_id: 'household-other' }), scope);
  await assertDbError(insertProposal({ source_page_id: 'page-other' }), scope);
  await assertDbError(insertProposal({ source_page_id: 'page-foreign' }), scope);
  await assertDbError(insertProposal({ page: 3 }), scope);
  await assertDbError(insertProposal({ status: 'accepted' }), { message: /inserted pending review and unredacted/ });
  await assertDbError(insertProposal({ label: null, value_json: null, redacted_at: at, redaction_reason_code: 'consent_revoked' }), { message: /inserted pending review and unredacted/ });
  await assertDbError(insertProposal({ proposed_key: 'd.room_rent_limit' }), CHECK_VIOLATION);
  await assertDbError(insertProposal({ category: 'z' }), CHECK_VIOLATION);
  await assertDbError(insertProposal({ label: null }), CHECK_VIOLATION);
  const kept = await insertProposal();
  const other = await insertProposal();

  const appendOnly = { message: /proposed parameters are append only/ };
  const update = (sql, id = kept) => database.prepare(`UPDATE proposed_parameters SET ${sql} WHERE id = ?`).run(id);
  await assertDbError(update("label = 'changed'"), appendOnly);
  await assertDbError(update("household_id = 'household-other', status = 'accepted'"), appendOnly);
  await assertDbError(update(`label = NULL, value_json = NULL, redacted_at = '${at}', redaction_reason_code = 'consent_revoked', status = 'accepted'`), appendOnly);
  await assertDbError(update(`label = NULL, value_json = '{}', redacted_at = '${at}', redaction_reason_code = 'consent_revoked'`), { message: /append only|check constraint/ });
  await assertDbError(update(`label = NULL, value_json = NULL, redacted_at = '2026-10-09T10:00:00Z', redaction_reason_code = 'consent_revoked'`), CHECK_VIOLATION);
  await update("status = 'accepted'");
  await update(`label = NULL, value_json = NULL, redacted_at = '${at}', redaction_reason_code = 'consent_revoked'`);
  // A redacted row is final.
  await assertDbError(update("status = 'rejected'"), appendOnly);
  await assertDbError(update(`redacted_at = '2026-10-10T10:00:00.000Z'`), appendOnly);
  await assertDbError(database.prepare('DELETE FROM proposed_parameters WHERE id = ?').run(other), appendOnly);

  const runAppendOnly = { message: /policy structuring runs are append only/ };
  await assertDbError(database.prepare("UPDATE policy_structuring_runs SET counts_json = '{}' WHERE id = ?").run(structuringRunId), runAppendOnly);
  await assertDbError(database.prepare('DELETE FROM policy_structuring_runs WHERE id = ?').run(structuringRunId), runAppendOnly);

  await database.prepare("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = ?").run(document);
  await assertDbError(insertProposal(), { message: /proposed parameters require an active document/ });
  await assertDbError(insertRun({ pipeline_version: 'guard-test/v2' }), { message: /policy structuring requires an active document/ });
  await database.prepare("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = ?").run(document);
  await insertProposal();
  await insertRun({ pipeline_version: 'guard-test/v2' });
  await assertDbError(insertRun({ id: 'sr-y', pipeline_version: 'guard-test/v2' }), UNIQUE_VIOLATION);
});
