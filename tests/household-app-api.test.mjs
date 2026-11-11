import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { assertSafeSeedTarget, assertSeedAllowed, seedDemoHousehold } from '../scripts/seed-demo-household.js';
import { plainRow } from './support/sealed.mjs';

const bootstrapToken = 'coversaath-test-bootstrap-token-0003';
const opts = postgresTestOptions();

async function start(database) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function household(app, name) {
  const r = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: `${name} household`, owner: { displayName: `${name} owner`, contactEmail: `${name.toLowerCase()}@example.test` } } });
  assert.equal(r.status, 201);
  return { token: r.data.session.token, householdId: r.data.household.id, adultId: r.data.owner.id, memberId: r.data.ownerMember.id };
}

async function setup(t) {
  const { db, services } = await freshDatabase(t);
  const app = await start(db);
  t.after(() => app.stop());
  return { app, db, services, owner: await household(app, 'Synthetic'), other: await household(app, 'Other') };
}

const add = (app, who, body) => app.call(`/api/v1/households/${who.householdId}/members`, { method: 'POST', token: who.token, body });

test('members: add, list, patch; owner flagged; names sealed at rest', opts, async t => {
  const { app, db, owner } = await setup(t);
  const kid = await add(app, owner, { displayName: 'Kabir Synthetic', relationshipLabel: 'Son', ageBand: '6-12', memberKind: 'dependent' });
  assert.equal(kid.status, 201, JSON.stringify(kid.data));
  assert.equal(kid.data.displayName, 'Kabir Synthetic');
  // A member under 18 keeps an age band, never a date of birth (ADR 0026, owner decision D5).
  assert.equal(kid.data.ageBand, '6-12');
  assert.equal(kid.data.dateOfBirth, null);
  assert.equal(kid.data.ageYears, null);
  const listed = await app.call(`/api/v1/households/${owner.householdId}/members`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.members.length, 2);
  assert.equal(listed.data.members.filter(m => m.isOwner).length, 1);
  const patched = await app.call(`/api/v1/households/${owner.householdId}/members/${kid.data.id}`, { method: 'PATCH', token: owner.token, body: { relationshipLabel: 'Child', dateOfBirth: null } });
  assert.equal(patched.status, 200);
  assert.equal(patched.data.relationshipLabel, 'Child');
  assert.equal(patched.data.dateOfBirth, null);
  const raw = await db.one('SELECT display_name FROM household_members WHERE id = ?', [kid.data.id]);
  assert.match(raw.display_name, /^enc[12]\./);
  const audit = await db.many("SELECT action, event_payload_json FROM audit_events WHERE action LIKE 'household_member.%'");
  assert.ok(audit.length >= 3);
  assert.ok(!JSON.stringify(audit).includes('Kabir'));
});

test('members: an adult placeholder gets an invited adult row with no role', opts, async t => {
  const { app, db, owner } = await setup(t);
  const adult = await add(app, owner, { displayName: 'Rohan Synthetic', relationshipLabel: 'Spouse', memberKind: 'adult' });
  assert.equal(adult.status, 201, JSON.stringify(adult.data));
  const row = await db.one('SELECT adult_users.account_status AS s, (SELECT count(*) FROM household_roles WHERE adult_user_id = adult_users.id) AS roles FROM household_members JOIN adult_users ON adult_users.id = household_members.adult_user_id WHERE household_members.id = ?', [adult.data.id]);
  assert.equal(row.s, 'invited');
  assert.equal(Number(row.roles), 0);
});

test('validation errors are coded and client-safe', opts, async t => {
  const { app, owner } = await setup(t);
  for (const body of [{}, { displayName: 'A', memberKind: 'robot' }, { displayName: '', memberKind: 'dependent' }, { displayName: 'A', memberKind: 'dependent', dateOfBirth: '2018-13-45' }, { displayName: 'A', memberKind: 'dependent', dateOfBirth: '2999-01-01' }, { displayName: 'x'.repeat(81), memberKind: 'dependent' }]) {
    const r = await add(app, owner, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error.code, 'INVALID_REQUEST');
  }
  const kid = await add(app, owner, { displayName: 'Kid', memberKind: 'dependent' });
  const empty = await app.call(`/api/v1/households/${owner.householdId}/members/${kid.data.id}`, { method: 'PATCH', token: owner.token, body: {} });
  assert.equal(empty.status, 400);
  const kind = await app.call(`/api/v1/households/${owner.householdId}/members/${kid.data.id}`, { method: 'PATCH', token: owner.token, body: { memberKind: 'adult' } });
  assert.equal(kind.status, 400);
  const missing = await app.call(`/api/v1/households/${owner.householdId}/members/member-none`, { method: 'PATCH', token: owner.token, body: { displayName: 'Z' } });
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'MEMBER_NOT_FOUND');
});

