import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocumentScanWorker } from '../src/modules/document-intake/scan-worker.js';

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    active: () => timers.filter(t => !t.cleared && !t.fired),
    fire(timer) { timer.fired = true; timer.fn(); },
  };
}

const flush = async () => { for (let i = 0; i < 10; i += 1) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const retryable = code => Object.assign(new Error('x'), { code, retryable: true });

function build(overrides = {}) {
  const t = fakeTimers();
  const events = [];
  const worker = createDocumentScanWorker({
    listPendingDocumentIds: async () => [],
    scanDocument: async () => 'clean',
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    random: () => 1,
    onEvent: event => events.push(event),
    ...overrides,
  });
  return { worker, t, events };
}

test('single-flight: a queued or in-flight id is not duplicated', async () => {
  const gate = deferred();
  const calls = [];
  const { worker } = build({ scanDocument: async id => { calls.push(id); await gate.promise; return 'clean'; } });
  worker.schedule('a');
  worker.schedule('a');
  worker.schedule('a');
  await flush();
  worker.schedule('a');
  assert.deepEqual(calls, ['a']);
  gate.resolve();
  await flush();
  assert.deepEqual(calls, ['a']);
  assert.equal(worker.stats().inFlight, 0);
});

test('concurrency cap is enforced and queue is FIFO', async () => {
  const gates = new Map();
  const started = [];
  let peak = 0;
  let running = 0;
  const { worker } = build({
    concurrency: 2,
    scanDocument: async id => {
      started.push(id);
      running += 1;
      peak = Math.max(peak, running);
      gates.set(id, deferred());
      await gates.get(id).promise;
      running -= 1;
      return 'clean';
    },
  });
  ['a', 'b', 'c', 'd'].forEach(id => worker.schedule(id));
  await flush();
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(worker.stats(), { inFlight: 2, queued: 2, exhausted: 0 });
  gates.get('a').resolve();
  await flush();
  assert.deepEqual(started, ['a', 'b', 'c']);
  gates.get('b').resolve();
  gates.get('c').resolve();
  await flush();
  gates.get('d').resolve();
  await flush();
  assert.equal(peak, 2);
  assert.deepEqual(started, ['a', 'b', 'c', 'd']);
});

test('backoff delay uses full jitter with random()=1 and 0.5, capped at maxDelayMs', async () => {
  for (const [rand, expected] of [[1, [2000, 4000, 8000, 10_000, 10_000]], [0.5, [1000, 2000, 4000, 5000, 5000]]]) {
    const { worker, t, events } = build({
      random: () => rand,
      maxDelayMs: 10_000,
      maxAttempts: 6,
      scanDocument: async () => { throw retryable('SCANNER_UNAVAILABLE'); },
    });
    worker.schedule('doc');
    for (let i = 0; i < 4; i += 1) {
      await flush();
      const pending = t.active().at(-1);
      t.fire(pending);
    }
    await flush();
    const delays = events.filter(e => e.type === 'scan_retry_scheduled').map(e => e.delayMs);
    assert.deepEqual(delays, expected);
    assert.deepEqual(events.filter(e => e.type === 'scan_retry_scheduled').map(e => e.attempt), [1, 2, 3, 4, 5]);
    assert.ok(t.timers.every(timer => timer.unrefCalled));
  }
});

test('exhaustion after maxAttempts; exhausted ids are not rescheduled', async () => {
  let calls = 0;
  const { worker, t, events } = build({
    maxAttempts: 3,
    scanDocument: async () => { calls += 1; throw retryable('SCANNER_UNAVAILABLE'); },
  });
  worker.schedule('doc');
  for (let i = 0; i < 2; i += 1) {
    await flush();
    t.fire(t.active().at(-1));
  }
  await flush();
  assert.equal(calls, 3);
  const exhausted = events.filter(e => e.type === 'scan_exhausted');
  assert.deepEqual(exhausted, [{ type: 'scan_exhausted', documentId: 'doc', attempts: 3, code: 'SCANNER_UNAVAILABLE' }]);
  assert.equal(t.active().length, 0);
  worker.schedule('doc');
  await flush();
  assert.equal(calls, 3);
  assert.equal(worker.stats().exhausted, 1);
});

test('non-retryable failure exhausts immediately', async () => {
  let calls = 0;
  const { worker, t, events } = build({
    scanDocument: async () => { calls += 1; throw Object.assign(new Error('x'), { code: 'SCANNER_ERROR', retryable: false }); },
  });
  worker.schedule('doc');
  await flush();
  assert.equal(calls, 1);
  assert.equal(t.active().length, 0);
  assert.deepEqual(events, [{ type: 'scan_exhausted', documentId: 'doc', attempts: 1, code: 'SCANNER_ERROR' }]);
  const plain = build({ scanDocument: async () => { throw new Error('no flag'); } });
  plain.worker.schedule('z');
  await flush();
  assert.equal(plain.events[0].type, 'scan_exhausted');
});

test('success emits scan_completed and resets attempts', async () => {
  let n = 0;
  const { worker, t, events } = build({
    scanDocument: async () => { n += 1; if (n === 1) throw retryable('SCANNER_UNAVAILABLE'); return 'blocked'; },
  });
  worker.schedule('doc');
  await flush();
  t.fire(t.active().at(-1));
  await flush();
  assert.deepEqual(events.map(e => e.type), ['scan_retry_scheduled', 'scan_completed']);
  assert.deepEqual(events.at(-1), { type: 'scan_completed', documentId: 'doc', outcome: 'blocked' });
  assert.deepEqual(worker.stats(), { inFlight: 0, queued: 0, exhausted: 0 });
});

test('sweep passes limit 50, schedules ids, and swallows list errors', async () => {
  const limits = [];
  const scanned = [];
  const { worker, events } = build({
    listPendingDocumentIds: async limit => { limits.push(limit); return ['a', 'b']; },
    scanDocument: async id => { scanned.push(id); return 'clean'; },
  });
  await worker.sweep();
  await flush();
  assert.deepEqual(limits, [50]);
  assert.deepEqual(scanned, ['a', 'b']);

  const failing = build({ listPendingDocumentIds: async () => { throw new Error('db down'); } });
  await failing.worker.sweep();
  assert.deepEqual(failing.events, [{ type: 'sweep_failed' }]);
  assert.equal(events.filter(e => e.type === 'sweep_failed').length, 0);
});

test('start sweeps immediately then on interval with unref-ed timers; stop clears timers', async () => {
  let lists = 0;
  const { worker, t } = build({
    sweepIntervalMs: 1234,
    listPendingDocumentIds: async () => { lists += 1; return []; },
  });
  worker.start();
  worker.start();
  await flush();
  assert.equal(lists, 1);
  const first = t.active();
  assert.equal(first.length, 1);
  assert.equal(first[0].ms, 1234);
  assert.equal(first[0].unrefCalled, true);
  t.fire(first[0]);
  await flush();
  assert.equal(lists, 2);
  assert.equal(t.active().length, 1);
  await worker.stop();
  assert.equal(t.active().length, 0);
  worker.start();
  await worker.sweep();
  await flush();
  assert.equal(lists, 2);
});

test('sweep failure inside the timer never throws out', async () => {
  const { worker, t, events } = build({ listPendingDocumentIds: async () => { throw new Error('x'); } });
  worker.start();
  await flush();
  t.fire(t.active().at(-1));
  await flush();
  assert.equal(events.filter(e => e.type === 'sweep_failed').length, 2);
  await worker.stop();
});

test('stop awaits in-flight scans, drops queue, and later calls are no-ops', async () => {
  const gate = deferred();
  const scanned = [];
  const { worker, t } = build({
    concurrency: 1,
    scanDocument: async id => { scanned.push(id); await gate.promise; return 'clean'; },
  });
  worker.schedule('a');
  worker.schedule('b');
  await flush();
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  gate.resolve();
  await stopping;
  await flush();
  assert.deepEqual(scanned, ['a']);
  worker.schedule('c');
  await worker.sweep();
  await worker.stop();
  await flush();
  assert.deepEqual(scanned, ['a']);
  assert.equal(t.active().length, 0);
});

test('stop clears pending retry timers', async () => {
  const { worker, t } = build({ scanDocument: async () => { throw retryable('SCANNER_UNAVAILABLE'); } });
  worker.schedule('a');
  await flush();
  assert.equal(t.active().length, 1);
  await worker.stop();
  assert.equal(t.active().length, 0);
});

test('restart semantics: a new worker re-scans pending documents', async () => {
  const pending = ['a'];
  const scanned = [];
  const make = () => build({
    listPendingDocumentIds: async () => pending,
    scanDocument: async id => { scanned.push(id); throw Object.assign(new Error('x'), { code: 'SCANNER_ERROR', retryable: false }); },
  });
  const first = make();
  await first.worker.sweep();
  await flush();
  assert.equal(first.worker.stats().exhausted, 1);
  await first.worker.sweep();
  await flush();
  assert.equal(scanned.length, 1);
  const second = make();
  await second.worker.sweep();
  await flush();
  assert.equal(scanned.length, 2);
});

test('queue is capped at 500 and extras are dropped', async () => {
  const gate = deferred();
  const scanned = [];
  const { worker } = build({
    concurrency: 1,
    scanDocument: async id => { scanned.push(id); await gate.promise; return 'clean'; },
  });
  for (let i = 0; i < 700; i += 1) worker.schedule(`d${i}`);
  await flush();
  assert.deepEqual(worker.stats(), { inFlight: 1, queued: 500, exhausted: 0 });
  gate.resolve();
  for (let i = 0; i < 20; i += 1) await flush();
  assert.equal(scanned.length, 501);
  assert.ok(!scanned.includes('d700'));
  await worker.stop();
});

test('onEvent errors do not break the worker', async () => {
  const { worker } = build({ onEvent: () => { throw new Error('observer'); } });
  worker.schedule('a');
  await flush();
  assert.equal(worker.stats().inFlight, 0);
});
