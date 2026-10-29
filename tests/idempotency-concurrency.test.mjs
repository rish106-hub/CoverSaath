// S3.2 WP3: analysis-run idempotency and source re-check inside createRunWithParameters (design
// decisions 1 and 4), on PostgreSQL. The port and its SQL are real; the workflow and parameter
// repositories are small async stand-ins that write real rows, so these tests do not depend on
// the repository conversion (WP1/WP2). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { householdLock } from '../src/backend/database/postgres/locks.js';
import { createCoverageAnalysisPort } from '../src/backend/services/coverage-analysis-port.js';
import { COVERAGE_ANALYSIS_WORKFLOW, createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { handleV1BackendRoute } from '../src/server/routes/v1-backend-routes.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';

const pgOptions = postgresTestOptions();
const NOW = new Date('2026-10-16T10:30:00.000Z');

// Async stand-ins for the repositories the port calls. createRun writes a real workflow_runs row
// inside the caller's transaction and then sleeps there, which widens the race window.
function stubServices(db, { createRunDelayMs = 25 } = {}) {
  const calls = { createRun: 0, insertTask: 0, initialize: 0 };
  const services = {
    audit: new AuditRepository(db, { clock: () => NOW }),
    cases: {
      async get(caseId) {
        const row = await db.one('SELECT * FROM service_cases WHERE id = ?', [caseId]);
        return row ? { ...row, revision: row.updated_at } : null;
      },
    },
    consents: {
      async requireActive(grantId) {
        const row = await db.one('SELECT id FROM consent_grants WHERE id = ? AND revoked_at IS NULL', [grantId]);
        if (!row) throw Object.assign(new Error('Active consent is required.'), { code: 'CONSENT_REQUIRED', statusCode: 403 });
        return row;
      },
    },
    workflows: {
      async createRun({ id, caseId, workflowName, workflowVersion, executionMode, consentGrantId }) {
        calls.createRun += 1;
        await db.run(`INSERT INTO workflow_runs
          (id, case_id, workflow_name, workflow_version, execution_mode, status, consent_grant_id, input_digest, created_at)
          VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
        [id, caseId, workflowName, workflowVersion, executionMode, consentGrantId ?? null, 'd'.repeat(64), at]);
        await db.one('SELECT pg_sleep(?)', [createRunDelayMs / 1000]);
        return { id };
      },
      async insertTask({ key, runId }) { calls.insertTask += 1; return { id: `${runId}:${key}` }; },
      async getRun(runId) { return db.one('SELECT * FROM workflow_runs WHERE id = ?', [runId]); },
      async getTask() { return null; },
      async claimNext() { return null; },
      async recoverExpiredLeases() { return 0; },
    },
    coverageParameters: {
      async initializeRunParameters() { calls.initialize += 1; return { total: 0 }; },
      async setAcquisitionStateForRun() { return {}; },
    },
  };
  return { services, calls };
}

const keyRow = (db, key) => db.one('SELECT count(*) AS count FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?', ['analysis_run', key]);

function runCreation(ids, { id, idempotency, executionMode = 'fixture', input = {} } = {}) {
  return {
    id, caseId: ids.case, workflowName: COVERAGE_ANALYSIS_WORKFLOW.name, workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version,
    executionMode, consentGrantId: ids.consent, input,
    tasks: [{ key: 'profile', agentName: 'coverage-analysis/profile', taskKind: 'profile_intake', dependsOn: [], input: { key: 'profile' } }],
    parameters: {
      registryVersion: 'policy-parameters/v1', householdId: ids.household, caseId: ids.case, subjectId: ids.member,
      policyId: `UNCLASSIFIED:${'a'.repeat(24)}`, requestedKeys: [], receivedKeys: [],
    },
    ...(idempotency ? { idempotency } : {}),
  };
}

const idempotencyFor = (key, runId, requestDigest = 'd'.repeat(64)) => ({
  scope: 'analysis_run', key, requestDigest, responseStatus: 202, response: { runId }, expiresAt: '2026-10-17T10:30:00.000Z',
});

test('decision 1: ten concurrent creations with one key create exactly one run and one key', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'idem');
  const { services, calls } = stubServices(db);
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  const results = await Promise.all(Array.from({ length: 10 }, (_, index) => port.createRunWithParameters(
    runCreation(ids, { id: `run-idem-${index}`, idempotency: idempotencyFor('same-key-0001', `run-idem-${index}`) }),
  )));
  const created = results.filter(result => !result.existing);
  assert.equal(created.length, 1, 'one request creates the run');
  assert.equal(created[0].idempotencyRecorded, true);
  assert.equal(calls.createRun, 1);
  const winner = created[0].id;
  for (const result of results.filter(item => item.existing)) {
    assert.equal(JSON.parse(result.existing.response_json).runId, winner, 'every loser sees the winner\'s run');
  }
  assert.equal((await keyRow(db, 'same-key-0001')).count, 1);
  assert.equal((await db.one("SELECT count(*) AS count FROM workflow_runs WHERE id LIKE 'run-idem-%'")).count, 1);
  // The unclassified placeholder policy is created once (ON CONFLICT DO NOTHING) and audit is per run.
  assert.equal((await db.one('SELECT count(*) AS count FROM policies WHERE id = ?', [`UNCLASSIFIED:${'a'.repeat(24)}`])).count, 1);
  assert.equal((await db.one("SELECT count(*) AS count FROM audit_events WHERE action = 'analysis.parameters_initialized'")).count, 1);
});

test('control: the old find-then-record sequence lets concurrent requests with one key create several runs', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'legacy');
  const { services, calls } = stubServices(db);
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  // Pre-S3.2 flow: findIdempotency, create without the in-transaction key, then recordIdempotency.
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, async (_, index) => {
    if (await port.findIdempotency({ scope: 'analysis_run', key: 'legacy-key-01', at: NOW.toISOString() })) return 'replay';
    await port.createRunWithParameters(runCreation(ids, { id: `run-legacy-${index}` }));
    await port.recordIdempotency({ ...idempotencyFor('legacy-key-01', `run-legacy-${index}`) });
    return 'created';
  }));
  assert.ok(calls.createRun > 1, `without decision 1 the race creates several runs (got ${calls.createRun})`);
  assert.ok(outcomes.some(outcome => outcome.status === 'rejected'), 'and the later key inserts fail');
});

test('decision 1 through the persistent service: concurrent requests return one run; a different request is a conflict', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'svc');
  const { services, calls } = stubServices(db);
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  const analysis = createPersistentCoverageAnalysisService({ port, clock: () => NOW });
  const request = { caseId: ids.case, consentGrantId: ids.consent, idempotencyKey: 'service-key-01' };
  const results = await Promise.all(Array.from({ length: 10 }, () => analysis.createAnalysisRun(request)));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal(calls.createRun, 1);
  const runIds = new Set(results.map(result => result.job?.id));
  assert.equal(runIds.size, 1, 'every caller gets the same run');
  assert.ok([...runIds][0].startsWith('coverage-run-'));

  // A request that missed the fast path (the key committed meanwhile) is still checked inside the
  // transaction: a different request with the same key is a conflict and creates nothing.
  const racingPort = { ...port, findIdempotency: async () => null };
  const racing = createPersistentCoverageAnalysisService({ port: racingPort, clock: () => NOW });
  await assert.rejects(racing.createAnalysisRun({ ...request, fixtureVariant: 'blocked_source' }), { code: 'IDEMPOTENCY_CONFLICT' });
  const replay = await racing.createAnalysisRun(request);
  assert.equal(replay.created, false);
  assert.equal(replay.job.id, [...runIds][0]);
  assert.equal(calls.createRun, 1, 'neither the conflict nor the replay created a run');
});

test('decision 1: an expired key is replaced inside the transaction', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'expired');
  const { services, calls } = stubServices(db);
  await handle.pool.query(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
    VALUES ('analysis_run', 'expired-key-1', $1, 202, '{"runId":"run-gone"}', $2, $3)`, ['d'.repeat(64), '2026-10-16T10:00:00.000Z', at]);
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  const result = await port.createRunWithParameters(runCreation(ids, { id: 'run-fresh', idempotency: idempotencyFor('expired-key-1', 'run-fresh') }));
  assert.equal(result.existing, undefined);
  assert.equal(calls.createRun, 1);
  assert.equal(JSON.parse((await db.one('SELECT response_json FROM idempotency_keys WHERE idempotency_key = ?', ['expired-key-1'])).response_json).runId, 'run-fresh');
});

test('a failure after the run insert rolls back the run and the key together', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'rollback');
  const { services } = stubServices(db);
  services.coverageParameters.initializeRunParameters = async () => { throw Object.assign(new Error('registry'), { code: 'PARAMETER_REGISTRY_INVALID' }); };
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  await assert.rejects(port.createRunWithParameters(runCreation(ids, { id: 'run-rolled', idempotency: idempotencyFor('rollback-key-1', 'run-rolled') })), { code: 'PARAMETER_REGISTRY_INVALID' });
  assert.equal(await db.one('SELECT id FROM workflow_runs WHERE id = ?', ['run-rolled']), null);
  assert.equal((await keyRow(db, 'rollback-key-1')).count, 0);
  assert.equal(db.inTransaction, false);
});

// A live source: an OCR'd page of a clean document with a document-specific derive scope for the
// model recipient, under a grant that expires at 11:00.
async function seedLiveSource(handle, ids) {
  await handle.pool.query('UPDATE consent_grants SET expires_at = $1 WHERE id = $2', ['2026-10-16T11:00:00.000Z', ids.consent]);
  await insert(handle.pool, 'consent_scopes', {
    id: `scope-${ids.case}`, consent_grant_id: ids.consent, resource_type: 'document', resource_id: ids.document,
    action: 'derive', data_category: 'insurance_document', recipient: GEMINI_MODEL_RECIPIENT,
  });
  await handle.pool.query(`UPDATE source_pages SET output_contract_version = 'knowvia.ocr.v1', extracted_text = 'Synthetic page text.'
    WHERE id = $1`, [ids.page]);
  return { authorizedSourceIds: [ids.page], authorizedSources: [{ sourceId: ids.page, documentId: ids.document }] };
}

test('decision 4: a live run re-checks its sources inside the transaction and creates nothing when they lapsed', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'live');
  const input = await seedLiveSource(handle, ids);
  const { services, calls } = stubServices(db, { createRunDelayMs: 0 });

  const current = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  assert.equal((await current.getCoverageSourcePages(ids.case)).length, 1, 'the page is eligible before expiry');
  await current.createRunWithParameters(runCreation(ids, { id: 'run-live-ok', executionMode: 'live', input }));
  assert.equal(calls.createRun, 1);

  // The grant expired between source selection and run creation.
  const lapsed = createCoverageAnalysisPort({ database: db, services, clock: () => new Date('2026-10-16T11:30:00.000Z') });
  await assert.rejects(lapsed.createRunWithParameters(runCreation(ids, {
    id: 'run-live-lapsed', executionMode: 'live', input, idempotency: idempotencyFor('live-lapsed-01', 'run-live-lapsed'),
  })), { code: 'CONSENT_SCOPE_REQUIRED', statusCode: 403 });
  // A remapped document and an empty source list are refused the same way.
  await assert.rejects(current.createRunWithParameters(runCreation(ids, {
    id: 'run-live-remap', executionMode: 'live',
    input: { authorizedSources: [{ sourceId: ids.page, documentId: 'document-elsewhere' }] },
  })), { code: 'CONSENT_SCOPE_REQUIRED' });
  await assert.rejects(current.createRunWithParameters(runCreation(ids, { id: 'run-live-empty', executionMode: 'live', input: {} })), { code: 'CONSENT_SCOPE_REQUIRED' });
  assert.equal(calls.createRun, 1, 'no refused run was created');
  assert.equal((await keyRow(db, 'live-lapsed-01')).count, 0);
});

