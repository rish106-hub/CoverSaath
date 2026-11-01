import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScenarioBody } from '../src/contracts/user-data.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createApiServer } from '../src/server/server.js';

// App user data (ADR 0015, migrations 025-029): sealed at rest, owned by the session adult, revisioned, minimised, erased.
// Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL); REQUIRE_POSTGRES=1 makes a missing server an error.

const bootstrapToken = 'coversaath-test-bootstrap-token-0015';
const opts = postgresTestOptions();

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
  const owner = await household(app, 'Synthetic');
  const other = await household(app, 'Other');
  const path = (who, rest) => `/api/v1/households/${who.householdId}/${rest}`;
  return { app, db, services, owner, other, path };
}

const ADDRESS = { line1: 'Plot 42 Sentinelgali Road', line2: 'Quillfeather Apartments', landmark: 'Near the Zebrafountain', city: 'Zebraville', state: 'Karnataka', pincode: '560034', country: 'IN' };
const GPS = { lat: 12.97163, lng: 77.59456, accuracyM: 12 };
const grantLocation = (app, path, who) => app.call(path(who, 'permissions/location'), { method: 'PUT', token: who.token, body: { state: 'granted', surface: 'emergency', wordingVersion: 'draft-1' } });
const count = async (db, table, where = '1=1', params = []) => Number((await db.one(`SELECT count(*) AS c FROM ${table} WHERE ${where}`, params)).c);

test('every write is sealed at rest: no submitted value appears in any column of the new tables', opts, async t => {
  const { app, db, owner, path } = await setup(t);
  assert.equal((await grantLocation(app, path, owner)).status, 200);
  assert.equal((await app.call(path(owner, 'places/registered_address'), { method: 'PUT', token: owner.token, body: { address: ADDRESS, label: 'Quillhome label' } })).status, 200);
  assert.equal((await app.call(path(owner, 'places/saved_place'), { method: 'PUT', token: owner.token, body: { slot: 'work', label: 'Mangotree office', address: { ...ADDRESS, line1: 'Gulmohar Tower 9' } } })).status, 200);
  assert.equal((await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body: { location: GPS } })).status, 200);
  assert.equal((await app.call(path(owner, 'preferences'), { method: 'PUT', token: owner.token, body: { prefs: { voiceLanguage: 'ta-IN', theme: 'dark', sources: ['whatsapp'], notifications: { channels: ['sms'], renewalReminders: true } } } })).status, 200);
  assert.equal((await app.call(path(owner, 'onboarding'), { method: 'PUT', token: owner.token, body: { state: { step: 7, way: 'talk', people: { partner: true }, wallet: 'google' }, completed: true } })).status, 200);
  assert.equal((await app.call(path(owner, 'scenarios/tax'), { method: 'PUT', token: owner.token, body: { inputs: { regime: 'old', annualIncome: 1234567, deduction80c: 150000 } } })).status, 200);
  assert.equal((await app.call(path(owner, 'scenarios/review_state'), { method: 'PUT', token: owner.token, body: { inputs: { items: { fact1: { status: 'edited', value: 'Pomegranate rider' } } } } })).status, 200);

  const rows = [];
  for (const table of ['device_permissions', 'household_places', 'adult_preferences', 'onboarding_progress', 'tool_scenarios']) {
    const found = await db.many(`SELECT * FROM ${table}`);
    assert.ok(found.length > 0, `${table} holds a row`);
    rows.push(...found);
  }
  const everything = JSON.stringify(rows);
  for (const fragment of ['Sentinelgali', 'Quillfeather', 'Zebrafountain', 'Zebraville', 'Karnataka', '560034', 'Quillhome', 'Mangotree', 'Gulmohar', '12.97', '77.59', 'ta-IN', 'dark', 'whatsapp', 'talk', 'google', '1234567', '150000', 'Pomegranate', 'edited']) {
    assert.ok(!everything.includes(fragment), `plaintext fragment "${fragment}" found at rest`);
  }
  for (const [table, column] of [['household_places', 'payload_ciphertext'], ['household_places', 'label_ciphertext'], ['adult_preferences', 'prefs_ciphertext'], ['onboarding_progress', 'state_ciphertext'], ['tool_scenarios', 'inputs_ciphertext']]) {
    for (const row of await db.many(`SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`)) assert.match(row.value, /^enc2\./, `${table}.${column}`);
  }
  // The audit chain names fields and ids, never values.
  const audit = JSON.stringify(await db.many("SELECT action, resource_type, event_payload_json FROM audit_events WHERE action ~ '^(permission|place|preferences|onboarding|scenario)[.]'"));
  for (const fragment of ['Sentinelgali', 'Zebraville', '560034', '12.97', 'Pomegranate', 'ta-IN']) assert.ok(!audit.includes(fragment), `audit leaks ${fragment}`);
  for (const action of ['permission.set', 'place.set', 'preferences.set', 'onboarding.set', 'scenario.set']) assert.ok(audit.includes(action), `audit has ${action}`);

  // And it reads back whole.
  const places = await app.call(path(owner, 'places'), { token: owner.token });
  assert.equal(places.status, 200);
  assert.equal(places.data.places.length, 3);
  const home = places.data.places.find(place => place.kind === 'registered_address');
  assert.deepEqual(home.address, { ...ADDRESS });
  assert.equal(home.label, 'Quillhome label');
  assert.equal((await app.call(path(owner, 'scenarios/tax'), { token: owner.token })).data.inputs.annualIncome, 1234567);
});

