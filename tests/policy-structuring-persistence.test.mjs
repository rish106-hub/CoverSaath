import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Storage for policy document structuring (SQLite migration 011, PostgreSQL 007) and its
// repository. Synthetic data only: every value below is invented.

const household = 'household-parameters';
const run = 'run-parameters';
const document = 'document-parameters';
const v1 = 'policy-parameters/v1';
const pipelineVersion = 'policy-structuring-extractor/v1';
const notFound = { code: 'STRUCTURING_SCOPE_NOT_FOUND' };

function seedOtherHousehold(database) {
  database.exec(`
    INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-other', 'Other', '${at}', '${at}');
    INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-other', 'Other', 'active', '${at}', '${at}');
    INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
      VALUES ('role-other', 'household-other', 'adult-other', 'owner', 'active', '${at}');
    INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
      VALUES ('member-other', 'household-other', 'adult-other', 'Other', 'adult', '${at}', '${at}');
    INSERT INTO consent_grants (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
      VALUES ('consent-other', 'household-other', 'adult-other', 'knowvia-local', 'document_processing', 'v1', 'fixture', '${at}', '${at}');
    INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
      VALUES ('case-other', 'household-other', 'member-other', 'adult-other', 'renewal', 'processing', '${at}', '${at}');
    INSERT INTO document_uploads (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename,
      storage_path, content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
      VALUES ('document-foreign', 'household-other', 'case-other', 'adult-other', 'consent-other', 'policy_schedule', 'fixture.pdf',
      'fixture/document-foreign', '${'9'.repeat(64)}', 'application/pdf', 100, 'clean', 'encrypted_local', 'active', '${at}', 'version-1');
    INSERT INTO source_pages (id, document_upload_id, page_number, source_version, page_sha256, extracted_text, extraction_status, created_at)
      VALUES ('page-foreign', 'document-foreign', 2, 'version-1', '${'8'.repeat(64)}', 'Synthetic clause', 'extracted', '${at}');
    INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, created_at)
      VALUES ('run-foreign', 'case-other', 'coverage-reconstruction', 'v2', 'fixture', 'queued', '${'d'.repeat(64)}', '{}', '${at}');
  `);
}

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  seedOtherHousehold(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: v1, ...parameterScope(), updatedBy: 'test' });
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

const count = (database, sql, ...params) => database.prepare(sql).get(...params).count;
const liveObservations = database => count(database, `SELECT count(*) AS count FROM coverage_parameter_observations
  WHERE redacted_at IS NULL AND recorded_by = 'policy-structuring'`);
const liveProposals = database => count(database, 'SELECT count(*) AS count FROM proposed_parameters WHERE redacted_at IS NULL');
const structuringRuns = database => count(database, 'SELECT count(*) AS count FROM policy_structuring_runs');
const resolution = (services, key) => services.coverageParameters.listForRun(run).find(record => record.parameterKey === key);
const auditFor = (database, action) => database.prepare('SELECT * FROM audit_events WHERE action = ? ORDER BY id').all(action);

