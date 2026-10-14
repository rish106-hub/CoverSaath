import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { CoverageParameterRepository } from '../src/backend/repositories/coverage-parameter-repository.js';
import {
  OBSERVATION_RESOLUTION_RULES,
  PARAMETER_OBSERVATION_METHODS,
  PARAMETER_RESOLUTION_STATES,
  PARAMETER_REVIEW_STATUSES,
  PARAMETER_TRANSITION_AUTHORITIES,
  deriveResolutionAuthority,
  resolvesParameterValue,
  transitionParameterRecord,
  createParameterRecord,
} from '../src/modules/coverage-analysis/parameter-records.js';
import { getPolicyParameterRegistry } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { observationInput, parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

const v1 = 'policy-parameters/v1';

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });
  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 });
  return { database, repository };
}

function parameter(repository, key = 'd.room_rent_limit', id = `parameter-${key.replace('.', '-')}`) {
  return repository.createParameter({ id, registryVersion: v1, parameterKey: key, ...parameterScope(), updatedBy: 'test' });
}

function observe(repository, parameterRecordId, extractionMethod, reviewStatus = 'not_reviewed', overrides = {}) {
  return repository.appendObservation({
    parameterRecordId, ...observationInput({ extractionMethod, reviewStatus, ...overrides }),
  });
}

function resolve(repository, parameterRecordId, state, observation, extra = {}) {
  return repository.setResolution({
    parameterRecordId, state, observationId: observation?.id ?? null, updatedBy: 'test', ...extra,
  });
}

test('D1: a caller cannot label model output as deterministic to reach proven, calculated or dynamic', t => {
  const { repository } = open(t);
  const record = parameter(repository);
  const modelObservation = observe(repository, record.id, 'document_extraction', 'accepted');

  for (const state of ['reported', 'proven', 'calculated', 'dynamic']) {
    for (const authority of [undefined, 'deterministic', 'human_reviewer', 'official_source', 'model']) {
      assert.throws(() => resolve(repository, record.id, state, modelObservation, { authority }), /cannot establish|does not match|cannot create|requires/);
    }
  }
  // The only state a model-derived observation can establish, and only under model authority.
  assert.throws(() => resolve(repository, record.id, 'extracted_unverified', modelObservation, { authority: 'deterministic' }), /does not match/);
  const resolved = resolve(repository, record.id, 'extracted_unverified', modelObservation);
  assert.equal(resolved.authority, 'model');
  assert.equal(resolved.resolutionState, 'extracted_unverified');
});

test('D1: proven needs an accepted non-model review; not_reviewed, rejected and superseded never resolve', t => {
  const { repository } = open(t);
  const record = parameter(repository);

  const unreviewed = observe(repository, record.id, 'human_review', 'not_reviewed');
  assert.throws(() => resolve(repository, record.id, 'proven', unreviewed), /requires an accepted review/);
  for (const status of ['rejected', 'superseded']) {
    const unusable = observe(repository, record.id, 'human_review', status);
    assert.throws(() => resolve(repository, record.id, 'reported', unusable), /cannot support a resolution/);
    assert.throws(() => resolve(repository, record.id, 'proven', unusable), /cannot support a resolution/);
  }
  const accepted = observe(repository, record.id, 'human_review', 'accepted');
  const proven = resolve(repository, record.id, 'proven', accepted, { authority: 'human_reviewer' });
  assert.equal(proven.resolutionState, 'proven');
  assert.equal(proven.authority, 'human_reviewer');

  const official = parameter(repository, 'j.repudiation_ratio', 'parameter-official');
  const lookup = observe(repository, official.id, 'official_source_lookup', 'accepted');
  assert.equal(resolve(repository, official.id, 'proven', lookup).authority, 'official_source');
});

test('D1: calculated and dynamic come only from their own evidence', t => {
  const { repository } = open(t);
  const record = parameter(repository);
  const review = observe(repository, record.id, 'human_review', 'accepted');
  assert.throws(() => resolve(repository, record.id, 'calculated', review), /cannot establish/);
  const calculation = observe(repository, record.id, 'deterministic_calculation', 'not_reviewed', { value: 42 });
  const calculated = resolve(repository, record.id, 'calculated', calculation, { resolvedValue: 42 });
  assert.equal(calculated.authority, 'deterministic');
  assert.throws(() => resolve(repository, record.id, 'calculated', calculation, { resolvedValue: 43 }), /must equal the selected observation value/);
  assert.equal(resolve(repository, record.id, 'dynamic', calculation).resolutionState, 'dynamic');
});

