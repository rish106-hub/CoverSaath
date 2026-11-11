import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignJWT, UnsecuredJWT, decodeJwt, decodeProtectedHeader, generateKeyPair } from 'jose';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJwtTokens, publicJwkFor, readJwtIssuer, readJwtPrivateKeys } from '../src/backend/security/jwt-tokens.js';
import { createApiServer } from '../src/server/server.js';
import { runPostgresMigrations, loadPostgresMigrations } from '../src/backend/database/postgres/index.js';

// ADR 0016: passwordless web sessions. Short EdDSA access tokens (jose), opaque rotating refresh tokens, instant revocation by
// reading api_sessions on every request. All keys are generated in memory for the test; nothing here is a real secret.
const bootstrapToken = 'coversaath-test-bootstrap-token-0016';
const identityToken = 'coversaath-test-identity-credential-0016';
const issuer = 'https://accounts.example.test';
const jwtIssuer = 'https://api.example.test';
const env = { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, KNOWVIA_IDENTITY_TOKEN: identityToken, IDENTITY_ISSUERS: issuer };
const DAY = 24 * 60 * 60 * 1000;
const opts = postgresTestOptions();

function newKey(kid) {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { kid, privateKey, publicJwk: publicJwkFor(privateKey) };
}

async function start(t, { configured = true, maxActiveSessions } = {}) {
  const fixture = await freshDatabase(t);
  const { db } = fixture;
  const time = { now: Date.parse('2026-11-03T10:00:00.000Z') };
  const clock = () => new Date(time.now);
  const key = newKey('key_one_0001');
  const services = createBackendServices(db, {
    env, clock, ...(maxActiveSessions ? { maxActiveSessions } : {}),
    ...(configured ? { jwt: { issuer: jwtIssuer, privateKeys: new Map([[key.kid, key.privateKey]]) } } : {}),
  });
  if (configured) {
    await services.authTokenRepository.registerKey({ kid: key.kid, publicJwk: key.publicJwk });
    await services.authTokenRepository.activateKey(key.kid);
  }
  const server = createApiServer({ database: db, env, backendServices: services });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const signIn = (subject = 'synthetic-subject-0016', { format = 'jwt' } = {}) => call(`/api/v1/identity-sessions${format ? `?format=${format}` : ''}`, {
    method: 'POST', token: identityToken, body: { issuer, subject, displayName: 'Asha Synthetic' },
  });
  const refresh = refreshToken => call('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken } });
  const consents = (session) => call(`/api/v1/households/${session.household.id}/consents`, { token: session.accessToken });
  return { db, services, call, signIn, refresh, consents, time, key, repo: services.authTokenRepository };
}

const sessionRow = (db, id) => db.one('SELECT * FROM api_sessions WHERE id = ?', [id]);

test('sign-in with ?format=jwt returns tokens whose claims carry ids only; the default response is unchanged', opts, async t => {
  const app = await start(t);
  const first = await app.signIn();
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.data).sort(), ['accessToken', 'expiresIn', 'household', 'memberId', 'refreshToken', 'returning']);
  assert.equal(first.data.expiresIn, 600);
  const claims = decodeJwt(first.data.accessToken);
  const header = decodeProtectedHeader(first.data.accessToken);
  assert.deepEqual({ alg: header.alg, typ: header.typ, kid: header.kid }, { alg: 'EdDSA', typ: 'at+jwt', kid: app.key.kid });
  assert.deepEqual(Object.keys(claims).sort(), ['amr', 'aud', 'exp', 'hid', 'iat', 'iss', 'jti', 'knd', 'scp', 'sid', 'sub']);
  assert.equal(claims.iss, jwtIssuer);
  assert.equal(claims.aud, 'knowvia-bff');
  assert.equal(claims.knd, 'web');
  assert.equal(claims.hid, first.data.household.id);
  assert.equal(claims.exp - claims.iat, 600);
  assert.deepEqual(claims.scp, ['household:rw']);
  assert.equal(JSON.stringify(claims).includes('Asha'), false);
  assert.equal((await app.consents(first.data)).status, 200);

  // The opaque form keeps its shape and still works beside JWT sessions.
  const plain = await app.signIn('synthetic-subject-0016', { format: null });
  assert.equal(plain.status, 200);
  assert.ok(plain.data.session.token && plain.data.adultId && !plain.data.accessToken);
  assert.equal((await app.call(`/api/v1/households/${plain.data.household.id}/consents`, { token: plain.data.session.token })).status, 200);
  const rows = await app.db.many('SELECT session_kind, token_sha256, household_id FROM api_sessions ORDER BY session_kind');
  assert.deepEqual(rows.map(r => [r.session_kind, r.token_sha256 === null, r.household_id !== null]), [['bearer', false, false], ['web', true, true]]);

  assert.equal((await app.signIn('x', { format: 'jws' })).status, 400);
});

