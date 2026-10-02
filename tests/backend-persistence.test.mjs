import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-backend-'));
  const path = join(directory, 'local.sqlite');
  let database = openDatabase({ path });
  const clock = () => new Date('2026-09-17T12:00:00.000Z');
  let services = createBackendServices(database, { clock });
  t.after(() => { try { database.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return {
    path,
    get database() { return database; },
    get services() { return services; },
    restart() { database.close(); database = openDatabase({ path }); services = createBackendServices(database, { clock }); },
  };
}

function seed(context) {
  const adult = context.services.households.createAdult({ id: 'adult-1', displayName: 'Synthetic adult' });
  const household = context.services.households.createHousehold({ id: 'household-1', displayName: 'Synthetic household', ownerAdultId: adult.id });
  const member = context.services.households.addMember({ id: 'member-1', householdId: household.id, adultUserId: adult.id, displayName: adult.display_name });
  return { adult, household, member };
}

test('households, cases and append-only audit history survive a database restart', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = context.services.cases.create({ id: 'case-1', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'planned_care' });
  const updated = context.services.cases.transition(record.id, 'collecting', { expectedRevision: record.revision, actorType: 'adult_user', actorId: adult.id });
  context.restart();
  assert.equal(context.services.cases.get(record.id).status, 'collecting');
  assert.equal(context.services.cases.get(record.id).revision, updated.revision);
  assert.ok(context.services.audit.listForCase(record.id).some(event => event.action === 'case.transitioned'));
});

test('case transitions reject stale revisions and invalid state jumps', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const changed = context.services.cases.transition(record.id, 'collecting', { expectedRevision: record.revision });
  assert.throws(() => context.services.cases.transition(record.id, 'processing', { expectedRevision: record.revision }), error => error.code === 'STALE_REVISION');
  assert.throws(() => context.services.cases.transition(changed.id, 'ready', { expectedRevision: changed.revision }), error => error.code === 'INVALID_CASE_TRANSITION');
});