test('D1: a model cannot replace an established resolution or set value-less restricted states', t => {
  const { repository } = open(t);
  const record = parameter(repository);
  const review = observe(repository, record.id, 'human_review', 'accepted');
  resolve(repository, record.id, 'proven', review);
  assert.throws(() => resolve(repository, record.id, 'unknown', null, { authority: 'model' }), /cannot replace an established resolution/);
  assert.throws(() => resolve(repository, record.id, 'not_permitted', null, { authority: 'model' }), /Model authority cannot create/);
  const modelObservation = observe(repository, record.id, 'document_extraction');
  assert.throws(() => resolve(repository, record.id, 'extracted_unverified', modelObservation), /cannot replace an established resolution/);
  assert.equal(repository.getParameter(record.id).resolutionState, 'proven');
});

test('D1: registry rules limit model extraction before and after persistence', t => {
  const { repository } = open(t);
  const restricted = parameter(repository, 'a.contract_and_member_identifiers', 'parameter-restricted');
  assert.throws(() => observe(repository, restricted.id, 'document_extraction'), /Model extraction is not permitted/);
  // A human report for the same parameter is still storable and resolves as reported.
  const report = observe(repository, restricted.id, 'human_report');
  assert.equal(resolve(repository, restricted.id, 'reported', report).authority, 'deterministic');
});

test('D1: the database enforces the same authority rules when the repository is bypassed', t => {
  const { database, repository } = open(t);
  const record = parameter(repository);
  const modelObservation = observe(repository, record.id, 'document_extraction', 'accepted');
  const unreviewed = observe(repository, record.id, 'human_review', 'not_reviewed');
  const update = (state, observationId, authority) => database.prepare(`UPDATE coverage_parameter_resolutions
    SET resolution_state = ?, resolved_value_json = '1', resolved_observation_id = ?, transition_authority = ?
    WHERE parameter_record_id = ?`).run(state, observationId, authority, record.id);

  assert.throws(() => update('proven', modelObservation.id, 'model'), /CHECK constraint failed|not supported by the observation/);
  assert.throws(() => update('proven', modelObservation.id, 'deterministic'), /not supported by the observation/);
  assert.throws(() => update('calculated', modelObservation.id, 'deterministic'), /not supported by the observation/);
  assert.throws(() => update('proven', unreviewed.id, 'human_reviewer'), /not supported by the observation/);
  assert.throws(() => database.prepare(`INSERT INTO coverage_parameter_resolutions
    (parameter_record_id, resolution_state, resolved_value_json, resolved_observation_id,
     transition_authority, updated_by, updated_at)
    VALUES ('parameter-other', 'proven', '1', ?, 'model', 'test', ?)`).run(modelObservation.id, at), /not supported by the observation|must belong|CHECK constraint failed|FOREIGN KEY/);
  update('extracted_unverified', modelObservation.id, 'model');
  assert.equal(repository.getParameter(record.id).authority, 'model');
});

test('D1: the module state machine and the database rule table are identical', t => {
  const { database } = open(t);
  const stored = database.prepare(`SELECT extraction_method AS extractionMethod, resolution_state AS state,
    transition_authority AS authority, requires_accepted AS requiresAccepted
    FROM coverage_parameter_observation_rules`).all()
    .map(row => ({ ...row, requiresAccepted: row.requiresAccepted === 1 }));
  const key = rule => `${rule.extractionMethod}|${rule.state}|${rule.authority}|${rule.requiresAccepted}`;
  assert.deepEqual(stored.map(key).sort(), OBSERVATION_RESOLUTION_RULES.map(key).sort());
  assert.throws(() => database.exec("UPDATE coverage_parameter_observation_rules SET requires_accepted = 0"), /immutable/);
  assert.throws(() => database.exec('DELETE FROM coverage_parameter_observation_rules'), /immutable/);
});

