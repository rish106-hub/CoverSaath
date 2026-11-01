import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { AppEventRepository, hashClient, normalizeEvent, sanitizePayload } from '../src/backend/repositories/app-event-repository.js';
import { createAppEventRecorder, deriveEventHmacKey } from '../src/backend/services/app-event-recorder.js';
import { pathAttribution, requestEventName, routeTemplate } from '../src/server/http/event-context.js';

// ADR 0014: append-only activity events with sealed payloads. Synthetic values only; keys are generated here.
const bootstrapToken = 'coversaath-test-bootstrap-token-0014';
const dataConfig = readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_ID: 'kt1' });
const columnCrypto = createColumnCrypto(dataConfig);
const hmacKey = deriveEventHmacKey(dataConfig);
const DAY = 86_400_000;

const event = (overrides = {}) => ({ ...normalizeEvent({ name: 'http_request', route: '/api/v1/health', method: 'GET', status: 200, durationMs: 4, ...overrides }), at: new Date() });
const count = async (db, where = 'true') => Number((await db.one(`SELECT count(*) AS count FROM app_events WHERE ${where}`)).count);

test('payload helpers keep numbers, booleans and short identifiers and drop free text', () => {
  assert.deepEqual(sanitizePayload({ task: 'extract_terms', tokens: 12, ok: true, email: 'asha@example.test', note: 'free text with spaces', 'bad key': 1, nested: { a: 1 }, list: [1] }),
    { task: 'extract_terms', tokens: 12, ok: true });
  assert.equal(sanitizePayload({ email: 'asha@example.test' }), null);
  assert.equal(sanitizePayload('text'), null);
  assert.equal(normalizeEvent({ name: 'made_up_event' }), null);
  const bad = normalizeEvent({ name: 'http_request', route: 'has space', method: 'TRACE', status: 99, householdId: 'a b', durationMs: -1 });
  assert.deepEqual([bad.route, bad.method, bad.status, bad.householdId, bad.durationMs], [null, null, null, null, null]);
  assert.match(hashClient(hmacKey, '203.0.113.9'), /^[0-9a-f]{16}$/);
  assert.notEqual(hashClient(hmacKey, '203.0.113.9'), hashClient(hmacKey, '203.0.113.10'));
});

test('route templates replace ids and attribution needs a successful request', () => {
  assert.equal(routeTemplate('/api/v1/households/household-0a1b2c3d-1111-2222-3333-444455556666/cases'), '/api/v1/households/:id/cases');
  assert.equal(routeTemplate('/api/v1/consents/consent-0a1b2c3d-1111-2222-3333-444455556666/revoke'), '/api/v1/consents/:id/revoke');
  assert.equal(routeTemplate('/api/v1/cases/abc/passages'), '/api/v1/cases/:id/passages');
  assert.equal(routeTemplate('/api/v1/%00/..;/x y'), '/api/v1/:x/:x/:x');
  assert.equal(routeTemplate('/wp-login.php'), '/other');
  assert.deepEqual(pathAttribution('/api/v1/households/h-1/cases', 200), { householdId: 'h-1' });
  assert.deepEqual(pathAttribution('/api/v1/households/h-1/cases', 404), {});
  assert.equal(requestEventName({ status: 429, method: 'GET', route: '/x' }), 'rate_limit_hit');
  assert.equal(requestEventName({ status: 503, method: 'GET', route: '/x' }), 'server_error');
  assert.equal(requestEventName({ status: 201, method: 'POST', route: '/api/v1/cases/:id/documents' }), 'upload_attempt');
});

