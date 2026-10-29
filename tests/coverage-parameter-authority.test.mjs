// Coverage parameter authority, erasure and pinning on the async PostgreSQL interface (S3.2).
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
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
} from '../src/features/coverage-analysis/parameter-records.js';
import { getPolicyParameterRegistry } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { observationInput, parameterAt as at, parameterReviewerId, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const v1 = 'policy-parameters/v1';
const pgOptions = postgresTestOptions();
// PostgreSQL wording of the constraint failures the SQLite runtime reported differently.
const CHECK_FAILED = /violates check constraint/;
const FOREIGN_KEY_FAILED = /violates foreign key constraint/;

async function open(t, { pin = true } = {}) {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });
  if (pin) await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 });
  return { database, repository };
}

function parameter(repository, key = 'd.room_rent_limit', id = `parameter-${key.replace('.', '-')}`) {
  return repository.createParameter({ id, registryVersion: v1, parameterKey: key, ...parameterScope(), updatedBy: 'test' });
}

function observe(repository, parameterRecordId, extractionMethod, reviewStatus = 'not_reviewed', overrides = {}) {
  return repository.appendObservation({
    parameterRecordId,
    ...observationInput({ extractionMethod, reviewStatus, ...(extractionMethod === 'human_review' ? { recordedBy: parameterReviewerId } : {}), ...overrides }),
  });
}

function resolve(repository, parameterRecordId, state, observation, extra = {}) {
  return repository.setResolution({
    parameterRecordId, state, observationId: observation?.id ?? null, updatedBy: 'test', ...extra,
  });
}

test('D1: a caller cannot label model output as deterministic to reach proven, calculated or dynamic', pgOptions, async t => {
  const { repository } = await open(t);
  const record = await parameter(repository);
  const modelObservation = await observe(repository, record.id, 'document_extraction', 'accepted');

  for (const state of ['reported', 'proven', 'calculated', 'dynamic']) {
    for (const authority of [undefined, 'deterministic', 'human_reviewer', 'official_source', 'model']) {
      await assert.rejects(resolve(repository, record.id, state, modelObservation, { authority }), /cannot establish|does not match|cannot create|requires/);
    }
  }
  // The only state a model-derived observation can establish, and only under model authority.
  await assert.rejects(resolve(repository, record.id, 'extracted_unverified', modelObservation, { authority: 'deterministic' }), /does not match/);
  const resolved = await resolve(repository, record.id, 'extracted_unverified', modelObservation);
  assert.equal(resolved.authority, 'model');
  assert.equal(resolved.resolutionState, 'extracted_unverified');
});

test('D1: proven needs an accepted non-model review; not_reviewed, rejected and superseded never resolve', pgOptions, async t => {
  const { repository } = await open(t);
  const record = await parameter(repository);

  const unreviewed = await observe(repository, record.id, 'human_review', 'not_reviewed');
  await assert.rejects(resolve(repository, record.id, 'proven', unreviewed), /requires an accepted review/);
  for (const status of ['rejected', 'superseded']) {
    const unusable = await observe(repository, record.id, 'human_review', status);
    await assert.rejects(resolve(repository, record.id, 'reported', unusable), /cannot support a resolution/);
    await assert.rejects(resolve(repository, record.id, 'proven', unusable), /cannot support a resolution/);
  }
  const accepted = await observe(repository, record.id, 'human_review', 'accepted');
  const proven = await resolve(repository, record.id, 'proven', accepted, { authority: 'human_reviewer' });
  assert.equal(proven.resolutionState, 'proven');
  assert.equal(proven.authority, 'human_reviewer');

  const official = await parameter(repository, 'j.repudiation_ratio', 'parameter-official');
  const lookup = await observe(repository, official.id, 'official_source_lookup', 'accepted');
  assert.equal((await resolve(repository, official.id, 'proven', lookup)).authority, 'official_source');
});

