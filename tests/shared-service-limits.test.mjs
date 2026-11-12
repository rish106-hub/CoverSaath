import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { RuntimeLimitsRepository } from '../src/backend/repositories/runtime-limits-repository.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createSharedWindowLimiter } from '../src/backend/services/shared-window-limiter.js';
import { createUserDataService } from '../src/backend/services/user-data-service.js';
import { createRunBudget, createLedgerScope } from '../src/features/ai-analysis/live-coverage-runtime.js';
import { createModelGateway } from '../src/features/ai-analysis/index.js';
import { sealedCoverageInput } from './support/sealed-input.mjs';

// O-F4: per-adult service limits and the model spend cap hold across two API machines that share one database. Synthetic ids only.
const count = async (db, table) => Number((await db.one(`SELECT count(*) AS count FROM ${table}`)).count);

test('two limiter instances sharing one database enforce one combined window and store only an opaque hash', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  let now = 1_000_000_000_000;
  const store = new RuntimeLimitsRepository(db);
  const machine = () => createSharedWindowLimiter({ limit: 3, store, clock: () => now });
  const [one, two] = [machine(), machine()];
  await one.check('user-data:adult-synthetic-1');
  await two.check('user-data:adult-synthetic-1');
  await one.check('user-data:adult-synthetic-1');
  await assert.rejects(two.check('user-data:adult-synthetic-1'), { status: 429 });
  await two.check('user-data:adult-synthetic-2');
  const rows = await db.many('SELECT key_hash, request_count FROM rate_limit_buckets');
  assert.ok(rows.every(row => /^[0-9a-f]{32}$/.test(row.key_hash)), 'only a hash is stored, never the id');
  assert.equal(rows.length, 2, 'one row per key per window: one small upsert per check');
  // The window follows the caller's clock, so a new window starts fresh on every machine.
  now += 61_000;
  await two.check('user-data:adult-synthetic-1');
});

test('two machines checking in parallel never admit more than the shared limit', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const now = 1_000_000_000_000;
  const store = new RuntimeLimitsRepository(db);
  // Each machine's local window is wide (20), so only the shared count (limit 5) can refuse.
  const machine = () => createSharedWindowLimiter({ limit: 5, store, clock: () => now });
  const [one, two] = [machine(), machine()];
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => (index % 2 ? one : two).check('sync-push:adult-synthetic-1')));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 5, 'exactly the limit is admitted across both machines');
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.status === 429));
  const row = await db.one('SELECT request_count FROM rate_limit_buckets');
  assert.equal(Number(row.request_count), 10, 'every check was counted once by the atomic upsert');
});

test('a database failure fails closed: the call is refused, not judged on the local count', async () => {
  let fallbacks = 0;
  const limiter = createSharedWindowLimiter({
    limit: 2, store: { consumeRequest: async () => { throw new Error('database down'); } }, onFallback: () => { fallbacks += 1; },
  });
  await assert.rejects(limiter.check('k'), { status: 503 });
  await assert.rejects(limiter.check('k'), { status: 503 });
  await assert.rejects(limiter.check('k'), { status: 429 }, 'the local limit still refuses first');
  assert.equal(fallbacks, 2, 'refused locally, the third check never reached the store');
});

test('a user-data write is refused when the shared limit store fails', async () => {
  const access = { requireHousehold: async () => ({ role: { role: 'owner' } }) };
  let writes = 0;
  const repository = { setPermission: async () => { writes += 1; return { ok: true }; } };
  const limitStore = { consumeRequest: async () => { throw new Error('database down'); } };
  const service = createUserDataService({ access, repository, limitStore });
  await assert.rejects(service.setPermission({ adultId: 'adult-synthetic-1' }, 'household-synthetic-1', 'notifications', { state: 'granted', surface: 'settings' }),
    { code: 'USER_DATA_RATE_LIMITED', statusCode: 429 });
  assert.equal(writes, 0, 'no write without a shared count');
});

test('two user-data services sharing one database enforce one combined write limit', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const limitStore = new RuntimeLimitsRepository(db);
  const access = { requireHousehold: async () => ({ role: { role: 'owner' } }) };
  const repository = { setPermission: async () => ({ ok: true }) };
  const machine = () => createUserDataService({ access, repository, writesPerMinute: 2, limitStore });
  const [one, two] = [machine(), machine()];
  const principal = { adultId: 'adult-synthetic-1' };
  const body = { state: 'granted', surface: 'settings' };
  await one.setPermission(principal, 'household-synthetic-1', 'notifications', body);
  await two.setPermission(principal, 'household-synthetic-1', 'notifications', body);
  await assert.rejects(one.setPermission(principal, 'household-synthetic-1', 'notifications', body), { code: 'USER_DATA_RATE_LIMITED', statusCode: 429 });
});

test('backend services on two machines share the per-adult session call limit through PostgreSQL', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const [one, two] = [createBackendServices(db, { env: {} }), createBackendServices(db, { env: {} })];
  const principal = { adultId: 'adult-synthetic-1', sessionId: 'session-synthetic-1' };
  for (let index = 0; index < 30; index += 1) {
    await one.authTokens.listSessions(principal);
    await two.authTokens.listSessions(principal);
  }
  await assert.rejects(one.authTokens.listSessions(principal), { code: 'AUTH_RATE_LIMITED' });
  assert.equal(await count(db, 'rate_limit_buckets'), 1);
  // RATE_LIMIT_BACKEND=memory is the explicit off switch: no database row is written.
  const { db: other } = await freshDatabase(t);
  await createBackendServices(other, { env: { RATE_LIMIT_BACKEND: 'memory' } }).authTokens.listSessions(principal);
  assert.equal(await count(other, 'rate_limit_buckets'), 0);
});

test('a budget ledger failure denies the model call and releases the run reservation', async () => {
  const ledger = { reserveBudget: async () => { throw new Error('database down'); }, settleBudget: async () => true, budgetSnapshot: async () => ({}) };
  const run = createRunBudget(0.05, createLedgerScope(ledger, 'project', 5));
  await assert.rejects(run.reserve(0.01, { task: 'profile_extraction' }), /database down/);
  assert.equal(run.snapshot().reservedUsd, 0, 'the failed project reservation left no run reservation behind');
  let dispatched = 0;
  const gateway = createModelGateway({ mode: 'live', budget: run, liveRunner: async () => { dispatched += 1; } });
  const input = { context: { caseId: 'case-1', subjectId: 'adult-1', purpose: 'Extract requested cover facts.', requestedFields: ['room_rent_limit'] }, sources: [{ id: 'policy:v1:p3', version: 'v1', page: 3, text: 'Room rent applicability is unresolved.', status: 'unknown' }], upstream: [] };
  await assert.rejects(gateway.execute({ task: 'profile_extraction', input: sealedCoverageInput('profile_extraction', input), reservationUsd: 0.01 }));
  assert.equal(dispatched, 0, 'no database, no reservation, no paid call');
});
