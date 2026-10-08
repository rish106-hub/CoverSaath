import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices } from '../src/backend/services/index.js';
import { createDurableTestDatabase, sql } from './helpers/test-database.js';

async function harness(t) {
  // A durable on-disk PGlite so restart() proves the data survives closing and reopening the database.
  const durable = await createDurableTestDatabase();
  let database = await durable.open();
  const clock = () => new Date('2026-09-17T12:00:00.000Z');
  let services = createBackendServices(database, { clock });
  t.after(async () => { await database.close().catch(() => {}); durable.cleanup(); });
  return {
    get database() { return database; },
    get services() { return services; },
    async restart() { await database.close(); database = await durable.open(); services = createBackendServices(database, { clock }); },
  };
}

async function seed(context) {
  const adult = await context.services.households.createAdult({ id: 'adult-1', displayName: 'Synthetic adult' });
  const household = await context.services.households.createHousehold({ id: 'household-1', displayName: 'Synthetic household', ownerAdultId: adult.id });
  const member = await context.services.households.addMember({ id: 'member-1', householdId: household.id, adultUserId: adult.id, displayName: adult.display_name });
  return { adult, household, member };
}

test('households, cases and append-only audit history survive a database restart', async t => {
  const context = await harness(t);
  const { adult, household, member } = await seed(context);
  const record = await context.services.cases.create({ id: 'case-1', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'planned_care' });
  const updated = await context.services.cases.transition(record.id, 'collecting', { expectedRevision: record.revision, actorType: 'adult_user', actorId: adult.id });
  await context.restart();
  assert.equal((await context.services.cases.get(record.id)).status, 'collecting');
  assert.equal((await context.services.cases.get(record.id)).revision, updated.revision);
  assert.ok((await context.services.audit.listForCase(record.id)).some(event => event.action === 'case.transitioned'));
});

test('case transitions reject stale revisions and invalid state jumps', async t => {
  const context = await harness(t);
  const { adult, household, member } = await seed(context);
  const record = await context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const changed = await context.services.cases.transition(record.id, 'collecting', { expectedRevision: record.revision });
  await assert.rejects(async () => await context.services.cases.transition(record.id, 'processing', { expectedRevision: record.revision }), error => error.code === 'STALE_REVISION');
  await assert.rejects(async () => await context.services.cases.transition(changed.id, 'ready', { expectedRevision: changed.revision }), error => error.code === 'INVALID_CASE_TRANSITION');
});

test('document processing is consent scoped and revocation cancels queued tasks and provider outbox', async t => {
  const context = await harness(t);
  const { adult, household, member } = await seed(context);
  const record = await context.services.cases.create({ id: 'case-consent', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'planned_care' });
  const grant = await context.services.consents.grant({
    id: 'consent-docs', householdId: household.id, subjectAdultId: adult.id, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  assert.equal((await context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: adult.id })).id, grant.id);
  await assert.rejects(async () => await context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: 'adult-other' }), error => error.code === 'CONSENT_REQUIRED');

  const run = await context.services.workflows.createRun({ id: 'run-consent', caseId: record.id, workflowName: 'document-intake', consentGrantId: grant.id, input: {} });
  const task = await context.services.workflows.enqueueTask({ id: 'task-consent', runId: run.id, agentName: 'sarvam-ocr', taskKind: 'ocr', input: {}, idempotencyKey: 'ocr-one' });
  const at = '2026-09-17T12:00:00.000Z';
  await sql.run(context.database, `INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES ('outbox-sarvam', ?, 'sarvam', 'ocr.submit', '{}', 'digest', ?, 'pending', ?, ?, ?)`, record.id, grant.id, at, at, at);
  await sql.run(context.database, `INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES ('document-ocr-revoke', ?, ?, ?, ?, 'policy_schedule', 'synthetic.pdf',
      'fixture/document-ocr-revoke', ?, 'application/pdf', 128, 'not_scanned_fixture',
      'fixture_only', 'active', ?, 'logical-ocr-revoke', '1')`, household.id, record.id, adult.id, grant.id, 'a'.repeat(64), at);
  await sql.run(context.database, `INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, requested_at,
     completed_at, contract_version, authorization_json, result_json, result_digest, updated_at)
    VALUES ('ocr-revoke', 'document-ocr-revoke', 'fixture', 'fixture-revoke', 'succeeded', 1, ?, ?,
      'knowvia.ocr.v1', '{}', ?, ?, ?)`, at, at, JSON.stringify({ pages: [{ text: 'sensitive OCR text' }] }), 'b'.repeat(64), at);
  await sql.run(context.database, `INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, confidence_basis_points, created_at,
     output_contract_version, text_sha256, provider_page_ref, provenance_json)
    VALUES ('page-revoke', 'document-ocr-revoke', 'ocr-revoke', 1, '1', ?,
      'sensitive OCR text', 'extracted', 9000, ?, 'knowvia.ocr.v1', ?, 'provider-page-1', ?)`, 'c'.repeat(64), at, 'd'.repeat(64), JSON.stringify({ documentId: 'document-ocr-revoke', pageNumber: 1 }));

  await context.services.consents.revoke({ grantId: grant.id, revokedByAdultId: adult.id, reason: 'Synthetic test' });
  assert.equal((await sql.get(context.database, 'SELECT status FROM workflow_tasks WHERE id = ?', task.id)).status, 'revoked');
  assert.equal((await sql.get(context.database, "SELECT status FROM integration_outbox WHERE id = 'outbox-sarvam'")).status, 'cancelled');
  const erasedJob = await sql.get(context.database, "SELECT * FROM ocr_jobs WHERE id = 'ocr-revoke'");
  assert.equal(erasedJob.status, 'succeeded');
  assert.equal(erasedJob.result_json, null);
  assert.equal(erasedJob.result_digest, null);
  const erasedPage = await sql.get(context.database, "SELECT * FROM source_pages WHERE id = 'page-revoke'");
  assert.equal(erasedPage.extracted_text, null);
  assert.equal(erasedPage.text_sha256, null);
  assert.equal(erasedPage.provider_page_ref, null);
  assert.equal(erasedPage.provenance_json, null);
  assert.equal(erasedPage.page_sha256, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(erasedPage.source_version, 'revoked:page-revoke');
  await assert.rejects(async () => await context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: adult.id }), error => error.code === 'CONSENT_REQUIRED');
});

