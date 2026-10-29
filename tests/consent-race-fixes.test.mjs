// S3.2 security review fixes: consent races around analysis run creation and model observation
// recording on PostgreSQL. Each race is forced deterministically: a hook commits the revocation
// at the exact gap under test, or a second session holds the household lock until every
// concurrent request is queued on it. No sleeps. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { advisoryLockKey, householdLock } from '../src/backend/database/postgres/locks.js';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/features/ai-analysis/index.js';
import { createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import { createApiServer } from '../src/server/server.js';
import { liveEnv, setupLiveCase, stubModelDriver } from './support/live-analysis-scenario.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';

const pgOptions = postgresTestOptions();
const MARKER = 'wombat heron synthetic';
const PAGE_TEXT = `Synthetic schedule: room rent limit is 5000 and ${MARKER} applies.`;

// The shared live scenario server, also exposing the pool handle so a second session can hold locks.
async function startServer(t) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-consent-race-'));
  const { db: database, handle } = await freshDatabase(t);
  const server = createApiServer({ database, env: liveEnv, analysisLiveModelDriver: stubModelDriver() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    database,
    handle,
    async call(path, { method = 'GET', body, token, idempotencyKey } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, raw: await response.clone().text(), data: await response.json() };
    },
  };
}

// A live analysis service whose port may be wrapped by `wrap(basePort)` to force an interleaving.
function liveService(app, { wrap = port => port, maxActiveRunsPerCase = null } = {}) {
  const services = createBackendServices(app.database);
  const basePort = createCoverageAnalysisPort({ database: app.database, services, maxActiveRunsPerCase });
  const port = Object.freeze(wrap(basePort, services));
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver(),
    preDispatchValidator: request => basePort.authorizeModelDispatch(request),
    knownIdentifierLoader: caseId => basePort.loadKnownIdentifiers(caseId),
  })();
  return { services, port: basePort, service: createPersistentCoverageAnalysisService({ port, liveRegistry: registry }) };
}

const liveRun = (scenario, idempotencyKey) => ({
  caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey,
});

async function caseRuns(database, caseId) {
  return database.many('SELECT id, status, input_json FROM workflow_runs WHERE case_id = ? ORDER BY id', [caseId]);
}

// A session outside the pool under test that holds `lockSql` until released.
async function holdLock(handle, lockSql, params = []) {
  const client = await handle.pool.connect();
  await client.query('BEGIN');
  await client.query(lockSql, params);
  let done = false;
  return async () => {
    if (done) return;
    done = true;
    await client.query('COMMIT');
    client.release();
  };
}

