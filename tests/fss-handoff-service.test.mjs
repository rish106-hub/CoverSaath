import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { seedWorld } from './support/postgres-fixtures.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createFssHandoffService, FSS_HANDOFF_JOB_KIND } from '../src/backend/services/fss-handoff-service.js';
import { createFssHandoffHandler } from '../src/backend/jobs/fss-handoff-handler.js';
import { signNotice, ReferenceDataError } from '../src/integrations/insurance-data/index.js';
import { buildJobHandlers } from '../src/server/worker.js';

// FSS handoff service (ADR 0037 step 3b): queue + outbox job, send (retry, permanent failure, idempotent), signed notice, handler, worker wiring.
// Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const SECRET = 'synthetic-notice-secret-0123456789';
const ENV = { HOLDINGS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true', FSS_HANDOFF_ENABLED: 'true', FSS_NOTICE_SECRET: SECRET, REFERENCE_DATA_BASE_URL: 'https://fss.example.invalid', REFERENCE_DATA_API_KEY: 'stub-key-not-real' };

async function world(t, { client, names = { insurerName: 'Test Insurer', productName: 'Test Plan' } } = {}) {
  const fresh = await freshDatabase(t);
  const a = await seedWorld(fresh.handle.pool, 'a');
  const services = createBackendServices(fresh.db, { env: ENV });
  const holding = await services.policyHoldings.create({ householdId: a.household, adultId: a.adult, documentId: a.document, kind: 'retail_health', policyId: a.policy });
  const holdingRepository = {
    getHolding: async () => ({ ...holding, householdId: a.household, policyProfileId: null }),
    confirmedNames: async () => new Map([[holding.id, names]]),
    confirmedUin: async () => null,
    holdingDocument: async () => ({ id: a.document, consentGrantId: a.consent }),
  };
  const calls = [];
  const events = [];
  const service = createFssHandoffService({ repository: services.fssHandoffs, holdingRepository, jobQueue: services.jobQueue, env: ENV, client: client(calls), onEvent: e => events.push(e) });
  return { ...fresh, a, services, holding: { ...holding, householdId: a.household }, service, calls, events };
}
const answer = (requestId, state, versionId = null) => ({ handoffId: 'h-1', requestId, state, versionId });

test('queueForHolding: one handoff and one outbox job; a repeat adds nothing; off flag queues nothing', opts, async t => {
  const s = await world(t, { client: () => ({}) });
  const first = await s.service.queueForHolding({ holding: s.holding });
  const again = await s.service.queueForHolding({ holding: s.holding });
  assert.equal(first.queued, true); assert.equal(again.queued, false);
  const jobs = await s.db.many('SELECT kind, payload_json AS payload FROM job_queue WHERE kind = ?', [FSS_HANDOFF_JOB_KIND]);
  assert.equal(jobs.length, 1);
  assert.deepEqual(Object.keys(typeof jobs[0].payload === 'string' ? JSON.parse(jobs[0].payload) : jobs[0].payload).sort(), ['holdingId', 'requestId']);
  const off = createFssHandoffService({ repository: s.services.fssHandoffs, holdingRepository: {}, jobQueue: s.services.jobQueue, env: {} });
  assert.deepEqual(await off.queueForHolding({ holding: s.holding }), { queued: false });
});

test('send: posts identifiers only and records accepted; a second send is skipped', opts, async t => {
  const s = await world(t, { client: calls => ({ create: async request => { calls.push(request); return answer(request.requestId, 'accepted'); } }) });
  const { requestId } = await s.service.queueForHolding({ holding: s.holding });
  assert.equal(await s.service.send({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'accepted');
  assert.deepEqual(Object.keys(s.calls[0]).sort(), ['insurerName', 'productName', 'requestId']);
  assert.equal(await s.service.send({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'skipped');
  assert.equal(s.calls.length, 1);
  assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).state, 'accepted');
});

test('send: retryable failure rethrows and counts; third failure marks failed; permanent failure does not rethrow', opts, async t => {
  const s = await world(t, { client: () => ({ create: async () => { throw new ReferenceDataError('REFERENCE_DATA_UNAVAILABLE', 'x', { retryable: true }); } }) });
  const { requestId } = await s.service.queueForHolding({ holding: s.holding });
  const args = { householdId: s.a.household, holdingId: s.holding.id, requestId };
  await assert.rejects(s.service.send(args), { retryable: true });
  await assert.rejects(s.service.send(args), { retryable: true });
  await assert.rejects(s.service.send(args), { retryable: true });
  const row = await s.services.fssHandoffs.byRequestId(requestId);
  assert.equal(row.state, 'failed'); assert.equal(row.attempts, 3); assert.equal(row.lastOutcome, 'unavailable');
  assert.equal(await s.service.send(args), 'skipped');

  const p = await world(t, { client: () => ({ create: async () => { throw new ReferenceDataError('REFERENCE_DATA_REQUEST_INVALID', 'x', { retryable: false }); } }) });
  const q = await p.service.queueForHolding({ holding: p.holding });
  assert.equal(await p.service.send({ householdId: p.a.household, holdingId: p.holding.id, requestId: q.requestId }), 'failed_send');
});

test('send: missing confirmed names never calls FSS', opts, async t => {
  const s = await world(t, { names: { insurerName: null, productName: 'Test Plan' }, client: calls => ({ create: async r => { calls.push(r); return answer(r.requestId, 'accepted'); } }) });
  const { requestId } = await s.service.queueForHolding({ holding: s.holding });
  assert.equal(await s.service.send({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'names_missing');
  assert.equal(s.calls.length, 0);
});

test('receiveNotice: bad signature, stale, wrong secret refused; valid applied, repeat duplicate, unknown dropped', opts, async t => {
  const s = await world(t, { client: calls => ({ create: async r => { calls.push(r); return answer(r.requestId, 'accepted'); } }) });
  const { requestId } = await s.service.queueForHolding({ holding: s.holding });
  await s.service.send({ householdId: s.a.household, holdingId: s.holding.id, requestId });
  const body = JSON.stringify({ handoff_id: 'h-1', request_id: requestId, state: 'matched', version_id: 'v-9' });
  const good = signNotice(body, SECRET);
  await assert.rejects(s.service.receiveNotice({ rawBody: body, header: signNotice(body, 'another-secret-0123456789') }), { code: 'FSS_NOTICE_SIGNATURE_INVALID' });
  await assert.rejects(s.service.receiveNotice({ rawBody: body, header: signNotice(body, SECRET, Date.now() - 10 * 60_000) }), { code: 'FSS_NOTICE_STALE' });
  await assert.rejects(s.service.receiveNotice({ rawBody: body + ' ', header: good }), { code: 'FSS_NOTICE_SIGNATURE_INVALID' });
  assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).state, 'accepted');
  assert.deepEqual(await s.service.receiveNotice({ rawBody: body, header: good }), { result: 'applied' });
  assert.deepEqual(await s.service.receiveNotice({ rawBody: body, header: signNotice(body, SECRET) }), { result: 'duplicate' });
  const row = await s.services.fssHandoffs.byRequestId(requestId);
  assert.equal(row.state, 'matched'); assert.equal(row.versionId, 'v-9');
  const other = JSON.stringify({ handoff_id: 'h-2', request_id: 'req-unknown-0001', state: 'no_match' });
  assert.deepEqual(await s.service.receiveNotice({ rawBody: other, header: signNotice(other, SECRET) }), { result: 'unknown' });
  assert.ok(s.events.some(e => e.type === 'fss.notice_dropped'));
});

test('handler and worker wiring', opts, async t => {
  const s = await world(t, { client: calls => ({ create: async r => { calls.push(r); return answer(r.requestId, 'working'); } }) });
  const { requestId } = await s.service.queueForHolding({ holding: s.holding });
  const handler = createFssHandoffHandler({ service: s.service });
  await assert.rejects(handler({ job: { kind: 'x' } }), { code: 'JOB_PAYLOAD_INVALID' });
  await handler({ job: { kind: FSS_HANDOFF_JOB_KIND, householdId: s.a.household, payload: { holdingId: s.holding.id, requestId } } });
  assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).state, 'working');
  assert.ok(FSS_HANDOFF_JOB_KIND in buildJobHandlers(s.services, ENV));
  assert.ok(!(FSS_HANDOFF_JOB_KIND in buildJobHandlers(s.services, { HOLDINGS_ENABLED: 'true' })));
});
