import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { RuntimeLimitsRepository } from '../src/backend/repositories/runtime-limits-repository.js';
import { createRateLimiter } from '../src/shared/http/index.js';
import { createSharedRateLimiter } from '../src/server/http/shared-rate-limiter.js';
import { createRunBudget, createSharedProjectBudget } from '../src/features/ai-analysis/live-coverage-runtime.js';
import { createMemoryBudget, createModelGateway } from '../src/features/ai-analysis/index.js';
import { sealedCoverageInput } from './support/sealed-input.mjs';
import { createApiServer } from '../src/server/server.js';

// ADR 0014: request limit and model spend cap shared through PostgreSQL. Synthetic values only.
const hmacKey = randomBytes(32);
const count = async (db, table) => Number((await db.one(`SELECT count(*) AS count FROM ${table}`)).count);

test('two machines share one request limit and the counters hold no address', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  let now = 1_000_000_000_000;
  const store = new RuntimeLimitsRepository(db, { clock: () => now });
  const machine = () => createSharedRateLimiter({ local: createRateLimiter({ limit: 3, clock: () => now }), store, hmacKey, limit: 3 });
  const [one, two] = [machine(), machine()];
  await one.check('203.0.113.9');
  await two.check('203.0.113.9');
  await one.check('203.0.113.9');
  await assert.rejects(two.check('203.0.113.9'), { status: 429 });
  // Another client is unaffected; health traffic does not touch the database.
  assert.equal((await two.check('203.0.113.10')).remaining, 2);
  const before = await count(db, 'rate_limit_buckets');
  await two.check('203.0.113.11', { shared: false });
  assert.equal(await count(db, 'rate_limit_buckets'), before);
  const keys = await db.many('SELECT key_hash FROM rate_limit_buckets');
  assert.ok(keys.every(row => /^[0-9a-f]{32}$/.test(row.key_hash) && !row.key_hash.includes('203')));
  // A new window starts fresh and old windows can be purged.
  now += 61_000;
  assert.equal((await one.check('203.0.113.9')).remaining, 2);
  assert.ok(await store.purgeRequestWindows(30_000) >= 2);
});

test('a database failure falls back to the per-process limiter and never blocks the request', async () => {
  let fallbacks = 0;
  const limiter = createSharedRateLimiter({
    local: createRateLimiter({ limit: 2 }), store: { consumeRequest: async () => { throw new Error('database down'); } }, hmacKey, limit: 2, onFallback: () => { fallbacks += 1; },
  });
  await limiter.check('k');
  await limiter.check('k');
  await assert.rejects(limiter.check('k'), { status: 429 }, 'the local limit still applies');
  assert.equal(fallbacks, 2);
});

test('the spend cap is atomic across concurrent machines, survives a restart and settles once', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const ledger = new RuntimeLimitsRepository(db);
  const results = await Promise.all(Array.from({ length: 12 }, () => ledger.reserveBudget({ scope: 'project', amountUsd: 0.01, maxUsd: 0.035, task: 'profile_extraction' })));
  const held = results.filter(Boolean);
  assert.equal(held.length, 3, 'exactly three 1-cent reservations fit under a 3.5-cent cap');
  assert.equal((await ledger.budgetSnapshot('project', 0.035)).reservedUsd, 0.03);

  assert.equal(await ledger.settleBudget({ id: held[0].id, actualUsd: 0.004 }), true);
  assert.equal(await ledger.settleBudget({ id: held[0].id, actualUsd: 0.004 }), false, 'settling twice changes nothing');
  assert.equal(await ledger.settleBudget({ id: held[1].id, actualUsd: 0 }), true, 'zero releases the reservation');
  const restarted = new RuntimeLimitsRepository(db);
  const snapshot = await restarted.budgetSnapshot('project', 0.035);
  assert.deepEqual([snapshot.spentUsd, snapshot.reservedUsd], [0.004, 0.01]);
  assert.ok(await restarted.reserveBudget({ scope: 'project', amountUsd: 0.02, maxUsd: 0.035 }), 'released money can be reserved again');
  assert.equal(await restarted.reserveBudget({ scope: 'project', amountUsd: 0.02, maxUsd: 0.035 }), null);
  assert.equal(await restarted.reserveBudget({ scope: 'other', amountUsd: 0.02, maxUsd: 0.01 }), null, 'a scope has its own cap');
  assert.equal(await count(db, 'model_budget_reservations'), 4);
});