test('revocation invalidates only work derived from the revoked grant', async t => {
  const context = await harness(t);
  const { adult, household, member } = await seed(context);
  const record = await context.services.cases.create({ id: 'case-specific-revoke', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const grantOne = await context.services.consents.grant({
    id: 'consent-one', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  const grantTwo = await context.services.consents.grant({
    id: 'consent-two', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  const first = await context.services.workflows.createRun({ id: 'run-one', caseId: record.id, workflowName: 'coverage', consentGrantId: grantOne.id });
  const second = await context.services.workflows.createRun({ id: 'run-two', caseId: record.id, workflowName: 'coverage', consentGrantId: grantTwo.id });
  await context.services.workflows.enqueueTask({ runId: first.id, agentName: 'one', taskKind: 'analyse', idempotencyKey: 'grant-one-task' });
  await context.services.workflows.enqueueTask({ runId: second.id, agentName: 'two', taskKind: 'analyse', idempotencyKey: 'grant-two-task' });

  await context.services.consents.revoke({ grantId: grantOne.id, revokedByAdultId: adult.id });
  assert.equal((await context.services.workflows.getRun(first.id)).status, 'revoked');
  assert.equal((await context.services.workflows.getRun(second.id)).status, 'queued');
});

test('field access is exact to subject, viewer and field and fails closed after revocation', async t => {
  const context = await harness(t);
  const { adult, household } = await seed(context);
  const viewer = await context.services.households.createAdult({ id: 'adult-viewer', displayName: 'Synthetic viewer' });
  await context.services.households.addRole({ householdId: household.id, adultUserId: viewer.id, role: 'viewer' });
  const grant = await context.services.consents.grant({
    id: 'consent-field', householdId: household.id, subjectAdultId: adult.id, purpose: 'profile_intake',
    scopes: [{ resourceType: 'profile_field', resourceId: 'date_of_birth', action: 'read', dataCategory: 'identity', recipient: viewer.id }],
  });
  assert.equal(await context.services.consents.canAccessField({ householdId: household.id, subjectAdultId: adult.id, viewerAdultId: viewer.id, fieldKey: 'date_of_birth' }), true);
  assert.equal(await context.services.consents.canAccessField({ householdId: household.id, subjectAdultId: adult.id, viewerAdultId: viewer.id, fieldKey: 'medical_history' }), false);
  await context.services.consents.revoke({ grantId: grant.id, revokedByAdultId: adult.id });
  assert.equal(await context.services.consents.canAccessField({ householdId: household.id, subjectAdultId: adult.id, viewerAdultId: viewer.id, fieldKey: 'date_of_birth' }), false);
});

test('workflow task enqueue is idempotent and transactionally claimable once', async t => {
  const context = await harness(t);
  const { adult, household, member } = await seed(context);
  const record = await context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const run = await context.services.workflows.createRun({ caseId: record.id, workflowName: 'coverage-reconstruction', input: { caseRevision: record.revision } });
  const request = { runId: run.id, agentName: 'profile-intake', taskKind: 'analyse', input: { caseId: record.id }, idempotencyKey: 'case-profile-v1' };
  const first = await context.services.workflows.enqueueTask(request);
  const repeated = await context.services.workflows.enqueueTask(request);
  assert.equal(first.id, repeated.id);
  await assert.rejects(async () => await context.services.workflows.enqueueTask({ ...request, input: { changed: true } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal((await context.services.workflows.claimNext({ workerId: 'worker-a' })).id, first.id);
  assert.equal(await context.services.workflows.claimNext({ workerId: 'worker-b' }), null);
  await context.services.workflows.completeTask(first.id, { output: { status: 'unknowns_preserved' } });
  assert.equal((await sql.get(context.database, 'SELECT status FROM workflow_runs WHERE id = ?', run.id)).status, 'completed');
});

test('emergency instruction is available before processing consent', async t => {
  const context = await harness(t);
  const { adult, household, member } = await seed(context);
  const record = await context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'emergency' });
  assert.equal(record.emergencyInstruction.headline, 'Admit first. Optimise later.');
  assert.equal(record.emergencyInstruction.processingConsentRequired, false);
  assert.equal((await sql.get(context.database, 'SELECT count(*) AS count FROM consent_grants')).count, 0);
});