test('D1: calculated and dynamic come only from their own evidence', pgOptions, async t => {
  const { repository } = await open(t);
  const record = await parameter(repository);
  const review = await observe(repository, record.id, 'human_review', 'accepted');
  await assert.rejects(resolve(repository, record.id, 'calculated', review), /cannot establish/);
  const calculation = await observe(repository, record.id, 'deterministic_calculation', 'not_reviewed', { value: 42 });
  const calculated = await resolve(repository, record.id, 'calculated', calculation, { resolvedValue: 42 });
  assert.equal(calculated.authority, 'deterministic');
  await assert.rejects(resolve(repository, record.id, 'calculated', calculation, { resolvedValue: 43 }), /must equal the selected observation value/);
  assert.equal((await resolve(repository, record.id, 'dynamic', calculation)).resolutionState, 'dynamic');
});

test('D1: a model cannot replace an established resolution or set value-less restricted states', pgOptions, async t => {
  const { repository } = await open(t);
  const record = await parameter(repository);
  const review = await observe(repository, record.id, 'human_review', 'accepted');
  await resolve(repository, record.id, 'proven', review);
  await assert.rejects(resolve(repository, record.id, 'unknown', null, { authority: 'model' }), /cannot replace an established resolution/);
  await assert.rejects(resolve(repository, record.id, 'not_permitted', null, { authority: 'model' }), /Model authority cannot create/);
  const modelObservation = await observe(repository, record.id, 'document_extraction');
  await assert.rejects(resolve(repository, record.id, 'extracted_unverified', modelObservation), /cannot replace an established resolution/);
  assert.equal((await repository.getParameter(record.id)).resolutionState, 'proven');
});

test('D1: registry rules limit model extraction before and after persistence', pgOptions, async t => {
  const { repository } = await open(t);
  const restricted = await parameter(repository, 'a.contract_and_member_identifiers', 'parameter-restricted');
  await assert.rejects(observe(repository, restricted.id, 'document_extraction'), /Model extraction is not permitted/);
  // A human report for the same parameter is still storable and resolves as reported.
  const report = await observe(repository, restricted.id, 'human_report');
  assert.equal((await resolve(repository, restricted.id, 'reported', report)).authority, 'deterministic');
});

test('D1: the database enforces the same authority rules when the repository is bypassed', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository);
  const modelObservation = await observe(repository, record.id, 'document_extraction', 'accepted');
  const unreviewed = await observe(repository, record.id, 'human_review', 'not_reviewed');
  const update = (state, observationId, authority) => database.run(`UPDATE coverage_parameter_resolutions
    SET resolution_state = ?, resolved_value_json = '1', resolved_observation_id = ?, transition_authority = ?
    WHERE parameter_record_id = ?`, [state, observationId, authority, record.id]);

  await assert.rejects(update('proven', modelObservation.id, 'model'), /violates check constraint|not supported by the observation/);
  await assert.rejects(update('proven', modelObservation.id, 'deterministic'), /not supported by the observation/);
  await assert.rejects(update('calculated', modelObservation.id, 'deterministic'), /not supported by the observation/);
  await assert.rejects(update('proven', unreviewed.id, 'human_reviewer'), /not supported by the observation/);
  await assert.rejects(database.run(`INSERT INTO coverage_parameter_resolutions
    (parameter_record_id, resolution_state, resolved_value_json, resolved_observation_id,
     transition_authority, updated_by, updated_at)
    VALUES ('parameter-other', 'proven', '1', ?, 'model', 'test', ?)`, [modelObservation.id, at]),
  /not supported by the observation|must belong|violates check constraint|violates foreign key constraint/);
  await update('extracted_unverified', modelObservation.id, 'model');
  assert.equal((await repository.getParameter(record.id)).authority, 'model');
});

test('D1: the module state machine and the database rule table are identical', pgOptions, async t => {
  const { database } = await open(t);
  const stored = (await database.many(`SELECT extraction_method AS "extractionMethod", resolution_state AS state,
    transition_authority AS authority, requires_accepted AS "requiresAccepted"
    FROM coverage_parameter_observation_rules`))
    .map(row => ({ ...row, requiresAccepted: row.requiresAccepted === 1 }));
  const key = rule => `${rule.extractionMethod}|${rule.state}|${rule.authority}|${rule.requiresAccepted}`;
  assert.deepEqual(stored.map(key).sort(), OBSERVATION_RESOLUTION_RULES.map(key).sort());
  await assert.rejects(database.run('UPDATE coverage_parameter_observation_rules SET requires_accepted = 0'), /immutable/);
  await assert.rejects(database.run('DELETE FROM coverage_parameter_observation_rules'), /immutable/);
});