test('a tampered or moved ciphertext is refused, not decrypted (AAD binds table, column and row)', opts, async t => {
  const { app, db, owner, path } = await setup(t);
  await app.call(path(owner, 'scenarios/tax'), { method: 'PUT', token: owner.token, body: { inputs: { regime: 'new' } } });
  await app.call(path(owner, 'scenarios/inflation'), { method: 'PUT', token: owner.token, body: { inputs: { years: 10 } } });
  const [a, b] = await db.many('SELECT id, inputs_ciphertext FROM tool_scenarios ORDER BY tool');
  await db.run('UPDATE tool_scenarios SET inputs_ciphertext = ? WHERE id = ?', [b.inputs_ciphertext, a.id]);
  const r = await app.call(path(owner, 'scenarios'), { token: owner.token });
  assert.equal(r.status, 500);
  assert.equal(r.data.error.code, 'COLUMN_DECRYPTION_FAILED');
});

test('another household cannot read or write; a wrong or missing session is refused', opts, async t => {
  const { app, owner, other, path } = await setup(t);
  await app.call(path(owner, 'preferences'), { method: 'PUT', token: owner.token, body: { prefs: { theme: 'dark' } } });
  const probes = [
    ['permissions', 'GET'], ['places', 'GET'], ['preferences', 'GET'], ['onboarding', 'GET'], ['scenarios', 'GET'], ['scenarios/tax', 'GET'],
  ];
  for (const [rest, method] of probes) {
    const r = await app.call(path(owner, rest), { method, token: other.token });
    assert.equal(r.status, 404, `${method} ${rest}`);
    assert.equal(r.data.error.code, 'HOUSEHOLD_NOT_FOUND');
    assert.equal((await app.call(path(owner, rest), { method })).status, 401, `unauthenticated ${rest}`);
    assert.equal((await app.call(path(owner, rest), { method, token: 'x'.repeat(40) })).status, 401);
  }
  const writes = [
    ['permissions/location', { state: 'granted', surface: 'settings' }], ['places/registered_address', { address: ADDRESS }], ['places/current_location', { location: GPS }],
    ['preferences', { prefs: { theme: 'dark' } }], ['onboarding', { state: { step: 1 } }], ['scenarios/tax', { inputs: {} }],
  ];
  for (const [rest, body] of writes) {
    const r = await app.call(path(owner, rest), { method: 'PUT', token: other.token, body });
    assert.equal(r.status, 404, `PUT ${rest}`);
  }
  assert.equal((await app.call(path(owner, 'places/registered_address'), { method: 'DELETE', token: other.token })).status, 404);
  // Foreign member id on an own-household address is a 404 too, and an own adult's data is untouched.
  const foreign = await app.call(path(owner, `places/registered_address?memberId=${other.memberId}`), { method: 'PUT', token: owner.token, body: { address: ADDRESS } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'MEMBER_NOT_FOUND');
  assert.equal((await app.call(path(owner, 'preferences'), { token: owner.token })).data.prefs.theme, 'dark');
});

test('a viewer reads and manages their own data but cannot change household places; another adult\'s own address is withheld', opts, async t => {
  const { app, db, services, owner, path } = await setup(t);
  const viewerAdult = await services.households.createAdult({ displayName: 'Viewer Synthetic', contactEmail: 'viewer@example.test' });
  await services.households.addRole({ householdId: owner.householdId, adultUserId: viewerAdult.id, role: 'viewer' });
  const viewerMember = await services.households.addMember({ householdId: owner.householdId, adultUserId: viewerAdult.id, displayName: 'Viewer Synthetic' });
  const session = await services.auth.issueSession({ adultUserId: viewerAdult.id });
  const viewer = { token: session.token, householdId: owner.householdId };
  assert.equal((await app.call(path(owner, 'preferences'), { method: 'PUT', token: viewer.token, body: { prefs: { theme: 'light' } } })).status, 200);
  const refused = await app.call(path(owner, 'places/registered_address'), { method: 'PUT', token: viewer.token, body: { address: ADDRESS } });
  assert.equal(refused.status, 403);
  assert.equal(refused.data.error.code, 'HOUSEHOLD_WRITE_FORBIDDEN');
  // The owner cannot write the viewer's own member address (the adult manages their own details) ...
  const protectedWrite = await app.call(path(owner, `places/registered_address?memberId=${viewerMember.id}`), { method: 'PUT', token: owner.token, body: { address: ADDRESS } });
  assert.equal(protectedWrite.status, 403);
  assert.equal(protectedWrite.data.error.code, 'MEMBER_PROTECTED');
  // ... the viewer would need a write role, so seed the row directly and check it is withheld from the owner's list.
  await db.run(`INSERT INTO household_places (id, household_id, adult_user_id, member_id, kind, payload_ciphertext, precision, source, captured_at, revision)
    VALUES ('place-seed-1', ?, ?, ?, 'registered_address', 'enc2.dev.AAAA.AAAA.AAAA', 'exact', 'user_typed', '2026-01-01T00:00:00.000Z', 1)`, [owner.householdId, viewerAdult.id, viewerMember.id]);
  const list = await app.call(path(owner, 'places'), { token: owner.token });
  assert.equal(list.status, 200);
  assert.equal(list.data.places.length, 0);
});

test('revision: If-Match mismatch is 409 REVISION_CONFLICT, a match advances, 0 means create-only', opts, async t => {
  const { app, owner, path } = await setup(t);
  const put = (rest, body, ifMatch) => app.call(path(owner, rest), { method: 'PUT', token: owner.token, body, headers: ifMatch === undefined ? {} : { 'If-Match': ifMatch } });
  const first = await put('preferences', { prefs: { theme: 'dark' } }, '0');
  assert.equal(first.status, 200);
  assert.equal(first.data.revision, 1);
  const again = await put('preferences', { prefs: { theme: 'light' } }, '0');
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'REVISION_CONFLICT');
  const stale = await put('preferences', { prefs: { theme: 'light' } }, '"7"');
  assert.equal(stale.status, 409);
  const ok = await put('preferences', { prefs: { theme: 'light' } }, '"1"');
  assert.equal(ok.status, 200);
  assert.equal(ok.data.revision, 2);
  assert.equal((await put('preferences', { prefs: { theme: 'system' } })).data.revision, 3);
  assert.equal((await put('preferences', { prefs: { theme: 'system' } }, 'abc')).status, 400);
  for (const [rest, body] of [['onboarding', { state: { step: 1 } }], ['scenarios/tax', { inputs: {} }], ['permissions/camera', { state: 'denied', surface: 'other' }], ['places/registered_address', { address: ADDRESS }]]) {
    assert.equal((await put(rest, body, '5')).status, 409, rest);
    assert.equal((await put(rest, body, '0')).status, 200, rest);
    assert.equal((await put(rest, body, '0')).status, 409, rest);
    assert.equal((await put(rest, body, '1')).status, 200, rest);
  }
  assert.equal((await app.call(path(owner, 'places/registered_address'), { method: 'DELETE', token: owner.token, headers: { 'If-Match': '1' } })).status, 409);
  assert.equal((await app.call(path(owner, 'places/registered_address'), { method: 'DELETE', token: owner.token, headers: { 'If-Match': '2' } })).status, 200);
  assert.equal((await app.call(path(owner, 'places/registered_address'), { method: 'DELETE', token: owner.token })).status, 404);
});

