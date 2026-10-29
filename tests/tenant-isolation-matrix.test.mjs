// S3.2 WP3: cross-household matrix over the v1 routes and the analysis port on PostgreSQL. The
// route handler, TenantAccessService, read-response policy and port are real; the auth, household
// and consent repositories are small async stand-ins with the same contracts (they are converted
// in parallel by WP1/WP2). Every protected route is asked for household B's resources by an adult
// of household A and must answer exactly as for a missing resource, with none of B's data.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { markDatabaseError } from '../src/backend/database/postgres/errors.js';
import { TenantAccessService, createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { handleV1BackendRoute } from '../src/server/routes/v1-backend-routes.js';
import { createApiServer } from '../src/server/create-server.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { insert, seedWorld } from './support/postgres-fixtures.mjs';

const pgOptions = postgresTestOptions();
const TOKENS = { a: 'a'.repeat(40), b: 'b'.repeat(40) };

function stubRepositories(db, overrides = {}) {
  const auth = {
    async authenticate(token) {
      const key = Object.entries(TOKENS).find(([, value]) => value === token)?.[0];
      return key ? { adultId: `adult-${key}`, sessionId: `session-${key}` } : null;
    },
  };
  const households = {
    async requireAccess(householdId, adultId) {
      const role = await db.one(`SELECT * FROM household_roles WHERE household_id = ? AND adult_user_id = ? AND status = 'active'`, [householdId, adultId]);
      if (!role) throw Object.assign(new Error('Household not found.'), { code: 'HOUSEHOLD_NOT_FOUND', statusCode: 404 });
      return { household: await db.one('SELECT * FROM households WHERE id = ?', [householdId]), role };
    },
    async listMembers(householdId) { return db.many('SELECT * FROM household_members WHERE household_id = ? ORDER BY id', [householdId]); },
    async listActiveRoles(householdId, adultId) { return db.many(`SELECT * FROM household_roles WHERE household_id = ? AND adult_user_id = ? AND status = 'active'`, [householdId, adultId]); },
  };
  // Only the subject may read their own fields in this stand-in.
  const consents = {
    async canAccessField({ subjectAdultId, viewerAdultId }) { return subjectAdultId === viewerAdultId; },
    async canAccessResource({ subjectAdultId, viewerAdultId }) { return subjectAdultId === viewerAdultId; },
    async requireResourceAccess(input) {
      if (!(await consents.canAccessResource(input))) throw Object.assign(new Error('Field access is required.'), { code: 'FIELD_ACCESS_REQUIRED', statusCode: 403 });
      return true;
    },
    async get(grantId) { return db.one('SELECT * FROM consent_grants WHERE id = ?', [grantId]); },
    async requireActive() { return {}; },
  };
  Object.assign(households, overrides.households);
  Object.assign(consents, overrides.consents);
  const audit = new AuditRepository(db);
  const access = new TenantAccessService(db, { auth, households, consents, env: {} });
  const fail = name => async () => { throw new Error(`${name} must not be reached across households`); };
  const cases = { get: async id => db.one('SELECT * FROM service_cases WHERE id = ?', [id]), create: fail('cases.create'), transition: fail('cases.transition') };
  const workflows = { getRun: async id => db.one('SELECT * FROM workflow_runs WHERE id = ?', [id]) };
  return { access, auth, households, consents, audit, cases, workflows };
}

async function seedTwoHouseholds(handle) {
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const ids of [a, b]) {
    await insert(handle.pool, 'workflow_tasks', { id: `task-${ids.case}`, workflow_run_id: ids.run });
    await insert(handle.pool, 'audit_events', { household_id: ids.household, case_id: ids.case, previous_event_hash: null, event_hash: `${ids.case}`.padEnd(64, '0') });
  }
  return { a, b };
}

