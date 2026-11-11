import test from 'node:test';
import assert from 'node:assert/strict';
import { CoverageParameterRepository } from '../src/backend/repositories/coverage-parameter-repository.js';
import { observationInput, parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();

async function open(t) {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  return { database, repository: new CoverageParameterRepository(database, { clock: () => new Date(at) }) };
}

test('parameter persistence pins a registry and keeps acquisition separate from resolution', pgOptions, async t => {
  const { repository } = await open(t);

  await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });
  const created = await repository.createParameter({
    id: 'parameter-room-rent', registryVersion: 'policy-parameters/v1',
    parameterKey: 'd.room_rent_limit', ...parameterScope(), updatedBy: 'test',
  });
  assert.equal(created.acquisitionState, 'not_requested');
  assert.equal(created.resolutionState, 'unknown');

  await repository.setAcquisitionState({ parameterRecordId: created.id, state: 'requested', updatedBy: 'test' });
  const acquired = await repository.setAcquisitionState({ parameterRecordId: created.id, state: 'received', updatedBy: 'test' });
  assert.equal(acquired.acquisitionState, 'received');
  assert.equal(acquired.resolutionState, 'unknown');

  const observation = await repository.appendObservation({
    id: 'observation-room-rent', parameterRecordId: created.id,
    ...observationInput({ recordedBy: 'extractor-v1' }),
  });
  const resolved = await repository.setResolution({
    parameterRecordId: created.id, state: 'extracted_unverified',
    resolvedValue: observation.value, observationId: observation.id,
    authority: 'model', updatedBy: 'extractor-v1',
  });
  assert.deepEqual(resolved.resolvedValue, { amountMinor: 500000 });
  assert.equal(resolved.resolvedObservationId, observation.id);
  assert.equal(resolved.authority, 'model');
  assert.equal((await repository.listObservations(created.id)).length, 1);
});

test('parameter persistence rejects unpinned versions, bad provenance and model authority escalation', pgOptions, async t => {
  const { repository } = await open(t);
  await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });

  await assert.rejects(repository.createParameter({
    registryVersion: 'unknown-version', parameterKey: 'd.room_rent_limit', ...parameterScope(), updatedBy: 'test',
  }), /registryVersion is not supported/);
  await assert.rejects(repository.createParameter({
    registryVersion: 'policy-parameters/v1', parameterKey: 'd.not_in_registry', ...parameterScope(), updatedBy: 'test',
  }), /Unknown policy parameter key/);

  const parameter = await repository.createParameter({
    id: 'parameter-security', registryVersion: 'policy-parameters/v1',
    parameterKey: 'a.policy_type', ...parameterScope(), updatedBy: 'test',
  });
  await assert.rejects(repository.appendObservation({
    parameterRecordId: parameter.id, ...observationInput({ version: 'wrong-version', value: true }),
  }), /source must match/);
  await assert.rejects(repository.setResolution({
    parameterRecordId: parameter.id, state: 'proven', resolvedValue: true,
    observationId: 'missing-observation', authority: 'model', updatedBy: 'extractor-v1',
  }), /must belong to the parameter/);
});

// The evidence-completion tables (SQLite migration 005) live in the PostgreSQL baseline.
test('the PostgreSQL migration set applies once on a fresh database and is not re-applied', pgOptions, async t => {
  const { database } = await open(t);
  const versions = (await database.prepare('SELECT version FROM schema_migrations ORDER BY version').all()).map(row => row.version);
  assert.deepEqual(versions, [
    '001_baseline_schema.sql', '002_baseline_triggers.sql', '003_harden_invariants.sql',
    '004_document_intake_scheduling.sql', '005_evidence_fact_redaction.sql',
    '006_evidence_fact_redaction_hardening.sql', '007_policy_structuring.sql',
    '008_julianday_hour_24.sql', '009_source_page_blocks.sql',
    '010_policy_structuring_jobs.sql', '011_source_page_blocks_upgrade.sql',
    '012_policy_evidence.sql', '013_catalogue_reviews.sql',
    '014_curated_product_workflow.sql', '015_curated_signed_actions.sql',
    '016_data_api_lockdown.sql', '017_auth_identities.sql', '018_profile_answers.sql',
    '019_column_encryption_prep.sql', '020_document_blobs.sql', '021_sealed_column_checks.sql', '022_app_events.sql', '023_runtime_limits.sql', '024_hot_path_indexes.sql', '025_device_permissions.sql', '026_household_places.sql', '027_adult_preferences_onboarding.sql', '028_tool_scenarios.sql', '029_adult_contacts.sql', '030_seal_remaining_columns.sql', '032_evidence_claims.sql', '033_reference_cache.sql', '034_job_queue.sql', '035_policy_answers_erasure_scope.sql', '036_fk_and_erasure_indexes.sql', '037_job_queue_hardening.sql', '039_session_capacity_index.sql', '040_idempotency_scope_columns.sql', '041_case_policy_type.sql', '042_document_page_count.sql', '043_policy_profiles.sql', '044_policy_facts.sql', '045_auth_tokens.sql', '046_sync_change_log.sql', '047_person_records.sql', '048_policy_holdings.sql', '049_household_memory_facts.sql', '050_memory_conflicts.sql', '051_member_declarations.sql', '052_premium_payments_dues.sql', '056_provider_calls.sql',
  ]);
  assert.deepEqual(
    (await database.prepare('SELECT version FROM coverage_parameter_registry_versions').all()).map(row => row.version),
    ['policy-parameters/v1'],
  );
  // PostgreSQL enforces foreign keys on write; every foreign key constraint must also be validated.
  assert.equal((await database.prepare("SELECT count(*) AS count FROM pg_constraint WHERE contype = 'f' AND NOT convalidated").get()).count, 0);
  assert.ok((await database.prepare("SELECT count(*) AS count FROM pg_constraint WHERE contype = 'f'").get()).count > 0);
});