test('two writers racing on one revision: exactly one wins', opts, async t => {
  const { app, owner, path } = await setup(t);
  await app.call(path(owner, 'scenarios/tax'), { method: 'PUT', token: owner.token, body: { inputs: { regime: 'old' } } });
  const results = await Promise.all([1, 2, 3, 4].map(n => app.call(path(owner, 'scenarios/tax'), { method: 'PUT', token: owner.token, headers: { 'If-Match': '1' }, body: { inputs: { annualIncome: n } } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409, 409]);
});

test('validation: unknown keys, bad enums, bad numbers, oversize, unsafe text and bad pincode are coded 400s', opts, async t => {
  const { app, owner, path } = await setup(t);
  await grantLocation(app, path, owner);
  const put = (rest, body) => app.call(path(owner, rest), { method: 'PUT', token: owner.token, body });
  const bad = [
    ['permissions/location', { state: 'maybe', surface: 'settings' }], ['permissions/location', { state: 'granted', surface: 'settings', extra: 1 }],
    ['permissions/telepathy', { state: 'granted', surface: 'settings' }], ['permissions/location', { state: 'granted', surface: 'settings', wordingVersion: 'has space' }],
    ['places/registered_address', { address: { ...ADDRESS, pincode: '56003' } }], ['places/registered_address', { address: { ...ADDRESS, pincode: '0560034' } }],
    ['places/registered_address', { address: { ...ADDRESS, state: 'Atlantis' } }], ['places/registered_address', { address: { ...ADDRESS, hacked: 'x' } }],
    ['places/registered_address', { address: { ...ADDRESS, line1: 'a‮b' } }], ['places/registered_address', { address: { ...ADDRESS, line1: 'a\u0085b' } }],
    ['places/registered_address', { address: { ...ADDRESS, line1: 'a\u007fb' } }], ['places/registered_address', { address: { ...ADDRESS, line1: 'x'.repeat(121) } }],
    ['places/registered_address', { address: { ...ADDRESS, country: 'US' } }], ['places/registered_address', { address: ADDRESS, source: 'device_gps' }],
    ['places/registered_address', { address: ADDRESS, extra: true }], ['places/registered_address', { location: GPS }],
    ['places/home', { address: ADDRESS }], ['places/saved_place', { address: ADDRESS }], ['places/saved_place', { address: ADDRESS, slot: 'attic' }],
    ['places/current_location', { location: { ...GPS, lat: 91 } }], ['places/current_location', { location: { ...GPS, lng: -181 } }],
    ['places/current_location', { location: { ...GPS, lat: '12.9' } }], ['places/current_location', { location: { ...GPS, accuracyM: -1 } }],
    ['places/current_location', { location: { ...GPS, extra: 1 } }], ['places/current_location', { location: GPS, precision: 'exact' }],
    ['places/current_location', { location: GPS, precision: 'exact', surface: 'settings' }], ['places/current_location', { location: GPS, precision: 'fine' }],
    ['preferences', { prefs: { theme: 'neon' } }], ['preferences', { prefs: { colour: 'red' } }], ['preferences', { prefs: { sources: ['documents', 'documents'] } }],
    ['preferences', { prefs: { voiceLanguage: 'xx-XX' } }], ['preferences', {}], ['preferences', { prefs: { reducedMotion: 'yes' } }],
    ['onboarding', { state: { step: 99 } }], ['onboarding', { state: { step: 1.5 } }], ['onboarding', { state: { way: 'teleport' } }], ['onboarding', { state: {}, completed: 'yes' }],
    ['scenarios/tax', { inputs: { regime: 'older' } }], ['scenarios/tax', { inputs: { annualIncome: -1 } }], ['scenarios/tax', { inputs: { annualIncome: 1e12 } }],
    ['scenarios/tax', { inputs: { annualIncome: 1.5 } }], ['scenarios/tax', { inputs: { annualIncome: 'lots' } }], ['scenarios/tax', { inputs: { secret: 1 } }],
    ['scenarios/premium_rise', { inputs: { years: 0 } }], ['scenarios/hospital_bill', { inputs: { coPayPct: 101 } }], ['scenarios/inflation', { inputs: { who: 'a b' } }],
    ['scenarios/compare_weights', { inputs: { weights: { price: 101 } } }], ['scenarios/compare_weights', { inputs: { weights: { luck: 1 } } }],
    ['scenarios/stress_levers', { inputs: { levers: { billMultiplierPct: 10 } } }], ['scenarios/review_state', { inputs: { items: { 'bad key!': { status: 'accepted' } } } }],
    ['scenarios/review_state', { inputs: { items: { ok: { status: 'done' } } } }], ['scenarios/review_state', { inputs: { items: { ok: { status: 'edited', value: 'x\u0007' } } } }],
    ['scenarios/lottery', { inputs: {} }], ['scenarios/tax', { inputs: {}, extra: 1 }],
  ];
  for (const [rest, body] of bad) {
    const r = await put(rest, body);
    assert.equal(r.status, 400, `${rest} ${JSON.stringify(body).slice(0, 80)} -> ${r.status} ${r.data?.error?.code}`);
    assert.equal(r.data.error.code, 'INVALID_REQUEST');
  }
  // 8 KB cap: a valid shape that is too large for the stored document.
  const items = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, { status: 'edited', value: 'v'.repeat(190) }]));
  const big = await put('scenarios/review_state', { inputs: { items } });
  assert.equal(big.status, 413);
  assert.equal(big.data.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal((await put('scenarios/review_state', { inputs: { items: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`k${i}`, { status: 'pending' }])) } })).status, 400);
  // Text is NFC-normalised before it is stored.
  assert.equal((await put('places/registered_address', { address: { ...ADDRESS, city: 'Café' } })).status, 200);
  assert.equal((await app.call(path(owner, 'places'), { token: owner.token })).data.places.find(p => p.kind === 'registered_address').address.city, 'Café');
});