test('D1: exhaustive method x review x state x authority matrix agrees between module and database', t => {
  const { database, repository } = open(t);
  const record = parameter(repository, 'a.policy_type', 'parameter-matrix');
  const observations = [];
  for (const extractionMethod of PARAMETER_OBSERVATION_METHODS) {
    for (const reviewStatus of PARAMETER_REVIEW_STATUSES) {
      // Insert directly: the matrix covers combinations the repository would refuse to store.
      const id = `matrix-${extractionMethod}-${reviewStatus}`;
      database.prepare(`INSERT INTO coverage_parameter_observations
        (id, parameter_record_id, source_id, document_id, version, page, extraction_method,
         review_status, value_json, source_digest, observed_at, recorded_by, created_at)
        VALUES (?, ?, 'page-parameters', 'document-parameters', 'version-1', '2', ?, ?, '1', ?, ?, 'matrix', ?)`)
        .run(id, record.id, extractionMethod, reviewStatus, 'e'.repeat(64), at, at);
      observations.push({ id, extractionMethod, reviewStatus, redactedAt: null });
    }
  }
  const reset = () => database.prepare(`UPDATE coverage_parameter_resolutions SET resolution_state = 'unknown',
    resolved_value_json = NULL, resolved_observation_id = NULL, transition_authority = 'deterministic'
    WHERE parameter_record_id = ?`).run(record.id);
  let accepted = 0;
  for (const observation of observations) {
    for (const state of PARAMETER_RESOLUTION_STATES.filter(resolvesParameterValue)) {
      for (const authority of PARAMETER_TRANSITION_AUTHORITIES) {
        let expected = true;
        try {
          expected = deriveResolutionAuthority({ state, observation, declaredAuthority: authority }) === authority;
        } catch {
          expected = false;
        }
        reset();
        let actual = true;
        try {
          database.prepare(`UPDATE coverage_parameter_resolutions SET resolution_state = ?,
            resolved_value_json = '1', resolved_observation_id = ?, transition_authority = ?
            WHERE parameter_record_id = ?`).run(state, observation.id, authority, record.id);
        } catch {
          actual = false;
        }
        assert.equal(actual, expected, `${observation.extractionMethod}/${observation.reviewStatus} -> ${state} as ${authority}`);
        if (actual) accepted += 1;
      }
    }
  }
  assert.ok(accepted > 0);
});

test('D1: the in-memory transition requires evidence for the claimed authority', () => {
  const base = createParameterRecord({ registryVersion: v1, parameterKey: 'd.room_rent_limit', subjectId: 's', policyId: 'p', updatedAt: at });
  const modelObservation = { id: 'o1', sourceId: 's1', documentId: 'd1', version: 'v1', page: 1, extractionMethod: 'document_extraction', reviewStatus: 'accepted', value: 'x' };
  assert.throws(() => transitionParameterRecord(base, {
    resolutionState: 'proven', observations: [modelObservation], resolvedValue: 'x', updatedAt: at,
  }), /No observation supports proven/);
  assert.throws(() => transitionParameterRecord(base, {
    resolutionState: 'calculated', observations: [modelObservation], resolvedValue: 'x', updatedAt: at,
  }, { authority: 'deterministic' }), /No observation supports calculated/);
  const review = { ...modelObservation, id: 'o2', extractionMethod: 'human_review' };
  const proven = transitionParameterRecord(base, {
    resolutionState: 'proven', observations: [review], resolvedValue: 'x', updatedAt: at,
  }, { authority: 'human_reviewer' });
  assert.equal(proven.resolutionState, 'proven');
  assert.throws(() => transitionParameterRecord(proven, { resolutionState: 'unknown', updatedAt: at }, { authority: 'model' }), /cannot replace an established resolution/);
});

