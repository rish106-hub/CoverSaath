import test from 'node:test';
import assert from 'node:assert/strict';
import { startAnalyticsDrain } from '../src/server/worker.js';

// Analytics drain shutdown: stop() waits (bounded) for the in-flight tick and no tick starts after stop. Local stubs only; no database.
const ENV = { ANALYTICS_DRAIN_MS: '3600000' };

function slowDrain() {
  const state = { started: 0, finished: 0, closedAfterFinish: null, release: null };
  const services = {
    analytics: {
      enabled: () => true,
      drain: () => new Promise(resolve => { state.started += 1; state.release = () => { state.finished += 1; resolve({ sent: 0, failed: 0, dropped: 0 }); }; }),
    },
  };
  const client = { close: async () => { state.closedAfterFinish = state.finished === state.started; } };
  return { state, services, client };
}

test('drain stop waits for the in-flight tick before closing the client', async () => {
  const { state, services, client } = slowDrain();
  const drain = startAnalyticsDrain({ services, env: ENV, client });
  const tick = drain.tick();
  assert.equal(state.started, 1);
  let stopped = false;
  const stopping = drain.stop().then(() => { stopped = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(stopped, false, 'stop must not finish while a tick is running');
  state.release();
  await tick;
  await stopping;
  assert.equal(state.closedAfterFinish, true);
});

test('drain stop is bounded and no tick starts after stop', async () => {
  const { state, services, client } = slowDrain();
  const drain = startAnalyticsDrain({ services, env: ENV, client });
  void drain.tick();
  await drain.stop({ stopWaitMs: 20 });
  assert.equal(state.closedAfterFinish, false, 'a hung tick does not block shutdown forever');
  await drain.tick();
  assert.equal(state.started, 1, 'no new tick after stop');
  state.release();
});