test('commit records observations, resolutions and proposals in one transaction with counts only', t => {
  const { database, services, structuring } = open(t);
  const result = structuring.commitStructuring(input(services));
  assert.equal(result.replayed, false);
  assert.deepEqual({ ...result, structuringRunId: undefined }, {
    replayed: false, structuringRunId: undefined, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 2, proposals: 2,
  });
  assert.equal(resolution(services, 'a.policy_type').resolutionState, 'extracted_unverified');
  assert.equal(resolution(services, 'a.policy_type').authority, 'model');
  assert.deepEqual(resolution(services, 'a.policy_type').resolvedValue, { ...value('Individual'), blockIndex: 1 });
  assert.equal(resolution(services, 'a.product_uin_and_version').resolutionState, 'conflicting');
  assert.equal(resolution(services, 'a.product_uin_and_version').resolutionReasonCode, 'model_observations_conflict');
  assert.equal(resolution(services, 'b.moratorium_date').resolutionState, 'unknown', 'model extraction not permitted: skipped');
  const observation = database.prepare("SELECT * FROM coverage_parameter_observations WHERE recorded_by = 'policy-structuring' LIMIT 1").get();
  assert.equal(observation.extraction_method, 'document_extraction');
  assert.equal(observation.review_status, 'not_reviewed');
  assert.equal(observation.source_id, 'page-parameters');
  assert.equal(observation.source_digest, 'b'.repeat(64), 'the digest is the cited page digest');

  const proposals = structuring.listProposals({ householdId: household, documentId: document, structuringRunId: result.structuringRunId });
  assert.deepEqual(proposals.map(item => [item.proposedKey, item.status, item.page, item.blockIndex]), [
    ['synthetic_daily_cash', 'pending_review', 2, 3], ['synthetic_wellness_credit', 'pending_review', 2, 5],
  ]);
  assert.equal(proposals[0].value.evidenceQuote, 'Synthetic benefit Rs. 2,000 per day');
  assert.equal(proposals[0].sourcePageId, 'page-parameters');

  const stored = structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  assert.equal(stored.id, result.structuringRunId);
  assert.deepEqual(stored.counts, { observations: 3, parameters: 2, conflicting: 1, skippedKeys: 2, proposals: 2 });
  assert.equal(stored.erasedAt, null);
  assert.equal(structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: 'document-other' }), null);

  const [event] = auditFor(database, 'policy_structuring.committed');
  assert.deepEqual(JSON.parse(event.event_payload_json), {
    structuringRunId: result.structuringRunId, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 2, proposals: 2,
  });
  const audits = JSON.stringify(database.prepare('SELECT * FROM audit_events').all());
  for (const secret of ['Individual', 'SYN-UIN', 'Rs. 2,000', 'Synthetic benefit']) assert.equal(audits.includes(secret), false, `audit holds no ${secret}`);
});

