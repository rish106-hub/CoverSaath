import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { sharedColumnCrypto } from '../src/backend/security/column-crypto.js';
import { createApiServer } from '../src/server/server.js';
import { readServerConfig } from '../src/server/config.js';

// ADR 0012 D3: POST /api/v1/identity-sessions maps (issuer, subject) to an adult behind a server credential.
const bootstrapToken = 'coversaath-test-bootstrap-token-0003';
const identityToken = 'coversaath-test-identity-credential-0003';
const issuer = 'https://accounts.example.test';
const otherIssuer = 'https://other-issuer.example.test';
const env = { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, KNOWVIA_IDENTITY_TOKEN: identityToken, IDENTITY_ISSUERS: `${issuer}, ${otherIssuer}` };

async function start(t, { serverEnv = env } = {}) {
  const { db } = await freshDatabase(t);
  const server = createApiServer({ database: db, env: serverEnv });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const call = async (path, { method = 'GET', body, token, headers = {} } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const signIn = (overrides = {}, token = identityToken) => call('/api/v1/identity-sessions', {
    method: 'POST', token, body: { issuer, subject: 'synthetic-subject-0001', displayName: 'Asha Synthetic', ...overrides },
  });
  return { db, port, call, signIn };
}

const count = async (db, table) => Number((await db.one(`SELECT count(*) AS count FROM ${table}`)).count);

test('the identity credential is required: none, the bootstrap token or a wrong value get 401; an unset credential is 503', postgresTestOptions(), async t => {
  const app = await start(t);
  assert.equal((await app.signIn({}, null)).status, 401);
  const bootstrap = await app.signIn({}, bootstrapToken);
  assert.equal(bootstrap.status, 401);
  assert.equal(bootstrap.data.error.code, 'AUTHENTICATION_REQUIRED');
  assert.equal((await app.signIn({}, 'coversaath-test-wrong-credential-000000')).status, 401);
  assert.equal(await count(app.db, 'adult_users'), 0);
  assert.equal(await count(app.db, 'auth_identities'), 0);

  // The identity credential does not open POST /households either.
  const households = await app.call('/api/v1/households', { method: 'POST', token: identityToken, body: { displayName: 'H', owner: { displayName: 'O' } } });
  assert.equal(households.status, 401);

  const unset = await start(t, { serverEnv: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, IDENTITY_ISSUERS: issuer } });
  const refused = await unset.signIn({}, identityToken);
  assert.equal(refused.status, 503);
  assert.equal(refused.data.error.code, 'AUTH_NOT_CONFIGURED');
  const refusedBootstrap = await unset.signIn({}, bootstrapToken);
  assert.equal(refusedBootstrap.status, 503);
});

test('an issuer outside the allow-list, or an empty list, is refused with 400 and creates nothing', postgresTestOptions(), async t => {
  const app = await start(t);
  for (const bad of ['https://evil.example', '', undefined, 'https://accounts.example.test/', 'HTTPS://ACCOUNTS.EXAMPLE.TEST', 42]) {
    const result = await app.signIn({ issuer: bad });
    assert.equal(result.status, 400, String(bad));
    assert.equal(result.data.error.code, 'INVALID_REQUEST');
  }
  const noIssuers = await start(t, { serverEnv: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, KNOWVIA_IDENTITY_TOKEN: identityToken } });
  assert.equal((await noIssuers.signIn()).status, 400);
  assert.equal(await count(app.db, 'adult_users'), 0);
  assert.equal(await count(noIssuers.db, 'adult_users'), 0);
});