test('D1: exhaustive method x review x state x authority matrix agrees between module and database', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository, 'a.policy_type', 'parameter-matrix');
  const observations = [];
  for (const extractionMethod of PARAMETER_OBSERVATION_METHODS) {
    for (const reviewStatus of PARAMETER_REVIEW_STATUSES) {
      // Insert directly: the matrix covers combinations the repository would refuse to store.
      const id = `matrix-${extractionMethod}-${reviewStatus}`;
      await database.run(`INSERT INTO coverage_parameter_observations
        (id, parameter_record_id, source_id, document_id, version, page, extraction_method,
         review_status, value_json, source_digest, observed_at, recorded_by, created_at)
        VALUES (?, ?, 'page-parameters', 'document-parameters', 'version-1', '2', ?, ?, '1', ?, ?, ?, ?)`,
      [id, record.id, extractionMethod, reviewStatus, 'e'.repeat(64), at, parameterReviewerId, at]);
      observations.push({ id, extractionMethod, reviewStatus, redactedAt: null });
    }
  }
  const reset = () => database.run(`UPDATE coverage_parameter_resolutions SET resolution_state = 'unknown',
    resolved_value_json = NULL, resolved_observation_id = NULL, transition_authority = 'deterministic'
    WHERE parameter_record_id = ?`, [record.id]);
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
        await reset();
        let actual = true;
        try {
          await database.run(`UPDATE coverage_parameter_resolutions SET resolution_state = ?,
            resolved_value_json = '1', resolved_observation_id = ?, transition_authority = ?
            WHERE parameter_record_id = ?`, [state, observation.id, authority, record.id]);
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

test('D1: acquisition path requested then received is valid and keys never sent stay not_requested', pgOptions, async t => {
  const { repository } = await open(t);
  const sent = await parameter(repository, 'd.room_rent_limit', 'parameter-sent');
  const unsent = await parameter(repository, 'a.policy_type', 'parameter-unsent');
  await assert.rejects(repository.setAcquisitionState({ parameterRecordId: sent.id, state: 'received', updatedBy: 'test' }), /Invalid acquisition transition/);

  const requested = await repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.room_rent_limit'], state: 'requested', updatedBy: 'runtime',
    at: '2026-10-09T10:01:00.000Z',
  });
  assert.equal(requested[0].acquisitionState, 'requested');
  assert.equal(requested[0].requestedAt, '2026-10-09T10:01:00.000Z');
  const received = await repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.room_rent_limit'], state: 'received', updatedBy: 'runtime',
    at: '2026-10-09T10:02:00.000Z',
  });
  assert.equal(received[0].acquisitionState, 'received');
  assert.equal(received[0].requestedAt, '2026-10-09T10:01:00.000Z');
  assert.equal(received[0].receivedAt, '2026-10-09T10:02:00.000Z');
  // Retrying the same state does not rewrite timestamps.
  const again = await repository.setAcquisitionState({ parameterRecordId: sent.id, state: 'received', updatedBy: 'runtime', at: '2026-10-09T10:09:00.000Z' });
  assert.equal(again.receivedAt, '2026-10-09T10:02:00.000Z');
  assert.equal((await repository.getParameter(unsent.id)).acquisitionState, 'not_requested');

  // A later re-request clears the previous receipt.
  const rerequested = await repository.setAcquisitionState({ parameterRecordId: sent.id, state: 'requested', updatedBy: 'runtime', at: '2026-10-09T10:10:00.000Z' });
  assert.equal(rerequested.receivedAt, null);
  // All-or-nothing: one invalid key leaves the others untouched.
  await assert.rejects(repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.room_rent_limit', 'a.policy_type'], state: 'received', updatedBy: 'runtime',
  }), /Invalid acquisition transition/);
  assert.equal((await repository.getParameter(sent.id)).acquisitionState, 'requested');
  await assert.rejects(repository.setAcquisitionStateForRun({
    workflowRunId: 'run-parameters', parameterKeys: ['d.missing_key'], state: 'requested', updatedBy: 'runtime',
  }), /not found/);
});