test('a replayed commit returns the stored counts and writes nothing new', t => {
  const { database, services, structuring } = open(t);
  const first = structuring.commitStructuring(input(services));
  const before = {
    observations: count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'),
    proposals: count(database, 'SELECT count(*) AS count FROM proposed_parameters'),
    audits: count(database, 'SELECT count(*) AS count FROM audit_events'),
  };
  const replay = structuring.commitStructuring(input(services));
  assert.deepEqual(replay, { ...first, replayed: true });
  assert.deepEqual({
    observations: count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'),
    proposals: count(database, 'SELECT count(*) AS count FROM proposed_parameters'),
    audits: count(database, 'SELECT count(*) AS count FROM audit_events'),
  }, before);
  assert.equal(structuringRuns(database), 1);
  // A different pipeline version is a new identity.
  assert.equal(structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring-extractor/v2', decisions: [] })).replayed, false);
  assert.equal(structuringRuns(database), 2);
});

// Run-scoped proposals defect: proposals were listed by document only, so a second analysis run on the
// same document showed the first run's proposals as its own.
function seedSecondRun(database, services) {
  database.prepare(`INSERT INTO workflow_runs
    (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, input_json, created_at)
    VALUES ('run-second', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture', 'queued', ?, '{}', ?)`).run('e'.repeat(64), at);
  services.coverageParameters.initializeRunParameters({ ...parameterScope(), workflowRunId: 'run-second', registryVersion: v1, updatedBy: 'test' });
}

test('listProposals returns only the proposals of the given structuring run (run-scoped proposals defect)', t => {
  const { database, services, structuring } = open(t);
  seedSecondRun(database, services);
  const first = structuring.commitStructuring(input(services, { decisions: [] }));
  const second = structuring.commitStructuring(input(services, {
    workflowRunId: 'run-second', decisions: [], proposals: [proposal('synthetic_second_run_benefit')],
  }));
  const keys = structuringRunId => structuring.listProposals({ householdId: household, documentId: document, structuringRunId })
    .map(item => [item.proposedKey, item.structuringRunId]);
  assert.deepEqual(keys(first.structuringRunId), [
    ['synthetic_daily_cash', first.structuringRunId], ['synthetic_wellness_credit', first.structuringRunId],
  ]);
  assert.deepEqual(keys(second.structuringRunId), [['synthetic_second_run_benefit', second.structuringRunId]]);
  // Erase the older run and structure again: only the newest run's proposals are listed.
  structuring.eraseDerived({ householdId: household, workflowRunIds: [run], reasonCode: 'data_subject_request' });
  const again = structuring.commitStructuring(input(services, { decisions: [], proposals: [proposal('synthetic_rerun_benefit')] }));
  assert.deepEqual(keys(again.structuringRunId), [['synthetic_rerun_benefit', again.structuringRunId]]);
  assert.deepEqual(keys(first.structuringRunId), []);

  const invalidInput = { code: 'STRUCTURING_INPUT_INVALID' };
  assert.throws(() => structuring.listProposals({ householdId: household, documentId: document }), invalidInput, 'run id is required');
  assert.throws(() => structuring.listProposals({ householdId: household, documentId: document, structuringRunId: "x' OR 1=1" }), invalidInput);
  assert.throws(() => structuring.listProposals({ householdId: 'household-other', documentId: document, structuringRunId: first.structuringRunId }), notFound);
});

test('the review result lists only the proposals of its own run and carries provenance', t => {
  const { database, services, structuring } = open(t);
  seedSecondRun(database, services);
  const first = structuring.commitStructuring(input(services, { decisions: [] }));
  structuring.commitStructuring(input(services, { workflowRunId: 'run-second', decisions: [], proposals: [proposal('synthetic_second_run_benefit')] }));
  const service = createPolicyStructuringService({ services, loadKnownIdentifiers: async () => [], createModelCall: () => () => {}, env: {} });
  const owned = { id: document, householdId: household, caseId: 'case-parameters' };
  const review = service.result({ document: owned, workflowRunId: run });
  assert.equal(review.structuringRun.id, first.structuringRunId);
  assert.equal(review.structuringRun.sourceVersion, 'version-1');
  assert.deepEqual(review.proposals.map(item => item.proposedKey), ['synthetic_daily_cash', 'synthetic_wellness_credit']);
  for (const item of review.proposals) {
    assert.deepEqual([item.structuringRunId, item.pipelineVersion, item.registryVersion, item.sourceVersion],
      [first.structuringRunId, pipelineVersion, v1, 'version-1']);
  }
  assert.throws(() => service.result({ document: owned, workflowRunId: undefined }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => service.result({ document: { ...owned, householdId: 'household-other' }, workflowRunId: run }), notFound);
});

test('every read and write is household-scoped with one coded error', t => {
  const { database, services, structuring } = open(t);
  structuring.commitStructuring(input(services));
  let consentCalls = 0;
  const consentCheck = () => { consentCalls += 1; };
  const before = { obs: liveObservations(database), proposals: liveProposals(database), runs: structuringRuns(database) };
  for (const overrides of [
    { householdId: 'household-other' },
    { documentId: 'document-foreign' },
    { workflowRunId: 'run-foreign' },
    { householdId: 'household-other', workflowRunId: 'run-foreign' },
    { workflowRunId: 'run-missing' },
  ]) {
    assert.throws(() => structuring.commitStructuring(input(services, { ...overrides, consentCheck })), notFound, JSON.stringify(overrides));
  }
  assert.equal(consentCalls, 0, 'scope is checked before consent');
  assert.deepEqual({ obs: liveObservations(database), proposals: liveProposals(database), runs: structuringRuns(database) }, before);
  const { id: structuringRunId } = structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  assert.throws(() => structuring.listProposals({ householdId: 'household-other', documentId: document, structuringRunId }), notFound);
  assert.throws(() => structuring.listProposals({ householdId: household, documentId: 'document-foreign', structuringRunId }), notFound);
  assert.throws(() => structuring.listProposals({ householdId: household, documentId: 'document-missing', structuringRunId }), notFound);
  assert.throws(() => structuring.getStructuringRun({ householdId: 'household-other', workflowRunId: run, documentId: document }), notFound);
  assert.throws(() => structuring.getStructuringRun({ householdId: household, workflowRunId: 'run-foreign', documentId: document }), notFound);
  assert.throws(() => structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: 'document-foreign' }), notFound);
  // An inactive document is out of scope for writes, with the same error.
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-other'").run();
  assert.throws(() => structuring.commitStructuring(input(services, { documentId: 'document-other', consentCheck })), notFound);
});

