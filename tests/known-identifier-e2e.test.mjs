// K1 end to end: the household's own identifiers are redacted at storage and again
// at the model boundary. Every value below is synthetic.
//
// AWAITS P0-C: these tests need the privacy gate to honour the frozen
// `knownIdentifiers` option of sanitizeEvidenceTextForStorage and
// sanitizeEvidenceForModel. Before the P0-C gate is merged the option is ignored
// and these tests are expected to fail; they must pass after the rebase onto P0-C.
// The wiring that does not depend on the gate (loading, fail-closed behaviour,
// nothing persisted) is covered in round4-runtime.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/modules/ai-analysis/index.js';
import { createPersistentCoverageAnalysisService } from '../src/modules/coverage-analysis/index.js';
import { liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';

const KNOWN_NAME = 'Zorblax Quimby';
const KNOWN_DEPENDENT = 'Fenwick Tolliver';
const KNOWN_PHONE = '5550100';
const KNOWN_DOB = '2001-03-17';
const FRAGMENTS = ['Zorblax', 'Quimby', 'Fenwick', 'Tolliver', KNOWN_PHONE, KNOWN_DOB];

function seedHouseholdIdentity(app, scenario) {
  const at = new Date().toISOString();
  app.database.prepare('UPDATE adult_users SET display_name = ?, contact_phone = ? WHERE id = ?').run(KNOWN_NAME, KNOWN_PHONE, scenario.ownerId);
  app.database.prepare('UPDATE household_members SET display_name = ? WHERE id = ?').run(KNOWN_NAME, scenario.ownerMemberId);
  app.database.prepare(`INSERT INTO household_members (id, household_id, display_name, member_kind, date_of_birth, created_at, updated_at)
    VALUES ('member-known-dependent', ?, ?, 'dependent', ?, ?, ?)`).run(scenario.householdId, KNOWN_DEPENDENT, KNOWN_DOB, at, at);
}

function everythingPersisted(database) {
  return JSON.stringify({
    runs: database.prepare('SELECT input_json FROM workflow_runs').all(),
    tasks: database.prepare('SELECT input_json, output_json, last_error_message FROM workflow_tasks').all(),
    audit: database.prepare('SELECT event_payload_json FROM audit_events').all(),
  });
}

test('K1 [awaits P0-C rebase]: known household names, phone and date of birth never reach the provider, run input, task output or audit', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app, { suffix: 'k1-e2e' });
  seedHouseholdIdentity(app, scenario);
  // Unlabelled mentions the generic detectors cannot recognise on their own.
  app.database.prepare('UPDATE source_pages SET extracted_text = ? WHERE id = ?').run(
    `Room rent limit is 5000 per day, as agreed with ${KNOWN_NAME} (${KNOWN_DEPENDENT}, ${KNOWN_DOB}, ref ${KNOWN_PHONE}).`, scenario.pageId);

  const response = await scenario.startLiveRun('k1-known-values');
  assert.equal(response.status, 202, response.raw);
  assert.equal(modelRequests.length, 5, 'the live happy path is unchanged');
  assert.equal(response.data.tasks.filter(task => task.status === 'completed').length, 22);

  const surfaces = { prompt: JSON.stringify(modelRequests.map(request => request.prompt)), persisted: everythingPersisted(app.database), response: response.raw };
  // Digit-only probes must not match inside random uuids / sha256 digests: stand-alone tokens only.
  const leaks = (body, fragment) => (/^[0-9]+$/.test(fragment)
    ? new RegExp(`(?<![0-9a-fA-F])${fragment}(?![0-9a-fA-F])`).test(body)
    : body.includes(fragment));
  for (const fragment of FRAGMENTS) {
    for (const [surface, body] of Object.entries(surfaces)) assert.ok(!leaks(body, fragment), `${fragment} leaked to ${surface}`);
  }
  assert.match(surfaces.prompt, /<NAME_\d+>/, 'known names were replaced by placeholders');
  assert.ok(!/knownIdentifiers/.test(surfaces.persisted), 'the identifier list itself is never persisted');
  // The allowlisted term survives the redaction.
  assert.match(surfaces.prompt, /room rent limit/i);
});

test('K1 [awaits P0-C rebase]: the model boundary redacts known values even when storage missed them', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { suffix: 'k1-boundary' });
  seedHouseholdIdentity(app, scenario);
  const services = createBackendServices(app.database);
  const basePort = createCoverageAnalysisPort({ database: app.database, services });
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver({ modelRequests }),
    preDispatchValidator: request => basePort.authorizeModelDispatch(request),
    knownIdentifierLoader: caseId => basePort.loadKnownIdentifiers(caseId),
  })();
  const service = createPersistentCoverageAnalysisService({ port: basePort, liveRegistry: registry });
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'k1-boundary' });

  // Simulate a stored excerpt that still names a household member (for example text stored before this fix).
  const input = JSON.parse(app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(job.id).input_json);
  input.sourcePages[0].text = `Room rent limit is 5000 for ${KNOWN_NAME} and ${KNOWN_DEPENDENT}, born ${KNOWN_DOB}.`;
  app.database.prepare('UPDATE workflow_runs SET input_json = ? WHERE id = ?').run(JSON.stringify(input), job.id);

  const settled = await service.runUntilSettled(job.id);
  assert.equal(settled.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(modelRequests.length, 5);
  const sent = JSON.stringify(modelRequests.map(request => request.prompt));
  for (const fragment of ['Zorblax', 'Quimby', 'Fenwick', 'Tolliver', KNOWN_DOB]) assert.ok(!sent.includes(fragment), `${fragment} reached the provider`);
  assert.match(sent, /<NAME_\d+>/);
  assert.match(sent, /<DOB_\d+>/);
});
