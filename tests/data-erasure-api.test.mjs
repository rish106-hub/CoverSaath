// S3 routes: erasure and export over HTTP. Authorisation, confirmation, cross-household denial, export scope, retention sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, household, ask } from './support/household-api-harness.mjs';
import { createRetentionService } from '../src/backend/services/retention-service.js';
import { createBackendServices } from '../src/backend/services/index.js';

const opts = postgresTestOptions();
const caseCount = async (app, who) => (await app.call(`/api/v1/households/${who.householdId}/cases`, { token: who.token })).data.cases.length;
const grantCaseRead = (app, who) => app.call('/api/v1/consents', { method: 'POST', token: who.token, body: { householdId: who.householdId, subjectAdultId: who.adultId, purpose: 'coverage_reconstruction',
  scopes: [{ resourceType: 'case', resourceId: who.caseId, action: 'read', dataCategory: 'case_summary', recipient: who.adultId }] } });
const erase = (app, path, token, confirm) => app.call(path, { method: 'POST', token, body: confirm === undefined ? {} : { confirm } });

test('erasure routes: confirmation, ownership, role and cross-household denial', opts, async t => {
  const app = await startApp(t);
  const a = await household(app, { name: 'Alpha' });
  const b = await household(app, { name: 'Bravo' });
  await ask(app, a);
  // Viewer in household A.
  const services = createBackendServices(app.database);
  const viewer = await services.households.createAdult({ displayName: 'Viewer Synthetic' });
  await services.households.addRole({ householdId: a.householdId, adultUserId: viewer.id, role: 'viewer' });
  const viewerSession = (await services.auth.issueSession({ adultUserId: viewer.id })).token;

  // No credential, wrong confirmation, foreign household.
  assert.equal((await app.call(`/api/v1/households/${a.householdId}/erasure`, { method: 'POST', body: { confirm: a.householdId } })).status, 401);
  const noConfirm = await erase(app, `/api/v1/households/${a.householdId}/erasure`, a.token);
  assert.equal(noConfirm.status, 400);
  assert.equal(noConfirm.data.error.code, 'ERASURE_CONFIRMATION_REQUIRED');
  assert.equal((await erase(app, `/api/v1/households/${a.householdId}/erasure`, a.token, 'wrong')).status, 400);
  for (const [path, id] of [[`/api/v1/households/${a.householdId}/erasure`, a.householdId], [`/api/v1/cases/${a.caseId}/erasure`, a.caseId], [`/api/v1/households/${a.householdId}/members/${a.memberId}/erasure`, a.memberId]]) {
    const foreign = await erase(app, path, b.token, id);
    assert.equal(foreign.status, 404, path);
    assert.ok(!JSON.stringify(foreign.data).includes(a.householdId) || foreign.data.error.code);
    const readOnly = await erase(app, path, viewerSession, id);
    assert.ok([403, 404].includes(readOnly.status), `viewer ${path} ${readOnly.status}`);
  }
  // Nothing was erased by the refusals.
  assert.equal(await caseCount(app, a), 1);

  // Owner erases the case: gone from reads and lists, documents removed, household stays.
  const erased = await erase(app, `/api/v1/cases/${a.caseId}/erasure`, a.token, a.caseId);
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  assert.equal(erased.data.status, 'erased');
  assert.equal(erased.data.documents.pending, 0);
  assert.equal(await caseCount(app, a), 0);
  assert.equal((await app.call(`/api/v1/cases/${a.caseId}/erasure`, { method: 'POST', token: a.token, body: { confirm: a.caseId } })).status, 404);
  assert.equal((await app.call(`/api/v1/documents/${a.documentIds[0]}`, { token: a.token })).status, 404 );
  const listed = await app.call(`/api/v1/households/${a.householdId}/cases`, { token: a.token });
  assert.deepEqual(listed.data.cases, []);
  assert.equal(Number((await app.database.one('SELECT count(*) AS n FROM document_blobs WHERE household_id = ?', [a.householdId])).n), 0);
  // B untouched.
  assert.equal(await caseCount(app, b), 1);

  // Owner erases the household: the session dies, a second call is 404, B still works.
  const household404 = await erase(app, `/api/v1/households/${a.householdId}/erasure`, a.token, a.householdId);
  assert.equal(household404.status, 200, JSON.stringify(household404.data));
  assert.equal((await app.call(`/api/v1/households/${a.householdId}`, { token: a.token })).status, 401);
  assert.equal((await app.call(`/api/v1/households/${b.householdId}`, { token: b.token })).status, 200);
  const left = await app.database.many("SELECT action FROM audit_events WHERE household_id = ? AND action LIKE '%erased%'", [a.householdId]);
  assert.ok(left.length >= 2);
});

