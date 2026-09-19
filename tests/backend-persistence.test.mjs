import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';

function harness(t) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-backend-'));
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

  const run = context.services.workflows.createRun({ id: 'run-consent', caseId: record.id, workflowName: 'document-intake', input: {} });
  const task = context.services.workflows.enqueueTask({ id: 'task-consent', runId: run.id, agentName: 'sarvam-ocr', taskKind: 'ocr', input: {}, idempotencyKey: 'ocr-one' });
  const at = '2026-09-17T12:00:00.000Z';
  context.database.prepare(`INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES ('outbox-sarvam', ?, 'sarvam', 'ocr.submit', '{}', 'digest', ?, 'pending', ?, ?, ?)`)
    .run(record.id, grant.id, at, at, at);

  context.services.consents.revoke({ grantId: grant.id, revokedByAdultId: adult.id, reason: 'Synthetic test' });
  assert.equal(context.database.prepare('SELECT status FROM workflow_tasks WHERE id = ?').get(task.id).status, 'revoked');
  assert.equal(context.database.prepare("SELECT status FROM integration_outbox WHERE id = 'outbox-sarvam'").get().status, 'cancelled');
  assert.throws(() => context.services.requireDocumentProcessingConsent({ consentGrantId: grant.id, subjectAdultId: adult.id }), error => error.code === 'CONSENT_REQUIRED');
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

