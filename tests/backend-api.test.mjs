import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';

async function start(database) {
  const server = createApiServer({ database, env: {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    async call(path, { method = 'GET', body, idempotencyKey } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

const stop = server => new Promise(resolve => server.close(resolve));

test('versioned backend persists cases and queued analysis across restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-backend-api-'));
  const databasePath = join(directory, 'coversaath.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  let database = openDatabase({ path: databasePath });
  let app = await start(database);

  const health = await app.call('/api/v1/health');
  assert.equal(health.status, 200);
  assert.equal(health.data.database.valid, true);
  assert.equal(health.data.hrms.status, 'on_hold');
  assert.equal(health.data.documentIntake, 'manual_upload_only');

  const integrations = await app.call('/api/v1/integrations');
  assert.equal(integrations.status, 200);
  assert.equal(integrations.data.providers.sarvam.networkAttempted, false);
  assert.equal(integrations.data.providers.gnani.status, 'not_configured');

  const identity = await app.call('/api/v1/households', {
    method: 'POST',
    body: { displayName: 'Synthetic household', owner: { displayName: 'Synthetic owner' } },
  });
  assert.equal(identity.status, 201);

  const emergency = await app.call('/api/v1/cases', {
    method: 'POST',
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

  const collecting = await app.call(`/api/v1/cases/${emergency.data.id}/transitions`, {
    method: 'POST',
    body: { toStatus: 'collecting', expectedRevision: emergency.data.revision, actorId: identity.data.owner.id },
  });
  assert.equal(collecting.status, 200);
  const processing = await app.call(`/api/v1/cases/${emergency.data.id}/transitions`, {
    method: 'POST',
    body: { toStatus: 'processing', expectedRevision: collecting.data.revision, actorId: identity.data.owner.id },
  });
  assert.equal(processing.status, 200);

  const grant = await app.call('/api/v1/consents', {
    method: 'POST',
    body: {
      householdId: identity.data.household.id,
      subjectAdultId: identity.data.owner.id,
      purpose: 'coverage_reconstruction',
      scopes: [{
        resourceType: 'case',
        resourceId: emergency.data.id,
        action: 'derive',
        dataCategory: 'insurance_document',
      }],
    },
  });
  assert.equal(grant.status, 201);

  const missingKey = await app.call(`/api/v1/cases/${emergency.data.id}/analysis-runs`, {
    method: 'POST',
    body: { consentGrantId: grant.data.id },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');

  const analysis = await app.call(`/api/v1/cases/${emergency.data.id}/analysis-runs`, {
    method: 'POST',
    idempotencyKey: 'analysis-emergency-001',
    body: { consentGrantId: grant.data.id, executionMode: 'fixture' },
  });
  assert.equal(analysis.status, 201);
  assert.equal(analysis.data.tasks.length, 10);
  assert.equal(analysis.data.dispatchStatus, 'queued_not_dispatched');
  assert.equal(analysis.data.externalProviderCalls, false);

  const repeated = await app.call(`/api/v1/cases/${emergency.data.id}/analysis-runs`, {
    method: 'POST',
    idempotencyKey: 'analysis-emergency-001',
    body: { consentGrantId: grant.data.id, executionMode: 'fixture' },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.data.id, analysis.data.id);

  const task = await app.call(`/api/v1/tasks/${analysis.data.tasks[0].id}`);
  assert.equal(task.status, 200);
  assert.equal(task.data.status, 'pending');

  await stop(app.server);
  database.close();
  database = openDatabase({ path: databasePath });
  app = await start(database);

  const persistedCase = await app.call(`/api/v1/cases/${emergency.data.id}`);
  assert.equal(persistedCase.status, 200);
  assert.equal(persistedCase.data.status, 'processing');
  const persistedJob = await app.call(`/api/v1/jobs/${analysis.data.id}`);
  assert.equal(persistedJob.status, 200);
  assert.equal(persistedJob.data.tasks.length, 10);
  const audit = await app.call(`/api/v1/cases/${emergency.data.id}/audit-events`);
  assert.equal(audit.status, 200);
  assert.ok(audit.data.events.some(event => event.action === 'analysis.queued'));

  const revoked = await app.call(`/api/v1/consents/${grant.data.id}/revoke`, {
    method: 'POST',
    body: { revokedByAdultId: identity.data.owner.id, reason: 'Synthetic revocation' },
  });
  assert.equal(revoked.status, 200);
  const revokedJob = await app.call(`/api/v1/jobs/${analysis.data.id}`);
  assert.equal(revokedJob.data.status, 'revoked');

  await stop(app.server);
  database.close();
});
