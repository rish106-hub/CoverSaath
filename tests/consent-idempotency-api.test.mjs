import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createApiServer } from '../src/server/server.js';

// A consent grant can be repeated safely: a client that timed out after the backend committed re-sends the same
// Idempotency-Key and gets the same grant back, instead of a second grant it has no record of.
const bootstrapToken = 'knowvia-test-bootstrap-token-00001';

async function start(t) {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-consent-idem-'));
  const database = openDatabase({ path: join(directory, 'knowvia.sqlite') });
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    try { database.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, idempotencyKey, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const household = async name => {
    const identity = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: name, owner: { displayName: `${name} owner` } } });
    assert.equal(identity.status, 201);
    return { token: identity.data.session.token, householdId: identity.data.household.id, adultId: identity.data.owner.id, memberId: identity.data.ownerMember.id };
  };
  return { call, household, database };
}

const grantBody = (who, caseId, action = 'derive') => ({
  householdId: who.householdId,
  subjectAdultId: who.adultId,
  purpose: 'coverage_reconstruction',
  scopes: [{ resourceType: 'case', resourceId: caseId, action, dataCategory: 'insurance_document' }],
});

async function withCase(app, who) {
  const created = await app.call('/api/v1/cases', { method: 'POST', token: who.token, body: { householdId: who.householdId, subjectMemberId: who.memberId, triggerType: 'planned_care' } });
  assert.equal(created.status, 201);
  return created.data.id;
}

test('the same Idempotency-Key returns the same grant and writes no second one', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic A');
  const caseId = await withCase(app, who);
  const first = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000001', body: grantBody(who, caseId) });
  assert.equal(first.status, 201);
  const second = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000001', body: grantBody(who, caseId) });
  assert.equal(second.status, 200, 'a replay is not a new creation');
  assert.equal(second.data.id, first.data.id);
  assert.equal(second.data.idempotentReplay, true);
});

test('without a key every request still creates its own grant', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic B');
  const caseId = await withCase(app, who);
  const one = await app.call('/api/v1/consents', { method: 'POST', token: who.token, body: grantBody(who, caseId) });
  const two = await app.call('/api/v1/consents', { method: 'POST', token: who.token, body: grantBody(who, caseId) });
  assert.equal(one.status, 201);
  assert.equal(two.status, 201);
  assert.notEqual(one.data.id, two.data.id);
});

test('the same key with a different request is a conflict, not a silent reuse', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic C');
  const caseId = await withCase(app, who);
  const first = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000002', body: grantBody(who, caseId, 'derive') });
  assert.equal(first.status, 201);
  const other = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000002', body: grantBody(who, caseId, 'read') });
  assert.equal(other.status, 409);
  assert.equal(other.data.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('a revoked grant is not handed back to a replay', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic D');
  const caseId = await withCase(app, who);
  const first = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000003', body: grantBody(who, caseId) });
  const revoked = await app.call(`/api/v1/consents/${first.data.id}/revoke`, { method: 'POST', token: who.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200);
  const replay = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000003', body: grantBody(who, caseId) });
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.code, 'CONSENT_REVOKED');
});

test('an expired grant is not handed back to a replay as if it were live', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic D2');
  const caseId = await withCase(app, who);
  const body = { ...grantBody(who, caseId), expiresAt: new Date(Date.now() + 300).toISOString() };
  const first = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000004', body });
  assert.equal(first.status, 201);
  await new Promise(resolve => setTimeout(resolve, 450));
  const replay = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000004', body });
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.code, 'CONSENT_EXPIRED');
});

test('replays and refusals are audited with counts only', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic D3');
  const caseId = await withCase(app, who);
  await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000005', body: grantBody(who, caseId) });
  await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000005', body: grantBody(who, caseId) });
  await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'consent-key-00000005', body: grantBody(who, caseId, 'read') });
  const events = app.database.prepare("SELECT action, event_payload_json AS payload_json FROM audit_events WHERE action LIKE 'consent.idempotent_%' ORDER BY id").all();
  assert.deepEqual(events.map(event => event.action), ['consent.idempotent_replay', 'consent.idempotent_rejected']);
  assert.ok(events.every(event => !/derive|insurance_document|coverage_reconstruction|case-/.test(event.payload_json)), 'no scope, purpose or case id in the payload');
});

test('two households using the same key never share a grant', async t => {
  const app = await start(t);
  const a = await app.household('Synthetic E1');
  const b = await app.household('Synthetic E2');
  const caseA = await withCase(app, a);
  const caseB = await withCase(app, b);
  const grantA = await app.call('/api/v1/consents', { method: 'POST', token: a.token, idempotencyKey: 'consent-key-shared-1', body: grantBody(a, caseA) });
  const grantB = await app.call('/api/v1/consents', { method: 'POST', token: b.token, idempotencyKey: 'consent-key-shared-1', body: grantBody(b, caseB) });
  assert.equal(grantA.status, 201);
  assert.equal(grantB.status, 201);
  assert.notEqual(grantA.data.id, grantB.data.id);
});

test('a malformed Idempotency-Key is refused', async t => {
  const app = await start(t);
  const who = await app.household('Synthetic F');
  const caseId = await withCase(app, who);
  const short = await app.call('/api/v1/consents', { method: 'POST', token: who.token, idempotencyKey: 'short', body: grantBody(who, caseId) });
  assert.equal(short.status, 400);
  assert.equal(short.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});
