import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { CoverageParameterRepository } from '../src/backend/repositories/coverage-parameter-repository.js';
import { observationInput, parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  return { database, repository: new CoverageParameterRepository(database, { clock: () => new Date(at) }) };
}

test('parameter persistence pins a registry and keeps acquisition separate from resolution', t => {
  const { repository } = open(t);

  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });
  const created = repository.createParameter({
    id: 'parameter-room-rent', registryVersion: 'policy-parameters/v1',
    parameterKey: 'd.room_rent_limit', ...parameterScope(), updatedBy: 'test',
  });
  assert.equal(created.acquisitionState, 'not_requested');
  assert.equal(created.resolutionState, 'unknown');

  repository.setAcquisitionState({ parameterRecordId: created.id, state: 'requested', updatedBy: 'test' });
  const acquired = repository.setAcquisitionState({ parameterRecordId: created.id, state: 'received', updatedBy: 'test' });
  assert.equal(acquired.acquisitionState, 'received');
  assert.equal(acquired.resolutionState, 'unknown');

  const observation = repository.appendObservation({
    id: 'observation-room-rent', parameterRecordId: created.id,
    ...observationInput({ recordedBy: 'extractor-v1' }),
  });
  const resolved = repository.setResolution({
    parameterRecordId: created.id, state: 'extracted_unverified',
    resolvedValue: observation.value, observationId: observation.id,
    authority: 'model', updatedBy: 'extractor-v1',
  });
  assert.deepEqual(resolved.resolvedValue, { amountMinor: 500000 });
  assert.equal(resolved.resolvedObservationId, observation.id);
  assert.equal(resolved.authority, 'model');
  assert.equal(repository.listObservations(created.id).length, 1);
});

test('parameter persistence rejects unpinned versions, bad provenance and model authority escalation', t => {
  const { repository } = open(t);
  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });

  assert.throws(() => repository.createParameter({
    registryVersion: 'unknown-version', parameterKey: 'd.room_rent_limit', ...parameterScope(), updatedBy: 'test',
  }), /registryVersion is not supported/);
  assert.throws(() => repository.createParameter({
    registryVersion: 'policy-parameters/v1', parameterKey: 'd.not_in_registry', ...parameterScope(), updatedBy: 'test',
  }), /Unknown policy parameter key/);

  const parameter = repository.createParameter({
    id: 'parameter-security', registryVersion: 'policy-parameters/v1',
    parameterKey: 'a.policy_type', ...parameterScope(), updatedBy: 'test',
  });
  assert.throws(() => repository.appendObservation({
    parameterRecordId: parameter.id, ...observationInput({ version: 'wrong-version', value: true }),
  }), /source must match/);
  assert.throws(() => repository.setResolution({
    parameterRecordId: parameter.id, state: 'proven', resolvedValue: true,
    observationId: 'missing-observation', authority: 'model', updatedBy: 'extractor-v1',
  }), /must belong to the parameter/);
});

test('migration 005 applies once on a fresh database and is not re-applied', t => {
  const { database } = open(t);
  const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => row.version);
  assert.deepEqual(versions, [
    '001_initial_schema.sql', '002_integrity_and_provenance.sql', '003_tenant_auth_and_permissions.sql',
    '004_ocr_contract_and_provenance.sql', '005_evidence_completion_parameters.sql',
    '006_parameter_observation_guards.sql', '007_append_only_delete_guards.sql',
    '008_document_intake_scheduling.sql', '009_evidence_fact_redaction.sql',
    '010_evidence_fact_redaction_hardening.sql', '011_policy_structuring.sql',
    '012_source_page_blocks.sql',
    '013_policy_structuring_jobs.sql',
    '014_source_page_blocks_upgrade.sql',
  ]);
  assert.deepEqual(
    database.prepare('SELECT version FROM coverage_parameter_registry_versions').all().map(row => row.version),
    ['policy-parameters/v1'],
  );
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
});