test('consent is checked inside the transaction and a failing check writes nothing', t => {
  const { database, services, structuring } = open(t);
  let insideTransaction = null;
  structuring.commitStructuring(input(services, {
    decisions: [], proposals: [proposal('synthetic_first')],
    consentCheck: () => { insideTransaction = database.isTransaction; },
  }));
  assert.equal(insideTransaction, true);

  const before = { obs: liveObservations(database), proposals: liveProposals(database), runs: structuringRuns(database), audits: count(database, 'SELECT count(*) AS count FROM audit_events') };
  const denied = Object.assign(new Error('Active subject-scoped consent is required.'), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: () => { throw denied; } })), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: () => Promise.resolve() })), { code: 'STRUCTURING_INPUT_INVALID' });
  assert.throws(() => structuring.commitStructuring(input(services, { pipelineVersion: 'policy-structuring/other', consentCheck: undefined })), { code: 'STRUCTURING_INPUT_INVALID' });
  assert.deepEqual({ obs: liveObservations(database), proposals: liveProposals(database), runs: structuringRuns(database), audits: count(database, 'SELECT count(*) AS count FROM audit_events') }, before);
  assert.equal(resolution(services, 'a.policy_type').resolutionState, 'unknown');
  // Revoked consent through the real check.
  services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  assert.throws(() => structuring.commitStructuring(input(services, { documentId: 'document-other' })), error => ['CONSENT_REQUIRED', 'STRUCTURING_SCOPE_NOT_FOUND'].includes(error.code));
});

