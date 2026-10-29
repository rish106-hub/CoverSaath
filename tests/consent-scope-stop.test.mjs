// A source whose consent is withdrawn after the unlocked commit re-check but before observations are
// recorded must stop the run and erase what was derived from it, not just fail the one task. The gap is
// forced deterministically: a port wrapper commits the withdrawal immediately before the first
// observation transaction. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/features/ai-analysis/index.js';
import { createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import { liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';
import { postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();
const MARKER = 'wombat heron synthetic';

test('a source withdrawn mid-run stops the run as revoked and erases its derived data', pgOptions, async t => {
  const app = await startLiveServer(t);
  // The upload grant's own derive scope names no recipient, so it never authorises the model;
  // a separate document grant that names the model is what the run depends on.
  const scenario = await setupLiveCase(app, { pageText: `Synthetic schedule: room rent limit is 5000 and ${MARKER} applies.`, suffix: 'scope-stop', recipient: null });
  const services = createBackendServices(app.database);
  const deriveGrant = await services.consents.grant({
    householdId: scenario.householdId, subjectAdultId: scenario.ownerId, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', resourceId: scenario.documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' }],
  });
  const basePort = createCoverageAnalysisPort({ database: app.database, services });
  let withdrawn = 0;
  const rejections = [];
  const port = Object.freeze({
    ...basePort,
    async recordModelObservations(input) {
      if (withdrawn === 0) {
        withdrawn += 1;
        // Withdrawn after verifyRunSourcesCurrent passed and before the locked re-check.
        await services.consents.revoke({ grantId: deriveGrant.id, revokedByAdultId: scenario.ownerId, reason: 'synthetic race' });
      }
      try {
        return await basePort.recordModelObservations(input);
      } catch (error) {
        rejections.push(error);
        throw error;
      }
    },
  });
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver(),
    preDispatchValidator: request => basePort.authorizeModelDispatch(request),
    knownIdentifierLoader: caseId => basePort.loadKnownIdentifiers(caseId),
  })();
  const service = createPersistentCoverageAnalysisService({ port, liveRegistry: registry });

  const { job } = await service.createAnalysisRun({
    caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'scope-stop',
  });
  assert.ok(job.input_json.includes(MARKER), 'the run holds the excerpt before the withdrawal');

  const settled = await service.runUntilSettled(job.id);
  assert.equal(withdrawn, 1, 'the withdrawal committed inside the gap');
  assert.equal(rejections[0]?.code, 'CONSENT_SCOPE_REQUIRED');

  // The run is stopped, not left running or failed task by task.
  assert.equal(settled.status, 'revoked');
  assert.equal(settled.terminal_reason, 'CONSENT_REVOKED');
  const tasks = await app.database.many('SELECT status, output_json FROM workflow_tasks WHERE workflow_run_id = ?', [job.id]);
  assert.ok(tasks.every(task => !['pending', 'running'].includes(task.status)), 'no task is left to run');
  assert.ok(tasks.every(task => task.output_json === null), 'no task output survives');
  const stopAudits = (await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'analysis.revoked'")).map(row => JSON.parse(row.event_payload_json));
  assert.deepEqual(stopAudits, [{ reason: 'source_consent_not_current', reasonCode: 'SOURCE_CONSENT_NOT_CURRENT' }]);

  // Derived data is erased: the excerpt is gone from the run input and no observation was committed.
  const run = await app.database.one('SELECT input_json FROM workflow_runs WHERE id = ?', [job.id]);
  assert.ok(!run.input_json.includes(MARKER), 'run input keeps no excerpt');
  assert.ok(JSON.parse(run.input_json).sourcePages.every(page => page.redacted !== undefined && page.text === undefined), 'every source page is redacted');
  assert.equal((await app.database.one('SELECT count(*) AS count FROM coverage_parameter_observations WHERE value_json IS NOT NULL')).count, 0);
  assert.equal((await app.database.one("SELECT count(*) AS count FROM audit_events WHERE action = 'analysis.derived_data_erased'")).count, 1);
});
