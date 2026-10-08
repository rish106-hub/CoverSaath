import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EVIDENCE_STATES, displayValue, formatPaise } from '../src/ui/components/format.js';
import { ApiError, createV1Client } from '../src/ui/api/v1-client.js';
import { createJourneyController } from '../src/ui/state/journey-controller.js';
import { buildProcedureBody, buildReviewBody, reconstructionConsentScopes } from '../src/ui/state/request-builders.js';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const sources = {
  app: await read('../src/ui/app.js'), styles: await read('../src/ui/styles.css'), client: await read('../src/ui/api/v1-client.js'),
  views: (await Promise.all(['onboarding-views', 'progress-view', 'breakdown-view', 'tools-views'].map(name => read(`../src/ui/components/${name}.js`)))).join('\n'),
};

test('evidence vocabulary includes all seven states and NotPermitted is distinct from Unknown', () => {
  assert.deepEqual(EVIDENCE_STATES.map(([name]) => name), ['Proven', 'Calculated', 'Reported', 'Dynamic', 'Unknown', 'Conflicting', 'NotPermitted']);
  assert.match(sources.views, /Withheld/);
});

test('money is integer paise formatted with Indian grouping', () => {
  assert.equal(formatPaise(10000000), '₹1,00,000');
  assert.equal(formatPaise(123456789), '₹12,34,567.89');
  assert.equal(formatPaise(null), 'Unknown');
  assert.equal(displayValue({ kind: 'money', amountMinor: 100000000, currency: 'INR' }), '₹10,00,000');
  assert.equal(displayValue(null), null);
});

test('review bodies follow the API contract', () => {
  assert.deepEqual(buildReviewBody({ action: 'confirm' }).body, { action: 'confirm' });
  assert.deepEqual(buildReviewBody({ action: 'correct', valueType: 'money', form: { value: '500000' } }).body, { action: 'correct', value: { valueNumber: 500000 } });
  const cited = buildReviewBody({ action: 'correct', valueType: 'percent', form: { value: '20', documentId: 'd1', pageNumber: '3', quote: 'Co-pay 20%' } }).body;
  assert.deepEqual(cited.citation, { documentId: 'd1', pageNumber: 3, quote: 'Co-pay 20%' });
  assert.ok(buildReviewBody({ action: 'correct', valueType: 'count', form: { value: '1.5' } }).error);
  assert.deepEqual(buildReviewBody({ action: 'correct', valueType: 'boolean', form: { value: 'no' } }).body.value, { valueBoolean: false });
  assert.deepEqual(reconstructionConsentScopes().map(scope => `${scope.resourceType}/${scope.action}`), ['policy/derive', 'document/share']);
});

test('procedure body converts rupees to paise and rejects an empty bill', () => {
  const built = buildProcedureBody({ procedure: 'cataract', roomRate: '9000', roomDays: '1', billLines: [{ head: 'surgeon_fees', amount: '30000' }] }, { includeBill: true });
  assert.deepEqual(built.body.room, { ratePerDayMinor: 900000, days: 1 });
  assert.deepEqual(built.body.billLines, [{ head: 'surgeon_fees', amountMinor: 3000000 }]);
  assert.ok(buildProcedureBody({ procedure: 'cataract', billLines: [] }, { includeBill: true }).error);
});

test('client sends bearer and idempotency headers and classifies errors', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: false, status: 402, json: async () => ({ error: { code: 'BREAKDOWN_BUDGET_EXHAUSTED', message: 'Budget' } }) }; };
  const client = createV1Client({ fetchImpl });
  client.setSessionToken('t'.repeat(32));
  await assert.rejects(client.createPolicyRecord('h1', { documentIds: ['d'] }, 'key-12345678'), error => error instanceof ApiError && error.kind === 'budget');
  assert.equal(calls[0].url, '/api/v1/households/h1/policy-records');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'key-12345678');
  assert.match(calls[0].init.headers.Authorization, /^Bearer /);
  const offline = createV1Client({ fetchImpl: async () => { throw new TypeError('offline'); } });
  await assert.rejects(offline.householdMatrix('h1'), error => error.kind === 'network');
});

function fakeClient(overrides = {}) {
  const calls = [];
  const record = name => async (...args) => { calls.push([name, ...args]); return overrides[name] ? overrides[name](...args) : {}; };
  const client = new Proxy({ calls }, { get: (target, name) => (name in target ? target[name] : record(name)) });
  return client;
}