test('D1: acquisition path requested then received is valid and keys never sent stay not_requested', t => {
  const { repository } = open(t);
  const sent = parameter(repository, 'd.room_rent_limit', 'parameter-sent');
  const unsent = parameter(repository, 'a.policy_type', 'parameter-unsent');
  assert.throws(() => repository.setAcquisitionState({ parameterRecordId: sent.id, state: 'received', updatedBy: 'test' }), /Invalid acquisition transition/);

  const requested = repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.room_rent_limit'], state: 'requested', updatedBy: 'runtime',
    at: '2026-10-09T10:01:00.000Z',
  });
  assert.equal(requested[0].acquisitionState, 'requested');
  assert.equal(requested[0].requestedAt, '2026-10-09T10:01:00.000Z');
  const received = repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.room_rent_limit'], state: 'received', updatedBy: 'runtime',
    at: '2026-10-09T10:02:00.000Z',
  });
  assert.equal(received[0].acquisitionState, 'received');
  assert.equal(received[0].requestedAt, '2026-10-09T10:01:00.000Z');
  assert.equal(received[0].receivedAt, '2026-10-09T10:02:00.000Z');
  // Retrying the same state does not rewrite timestamps.
  const again = repository.setAcquisitionState({ parameterRecordId: sent.id, state: 'received', updatedBy: 'runtime', at: '2026-10-09T10:09:00.000Z' });
  assert.equal(again.receivedAt, '2026-10-09T10:02:00.000Z');
  assert.equal(repository.getParameter(unsent.id).acquisitionState, 'not_requested');

  // A later re-request clears the previous receipt.
  const rerequested = repository.setAcquisitionState({ parameterRecordId: sent.id, state: 'requested', updatedBy: 'runtime', at: '2026-10-09T10:10:00.000Z' });
  assert.equal(rerequested.receivedAt, null);
  // All-or-nothing: one invalid key leaves the others untouched.
  assert.throws(() => repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.room_rent_limit', 'a.policy_type'], state: 'received', updatedBy: 'runtime',
  }), /Invalid acquisition transition/);
  assert.equal(repository.getParameter(sent.id).acquisitionState, 'requested');
  assert.throws(() => repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.missing_key'], state: 'requested', updatedBy: 'runtime',
  }), /not found/);
});

test('D2: erasing a document redacts values, keeps ids, audits without values and keeps other updates blocked', t => {
  const { database, repository } = open(t);
  const record = parameter(repository);
  const secret = { amountMinor: 987654321 };
  const kept = observe(repository, record.id, 'document_extraction', 'not_reviewed', { value: secret });
  const other = observe(repository, record.id, 'human_report', 'not_reviewed', {
    sourceId: 'page-other', documentId: 'document-other', value: { amountMinor: 111 },
  });
  resolve(repository, record.id, 'extracted_unverified', kept);
  const second = observe(repository, record.id, 'document_extraction', 'not_reviewed', { value: { amountMinor: 222 } });
  assert.ok(second.id);

  const result = repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'data_subject_request', at: '2026-10-09T11:00:00.000Z' });
  assert.equal(result.redactedObservations, 2);
  assert.equal(result.affectedParameters, 1);
  assert.equal(result.resetResolutions, 1);

  const observations = repository.listObservations(record.id);
  const erased = observations.filter(item => item.documentId === 'document-parameters');
  assert.equal(erased.length, 2);
  for (const item of erased) {
    assert.equal(item.value, null);
    assert.equal(item.redactedAt, '2026-10-09T11:00:00.000Z');
    assert.equal(item.redactionReasonCode, 'data_subject_request');
    assert.equal(item.sourceDigest, 'e'.repeat(64));
    assert.equal(item.sourceId, 'page-parameters');
  }
  assert.equal(erased.some(item => item.id === kept.id), true);
  assert.deepEqual(observations.find(item => item.id === other.id).value, { amountMinor: 111 });
  assert.equal(JSON.stringify(database.prepare('SELECT * FROM coverage_parameter_observations').all()).includes('987654321'), false);

  const reset = repository.getParameter(record.id);
  assert.equal(reset.resolutionState, 'unknown');
  assert.equal(reset.resolvedValue, null);
  assert.equal(reset.resolvedObservationId, null);
  assert.equal(reset.resolutionReasonCode, 'source_redacted');
  assert.equal(JSON.stringify(database.prepare('SELECT * FROM coverage_parameter_resolutions').all()).includes('987654321'), false);

  const events = database.prepare("SELECT * FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'").all();
  assert.equal(events.length, 1);
  assert.equal(events[0].resource_id, 'document-parameters');
  assert.equal(events[0].household_id, 'household-parameters');
  assert.deepEqual(JSON.parse(events[0].event_payload_json), {
    affectedParameters: 1, reasonCode: 'data_subject_request', redactedObservations: 2, resetResolutions: 1,
  });
  assert.equal(events[0].event_payload_json.includes('987654321'), false);

  // Redacted observations cannot back a resolution, and a repeat erasure is a quiet no-op.
  assert.throws(() => resolve(repository, record.id, 'extracted_unverified', erased[0]), /redacted observation/);
  assert.equal(repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'data_subject_request' }).redactedObservations, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'").get().count, 1);

  // Everything except that single redaction update is still rejected.
  assert.throws(() => database.exec("UPDATE coverage_parameter_observations SET review_status = 'accepted'"), /append only/);
  assert.throws(() => database.exec("UPDATE coverage_parameter_observations SET value_json = '1' WHERE redacted_at IS NOT NULL"), /append only/);
  assert.throws(() => database.exec("UPDATE coverage_parameter_observations SET redacted_at = NULL, redaction_reason_code = NULL"), /append only/);
  assert.throws(() => database.exec("UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = '2026-10-09T12:00:00.000Z', redaction_reason_code = 'x', source_digest = '" + 'f'.repeat(64) + "' WHERE id = '" + other.id + "'"), /append only/);
  assert.throws(() => database.exec("UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = '2026-10-09T12:00:00.000Z' WHERE id = '" + other.id + "'"), /CHECK constraint failed|append only/);
  assert.throws(() => database.exec('DELETE FROM coverage_parameter_observations'), /append only/);
  assert.deepEqual(repository.listObservations(record.id).find(item => item.id === other.id).value, { amountMinor: 111 });
});