test('current location: needs granted permission, rounded to about 1 km unless Emergency asks for exact', opts, async t => {
  const { app, owner, path } = await setup(t);
  const body = { location: GPS };
  const noPermission = await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body });
  assert.equal(noPermission.status, 403);
  assert.equal(noPermission.data.error.code, 'LOCATION_PERMISSION_REQUIRED');
  await grantLocation(app, path, owner);
  const coarse = await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body });
  assert.equal(coarse.status, 200);
  assert.equal(coarse.data.precision, 'coarse');
  assert.deepEqual(coarse.data.location, { lat: 12.97, lng: 77.59, accuracyM: 1000 });
  assert.ok(Date.parse(coarse.data.expiresAt) - Date.parse(coarse.data.capturedAt) === 24 * 3600 * 1000);
  const exact = await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body: { location: GPS, precision: 'exact', surface: 'emergency' } });
  assert.equal(exact.status, 200);
  assert.equal(exact.data.precision, 'exact');
  assert.deepEqual(exact.data.location, GPS);
  assert.equal(exact.data.revision, 2);
  const withMember = await app.call(path(owner, `places/current_location?memberId=${owner.memberId}`), { method: 'PUT', token: owner.token, body });
  assert.equal(withMember.status, 400);
});

test('current location expires after 24 hours: hidden at read time and removed by the purge', opts, async t => {
  let now = new Date('2026-03-01T10:00:00.000Z');
  const { db, services } = await freshDatabase(t, { clock: () => now });
  const adult = await services.households.createAdult({ displayName: 'Clock Synthetic', contactEmail: 'clock@example.test' });
  const home = await services.households.createHousehold({ displayName: 'Clock household', ownerAdultId: adult.id });
  const principal = { adultId: adult.id };
  await services.userData.setPermission(principal, home.id, 'location', { state: 'granted', surface: 'emergency' });
  const placed = await services.userData.setPlace(principal, home.id, 'current_location', {}, { location: GPS });
  assert.equal(placed.expiresAt, '2026-03-02T10:00:00.000Z');
  assert.equal((await services.userData.listPlaces(principal, home.id)).places.length, 1);
  now = new Date('2026-03-02T09:59:59.000Z');
  assert.equal((await services.userData.listPlaces(principal, home.id)).places.length, 1);
  now = new Date('2026-03-02T10:00:01.000Z');
  // The read filter hides it even before any purge ran.
  assert.equal((await services.userDataRepository.listPlaces({ householdId: home.id, adultId: adult.id })).length, 0);
  assert.equal(await count(db, 'household_places'), 1);
  assert.equal(await services.userDataRepository.purgeExpiredLocations(), 1);
  assert.equal(await count(db, 'household_places'), 0);
  assert.equal(await services.userDataRepository.purgeExpiredLocations(), 0);
  const expired = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'place.expired'");
  assert.deepEqual(JSON.parse(expired.event_payload_json), { count: 1, kind: 'current_location' });
});

