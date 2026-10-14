import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { CoverageParameterRepository } from '../src/backend/repositories/coverage-parameter-repository.js';

const at = '2026-10-09T10:00:00.000Z';

function seed(database) {
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-parameters', 'Synthetic household', at, at);
  database.prepare(`INSERT INTO adult_users
    (id, display_name, account_status, created_at, updated_at) VALUES ('adult-parameters', 'Adult', 'active', ?, ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-parameters', 'household-parameters', 'adult-parameters', 'owner', 'active', ?)`)
    .run(at);
  database.prepare(`INSERT INTO household_members
    (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-parameters', 'household-parameters', 'adult-parameters', 'Adult', 'adult', ?, ?)`)
    .run(at, at);
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, created_at)
    VALUES ('consent-parameters', 'household-parameters', 'adult-parameters', 'knowvia-local',
      'document_processing', 'v1', 'fixture', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('case-parameters', 'household-parameters', 'member-parameters', 'adult-parameters',
      'renewal', 'processing', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO policies
    (id, household_id, policy_kind, verification_state, created_at, updated_at)
    VALUES ('policy-parameters', 'household-parameters', 'personal', 'unverified', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES ('document-parameters', 'household-parameters', 'case-parameters', 'adult-parameters',
      'consent-parameters', 'policy_schedule', 'fixture.pdf', 'fixture/parameters', ?,
      'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`)
    .run('a'.repeat(64), at);
  database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, status, attempt_count, requested_at, completed_at, updated_at)
    VALUES ('ocr-parameters', 'document-parameters', 'fixture', 'succeeded', 1, ?, ?, ?)`)
    .run(at, at, at);
  database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, created_at, text_sha256)
    VALUES ('page-parameters', 'document-parameters', 'ocr-parameters', 2, 'version-1', ?,
      'Synthetic clause', 'extracted', ?, ?)`).run('b'.repeat(64), at, 'c'.repeat(64));
  database.prepare(`INSERT INTO workflow_runs
    (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
     input_json, created_at)
    VALUES ('run-parameters', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture',
      'queued', ?, '{}', ?)`).run('d'.repeat(64), at);
}

test('parameter persistence pins a registry and keeps acquisition separate from resolution', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seed(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });

  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });
  const created = repository.createParameter({
    id: 'parameter-room-rent', workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1',
    parameterKey: 'd.room_rent_limit', householdId: 'household-parameters', caseId: 'case-parameters',
    subjectId: 'member-parameters', policyId: 'policy-parameters', updatedBy: 'test',
  });
  assert.equal(created.acquisitionState, 'not_requested');
  assert.equal(created.resolutionState, 'unknown');

  repository.setAcquisitionState({ parameterRecordId: created.id, state: 'requested', updatedBy: 'test' });
  const acquired = repository.setAcquisitionState({ parameterRecordId: created.id, state: 'received', updatedBy: 'test' });
  assert.equal(acquired.acquisitionState, 'received');
  assert.equal(acquired.resolutionState, 'unknown');

  const observation = repository.appendObservation({
    id: 'observation-room-rent', parameterRecordId: created.id, sourceId: 'page-parameters',
    documentId: 'document-parameters', version: 'version-1', page: 2,
    extractionMethod: 'document_extraction', value: { amountMinor: 500000 },
    sourceDigest: 'e'.repeat(64), recordedBy: 'extractor-v1',
  });
  const resolved = repository.setResolution({
    parameterRecordId: created.id, state: 'extracted_unverified',
    resolvedValue: observation.value, observationId: observation.id,
    authority: 'model', updatedBy: 'extractor-v1',
  });
  assert.deepEqual(resolved.resolvedValue, { amountMinor: 500000 });
  assert.equal(resolved.resolvedObservationId, observation.id);
  assert.equal(repository.listObservations(created.id).length, 1);
});

test('parameter persistence rejects unpinned versions, bad provenance and model authority escalation', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seed(database);
  const repository = new CoverageParameterRepository(database, { clock: () => new Date(at) });
  repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });

  assert.throws(() => repository.createParameter({
    workflowRunId: 'run-parameters', registryVersion: 'unknown-version', parameterKey: 'd.room_rent_limit',
    householdId: 'household-parameters', caseId: 'case-parameters', subjectId: 'member-parameters',
    policyId: 'policy-parameters', updatedBy: 'test',
  }), /registryVersion is not supported/);

  const parameter = repository.createParameter({
    id: 'parameter-security', workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1',
    parameterKey: 'a.policy_type', householdId: 'household-parameters', caseId: 'case-parameters',
    subjectId: 'member-parameters', policyId: 'policy-parameters', updatedBy: 'test',
  });
  assert.throws(() => repository.appendObservation({
    parameterRecordId: parameter.id, sourceId: 'page-parameters', documentId: 'document-parameters',
    version: 'wrong-version', page: 2, extractionMethod: 'document_extraction', value: true,
    sourceDigest: 'e'.repeat(64), recordedBy: 'extractor-v1',
  }), /source must match/);
  assert.throws(() => repository.setResolution({
    parameterRecordId: parameter.id, state: 'proven', resolvedValue: true,
    observationId: 'missing-observation', authority: 'model', updatedBy: 'extractor-v1',
  }), /model authority cannot set/);
});