test('the analysis-run route awaits the settled job before spreading it, and replays by key', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'route');
  const { services } = stubServices(db, { createRunDelayMs: 0 });
  services.access = {
    authenticate: async () => ({ adultId: ids.adult, sessionId: 'session-route' }),
    requireCase: async () => db.one('SELECT * FROM service_cases WHERE id = ?', [ids.case]),
  };
  const post = async () => {
    const path = `/api/v1/cases/${ids.case}/analysis-runs`;
    const req = (async function* stream() { yield Buffer.from(JSON.stringify({ consentGrantId: ids.consent })); })();
    Object.assign(req, { method: 'POST', url: path, headers: { 'content-type': 'application/json', 'idempotency-key': 'route-key-0001', authorization: 'Bearer x' } });
    return handleV1BackendRoute({ req, url: new URL(path, 'http://127.0.0.1:8787'), database: db, services, integrations: {}, config: { maxRunsPerCase: 5 } });
  };
  const first = await post();
  assert.equal(first.status, 202, JSON.stringify(first.body));
  assert.ok(first.body.id.startsWith('coverage-run-'), 'the body carries the job, not {} from a spread Promise');
  assert.equal(first.body.caseId, ids.case);
  assert.ok(Array.isArray(first.body.tasks));
  assert.equal(first.body.dispatchStatus, 'fixture_completed');
  const replay = await post();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.id, first.body.id);
  assert.equal(replay.body.dispatchStatus, 'idempotent_existing_run');
});

test('decision 4: run creation waits for the household lock that revocation holds', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const ids = await seedWorld(handle.pool, 'locked');
  const { services, calls } = stubServices(db, { createRunDelayMs: 0 });
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => NOW });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let locked;
  const lockTaken = new Promise(resolve => { locked = resolve; });
  const revocation = db.transaction(async () => { locked(); await held; }, { locks: [householdLock(ids.household)] });
  await lockTaken;
  const creation = port.createRunWithParameters(runCreation(ids, { id: 'run-after-lock' }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls.createRun, 0, 'creation is blocked while the household lock is held');
  release();
  await revocation;
  await creation;
  assert.equal(calls.createRun, 1);
});