test('revoking or denying location erases the current location in the same step', opts, async t => {
  const { app, db, owner, path } = await setup(t);
  for (const state of ['revoked', 'denied']) {
    await grantLocation(app, path, owner);
    await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body: { location: GPS } });
    assert.equal(await count(db, 'household_places', "kind = 'current_location'"), 1);
    const r = await app.call(path(owner, 'permissions/location'), { method: 'PUT', token: owner.token, body: { state, surface: 'settings' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.state, state);
    assert.equal(await count(db, 'household_places', "kind = 'current_location'"), 0, `location survived ${state}`);
    const stored = await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body: { location: GPS } });
    assert.equal(stored.status, 403);
  }
  const audit = await db.many("SELECT event_payload_json FROM audit_events WHERE action = 'permission.set' ORDER BY id");
  assert.ok(audit.some(row => JSON.parse(row.event_payload_json).currentLocationErased === 1));
  // Notification refusal leaves location alone.
  await grantLocation(app, path, owner);
  await app.call(path(owner, 'places/current_location'), { method: 'PUT', token: owner.token, body: { location: GPS } });
  await app.call(path(owner, 'permissions/notifications'), { method: 'PUT', token: owner.token, body: { state: 'denied', surface: 'onboarding' } });
  assert.equal(await count(db, 'household_places', "kind = 'current_location'"), 1);
});