test('a failure part-way through rolls back every write', t => {
  const { database, services, structuring } = open(t);
  // Invalid second proposal: rejected before anything is written.
  assert.throws(() => structuring.commitStructuring(input(services, {
    proposals: [proposal('synthetic_ok'), proposal('Bad Key')],
  })), { code: 'STRUCTURING_INPUT_INVALID' });
  // A storage failure on the second proposal insert, after observations and the run row exist.
  database.exec(`CREATE TEMP TRIGGER fail_second_proposal BEFORE INSERT ON main.proposed_parameters
    WHEN (SELECT count(*) FROM main.proposed_parameters) >= 1
    BEGIN SELECT RAISE(ABORT, 'synthetic storage failure'); END;`);
  assert.throws(() => structuring.commitStructuring(input(services)), error => {
    assert.equal(error.code, 'STRUCTURING_COMMIT_FAILED');
    assert.equal(error.message.includes('synthetic storage failure'), false, 'driver detail is not returned');
    return true;
  });
  assert.equal(count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'), 0);
  assert.equal(count(database, 'SELECT count(*) AS count FROM proposed_parameters'), 0);
  assert.equal(structuringRuns(database), 0);
  assert.equal(auditFor(database, 'policy_structuring.committed').length, 0);
  assert.equal(resolution(services, 'a.policy_type').resolutionState, 'unknown');
  assert.equal(resolution(services, 'a.product_uin_and_version').resolutionState, 'unknown');
  database.exec('DROP TRIGGER temp.fail_second_proposal');
  // A cited page that does not exist also rolls back.
  assert.throws(() => structuring.commitStructuring(input(services, { proposals: [proposal('synthetic_ok', { page: 9 })] })), { code: 'STRUCTURING_PAGE_NOT_FOUND' });
  assert.equal(count(database, 'SELECT count(*) AS count FROM coverage_parameter_observations'), 0);
  assert.equal(structuring.commitStructuring(input(services)).replayed, false, 'the same commit succeeds afterwards');
});

test('the model authority ceiling holds: no proven or calculated, conflicting needs two observations', t => {
  const { database, services, structuring } = open(t);
  for (const state of ['proven', 'calculated', 'reported', 'dynamic', 'unknown']) {
    assert.throws(() => structuring.commitStructuring(input(services, {
      decisions: [decision('a.policy_type', state, [{ value: value('Individual'), page: 2 }], 'model_extracted_unverified')],
    })), { code: 'STRUCTURING_DECISION_INVALID' }, state);
  }
  assert.throws(() => structuring.commitStructuring(input(services, {
    decisions: [decision('a.policy_type', 'conflicting', [{ value: value('Individual'), page: 2 }])],
  })), { code: 'STRUCTURING_DECISION_INVALID' });
  assert.throws(() => structuring.commitStructuring(input(services, {
    decisions: [decision('a.policy_type', 'extracted_unverified', [{ value: value('A'), page: 2 }]), decision('a.policy_type', 'extracted_unverified', [{ value: value('B'), page: 2 }])],
  })), { code: 'STRUCTURING_DECISION_INVALID' }, 'a key appears once');
  assert.equal(liveObservations(database), 0);
  for (const row of database.prepare("SELECT resolution_state FROM coverage_parameter_resolutions WHERE transition_authority = 'model'").all()) {
    assert.ok(['extracted_unverified', 'conflicting', 'unknown'].includes(row.resolution_state));
  }
});

test('keys held by established authority are skipped and counted; a disagreeing prior value makes a conflict', t => {
  const { services, structuring } = open(t);
  const coverage = services.coverageParameters;
  const held = resolution(services, 'a.document_set');
  const reviewed = coverage.appendObservation({
    parameterRecordId: held.id, sourceId: 'page-parameters', documentId: document, version: 'version-1', page: 2,
    extractionMethod: 'human_review', reviewStatus: 'accepted', value: value('Schedule and wording'),
    sourceDigest: 'b'.repeat(64), recordedBy: 'adult-parameters',
  });
  coverage.setResolution({ parameterRecordId: held.id, state: 'proven', observationId: reviewed.id, updatedBy: 'adult-parameters' });
  const prior = resolution(services, 'a.policy_type');
  coverage.appendObservation({
    parameterRecordId: prior.id, sourceId: 'page-other', documentId: 'document-other', version: 'version-1', page: 2,
    extractionMethod: 'document_extraction', value: value('Floater'), sourceDigest: 'b'.repeat(64), recordedBy: 'earlier-structuring',
  });
  const result = structuring.commitStructuring(input(services, {
    decisions: [
      decision('a.document_set', 'extracted_unverified', [{ value: value('Schedule only'), page: 2 }]),
      decision('a.policy_type', 'extracted_unverified', [{ value: value('Individual'), page: 2 }]),
    ],
    proposals: [],
  }));
  assert.equal(result.skippedKeys, 1);
  assert.equal(result.conflicting, 1);
  assert.equal(resolution(services, 'a.document_set').resolutionState, 'proven', 'human-proven value untouched');
  assert.equal(resolution(services, 'a.policy_type').resolutionState, 'conflicting');
});

function assertBothStoresEmpty(database, label) {
  assert.equal(liveObservations(database), 0, `${label}: no unredacted structuring observations`);
  assert.equal(liveProposals(database), 0, `${label}: no unredacted proposals`);
  assert.equal(count(database, 'SELECT count(*) AS count FROM proposed_parameters WHERE label IS NOT NULL OR value_json IS NOT NULL'), 0);
  assert.equal(count(database, 'SELECT count(*) AS count FROM policy_structuring_runs WHERE erased_at IS NULL'), 0, `${label}: runs erased`);
}

test('consent revocation (document grant) empties both stores with a counts-only audit', t => {
  const { database, services, structuring } = open(t);
  structuring.commitStructuring(input(services));
  assert.equal(liveObservations(database), 3);
  assert.equal(liveProposals(database), 2);
  services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
  assertBothStoresEmpty(database, 'revocation');
  assert.equal(database.prepare('SELECT DISTINCT redaction_reason_code AS reason FROM proposed_parameters').get().reason, 'consent_revoked',
    'the repository path ran before the lifecycle safety net');
  const [event] = auditFor(database, 'policy_structuring.erased');
  const payload = JSON.parse(event.event_payload_json);
  assert.equal(payload.reasonCode, 'consent_revoked');
  assert.equal(payload.proposals, 2);
  assert.equal(payload.runs, 1);
  assert.equal(JSON.stringify(event).includes('Synthetic benefit'), false);
  const { id: structuringRunId } = structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  assert.deepEqual(structuring.listProposals({ householdId: household, documentId: document, structuringRunId }), []);
  assert.ok(structuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document }).erasedAt);
});