test('JWT sign-in is refused with 503 and creates nothing when this process cannot sign; bearer sessions still work', opts, async t => {
  const app = await start(t, { configured: false });
  const refused = await app.signIn();
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error.code, 'AUTH_NOT_CONFIGURED');
  assert.equal(Number((await app.db.one('SELECT count(*) AS count FROM adult_users')).count), 0);
  assert.equal((await app.signIn('synthetic-subject-0016', { format: null })).status, 201);
  const lookalike = `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(20)}`;
  assert.equal((await app.call('/api/v1/auth/sessions', { token: lookalike })).status, 401);
  const refreshed = await app.refresh('A'.repeat(43));
  assert.deepEqual([refreshed.status, refreshed.data.error.code], [503, 'AUTH_NOT_CONFIGURED']);
});

test('only EdDSA is accepted: none, HS256 and RS256 tokens are rejected, as are wrong aud, iss, typ, knd and missing claims', opts, async t => {
  const app = await start(t);
  const { data } = await app.signIn();
  const valid = decodeJwt(data.accessToken);
  const claims = { hid: valid.hid, sid: valid.sid, scp: valid.scp, amr: valid.amr, knd: 'web' };
  const base = (overrides = {}, { omit = [], aud = 'knowvia-bff', iss = jwtIssuer } = {}) => {
    const body = { ...claims, ...overrides };
    for (const name of omit) delete body[name];
    return new SignJWT(body).setIssuer(iss).setAudience(aud).setSubject(valid.sub).setJti(randomUUID())
      .setIssuedAt(Math.floor(app.time.now / 1000)).setExpirationTime(Math.floor(app.time.now / 1000) + 600);
  };
  const header = { alg: 'EdDSA', kid: app.key.kid, typ: 'at+jwt' };
  const sign = (builder, h = header) => builder.setProtectedHeader(h).sign(app.key.privateKey);
  const status = async token => (await app.call('/api/v1/auth/sessions', { token })).status;

  assert.equal(await status(await sign(base())), 200, 'control: a forged-but-correctly-signed token is the same as a real one');
  const none = new UnsecuredJWT({ ...claims, sid: valid.sid }).setIssuer(jwtIssuer).setAudience('knowvia-bff').setSubject(valid.sub)
    .setExpirationTime(Math.floor(app.time.now / 1000) + 600).encode();
  assert.equal(await status(none), 401, 'alg none');
  const hs = await base().setProtectedHeader({ ...header, alg: 'HS256' }).sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef'));
  assert.equal(await status(hs), 401, 'HS256');
  const rsa = await generateKeyPair('RS256');
  assert.equal(await status(await base().setProtectedHeader({ ...header, alg: 'RS256' }).sign(rsa.privateKey)), 401, 'RS256');
  // Signed by a key the server does not know, under the real kid.
  assert.equal(await status(await base().setProtectedHeader(header).sign(newKey('key_other_01').privateKey)), 401, 'foreign key');
  assert.equal(await status(await sign(base({}, { aud: 'other-audience' }))), 401, 'aud');
  assert.equal(await status(await sign(base({}, { iss: 'https://evil.example' }))), 401, 'iss');
  assert.equal(await status(await sign(base(), { ...header, typ: 'JWT' })), 401, 'typ');
  assert.equal(await status(await sign(base(), { alg: 'EdDSA', typ: 'at+jwt' })), 401, 'no kid');
  assert.equal(await status(await sign(base(), { ...header, kid: 'key_unknown_1' })), 401, 'unknown kid');
  assert.equal(await status(await sign(base({ knd: 'demo' }))), 401, 'knd');
  assert.equal(await status(await sign(base({ scp: ['other'] }))), 401, 'scope');
  assert.equal(await status(await sign(base({}, { omit: ['sid'] }))), 401, 'missing sid');
  assert.equal(await status(await sign(base({}, { omit: ['hid'] }))), 401, 'missing hid');
  assert.equal(await status(await sign(base({ sid: 'session-does-not-exist' }))), 401, 'unknown sid');
  assert.equal(await status(await sign(base({ hid: 'household-someone-else' }))), 401, 'hid not the session household');
  assert.equal(await status(await sign(base().setSubject('adult-someone-else'))), 401, 'sub not the session adult');
  assert.equal(await status(`${'x'.repeat(2100)}.a.b`), 401);
});