test('document processing is consent scoped and revocation cancels queued tasks and provider outbox', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = context.services.cases.create({ id: 'case-consent', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'planned_care' });
  const grant = context.services.consents.grant({
    id: 'consent-docs', householdId: household.id, subjectAdultId: adult.id, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  assert.equal(context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: adult.id }).id, grant.id);
  assert.throws(() => context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: 'adult-other' }), error => error.code === 'CONSENT_REQUIRED');

  const run = context.services.workflows.createRun({ id: 'run-consent', caseId: record.id, workflowName: 'document-intake', consentGrantId: grant.id, input: {} });
  const task = context.services.workflows.enqueueTask({ id: 'task-consent', runId: run.id, agentName: 'sarvam-ocr', taskKind: 'ocr', input: {}, idempotencyKey: 'ocr-one' });
  const at = '2026-09-17T12:00:00.000Z';
  context.database.prepare(`INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES ('outbox-sarvam', ?, 'sarvam', 'ocr.submit', '{}', 'digest', ?, 'pending', ?, ?, ?)`)
    .run(record.id, grant.id, at, at, at);
  context.database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES ('document-ocr-revoke', ?, ?, ?, ?, 'policy_schedule', 'synthetic.pdf',
      'fixture/document-ocr-revoke', ?, 'application/pdf', 128, 'not_scanned_fixture',
      'fixture_only', 'active', ?, 'logical-ocr-revoke', '1')`)
    .run(household.id, record.id, adult.id, grant.id, 'a'.repeat(64), at);
  context.database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, requested_at,
     completed_at, contract_version, authorization_json, result_json, result_digest, updated_at)
    VALUES ('ocr-revoke', 'document-ocr-revoke', 'fixture', 'fixture-revoke', 'succeeded', 1, ?, ?,
      'knowvia.ocr.v1', '{}', ?, ?, ?)`)
    .run(at, at, JSON.stringify({ pages: [{ text: 'sensitive OCR text' }] }), 'b'.repeat(64), at);
  context.database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, confidence_basis_points, created_at,
     output_contract_version, text_sha256, provider_page_ref, provenance_json)
    VALUES ('page-revoke', 'document-ocr-revoke', 'ocr-revoke', 1, '1', ?,
      'sensitive OCR text', 'extracted', 9000, ?, 'knowvia.ocr.v1', ?, 'provider-page-1', ?)`)
    .run('c'.repeat(64), at, 'd'.repeat(64), JSON.stringify({ documentId: 'document-ocr-revoke', pageNumber: 1 }));

  context.services.consents.revoke({ grantId: grant.id, revokedByAdultId: adult.id, reason: 'Synthetic test' });
  assert.equal(context.database.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get(task.id).status, 'revoked');
  assert.equal(context.database.prepare("SELECT status FROM integration_outbox WHERE id = 'outbox-sarvam'").get().status, 'cancelled');
  const erasedJob = context.database.prepare("SELECT * FROM ocr_jobs WHERE id = 'ocr-revoke'").get();
  assert.equal(erasedJob.status, 'succeeded');
  assert.equal(erasedJob.result_json, null);
  assert.equal(erasedJob.result_digest, null);
  const erasedPage = context.database.prepare("SELECT * FROM source_pages WHERE id = 'page-revoke'").get();
  assert.equal(erasedPage.extracted_text, null);
  assert.equal(erasedPage.text_sha256, null);
  assert.equal(erasedPage.provider_page_ref, null);
  assert.equal(erasedPage.provenance_json, null);
  assert.equal(erasedPage.page_sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(erasedPage.source_version, 'revoked:page-revoke');
  assert.throws(() => context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: adult.id }), error => error.code === 'CONSENT_REQUIRED');
});

test('revocation invalidates only work derived from the revoked grant', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = context.services.cases.create({ id: 'case-specific-revoke', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const grantOne = context.services.consents.grant({
    id: 'consent-one', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  const grantTwo = context.services.consents.grant({
    id: 'consent-two', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  const first = context.services.workflows.createRun({ id: 'run-one', caseId: record.id, workflowName: 'coverage', consentGrantId: grantOne.id });
  const second = context.services.workflows.createRun({ id: 'run-two', caseId: record.id, workflowName: 'coverage', consentGrantId: grantTwo.id });
  context.services.workflows.enqueueTask({ runId: first.id, agentName: 'one', taskKind: 'analyse', idempotencyKey: 'grant-one-task' });
  context.services.workflows.enqueueTask({ runId: second.id, agentName: 'two', taskKind: 'analyse', idempotencyKey: 'grant-two-task' });

  context.services.consents.revoke({ grantId: grantOne.id, revokedByAdultId: adult.id });
  assert.equal(context.services.workflows.getRun(first.id).status, 'revoked');
  assert.equal(context.services.workflows.getRun(second.id).status, 'queued');
});

test('field access is exact to subject, viewer and field and fails closed after revocation', t => {
  const context = harness(t);
  const { adult, household } = seed(context);
  const viewer = context.services.households.createAdult({ id: 'adult-viewer', displayName: 'Synthetic viewer' });
  context.services.households.addRole({ householdId: household.id, adultUserId: viewer.id, role: 'viewer' });
  const grant = context.services.consents.grant({
    id: 'consent-field', householdId: household.id, subjectAdultId: adult.id, purpose: 'profile_intake',
    scopes: [{ resourceType: 'profile_field', resourceId: 'date_of_birth', action: 'read', dataCategory: 'identity', recipient: viewer.id }],
  });
  assert.equal(context.services.consents.canAccessField({ householdId: household.id, subjectAdultId: adult.id, viewerAdultId: viewer.id, fieldKey: 'date_of_birth' }), true);
  assert.equal(context.services.consents.canAccessField({ householdId: household.id, subjectAdultId: adult.id, viewerAdultId: viewer.id, fieldKey: 'medical_history' }), false);
  context.services.consents.revoke({ grantId: grant.id, revokedByAdultId: adult.id });
  assert.equal(context.services.consents.canAccessField({ householdId: household.id, subjectAdultId: adult.id, viewerAdultId: viewer.id, fieldKey: 'date_of_birth' }), false);
});

test('workflow task enqueue is idempotent and transactionally claimable once', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const run = context.services.workflows.createRun({ caseId: record.id, workflowName: 'coverage-reconstruction', input: { caseRevision: record.revision } });
  const request = { runId: run.id, agentName: 'profile-intake', taskKind: 'analyse', input: { caseId: record.id }, idempotencyKey: 'case-profile-v1' };
  const first = context.services.workflows.enqueueTask(request);
  const repeated = context.services.workflows.enqueueTask(request);
  assert.equal(first.id, repeated.id);
  assert.throws(() => context.services.workflows.enqueueTask({ ...request, input: { changed: true } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal(context.services.workflows.claimNext({ workerId: 'worker-a' }).id, first.id);
  assert.equal(context.services.workflows.claimNext({ workerId: 'worker-b' }), null);
  context.services.workflows.completeTask(first.id, { output: { status: 'unknowns_preserved' } });
  assert.equal(context.database.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id).status, 'completed');
});

test('emergency instruction is available before processing consent', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'emergency' });
  assert.equal(record.emergencyInstruction.headline, 'Admit first. Optimise later.');
  assert.equal(record.emergencyInstruction.processingConsentRequired, false);
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM consent_grants').get().count, 0);
});
