// Review 3 findings R3-1 (budget reservations of never-dispatched calls) and
// R3-2 (identifiers carried as JSON numbers in structured upstream evidence).
// Every value below is synthetic. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory, createMemoryBudget, createModelGateway } from '../src/modules/ai-analysis/index.js';
import { sanitizeEvidenceForModel } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { createPersistentCoverageAnalysisService } from '../src/modules/coverage-analysis/index.js';
import { liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';

const gatewayInput = () => ({
  context: { caseId: 'case-r3', subjectId: 'adult-r3', purpose: 'Extract requested cover facts.', requestedFields: ['room_rent_limit'] },
  sources: [{ id: 'policy:v1:p1', version: 'v1', page: 1, text: 'Room rent limit is unresolved.', status: 'unknown' }],
  upstream: [],
});

test('R3-1: a call refused before dispatch releases its reservation; a dispatched failure keeps it', async () => {
  const refusedBudget = createMemoryBudget(0.02);
  const refused = createModelGateway({
    mode: 'live',
    budget: refusedBudget,
    liveRunner: async () => { throw Object.assign(new Error('refused before dispatch'), { modelDispatched: false }); },
  });
  await assert.rejects(refused.execute({ task: 'profile_extraction', input: gatewayInput(), reservationUsd: 0.01 }), /refused before dispatch/);
  assert.equal(refusedBudget.snapshot().reservedUsd, 0);
  assert.equal(refusedBudget.snapshot().spentUsd, 0);

  const dispatchedBudget = createMemoryBudget(0.02);
  const dispatched = createModelGateway({ mode: 'live', budget: dispatchedBudget, liveRunner: async () => { throw new Error('provider timeout'); } });
  await assert.rejects(dispatched.execute({ task: 'profile_extraction', input: gatewayInput(), reservationUsd: 0.01 }), /provider timeout/);
  assert.equal(dispatchedBudget.snapshot().reservedUsd, 0.01);
});

test('R3-1: repeated pre-dispatch consent denials do not exhaust the project budget', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: 'Synthetic schedule: room rent limit is 5000.' });
  const services = createBackendServices(app.database);
  const port = createCoverageAnalysisPort({ database: app.database, services });
  const modelRequests = [];
  let allow = false;
  // Room for exactly one in-flight reservation: a single leaked reservation
  // would refuse every later call.
  const factory = createGeminiCoverageRegistryFactory({
    env: { ...liveEnv, ORCHESTRATION_PROJECT_BUDGET_USD: '0.05' },
    ...stubModelDriver({ modelRequests }),
    knownIdentifierLoader: caseId => port.loadKnownIdentifiers(caseId),
    preDispatchValidator: request => (allow ? port.authorizeModelDispatch(request) : { allowed: false }),
  });
  const runOnce = async key => {
    const service = createPersistentCoverageAnalysisService({ port, liveRegistry: factory(), maxConcurrency: 1 });
    const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: key });
    await service.runUntilSettled(job.id);
    return app.database.prepare('SELECT last_error_code FROM workflow_tasks WHERE workflow_run_id = ?').all(job.id).map(row => row.last_error_code);
  };

  for (const key of ['r3-denied-1', 'r3-denied-2', 'r3-denied-3']) {
    const codes = await runOnce(key);
    assert.ok(codes.includes('MODEL_DISPATCH_AUTHORIZATION_FAILED'));
  }
  assert.equal(modelRequests.length, 0);

  allow = true;
  const codes = await runOnce('r3-allowed');
  assert.ok(!codes.includes('budget_refused'), 'denied calls must not have consumed the project budget');
  assert.ok(modelRequests.length >= 1);
});

const policy = () => ({ dataClass: 'CONFIDENTIAL', modelExtraction: { allowed: true }, registryVersion: 'policy-parameters/v1' });
const withUpstream = upstream => sanitizeEvidenceForModel({
  context: { caseId: 'case-r3', subjectId: 'subject-r3', purpose: 'Draft questions.', requestedFields: [] },
  sources: [{ id: 'page-r3', version: 'v1', page: 1, text: 'Room rent limit is 5000.', status: 'known' }],
  upstream,
}, { resolveParameterPolicy: policy });

test('R3-2: identifiers carried as JSON numbers are minimised in structured upstream evidence', () => {
  const result = withUpstream([{
    note: 'household contact',
    contact: 9876543210,
    phone: 9123456780,
    memberId: 4021,
    aadhaar: 234567890123,
    reference: 345678901234,
  }]);
  const body = JSON.stringify(result.input.upstream);
  for (const raw of ['9876543210', '9123456780', '4021', '234567890123', '345678901234']) {
    assert.ok(!body.includes(raw), `${raw} must not reach the model`);
  }
  const [entry] = result.input.upstream;
  assert.match(entry.contact, /^<PHONE_[1-9]\d*>$/);
  assert.match(entry.memberId, /^<ID_[1-9]\d*>$/);
  assert.match(entry.reference, /^<GOV_ID_[1-9]\d*>$/);
  assert.ok(result.audit.redactionReasonCodes.includes('DIRECT_IDENTIFIER_PHONE'));
});

test('R3-2: amounts, counts and decimals stay numbers', () => {
  const [entry] = withUpstream([{ sumInsured: 500000, roomRent: 5000, waitingDays: 30, copayPercent: 12.5, premium: 1500000, year: 2024, negative: -3 }]).input.upstream;
  assert.deepEqual(entry, { sumInsured: 500000, roomRent: 5000, waitingDays: 30, copayPercent: 12.5, premium: 1500000, year: 2024, negative: -3 });
});

test('R3-2: a card number carried as a JSON number is rejected like its text form', () => {
  assert.throws(() => withUpstream([{ reference: 4111111111111111 }]), { code: 'RESTRICTED_EVIDENCE' });
});