test('member erasure over HTTP and the old delete route keep working', opts, async t => {
  const app = await startApp(t);
  const a = await household(app, { name: 'Alpha', documents: 1 });
  const kid = await app.call(`/api/v1/households/${a.householdId}/members`, { method: 'POST', token: a.token, body: { displayName: 'Kid Synthetic', memberKind: 'dependent', dateOfBirth: '2018-01-01' } });
  assert.equal(kid.status, 201);
  const owner = await erase(app, `/api/v1/households/${a.householdId}/members/${a.memberId}/erasure`, a.token, a.memberId);
  assert.equal(owner.status, 409);
  assert.equal(owner.data.error.code, 'MEMBER_PROTECTED');
  const gone = await erase(app, `/api/v1/households/${a.householdId}/members/${kid.data.id}/erasure`, a.token, kid.data.id);
  assert.equal(gone.status, 200, JSON.stringify(gone.data));
  const members = await app.call(`/api/v1/households/${a.householdId}/members`, { token: a.token });
  assert.equal(members.data.members.length, 1);
  assert.ok(!JSON.stringify(gone.data).includes('Kid'));
});

test('export: own household only, no bytes or text, counts-only audit; foreign ids are 404', opts, async t => {
  const app = await startApp(t);
  const a = await household(app, { name: 'Alpha' });
  const b = await household(app, { name: 'Bravo' });
  await app.call(`/api/v1/cases/${a.caseId}/profile-answers`, { method: 'PUT', token: a.token, body: { answers: { city: 'Pune' } } }).catch(() => undefined);
  const exported = await app.call(`/api/v1/households/${a.householdId}/export`, { token: a.token });
  assert.equal(exported.status, 200, JSON.stringify(exported.data));
  const text = JSON.stringify(exported.data);
  assert.equal(exported.data.household.id, a.householdId);
  assert.ok(exported.data.documents.length === 1 && exported.data.manifest.excluded.length > 0);
  assert.ok(!text.includes(b.householdId) && !text.includes(b.adultId) && !text.includes(b.caseId));
  assert.ok(!/token_sha256|storage_path|SYNTHETIC TEST DATA|subject_sha256/.test(text), 'no credentials, storage paths or document text');
  assert.equal((await app.call(`/api/v1/households/${a.householdId}/export`, { token: b.token })).status, 404);
  assert.equal((await app.call(`/api/v1/cases/${a.caseId}/export`, { token: b.token })).status, 404);
  assert.equal((await app.call(`/api/v1/households/${a.householdId}/members/${a.memberId}/export`, { token: b.token })).status, 404);
  assert.equal((await app.call(`/api/v1/households/${a.householdId}/export`)).status, 401);
  await grantCaseRead(app, a);
  const caseExport = await app.call(`/api/v1/cases/${a.caseId}/export`, { token: a.token });
  assert.equal(caseExport.status, 200, JSON.stringify(caseExport.data));
  assert.equal(caseExport.data.case.id, a.caseId);
  const memberExport = await app.call(`/api/v1/households/${a.householdId}/members/${a.memberId}/export`, { token: a.token });
  assert.equal(memberExport.status, 200, JSON.stringify(memberExport.data));
  const audit = await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'data_export.generated'");
  assert.equal(audit.length, 3);
  for (const row of audit) for (const value of Object.values(JSON.parse(row.event_payload_json))) assert.equal(typeof value, 'number');
  // After erasure the export is gone with the household.
  await erase(app, `/api/v1/households/${a.householdId}/erasure`, a.token, a.householdId);
  assert.equal((await app.call(`/api/v1/households/${a.householdId}/export`, { token: a.token })).status, 401);
});

