import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createApiServer } from '../src/server/server.js';

const bootstrapToken = 'knowvia-test-bootstrap-token-00001';

async function start(database) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    async call(path, { method = 'GET', body, idempotencyKey, token } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

const stop = server => new Promise(resolve => server.close(resolve));

test('versioned backend persists cases and queued analysis across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-backend-api-'));
  const databasePath = join(directory, 'knowvia.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let database = openDatabase({ path: databasePath });
  let app = await start(database);
  t.after(async () => {
    if (app?.server?.listening) await stop(app.server);
    try { database.close(); } catch {}
  });

  const health = await app.call('/api/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.service, 'knowvia-api');

  const readiness = await app.call('/api/v1/ready');
  assert.equal(readiness.status, 200);
  assert.equal(readiness.data.database.valid, true);

  const unauthenticated = await app.call('/api/v1/integrations');
  assert.equal(unauthenticated.status, 401);

  const identity = await app.call('/api/v1/households', {
    method: 'POST',
    token: bootstrapToken,
    body: { displayName: 'Synthetic household', owner: { displayName: 'Synthetic owner' } },
  });
  assert.equal(identity.status, 201);
  const token = identity.data.session.token;

  const integrations = await app.call('/api/v1/integrations', { token });
  assert.equal(integrations.status, 200);
  assert.equal(integrations.data.providers.sarvam.networkAttempted, false);
  assert.equal(integrations.data.providers.gnani.status, 'not_configured');

  const matrix = await app.call(`/api/v1/households/${identity.data.household.id}`, { token });
  assert.equal(matrix.status, 200);
  assert.equal(matrix.data.members.length, 1);
  assert.equal(matrix.data.members[0].fieldAccess.dateOfBirth, 'granted');

  const otherIdentity = await app.call('/api/v1/households', {
    method: 'POST', token: bootstrapToken,
    body: { displayName: 'Other synthetic household', owner: { displayName: 'Other synthetic owner' } },
  });
  const hiddenMatrix = await app.call(`/api/v1/households/${otherIdentity.data.household.id}`, { token });
  assert.equal(hiddenMatrix.status, 404);

  const setup = createBackendServices(database, { env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  const householdViewer = setup.households.createAdult({ displayName: 'Synthetic household viewer' });
  setup.households.addRole({
    householdId: identity.data.household.id,
    adultUserId: householdViewer.id,
    role: 'viewer',
  });
  const viewerToken = setup.auth.issueSession({ adultUserId: householdViewer.id }).token;

  const emergency = await app.call('/api/v1/cases', {
    method: 'POST',
    token,
    body: {
      householdId: identity.data.household.id,
      subjectMemberId: identity.data.ownerMember.id,
      openedByAdultId: identity.data.owner.id,
      triggerType: 'emergency',
    },
  });
  assert.equal(emergency.status, 201);
  assert.equal(emergency.data.emergencyInstruction.headline, 'Admit first. Optimise later.');
  assert.equal(emergency.data.emergencyInstruction.processingConsentRequired, false);

  const ownerCaseWithoutPermission = await app.call(`/api/v1/cases/${emergency.data.id}`, { token });
  assert.equal(ownerCaseWithoutPermission.status, 403);
  const viewerCaseWithoutPermission = await app.call(`/api/v1/cases/${emergency.data.id}`, { token: viewerToken });
  assert.equal(viewerCaseWithoutPermission.status, 403);
  const viewerMatrixWithoutPermission = await app.call(`/api/v1/households/${identity.data.household.id}`, { token: viewerToken });
  assert.equal(viewerMatrixWithoutPermission.status, 200);
  assert.equal(viewerMatrixWithoutPermission.data.members[0].immediateIssue, null);
  assert.equal(viewerMatrixWithoutPermission.data.members[0].fieldAccess.immediateIssue, 'withheld');
  const otherTenantCase = await app.call(`/api/v1/cases/${emergency.data.id}`, { token: otherIdentity.data.session.token });
  assert.equal(otherTenantCase.status, 404);

  const sourcePackWithoutPermission = await app.call(`/api/v1/cases/${emergency.data.id}/source-pack`, { token });
  assert.equal(sourcePackWithoutPermission.status, 403);
  assert.equal(sourcePackWithoutPermission.data.error.code, 'FIELD_ACCESS_REQUIRED');

  const collecting = await app.call(`/api/v1/cases/${emergency.data.id}/transitions`, {
    method: 'POST',
    token,
    body: { toStatus: 'collecting', expectedRevision: emergency.data.revision, actorId: identity.data.owner.id },
  });
  assert.equal(collecting.status, 200);
  const processing = await app.call(`/api/v1/cases/${emergency.data.id}/transitions`, {
    method: 'POST',
    token,
    body: { toStatus: 'processing', expectedRevision: collecting.data.revision, actorId: identity.data.owner.id },
  });
  assert.equal(processing.status, 200);

  const grant = await app.call('/api/v1/consents', {
    method: 'POST',
    token,
    body: {
      householdId: identity.data.household.id,
      subjectAdultId: identity.data.owner.id,
      purpose: 'coverage_reconstruction',
      scopes: [{
        resourceType: 'case',
        resourceId: emergency.data.id,
        action: 'derive',
        dataCategory: 'insurance_document',
      }, {
        resourceType: 'case',
        resourceId: emergency.data.id,
        action: 'read',
        dataCategory: 'analysis_summary',
        recipient: identity.data.owner.id,
      }, {
        resourceType: 'case',
        resourceId: emergency.data.id,
        action: 'read',
        dataCategory: 'case_summary',
        recipient: identity.data.owner.id,
      }, {
        // Correct field, wrong purpose: this must not unlock source-pack reads.
        resourceType: 'case',
        resourceId: emergency.data.id,
        action: 'read',
        dataCategory: 'source_pack_metadata',
        recipient: identity.data.owner.id,
      }],
    },
  });
  assert.equal(grant.status, 201);
  const ownerCase = await app.call(`/api/v1/cases/${emergency.data.id}`, { token });
  assert.equal(ownerCase.status, 200);
  assert.equal(ownerCase.data.triggerType, 'emergency');
  assert.equal('opened_by_adult_id' in ownerCase.data, false);
  assert.equal('household_id' in ownerCase.data, false);
  const ownerMatrix = await app.call(`/api/v1/households/${identity.data.household.id}`, { token });
  assert.equal(ownerMatrix.data.members[0].immediateIssue.caseId, emergency.data.id);
  assert.equal(ownerMatrix.data.members[0].fieldAccess.immediateIssue, 'granted');

  const missingKey = await app.call(`/api/v1/cases/${emergency.data.id}/analysis-runs`, {
    method: 'POST',
    token,
    body: { consentGrantId: grant.data.id },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const analysis = await app.call(`/api/v1/cases/${emergency.data.id}/analysis-runs`, {
    method: 'POST',
    token,
    idempotencyKey: 'analysis-emergency-001',
    body: { consentGrantId: grant.data.id, executionMode: 'fixture' },
  });
  assert.equal(analysis.status, 202, JSON.stringify(analysis.data));
  assert.equal(analysis.data.tasks.length, 22);
  assert.equal(analysis.data.dispatchStatus, 'fixture_completed');
  assert.equal(analysis.data.externalProviderCalls, false);
  const financialBreakdown = analysis.data.tasks.find(item => item.taskKind === 'policy_decomposition_d');
  assert.equal(financialBreakdown.resultSummary.section, 'D');
  assert.match(financialBreakdown.resultSummary.responsibility, /financial limits/i);
  assert.ok(financialBreakdown.resultSummary.facts.some(fact => fact.field === 'room_rent_limit'));
  assert.ok(financialBreakdown.resultSummary.facts.some(fact => fact.evidenceState === 'Unknown'));

  const repeated = await app.call(`/api/v1/cases/${emergency.data.id}/analysis-runs`, {
    method: 'POST',
    token,
    idempotencyKey: 'analysis-emergency-001',
    body: { consentGrantId: grant.data.id, executionMode: 'fixture' },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.id, analysis.data.id);

  const task = await app.call(`/api/v1/tasks/${analysis.data.tasks[0].id}`, { token });
  assert.equal(task.status, 200);
  assert.equal(task.data.status, 'completed');
  assert.equal('input_json' in task.data, false);
  assert.equal('output_json' in task.data, false);
  assert.equal('last_error_message' in task.data, false);
  assert.equal('resultSummary' in task.data, true);

  const wrongPurposeSourcePack = await app.call(`/api/v1/cases/${emergency.data.id}/source-pack`, { token });
  assert.equal(wrongPurposeSourcePack.status, 403);

  const sourceGrant = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: {
      householdId: identity.data.household.id,
      subjectAdultId: identity.data.owner.id,
      purpose: 'document_processing',
      scopes: [{
        resourceType: 'case', resourceId: emergency.data.id, action: 'read',
        dataCategory: 'source_pack_metadata', recipient: identity.data.owner.id,
      }],
    },
  });
  assert.equal(sourceGrant.status, 201);
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at)
    VALUES (?, ?, ?, ?, ?, 'medical_record', 'private-medical-record.pdf', ?, ?,
      'application/pdf', 2048, 'pending', 'required', 'quarantined', ?)`)
    .run(
      'document-sensitive-fixture', identity.data.household.id, emergency.data.id,
      identity.data.owner.id, sourceGrant.data.id, '/encrypted/private-medical-record.pdf',
      'a'.repeat(64), new Date().toISOString(),
    );
  const sourcePack = await app.call(`/api/v1/cases/${emergency.data.id}/source-pack`, { token });
  assert.equal(sourcePack.status, 200);
  assert.equal(sourcePack.data.sources[0].documentKind, 'medical_record');
  assert.equal('original_filename' in sourcePack.data.sources[0], false);
  assert.equal('content_sha256' in sourcePack.data.sources[0], false);
  assert.doesNotMatch(JSON.stringify(sourcePack.data), /private-medical-record/);

  const viewerDenied = await app.call(`/api/v1/jobs/${analysis.data.id}`, { token: viewerToken });
  assert.equal(viewerDenied.status, 403);
  assert.equal(viewerDenied.data.error.code, 'FIELD_ACCESS_REQUIRED');

  const viewerGrant = await app.call('/api/v1/consents', {
    method: 'POST',
    token,
    body: {
      householdId: identity.data.household.id,
      subjectAdultId: identity.data.owner.id,
      purpose: 'coverage_reconstruction',
      scopes: [{
        resourceType: 'case', resourceId: emergency.data.id, action: 'read',
        dataCategory: 'analysis_summary', recipient: householdViewer.id,
      }, {
        resourceType: 'case', resourceId: emergency.data.id, action: 'read',
        dataCategory: 'case_summary', recipient: householdViewer.id,
      }],
    },
  });
  assert.equal(viewerGrant.status, 201);
  const viewerAllowed = await app.call(`/api/v1/jobs/${analysis.data.id}`, { token: viewerToken });
  assert.equal(viewerAllowed.status, 200);
  assert.equal('input_json' in viewerAllowed.data, false);
  assert.equal(viewerAllowed.data.tasks.every(item => !('output_json' in item)), true);
  assert.equal(viewerAllowed.data.tasks.find(item => item.taskKind === 'deterministic_release_gate').resultSummary.externalActionsAuthorized, false);
  const viewerCaseAllowed = await app.call(`/api/v1/cases/${emergency.data.id}`, { token: viewerToken });
  assert.equal(viewerCaseAllowed.status, 200);
  assert.equal(viewerCaseAllowed.data.id, emergency.data.id);

  const otherTenantJob = await app.call(`/api/v1/jobs/${analysis.data.id}`, { token: otherIdentity.data.session.token });
  assert.equal(otherTenantJob.status, 404);

  await stop(app.server);
  database.close();
  database = openDatabase({ path: databasePath });
  app = await start(database);

  const persistedCase = await app.call(`/api/v1/cases/${emergency.data.id}`, { token });
  assert.equal(persistedCase.status, 200);
  assert.equal(persistedCase.data.status, 'processing');
  const persistedJob = await app.call(`/api/v1/jobs/${analysis.data.id}`, { token });
  assert.equal(persistedJob.status, 200);
  assert.equal(persistedJob.data.tasks.length, 22);
  assert.equal(persistedJob.data.status, 'completed');
  const auditWithoutPermission = await app.call(`/api/v1/cases/${emergency.data.id}/audit-events`, { token });
  assert.equal(auditWithoutPermission.status, 403);
  const auditGrant = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: {
      householdId: identity.data.household.id,
      subjectAdultId: identity.data.owner.id,
      purpose: 'human_review',
      scopes: [{
        resourceType: 'case', resourceId: emergency.data.id, action: 'read',
        dataCategory: 'audit_summary', recipient: identity.data.owner.id,
      }],
    },
  });
  assert.equal(auditGrant.status, 201);
  const audit = await app.call(`/api/v1/cases/${emergency.data.id}/audit-events`, { token });
  assert.equal(audit.status, 200);
  assert.ok(audit.data.events.some(event => event.action === 'analysis.task_completed'));
  assert.equal(audit.data.events.every(event => !('event_payload_json' in event) && !('actor_id' in event) && !('event_hash' in event)), true);

  const revoked = await app.call(`/api/v1/consents/${grant.data.id}/revoke`, {
    method: 'POST',
    token,
    body: { revokedByAdultId: identity.data.owner.id, reason: 'Synthetic revocation' },
  });
  assert.equal(revoked.status, 200);
  const revokedJob = await app.call(`/api/v1/jobs/${analysis.data.id}`, { token });
  assert.equal(revokedJob.status, 403);

  await stop(app.server);
  database.close();
});
