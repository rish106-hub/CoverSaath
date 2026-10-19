// Round-2 findings C1 (analysis subject), C2 (expiry semantics) and A1 (no
// registry override on the server). Every identifier below is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/modules/ai-analysis/index.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { createPersistentCoverageAnalysisService } from '../src/modules/coverage-analysis/index.js';
import { createApiServer } from '../src/server/server.js';
import { liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';

const SUBJECT = 'adult-synthetic-subject';
const OTHER = 'adult-synthetic-other';

function addAdult(db, householdId, adultId, { memberId = `member-${adultId}` } = {}) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`).run(adultId, adultId, now, now);
  db.prepare(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES (?, ?, ?, 'member', 'active', ?)`).run(`role-${adultId}`, householdId, adultId, now);
  db.prepare(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES (?, ?, ?, 'Synthetic adult', 'adult', ?, ?)`).run(memberId, householdId, adultId, now, now);
  return memberId;
}

function addDependent(db, householdId, memberId) {
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES (?, ?, NULL, 'Synthetic dependent', 'dependent', ?, ?)`).run(memberId, householdId, now, now);
  return memberId;
}

function coverageGrant(services, { householdId, caseId, subjectAdultId }) {
  return services.consents.grant({
    householdId, subjectAdultId, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: caseId, action: 'derive', dataCategory: 'insurance_document' }],
  }).id;
}

function documentDeriveGrant(services, { householdId, documentId, subjectAdultId }) {
  return services.consents.grant({
    householdId, subjectAdultId, purpose: 'document_processing',
    scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: GEMINI_MODEL_RECIPIENT }],
  }).id;
}

async function subjectFixture(t) {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { suffix: 'subject-case' });
  const db = app.database;
  const services = createBackendServices(db);
  const port = createCoverageAnalysisPort({ database: db, services });
  const setSubjectMember = memberId => db.prepare('UPDATE service_cases SET subject_member_id = ? WHERE id = ?').run(memberId, scenario.caseId);
  const requireCoverage = consentGrantId => port.requireCoverageConsent({ caseRecord: port.getCase(scenario.caseId), consentGrantId });
  return { app, scenario, db, services, port, setSubjectMember, requireCoverage };
}

test('C1: the analysis subject is the subject member adult, not the case opener', async t => {
  const { scenario, db, services, port, setSubjectMember, requireCoverage } = await subjectFixture(t);
  const subjectMember = addAdult(db, scenario.householdId, SUBJECT);
  addAdult(db, scenario.householdId, OTHER);

  // Default scenario: subject member is the opener.
  assert.equal(port.getCase(scenario.caseId).analysis_subject_adult_id, scenario.ownerId);

  setSubjectMember(subjectMember);
  const caseRecord = port.getCase(scenario.caseId);
  assert.equal(caseRecord.analysis_subject_adult_id, SUBJECT);
  assert.equal(caseRecord.opened_by_adult_id, scenario.ownerId);

  // Deny: the opener's (or another adult's) coverage consent no longer covers the subject's analysis.
  assert.throws(() => requireCoverage(scenario.coverageConsentId), { code: 'CONSENT_REQUIRED' });
  assert.throws(() => requireCoverage(coverageGrant(services, { householdId: scenario.householdId, caseId: scenario.caseId, subjectAdultId: OTHER })), { code: 'CONSENT_REQUIRED' });
  // The subject is re-derived from the database; a caller cannot substitute it.
  assert.throws(() => port.requireCoverageConsent({ caseRecord: { ...caseRecord, analysis_subject_adult_id: scenario.ownerId }, consentGrantId: scenario.coverageConsentId }), { code: 'CONSENT_REQUIRED' });

  // Allow: the subject grants coverage reconstruction.
  const subjectCoverage = coverageGrant(services, { householdId: scenario.householdId, caseId: scenario.caseId, subjectAdultId: SUBJECT });
  assert.doesNotThrow(() => requireCoverage(subjectCoverage));

  // Source selection follows the same subject: the opener's document consent no longer admits the page.
  assert.deepEqual(port.getCoverageSourcePages(scenario.caseId), []);
  documentDeriveGrant(services, { householdId: scenario.householdId, documentId: scenario.documentId, subjectAdultId: SUBJECT });
  assert.deepEqual(port.getCoverageSourcePages(scenario.caseId).map(page => page.id), [scenario.pageId]);

  // Dispatch validator: subject check and coverage re-check use the same subject.
  const service = createPersistentCoverageAnalysisService({
    port,
    liveRegistry: createGeminiCoverageRegistryFactory({ env: liveEnv, ...stubModelDriver(), knownIdentifierLoader: () => [], preDispatchValidator: () => false })(),
  });
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: subjectCoverage, executionMode: 'live', modelPermission: true, idempotencyKey: 'subject-not-opener' });
  const request = subjectId => ({
    task: 'profile_extraction', runId: job.id, caseId: scenario.caseId, subjectId,
    authorizedSourceIds: [scenario.pageId], authorizedSources: [{ sourceId: scenario.pageId, documentId: scenario.documentId }],
    modelRecipient: GEMINI_MODEL_RECIPIENT, sourceDigests: [],
  });
  assert.deepEqual({ ...port.authorizeModelDispatch(request(SUBJECT)) }, { allowed: true, reasonCode: null });
  assert.deepEqual({ ...port.authorizeModelDispatch(request(scenario.ownerId)) }, { allowed: false, reasonCode: 'SUBJECT_MISMATCH' });
  assert.deepEqual({ ...port.authorizeModelDispatch(request(OTHER)) }, { allowed: false, reasonCode: 'SUBJECT_MISMATCH' });
  services.consents.revoke({ grantId: subjectCoverage, revokedByAdultId: SUBJECT, reason: 'synthetic' });
  db.prepare("UPDATE workflow_runs SET status = 'running' WHERE id = ?").run(job.id);
  assert.deepEqual({ ...port.authorizeModelDispatch(request(SUBJECT)) }, { allowed: false, reasonCode: 'COVERAGE_CONSENT_NOT_CURRENT' });
});