test('run-scoped erasure (coverage or run grant path) empties both stores while the document stays active', t => {
  const { database, services, structuring } = open(t);
  structuring.commitStructuring(input(services));
  database.exec('BEGIN IMMEDIATE');
  const counts = services.consents.eraseDerivedRunData({
    householdId: household, runIds: [run], reason: 'source_consent_not_current', resourceType: 'workflow_run', resourceId: run,
  });
  database.exec('COMMIT');
  assert.equal(counts.structuringProposals, 2);
  assert.equal(counts.structuringRuns, 1);
  assert.equal(database.prepare('SELECT lifecycle_state FROM document_uploads WHERE id = ?').get(document).lifecycle_state, 'active');
  assertBothStoresEmpty(database, 'run erasure');
  assert.equal(database.prepare('SELECT DISTINCT redaction_reason_code AS reason FROM proposed_parameters').get().reason, 'source_consent_not_current');
  // Erased identity is free again: a fresh commit is not a replay.
  database.prepare("UPDATE workflow_runs SET status = 'queued' WHERE id = ?").run(run);
  assert.equal(structuring.commitStructuring(input(services, { decisions: [] })).replayed, false);

  // Consent-grant path: a run authorised by its own grant.
  database.prepare(`INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
    input_json, consent_grant_id, created_at) VALUES ('run-granted', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture',
    'queued', ?, '{}', 'consent-parameters', ?)`).run('d'.repeat(64), at);
  services.coverageParameters.initializeRunParameters({ workflowRunId: 'run-granted', registryVersion: v1, ...parameterScope({ workflowRunId: 'run-granted' }), updatedBy: 'test' });
  const granted = structuring.commitStructuring(input(services, { workflowRunId: 'run-granted' }));
  assert.equal(granted.observations, 3);
  assert.ok(liveObservations(database) >= 3);
  database.exec('BEGIN IMMEDIATE');
  services.consents.eraseDerivedRunData({ householdId: household, consentGrantId: 'consent-parameters', resourceType: 'consent_grant', resourceId: 'consent-parameters' });
  database.exec('COMMIT');
  assert.equal(count(database, `SELECT count(*) AS count FROM proposed_parameters proposal JOIN policy_structuring_runs structuring
    ON structuring.id = proposal.structuring_run_id WHERE structuring.workflow_run_id = 'run-granted' AND proposal.redacted_at IS NULL`), 0);
  assert.equal(count(database, `SELECT count(*) AS count FROM coverage_parameter_observations observation JOIN coverage_parameter_records record
    ON record.id = observation.parameter_record_id WHERE record.workflow_run_id = 'run-granted' AND observation.redacted_at IS NULL`), 0);
  assert.equal(count(database, "SELECT count(*) AS count FROM policy_structuring_runs WHERE workflow_run_id = 'run-granted' AND erased_at IS NULL"), 0);
  assert.equal(liveProposals(database), 2, 'the unrelated run keeps its proposals');
});

test('a document erasure request empties both stores, and the trigger is a safety net on its own', t => {
  const { database, services, structuring } = open(t);
  structuring.commitStructuring(input(services));
  services.documents.requestDeletion(document, { actorAdultId: 'adult-parameters' });
  assertBothStoresEmpty(database, 'document deletion');
  assert.equal(auditFor(database, 'policy_structuring.erased').length, 1);

  // Safety net alone: a raw lifecycle change with no repository path.
  structuring.commitStructuring(input(services, { documentId: 'document-other', decisions: [], proposals: [proposal('synthetic_other')] }));
  assert.equal(liveProposals(database), 1);
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-other'").run();
  assertBothStoresEmpty(database, 'trigger');
  assert.equal(database.prepare("SELECT erasure_reason_code FROM policy_structuring_runs WHERE document_id = 'document-other'").get().erasure_reason_code, 'document_erasure');
});

