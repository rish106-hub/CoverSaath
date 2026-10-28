// S3.2 WP3: missing-await guards (design section 4) with in-memory fakes. No database needed: each
// fake returns Promises the way the PostgreSQL interface does, and each test fails if the code
// under test treats a pending or rejected Promise as a value. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { markDatabaseError } from '../src/backend/database/postgres/errors.js';
import { TenantAccessService, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { errorResponse, handleV1BackendRoute } from '../src/server/routes/v1-backend-routes.js';
import { createReadResponsePolicy } from '../src/server/policies/read-response-policy.js';
import { createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/features/ai-analysis/privacy-evidence-gate.js';

const rejecting = () => Promise.reject(markDatabaseError(Object.assign(new Error('Connection terminated unexpectedly'), { detail: 'synthetic-secret' })));

// A fake database interface: answers by SQL prefix, records statements, runs transactions inline.
function fakeDb(answers = {}) {
  const statements = [];
  const answer = (kind, sql, params) => {
    statements.push({ kind, sql, params });
    for (const [match, value] of Object.entries(answers)) {
      if (sql.includes(match)) return typeof value === 'function' ? value(params) : Promise.resolve(value);
    }
    return Promise.resolve(kind === 'many' ? [] : kind === 'run' ? { changes: 0 } : null);
  };
  return {
    statements,
    one: (sql, params) => answer('one', sql, params),
    many: (sql, params) => answer('many', sql, params),
    run: (sql, params) => answer('run', sql, params),
    async transaction(fn) { return fn(); },
    inTransaction: false,
  };
}

const run = { id: 'run-1', case_id: 'case-1', execution_mode: 'live', status: 'running', consent_grant_id: 'grant-1',
  input_json: JSON.stringify({ authorizedSourceIds: ['page-1'], authorizedSources: [{ sourceId: 'page-1', documentId: 'doc-1' }] }) };
const caseRow = { id: 'case-1', household_id: 'household-1', opened_by_adult_id: 'adult-1', analysis_subject_adult_id: 'adult-1', analysis_subject_member_id: 'member-1' };
const dispatchRequest = { task: 'profile', runId: 'run-1', caseId: 'case-1', subjectId: 'adult-1', modelRecipient: GEMINI_MODEL_RECIPIENT,
  authorizedSourceIds: ['page-1'], authorizedSources: [{ sourceId: 'page-1', documentId: 'doc-1' }] };

function portWith({ db, appended = [], consents = {}, audit } = {}) {
  const services = {
    cases: { get: async () => ({ id: 'case-1', household_id: 'household-1' }) },
    consents: { requireActive: async () => ({}), ...consents },
    workflows: { getRun: async () => run },
    audit: audit ?? { append: async event => { appended.push(event); return {}; } },
  };
  return createCoverageAnalysisPort({ database: db, services, clock: () => new Date('2026-10-16T10:00:00.000Z') });
}

const eligibleDb = (extra = {}) => fakeDb({
  'FROM workflow_runs WHERE id': run,
  'FROM service_cases service_case': caseRow,
  'FROM source_pages page': [{ id: 'page-1', document_upload_id: 'doc-1' }],
  ...extra,
});

test('control: an eligible dispatch is allowed and audited on the case household', async () => {
  const appended = [];
  assert.deepEqual(await portWith({ db: eligibleDb(), appended }).authorizeModelDispatch(dispatchRequest), { allowed: true, reasonCode: null });
  assert.equal(appended[0].householdId, 'household-1');
});

test('Boolean(db...) site: isConsentActive compares an awaited row and rejects on a database error', async () => {
  assert.equal(await portWith({ db: fakeDb() }).isConsentActive('grant-1', '2026-10-16T10:00:00.000Z'), false);
  assert.equal(await portWith({ db: fakeDb({ 'FROM consent_grants': { active: 1 } }) }).isConsentActive('grant-1', 'x'), true);
  await assert.rejects(portWith({ db: fakeDb({ 'FROM consent_grants': rejecting }) }).isConsentActive('grant-1', 'x'));
  // The persistent worker stops on a rejection instead of running tasks.
  const port = {
    ...Object.fromEntries(['getCase', 'requireCoverageConsent', 'findIdempotency', 'recordIdempotency', 'createRunWithParameters', 'verifyRunSourcesCurrent',
      'getCoverageSourcePages', 'loadKnownIdentifiers', 'getTask', 'dependencyOutputs', 'completeTask', 'failTask', 'recoverExpiredLeases', 'stopForRevocation',
      'persistTaskArtifact', 'recordModelObservations'].map(name => [name, async () => null])),
    getJob: async () => ({ id: 'run-1', status: 'running', consent_grant_id: 'grant-1' }),
    isConsentActive: () => rejecting(),
    claimNext: async () => { throw new Error('a task must not be claimed after a failed consent check'); },
  };
  await assert.rejects(createPersistentCoverageAnalysisService({ port }).runUntilSettled('run-1'), /Connection terminated/);
});

test('sync try/catch-deny sites: rejected consent, query or audit deny the dispatch', async () => {
  const consentRejects = portWith({ db: eligibleDb(), consents: { requireActive: async () => { throw Object.assign(new Error('x'), { code: 'CONSENT_REQUIRED' }); } } });
  assert.deepEqual(await consentRejects.authorizeModelDispatch(dispatchRequest), { allowed: false, reasonCode: 'COVERAGE_CONSENT_NOT_CURRENT' });
  const queryRejects = portWith({ db: eligibleDb({ 'FROM source_pages page': rejecting }) });
  assert.deepEqual(await queryRejects.authorizeModelDispatch(dispatchRequest), { allowed: false, reasonCode: 'DISPATCH_VALIDATION_ERROR' });
  const auditRejects = portWith({ db: eligibleDb(), audit: { append: () => rejecting() } });
  assert.deepEqual(await auditRejects.authorizeModelDispatch(dispatchRequest), { allowed: false, reasonCode: 'DISPATCH_AUDIT_FAILED' });
  assert.deepEqual(await portWith({ db: eligibleDb({ 'FROM workflow_runs WHERE id': rejecting }) }).verifyRunSourcesCurrent('run-1'), { allowed: false, reasonCode: 'COMMIT_RECHECK_ERROR' });
  assert.deepEqual(await portWith({ db: eligibleDb({ 'FROM source_pages page': [] }) }).verifyRunSourcesCurrent('run-1'), { allowed: false, reasonCode: 'SOURCE_CONSENT_NOT_CURRENT' });
  await assert.rejects(portWith({ db: fakeDb({ 'FROM service_cases service_case': caseRow, 'FROM household_members': rejecting }) }).loadKnownIdentifiers('case-1'),
    { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE' });
});

test('IN lists use one text[] parameter', async () => {
  const db = eligibleDb();
  await portWith({ db }).verifyRunSourcesCurrent('run-1');
  const eligibility = db.statements.find(statement => statement.sql.includes('FROM source_pages page'));
  assert.match(eligibility.sql, /page\.id = ANY\(CAST\(\? AS text\[\]\)\)/);
  assert.deepEqual(eligibility.params[1], ['page-1']);
  assert.equal(eligibility.params.length, 4);
});

test('promise?.household_id sites: revocation and artifacts audit on the run household', async () => {
  const appended = [];
  const db = eligibleDb();
  const port = portWith({ db, appended });
  await port.stopForRevocation('run-1');
  await port.persistTaskArtifact({ run, task: { id: 'task-1' }, taskKey: 'profile', output: {} });
  assert.deepEqual(appended.map(event => [event.action, event.householdId]), [['analysis.revoked', 'household-1'], ['analysis.task_completed', 'household-1']]);
  // Lock order inside the stop: run row first, then tasks, then the run update.
  const order = db.statements.map(statement => statement.sql.trim().split(/\s+/).slice(0, 3).join(' '));
  assert.ok(order.indexOf('SELECT id FROM') < order.indexOf('UPDATE workflow_tasks SET'));
});

test('array-callback site: householdMatrix awaits every per-member check and withholds non-true answers', async () => {
  const db = fakeDb({ 'count(*)': { count: 0 } });
  const members = [{ id: 'm1', adult_user_id: 'adult-2', display_name: 'Member One', date_of_birth: '1990-01-01' }];
  const make = canAccessField => new TenantAccessService(db, {
    auth: {}, households: { requireAccess: async () => ({ household: { id: 'h' }, role: { role: 'owner' } }), listMembers: async () => members },
    consents: { canAccessField, canAccessResource: async () => false },
  });
  const pendingTrue = await make(async () => true).householdMatrix({ adultId: 'adult-1' }, 'h');
  assert.equal(pendingTrue.members[0].dateOfBirth, '1990-01-01');
  const denied = await make(async () => false).householdMatrix({ adultId: 'adult-1' }, 'h');
  assert.equal(denied.members[0].dateOfBirth, null);
  await assert.rejects(make(() => rejecting()).householdMatrix({ adultId: 'adult-1' }, 'h'), /Connection terminated/);
});

test('read policy: requireCaseField rejects when the consent check rejects', async () => {
  const policy = createReadResponsePolicy({ database: fakeDb(), consents: { requireResourceAccess: async () => { throw Object.assign(new Error('x'), { code: 'FIELD_ACCESS_REQUIRED' }); } } });
  await assert.rejects(policy.requireCaseField({ principal: { adultId: 'a' }, caseRecord: { id: 'c', household_id: 'h', opened_by_adult_id: 'a' }, field: { purpose: 'p', dataCategory: 'd' } }),
    { code: 'FIELD_ACCESS_REQUIRED' });
});

test('route boundary: driver errors are classified and never leak their fields', () => {
  const driver = (code, detail = 'Key (id)=(synthetic-secret) already exists.') => Object.assign(new pg.DatabaseError('synthetic-secret message', 1, 'error'), {
    code, detail, table: 'synthetic-secret-table', constraint: 'synthetic-secret-constraint', column: 'c', where: 'synthetic-secret-where',
  });
  for (const [sqlstate, status, code] of [['23505', 409, 'BACKEND_REQUEST_FAILED'], ['P0001', 400, 'BACKEND_REQUEST_FAILED'], ['22P02', 400, 'BACKEND_REQUEST_FAILED'], ['40001', 503, 'DATABASE_UNAVAILABLE'], ['08006', 503, 'DATABASE_UNAVAILABLE']]) {
    const response = errorResponse(driver(sqlstate));
    assert.equal(response.status, status, sqlstate);
    assert.equal(response.body.error.code, code, sqlstate);
    assert.ok(!JSON.stringify(response).includes('synthetic-secret'), sqlstate);
  }
  // Application errors keep their own code and status.
  assert.deepEqual(errorResponse(Object.assign(new Error('Case not found.'), { code: 'CASE_NOT_FOUND', statusCode: 404 })), { status: 404, body: { error: { code: 'CASE_NOT_FOUND', message: 'Case not found.' } } });
});

test('route boundary: a rejected authentication query is a 503, and /ready is not ready without detail', async () => {
  const services = { access: { authenticate: () => rejecting(), bootstrapConfigured: true } };
  const req = { method: 'GET', url: '/api/v1/cases/x', headers: { host: '127.0.0.1:8787' }, socket: { remoteAddress: '203.0.113.7' } };
  const result = await handleV1BackendRoute({ req, url: new URL(req.url, 'http://127.0.0.1:8787'), database: fakeDb(), services, integrations: {}, config: {} });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'DATABASE_UNAVAILABLE');
  const readyReq = { ...req, url: '/api/v1/ready' };
  const ready = await handleV1BackendRoute({ req: readyReq, url: new URL(readyReq.url, 'http://127.0.0.1:8787'),
    database: { pool: { query: () => rejecting() } }, services, integrations: {}, config: {} });
  assert.equal(ready.status, 503);
  assert.deepEqual(ready.body, { status: 'not_ready', checks: { database: false, authentication: true } });
});