test('registered address and saved places are unique per owner; a member\'s places go when the member is removed', opts, async t => {
  const { app, db, owner, path } = await setup(t);
  const kid = await app.call(path(owner, 'members'), { method: 'POST', token: owner.token, body: { displayName: 'Kabir Synthetic', memberKind: 'dependent' } });
  assert.equal(kid.status, 201);
  const put = (rest, body) => app.call(path(owner, rest), { method: 'PUT', token: owner.token, body });
  await put('places/registered_address', { address: ADDRESS });
  await put('places/registered_address', { address: { ...ADDRESS, city: 'Otherville' } });
  await put(`places/registered_address?memberId=${kid.data.id}`, { address: ADDRESS });
  await put(`places/saved_place?memberId=${kid.data.id}`, { slot: 'home', address: ADDRESS });
  await put(`places/saved_place?memberId=${kid.data.id}`, { slot: 'home', address: ADDRESS });
  await put('places/saved_place', { slot: 'home', address: ADDRESS });
  await put('places/saved_place', { slot: 'work', address: ADDRESS });
  assert.equal(await count(db, 'household_places', "kind = 'registered_address'"), 2);
  assert.equal(await count(db, 'household_places', "kind = 'saved_place'"), 3);
  assert.equal((await app.call(path(owner, 'places'), { token: owner.token })).data.places.find(p => p.kind === 'registered_address' && !p.memberId).address.city, 'Otherville');
  const removed = await app.call(path(owner, `members/${kid.data.id}`), { method: 'DELETE', token: owner.token });
  assert.equal(removed.status, 200);
  assert.equal(await count(db, 'household_places', 'member_id = ?', [kid.data.id]), 0);
  assert.equal(await count(db, 'household_places'), 3);
  const audit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'household_member.removed'");
  assert.equal(JSON.parse(audit.event_payload_json).placesErased, 2);
  const deleted = await app.call(path(owner, 'places/saved_place?slot=work'), { method: 'DELETE', token: owner.token });
  assert.equal(deleted.status, 200);
  assert.equal((await app.call(path(owner, 'places/saved_place'), { method: 'DELETE', token: owner.token })).status, 400);
});

test('household erasure removes every new row and leaves other households alone', opts, async t => {
  const { app, db, services, owner, other, path } = await setup(t);
  for (const who of [owner, other]) {
    const p = rest => path(who, rest);
    await grantLocation(app, path, who);
    await app.call(p('places/registered_address'), { method: 'PUT', token: who.token, body: { address: ADDRESS } });
    await app.call(p('places/current_location'), { method: 'PUT', token: who.token, body: { location: GPS } });
    await app.call(p('preferences'), { method: 'PUT', token: who.token, body: { prefs: { theme: 'dark' } } });
    await app.call(p('onboarding'), { method: 'PUT', token: who.token, body: { state: { step: 2 } } });
    await app.call(p('scenarios/tax'), { method: 'PUT', token: who.token, body: { inputs: { regime: 'new' } } });
  }
  const tables = ['device_permissions', 'household_places', 'adult_preferences', 'onboarding_progress', 'tool_scenarios'];
  const totals = async where => (await Promise.all(tables.map(table => count(db, table, where.replace('$', ''), [])))).reduce((a, b) => a + b, 0);
  assert.equal(await totals('1=1'), 2 * 6);
  const erased = await services.userDataRepository.eraseForHousehold({ householdId: owner.householdId });
  assert.deepEqual({ ...erased }, { device_permissions: 1, household_places: 2, adult_preferences: 1, onboarding_progress: 1, tool_scenarios: 1 });
  assert.equal(await totals('1=1'), 6);
  for (const table of tables) assert.equal(await count(db, table, 'household_id = ?', [owner.householdId]), 0, table);
  const audit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'user_data.erased'");
  assert.equal(JSON.parse(audit.event_payload_json).household_places, 2);
});