test('owner member cannot be deleted; member removal erases policy links and placeholder adult', opts, async t => {
  const { app, db, services, owner } = await setup(t);
  const base = `/api/v1/households/${owner.householdId}/members`;
  const refused = await app.call(`${base}/${owner.memberId}`, { method: 'DELETE', token: owner.token });
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error.code, 'MEMBER_PROTECTED');

  const adult = await add(app, owner, { displayName: 'Rohan Synthetic', memberKind: 'adult' });
  const kid = await add(app, owner, { displayName: 'Kabir Synthetic', memberKind: 'dependent' });
  const insurer = await services.householdApp.findOrCreateInsurer({ legalName: 'Northstar Synthetic' });
  const policy = await services.householdApp.createPolicy({ householdId: owner.householdId, insurerId: insurer.id, policyKind: 'group', startsOn: '2026-04-01', endsOn: '2027-03-31', memberIds: [owner.memberId, adult.data.id, kid.data.id] });
  assert.equal(policy.members.length, 3);

  assert.equal((await app.call(`${base}/${kid.data.id}`, { method: 'DELETE', token: owner.token })).status, 200);
  assert.equal((await app.call(`${base}/${adult.data.id}`, { method: 'DELETE', token: owner.token })).status, 200);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM policy_members WHERE policy_id = ?', [policy.id])).c), 1);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM household_members WHERE id IN (?, ?)', [kid.data.id, adult.data.id])).c), 0);
  assert.equal(Number((await db.one("SELECT count(*) AS c FROM adult_users WHERE account_status = 'invited'")).c), 0);
  const audit = await db.many("SELECT event_payload_json FROM audit_events WHERE action = 'household_member.removed' ORDER BY id");
  assert.equal(audit.length, 2);
  assert.equal(JSON.parse(audit[0].event_payload_json).policyLinksErased, 1);
});