test('a tampered token fails and the error never echoes it', opts, async t => {
  const app = await start(t);
  const { data } = await app.signIn();
  const [h, p, s] = data.accessToken.split('.');
  const flip = value => `${value.slice(0, -2)}${value.endsWith('AA') ? 'BB' : 'AA'}`;
  const forgedPayload = Buffer.from(JSON.stringify({ ...decodeJwt(data.accessToken), hid: 'household-other' })).toString('base64url');
  for (const token of [`${h}.${p}.${flip(s)}`, `${h}.${forgedPayload}.${s}`, `${flip(h)}.${p}.${s}`, `${h}.${p}`, `${h}.${p}.`]) {
    const response = await app.call('/api/v1/auth/sessions', { token });
    assert.equal(response.status, 401);
    assert.equal(response.data.error.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(JSON.stringify(response.data).includes(p), false);
  }
});

test('an access token expires after 10 minutes, to the second', opts, async t => {
  const app = await start(t);
  const { data } = await app.signIn();
  app.time.now += 599_000;
  assert.equal((await app.consents(data)).status, 200);
  app.time.now += 1_000;
  const expired = await app.consents(data);
  assert.equal(expired.status, 401);
  assert.equal(expired.data.error.code, 'AUTHENTICATION_REQUIRED');
});

test('revoking the session ends the token at once, even though it is unexpired and validly signed', opts, async t => {
  const app = await start(t);
  const { data } = await app.signIn();
  assert.equal((await app.consents(data)).status, 200);
  const sid = decodeJwt(data.accessToken).sid;
  await app.db.run("UPDATE api_sessions SET revoked_at = ?, revoked_reason = 'admin' WHERE id = ?", [new Date(app.time.now).toISOString(), sid]);
  assert.equal((await app.consents(data)).status, 401);

  const second = (await app.signIn()).data;
  assert.equal((await app.call('/api/v1/auth/signout', { method: 'POST', token: second.accessToken })).status, 200);
  assert.equal((await app.consents(second)).status, 401);
  assert.equal((await sessionRow(app.db, decodeJwt(second.accessToken).sid)).revoked_reason, 'sign_out');
  // The refresh token of a signed-out session is dead too.
  assert.equal((await app.refresh(second.refreshToken)).status, 401);

  // An inactive adult cannot use a token that was valid a moment ago.
  const third = (await app.signIn('synthetic-subject-other')).data;
  assert.equal((await app.consents(third)).status, 200);
  await app.db.run("UPDATE adult_users SET account_status = 'suspended' WHERE id = ?", [decodeJwt(third.accessToken).sub]);
  assert.equal((await app.consents(third)).status, 401);
  assert.equal((await app.refresh(third.refreshToken)).status, 401);
});

test('signing keys rotate with a 15 minute overlap; a revoked key stops at once; the JWKS shows the published keys only', opts, async t => {
  const app = await start(t);
  const long = createJwtTokens({
    issuer: jwtIssuer, privateKeys: new Map([[app.key.kid, app.key.privateKey]]), clock: () => new Date(app.time.now), ttlSeconds: 3600,
    keyStore: { getActive: () => app.repo.getActiveKey(), find: kid => app.repo.findKey(kid) },
  });
  const old = await long.sign({ adultId: 'adult-a', householdId: 'household-a', sessionId: 'session-a', amr: 'beta', jti: 'j1' });
  const second = newKey('key_two_0002');
  await app.repo.registerKey({ kid: second.kid, publicJwk: second.publicJwk });
  await app.repo.registerKey({ kid: second.kid, publicJwk: second.publicJwk }); // idempotent
  await assert.rejects(app.repo.registerKey({ kid: second.kid, publicJwk: newKey('x').publicJwk }), { code: 'AUTH_SIGNING_KEY_CONFLICT' });
  assert.deepEqual((await app.services.authTokens.jwks()).keys.map(k => k.kid), [app.key.kid, second.kid], 'next is published before activation');
  await app.repo.activateKey(second.kid);
  assert.equal((await app.repo.getActiveKey()).kid, second.kid);
  assert.equal((await app.repo.findKey(app.key.kid)).status, 'retiring');
  assert.equal((await long.verify(old.token)).sessionId, 'session-a', 'old key still verifies inside the overlap');
  app.time.now += 14 * 60_000;
  assert.equal((await long.verify(old.token)).sessionId, 'session-a');
  app.time.now += 2 * 60_000;
  await assert.rejects(long.verify(old.token), { code: 'AUTHENTICATION_REQUIRED', reason: 'key' });
  assert.deepEqual((await app.services.authTokens.jwks()).keys.map(k => k.kid), [second.kid]);

  const both = new Map([[app.key.kid, app.key.privateKey], [second.kid, second.privateKey]]);
  const rotated = createJwtTokens({ issuer: jwtIssuer, privateKeys: both, clock: () => new Date(app.time.now), keyStore: { getActive: () => app.repo.getActiveKey(), find: kid => app.repo.findKey(kid) } });
  const fresh = await rotated.sign({ adultId: 'adult-a', householdId: 'household-a', sessionId: 'session-a', amr: 'beta', jti: 'j2' });
  assert.equal(decodeProtectedHeader(fresh.token).kid, second.kid);
  assert.ok(await rotated.verify(fresh.token));
  assert.equal(await app.repo.revokeKey(second.kid), true);
  await assert.rejects(rotated.verify(fresh.token), { reason: 'key' });
  await assert.rejects(app.repo.activateKey(second.kid), { code: 'AUTH_SIGNING_KEY_NOT_FOUND' });
  // Only one key can ever be active.
  await assert.rejects(app.db.run("INSERT INTO auth_signing_keys (kid, public_jwk, status, created_at) VALUES ('key_dup_00001', '{}', 'active', 'x'), ('key_dup_00002', '{}', 'active', 'x')"));
  // A private key that is not Ed25519 never loads.
  assert.throws(() => readJwtPrivateKeys({ KNOWVIA_JWT_PRIVATE_KEY_key_bad_0001: 'AAAA' }), { code: 'AUTH_SIGNING_KEY_INVALID' });
  assert.equal(readJwtIssuer({}), null);
  assert.throws(() => readJwtIssuer({ KNOWVIA_JWT_ISSUER: 'http://api.example.test' }), { code: 'AUTH_NOT_CONFIGURED' });
});

test('the JWKS route publishes public keys only, under the Host guard', opts, async t => {
  const app = await start(t);
  const server = { port: await portOf(t, app) };
  const response = await fetch(`http://127.0.0.1:${server.port}/.well-known/jwks.json`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.keys.length, 1);
  assert.deepEqual(Object.keys(body.keys[0]).sort(), ['alg', 'crv', 'kid', 'kty', 'use', 'x']);
  assert.equal('d' in body.keys[0], false);
  const foreign = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.port, path: '/.well-known/jwks.json', headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreign, 403);
});