// Waits until `count` other sessions of this database are blocked on a lock.
async function waitForWaiters(handle, count) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { rows: [row] } = await handle.pool.query(`SELECT count(*)::int AS waiting FROM pg_stat_activity
      WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    if (row.waiting >= count) return;
    await new Promise(done => setTimeout(done, 10));
  }
  throw new Error(`Timed out waiting for ${count} blocked sessions.`);
}

test('a coverage grant revoked after the pre-check but before run creation creates no run and stores no excerpt', pgOptions, async t => {
  const app = await startServer(t);
  const scenario = await setupLiveCase(app, { pageText: PAGE_TEXT, suffix: 'race-create' });
  let revoked = false;
  const { service } = liveService(app, {
    // The service has passed requireCoverageConsent; the revocation commits before the run transaction.
    wrap: (port, services) => ({
      ...port,
      async createRunWithParameters(input) {
        await services.consents.revoke({ grantId: scenario.coverageConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic race' });
        revoked = true;
        return port.createRunWithParameters(input);
      },
    }),
  });

  await assert.rejects(service.createAnalysisRun(liveRun(scenario, 'race-create')), { code: 'CONSENT_REQUIRED' });
  assert.equal(revoked, true, 'the revocation committed inside the gap');
  assert.deepEqual(await caseRuns(app.database, scenario.caseId), [], 'no run exists under the revoked grant');
  assert.equal((await app.database.one('SELECT count(*) AS count FROM workflow_tasks')).count, 0);
  assert.equal((await app.database.one("SELECT count(*) AS count FROM idempotency_keys WHERE idempotency_key = 'race-create'")).count, 0);
  assert.equal((await app.database.one('SELECT count(*) AS count FROM coverage_parameter_records')).count, 0);
});

test('stopping a run whose own coverage grant is revoked erases its excerpts', pgOptions, async t => {
  const app = await startServer(t);
  const scenario = await setupLiveCase(app, { pageText: PAGE_TEXT, suffix: 'stop-erase' });
  const { service } = liveService(app);
  const { job } = await service.createAnalysisRun(liveRun(scenario, 'stop-erase'));
  assert.ok(job.input_json.includes(MARKER), 'the run holds the excerpt before the stop');
  // A run the revocation never saw (for example one that escaped it before the fix above):
  // the grant is revoked without the repository cascade.
  await app.database.run('UPDATE consent_grants SET revoked_at = ? WHERE id = ?', [new Date().toISOString(), scenario.coverageConsentId]);

  const settled = await service.runUntilSettled(job.id);
  assert.equal(settled.status, 'revoked');
  const [run] = await caseRuns(app.database, scenario.caseId);
  assert.ok(!run.input_json.includes(MARKER), 'run input keeps no excerpt');
  for (const sourcePage of JSON.parse(run.input_json).sourcePages) assert.equal(sourcePage.redacted, 'consent_revoked');
  const outputs = await app.database.many('SELECT output_json FROM workflow_tasks WHERE workflow_run_id = ?', [job.id]);
  assert.ok(outputs.every(task => task.output_json === null));
  assert.equal((await app.database.one("SELECT count(*) AS count FROM audit_events WHERE action = 'analysis.derived_data_erased'")).count, 1);
});

test('a derive grant revoked after the commit re-check but before observations are recorded writes no observation', pgOptions, async t => {
  const app = await startServer(t);
  // The upload grant's own derive scope names no recipient, so it never authorises the model.
  const scenario = await setupLiveCase(app, { pageText: PAGE_TEXT, suffix: 'race-observe', recipient: null });
  const services = createBackendServices(app.database);
  const deriveGrant = await services.consents.grant({
    householdId: scenario.householdId, subjectAdultId: scenario.ownerId, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', resourceId: scenario.documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' }],
  });
  let revokedBefore = null;
  const rejections = [];
  const { service } = liveService(app, {
    // persistent-service has run verifyRunSourcesCurrent; the derive-only revocation commits
    // before the first observation transaction. It does not erase the run's input.
    wrap: port => ({
      ...port,
      async recordModelObservations(input) {
        if (!revokedBefore) {
          await services.consents.revoke({ grantId: deriveGrant.id, revokedByAdultId: scenario.ownerId, reason: 'synthetic race' });
          revokedBefore = input.taskKey;
        }
        try {
          return await port.recordModelObservations(input);
        } catch (error) {
          rejections.push(error);
          throw error;
        }
      },
    }),
  });
  const { job } = await service.createAnalysisRun(liveRun(scenario, 'race-observe'));
  assert.deepEqual(JSON.parse(job.input_json).authorizedSources, [{ sourceId: scenario.pageId, documentId: scenario.documentId }]);

  const settled = await service.runUntilSettled(job.id);
  assert.ok(revokedBefore, 'the revocation committed inside the gap');
  assert.equal((await app.database.one('SELECT count(*) AS count FROM coverage_parameter_observations')).count, 0, 'zero observations committed');
  assert.ok(rejections.length >= 1);
  assert.equal(rejections[0].code, 'CONSENT_SCOPE_REQUIRED');
  assert.equal(rejections[0].reasonCode, 'SOURCE_CONSENT_NOT_CURRENT');
  assert.notEqual(settled.status, 'completed');
});

test('concurrent run creations with distinct keys at the cap create exactly the cap', pgOptions, async t => {
  const app = await startServer(t);
  const scenario = await setupLiveCase(app, { suffix: 'cap' });
  // The test pool has six connections: one holds the lock, one polls, four create.
  const cap = 2;
  const attempts = 4;
  const { service } = liveService(app, { maxActiveRunsPerCase: cap });
  const key = advisoryLockKey(...householdLock(scenario.householdId));
  const release = await holdLock(app.handle, 'SELECT pg_advisory_xact_lock($1::bigint)', [key]);
  let outcomes;
  try {
    // Every request passes its pre-checks and queues on the household lock of the run transaction.
    const creating = Array.from({ length: attempts }, (_, index) => service.createAnalysisRun({
      caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'fixture', idempotencyKey: `cap-${index}`,
    }));
    await waitForWaiters(app.handle, attempts);
    await release();
    outcomes = await Promise.allSettled(creating);
  } finally {
    await release();
  }
  const created = outcomes.filter(outcome => outcome.status === 'fulfilled');
  const refused = outcomes.filter(outcome => outcome.status === 'rejected');
  assert.equal(created.length, cap);
  assert.ok(created.every(outcome => outcome.value.created === true));
  assert.equal(refused.length, attempts - cap);
  for (const outcome of refused) {
    assert.equal(outcome.reason.code, 'ANALYSIS_CAPACITY_REACHED', outcome.reason.stack);
    assert.equal(outcome.reason.statusCode, 429);
  }
  const runs = await caseRuns(app.database, scenario.caseId);
  assert.equal(runs.length, cap);
  assert.ok(runs.every(run => run.status === 'queued'));
  assert.equal((await app.database.one("SELECT count(*) AS count FROM idempotency_keys WHERE scope = 'analysis_run'")).count, cap);
});

test('the active run limit must be a positive integer', () => {
  const services = { cases: {}, consents: {}, workflows: {}, audit: {} };
  for (const invalid of [0, -1, 1.5, '2']) {
    assert.throws(() => createCoverageAnalysisPort({ database: {}, services, maxActiveRunsPerCase: invalid }), TypeError);
  }
});