test('payloads are sealed at rest, bound to their row, and the table refuses plaintext and edits', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new AppEventRepository(db, { columnCrypto });
  const secret = 'synthetic-marker-value';
  await repo.insertBatch([event({ householdId: 'h-1', payload: { task: secret, tokens: 7 } }), event({ householdId: 'h-1', payload: { tokens: 9 } })], { retentionMs: DAY });
  const raw = await db.many('SELECT id, payload_enc FROM app_events ORDER BY id');
  assert.equal(raw.length, 2);
  for (const row of raw) {
    assert.match(row.payload_enc, /^enc2\.kt1\./);
    assert.ok(!row.payload_enc.includes(secret));
  }
  const listed = await repo.listForHousehold('h-1');
  assert.deepEqual(listed.map(row => row.payload).sort((a, b) => a.tokens - b.tokens), [{ tokens: 7, task: secret }, { tokens: 9 }].sort((a, b) => a.tokens - b.tokens));
  // Moved ciphertext does not open under another row id.
  assert.throws(() => columnCrypto.openJson('app_events', 'payload_enc', String(raw[1].id), raw[0].payload_enc), { code: 'COLUMN_DECRYPTION_FAILED' });
  // The CHECK refuses plaintext in the payload column; an edit other than redaction is refused.
  await assertDbError(db.run("INSERT INTO app_events (event_name, expires_at, payload_enc) VALUES ('http_request', now() + interval '1 day', 'plain text')"), { sqlstate: '23514' });
  await assertDbError(db.run("UPDATE app_events SET payload_enc = 'plain text' WHERE id = ?", [raw[0].id]), { sqlstate: 'P0001' });
  await assertDbError(db.run("UPDATE app_events SET status = 500 WHERE id = ?", [raw[0].id]), { sqlstate: 'P0001' });
  await assertDbError(db.run("UPDATE app_events SET payload_enc = NULL WHERE id = ?", [raw[0].id]), { sqlstate: 'P0001' });
  await assertDbError(db.run("UPDATE app_events SET payload_enc = NULL, redacted_at = now(), household_id = 'h-2' WHERE id = ?", [raw[0].id]), { sqlstate: 'P0001' });
  assert.equal((await db.run('UPDATE app_events SET payload_enc = NULL, redacted_at = now() WHERE id = ?', [raw[0].id])).changes, 1);
  // Without a configured crypto, sealing is refused rather than storing plaintext.
  await assert.rejects(new AppEventRepository(db).insertBatch([event({ payload: { tokens: 1 } })], { retentionMs: DAY }), { code: 'COLUMN_ENCRYPTION_NOT_CONFIGURED' });
});

test('erasure paths: grant redaction, household, adult and retention purge', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new AppEventRepository(db, { columnCrypto });
  await repo.insertBatch([
    event({ householdId: 'h-1', adultUserId: 'a-1', consentGrantId: 'g-1', payload: { tokens: 1 } }),
    event({ householdId: 'h-1', adultUserId: 'a-1', consentGrantId: 'g-2', payload: { tokens: 2 } }),
    event({ householdId: 'h-2', adultUserId: 'a-2', payload: { tokens: 3 } }),
  ], { retentionMs: DAY });
  assert.equal(await repo.redactForGrant('g-1'), 1);
  assert.equal(await repo.redactForGrant('g-1'), 0, 'a second revoke redacts nothing more');
  const redacted = await db.one("SELECT payload_enc, redacted_at, route FROM app_events WHERE consent_grant_id = 'g-1'");
  assert.equal(redacted.payload_enc, null);
  assert.ok(redacted.redacted_at);
  assert.equal(await count(db, "consent_grant_id = 'g-2' AND payload_enc IS NOT NULL"), 1);
  assert.equal(await repo.eraseForAdult('a-2'), 1);
  assert.equal(await repo.eraseForHousehold('h-1'), 2);
  assert.equal(await count(db), 0);

  await repo.insertBatch([{ ...event({ payload: { tokens: 1 } }), at: new Date(Date.now() - 3 * DAY) }], { retentionMs: DAY });
  await assertDbError(db.run("UPDATE app_events SET expires_at = now() + interval '1 year'"), { sqlstate: 'P0001' });
  await repo.insertBatch([event({ payload: { tokens: 2 } })], { retentionMs: DAY });
  assert.equal(await repo.purgeExpired({ limit: 10 }), 1);
  assert.equal(await count(db), 1);
});

