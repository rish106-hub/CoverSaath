import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';

const bootstrapToken = 'coversaath-test-bootstrap-token-0002';

async function start(database) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, call, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function household(app, name) {
  const identity = await app.call('/api/v1/households', {
    method: 'POST', token: bootstrapToken,
    body: { displayName: `${name} household`, owner: { displayName: `${name} owner`, contactEmail: `${name.toLowerCase()}@example.test` } },
  });
  assert.equal(identity.status, 201);
  return { token: identity.data.session.token, householdId: identity.data.household.id, adultId: identity.data.owner.id, memberId: identity.data.ownerMember.id };
}

const consentBody = owner => ({
  householdId: owner.householdId, subjectAdultId: owner.adultId, purpose: 'document_processing',
  noticeVersion: 'draft-v0-needs-legal-review', evidenceMethod: 'typed',
  scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
});

async function setup(t) {
  const { db } = await freshDatabase(t);
  const app = await start(db);
  t.after(() => app.stop());
  return { app, db, owner: await household(app, 'Synthetic'), other: await household(app, 'Other') };
}

test('integrations lists intake connectors and scan mode without a provider call', postgresTestOptions(), async t => {
  const { app, owner } = await setup(t);
  const result = await app.call('/api/v1/integrations', { token: owner.token });
  assert.equal(result.status, 200);
  assert.equal(result.data.intake.length, 10);
  const byId = Object.fromEntries(result.data.intake.map(c => [c.id, c]));
  assert.equal(byId.gmail.health.status, 'not_built');
  assert.deepEqual(byId.upload.health, { connector: 'upload', status: 'available_via_document_route', networkAttempted: false });
  assert.equal(result.data.documentScan.mode, 'disabled');
  assert.deepEqual(result.data.hrms, { status: 'on_hold', intake: 'manual_upload_only' });
  assert.equal((await app.call('/api/v1/integrations')).status, 401);
});

test('case list is the caller\'s own, newest first, bounded and tenant-isolated', postgresTestOptions(), async t => {
  const { app, owner, other } = await setup(t);
  const open = async (who, triggerType) => app.call('/api/v1/cases', { method: 'POST', token: who.token, body: { householdId: who.householdId, subjectMemberId: who.memberId, triggerType, statedEstimateMinor: 123456, currency: 'INR' } });
  assert.equal((await open(owner, 'emergency')).status, 201);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await open(owner, 'planned_care')).status, 201);
  assert.equal((await open(other, 'planned_care')).status, 201);

  const listed = await app.call(`/api/v1/households/${owner.householdId}/cases`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.cases.length, 2);
  assert.equal(listed.data.truncated, false);
  assert.deepEqual(listed.data.cases.map(c => c.triggerType), ['planned_care', 'emergency']);
  assert.deepEqual(listed.data.cases.map(c => c.emergencyMode), [false, true]);
  const text = JSON.stringify(listed.data);
  for (const forbidden of ['stated_estimate_minor', 'statedEstimateMinor', 'currency', 'subject_member_id', 'subjectMemberId', '123456', 'example.test', owner.token]) {
    assert.equal(text.includes(forbidden), false, `${forbidden} must not be returned`);
  }
  assert.deepEqual(Object.keys(listed.data.cases[0]).sort(), ['createdAt', 'emergencyMode', 'id', 'status', 'triggerType', 'updatedAt']);

  const one = await app.call(`/api/v1/households/${owner.householdId}/cases?limit=1`, { token: owner.token });
  assert.equal(one.data.cases.length, 1);
  assert.equal(one.data.truncated, true);
  for (const limit of ['0', '101', 'abc', '-1', '1.5', '']) {
    const bad = await app.call(`/api/v1/households/${owner.householdId}/cases?limit=${limit}`, { token: owner.token });
    assert.equal(bad.status, 400, `limit=${limit}`);
    assert.equal(bad.data.error.code, 'INVALID_REQUEST');
  }
  const foreign = await app.call(`/api/v1/households/${other.householdId}/cases`, { token: owner.token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  assert.equal((await app.call(`/api/v1/households/${owner.householdId}/cases`)).status, 401);
});

test('consent list shows status, scopes and revocation, and never contact data', postgresTestOptions(), async t => {
  const { app, db, owner, other } = await setup(t);
  const granted = await app.call('/api/v1/consents', { method: 'POST', token: owner.token, body: consentBody(owner) });
  assert.equal(granted.status, 201);
  const url = `/api/v1/households/${owner.householdId}/consents`;
  let listed = await app.call(url, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.consents.length, 1);
  const [consent] = listed.data.consents;
  assert.equal(consent.status, 'active');
  assert.equal(consent.scopes.length, 1);
  assert.deepEqual(consent.scopes[0], { resourceType: 'document', resourceId: null, action: 'collect', dataCategory: 'insurance_document', recipient: null });
  assert.equal(consent.purpose, 'document_processing');

  const revoked = await app.call(`/api/v1/consents/${consent.id}/revoke`, { method: 'POST', token: owner.token, body: {} });
  assert.equal(revoked.status, 200);
  listed = await app.call(url, { token: owner.token });
  assert.equal(listed.data.consents[0].status, 'revoked');
  assert.ok(listed.data.consents[0].revokedAt);

  const insert = (id, expiresAt) => db.run(`INSERT INTO consent_grants (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, expires_at, created_at)
    VALUES (?, ?, ?, 'knowvia-local', 'document_processing', 'v1', 'typed', ?, ?, ?)`, [id, owner.householdId, owner.adultId, '2099-01-01T00:00:00.000Z', expiresAt, '2099-01-01T00:00:00.000Z']);
  await insert('consent-expired-synthetic', '2000-01-01T00:00:00.000Z');
  // The column has no CHECK on expires_at (verified: this insert succeeds), so the unparseable path is real.
  await insert('consent-garbage-synthetic', 'not-a-date');
  listed = await app.call(url, { token: owner.token });
  const byId = Object.fromEntries(listed.data.consents.map(c => [c.id, c.status]));
  assert.equal(byId['consent-expired-synthetic'], 'expired');
  assert.equal(byId['consent-garbage-synthetic'], 'expired');

  // limit and truncation
  const limited = await app.call(`${url}?limit=1`, { token: owner.token });
  assert.equal(limited.data.consents.length, 1);
  assert.equal(limited.data.truncated, true);
  assert.equal((await app.call(`${url}?limit=0`, { token: owner.token })).status, 400);

  // Idempotency-Key: same request twice is still one grant
  const keyed = { method: 'POST', token: owner.token, body: consentBody(owner), headers: { 'Idempotency-Key': 'list-route-key-0001' } };
  const before = (await app.call(url, { token: owner.token })).data.consents.length;
  assert.equal((await app.call('/api/v1/consents', keyed)).status, 201);
  assert.equal((await app.call('/api/v1/consents', keyed)).status, 200);
  assert.equal((await app.call(url, { token: owner.token })).data.consents.length, before + 1);

  const text = JSON.stringify(listed.data);
  assert.equal(text.includes('example.test'), false);
  assert.equal(text.includes(owner.token), false);

  // The other household sees none of these, and the owner cannot read it.
  assert.equal((await app.call(url, { token: other.token })).status, 404);
  assert.equal((await app.call(`/api/v1/households/${other.householdId}/consents`, { token: other.token })).data.consents.length, 0);
  assert.equal((await app.call(url)).status, 401);
});
