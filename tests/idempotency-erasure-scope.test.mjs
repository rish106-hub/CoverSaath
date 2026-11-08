// P1-1: run and task idempotency responses are sealed (migration 030), so erasure cannot find them by the ids they mention.
// They carry household_id / case_id columns (migration 038) and erasure deletes by those. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageAnalysisPort } from '../src/backend/services/coverage-analysis-port.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { seedWorld, hex } from './support/postgres-fixtures.mjs';

const opts = postgresTestOptions();
const actorOf = ids => ({ type: 'adult_user', id: ids.adult });
const EXPIRES = '2099-01-01T00:00:00.000Z';

// Writes one task key and one run key through the real writers.
async function seedKeys({ services, db }, ids, key) {
  const port = createCoverageAnalysisPort({ database: db, services });
  await services.workflows.enqueueTask({
    runId: ids.run, agentName: 'agent/x', taskKind: 'analyse', input: { excerpt: `EXCERPT-${key}` },
    idempotencyKey: `task-key-${key}-0001`, expiresAt: EXPIRES,
  });
  await port.recordIdempotency({
    scope: 'analysis_run', key: `run-key-${key}-0001`, requestDigest: hex('d'), responseStatus: 202,
    response: { runId: ids.run }, expiresAt: EXPIRES, householdId: ids.household, caseId: ids.case,
  });
}

const keysOf = async (db, key) => Number((await db.one(
  "SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key IN (?, ?)", [`task-key-${key}-0001`, `run-key-${key}-0001`])).n);

test('the sealed task and run keys are really sealed (the needle query cannot see them)', opts, async t => {
  const ctx = await freshDatabase(t);
  const a = await seedWorld(ctx.handle.pool, 'a');
  await seedKeys(ctx, a, 'a');
  const raw = await ctx.db.many("SELECT response_json FROM idempotency_keys WHERE idempotency_key LIKE '%-a-0001'");
  assert.equal(raw.length, 2);
  for (const row of raw) assert.ok(!row.response_json.includes(a.run) && !row.response_json.includes(a.case), 'response is ciphertext');
});

test('case erasure removes the case task and run idempotency keys and leaves another case alone', opts, async t => {
  const ctx = await freshDatabase(t);
  const a = await seedWorld(ctx.handle.pool, 'a');
  const b = await seedWorld(ctx.handle.pool, 'b');
  await seedKeys(ctx, a, 'a');
  await seedKeys(ctx, b, 'b');
  assert.equal(await keysOf(ctx.db, 'a'), 2);
  await ctx.services.erasure.eraseCase({ householdId: a.household, caseId: a.case, actor: actorOf(a), reason: 'data_subject_request' });
  assert.equal(await keysOf(ctx.db, 'a'), 0, 'case a keys are gone');
  assert.equal(await keysOf(ctx.db, 'b'), 2, 'case b keys are untouched');
});

test('household erasure removes the household task and run idempotency keys and leaves another household alone', opts, async t => {
  const ctx = await freshDatabase(t);
  const a = await seedWorld(ctx.handle.pool, 'a');
  const b = await seedWorld(ctx.handle.pool, 'b');
  await seedKeys(ctx, a, 'a');
  await seedKeys(ctx, b, 'b');
  await ctx.services.erasure.eraseHousehold({ householdId: a.household, actor: actorOf(a), reason: 'data_subject_request' });
  assert.equal(await keysOf(ctx.db, 'a'), 0, 'household a keys are gone');
  assert.equal(await keysOf(ctx.db, 'b'), 2, 'household b keys are untouched');
});