test('the recorder batches, hashes the client, bounds memory and survives a failing database', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new AppEventRepository(db, { columnCrypto });
  const recorder = createAppEventRecorder({ repository: repo, hmacKey, bufferLimit: 3, batchSize: 2, flushIntervalMs: 60_000 });
  t.after(() => recorder.close());
  recorder.record({ name: 'http_request', route: '/api/v1/health', method: 'GET', status: 200, clientKey: '203.0.113.9', payload: { tokens: 1, email: 'a@b.test' } });
  recorder.record({ name: 'not_an_event' });
  recorder.record(null);
  await recorder.flush();
  const row = await db.one('SELECT * FROM app_events');
  assert.equal(row.client_hash, hashClient(hmacKey, '203.0.113.9'));
  assert.ok(!Object.values(row).some(value => String(value).includes('203.0.113.9')), 'the raw address is never stored');
  assert.deepEqual(columnCrypto.openJson('app_events', 'payload_enc', String(row.id), row.payload_enc), { tokens: 1 });
  assert.equal(recorder.stats().rejected, 2);

  for (let index = 0; index < 5; index += 1) recorder.record({ name: 'http_request', status: 200, route: `/r${index}` });
  assert.equal(recorder.stats().buffered, 3);
  assert.equal(recorder.stats().dropped, 2, 'the oldest events are dropped when the buffer is full');
  await recorder.flush();
  assert.equal(await count(db), 4);

  let reported = 0;
  const broken = createAppEventRecorder({ repository: { insertBatch: async () => { throw new Error('database down'); } }, hmacKey, flushIntervalMs: 60_000, onError: () => { reported += 1; } });
  broken.record({ name: 'http_request', status: 200 });
  await broken.flush();
  assert.deepEqual([broken.stats().failedBatches, broken.stats().dropped, broken.stats().buffered, reported], [1, 1, 0, 1]);
  await broken.close();
  broken.record({ name: 'http_request' });
  assert.equal(broken.stats().buffered, 0, 'a closed recorder records nothing');
  const off = createAppEventRecorder({ repository: repo, hmacKey, enabled: false });
  off.record({ name: 'http_request' });
  assert.equal(off.stats().recorded, 0);
});

async function start(t, env = {}) {
  const { db } = await freshDatabase(t);
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const household = async name => {
    const created = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: name, owner: { displayName: `${name} owner`, contactEmail: `${name.toLowerCase()}@example.test` } } });
    assert.equal(created.status, 201);
    return { token: created.data.session.token, householdId: created.data.household.id, adultId: created.data.owner.id, memberId: created.data.ownerMember.id };
  };
  return { db, server, call, household };
}

test('the API records one event per request without ids, tokens, e-mail or addresses', postgresTestOptions(), async t => {
  const app = await start(t);
  const owner = await app.household('Asha');
  const other = await app.household('Ravi');
  assert.equal((await app.call('/api/v1/health')).status, 200);
  assert.equal((await app.call(`/api/v1/households/${owner.householdId}/cases`, { token: owner.token })).status, 200);
  assert.equal((await app.call(`/api/v1/households/${owner.householdId}/cases`, { token: other.token })).status === 200, false);
  assert.equal((await app.call('/api/v1/cases', { method: 'POST', body: {} })).status, 401);
  await app.server.appEvents.flush();
  const rows = await app.db.many('SELECT * FROM app_events ORDER BY id');
  assert.ok(rows.length >= 5);
  const blob = JSON.stringify(rows);
  for (const forbidden of [owner.token, other.token, bootstrapToken, 'asha@example.test', '127.0.0.1']) {
    assert.ok(!blob.includes(forbidden), `event rows must not contain ${forbidden.slice(0, 8)}`);
  }
  assert.ok(!rows.some(row => row.route.includes(owner.householdId)), 'routes are templates');
  const routes = new Set(rows.map(row => row.route));
  assert.ok(routes.has('/api/v1/health') && routes.has('/api/v1/households/:id/cases') && routes.has('/api/v1/households'));
  assert.ok(rows.every(row => row.client_hash === null || /^[0-9a-f]{16}$/.test(row.client_hash)));
  assert.ok(rows.every(row => row.duration_ms >= 0 && row.expires_at > row.occurred_at));
  // Attribution only for the request that succeeded.
  const success = rows.filter(row => row.route === '/api/v1/households/:id/cases');
  assert.deepEqual(success.map(row => [row.status, row.household_id]), [[200, owner.householdId], [success[1].status, null]]);
  assert.notEqual(success[1].status, 200);
  assert.equal(rows.find(row => row.status === 401).adult_user_id, null);
  assert.equal(rows.find(row => row.route === '/api/v1/households/:id/cases').adult_user_id, owner.adultId);
});