test('writes are limited to 60 per adult per minute', opts, async t => {
  const { app, owner, other, path } = await setup(t);
  const put = (who, n) => app.call(path(who, 'onboarding'), { method: 'PUT', token: who.token, body: { state: { step: n % 50 } } });
  for (let n = 0; n < 60; n += 1) assert.equal((await put(owner, n)).status, 200, `write ${n}`);
  const limited = await put(owner, 61);
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'USER_DATA_RATE_LIMITED');
  // Reads are not counted, and another adult has their own allowance.
  assert.equal((await app.call(path(owner, 'onboarding'), { token: owner.token })).status, 200);
  assert.equal((await put(other, 1)).status, 200);
});

test('POST /access is bootstrap-guarded and idempotent per e-mail', opts, async t => {
  const { app, db } = await setup(t);
  const body = { displayName: 'Meera Synthetic', contactEmail: 'Meera.Synthetic@Example.TEST', contactPhone: '+91 98765 43210' };
  assert.equal((await app.call('/api/v1/access', { method: 'POST', body })).status, 401);
  assert.equal((await app.call('/api/v1/access', { method: 'POST', token: 'x'.repeat(40), body })).status, 401);
  const first = await app.call('/api/v1/access', { method: 'POST', token: bootstrapToken, body });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.returning, false);
  const second = await app.call('/api/v1/access', { method: 'POST', token: bootstrapToken, body: { ...body, displayName: 'Someone Else', contactEmail: 'meera.synthetic@example.test' } });
  assert.equal(second.status, 200);
  assert.equal(second.data.returning, true);
  assert.equal(second.data.household.id, first.data.household.id);
  assert.equal(second.data.owner.id, first.data.owner.id);
  assert.notEqual(second.data.session.token, first.data.session.token);
  assert.equal((await app.call(`/api/v1/households/${first.data.household.id}/overview`, { token: second.data.session.token })).status, 200);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM households')).c), 3);
  const [concurrent, again] = await Promise.all([
    app.call('/api/v1/access', { method: 'POST', token: bootstrapToken, body: { displayName: 'Race Synthetic', contactEmail: 'race@example.test' } }),
    app.call('/api/v1/access', { method: 'POST', token: bootstrapToken, body: { displayName: 'Race Synthetic', contactEmail: 'race@example.test' } }),
  ]);
  assert.deepEqual([concurrent.status, again.status].sort(), [200, 201]);
  assert.equal(concurrent.data.household.id, again.data.household.id);
  const row = await db.one('SELECT * FROM adult_users WHERE id = ?', [first.data.owner.id]);
  assert.match(row.contact_email_hash, /^[0-9a-f]{64}$/);
  assert.match(row.phone_hash, /^[0-9a-f]{64}$/);
  assert.match(row.phone_ciphertext, /^enc2\./);
  const raw = JSON.stringify(row);
  for (const fragment of ['Meera', 'example.test', '98765', '43210']) assert.ok(!raw.includes(fragment), `adult row leaks ${fragment}`);
  for (const bad of [{}, { displayName: 'A' }, { displayName: 'A', contactEmail: 'not-an-email' }, { displayName: 'A', contactEmail: 'a@b.test', contactPhone: 'call me' }, { displayName: 'A', contactEmail: 'a@b.test', extra: 1 }]) {
    assert.equal((await app.call('/api/v1/access', { method: 'POST', token: bootstrapToken, body: bad })).status, 400, JSON.stringify(bad));
  }
  const audit = JSON.stringify(await db.many("SELECT action, event_payload_json FROM audit_events WHERE action LIKE 'access.%'"));
  assert.ok(audit.includes('access.created') && audit.includes('access.reused'));
  assert.ok(!audit.includes('example.test') && !audit.includes('Meera'));
});

test('the contact-hash backfill hashes older adults and skips a duplicate e-mail instead of merging', opts, async t => {
  const { db, services } = await freshDatabase(t);
  const a = await services.households.createAdult({ displayName: 'Old A', contactEmail: 'Twin@example.test' });
  const b = await services.households.createAdult({ displayName: 'Old B', contactEmail: 'twin@example.test' });
  await services.households.createAdult({ displayName: 'Old C', contactEmail: 'solo@example.test' });
  await services.households.createAdult({ displayName: 'Old D' });
  const counts = await services.userDataRepository.backfillContactHashes({ pageSize: 2 });
  assert.deepEqual(counts, { hashed: 2, skippedDuplicate: 1, skippedNoEmail: 1 });
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM adult_users WHERE contact_email_hash IS NOT NULL')).c), 2);
  assert.equal(Number((await db.one('SELECT count(*) AS c FROM adult_users WHERE id IN (?, ?) AND contact_email_hash IS NOT NULL', [a.id, b.id])).c), 1);
  // A second run is a no-op for hashed rows (the duplicate and the e-mail-less row are counted again, nothing changes).
  const again = await services.userDataRepository.backfillContactHashes();
  assert.equal(again.hashed, 0);
});