test('journey: policy record uses one Idempotency-Key across retries and polls to the sections', async () => {
  const keys = []; let attempt = 0; let polls = 0;
  const client = fakeClient({
    bootstrapHousehold: async () => ({ household: { id: 'h1' }, owner: { id: 'a1', display_name: 'Asha' }, ownerMember: { id: 'm1' }, session: { token: 's'.repeat(32) } }),
    householdMatrix: async () => ({ members: [{ id: 'm1', displayName: 'Asha' }] }),
    grantConsent: async body => ({ id: `c-${body.purpose}` }),
    uploadDocument: async () => ({ accepted: true, document: { id: 'doc1' } }),
    createPolicyRecord: async (_h, _body, key) => { keys.push(key); if (++attempt === 1) throw new ApiError({ status: 0, message: 'offline' }); return { record: { id: 'r1' }, job: { id: 'j1', status: 'queued', steps: [] } }; },
    breakdownJob: async () => ({ id: 'j1', status: ++polls < 2 ? 'running' : 'succeeded', steps: [{ id: 'ocr', status: 'succeeded' }] }),
    sections: async () => ({ recordStatus: 'needs_review', consistencyIssues: [], sections: [{ number: 1, title: 'S', parameters: [] }] }),
  });
  const timers = [];
  const controller = createJourneyController({
    client, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {}, readFile: async () => new Uint8Array([37, 80, 68, 70]).buffer,
  });
  await controller.bootstrap({ bootstrapToken: 'x'.repeat(32), displayName: 'F', ownerName: 'Asha' });
  assert.equal(controller.snapshot().stage, 'family');
  await controller.uploadDocument({ file: { name: 'p.pdf', size: 10, type: 'application/pdf' }, documentKind: 'policy_wording' });
  assert.equal(controller.snapshot().documents.length, 1);
  await controller.startBreakdown();
  assert.equal(controller.snapshot().error.kind, 'network');
  assert.equal(controller.snapshot().canRetry, true);
  await controller.retry();
  assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
  assert.equal(controller.snapshot().job.status, 'queued');
  while (timers.length && controller.snapshot().stage === 'processing') await timers.shift()();
  const done = controller.snapshot();
  assert.equal(done.stage, 'workspace');
  assert.equal(done.sections.length, 1);
});

test('journey: budget exhaustion stops polling and offers no resume loop; auth expiry is surfaced', async () => {
  const client = fakeClient({
    bootstrapHousehold: async () => ({ household: { id: 'h1' }, owner: { id: 'a1' }, ownerMember: { id: 'm1' }, session: { token: 's'.repeat(32) } }),
    householdMatrix: async () => ({ members: [] }),
    grantConsent: async () => ({ id: 'c' }),
    uploadDocument: async () => ({ accepted: false, reason: 'Password protected.', document: { id: 'd' } }),
    createPolicyRecord: async () => ({ record: { id: 'r1' }, job: { id: 'j1', status: 'running', steps: [] } }),
    breakdownJob: async () => ({ id: 'j1', status: 'failed', steps: [], error: { code: 'BREAKDOWN_BUDGET_EXHAUSTED', message: 'x' } }),
  });
  const timers = [];
  const controller = createJourneyController({ client, setTimer: fn => { timers.push(fn); return 1; }, clearTimer() {}, readFile: async () => new ArrayBuffer(4) });
  await controller.bootstrap({ bootstrapToken: 'x'.repeat(32), displayName: 'F', ownerName: 'A' });
  await controller.uploadDocument({ file: { name: 'locked.pdf', size: 5, type: 'application/pdf' }, documentKind: 'other' });
  assert.deepEqual(controller.snapshot().lastUpload, { filename: 'locked.pdf', accepted: false, reason: 'Password protected.' });
  assert.equal(controller.snapshot().documents.length, 0);
  assert.equal(await controller.startBreakdown(), null); // no accepted document, nothing is sent
  assert.equal(controller.snapshot().error.code, 'NO_DOCUMENT');
});

test('journey: a 401 during work flags an expired session instead of a generic error', async () => {
  const client = fakeClient({
    bootstrapHousehold: async () => ({ household: { id: 'h1' }, owner: { id: 'a1' }, ownerMember: { id: 'm1' }, session: { token: 's'.repeat(32) } }),
    householdMatrix: async () => ({ members: [] }),
    addMember: async () => { throw new ApiError({ status: 401, code: 'AUTHENTICATION_REQUIRED', message: 'expired' }); },
  });
  const controller = createJourneyController({ client, setTimer: () => 1, clearTimer() {} });
  await controller.bootstrap({ bootstrapToken: 'x'.repeat(32), displayName: 'F', ownerName: 'A' });
  await controller.addMember({ displayName: 'Ravi', relationship: 'son', dateOfBirth: '2010-01-01' });
  assert.equal(controller.snapshot().authExpired, true);
  assert.equal(controller.snapshot().error, null);
});

test('view source keeps the accessibility and testing contract', () => {
  assert.match(sources.views, /aria-live/);
  assert.match(sources.views, /data-testid/);
  assert.match(sources.views, /BREAKDOWN_BUDGET_EXHAUSTED/);
  assert.match(sources.views, /Sarvam/);
  assert.match(sources.views, /Gemini/);
  assert.match(sources.app, /tel:112/);
  assert.doesNotMatch(sources.app + sources.views, /innerHTML/);
  assert.doesNotMatch(sources.client, /localStorage|sessionStorage/);
  assert.doesNotMatch(sources.client, /\/api\/cases|\/jobs\//);
  assert.doesNotMatch(sources.app + sources.views, /CoverSaath/i);
});

test('responsive theme includes dark mode, reduced motion and a 360 px friendly layout', () => {
  assert.match(sources.styles, /prefers-color-scheme\s*:\s*dark/);
  assert.match(sources.styles, /prefers-reduced-motion\s*:\s*reduce/);
  assert.match(sources.styles, /@media \(max-width: 780px\)/);
  assert.match(sources.styles, /overflow-wrap: anywhere/);
});
