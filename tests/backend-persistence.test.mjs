import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { createPostgresPool } from '../src/backend/database/postgres/index.js';
import { AuditRepository, CaseRepository, WorkflowRepository } from '../src/backend/repositories/index.js';
import { createBackendServices } from '../src/backend/services/index.js';

const pg = postgresTestOptions();
const clock = () => new Date('2026-09-17T12:00:00.000Z');

// PostgreSQL (S3.2): the case, workflow and audit repositories are async. Households are seeded
// with direct SQL because the household repository is converted separately.
async function pgHarness(t) {
  const { db, handle } = await freshDatabase(t, { clock });
  const build = database => {
    const audit = new AuditRepository(database, { clock });
    return { audit, cases: new CaseRepository(database, { clock, audit }), workflows: new WorkflowRepository(database, { clock, audit }) };
  };
  let services = build(db);
  const restarted = [];
  t.after(async () => { for (const pool of restarted) await pool.end().catch(() => {}); });
  return {
    database: db,
    get services() { return services; },
    // A new pool and interface over the same database: nothing survives in process memory.
    restart() {
      const pool = createPostgresPool({ connectionString: handle.url, max: 2, applicationName: 'coversaath-test-restart' });
      restarted.push(pool);
      services = build(createDatabase(pool));
    },
  };
}