test('a placeholder (invited) adult has no session, so no user-data route can be reached as one', opts, async t => {
  const { app, services, owner, path } = await setup(t);
  const adult = await app.call(path(owner, 'members'), { method: 'POST', token: owner.token, body: { displayName: 'Rohan Synthetic', memberKind: 'adult' } });
  assert.equal(adult.status, 201);
  const row = await services.householdApp.getMember(owner.householdId, adult.data.id);
  await assert.rejects(services.auth.issueSession({ adultUserId: row.adult_user_id }), error => error.code === 'AUTH_SUBJECT_INVALID');
});

test('the purge on a request is scoped to the caller\'s household; expired rows stay unreadable and other households are untouched', opts, async t => {
  let now = new Date('2026-03-01T10:00:00.000Z');
  const { db, services } = await freshDatabase(t, { clock: () => now });
  const make = async name => {
    const adult = await services.households.createAdult({ displayName: `${name} Synthetic`, contactEmail: `${name}@example.test` });
    const home = await services.households.createHousehold({ displayName: `${name} household`, ownerAdultId: adult.id });
    const principal = { adultId: adult.id };
    await services.userData.setPermission(principal, home.id, 'location', { state: 'granted', surface: 'emergency' });
    await services.userData.setPlace(principal, home.id, 'current_location', {}, { location: GPS });
    return { principal, home };
  };
  const a = await make('purgea');
  const b = await make('purgeb');
  now = new Date('2026-03-02T11:00:00.000Z');
  assert.equal(await count(db, 'household_places'), 2);
  assert.equal((await services.userData.listPlaces(a.principal, a.home.id)).places.length, 0);
  assert.equal(await count(db, 'household_places', 'household_id = ?', [a.home.id]), 0, 'owner call purged its own');
  assert.equal(await count(db, 'household_places', 'household_id = ?', [b.home.id]), 1, 'other household untouched by a request');
  assert.equal((await services.userData.listPlaces(b.principal, b.home.id)).places.length, 0, 'but unreadable at once');
});

test('review_state refuses prototype keys', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const items = JSON.parse(`{"${key}": {"status": "pending"}}`);
    assert.throws(() => parseScenarioBody('review_state', { inputs: { items } }), error => error.code === 'VALIDATION_ERROR' || error.statusCode === 400 || error.status === 400);
  }
  assert.deepEqual(parseScenarioBody('review_state', { inputs: { items: { ok_1: { status: 'accepted', value: 'x' } } } }).inputs.items, { ok_1: { status: 'accepted', value: 'x' } });
});

test('every foreign key of the user-data tables cascades from household, adult and member (no orphan can outlive its owner)', opts, async t => {
  const { db } = await freshDatabase(t);
  const tables = ['device_permissions', 'household_places', 'adult_preferences', 'onboarding_progress', 'tool_scenarios'];
  const fks = await db.many(`SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS parent, confdeltype FROM pg_constraint
    WHERE contype = 'f' AND conrelid::regclass::text = ANY(?::text[])`, [tables]);
  assert.ok(fks.length >= 10);
  for (const fk of fks) assert.equal(fk.confdeltype, 'c', `${fk.tbl} -> ${fk.parent}`);
  // A real household or adult delete is not possible today: audit_events and household_roles reference them without cascade by
  // design, and no delete flow exists (ADR 0015 D5). UserDataRepository.eraseForHousehold is the tested erasure path.
});

test('a blind-index key that differs from the one that wrote the hashes finds no adult (rotation needs a rehash first)', opts, async t => {
  const { db } = await freshDatabase(t);
  const crypto = key => createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, key).toString('base64') }));
  const first = createBackendServices(db, { columnCrypto: crypto(1) });
  const created = await first.userDataRepository.access({ displayName: 'Rotate Synthetic', contactEmail: 'rotate@example.test' });
  assert.equal(created.returning, false);
  assert.equal((await first.userDataRepository.access({ displayName: 'Rotate Synthetic', contactEmail: 'rotate@example.test' })).returning, true);
  const rotated = createBackendServices(db, { columnCrypto: crypto(2) });
  const again = await rotated.userDataRepository.access({ displayName: 'Rotate Synthetic', contactEmail: 'rotate@example.test' }).catch(error => error);
  assert.ok(again instanceof Error || again.returning === false, 'a rotated key does not find the existing adult');
});
