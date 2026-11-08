// P1-1: run and task idempotency responses are sealed (migration 030), so erasure cannot find them by the ids they mention.
// They carry household_id / case_id columns (migration 038) and erasure deletes by those. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { createCoverageAnalysisPort } from '../src/backend/services/coverage-analysis-port.js';
import { createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
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

// The service records the key itself when the port did not (no idempotencyRecorded flag). That path must pass the ids.
test('the persistent-service fallback records household and case ids, so case erasure removes the key', opts, async t => {
  const ctx = await freshDatabase(t);
  const { db } = ctx;
  const NOW = new Date('2026-10-16T10:30:00.000Z');
  const a = await seedWorld(ctx.handle.pool, 'a');
  const b = await seedWorld(ctx.handle.pool, 'b');
  const stubs = {
    audit: new AuditRepository(db, { clock: () => NOW }),
    cases: { async get(caseId) { const row = await db.one('SELECT * FROM service_cases WHERE id = ?', [caseId]); return row ? { ...row, revision: row.updated_at } : null; } },
    consents: { async requireActive(grantId) { return db.one('SELECT id FROM consent_grants WHERE id = ? AND revoked_at IS NULL', [grantId]); } },
    workflows: {
      async createRun({ id, caseId, workflowName, workflowVersion, executionMode, consentGrantId }) {
        await db.run(`INSERT INTO workflow_runs (id, case_id, workflow_name, workflow_version, execution_mode, status, consent_grant_id, input_digest, created_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`, [id, caseId, workflowName, workflowVersion, executionMode, consentGrantId ?? null, hex('d'), NOW.toISOString()]);
        return { id };
      },
      async insertTask({ key, runId }) { return { id: `${runId}:${key}` }; },
      async getRun() { return null }, async listTasks() { return []; },
    },
    coverageParameters: { async initializeRunParameters() { return { total: 0 }; }, async setAcquisitionStateForRun() { return {}; } },
  };
  const real = createCoverageAnalysisPort({ database: db, services: stubs, clock: () => NOW });
  // Same port, but creation never records the key, so the service falls back to recordIdempotency.
  const port = { ...real, createRunWithParameters: async ({ idempotency, ...input }) => real.createRunWithParameters(input), getJob: async id => ({ id }) };
  const analysis = createPersistentCoverageAnalysisService({ port, clock: () => NOW });
  for (const [ids, key] of [[a, 'fallback-key-a1'], [b, 'fallback-key-b1']]) {
    const result = await analysis.createAnalysisRun({ caseId: ids.case, consentGrantId: ids.consent, idempotencyKey: key });
    assert.equal(result.created, true);
  }
  const count = async key => Number((await db.one('SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key = ?', [key])).n);
  const stored = await db.one('SELECT household_id, case_id FROM idempotency_keys WHERE idempotency_key = ?', ['fallback-key-a1']);
  assert.deepEqual([stored.household_id, stored.case_id], [a.household, a.case]);
  await ctx.services.erasure.eraseCase({ householdId: a.household, caseId: a.case, actor: actorOf(a), reason: 'data_subject_request' });
  assert.equal(await count('fallback-key-a1'), 0, 'case a fallback key is gone');
  assert.equal(await count('fallback-key-b1'), 1, 'control key stays');
});