test('a request over the limit is a rate_limit_hit event and revoking a consent erases its event payloads', postgresTestOptions(), async t => {
  const limited = await start(t, { API_RATE_LIMIT_PER_MINUTE: '2' });
  assert.equal((await limited.call('/api/v1/health')).status, 200);
  assert.equal((await limited.call('/api/v1/health')).status, 200);
  assert.equal((await limited.call('/api/v1/health')).status, 429);
  await limited.server.appEvents.flush();
  assert.equal(await count(limited.db, "event_name = 'rate_limit_hit' AND status = 429"), 1);

  const app = await start(t);
  const who = await app.household('Meera');
  const created = await app.call('/api/v1/cases', { method: 'POST', token: who.token, body: { householdId: who.householdId, subjectMemberId: who.memberId, triggerType: 'planned_care' } });
  const grant = await app.call('/api/v1/consents', { method: 'POST', token: who.token, body: {
    householdId: who.householdId, subjectAdultId: who.adultId, purpose: 'coverage_reconstruction',
    scopes: [{ resourceType: 'case', resourceId: created.data.id, action: 'derive', dataCategory: 'insurance_document' }],
  } });
  assert.equal(grant.status, 201);
  const repo = new AppEventRepository(app.db, { columnCrypto });
  await repo.insertBatch([event({ householdId: who.householdId, consentGrantId: grant.data.id, payload: { tokens: 5 } })], { retentionMs: DAY });
  await app.server.appEvents.flush();
  assert.equal((await app.call(`/api/v1/consents/${grant.data.id}/revoke`, { method: 'POST', token: who.token, body: {} })).status, 200);
  await app.server.appEvents.flush();
  const rows = await app.db.many('SELECT payload_enc, redacted_at FROM app_events WHERE consent_grant_id = ?', [grant.data.id]);
  assert.ok(rows.length >= 2, 'the seeded event and the revoke request event');
  assert.ok(rows.every(row => row.payload_enc === null), 'no sealed payload survives revocation');
  assert.ok(rows.some(row => row.redacted_at));
});

test('events can be turned off and a missing production key stops startup', postgresTestOptions(), async t => {
  const off = await start(t, { APP_EVENTS_ENABLED: 'false' });
  assert.equal((await off.call('/api/v1/health')).status, 200);
  assert.equal(await off.server.appEvents.flush(), undefined);
  assert.equal(await count(off.db), 0);
  assert.throws(() => createApiServer({ env: { NODE_ENV: 'production', KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  // Column encryption (ADR 0013) seals household data whatever the event setting is, so production needs the data key even with
  // events off; with a key, events off starts cleanly.
  assert.throws(() => createApiServer({ env: { NODE_ENV: 'production', APP_EVENTS_ENABLED: 'false', KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  assert.doesNotThrow(() => createApiServer({ env: { NODE_ENV: 'production', APP_EVENTS_ENABLED: 'false', KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 7).toString('base64') } }));
});