test('D2: erasing a document redacts values, keeps ids, audits without values and keeps other updates blocked', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository);
  const secret = { amountMinor: 987654321 };
  const kept = await observe(repository, record.id, 'document_extraction', 'not_reviewed', { value: secret });
  const other = await observe(repository, record.id, 'human_report', 'not_reviewed', {
    sourceId: 'page-other', documentId: 'document-other', value: { amountMinor: 111 },
  });
  await resolve(repository, record.id, 'extracted_unverified', kept);
  const second = await observe(repository, record.id, 'document_extraction', 'not_reviewed', { value: { amountMinor: 222 } });
  assert.ok(second.id);

  const result = await repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'data_subject_request', at: '2026-10-09T11:00:00.000Z' });
  // int8 counts arrive as Numbers (S3.2 int8 parser), so strict equality holds.
  assert.equal(result.redactedObservations, 2);
  assert.equal(result.affectedParameters, 1);
  assert.equal(result.resetResolutions, 1);

  const observations = await repository.listObservations(record.id);
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
  assert.equal(JSON.stringify(await database.many('SELECT * FROM coverage_parameter_observations')).includes('987654321'), false);

  const reset = await repository.getParameter(record.id);
  assert.equal(reset.resolutionState, 'unknown');
  assert.equal(reset.resolvedValue, null);
  assert.equal(reset.resolvedObservationId, null);
  assert.equal(reset.resolutionReasonCode, 'source_redacted');
  assert.equal(JSON.stringify(await database.many('SELECT * FROM coverage_parameter_resolutions')).includes('987654321'), false);

  const events = await database.many("SELECT * FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'");
  assert.equal(events.length, 1);
  assert.equal(events[0].resource_id, 'document-parameters');
  assert.equal(events[0].household_id, 'household-parameters');
  assert.deepEqual(JSON.parse(events[0].event_payload_json), {
    affectedParameters: 1, reasonCode: 'data_subject_request', redactedObservations: 2, resetResolutions: 1,
  });
  assert.equal(events[0].event_payload_json.includes('987654321'), false);

  // Redacted observations cannot back a resolution, and a repeat erasure is a quiet no-op.
  await assert.rejects(resolve(repository, record.id, 'extracted_unverified', erased[0]), /redacted observation/);
  assert.equal((await repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'data_subject_request' })).redactedObservations, 0);
  assert.equal((await database.one("SELECT count(*) AS count FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'")).count, 1);

  // Everything except that single redaction update is still rejected.
  await assert.rejects(database.run("UPDATE coverage_parameter_observations SET review_status = 'accepted'"), /append only/);
  await assert.rejects(database.run("UPDATE coverage_parameter_observations SET value_json = '1' WHERE redacted_at IS NOT NULL"), /append only/);
  await assert.rejects(database.run('UPDATE coverage_parameter_observations SET redacted_at = NULL, redaction_reason_code = NULL'), /append only/);
  await assert.rejects(database.run(`UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = '2026-10-09T12:00:00.000Z',
    redaction_reason_code = 'x', source_digest = ? WHERE id = ?`, ['f'.repeat(64), other.id]), /append only/);
  await assert.rejects(database.run("UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = '2026-10-09T12:00:00.000Z' WHERE id = ?", [other.id]),
    /violates check constraint|append only/);
  await assert.rejects(database.run('DELETE FROM coverage_parameter_observations'), /append only/);
  assert.deepEqual((await repository.listObservations(record.id)).find(item => item.id === other.id).value, { amountMinor: 111 });
});

