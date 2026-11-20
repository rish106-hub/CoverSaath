import test from 'node:test';
import assert from 'node:assert/strict';
import { startFssPollScheduler } from '../src/server/worker.js';
import { readFssPollConfig } from '../src/server/config.js';

// FSS handoff poll scheduler (ADR 0037, plan C2): interval calls, the off flag, error isolation, shutdown, config bounds.
// Synthetic data only. No database: a fake service records calls. Timers are mocked, so no real waiting.

const ON = Object.freeze({ REFERENCE_DATA_ENABLED: 'true', FSS_HANDOFF_ENABLED: 'true' });
const INTERVAL = 60_000;
const flush = () => new Promise(resolve => setImmediate(resolve));

function fakeService(behaviour = async () => ({ polled: 0 })) {
  const service = { calls: 0, poll: async () => { service.calls += 1; return behaviour(service.calls); } };
  return service;
}

test('poll runs once per interval and not before', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const service = fakeService();
  const scheduler = startFssPollScheduler({ service, env: ON, intervalMs: INTERVAL });
  assert.ok(scheduler);
  t.mock.timers.tick(INTERVAL - 1);
  await flush();
  assert.equal(service.calls, 0);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(service.calls, 1);
  // One interval at a time: a poll still in flight makes the next tick a no-op (one tick at a time).
  for (let i = 0; i < 2; i += 1) { t.mock.timers.tick(INTERVAL); await flush(); }
  assert.equal(service.calls, 3);
  await scheduler.stop();
});

test('handoff flags off: no timer, poll never called', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const service = fakeService();
  assert.equal(startFssPollScheduler({ service, env: { FSS_HANDOFF_ENABLED: 'true' }, intervalMs: INTERVAL }), null);
  assert.equal(startFssPollScheduler({ service, env: { REFERENCE_DATA_ENABLED: 'true' }, intervalMs: INTERVAL }), null);
  assert.equal(startFssPollScheduler({ service, env: { ...ON, FSS_HANDOFF_ENABLED: 'false' }, intervalMs: INTERVAL }), null);
  assert.equal(startFssPollScheduler({ service, env: { ...ON, FSS_HANDOFF_ENABLED: 'yes' }, intervalMs: INTERVAL }), null);
  t.mock.timers.tick(INTERVAL * 5);
  await flush();
  assert.equal(service.calls, 0);
});

test('a throwing poll is logged by code and the loop keeps running', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const logs = [];
  const service = fakeService(calls => {
    if (calls === 1) throw Object.assign(new Error('synthetic uin 0000-SYNTH should never be logged'), { code: 'FSS_TEST_DOWN' });
    if (calls === 2) throw new Error('no code here');
    return { polled: 1 };
  });
  const scheduler = startFssPollScheduler({ service, env: ON, intervalMs: INTERVAL, log: line => logs.push(line) });
  for (let i = 0; i < 3; i += 1) { t.mock.timers.tick(INTERVAL); await flush(); }
  assert.equal(service.calls, 3);
  assert.deepEqual(logs.map(line => line.type), ['fss.poll_failed', 'fss.poll_failed', 'fss.polled']);
  assert.equal(logs[0].code, 'FSS_TEST_DOWN');
  assert.equal(logs[1].code, 'FSS_POLL_FAILED');
  assert.ok(!JSON.stringify(logs).includes('SYNTH'), 'messages and identifiers must not be logged');
  await scheduler.stop();
});

test('stop clears the timer and waits for the in-flight poll', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let release;
  const service = fakeService(() => new Promise(resolve => { release = () => resolve({ polled: 0 }); }));
  const scheduler = startFssPollScheduler({ service, env: ON, intervalMs: INTERVAL });
  t.mock.timers.tick(INTERVAL);
  await flush();
  assert.equal(service.calls, 1);
  let stopped = false;
  const stopping = scheduler.stop({ stopWaitMs: 5_000 }).then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false, 'stop waits for the in-flight poll');
  release();
  await stopping;
  t.mock.timers.tick(INTERVAL * 3);
  await flush();
  assert.equal(service.calls, 1, 'no poll after stop');
});

test('a bad FSS_POLL_INTERVAL_MS fails at read; default is one hour', () => {
  assert.equal(readFssPollConfig({}).intervalMs, 3_600_000);
  assert.equal(readFssPollConfig({ FSS_POLL_INTERVAL_MS: '60000' }).intervalMs, 60_000);
  for (const bad of ['59999', '0', 'abc', '1.5', '604800001']) {
    assert.throws(() => readFssPollConfig({ FSS_POLL_INTERVAL_MS: bad }), /Invalid FSS_POLL_INTERVAL_MS/, bad);
  }
});
