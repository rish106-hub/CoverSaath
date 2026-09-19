import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCase, runCase } from '../src/core/engine.js';
import { createOrchestrator, createMemoryStore, createDiskStore, validateTaskOutput } from '../src/orchestration/index.js';
const caseInput = { trigger: 'planned_care', patientName: 'Demo adult', procedure: 'Sample procedure', hospital: 'Sample hospital', estimate: 500000, consent: true };
const sampleCase = () => runCase(createCase(caseInput));
function result(role, packet, overrides = {}) {
  return { output: { findings: [{ id: role, text: packet.sources[0].text, sourceIds: [packet.sources[0].id], severity: 'info', kind: 'observation' }], summary: 'Synthetic evidence reviewed; eligibility remains unknown.', verdict: 'pass', ...overrides }, usage: { inputTokens: 10, outputTokens: 10 }, provider: 'test', model: 'test-fixture', estimatedCostUsd: 0.001 };
}
const executor = { execute: async ({ role, packet }) => result(role, packet) };
async function until(orchestrator, id, predicate) {
  for (let count = 0; count < 1000; count++) { const run = await orchestrator.getRun(id); if (predicate(run)) return run; await new Promise(resolve => setImmediate(resolve)); }
  throw new Error('Run did not reach expected state.');
}
const finished = (engine, id) => until(engine, id, run => !['queued', 'running'].includes(run.status));