test('a member named by a case cannot be removed until the case is gone', opts, async t => {
  const { app, owner } = await setup(t);
  const kid = await add(app, owner, { displayName: 'Kid', memberKind: 'dependent' });
  const opened = await app.call('/api/v1/cases', { method: 'POST', token: owner.token, body: { householdId: owner.householdId, subjectMemberId: kid.data.id, triggerType: 'planned_care' } });
  assert.equal(opened.status, 201, JSON.stringify(opened.data));
  const r = await app.call(`/api/v1/households/${owner.householdId}/members/${kid.data.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(r.status, 409);
  assert.equal(r.data.error.code, 'MEMBER_HAS_RECORDS');
});

test('policies and overview: shape, derived counts, ownership', opts, async t => {
  const { app, services, owner, other } = await setup(t);
  const kid = await add(app, owner, { displayName: 'Kabir Synthetic', relationshipLabel: 'Son', memberKind: 'dependent', ageBand: '6-12' });
  await add(app, owner, { displayName: 'Uncovered', memberKind: 'dependent' });
  const insurer = await services.householdApp.findOrCreateInsurer({ legalName: 'Northstar Synthetic' });
  const policy = await services.householdApp.createPolicy({ householdId: owner.householdId, insurerId: insurer.id, policyKind: 'group', policyNumberMasked: 'XXXX-0001', startsOn: '2026-04-01', endsOn: '2099-03-31', memberIds: [owner.memberId, kid.data.id] });

  const list = await app.call(`/api/v1/households/${owner.householdId}/policies`, { token: owner.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.policies[0].insurer.name, 'Northstar Synthetic');
  assert.equal(list.data.policies[0].members.length, 2);
  const one = await app.call(`/api/v1/policies/${policy.id}`, { token: owner.token });
  assert.equal(one.status, 200);
  assert.equal(one.data.endsOn, '2099-03-31');

  const ov = await app.call(`/api/v1/households/${owner.householdId}/overview`, { token: owner.token });
  assert.equal(ov.status, 200);
  assert.deepEqual(Object.keys(ov.data).sort(), ['counts', 'derived', 'household', 'members', 'nextPolicyEnd', 'policies', 'viewerRole']);
  assert.equal(ov.data.viewerRole, 'owner');
  assert.equal(ov.data.counts.members, 3);
  assert.equal(ov.data.counts.membersCovered, 2);
  assert.equal(ov.data.counts.membersWithoutPolicy, 1);
  assert.equal(ov.data.counts.policiesByKind.group, 1);
  assert.equal(ov.data.nextPolicyEnd.policyId, policy.id);
  assert.equal(ov.data.household.displayName, 'Synthetic household');
  assert.equal((await app.call(`/api/v1/households/${owner.householdId}/overview`)).status, 401);

  // Ownership: another household's token is denied on every route, and a foreign policy looks absent.
  const base = `/api/v1/households/${owner.householdId}`;
  for (const [method, path, body] of [
    ['GET', `${base}/members`], ['POST', `${base}/members`, { displayName: 'X', memberKind: 'dependent' }],
    ['PATCH', `${base}/members/${kid.data.id}`, { displayName: 'Y' }], ['DELETE', `${base}/members/${kid.data.id}`],
    ['GET', `${base}/policies`], ['GET', `${base}/overview`],
  ]) {
    const r = await app.call(path, { method, token: other.token, body });
    assert.equal(r.status, 404, `${method} ${path}`);
    assert.equal(r.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  }
  const foreign = await app.call(`/api/v1/policies/${policy.id}`, { token: other.token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'POLICY_NOT_FOUND');
  assert.equal((await app.call('/api/v1/policies/policy-none', { token: owner.token })).data.error.code, 'POLICY_NOT_FOUND');
  // Nothing was changed by the denied writes.
  assert.equal((await app.call(`${base}/members`, { token: owner.token })).data.members.length, 3);
});

test('viewer can read but not write', opts, async t => {
  const { app, db, services, owner } = await setup(t);
  const viewer = await services.households.createAdult({ displayName: 'Viewer Synthetic' });
  await services.households.addRole({ householdId: owner.householdId, adultUserId: viewer.id, role: 'viewer' });
  const session = await services.auth.issueSession({ adultUserId: viewer.id });
  const base = `/api/v1/households/${owner.householdId}`;
  assert.equal((await app.call(`${base}/members`, { token: session.token })).status, 200);
  assert.equal((await app.call(`${base}/overview`, { token: session.token })).data.viewerRole, 'viewer');
  for (const [method, path, body] of [['POST', `${base}/members`, { displayName: 'X', memberKind: 'dependent' }], ['PATCH', `${base}/members/${owner.memberId}`, { displayName: 'Y' }], ['DELETE', `${base}/members/${owner.memberId}`]]) {
    const r = await app.call(path, { method, token: session.token, body });
    assert.equal(r.status, 403, `${method}`);
    assert.equal(r.data.error.code, 'HOUSEHOLD_WRITE_FORBIDDEN');
  }
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM household_members WHERE household_id = ?', [owner.householdId])).c), 1);
});

test('seed: refuses unsafe targets', () => {
  for (const url of [undefined, '', 'not a url', 'postgres://u@db.example.com:5432/x', 'postgres://u@localhost:54329/coversaath_dev', 'postgres://u@127.0.0.1/coversaath_dev?sslmode=disable', 'postgres://u@localhost/x?host=db.example.com', 'mysql://u@localhost/x']) {
    assert.throws(() => assertSafeSeedTarget(url), { code: 'SEED_TARGET_REFUSED' }, String(url));
  }
  assert.deepEqual(assertSafeSeedTarget('postgres://u@localhost:54329/knowvia_ba_test'), { database: 'knowvia_ba_test' });
});

test('seed: builds the Rao family and is idempotent', opts, async t => {
  const { db } = await freshDatabase(t);
  const first = await seedDemoHousehold(db);
  assert.equal(first.pass, true);
  assert.equal(first.policyIds.length, 3);
  const second = await seedDemoHousehold(db);
  assert.equal(second.pass, true);
  assert.deepEqual(second.created, []);
  assert.equal(second.householdId, first.householdId);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM households')).c), 1);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM household_members')).c), 5);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM insurers')).c), 3);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM policy_members')).c), 8);
});

test('a real adult member row cannot be changed by another adult; placeholders and self stay editable', opts, async t => {
  const { app, db, services, owner } = await setup(t);
  const base = `/api/v1/households/${owner.householdId}/members`;
  const real = await services.households.createAdult({ displayName: 'Real Adult Synthetic', contactEmail: 'real.adult@example.test' });
  const realMember = await services.households.addMember({ householdId: owner.householdId, adultUserId: real.id, displayName: 'Real Adult Synthetic', relationshipLabel: 'Sibling' });
  for (const body of [{ dateOfBirth: '1990-01-01' }, { displayName: 'Renamed' }, { relationshipLabel: 'Friend' }]) {
    const r = await app.call(`${base}/${realMember.id}`, { method: 'PATCH', token: owner.token, body });
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(r.data.error.code, 'MEMBER_PROTECTED');
  }
  const unchanged = await plainRow(db, 'household_members', 'WHERE id = ?', [realMember.id]);
  assert.equal(unchanged.relationship_label, 'Sibling');
  assert.equal(unchanged.date_of_birth, null);
  const placeholder = await add(app, owner, { displayName: 'Placeholder Synthetic', memberKind: 'adult' });
  assert.equal((await app.call(`${base}/${placeholder.data.id}`, { method: 'PATCH', token: owner.token, body: { relationshipLabel: 'Spouse', dateOfBirth: '1990-01-01' } })).status, 200);
  assert.equal((await app.call(`${base}/${owner.memberId}`, { method: 'PATCH', token: owner.token, body: { relationshipLabel: 'Self' } })).status, 200);
});

test('removing a placeholder adult that other rows still reference is a coded 409, not a 500', opts, async t => {
  const { app, db, owner } = await setup(t);
  const base = `/api/v1/households/${owner.householdId}/members`;
  const placeholder = await add(app, owner, { displayName: 'Placeholder Synthetic', memberKind: 'adult' });
  const adultId = (await db.one('SELECT adult_user_id FROM household_members WHERE id = ?', [placeholder.data.id])).adult_user_id;
  await db.run(`INSERT INTO api_sessions (id, adult_user_id, token_sha256, issued_at, expires_at, created_at) VALUES ('session-synthetic', ?, ?, '2026-01-01T00:00:00Z', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00Z')`, [adultId, 'a'.repeat(64)]);
  const refused = await app.call(`${base}/${placeholder.data.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(refused.status, 409, JSON.stringify(refused.data));
  assert.equal(refused.data.error.code, 'MEMBER_PROTECTED');
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM household_members WHERE id = ?', [placeholder.data.id])).c), 1);

  // A second member row pointing at the same adult also blocks removal.
  const other = await add(app, owner, { displayName: 'Second Placeholder', memberKind: 'adult' });
  const otherAdult = (await db.one('SELECT adult_user_id FROM household_members WHERE id = ?', [other.data.id])).adult_user_id;
  await db.run(`INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES ('member-dup-synthetic', ?, ?, 'x', 'adult', now()::text, now()::text)`, [owner.householdId, otherAdult]);
  const dup = await app.call(`${base}/${other.data.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'MEMBER_PROTECTED');
});

test('removeMember refuses the owner inside the repository transaction', opts, async t => {
  const { services, owner } = await setup(t);
  await assert.rejects(() => services.householdApp.deleteMember({ householdId: owner.householdId, actorAdultId: owner.adultId, memberId: owner.memberId }), { code: 'MEMBER_PROTECTED', statusCode: 409 });
});

test('text validation rejects hidden control and bidi characters and stores NFC', opts, async t => {
  const { app, owner } = await setup(t);
  for (const bad of ['A\u007fB', 'A\u0085B', 'A\u009fB', 'A B', 'A B', 'A‮B', 'A‪B', 'A⁦B', 'A⁩B', 'A\u0000B', 'A\nB']) {
    const r = await add(app, owner, { displayName: bad, memberKind: 'dependent' });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.data.error.code, 'INVALID_REQUEST');
    assert.equal((await add(app, owner, { displayName: 'Fine', relationshipLabel: bad, memberKind: 'dependent' })).status, 400);
  }
  const composed = await add(app, owner, { displayName: 'José Synthetic', memberKind: 'dependent' });
  assert.equal(composed.status, 201);
  assert.equal(composed.data.displayName, 'José Synthetic');
});

test('seed: refuses in production or without SEED_ALLOW=1', () => {
  for (const env of [{}, { SEED_ALLOW: '0' }, { SEED_ALLOW: 'true' }, { SEED_ALLOW: '1', NODE_ENV: 'production' }]) {
    assert.throws(() => assertSeedAllowed(env), { code: 'SEED_TARGET_REFUSED' }, JSON.stringify(env));
  }
  assert.doesNotThrow(() => assertSeedAllowed({ SEED_ALLOW: '1', NODE_ENV: 'development' }));
  assert.doesNotThrow(() => assertSeedAllowed({ SEED_ALLOW: '1' }));
});

test('seed: finds the owner past the first page of adults, creating no duplicate', opts, async t => {
  const { db, services } = await freshDatabase(t);
  for (let i = 0; i < 5; i += 1) await services.households.createAdult({ displayName: `Filler ${i}`, contactEmail: `filler${i}@example.test` });
  const first = await seedDemoHousehold(db);
  const found = await services.householdApp.findAdultByContactEmail('meera.rao@company.com', { pageSize: 2 });
  assert.equal(found?.id, first.ownerAdultId);
  assert.equal((await seedDemoHousehold(db)).ownerAdultId, first.ownerAdultId);
  assert.equal(await services.householdApp.findAdultByContactEmail('nobody@example.test', { pageSize: 2 }), null);
});