test('run budgets over the database ledger refuse at the project cap and release the run reservation', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const ledger = new RuntimeLimitsRepository(db);
  const project = createSharedProjectBudget({ ledger }).get(0.015);
  const run = createRunBudget(0.05, project);
  const first = await run.reserve(0.01, { task: 'profile_extraction' });
  assert.ok(first);
  assert.equal(await run.reserve(0.01, { task: 'profile_extraction' }), null);
  assert.equal(run.snapshot().reservedUsd, 0.01, 'the refused call left no run reservation behind');
  await run.settle(first, 0.006);
  assert.deepEqual([(await project.snapshot()).spentUsd, (await project.snapshot()).reservedUsd], [0.006, 0]);
  // A call that failed after dispatch stays reserved, as in memory.
  const second = await run.reserve(0.009, { task: 'profile_extraction' });
  await run.settle(second, null, { failed: true });
  assert.equal((await project.snapshot()).reservedUsd, 0.009);
});

test('the gateway reports metadata-only provider events and a throwing listener cannot affect the call', async () => {
  const events = [];
  const input = { context: { caseId: 'case-1', subjectId: 'adult-1', purpose: 'Extract requested cover facts.', requestedFields: ['room_rent_limit'] }, sources: [{ id: 'policy:v1:p3', version: 'v1', page: 3, text: 'Room rent applicability is unresolved.', status: 'unknown' }], upstream: [] };
  const refused = createModelGateway({ mode: 'live', budget: createMemoryBudget(0.001), liveRunner: async () => {}, onEvent: event => events.push(event) });
  await assert.rejects(refused.execute({ task: 'profile_extraction', input: sealedCoverageInput('profile_extraction', input), reservationUsd: 0.01 }), { code: 'budget_refused' });
  const failing = createModelGateway({ mode: 'live', budget: createMemoryBudget(0.05), liveRunner: async () => { throw new Error('synthetic provider failure'); }, onEvent: event => { events.push(event); throw new Error('listener failure'); } });
  await assert.rejects(failing.execute({ task: 'profile_extraction', input: sealedCoverageInput('profile_extraction', input), reservationUsd: 0.01 }), /synthetic provider failure/);
  assert.deepEqual(events.map(event => [event.outcome, event.dispatched]), [['budget_refused', false], ['error', true]]);
  assert.ok(events.every(event => !JSON.stringify(event).includes('synthetic provider failure')), 'no error text or prompt in an event');
  assert.ok(events.every(event => Number.isFinite(event.latencyMs) && event.costUsd === 0));
});

test('RATE_LIMIT_BACKEND=database counts requests in PostgreSQL through the API', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-test-bootstrap-token-0015', RATE_LIMIT_BACKEND: 'database', API_RATE_LIMIT_PER_MINUTE: '3', APP_EVENTS_ENABLED: 'false', DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/ready`;
  const statuses = [];
  for (let index = 0; index < 5; index += 1) statuses.push((await fetch(url)).status);
  assert.deepEqual(statuses.filter(status => status === 429).length, 2);
  // Requests the per-process limiter already refused never reach the database.
  assert.equal(Number((await db.one('SELECT sum(request_count) AS total FROM rate_limit_buckets')).total), 3);
  // Health probes are never counted in the database.
  const health = `http://127.0.0.1:${server.address().port}/api/v1/health`;
  await fetch(health);
  assert.equal(Number((await db.one('SELECT sum(request_count) AS total FROM rate_limit_buckets')).total), 3);
});