test('retention sweep: dry run by default changes nothing; apply erases only what is due and configured', opts, async t => {
  const app = await startApp(t);
  const a = await household(app, { name: 'Alpha', documents: 1 });
  const b = await household(app, { name: 'Bravo', documents: 1 });
  const services = createBackendServices(app.database);
  // Close A's case a year and a day ago.
  const old = new Date(Date.now() - 366 * 86_400_000).toISOString();
  await app.database.run(`UPDATE service_cases SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?`, [old, old, a.caseId]);
  const sweepWith = retention => createRetentionService({ database: app.database, erasure: services.erasure, appEvents: services.appEvents, userData: services.userDataRepository, documents: services.documents, retention });
  const none = { closedCaseDays: null, inactiveHouseholdDays: null, expiredSessionDays: null, deletedDocumentTombstoneDays: null, erasureLedgerDays: null };

  const unscheduled = await sweepWith(none).sweep({ apply: true });
  assert.equal(unscheduled.rules.closedCases.scheduled, false);
  assert.equal(await caseCount(app, a), 1);

  const dry = await sweepWith({ ...none, closedCaseDays: 365 }).sweep();
  assert.equal(dry.dryRun, true);
  assert.equal(dry.rules.closedCases.candidates, 1);
  assert.equal(dry.rules.closedCases.applied, 0);
  assert.equal(await caseCount(app, a), 1);

  const applied = await sweepWith({ ...none, closedCaseDays: 365 }).sweep({ apply: true });
  assert.equal(applied.rules.closedCases.applied, 1);
  assert.equal(await caseCount(app, a), 0);
  assert.equal(await caseCount(app, b), 1);
  const rerun = await sweepWith({ ...none, closedCaseDays: 365 }).sweep({ apply: true });
  assert.equal(rerun.rules.closedCases.candidates, 0);
  assert.ok(!JSON.stringify(applied).includes(a.caseId), 'sweep reports counts only');
  const events = await app.database.many("SELECT actor_type, actor_id FROM audit_events WHERE action = 'case.erased'");
  assert.deepEqual(events.map(e => [e.actor_type, e.actor_id]), [['system', 'retention-sweep']]);

  // Inactive household rule.
  await app.database.run('UPDATE households SET created_at = ? WHERE id = ?', [old, b.householdId]);
  await app.database.run('UPDATE api_sessions SET issued_at = ?, last_seen_at = NULL, expires_at = ?', [old, new Date(Date.parse(old) + 3_600_000).toISOString()]);
  const inactive = await sweepWith({ ...none, inactiveHouseholdDays: 7000 }).sweep();
  assert.equal(inactive.rules.inactiveHouseholds.candidates, 0);
});

test('a member-role adult cannot erase a member whose case someone else opened; the owner can', opts, async t => {
  const app = await startApp(t);
  const a = await household(app, { name: 'Alpha' });
  const services = createBackendServices(app.database);
  const kid = await app.call(`/api/v1/households/${a.householdId}/members`, { method: 'POST', token: a.token, body: { displayName: 'Kid Synthetic', memberKind: 'dependent' } });
  assert.equal(kid.status, 201);
  const kidCase = await app.call('/api/v1/cases', { method: 'POST', token: a.token, body: { householdId: a.householdId, subjectMemberId: kid.data.id, triggerType: 'planned_care' } });
  assert.equal(kidCase.status, 201, JSON.stringify(kidCase.data));
  const helper = await services.households.createAdult({ displayName: 'Helper Synthetic' });
  await services.households.addRole({ householdId: a.householdId, adultUserId: helper.id, role: 'member' });
  const helperToken = (await services.auth.issueSession({ adultUserId: helper.id })).token;

  const denied = await erase(app, `/api/v1/households/${a.householdId}/members/${kid.data.id}/erasure`, helperToken, kid.data.id);
  assert.equal(denied.status, 403, JSON.stringify(denied.data));
  assert.equal(denied.data.error.code, 'ERASURE_FORBIDDEN');
  // Nothing was erased: the member is listed, the owner's two cases and the documents are intact.
  const members = await app.call(`/api/v1/households/${a.householdId}/members`, { token: a.token });
  assert.ok(members.data.members.some(member => member.id === kid.data.id));
  assert.equal(await caseCount(app, a), 2);
  assert.equal(Number((await app.database.one('SELECT count(*) AS n FROM retention_records WHERE household_id = ?', [a.householdId])).n), 0);
  assert.equal(Number((await app.database.one('SELECT count(*) AS n FROM document_blobs WHERE household_id = ?', [a.householdId])).n), 1);

  const allowed = await erase(app, `/api/v1/households/${a.householdId}/members/${kid.data.id}/erasure`, a.token, kid.data.id);
  assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
  assert.equal(await caseCount(app, a), 1);
});

test('export never carries free-text reasons, even from audit rows written before reasons were restricted', opts, async t => {
  const app = await startApp(t);
  const a = await household(app, { name: 'Alpha' });
  const services = createBackendServices(app.database);
  await services.audit.append({ householdId: a.householdId, actorType: 'adult_user', actorId: 'adult-legacy', action: 'consent.revoked', resourceType: 'consent_grant', resourceId: 'consent-legacy', payload: { reason: 'my brother Rohan has a hospital bill', note: 'free text with spaces' } });
  const revoke = await app.call(`/api/v1/consents/${a.questionGrantId}/revoke`, { method: 'POST', token: a.token, body: { reason: 'private reason about my divorce' } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
  const exported = await app.call(`/api/v1/households/${a.householdId}/export`, { token: a.token });
  const text = JSON.stringify(exported.data);
  assert.ok(!/Rohan|hospital bill|divorce|free text/.test(text));
  const revoked = exported.data.audit.filter(event => event.action === 'consent.revoked');
  assert.equal(revoked.length, 2);
  for (const event of revoked) assert.ok(!('note' in event.payload) && (event.payload.reason === undefined || event.payload.reason === 'other'));
  assert.ok(!(await app.database.many('SELECT event_payload_json FROM audit_events')).some(row => /divorce/.test(row.event_payload_json)), 'the free text reached the audit trail');
});