test('parallel workers and isolated reviewers form a real joined DAG', async () => {
  const deferred = new Map(); const dispatched = [];
  const engine = createOrchestrator({ store: createMemoryStore(), executor: { execute: ({ role, packet }) => {
    dispatched.push(role);
    if (role.endsWith('reviewer')) assert.ok(packet.upstream.every(item => !Object.hasOwn(item.output, 'verdict')));
    return new Promise(resolve => deferred.set(role, () => resolve(result(role, packet))));
  } } });
  const queued = await engine.createRun(await sampleCase(), { mode: 'fixture' });
  const running = await engine.start(queued.id); assert.equal(running.status, 'running');
  await until(engine, queued.id, () => dispatched.length === 3);
  assert.deepEqual(dispatched, ['cover-worker', 'rules-worker', 'coordination-worker']);
  deferred.get('cover-worker')(); await new Promise(resolve => setImmediate(resolve)); assert.equal(dispatched.length, 3);
  deferred.get('rules-worker')(); deferred.get('coordination-worker')();
  await until(engine, queued.id, () => dispatched.length === 5);
  assert.deepEqual(dispatched.slice(3), ['evidence-reviewer', 'safety-reviewer']);
  deferred.get('evidence-reviewer')(); deferred.get('safety-reviewer')();
  await until(engine, queued.id, () => dispatched.length === 6); deferred.get('primary')();
  const done = await finished(engine, queued.id); assert.equal(done.status, 'completed'); assert.equal(done.release.status, 'released');
  assert.equal(done.budget.reservedUsd, 0.12); assert.equal(done.usage.inputTokens, 60);
  assert.throws(() => { done.sources[0].text = 'mutated'; }, TypeError);
});
test('unsupported observations and invented amounts block before reviewer dispatch', async () => {
  const roles = [];
  const engine = createOrchestrator({ store: createMemoryStore(), executor: { execute: async ({ role, packet }) => {
    roles.push(role); return result(role, packet, role === 'rules-worker' ? { findings: [{ id: 'invented', text: 'You are covered for ₹9 lakh', sourceIds: [packet.sources[0].id], severity: 'info', kind: 'unknown' }] } : {});
  } } });
  const run = await engine.createRun(await sampleCase()); await engine.start(run.id);
  const done = await finished(engine, run.id); assert.equal(done.status, 'blocked'); assert.equal(roles.length, 3); assert.equal(done.release.findings.length, 0);
  assert.ok(done.release.blockers.some(message => /invented/.test(message)));
});
test('reviewer blocker stops primary, warning remains human-review required', async () => {
  for (const verdict of ['block', 'flag']) {
    const roles = [];
    const engine = createOrchestrator({ store: createMemoryStore(), executor: { execute: async ({ role, packet }) => { roles.push(role); return result(role, packet, role === 'safety-reviewer' ? { verdict } : {}); } } });
    const run = await engine.createRun(await sampleCase()); await engine.start(run.id); const done = await finished(engine, run.id);
    assert.equal(done.status, verdict === 'block' ? 'blocked' : 'flagged');
    assert.equal(roles.includes('primary'), verdict !== 'block');
    const attempt = await engine.recordCallAttempt(run.id, { shareContext: true }); assert.equal(attempt.telUrl, 'tel:+919749452397'); assert.equal(attempt.status, 'attempt_recorded');
    assert.equal((await engine.getRun(run.id)).release.status, verdict === 'block' ? 'blocked' : 'human_review_required');
  }
});
test('consent, source and per-run provider sharing are mandatory', async () => {
  const engine = createOrchestrator({ store: createMemoryStore(), executor });
  await assert.rejects(engine.createRun(createCase({ ...caseInput, consent: false })), /consented/);
  await assert.rejects(engine.createRun(createCase(caseInput)), /source-linked/);
  await assert.rejects(engine.createRun(await sampleCase(), { mode: 'live' }), /per-run/);
  assert.equal((await engine.createRun(await sampleCase(), { mode: 'live', modelConsent: true })).mode, 'live');
});
test('repeated starts do not duplicate tasks; cancellation prevents late publication', async () => {
  let calls = 0; const resolves = [];
  const engine = createOrchestrator({ store: createMemoryStore(), executor: { execute: ({ role, packet }) => { calls++; return new Promise(resolve => resolves.push(() => resolve(result(role, packet)))); } } });
  const run = await engine.createRun(await sampleCase()); await Promise.all([engine.start(run.id), engine.start(run.id)]);
  await until(engine, run.id, () => calls === 3); await engine.cancel(run.id); resolves.forEach(resolve => resolve());
  const done = await finished(engine, run.id); assert.equal(done.status, 'cancelled'); assert.equal(done.release.status, 'blocked'); assert.equal(calls, 3);
  await assert.rejects(engine.resume(run.id), /failed or interrupted/);
});
test('revocation aborts tasks, clears stored context and denies dial attempts', async () => {
  const engine = createOrchestrator({ store: createMemoryStore(), executor: { execute: () => new Promise(() => {}) } });
  const run = await engine.createRun(await sampleCase()); await engine.start(run.id);
  await until(engine, run.id, record => record.events.some(event => event.type === 'task_started'));
  await engine.revoke(run.id); const done = await engine.getRun(run.id);
  assert.equal(done.status, 'revoked'); assert.equal(done.input, null); assert.deepEqual(done.sources, []);
  assert.ok(Object.values(done.tasks).every(task => !task.output)); await assert.rejects(engine.recordCallAttempt(run.id), /Consent/);
});
test('disk restart preserves completed work and marks running tasks interrupted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coversaath-orchestration-'));
  const store = createDiskStore({ directory }); const engine = createOrchestrator({ store, executor });
  const run = await engine.createRun(await sampleCase()); const interrupted = structuredClone(run);
  interrupted.status = 'running'; interrupted.tasks['cover-worker'].status = 'running'; interrupted.tasks['cover-worker'].attempts = 1; interrupted.budget.reservedUsd = 0.02;
  await store.put(interrupted);
  const restarted = createOrchestrator({ store: createDiskStore({ directory }), executor });
  assert.equal((await restarted.getRun(run.id)).status, 'interrupted');
  assert.equal((await restarted.start(run.id)).status, 'interrupted');
  await restarted.resume(run.id); const done = await finished(restarted, run.id);
  assert.equal(done.status, 'completed'); assert.equal(done.tasks['cover-worker'].attempts, 2); assert.equal(done.budget.reservedUsd, 0.14);
});
test('project reservations survive completed runs and block before new dispatch', async () => {
  let calls = 0; const store = createMemoryStore();
  const engine = createOrchestrator({ store, projectBudgetUsd: 0.13, executor: { execute: async args => { calls++; return executor.execute(args); } } });
  const first = await engine.createRun(await sampleCase()); await engine.start(first.id); await finished(engine, first.id); assert.equal(calls, 6);
  const second = await engine.createRun(await sampleCase()); await engine.start(second.id); const done = await finished(engine, second.id);
  assert.equal(done.status, 'blocked'); assert.equal(calls, 6); assert.match(done.release.blockers[0], /project budget/);
});
test('timeout failures keep reservations and require bounded explicit retry', async () => {
  const engine = createOrchestrator({ store: createMemoryStore(), timeoutMs: 5, executor: { execute: () => new Promise(() => {}) } });
  const run = await engine.createRun(await sampleCase()); await engine.start(run.id); const failed = await finished(engine, run.id);
  assert.equal(failed.status, 'failed'); assert.equal(failed.budget.reservedUsd, 0.06);
  await engine.resume(run.id); const twice = await finished(engine, run.id); assert.equal(twice.budget.reservedUsd, 0.12);
  await assert.rejects(engine.resume(run.id), /attempt limit/);
});
test('citations cannot be hallucinated and wrong kind cannot bypass safe forms', () => {
  const sources = [{ id: 'known', text: 'Source excerpt.' }];
  const finding = { id: 'unsafe', text: 'Source excerpt.', sourceIds: ['missing'], severity: 'info', kind: 'observation' };
  assert.equal(validateTaskOutput({ findings: [finding], summary: 'Review', verdict: 'pass' }, sources).pass, false);
  for (const text of ['The procedure is covered', 'Unknown payable amount: ₹900000', 'You are eligible for nine lakh?']) {
    assert.equal(validateTaskOutput({ findings: [{ ...finding, sourceIds: ['known'], text, kind: 'unknown' }], summary: 'Review', verdict: 'pass' }, sources).pass, false);
  }
  assert.equal(validateTaskOutput({ findings: [{ ...finding, text: sources[0].text, sourceIds: ['known'] }], summary: 'Your payout is ₹900000.', verdict: 'pass' }, sources).pass, false);
});
test('executor dispatch is bounded across simultaneous runs', async () => {
  let simultaneous = 0; let maximum = 0;
  const engine = createOrchestrator({ store: createMemoryStore(), executor: { execute: async ({ role, packet }) => {
    simultaneous++; maximum = Math.max(maximum, simultaneous);
    await new Promise(resolve => setImmediate(resolve)); simultaneous--; return result(role, packet);
  } } });
  const runs = await Promise.all([1, 2, 3].map(async () => engine.createRun(await sampleCase())));
  await Promise.all(runs.map(run => engine.start(run.id))); await Promise.all(runs.map(run => finished(engine, run.id)));
  assert.equal(maximum, 3); assert.equal(simultaneous, 0);
});