test('the body is validated: subject, displayName and contactEmail bounds', postgresTestOptions(), async t => {
  const app = await start(t);
  for (const bad of [{ subject: '' }, { subject: 'x'.repeat(256) }, { subject: 7 }, { subject: undefined }, { displayName: '' }, { displayName: '   ' }, { displayName: 'x'.repeat(81) }, { displayName: undefined }, { contactEmail: 'a'.repeat(321) }, { contactEmail: 5 }]) {
    const result = await app.signIn(bad);
    assert.equal(result.status, 400, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(await count(app.db, 'adult_users'), 0);
  const edge = await app.signIn({ subject: 'x'.repeat(255), displayName: 'x'.repeat(80), contactEmail: `${'a'.repeat(300)}@example.test` });
  assert.equal(edge.status, 201);
});

test('first sign-in creates adult, household, owner member and identity; the same identity returns the same adult with a new session', postgresTestOptions(), async t => {
  const app = await start(t);
  const first = await app.signIn({ contactEmail: 'asha@example.test' });
  assert.equal(first.status, 201);
  assert.equal(first.data.returning, false);
  assert.match(first.data.household.id, /^household-/);
  assert.match(first.data.adultId, /^adult-/);
  assert.match(first.data.memberId, /^member-/);
  assert.equal(typeof first.data.session.token, 'string');
  assert.equal(first.headers.get('cache-control'), 'no-store');

  // The session works and only for this household.
  const matrix = await app.call(`/api/v1/households/${first.data.household.id}`, { token: first.data.session.token });
  assert.equal(matrix.status, 200);
  assert.equal(matrix.data.viewerRole, 'owner');
  assert.deepEqual(matrix.data.members.map(m => m.id), [first.data.memberId]);

  const created = await app.db.one('SELECT created_at, last_used_at FROM auth_identities');
  assert.equal(created.last_used_at, created.created_at);
  await new Promise(resolve => setTimeout(resolve, 20));
  const again = await app.signIn({ displayName: 'A different name', contactEmail: 'someone-else@example.test' });
  assert.equal(again.status, 200);
  assert.equal(again.data.returning, true);
  assert.equal(again.data.adultId, first.data.adultId);
  assert.equal(again.data.household.id, first.data.household.id);
  assert.equal(again.data.memberId, first.data.memberId);
  assert.notEqual(again.data.session.token, first.data.session.token);
  assert.notEqual(again.data.session.sessionId, first.data.session.sessionId);
  assert.equal(await count(app.db, 'adult_users'), 1);
  assert.equal(await count(app.db, 'households'), 1);
  assert.equal(await count(app.db, 'auth_identities'), 1);
  const row = await app.db.one('SELECT * FROM auth_identities');
  // A returning sign-in moves last_used_at forward; created_at stays.
  assert.equal(row.created_at, created.created_at);
  assert.ok(Date.parse(row.last_used_at) > Date.parse(created.last_used_at), 'last_used_at must advance on a returning sign-in');
  assert.equal(row.revoked_at, null);
  // Returning does not rewrite the adult (no lookup or update by e-mail or name).
  // Name and e-mail are sealed at rest (ADR 0013): the raw columns are ciphertext that opens to the same values.
  const stored = await app.db.one('SELECT id, display_name, contact_email FROM adult_users');
  assert.match(stored.display_name, /^enc2\./);
  assert.match(stored.contact_email, /^enc2\./);
  assert.equal(sharedColumnCrypto().open('adult_users', 'display_name', stored.id, stored.display_name), 'Asha Synthetic');
  assert.equal(sharedColumnCrypto().open('adult_users', 'contact_email', stored.id, stored.contact_email), 'asha@example.test');
});

test('the same subject at another issuer is a different adult; the same e-mail does not link identities', postgresTestOptions(), async t => {
  const app = await start(t);
  const a = await app.signIn({ contactEmail: 'same@example.test' });
  const b = await app.signIn({ issuer: otherIssuer, contactEmail: 'same@example.test' });
  const c = await app.signIn({ subject: 'synthetic-subject-0002', contactEmail: 'same@example.test' });
  assert.deepEqual([a.status, b.status, c.status], [201, 201, 201]);
  assert.equal(new Set([a.data.adultId, b.data.adultId, c.data.adultId]).size, 3);
  assert.equal(new Set([a.data.household.id, b.data.household.id, c.data.household.id]).size, 3);
  // One household cannot be read with another identity's session.
  const cross = await app.call(`/api/v1/households/${a.data.household.id}`, { token: b.data.session.token });
  assert.equal(cross.status, 404);
  assert.equal(cross.data.error.code, 'HOUSEHOLD_NOT_FOUND');
});

test('the raw subject is stored nowhere: only sha256(issuer LF subject) is in the table, and the audit chain carries no identity', postgresTestOptions(), async t => {
  const app = await start(t);
  const subject = 'synthetic-subject-raw-check-7731';
  const first = await app.signIn({ subject });
  assert.equal(first.status, 201);
  const columns = (await app.db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'auth_identities' ORDER BY ordinal_position")).map(r => r.column_name);
  assert.deepEqual(columns, ['id', 'adult_user_id', 'issuer', 'subject_sha256', 'created_at', 'last_used_at', 'revoked_at']);
  const row = await app.db.one('SELECT * FROM auth_identities');
  assert.equal(row.subject_sha256, createHash('sha256').update(`${issuer}\n${subject}`).digest('hex'));
  assert.equal(row.issuer, issuer);
  assert.equal(JSON.stringify(row).includes(subject), false);
  for (const table of ['adult_users', 'households', 'household_members', 'household_roles', 'api_sessions', 'audit_events']) {
    const rows = await app.db.many(`SELECT * FROM ${table}`);
    assert.equal(JSON.stringify(rows).includes(subject), false, `${table} must not hold the raw subject`);
  }
  const audit = await app.db.many("SELECT action, event_payload_json FROM audit_events WHERE action = 'auth_identity.created'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0].event_payload_json.includes(issuer), false);
  assert.equal(JSON.stringify(first.data).includes(subject), false);
});

test('a revoked identity gets 401 and no session; an inactive adult gets 401; neither creates rows', postgresTestOptions(), async t => {
  const app = await start(t);
  const first = await app.signIn();
  assert.equal(first.status, 201);
  const sessionsBefore = await count(app.db, 'api_sessions');

  await app.db.run('UPDATE auth_identities SET revoked_at = ?', [new Date().toISOString()]);
  const revoked = await app.signIn();
  assert.equal(revoked.status, 401);
  assert.equal(revoked.data.error.code, 'AUTHENTICATION_REQUIRED');
  assert.equal(await count(app.db, 'api_sessions'), sessionsBefore);
  assert.equal(await count(app.db, 'adult_users'), 1);
  assert.equal(await count(app.db, 'auth_identities'), 1);

  await app.db.run('UPDATE auth_identities SET revoked_at = NULL');
  await app.db.run("UPDATE adult_users SET account_status = 'suspended'");
  const suspended = await app.signIn();
  assert.equal(suspended.status, 401);
  assert.equal(await count(app.db, 'api_sessions'), sessionsBefore);
});

test('a returning adult is routed to the oldest active owner household', postgresTestOptions(), async t => {
  const app = await start(t);
  const first = await app.signIn();
  // A second, newer owner household for the same adult.
  const later = new Date(Date.now() + 60_000).toISOString();
  await app.db.run("INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-newer', 'Newer', ?, ?)", [later, later]);
  await app.db.run("INSERT INTO household_roles (id, household_id, adult_user_id, role, status, starts_at, created_at) VALUES ('role-newer', 'household-newer', ?, 'owner', 'active', ?, ?)", [first.data.adultId, new Date(Date.now() - 1000).toISOString(), later]);
  await app.db.run("INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES ('member-newer', 'household-newer', ?, 'Asha', 'adult', ?, ?)", [first.data.adultId, later, later]);
  const again = await app.signIn();
  assert.equal(again.data.household.id, first.data.household.id);
  assert.equal(again.data.memberId, first.data.memberId);
  // Close the oldest: the next owner household is used.
  await app.db.run("UPDATE households SET status = 'closed' WHERE id = ?", [first.data.household.id]);
  const next = await app.signIn();
  assert.equal(next.data.household.id, 'household-newer');
  assert.equal(next.data.memberId, 'member-newer');
  // No active owner household left: coded 404, no session.
  await app.db.run("UPDATE households SET status = 'closed' WHERE id = 'household-newer'");
  const sessions = await count(app.db, 'api_sessions');
  const none = await app.signIn();
  assert.equal(none.status, 404);
  assert.equal(none.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  assert.equal(await count(app.db, 'api_sessions'), sessions);
});

test('two concurrent first calls for one identity make one adult and one identity', postgresTestOptions(), async t => {
  const app = await start(t);
  const results = await Promise.all([app.signIn({ subject: 'synthetic-subject-race' }), app.signIn({ subject: 'synthetic-subject-race' }), app.signIn({ subject: 'synthetic-subject-race' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 201]);
  assert.equal(new Set(results.map(r => r.data.adultId)).size, 1);
  assert.equal(new Set(results.map(r => r.data.household.id)).size, 1);
  assert.equal(await count(app.db, 'adult_users'), 1);
  assert.equal(await count(app.db, 'households'), 1);
  assert.equal(await count(app.db, 'auth_identities'), 1);
});

test('the Host/Origin guard still runs first: a foreign Origin is 403 before any credential or database work', postgresTestOptions(), async t => {
  const app = await start(t);
  const result = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: app.port, path: '/api/v1/identity-sessions', method: 'POST',
      headers: { Host: `127.0.0.1:${app.port}`, Origin: 'https://evil.example', 'Content-Type': 'application/json', Authorization: `Bearer ${identityToken}` },
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ issuer, subject: 'synthetic-subject-evil', displayName: 'Evil' }));
  });
  assert.equal(result.status, 403);
  assert.deepEqual(result.body, { error: 'Origin not permitted.' });
  assert.equal(await count(app.db, 'adult_users'), 0);
});

test('the session cap still applies: 429 SESSION_CAPACITY_REACHED, and a refused first sign-in leaves no adult, household or identity', postgresTestOptions(), async t => {
  const app = await start(t, { serverEnv: { ...env, MAX_ACTIVE_SESSIONS: '1' } });
  const first = await app.signIn();
  assert.equal(first.status, 201);
  const refusedNew = await app.signIn({ subject: 'synthetic-subject-0002' });
  assert.equal(refusedNew.status, 429);
  assert.equal(refusedNew.data.error.code, 'SESSION_CAPACITY_REACHED');
  assert.equal(await count(app.db, 'adult_users'), 1);
  assert.equal(await count(app.db, 'households'), 1);
  assert.equal(await count(app.db, 'auth_identities'), 1);
  const lastUsed = (await app.db.one('SELECT last_used_at FROM auth_identities')).last_used_at;
  const refusedReturning = await app.signIn();
  assert.equal(refusedReturning.status, 429);
  assert.equal((await app.db.one('SELECT last_used_at FROM auth_identities')).last_used_at, lastUsed);
  // Revoking the live session frees the slot.
  assert.equal((await app.call('/api/v1/sessions/current/revoke', { method: 'POST', token: first.data.session.token })).status, 200);
  assert.equal((await app.signIn({ subject: 'synthetic-subject-0002' })).status, 201);
});

test('identity settings are validated at startup', () => {
  assert.throws(() => readServerConfig({ KNOWVIA_IDENTITY_TOKEN: 'short' }), /KNOWVIA_IDENTITY_TOKEN/);
  assert.throws(() => readServerConfig({ KNOWVIA_IDENTITY_TOKEN: 'x'.repeat(257) }), /KNOWVIA_IDENTITY_TOKEN/);
  assert.throws(() => readServerConfig({ KNOWVIA_IDENTITY_TOKEN: `${'a'.repeat(31)} ` }), /KNOWVIA_IDENTITY_TOKEN/);
  assert.throws(() => readServerConfig({ KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, KNOWVIA_IDENTITY_TOKEN: bootstrapToken }), /must differ/);
  for (const bad of ['https://a b.example', 'https://a.example,https://a.example', Array.from({ length: 11 }, (_, i) => `https://i${i}.example`).join(',')]) {
    assert.throws(() => readServerConfig({ IDENTITY_ISSUERS: bad }), /IDENTITY_ISSUERS/);
  }
  assert.throws(() => createApiServer({ env: { KNOWVIA_IDENTITY_TOKEN: 'short' } }), /KNOWVIA_IDENTITY_TOKEN/);
  assert.doesNotThrow(() => readServerConfig({ KNOWVIA_IDENTITY_TOKEN: identityToken, IDENTITY_ISSUERS: ` ${issuer} , ${otherIssuer} ` }));
});

test('the table rejects a malformed subject hash and a revocation before creation', postgresTestOptions(), async t => {
  const app = await start(t);
  const first = await app.signIn();
  assert.equal(first.status, 201);
  const at = new Date().toISOString();
  const insert = hash => app.db.run(`INSERT INTO auth_identities (id, adult_user_id, issuer, subject_sha256, created_at) VALUES ('identity-x', ?, ?, ?, ?)`, [first.data.adultId, otherIssuer, hash, at]);
  for (const bad of ['a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64), 'a'.repeat(65)]) {
    await assert.rejects(insert(bad), error => error.code === '23514', bad.slice(0, 8));
  }
  await assert.rejects(app.db.run('UPDATE auth_identities SET revoked_at = ?', ['2000-01-01T00:00:00.000Z']), error => error.code === '23514');
  await insert('a'.repeat(64));
});

test('a household with no member row for the adult is skipped, so memberId is never null', postgresTestOptions(), async t => {
  const app = await start(t);
  const first = await app.signIn();
  const later = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 1000).toISOString();
  // A newer owner household that has a member row, and the oldest one loses its member row.
  await app.db.run("INSERT INTO households (id, display_name, created_at, updated_at) VALUES ('household-newer', 'Newer', ?, ?)", [later, later]);
  await app.db.run("INSERT INTO household_roles (id, household_id, adult_user_id, role, status, starts_at, created_at) VALUES ('role-newer', 'household-newer', ?, 'owner', 'active', ?, ?)", [first.data.adultId, past, later]);
  await app.db.run("INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES ('member-newer', 'household-newer', ?, 'Asha', 'adult', ?, ?)", [first.data.adultId, later, later]);
  await app.db.run('UPDATE household_members SET adult_user_id = NULL, member_kind = ? WHERE id = ?', ['dependent', first.data.memberId]);
  const again = await app.signIn();
  assert.equal(again.status, 200);
  assert.equal(again.data.household.id, 'household-newer');
  assert.equal(again.data.memberId, 'member-newer');
  // No member row anywhere: coded 404, no session, never a null memberId.
  await app.db.run("UPDATE household_members SET adult_user_id = NULL, member_kind = 'dependent' WHERE id = 'member-newer'");
  const sessions = await count(app.db, 'api_sessions');
  const none = await app.signIn();
  assert.equal(none.status, 404);
  assert.equal(none.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  assert.equal(await count(app.db, 'api_sessions'), sessions);
});