test('D2: redaction also withdraws a conflict built from the erased evidence', t => {
  const { repository } = open(t);
  const record = parameter(repository);
  observe(repository, record.id, 'human_report', 'not_reviewed', { value: 'a' });
  observe(repository, record.id, 'human_report', 'not_reviewed', { sourceId: 'page-other', documentId: 'document-other', value: 'b' });
  assert.equal(resolve(repository, record.id, 'conflicting', null).resolutionState, 'conflicting');
  repository.redactObservationsForDocument({ documentId: 'document-other', reasonCode: 'retention_expired' });
  assert.equal(repository.getParameter(record.id).resolutionState, 'unknown');
  assert.throws(() => resolve(repository, record.id, 'conflicting', null), /at least two observations/);
});

test('D2: a document deletion request or consent revocation redacts values even without the repository call', t => {
  const { database, repository } = open(t);
  const record = parameter(repository);
  const model = observe(repository, record.id, 'document_extraction', 'not_reviewed', { value: { secret: 'revocable' } });
  resolve(repository, record.id, 'extracted_unverified', model);

  database.prepare(`INSERT INTO consent_revocations
    (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, created_at)
    VALUES ('revocation-parameters', 'consent-parameters', 'adult-parameters', 'Synthetic', ?, ?)`).run(at, at);
  database.prepare(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested'
    WHERE consent_grant_id = 'consent-parameters' AND lifecycle_state IN ('active', 'quarantined')`).run();

  const [observation] = repository.listObservations(record.id);
  assert.equal(observation.value, null);
  assert.equal(observation.redactionReasonCode, 'document_erasure');
  assert.equal(repository.getParameter(record.id).resolutionState, 'unknown');
  assert.equal(JSON.stringify(database.prepare('SELECT * FROM coverage_parameter_observations').all()).includes('revocable'), false);
});

test('D2: the erasure method validates its input and joins an outer transaction', t => {
  const { database, repository } = open(t);
  const record = parameter(repository);
  observe(repository, record.id, 'human_report', 'not_reviewed');
  assert.throws(() => repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'because' }), /reasonCode is not supported/);
  assert.throws(() => repository.redactObservationsForDocument({ documentId: 'document-missing', reasonCode: 'document_erasure' }), /not found/);
  database.exec('BEGIN IMMEDIATE');
  repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'document_erasure' });
  database.exec('ROLLBACK');
  assert.notEqual(repository.listObservations(record.id)[0].value, null);
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'").get().count, 0);
});

test('D2: an injected audit repository records the erasure event', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const audit = new AuditRepository(database, { clock: () => new Date(at) });
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at), audit });
  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 });
  const record = parameter(repository);
  observe(repository, record.id, 'human_report');
  repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'consent_revoked', actorType: 'adult_user', actorId: 'adult-parameters' });
  const [event] = audit.listForCase('case-parameters');
  assert.equal(event.actor_type, 'adult_user');
  assert.equal(event.occurred_at, at);
});

test('M1: registry versions are rows, not a hard-coded CHECK, and unknown versions still fail closed', t => {
  const { database, repository } = open(t);
  assert.throws(() => database.prepare(`INSERT INTO coverage_parameter_registry_pins
    (workflow_run_id, registry_version, pinned_at, created_at) VALUES ('run-other', 'policy-parameters/v2', ?, ?)`).run(at, at), /FOREIGN KEY/);
  // Registering v2 is a data change only; the pin table accepts it without a rebuild.
  database.prepare("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('policy-parameters/v2', ?)").run(at);
  assert.throws(() => database.prepare("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('other/v1', ?)").run(at), /CHECK constraint failed/);
  assert.throws(() => database.exec("UPDATE coverage_parameter_registry_versions SET registered_at = 'x'"), /immutable/);
  assert.throws(() => database.exec('DELETE FROM coverage_parameter_registry_versions'), /immutable/);
  // The repository does not know v2, so it fails closed even though the database now would allow it.
  assert.throws(() => repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v2' }), /registryVersion is not supported/);
  assert.throws(() => repository.initializeRunParameters({ ...parameterScope(), registryVersion: 'policy-parameters/v2' }), /registryVersion is not supported/);
});

test('pins are idempotent for the same version, immutable and never re-pinned', t => {
  const { database, repository } = open(t);
  const first = repository.getRegistryPin('run-parameters');
  assert.deepEqual(repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 }), first);
  database.prepare("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('policy-parameters/v2', ?)").run(at);
  assert.throws(() => database.exec("UPDATE coverage_parameter_registry_pins SET registry_version = 'policy-parameters/v2'"), /immutable/);
});

test('initializeRunParameters pins the run and creates every registry parameter idempotently', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });
  const total = getPolicyParameterRegistry(v1).parameters.length;

  const first = repository.initializeRunParameters({ ...parameterScope(), notApplicableKeys: ['j.repudiation_ratio'], updatedBy: 'run-start' });
  assert.equal(first.registryVersion, v1);
  assert.equal(first.created, total);
  assert.equal(first.existing, 0);
  assert.equal(repository.getRegistryPin('run-parameters').registryVersion, v1);

  const records = repository.listForRun('run-parameters');
  assert.equal(records.length, total);
  const applicable = records.filter(item => item.applicable);
  assert.equal(applicable.length, total - 1);
  assert.ok(applicable.every(item => item.acquisitionState === 'not_requested' && item.resolutionState === 'unknown' && item.resolvedValue === null));
  const skipped = records.find(item => item.parameterKey === 'j.repudiation_ratio');
  assert.equal(skipped.applicable, false);
  assert.equal(skipped.resolutionState, 'not_permitted');

  // Re-running keeps existing state untouched.
  const kept = records.find(item => item.parameterKey === 'd.room_rent_limit');
  repository.setAcquisitionState({ parameterRecordId: kept.id, state: 'requested', updatedBy: 'runtime' });
  const second = repository.initializeRunParameters({ ...parameterScope(), notApplicableKeys: ['j.repudiation_ratio'] });
  assert.equal(second.created, 0);
  assert.equal(second.existing, total);
  assert.equal(repository.getParameter(kept.id).acquisitionState, 'requested');
  assert.equal(database.prepare('SELECT count(*) AS count FROM coverage_parameter_records').get().count, total);

  assert.throws(() => repository.initializeRunParameters({ ...parameterScope(), subjectId: 'member-elsewhere' }), /different scope|FOREIGN KEY|must match/);
  assert.throws(() => repository.initializeRunParameters({ ...parameterScope(), notApplicableKeys: ['z.nope'] }), /Unknown policy parameter key/);
  assert.equal(repository.listForRun('run-parameters', { limit: 5 }).length, 5);
  assert.throws(() => repository.listForRun('run-parameters', { limit: 100000 }), /limit must be/);
});

test('initializeRunParameters is atomic when a scope check fails midway', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });
  assert.throws(() => repository.initializeRunParameters({ ...parameterScope(), policyId: 'policy-missing' }), /must match|FOREIGN KEY/);
  assert.equal(repository.getRegistryPin('run-parameters'), null);
  assert.equal(database.prepare('SELECT count(*) AS count FROM coverage_parameter_records').get().count, 0);
});

test('reads are bounded', t => {
  const { repository } = open(t);
  const record = parameter(repository);
  assert.throws(() => repository.listObservations(record.id, { limit: 0 }), /limit must be/);
  assert.throws(() => repository.listObservations(record.id, { limit: 501 }), /limit must be/);
});