function request(method, path, { token = TOKENS.a, body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = (async function* stream() { yield* chunks; })();
  Object.assign(req, {
    method, url: path,
    headers: { host: '127.0.0.1:8787', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'matrix-key-0001' },
    socket: { remoteAddress: '127.0.0.1' },
  });
  return req;
}

const call = (db, services, method, path, options) => {
  const req = request(method, path, options);
  return handleV1BackendRoute({
    req, url: new URL(path, 'http://127.0.0.1:8787'), database: db, services, integrations: {},
    config: { maxCases: 100, maxRunsPerCase: 5 }, documentUploads: { configured: false, getDocument: async () => null },
  });
};

// [method, path for household ids, body, expected status across households, expected code]
const matrix = ids => [
  ['GET', `/api/v1/households/${ids.household}`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['GET', `/api/v1/households/${ids.household}/members/${ids.adult}/fields/date_of_birth/access`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['POST', '/api/v1/cases', { householdId: ids.household, triggerType: 'renewal' }, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['GET', `/api/v1/cases/${ids.case}`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['GET', `/api/v1/cases/${ids.case}/source-pack`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['GET', `/api/v1/cases/${ids.case}/audit-events`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['GET', `/api/v1/cases/${ids.case}/documents`, undefined, 404, 'CASE_NOT_FOUND'],
  ['GET', `/api/v1/cases/${ids.case}/documents/deletion-inventory`, undefined, 404, 'CASE_NOT_FOUND'],
  ['GET', `/api/v1/cases/${ids.case}/questions/answer-x`, undefined, 404, 'CASE_NOT_FOUND'],
  ['POST', `/api/v1/cases/${ids.case}/transitions`, { toStatus: 'closed', expectedRevision: 'x' }, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['POST', `/api/v1/cases/${ids.case}/analysis-runs`, { consentGrantId: ids.consent }, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['POST', '/api/v1/consents', { householdId: ids.household, subjectAdultId: 'adult-a', purpose: 'document_processing' }, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['POST', `/api/v1/consents/${ids.consent}/revoke`, {}, 404, 'CONSENT_NOT_FOUND'],
  ['GET', `/api/v1/jobs/${ids.run}`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
  ['GET', `/api/v1/tasks/task-${ids.case}`, undefined, 404, 'HOUSEHOLD_NOT_FOUND'],
];

test('every protected route refuses another household\'s resources like missing ones and leaks nothing', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const { b } = await seedTwoHouseholds(handle);
  const services = stubRepositories(db);
  for (const [method, path, body, status, code] of matrix(b)) {
    const result = await call(db, services, method, path, { body });
    assert.equal(result.status, status, `${method} ${path}`);
    assert.equal(result.body.error.code, code, `${method} ${path}`);
    const text = JSON.stringify(result.body);
    for (const value of ['household-b', 'Household household-b', 'Member member-b', 'adult-b']) {
      assert.ok(!text.includes(value), `${method} ${path} leaked ${value}`);
    }
  }
  assert.equal((await db.one("SELECT count(*) AS count FROM service_cases WHERE household_id = 'household-b'")).count, 1, 'no case was created in B');
});

test('the same routes serve the caller\'s own household (the matrix is not denying everything)', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const { a } = await seedTwoHouseholds(handle);
  const services = stubRepositories(db);
  const own = [
    ['GET', `/api/v1/households/${a.household}`],
    ['GET', `/api/v1/cases/${a.case}`],
    ['GET', `/api/v1/cases/${a.case}/source-pack`],
    ['GET', `/api/v1/cases/${a.case}/audit-events`],
    ['GET', `/api/v1/jobs/${a.run}`],
    ['GET', `/api/v1/tasks/task-${a.case}`],
  ];
  for (const [method, path] of own) {
    const result = await call(db, services, method, path);
    assert.equal(result.status, 200, `${method} ${path}: ${JSON.stringify(result.body)}`);
  }
  // Awaited values, not spread Promises: the job carries its id and tasks, the matrix its members.
  const job = await call(db, services, 'GET', `/api/v1/jobs/${a.run}`);
  assert.equal(job.body.id, a.run);
  assert.equal(job.body.tasks.length, 1);
  const matrixBody = (await call(db, services, 'GET', `/api/v1/households/${a.household}`)).body;
  assert.deepEqual(matrixBody.members.map(member => member.id), [a.member]);
  assert.equal(matrixBody.members[0].fieldAccess.dateOfBirth, 'granted');
  assert.equal(matrixBody.members[0].policiesFound, 0);
});

test('fail closed: a rejected tenant or field check denies, and a dropped connection is a 503 without data', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const { a } = await seedTwoHouseholds(handle);
  // The field check rejects asynchronously: an un-awaited requireCaseField would serve the case.
  const denying = stubRepositories(db, { consents: { async requireResourceAccess() { throw Object.assign(new Error('denied'), { code: 'FIELD_ACCESS_REQUIRED', statusCode: 403 }); } } });
  for (const path of [`/api/v1/cases/${a.case}`, `/api/v1/cases/${a.case}/source-pack`, `/api/v1/jobs/${a.run}`, `/api/v1/tasks/task-${a.case}`]) {
    const result = await call(db, denying, 'GET', path);
    assert.equal(result.status, 403, path);
    assert.equal(result.body.error.code, 'FIELD_ACCESS_REQUIRED');
  }
  // The tenant check loses its connection.
  const lost = () => markDatabaseError(Object.assign(new Error('Connection terminated unexpectedly'), { detail: 'household-a' }));
  const dropped = stubRepositories(db, { households: { async requireAccess() { throw lost(); } } });
  for (const path of [`/api/v1/cases/${a.case}`, `/api/v1/households/${a.household}`, `/api/v1/jobs/${a.run}`]) {
    const result = await call(db, dropped, 'GET', path);
    assert.equal(result.status, 503, path);
    assert.deepEqual(result.body, { error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is temporarily unavailable. Try again later.' } });
  }
  // A field check that resolves to something other than true is withheld.
  const vague = stubRepositories(db, { consents: { async canAccessField() { return 'yes'; } } });
  const allowed = await call(db, vague, 'GET', `/api/v1/households/${a.household}/members/${a.adult}/fields/date_of_birth/access`);
  assert.deepEqual(allowed.body, { allowed: false });
});

test('createApiServer builds its database from DATABASE_URL, reports ready, and ends its pool on close', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  // Every repository accepts the PostgreSQL interface: building the backend on it must not throw.
  createBackendServices(db, { env: {} });
  const server = createApiServer({ env: { DATABASE_URL: handle.url, KNOWVIA_BOOTSTRAP_TOKEN: 'c'.repeat(40) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let open = true;
  const close = () => (open ? new Promise(resolve => { open = false; server.close(resolve); server.closeAllConnections(); }) : undefined);
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const [first, second] = await Promise.all([fetch(`${base}/api/v1/ready`), fetch(`${base}/api/v1/ready`)]);
  const body = await first.json();
  assert.equal(first.status, 200, JSON.stringify(body));
  assert.equal(second.status, 200);
  assert.equal(body.checks.database, true);
  await close();
  await new Promise(resolve => setTimeout(resolve, 100));
  const sessions = await handle.pool.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'cover_saath' AND pid <> pg_backend_pid()");
  assert.equal(sessions.rows[0].count, 0, 'the server pool was ended');

  // Without DATABASE_URL the API answers 500-class without the variable's value, and nothing listens on a database.
  const bare = createApiServer({ env: {} });
  await new Promise(resolve => bare.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { bare.close(resolve); bare.closeAllConnections(); }));
  const refused = await fetch(`http://127.0.0.1:${bare.address().port}/api/v1/ready`);
  assert.ok(refused.status >= 500);
  assert.ok(!JSON.stringify(await refused.json()).includes('postgres://'));
});

test('the analysis port refuses cross-household dispatch and keeps each household\'s audit chain', pgOptions, async t => {
  const { db, handle } = await freshDatabase(t);
  const { a, b } = await seedTwoHouseholds(handle);
  await handle.pool.query(`UPDATE workflow_runs SET execution_mode = 'live',
    input_json = $1 WHERE id = $2`, [JSON.stringify({ authorizedSourceIds: [a.page], authorizedSources: [{ sourceId: a.page, documentId: a.document }] }), a.run]);
  const services = stubRepositories(db);
  const port = createCoverageAnalysisPort({ database: db, services, clock: () => new Date('2026-10-16T10:30:00.000Z') });
  const dispatch = overrides => port.authorizeModelDispatch({
    task: 'profile', runId: a.run, caseId: a.case, subjectId: a.adult, modelRecipient: GEMINI_MODEL_RECIPIENT,
    authorizedSourceIds: [a.page], authorizedSources: [{ sourceId: a.page, documentId: a.document }], ...overrides,
  });
  assert.deepEqual(await dispatch({ caseId: b.case }), { allowed: false, reasonCode: 'RUN_NOT_DISPATCHABLE' });
  assert.deepEqual(await dispatch({ subjectId: b.adult }), { allowed: false, reasonCode: 'SUBJECT_MISMATCH' });
  assert.deepEqual(await dispatch({ authorizedSources: [{ sourceId: a.page, documentId: b.document }] }), { allowed: false, reasonCode: 'SOURCE_NOT_SELECTED_FOR_RUN' });
  // Household B's identifiers never appear in A's redaction list.
  const known = await port.loadKnownIdentifiers(a.case);
  assert.ok(known.length > 0);
  assert.ok(!JSON.stringify(known).includes('-b'));
  // A denied dispatch for A's run is audited on A's chain, not the global one.
  const denials = await db.many("SELECT household_id FROM audit_events WHERE action = 'analysis.model_dispatch_denied'");
  assert.ok(denials.some(row => row.household_id === a.household));
  assert.ok(denials.every(row => row.household_id !== b.household));
  // The task artifact audit resolves the run's household (an un-awaited case lookup gives null).
  await port.persistTaskArtifact({ run: { case_id: a.case }, task: { id: `task-${a.case}` }, taskKey: 'profile', output: {} });
  const artifact = await db.one("SELECT household_id FROM audit_events WHERE action = 'analysis.task_completed'");
  assert.equal(artifact.household_id, a.household);
});