test('C1: a dependent subject without an adult account is consented by the opener (guardian)', async t => {
  const { scenario, db, services, port, setSubjectMember, requireCoverage } = await subjectFixture(t);
  addAdult(db, scenario.householdId, OTHER);
  setSubjectMember(addDependent(db, scenario.householdId, 'member-synthetic-dependent'));
  assert.equal(port.getCase(scenario.caseId).analysis_subject_adult_id, scenario.ownerId);
  assert.doesNotThrow(() => requireCoverage(scenario.coverageConsentId));
  assert.throws(() => requireCoverage(coverageGrant(services, { householdId: scenario.householdId, caseId: scenario.caseId, subjectAdultId: OTHER })), { code: 'CONSENT_REQUIRED' });
  assert.deepEqual(port.getCoverageSourcePages(scenario.caseId).map(page => page.id), [scenario.pageId]);
});

test('C1: a subject member from another household resolves to no subject and fails closed', async t => {
  const { scenario, db, port, setSubjectMember, requireCoverage } = await subjectFixture(t);
  const now = new Date().toISOString();
  db.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('household-synthetic-foreign', 'Foreign synthetic household', now, now);
  addDependent(db, 'household-synthetic-foreign', 'member-synthetic-foreign');
  // The schema already refuses the cross-household link ...
  assert.throws(() => setSubjectMember('member-synthetic-foreign'));
  // ... and with that trigger removed the port still fails closed.
  db.exec('DROP TRIGGER service_cases_household_refs_update');
  setSubjectMember('member-synthetic-foreign');
  assert.equal(port.getCase(scenario.caseId).analysis_subject_adult_id, null);
  assert.throws(() => requireCoverage(scenario.coverageConsentId), { code: 'CONSENT_REQUIRED' });
  assert.deepEqual(port.getCoverageSourcePages(scenario.caseId), []);
});

test('C2: consent expiry compares instants (julianday), and an unparseable expiry is expired', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  const services = createBackendServices(database);
  const port = createCoverageAnalysisPort({ database, services });
  const at = '2026-10-09T05:00:00.000Z';
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('household-expiry', 'Synthetic', at, at);
  database.prepare(`INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-expiry', 'Synthetic', 'active', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-expiry', 'household-expiry', 'adult-expiry', 'owner', 'active', ?)`).run(at);
  const grantWithExpiry = (id, expiresAt) => {
    database.prepare(`INSERT INTO consent_grants
      (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, expires_at, created_at)
      VALUES (?, 'household-expiry', 'adult-expiry', 'knowvia-local', 'coverage_reconstruction', 'v1', 'typed', ?, ?, ?)`).run(id, at, expiresAt, at);
    return id;
  };
  const cases = [
    // Offset form: 10:00+05:30 is 04:30Z, before `at`, although it sorts after it as a string.
    ['offset expiry already passed', grantWithExpiry('consent-offset-past', '2026-10-09T10:00:00+05:30'), false],
    ['unparseable expiry', grantWithExpiry('consent-garbage', 'not-a-date'), false],
    ['space-separated future expiry', grantWithExpiry('consent-space-future', '2026-10-09 06:00:00'), true],
    ['future ISO expiry', grantWithExpiry('consent-future', '2026-10-10T00:00:00.000Z'), true],
    ['no expiry', grantWithExpiry('consent-open', null), true],
  ];
  for (const [label, grantId, active] of cases) {
    const check = () => services.consents.requireActive(grantId, { subjectAdultId: 'adult-expiry', at });
    if (active) assert.doesNotThrow(check, label);
    else assert.throws(check, { code: 'CONSENT_REQUIRED' }, label);
    assert.equal(port.isConsentActive(grantId, at), active, label);
  }
  // An unparseable check time fails closed for any expiring grant.
  assert.throws(() => services.consents.requireActive('consent-future', { subjectAdultId: 'adult-expiry', at: 'garbage' }), { code: 'CONSENT_REQUIRED' });
  assert.equal(port.isConsentActive('consent-future', 'garbage'), false);
});

test('A1: the server offers no option to replace the live registry, gate or validator', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-a1-'));
  const database = openDatabase({ path: join(directory, 'knowvia.sqlite') });
  let overrideUsed = false;
  const modelRequests = [];
  const server = createApiServer({
    database,
    env: liveEnv,
    // Not a supported option: must be ignored.
    analysisLiveRegistryFactory: () => { overrideUsed = true; throw new Error('override must not be used'); },
    analysisLiveModelDriver: stubModelDriver({ modelRequests }),
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const app = {
    database,
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
  const scenario = await setupLiveCase(app, { pageText: 'Synthetic schedule: room rent limit is 5000. Mobile: 98765 43210.', suffix: 'a1-case' });
  const response = await scenario.startLiveRun('a1-no-registry-override');
  assert.equal(response.status, 202);
  assert.equal(overrideUsed, false);
  assert.ok(modelRequests.length >= 1);
  // The built-in path ran the privacy gate and the pre-dispatch validator.
  assert.ok(modelRequests.every(request => !request.prompt.includes('98765')));
  const authorized = database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'analysis.model_dispatch_authorized'").get().count;
  assert.equal(authorized, modelRequests.length);
});