test('database guards: household, page, active document, initial state, append only, redaction carve-out', t => {
  const { database, services, structuring } = open(t);
  const { structuringRunId } = structuring.commitStructuring(input(services, { decisions: [] }));
  const insertRun = (overrides = {}) => {
    const row = { id: 'sr-x', household_id: household, case_id: 'case-parameters', workflow_run_id: run, document_id: document,
      source_version: 'version-1', pipeline_version: 'guard-test/v1', counts_json: '{}', created_at: at, erased_at: null, erasure_reason_code: null, ...overrides };
    database.prepare(`INSERT INTO policy_structuring_runs (id, household_id, case_id, workflow_run_id, document_id, source_version,
      pipeline_version, counts_json, created_at, erased_at, erasure_reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(...Object.values(row));
  };
  assert.throws(() => insertRun({ household_id: 'household-other' }), /must match its workflow case, household and document/);
  assert.throws(() => insertRun({ document_id: 'document-foreign' }), /must match its workflow case, household and document/);
  assert.throws(() => insertRun({ workflow_run_id: 'run-foreign' }), /must match its workflow case, household and document/);
  assert.throws(() => insertRun({ erased_at: at, erasure_reason_code: 'consent_revoked' }), /cannot be inserted erased/);
  assert.throws(() => insertRun({ pipeline_version: 'Bad Version' }), /CHECK constraint failed/);
  assert.throws(() => insertRun({ counts_json: '[1]' }), /CHECK constraint failed/);

  const insertProposal = (overrides = {}) => {
    const row = { id: `pp-${Math.random()}`, structuring_run_id: structuringRunId, household_id: household, document_id: document,
      source_page_id: 'page-parameters', registry_version: v1, proposed_key: 'synthetic_key', category: 'unassigned', label: 'Label',
      value_json: '{"text":"x"}', page: 2, block_index: 0, status: 'pending_review', created_at: at, redacted_at: null, redaction_reason_code: null, ...overrides };
    database.prepare(`INSERT INTO proposed_parameters (id, structuring_run_id, household_id, document_id, source_page_id, registry_version,
      proposed_key, category, label, value_json, page, block_index, status, created_at, redacted_at, redaction_reason_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...Object.values(row));
    return row.id;
  };
  const scope = /must match its structuring run, household and document page/;
  assert.throws(() => insertProposal({ household_id: 'household-other' }), scope);
  assert.throws(() => insertProposal({ source_page_id: 'page-other' }), scope);
  assert.throws(() => insertProposal({ source_page_id: 'page-foreign' }), scope);
  assert.throws(() => insertProposal({ page: 3 }), scope);
  assert.throws(() => insertProposal({ status: 'accepted' }), /inserted pending review and unredacted/);
  assert.throws(() => insertProposal({ label: null, value_json: null, redacted_at: at, redaction_reason_code: 'consent_revoked' }), /inserted pending review and unredacted/);
  assert.throws(() => insertProposal({ proposed_key: 'd.room_rent_limit' }), /CHECK constraint failed/);
  assert.throws(() => insertProposal({ category: 'z' }), /CHECK constraint failed/);
  assert.throws(() => insertProposal({ label: null }), /CHECK constraint failed/);
  const kept = insertProposal();
  const other = insertProposal();

  const appendOnly = /proposed parameters are append only/;
  const update = (sql, id = kept) => database.prepare(`UPDATE proposed_parameters SET ${sql} WHERE id = ?`).run(id);
  assert.throws(() => update("label = 'changed'"), appendOnly);
  assert.throws(() => update("household_id = 'household-other', status = 'accepted'"), appendOnly);
  assert.throws(() => update(`label = NULL, value_json = NULL, redacted_at = '${at}', redaction_reason_code = 'consent_revoked', status = 'accepted'`), appendOnly);
  assert.throws(() => update(`label = NULL, value_json = '{}', redacted_at = '${at}', redaction_reason_code = 'consent_revoked'`), /append only|CHECK/);
  assert.throws(() => update(`label = NULL, value_json = NULL, redacted_at = '2026-10-09T10:00:00Z', redaction_reason_code = 'consent_revoked'`), /CHECK constraint failed/);
  update("status = 'accepted'");
  update(`label = NULL, value_json = NULL, redacted_at = '${at}', redaction_reason_code = 'consent_revoked'`);
  assert.throws(() => update("status = 'rejected'"), appendOnly, 'a redacted row is final');
  assert.throws(() => update(`redacted_at = '2026-10-10T10:00:00.000Z'`), appendOnly);
  assert.throws(() => database.prepare('DELETE FROM proposed_parameters WHERE id = ?').run(other), appendOnly);

  const runAppendOnly = /policy structuring runs are append only/;
  assert.throws(() => database.prepare("UPDATE policy_structuring_runs SET counts_json = '{}' WHERE id = ?").run(structuringRunId), runAppendOnly);
  assert.throws(() => database.prepare('DELETE FROM policy_structuring_runs WHERE id = ?').run(structuringRunId), runAppendOnly);

  database.prepare("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = ?").run(document);
  assert.throws(() => insertProposal(), /proposed parameters require an active document/);
  assert.throws(() => insertRun({ pipeline_version: 'guard-test/v2' }), /policy structuring requires an active document/);
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'active' WHERE id = ?").run(document);
  insertProposal();
  insertRun({ pipeline_version: 'guard-test/v2' });
  assert.throws(() => insertRun({ id: 'sr-y', pipeline_version: 'guard-test/v2' }), /UNIQUE constraint failed/);
});