test('D2: redaction also withdraws a conflict built from the erased evidence', pgOptions, async t => {
  const { repository } = await open(t);
  const record = await parameter(repository);
  await observe(repository, record.id, 'human_report', 'not_reviewed', { value: 'a' });
  await observe(repository, record.id, 'human_report', 'not_reviewed', { sourceId: 'page-other', documentId: 'document-other', value: 'b' });
  assert.equal((await resolve(repository, record.id, 'conflicting', null)).resolutionState, 'conflicting');
  await repository.redactObservationsForDocument({ documentId: 'document-other', reasonCode: 'retention_expired' });
  assert.equal((await repository.getParameter(record.id)).resolutionState, 'unknown');
  await assert.rejects(resolve(repository, record.id, 'conflicting', null), /at least two observations/);
});

test('D2: a document deletion request or consent revocation redacts values even without the repository call', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository);
  const model = await observe(repository, record.id, 'document_extraction', 'not_reviewed', { value: { secret: 'revocable' } });
  await resolve(repository, record.id, 'extracted_unverified', model);

  await database.run(`INSERT INTO consent_revocations
    (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, created_at)
    VALUES ('revocation-parameters', 'consent-parameters', 'adult-parameters', 'Synthetic', ?, ?)`, [at, at]);
  await database.run(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested'
    WHERE consent_grant_id = 'consent-parameters' AND lifecycle_state IN ('active', 'quarantined')`);

  const [observation] = await repository.listObservations(record.id);
  assert.equal(observation.value, null);
  assert.equal(observation.redactionReasonCode, 'document_erasure');
  assert.equal((await repository.getParameter(record.id)).resolutionState, 'unknown');
  assert.equal(JSON.stringify(await database.many('SELECT * FROM coverage_parameter_observations')).includes('revocable'), false);
});

test('D2: the erasure method validates its input and joins an outer transaction', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository);
  await observe(repository, record.id, 'human_report', 'not_reviewed');
  await assert.rejects(repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'because' }), /reasonCode is not supported/);
  await assert.rejects(repository.redactObservationsForDocument({ documentId: 'document-missing', reasonCode: 'document_erasure' }), /not found/);
  // Inside a caller's transaction the erasure joins it: rolling the caller back undoes it.
  const rollback = new Error('synthetic caller rollback');
  await assert.rejects(database.transaction(async () => {
    const counts = await repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'document_erasure' });
    assert.equal(counts.redactedObservations, 1);
    throw rollback;
  }), error => error === rollback);
  assert.notEqual((await repository.listObservations(record.id))[0].value, null);
  assert.equal((await database.one("SELECT count(*) AS count FROM audit_events WHERE action = 'coverage_parameter.observations_redacted'")).count, 0);
  // A failing nested call rolls back only its savepoint; the caller's own write survives.
  await database.transaction(async () => {
    await database.run(`INSERT INTO policies (id, household_id, policy_kind, verification_state, created_at, updated_at)
      VALUES ('policy-outer', 'household-parameters', 'unknown', 'unverified', ?, ?)`, [at, at]);
    await assert.rejects(repository.redactObservationsForDocument({ documentId: 'document-missing', reasonCode: 'document_erasure' }), /not found/);
  });
  assert.equal((await database.one("SELECT count(*) AS count FROM policies WHERE id = 'policy-outer'")).count, 1);
});

test('D2: an injected audit repository records the erasure event', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const audit = new AuditRepository(database, { clock: () => new Date(at) });
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at), audit });
  await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 });
  const record = await parameter(repository);
  await observe(repository, record.id, 'human_report');
  await repository.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'consent_revoked', actorType: 'adult_user', actorId: 'adult-parameters' });
  const [event] = await audit.listForCase('case-parameters');
  assert.equal(event.actor_type, 'adult_user');
  assert.equal(event.occurred_at, at);
});

test('M1: registry versions are rows, not a hard-coded CHECK, and unknown versions still fail closed', pgOptions, async t => {
  const { database, repository } = await open(t);
  await assert.rejects(database.run(`INSERT INTO coverage_parameter_registry_pins
    (workflow_run_id, registry_version, pinned_at, created_at) VALUES ('run-other', 'policy-parameters/v2', ?, ?)`, [at, at]), FOREIGN_KEY_FAILED);
  // Registering v2 is a data change only; the pin table accepts it without a rebuild.
  await database.run("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('policy-parameters/v2', ?)", [at]);
  await assert.rejects(database.run("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('other/v1', ?)", [at]), CHECK_FAILED);
  await assert.rejects(database.run("UPDATE coverage_parameter_registry_versions SET registered_at = 'x'"), /immutable/);
  await assert.rejects(database.run('DELETE FROM coverage_parameter_registry_versions'), /immutable/);
  // The repository does not know v2, so it fails closed even though the database now would allow it.
  await assert.rejects(repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v2' }), /registryVersion is not supported/);
  await assert.rejects(repository.initializeRunParameters({ ...parameterScope(), registryVersion: 'policy-parameters/v2' }), /registryVersion is not supported/);
});

test('pins are idempotent for the same version, immutable and never re-pinned', pgOptions, async t => {
  const { database, repository } = await open(t);
  const first = await repository.getRegistryPin('run-parameters');
  // Quoted camelCase aliases survive PostgreSQL identifier folding.
  assert.deepEqual(Object.keys(first).sort(), ['createdAt', 'pinnedAt', 'registryVersion', 'workflowRunId']);
  assert.deepEqual(await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1 }), first);
  assert.deepEqual(await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: v1, pinnedAt: '2026-10-10T00:00:00.000Z' }), first);
  await database.run("INSERT INTO coverage_parameter_registry_versions (version, registered_at) VALUES ('policy-parameters/v2', ?)", [at]);
  await assert.rejects(database.run("UPDATE coverage_parameter_registry_pins SET registry_version = 'policy-parameters/v2'"), /immutable/);
  await assert.rejects(database.run("DELETE FROM coverage_parameter_registry_pins WHERE workflow_run_id = 'run-parameters'"), /immutable/);
});

test('concurrent pins of one run all return the same pin and raise no unique violation', pgOptions, async t => {
  const { database, repository } = await open(t, { pin: false });
  const pins = await Promise.all(Array.from({ length: 10 }, (_, index) => repository.pinRegistry({
    workflowRunId: 'run-parameters', registryVersion: v1, pinnedAt: `2026-10-09T10:00:0${index}.000Z`,
  })));
  assert.equal(new Set(pins.map(pin => JSON.stringify(pin))).size, 1);
  assert.equal((await database.one('SELECT count(*) AS count FROM coverage_parameter_registry_pins')).count, 1);
});

test('a parameter read reports the resolution updated_at (duplicate column name, last wins)', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository);
  // The acquisition change moves the record's updated_at but not the resolution's.
  await repository.setAcquisitionState({ parameterRecordId: record.id, state: 'requested', updatedBy: 'runtime', at: '2026-10-09T12:00:00.000Z' });
  const row = await database.one(`SELECT parameter.updated_at AS record_updated, resolution.updated_at AS resolution_updated
    FROM coverage_parameter_records parameter JOIN coverage_parameter_resolutions resolution ON resolution.parameter_record_id = parameter.id
    WHERE parameter.id = ?`, [record.id]);
  assert.equal(row.record_updated, '2026-10-09T12:00:00.000Z');
  assert.notEqual(row.resolution_updated, row.record_updated);
  assert.equal((await repository.getParameter(record.id)).updatedAt, row.resolution_updated);
});

test('concurrent identical acquisition moves write once; the row is locked before the check', pgOptions, async t => {
  const { database, repository } = await open(t);
  const record = await parameter(repository);
  await repository.setAcquisitionState({ parameterRecordId: record.id, state: 'requested', updatedBy: 'runtime', at: '2026-10-09T10:01:00.000Z' });
  // Test-only write counter in this throwaway database.
  await database.run('CREATE TABLE test_acquisition_writes (state text NOT NULL)');
  await database.run(`CREATE FUNCTION test_count_acquisition_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN INSERT INTO test_acquisition_writes (state) VALUES (NEW.acquisition_state); RETURN NEW; END $$`);
  await database.run(`CREATE TRIGGER test_count_acquisition_write AFTER UPDATE ON coverage_parameter_acquisitions
    FOR EACH ROW EXECUTE FUNCTION test_count_acquisition_write()`);
  const moves = await Promise.all(Array.from({ length: 8 }, (_, index) => repository.setAcquisitionState({
    parameterRecordId: record.id, state: 'received', updatedBy: 'runtime', at: `2026-10-09T10:02:0${index}.000Z`,
  })));
  assert.equal((await database.one('SELECT count(*) AS count FROM test_acquisition_writes')).count, 1);
  assert.equal(new Set(moves.map(move => move.receivedAt)).size, 1);
  assert.equal(moves[0].requestedAt, '2026-10-09T10:01:00.000Z');

  // Concurrent resolutions of one parameter serialise on the locked resolution row.
  const report = await observe(repository, record.id, 'human_report');
  const resolutions = await Promise.allSettled(Array.from({ length: 6 }, () => resolve(repository, record.id, 'reported', report)));
  assert.ok(resolutions.every(outcome => outcome.status === 'fulfilled'), 'reported -> reported is an allowed repeat');
  assert.equal((await repository.getParameter(record.id)).resolutionState, 'reported');
});

test('initializeRunParameters pins the run and creates every registry parameter idempotently', pgOptions, async t => {
  const { database, repository } = await open(t, { pin: false });
  const total = getPolicyParameterRegistry(v1).parameters.length;

  const first = await repository.initializeRunParameters({ ...parameterScope(), notApplicableKeys: ['j.repudiation_ratio'], updatedBy: 'run-start' });
  assert.equal(first.registryVersion, v1);
  assert.equal(first.created, total);
  assert.equal(first.existing, 0);
  assert.equal((await repository.getRegistryPin('run-parameters')).registryVersion, v1);

  const records = await repository.listForRun('run-parameters');
  assert.equal(records.length, total);
  const applicable = records.filter(item => item.applicable);
  assert.equal(applicable.length, total - 1);
  assert.ok(applicable.every(item => item.acquisitionState === 'not_requested' && item.resolutionState === 'unknown' && item.resolvedValue === null));
  const skipped = records.find(item => item.parameterKey === 'j.repudiation_ratio');
  assert.equal(skipped.applicable, false);
  assert.equal(skipped.resolutionState, 'not_permitted');

  // Re-running keeps existing state untouched.
  const kept = records.find(item => item.parameterKey === 'd.room_rent_limit');
  await repository.setAcquisitionState({ parameterRecordId: kept.id, state: 'requested', updatedBy: 'runtime' });
  const second = await repository.initializeRunParameters({ ...parameterScope(), notApplicableKeys: ['j.repudiation_ratio'] });
  assert.equal(second.created, 0);
  assert.equal(second.existing, total);
  assert.equal((await repository.getParameter(kept.id)).acquisitionState, 'requested');
  assert.equal((await database.one('SELECT count(*) AS count FROM coverage_parameter_records')).count, total);

  await assert.rejects(repository.initializeRunParameters({ ...parameterScope(), subjectId: 'member-elsewhere' }), /different scope|violates foreign key constraint|must match/);
  await assert.rejects(repository.initializeRunParameters({ ...parameterScope(), notApplicableKeys: ['z.nope'] }), /Unknown policy parameter key/);
  assert.equal((await repository.listForRun('run-parameters', { limit: 5 })).length, 5);
  await assert.rejects(repository.listForRun('run-parameters', { limit: 100000 }), /limit must be/);
});

test('initializeRunParameters is atomic when a scope check fails midway', pgOptions, async t => {
  const { database, repository } = await open(t, { pin: false });
  await assert.rejects(repository.initializeRunParameters({ ...parameterScope(), policyId: 'policy-missing' }), /must match|violates foreign key constraint/);
  assert.equal(await repository.getRegistryPin('run-parameters'), null);
  assert.equal((await database.one('SELECT count(*) AS count FROM coverage_parameter_records')).count, 0);
});

test('reads are bounded', pgOptions, async t => {
  const { repository } = await open(t);
  const record = await parameter(repository);
  await assert.rejects(repository.listObservations(record.id, { limit: 0 }), /limit must be/);
  await assert.rejects(repository.listObservations(record.id, { limit: 501 }), /limit must be/);
});