async function portOf(t, app) {
  // start() keeps the server private; a second server on the same services is the simplest way to reach the route.
  const server = createApiServer({ database: app.db, env, backendServices: app.services });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

test('refresh rotates the token; the old one is single-use and its reuse revokes the whole session', opts, async t => {
  const app = await start(t);
  const first = (await app.signIn()).data;
  const sid = decodeJwt(first.accessToken).sid;
  app.time.now += 5 * 60_000;
  const second = await app.refresh(first.refreshToken);
  assert.equal(second.status, 200);
  assert.deepEqual(Object.keys(second.data).sort(), ['accessToken', 'expiresIn', 'household', 'refreshToken']);
  assert.notEqual(second.data.refreshToken, first.refreshToken);
  assert.equal(decodeJwt(second.data.accessToken).sid, sid);
  assert.equal((await app.consents(second.data)).status, 200);
  assert.equal((await app.consents(first)).status, 200, 'the earlier access token lives until it expires');

  // Reuse of the first (already rotated) token.
  const reuse = await app.refresh(first.refreshToken);
  assert.equal(reuse.status, 401);
  assert.equal(reuse.data.error.code, 'AUTH_REFRESH_INVALID');
  const row = await sessionRow(app.db, sid);
  assert.equal(row.revoked_reason, 'refresh_reuse');
  assert.ok(row.revoked_at);
  assert.equal((await app.consents(second.data)).status, 401, 'access tokens of the revoked session stop at once');
  assert.equal((await app.refresh(second.data.refreshToken)).status, 401, 'the newest refresh token is dead too');
  const audit = await app.db.many("SELECT action, resource_id FROM audit_events WHERE action LIKE 'auth.%' ORDER BY id");
  assert.deepEqual(audit.map(e => e.action), ['auth.session_started', 'auth.session_refreshed', 'auth.refresh_reuse_detected']);
  assert.ok(audit.every(e => e.resource_id === sid));
});

test('refresh requires a well-formed token and answers every failure the same way', opts, async t => {
  const app = await start(t);
  const real = (await app.signIn()).data;
  const outcomes = [];
  for (const bad of [undefined, null, 5, '', 'short', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}!`, 'A'.repeat(43), real.accessToken]) {
    const response = await app.refresh(bad);
    outcomes.push([response.status, response.data.error.code, response.data.error.message]);
  }
  assert.ok(outcomes.every(([status, code, message]) => status === 401 && code === 'AUTH_REFRESH_INVALID' && message === outcomes[0][2]), JSON.stringify(outcomes));
  // Expired by the sliding window: 31 days without use.
  app.time.now += 31 * DAY;
  assert.equal((await app.refresh(real.refreshToken)).status, 401);
  assert.equal((await app.call('/api/v1/auth/refresh', { method: 'POST' })).status, 415);
});

test('the sliding window moves with each refresh and the 90 day absolute cap ends the chain', opts, async t => {
  const app = await start(t);
  let session = (await app.signIn()).data;
  const sid = decodeJwt(session.accessToken).sid;
  const started = app.time.now;
  for (const days of [29, 58, 87]) {
    app.time.now = started + days * DAY;
    const next = await app.refresh(session.refreshToken);
    assert.equal(next.status, 200, `day ${days}`);
    session = next.data;
  }
  const row = await sessionRow(app.db, sid);
  assert.equal(Date.parse(row.expires_at), Date.parse(row.absolute_expires_at), 'the sliding window is capped at the absolute limit');
  assert.equal(Date.parse(row.absolute_expires_at) - started, 90 * DAY);
  app.time.now = started + 89 * DAY;
  assert.equal((await app.consents(session)).status, 401, 'the access token from day 87 has expired');
  const lastDay = await app.refresh(session.refreshToken);
  assert.equal(lastDay.status, 200, 'day 89 is still inside the cap');
  app.time.now = started + 91 * DAY;
  assert.equal((await app.refresh(lastDay.data.refreshToken)).status, 401);
  assert.equal((await app.consents(lastDay.data)).status, 401);
});

test('two concurrent refreshes of one token: exactly one wins and the session is then revoked', opts, async t => {
  const app = await start(t);
  const session = (await app.signIn()).data;
  const results = await Promise.all([app.refresh(session.refreshToken), app.refresh(session.refreshToken)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  const sid = decodeJwt(session.accessToken).sid;
  assert.equal((await sessionRow(app.db, sid)).revoked_reason, 'refresh_reuse');
  assert.equal(Number((await app.db.one('SELECT count(*) AS count FROM auth_refresh_tokens WHERE session_id = ? AND used_at IS NULL', [sid])).count), 1);
});

test('sign-out-all ends every session of the adult, bearer sessions included, and no one else\'s', opts, async t => {
  const app = await start(t);
  const a1 = (await app.signIn()).data;
  const a2 = (await app.signIn()).data;
  const bearer = (await app.signIn('synthetic-subject-0016', { format: null })).data;
  const other = (await app.signIn('synthetic-subject-other')).data;
  const result = await app.call('/api/v1/auth/signout-all', { method: 'POST', token: a1.accessToken });
  assert.deepEqual(result.data, { signedOut: true, sessionsRevoked: 3 });
  assert.equal((await app.consents(a1)).status, 401);
  assert.equal((await app.consents(a2)).status, 401);
  assert.equal((await app.call(`/api/v1/households/${bearer.household.id}/consents`, { token: bearer.session.token })).status, 401);
  assert.equal((await app.refresh(a2.refreshToken)).status, 401);
  assert.equal((await app.consents(other)).status, 200);
});

test('sessions list and delete: own sessions only, ids and timestamps only', opts, async t => {
  const app = await start(t);
  const a1 = (await app.signIn()).data;
  const a2 = (await app.signIn()).data;
  const other = (await app.signIn('synthetic-subject-other')).data;
  const list = await app.call('/api/v1/auth/sessions', { token: a1.accessToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.sessions.length, 2);
  assert.deepEqual(Object.keys(list.data.sessions[0]).sort(), ['amr', 'createdAt', 'current', 'expiresAt', 'id', 'kind', 'lastSeenAt']);
  assert.equal(list.data.sessions.filter(s => s.current).length, 1);
  assert.equal(list.data.sessions.find(s => s.current).id, decodeJwt(a1.accessToken).sid);
  const text = JSON.stringify(list.data);
  for (const secret of [a1.accessToken, a1.refreshToken, a2.refreshToken]) assert.equal(text.includes(secret), false);

  const otherSid = decodeJwt(other.accessToken).sid;
  const foreign = await app.call(`/api/v1/auth/sessions/${otherSid}`, { method: 'DELETE', token: a1.accessToken });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'AUTH_SESSION_NOT_FOUND');
  assert.equal((await app.call('/api/v1/auth/sessions/nope', { method: 'DELETE', token: a1.accessToken })).status, 404);
  assert.equal((await app.consents(other)).status, 200);

  const removed = await app.call(`/api/v1/auth/sessions/${decodeJwt(a2.accessToken).sid}`, { method: 'DELETE', token: a1.accessToken });
  assert.deepEqual(removed.data, { revoked: true, current: false });
  assert.equal((await app.consents(a2)).status, 401);
  assert.equal((await app.consents(a1)).status, 200);
  assert.equal((await app.call(`/api/v1/auth/sessions/${decodeJwt(a2.accessToken).sid}`, { method: 'DELETE', token: a1.accessToken })).status, 404);
  assert.equal((await app.call('/api/v1/auth/sessions')).status, 401);
});

test('a token is bound to its household: another household in the path is refused before any lookup', opts, async t => {
  const app = await start(t);
  const a = (await app.signIn()).data;
  const b = (await app.signIn('synthetic-subject-other')).data;
  for (const path of [`/api/v1/households/${b.household.id}/consents`, '/api/v1/households/household-does-not-exist/consents']) {
    const response = await app.call(path, { token: a.accessToken });
    assert.equal(response.status, 403);
    assert.equal(response.data.error.code, 'AUTH_HOUSEHOLD_MISMATCH');
  }
  assert.equal((await app.consents(a)).status, 200);
  assert.equal((await app.consents(b)).status, 200);
  // A bearer session of the same adult is not household-bound and keeps its old behaviour (ownership is still checked).
  const bearer = (await app.signIn('synthetic-subject-0016', { format: null })).data;
  assert.equal((await app.call(`/api/v1/households/${b.household.id}/consents`, { token: bearer.session.token })).status, 404);
});

test('the active-session cap counts web sessions too', opts, async t => {
  const app = await start(t, { maxActiveSessions: 2 });
  assert.equal((await app.signIn('s-one')).status, 201);
  assert.equal((await app.signIn('s-two', { format: null })).status, 201);
  const refused = await app.signIn('s-three');
  assert.equal(refused.status, 429);
  assert.equal(refused.data.error.code, 'SESSION_CAPACITY_REACHED');
  assert.equal(Number((await app.db.one('SELECT count(*) AS count FROM adult_users')).count), 2);
});

test('refresh tokens and signing keys are stored as hashes and public halves only; no token, hash or key reaches audit rows or logs', opts, async t => {
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error']) {
    const original = console[level];
    console[level] = (...args) => logs.push(args.map(String).join(' '));
    t.after(() => { console[level] = original; });
  }
  const app = await start(t);
  const first = (await app.signIn()).data;
  const second = (await app.refresh(first.refreshToken)).data;
  await app.refresh(first.refreshToken); // reuse
  await app.consents(second);
  const hashes = (await app.db.many('SELECT token_hash FROM auth_refresh_tokens')).map(r => r.token_hash);
  assert.equal(hashes.length, 2);
  assert.ok(hashes.every(h => /^[0-9a-f]{64}$/.test(h) && h !== first.refreshToken));
  const stored = JSON.stringify([
    await app.db.many('SELECT * FROM auth_refresh_tokens'),
    await app.db.many('SELECT * FROM auth_signing_keys'),
    await app.db.many('SELECT * FROM api_sessions'),
    await app.db.many('SELECT * FROM audit_events'),
  ]);
  const pem = app.key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const secrets = [first.refreshToken, second.refreshToken, first.accessToken, second.accessToken, pem, ...hashes, identityToken];
  for (const secret of secrets.slice(0, 5)) assert.equal(stored.includes(secret), false, 'stored plaintext');
  const auditText = JSON.stringify(await app.db.many('SELECT * FROM audit_events'));
  for (const secret of secrets) assert.equal(auditText.includes(secret), false, 'audit row');
  assert.equal(logs.join('\n').match(new RegExp(secrets.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))), null, 'logs');
  assert.equal(JSON.parse((await app.db.one("SELECT public_jwk FROM auth_signing_keys WHERE status = 'active'")).public_jwk).d, undefined);
});

test('every new table is erased with its owner: household erase and adult delete cascade', opts, async t => {
  const { db } = await freshDatabase(t);
  const at = '2026-11-03T10:00:00.000Z';
  const later = '2026-11-04T10:00:00.000Z';
  await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', ['household-e', 'Synthetic', at, at]);
  await db.run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-e', 'Synthetic', 'active', ?, ?)", [at, at]);
  await db.run(`INSERT INTO api_sessions (id, adult_user_id, token_sha256, issued_at, expires_at, created_at, session_kind, household_id, amr, absolute_expires_at)
    VALUES ('session-e', 'adult-e', NULL, ?, ?, ?, 'web', 'household-e', 'beta', ?)`, [at, later, at, later]);
  await db.run("INSERT INTO auth_refresh_tokens (id, session_id, token_hash, issued_at, expires_at) VALUES ('refresh-e', 'session-e', ?, ?, ?)", ['a'.repeat(64), at, later]);
  await db.run("INSERT INTO webauthn_credentials (id, adult_user_id, credential_id, public_key, created_at) VALUES ('wa-e', 'adult-e', 'cred-e', 'pk', ?)", [at]);
  await db.run("INSERT INTO devices (id, adult_user_id, first_seen_at, last_seen_at) VALUES ('device-e', 'adult-e', ?, ?)", [at, at]);
  await db.run("INSERT INTO notice_acceptances (id, adult_user_id, notice_kind, notice_version, accepted_at, surface) VALUES ('notice-e', 'adult-e', 'privacy', 'v1-draft', ?, 'signup')", [at]);
  await db.run("INSERT INTO auth_challenges (id, kind, code_hash, created_at, expires_at) VALUES ('chal-e', 'email_otp', ?, ?, ?)", ['b'.repeat(64), at, later]);

  await db.run("DELETE FROM households WHERE id = 'household-e'");
  assert.equal(await db.one("SELECT 1 AS x FROM api_sessions WHERE id = 'session-e'"), null);
  assert.equal(await db.one("SELECT 1 AS x FROM auth_refresh_tokens WHERE id = 'refresh-e'"), null);

  await db.run("DELETE FROM adult_users WHERE id = 'adult-e'");
  for (const table of ['webauthn_credentials', 'devices', 'notice_acceptances']) {
    assert.equal(Number((await db.one(`SELECT count(*) AS count FROM ${table}`)).count), 0, table);
  }
  // Challenges hold no person: only a keyed hash, expiring in minutes. They are swept by expiry, not by owner.
  assert.equal(Number((await db.one('SELECT count(*) AS count FROM auth_challenges')).count), 1);
});

test('the migration is rerunnable, keeps bearer rows valid and enforces the session shape', opts, async t => {
  const { db, handle } = await freshDatabase(t);
  const sql = loadPostgresMigrations().find(m => m.version === '045_auth_tokens.sql').sql;
  await handle.pool.query(sql);
  await handle.pool.query(sql);
  await runPostgresMigrations(handle.pool);
  const at = '2026-11-03T10:00:00.000Z';
  const later = '2026-11-04T10:00:00.000Z';
  await db.run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES ('adult-s', 'Synthetic', 'active', ?, ?)", [at, at]);
  const insert = (id, extra) => db.run(`INSERT INTO api_sessions (id, adult_user_id, token_sha256, issued_at, expires_at, created_at${extra.cols}) VALUES (?, 'adult-s', ?, ?, ?, ?${extra.marks})`,
    [id, extra.token, at, later, at, ...extra.values]);
  await insert('s-bearer', { cols: '', marks: '', token: 'c'.repeat(64), values: [] });
  await assert.rejects(insert('s-bearer-no-token', { cols: '', marks: '', token: null, values: [] }), /api_sessions_kind_shape_check/);
  await assert.rejects(insert('s-web-no-household', { cols: ', session_kind', marks: ", 'web'", token: null, values: [] }), /api_sessions_kind_shape_check/);
  await assert.rejects(insert('s-bad-kind', { cols: ', session_kind', marks: ", 'robot'", token: 'd'.repeat(64), values: [] }));
  await assert.rejects(db.run("UPDATE api_sessions SET revoked_reason = 'sign_out' WHERE id = 's-bearer'"), /api_sessions_kind_shape_check/);
  await assert.rejects(db.run("INSERT INTO auth_signing_keys (kid, public_jwk, status, created_at) VALUES ('short', '{}', 'next', 'x')"));
  await assert.rejects(db.run("INSERT INTO auth_signing_keys (kid, public_jwk, status, created_at) VALUES ('key_notjson_1', 'not json', 'next', 'x')"));
  await assert.rejects(db.run("INSERT INTO auth_refresh_tokens (id, session_id, token_hash, issued_at, expires_at) VALUES ('r', 's-bearer', 'plain', ?, ?)", [at, later]));
  await assert.rejects(db.run("INSERT INTO devices (id, adult_user_id, label_ciphertext, first_seen_at, last_seen_at) VALUES ('d', 'adult-s', 'plain label', ?, ?)", [at, at]));
  await assert.rejects(db.run("INSERT INTO webauthn_credentials (id, adult_user_id, credential_id, public_key, label_ciphertext, created_at) VALUES ('w', 'adult-s', 'c', 'k', 'plain label', ?)", [at]));
});
