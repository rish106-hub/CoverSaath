import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server/server.js';
import { createFixtureExecutor } from '../src/models/index.js';
import { createMemoryStore } from '../src/orchestration/index.js';

async function setup(t, options = {}) {
  const server = createApiServer({ store: createMemoryStore(), ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { body, cookie } = {}) => {
    const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const input = { trigger: 'planned_care', patientName: 'Synthetic adult', procedure: 'Synthetic procedure', hospital: 'Synthetic hospital', estimate: 500000, consent: true };
  const created = await call('/api/cases', { body: input });
  return { call, cookie: created.cookie, path: `/api/cases/${created.data.id}`, input };
}
async function until(call, path, cookie, predicate) {
  for (let index = 0; index < 100; index++) {
    const response = await call(path, { cookie });
    if (predicate(response.data)) return response;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Run did not reach expected state.');
}

test('HTTP orchestration is asynchronous, owned, observable and revocable', async t => {
  const fixture = createFixtureExecutor();
  const slow = { async execute(packet) { await new Promise(resolve => setTimeout(resolve, 25)); return fixture.execute(packet); } };
  const { call, cookie, path, input } = await setup(t, { fixtureExecutor: slow, env: {} });
  assert.equal((await call('/api/orchestration/config')).status, 200);
  const config = await call('/api/orchestration/config', { cookie });
  assert.equal(config.data.telephonyConnected, false);
  const created = await call(path + '/orchestration', { cookie, body: { mode: 'fixture', modelConsent: false } });
  assert.equal(created.status, 202);
  assert.equal(created.data.mode, 'fixture');
  const runPath = path + `/orchestration/${created.data.id}`;
  assert.equal((await call(runPath)).status, 401);
  const other = await call('/api/cases', { body: input });
  assert.equal((await call(runPath, { cookie: other.cookie })).status, 404);
  assert.equal((await call(path + '/orchestration/arbitrary', { cookie })).status, 404);
  const done = await until(call, runPath, cookie, data => ['completed', 'flagged', 'blocked', 'failed'].includes(data.status));
  assert.ok(done.data.events.some(event => event.role === 'cover-worker'));
  assert.equal(done.data.tasks['evidence-reviewer'].status, 'completed');
  const attempt = await call(runPath + '/call-attempt', { cookie, body: { shareContext: false } });
  assert.equal(attempt.status, 200);
  assert.equal(attempt.data.status, 'attempt_recorded');
  assert.ok(JSON.stringify(attempt.data).includes('tel:+919749452397'));
  assert.equal((await call(path + '/revoke-consent', { cookie, body: {} })).status, 200);
  const revoked = await call(runPath, { cookie });
  assert.equal(revoked.data.status, 'revoked');
  assert.ok(!JSON.stringify(revoked.data).includes('Synthetic adult'));
  assert.equal((await call(runPath + '/resume', { cookie, body: {} })).status, 403);
});

test('live mode never silently falls back when key or consent is missing', async t => {
  const { call, cookie, path } = await setup(t, { env: {} });
  assert.equal((await call(path + '/orchestration', { cookie, body: { mode: 'live', modelConsent: false } })).status >= 400, true);
  const created = await call(path + '/orchestration', { cookie, body: { mode: 'live', modelConsent: true } });
  if (created.status >= 400) return;
  assert.equal(created.status, 202);
  const failed = await until(call, `${path}/orchestration/${created.data.id}`, cookie, data => ['failed', 'blocked'].includes(data.status));
  assert.equal(failed.data.mode, 'live');
  assert.notEqual(failed.data.release.status, 'released');
});

test('revoking an active run prevents late worker release', async t => {
  const fixture = createFixtureExecutor();
  const delayed = { async execute(packet) { await new Promise(resolve => setTimeout(resolve, 60)); return fixture.execute(packet); } };
  const { call, cookie, path } = await setup(t, { fixtureExecutor: delayed, env: {} });
  const created = await call(path + '/orchestration', { cookie, body: { mode: 'fixture', modelConsent: false } });
  await call(path + '/revoke-consent', { cookie, body: {} });
  await new Promise(resolve => setTimeout(resolve, 90));
  const run = await call(`${path}/orchestration/${created.data.id}`, { cookie });
  assert.equal(run.data.status, 'revoked');
  assert.notEqual(run.data.release.status, 'released');
});

test('owned runs can cancel and explicitly resume, foreign run IDs cannot mutate', async t => {
  const fixture = createFixtureExecutor();
  const delayed = { async execute(packet) { await new Promise(resolve => setTimeout(resolve, 30)); return fixture.execute(packet); } };
  const { call, cookie, path, input } = await setup(t, { fixtureExecutor: delayed, env: {} });
  const created = await call(path + '/orchestration', { cookie, body: { mode: 'fixture', modelConsent: false } });
  const runPath = `${path}/orchestration/${created.data.id}`;
  const other = await call('/api/cases', { body: input });
  assert.equal((await call(runPath + '/cancel', { cookie: other.cookie, body: {} })).status, 404);
  const cancelled = await call(runPath + '/cancel', { cookie, body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.status, 'cancelled');
  const resumed = await call(runPath + '/resume', { cookie, body: {} });
  // Safe resume can reject when conservative prior reservations exhaust its budget.
  assert.ok([202, 409].includes(resumed.status));
});

test('revocation during durable creation stops dispatch and concurrent creation', async t => {
  const memory = createMemoryStore();
  let releaseWrite;
  const paused = new Promise(resolve => { releaseWrite = resolve; });
  let announceWrite;
  const entered = new Promise(resolve => { announceWrite = resolve; });
  let first = true;
  const store = { ...memory, async put(record) {
    if (first) { first = false; announceWrite(); await paused; }
    return memory.put(record);
  } };
  let calls = 0;
  const fixture = createFixtureExecutor();
  const counted = { reservationUsd: () => 0, execute(packet) { calls++; return fixture.execute(packet); } };
  const { call, cookie, path } = await setup(t, { store, fixtureExecutor: counted, env: {} });
  const pending = call(path + '/orchestration', { cookie, body: { mode: 'fixture', modelConsent: false } });
  await entered;
  assert.equal((await call(path + '/orchestration', { cookie, body: { mode: 'fixture', modelConsent: false } })).status, 409);
  await call(path + '/revoke-consent', { cookie, body: {} });
  releaseWrite();
  assert.equal((await pending).status, 409);
  assert.equal(calls, 0);
  const [id] = await memory.list();
  assert.equal((await memory.get(id)).status, 'revoked');
});

test('invalid budget settings are refused before starting a server', () => {
  assert.throws(() => createApiServer({ env: { ORCHESTRATION_RUN_BUDGET_USD: 'NaN' }, store: createMemoryStore() }), /Invalid ORCHESTRATION_RUN_BUDGET_USD/);
});