async function pgSeed(db) {
  const at = clock().toISOString();
  await db.run(`INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at)
    VALUES ('adult-1', 'Synthetic adult', 'en-IN', 'active', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO households (id, display_name, created_at, updated_at)
    VALUES ('household-1', 'Synthetic household', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, starts_at, created_at)
    VALUES ('role-1', 'household-1', 'adult-1', 'owner', 'active', ?, ?)`, [at, at]);
  await db.run(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-1', 'household-1', 'adult-1', 'Synthetic adult', 'adult', ?, ?)`, [at, at]);
  return { adult: { id: 'adult-1' }, household: { id: 'household-1' }, member: { id: 'member-1' } };
}

// node:sqlite harness for the consent-revocation tests below. They exercise ConsentRepository,
// which another S3.2 work package converts to PostgreSQL, so case, run and task rows are seeded
// with direct SQL here instead of through the now-async case and workflow repositories.
function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-backend-'));
  const path = join(directory, 'local.sqlite');
  const database = openDatabase({ path });
  const services = createBackendServices(database, { clock });
  t.after(() => { try { database.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  return { path, database, services };
}

function seed(context) {
  const adult = context.services.households.createAdult({ id: 'adult-1', displayName: 'Synthetic adult' });
  const household = context.services.households.createHousehold({ id: 'household-1', displayName: 'Synthetic household', ownerAdultId: adult.id });
  const member = context.services.households.addMember({ id: 'member-1', householdId: household.id, adultUserId: adult.id, displayName: adult.display_name });
  return { adult, household, member };
}

function sqliteCase(context, { id, householdId, subjectMemberId, openedByAdultId, triggerType }) {
  const at = clock().toISOString();
  context.database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, emergency_mode, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'created', 0, ?, ?)`).run(id, householdId, subjectMemberId, openedByAdultId, triggerType, at, at);
  return { id };
}

function sqliteRun(context, { id, caseId, workflowName, consentGrantId }) {
  const at = clock().toISOString();
  context.database.prepare(`INSERT INTO workflow_runs
    (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest, consent_grant_id, input_json, created_at)
    VALUES (?, ?, ?, 'v1', 'live', 'queued', 'digest', ?, '{}', ?)`).run(id, caseId, workflowName, consentGrantId, at);
  return { id };
}

function sqliteTask(context, { id, runId, agentName, taskKind }) {
  const at = clock().toISOString();
  context.database.prepare(`INSERT INTO workflow_tasks
    (id, workflow_run_id, agent_name, task_kind, status, input_digest, input_json, created_at)
    VALUES (?, ?, ?, ?, 'pending', 'digest', '{}', ?)`).run(id, runId, agentName, taskKind, at);
  return { id };
}

test('households, cases and append-only audit history survive a database restart', pg, async t => {
  const context = await pgHarness(t);
  const { adult, household, member } = await pgSeed(context.database);
  const record = await context.services.cases.create({ id: 'case-1', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'planned_care' });
  const updated = await context.services.cases.transition(record.id, 'collecting', { expectedRevision: record.revision, actorType: 'adult_user', actorId: adult.id });
  context.restart();
  assert.equal((await context.services.cases.get(record.id)).status, 'collecting');
  assert.equal((await context.services.cases.get(record.id)).revision, updated.revision);
  const events = await context.services.audit.listForCase(record.id);
  assert.deepEqual(events.map(event => event.action), ['case.created', 'case.transitioned']);
  assert.equal(events[1].previous_event_hash, events[0].event_hash, 'case events extend one household chain');
});

test('case transitions reject stale revisions and invalid state jumps', pg, async t => {
  const context = await pgHarness(t);
  const { adult, household, member } = await pgSeed(context.database);
  const record = await context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const changed = await context.services.cases.transition(record.id, 'collecting', { expectedRevision: record.revision });
  await assert.rejects(context.services.cases.transition(record.id, 'processing', { expectedRevision: record.revision }), error => error.code === 'STALE_REVISION');
  await assert.rejects(context.services.cases.transition(changed.id, 'ready', { expectedRevision: changed.revision }), error => error.code === 'INVALID_CASE_TRANSITION');
  await assert.rejects(context.services.cases.transition('case-missing', 'collecting', { expectedRevision: changed.revision }), /Case not found/);
  assert.equal((await context.services.cases.get(record.id)).status, 'collecting');
});

test('case writes roll back when their audit event fails (the audit append is awaited)', pg, async t => {
  const context = await pgHarness(t);
  const { adult, household, member } = await pgSeed(context.database);
  // The append rejects only after a tick: a missing await would let the write commit.
  const failing = { append: async () => { await new Promise(done => setImmediate(done)); throw new Error('synthetic audit failure'); } };
  const cases = new CaseRepository(context.database, { clock, audit: failing });
  await assert.rejects(cases.create({ id: 'case-audit-fail', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' }), /synthetic audit failure/);
  assert.equal(await context.services.cases.get('case-audit-fail'), null, 'no case without its audit event');
  const record = await context.services.cases.create({ id: 'case-audit-ok', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  await assert.rejects(cases.transition(record.id, 'collecting', { expectedRevision: record.revision }), /synthetic audit failure/);
  const after = await context.services.cases.get(record.id);
  assert.equal(after.status, 'created', 'no transition without its audit event');
  assert.equal(after.revision, record.revision);
});

test('document processing is consent scoped and revocation cancels queued tasks and provider outbox', t => {
  const context = harness(t);
  const { adult, household, member } = seed(context);
  const record = sqliteCase(context, { id: 'case-consent', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'planned_care' });
  const grant = context.services.consents.grant({
    id: 'consent-docs', householdId: household.id, subjectAdultId: adult.id, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  assert.equal(context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: adult.id }).id, grant.id);
  assert.throws(() => context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: 'adult-other' }), error => error.code === 'CONSENT_REQUIRED');

  const run = sqliteRun(context, { id: 'run-consent', caseId: record.id, workflowName: 'document-intake', consentGrantId: grant.id });
  const task = sqliteTask(context, { id: 'task-consent', runId: run.id, agentName: 'sarvam-ocr', taskKind: 'ocr' });
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
  const record = sqliteCase(context, { id: 'case-specific-revoke', householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const grantOne = context.services.consents.grant({
    id: 'consent-one', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  const grantTwo = context.services.consents.grant({
    id: 'consent-two', householdId: household.id, subjectAdultId: adult.id, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: record.id, action: 'derive', dataCategory: 'insurance_document' }],
  });
  const first = sqliteRun(context, { id: 'run-one', caseId: record.id, workflowName: 'coverage', consentGrantId: grantOne.id });
  const second = sqliteRun(context, { id: 'run-two', caseId: record.id, workflowName: 'coverage', consentGrantId: grantTwo.id });
  sqliteTask(context, { id: 'task-one', runId: first.id, agentName: 'one', taskKind: 'analyse' });
  sqliteTask(context, { id: 'task-two', runId: second.id, agentName: 'two', taskKind: 'analyse' });

  context.services.consents.revoke({ grantId: grantOne.id, revokedByAdultId: adult.id });
  const runStatus = runId => context.database.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(runId).status;
  assert.equal(runStatus(first.id), 'revoked');
  assert.equal(runStatus(second.id), 'queued');
});

test('revoking a provider disclosure grant cancels and erases its OCR without deleting the upload', t => {
  const context = harness(t);
  const { adult, household } = seed(context);
  const collection = context.services.consents.grant({
    id: 'consent-collection', householdId: household.id, subjectAdultId: adult.id, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  const at = '2026-09-17T12:00:00.000Z';
  context.database.prepare(`INSERT INTO document_uploads
    (id, household_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES ('document-provider-revoke', ?, ?, ?, 'policy_schedule', 'synthetic.pdf',
      'fixture/document-provider-revoke', ?, 'application/pdf', 128, 'clean',
      'fixture_only', 'active', ?, 'logical-provider-revoke', '1')`)
    .run(household.id, adult.id, collection.id, 'a'.repeat(64), at);
  const disclosure = context.services.consents.grant({
    id: 'consent-sarvam-revoke', householdId: household.id, subjectAdultId: adult.id,
    grantedToActor: 'sarvam', purpose: 'document_processing',
    scopes: [{ resourceType: 'document', resourceId: 'document-provider-revoke', action: 'derive', dataCategory: 'insurance_document', recipient: 'sarvam' }],
  });
  context.database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, requested_at,
     started_at, contract_version, authorization_json, updated_at)
    VALUES ('ocr-provider-revoke', 'document-provider-revoke', 'sarvam', 'remote-job', 'processing', 1, ?, ?,
      'knowvia.ocr.v1', ?, ?)`)
    .run(at, at, JSON.stringify({ consentGrantId: disclosure.id }), at);
  context.database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, created_at, output_contract_version, text_sha256)
    VALUES ('page-provider-revoke', 'document-provider-revoke', 'ocr-provider-revoke', 1, '1', ?,
      'sensitive OCR text', 'extracted', ?, 'knowvia.ocr.v1', ?)`)
    .run('b'.repeat(64), at, 'c'.repeat(64));

  context.services.consents.revoke({ grantId: disclosure.id, revokedByAdultId: adult.id });

  assert.deepEqual({ ...context.database.prepare(`SELECT status, error_code, provider_job_ref
    FROM ocr_jobs WHERE id = 'ocr-provider-revoke'`).get() }, {
    status: 'cancelled', error_code: 'CONSENT_REVOKED', provider_job_ref: 'remote-job',
  });
  assert.equal(context.database.prepare(`SELECT extracted_text FROM source_pages
    WHERE id = 'page-provider-revoke'`).get().extracted_text, null);
  assert.equal(context.database.prepare(`SELECT lifecycle_state FROM document_uploads
    WHERE id = 'document-provider-revoke'`).get().lifecycle_state, 'active');
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

test('workflow task enqueue is idempotent and transactionally claimable once', pg, async t => {
  const context = await pgHarness(t);
  const { adult, household, member } = await pgSeed(context.database);
  const record = await context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'renewal' });
  const run = await context.services.workflows.createRun({ caseId: record.id, workflowName: 'coverage-reconstruction', input: { caseRevision: record.revision } });
  const request = { runId: run.id, agentName: 'profile-intake', taskKind: 'analyse', input: { caseId: record.id }, idempotencyKey: 'case-profile-v1' };
  const first = await context.services.workflows.enqueueTask(request);
  const repeated = await context.services.workflows.enqueueTask(request);
  assert.equal(first.id, repeated.id);
  await assert.rejects(context.services.workflows.enqueueTask({ ...request, input: { changed: true } }), error => error.code === 'IDEMPOTENCY_CONFLICT');
  assert.equal((await context.services.workflows.claimNext({ workerId: 'worker-a' })).id, first.id);
  assert.equal(await context.services.workflows.claimNext({ workerId: 'worker-b' }), null);
  await context.services.workflows.completeTask(first.id, { output: { status: 'unknowns_preserved' } });
  assert.equal((await context.database.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.id)).status, 'completed');
});

test('emergency instruction is available before processing consent', pg, async t => {
  const context = await pgHarness(t);
  const { adult, household, member } = await pgSeed(context.database);
  const record = await context.services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: adult.id, triggerType: 'emergency' });
  assert.equal(record.emergencyInstruction.headline, 'Admit first. Optimise later.');
  assert.equal(record.emergencyInstruction.processingConsentRequired, false);
  assert.equal(record.emergency_mode, 1);
  assert.equal((await context.database.prepare('SELECT count(*) AS count FROM consent_grants').get()).count, 0);
});
