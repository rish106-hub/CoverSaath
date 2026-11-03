import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { captureSchema, RECORD_TYPES } from '../src/contracts/capture-registry.js';
import { containsSensitiveIdentifier } from '../src/contracts/sensitive-identifiers.js';

// Person records and member details (ADR 0018, migration 032): sealed at rest, owned, guardian- and consent-gated, revisioned, capped,
// erased. Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL); REQUIRE_POSTGRES=1 makes a missing server an error.

const bootstrapToken = 'coversaath-test-bootstrap-token-0018';
const opts = postgresTestOptions();

async function start(database) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, raw, token, headers = {} } = {}) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const response = await fetch(base + path, {
      method,
      headers: { ...(payload !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(payload !== undefined ? { body: payload } : {}),
    });
    const textBody = await response.text();
    let data = null;
    try { data = JSON.parse(textBody); } catch { data = textBody; }
    return { status: response.status, data, text: textBody };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function household(app, name) {
  const r = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: `${name} household`, owner: { displayName: `${name} owner`, contactEmail: `${name.toLowerCase()}@example.test` } } });
  assert.equal(r.status, 201);
  return { token: r.data.session.token, householdId: r.data.household.id, adultId: r.data.owner.id, memberId: r.data.ownerMember.id };
}

async function setup(t) {
  const fresh = await freshDatabase(t);
  const app = await start(fresh.db);
  t.after(() => app.stop());
  const owner = await household(app, 'Synthetic');
  const other = await household(app, 'Other');
  const base = who => `/api/v1/households/${who.householdId}`;
  const rec = (who, type, slot = 'main', query = '') => `${base(who)}/records/${type}/${slot}${query}`;
  const put = (who, type, data, { slot = 'main', member, ifMatch, source, token = who.token } = {}) => app.call(
    rec(who, type, slot, member ? `?memberId=${member}` : ''),
    { method: 'PUT', token, body: { data, ...(source ? { source } : {}) }, headers: ifMatch === undefined ? {} : { 'If-Match': String(ifMatch) } });
  const grant = (who, dataCategory, extra = {}) => fresh.services.consents.grant({
    householdId: who.householdId, subjectAdultId: who.adultId, purpose: 'profile_intake', scopes: [{ resourceType: 'profile_field', action: 'collect', dataCategory }], ...extra,
  });
  return { ...fresh, app, owner, other, base, rec, put, grant };
}

const count = async (db, table, where = '1=1', params = []) => Number((await db.one(`SELECT count(*) AS c FROM ${table} WHERE ${where}`, params)).c);

// A synthetic value for every descriptor in the registry, with a unique marker in every text so a plaintext scan can look for it.
function sampleFor(descriptor, path) {
  switch (descriptor.type) {
    case 'text': return `Quillberry ${path}`.slice(0, descriptor.max);
    case 'enum': return descriptor.values[descriptor.values.length - 1];
    case 'int': return descriptor.min + 1 <= descriptor.max ? descriptor.min + 1 : descriptor.min;
    case 'year': return 2001;
    case 'bool': return true;
    case 'date': return path.endsWith('dateOfBirth') ? '1980-02-03' : '2024-02-03';
    case 'month': return '2026-05';
    case 'phone': return '+919876500001';
    case 'email': return 'quillberry.person@example.test';
    case 'list': return [sampleFor(descriptor.item, `${path}.0`)];
    case 'object': return Object.fromEntries(Object.entries(descriptor.fields).map(([key, value]) => [key, sampleFor(value, `${path}.${key}`)]));
    default: throw new Error(`no sample for ${descriptor.type}`);
  }
}
const sampleRecord = type => Object.fromEntries(Object.entries(captureSchema().recordTypes[type].fields).map(([key, value]) => [key, sampleFor(value, `${type}.${key}`)]));

test('capture schema route exposes the closed registry and needs a session', opts, async t => {
  const { app, owner } = await setup(t);
  assert.equal((await app.call('/api/v1/capture-schema')).status, 401);
  const r = await app.call('/api/v1/capture-schema', { token: owner.token });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data.recordTypes).sort(), Object.keys(RECORD_TYPES).sort());
  assert.deepEqual(Object.keys(r.data.recordTypes), ['self_profile', 'health_context', 'nominee', 'emergency_contact', 'advisor', 'member_note', 'out_of_pocket_spend']);
  assert.equal(r.data.recordTypes.health_context.consentCategory, 'health_profile');
  assert.ok(r.data.neverCollected.includes('Aadhaar number'));
  assert.ok(r.data.member.underEighteenBands.includes('0-5'));
});

test('every registry field round trips over HTTP and nothing readable is stored', opts, async t => {
  const { app, db, owner, put, rec, grant } = await setup(t);
  await grant(owner, 'health_profile');
  await grant(owner, 'family_data');
  const samples = {};
  for (const type of Object.keys(RECORD_TYPES)) {
    samples[type] = sampleRecord(type);
    const stored = await put(owner, type, samples[type], { member: RECORD_TYPES[type].subject === 'member_required' ? owner.memberId : undefined });
    assert.equal(stored.status, 200, `${type}: ${stored.text}`);
    assert.deepEqual(stored.data.data, samples[type], `${type} PUT echo`);
    assert.equal(stored.data.completeness, 'complete', type);
    assert.equal(stored.data.state, 'user_stated');
    assert.equal(stored.data.revision, 1);
    const read = await app.call(rec(owner, type, 'main', RECORD_TYPES[type].subject === 'member_required' ? `?memberId=${owner.memberId}` : ''), { token: owner.token });
    assert.equal(read.status, 200, `${type}: ${read.text}`);
    assert.deepEqual(read.data.data, samples[type], `${type} GET`);
  }
  // Direct SQL: no submitted value appears in any column of person_records.
  const rows = await db.many('SELECT * FROM person_records');
  assert.equal(rows.length, Object.keys(RECORD_TYPES).length);
  const everything = JSON.stringify(rows);
  for (const fragment of ['Quillberry', 'diabetes', 'hypertension', 'heart_disease', '919876500001', 'example.test', 'cardiac', 'kidney_', 'whatsapp', 'consultation']) {
    assert.ok(!everything.includes(fragment), `plaintext "${fragment}" found at rest`);
  }
  for (const row of rows) {
    assert.match(row.payload_ciphertext, /^enc2\./);
    assert.ok(['empty', 'partial', 'complete'].includes(row.completeness));
  }
  // The audit trail names fields, never values.
  const audit = JSON.stringify(await db.many("SELECT action, event_payload_json FROM audit_events WHERE action LIKE 'record.%'"));
  assert.ok(audit.includes('record.set') && audit.includes('heightCm'));
  for (const fragment of ['Quillberry', '919876500001', 'example.test']) assert.ok(!audit.includes(fragment), `audit leaks ${fragment}`);
  // The list route returns them all for the owner.
  const listed = await app.call(`/api/v1/households/${owner.householdId}/records`, { token: owner.token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.records.length, Object.keys(RECORD_TYPES).length);
  assert.deepEqual(listed.data.withheld, []);
});

test('completeness is computed by the server and provenance by source', opts, async t => {
  const { app, owner, put } = await setup(t);
  const member = owner.memberId;
  assert.equal((await put(owner, 'member_note', {}, { member })).data.completeness, 'empty');
  assert.equal((await put(owner, 'self_profile', { preferredLanguage: 'hi-IN' })).data.completeness, 'partial');
  assert.equal((await put(owner, 'self_profile', { preferredLanguage: 'hi-IN', occupationBand: 'retired' })).data.completeness, 'complete');
  const voice = await put(owner, 'member_note', { note: 'Prefers a morning call' }, { member, source: 'voice' });
  assert.equal(voice.data.source, 'voice');
  assert.equal(voice.data.state, 'extracted_unverified');
  assert.equal((await put(owner, 'member_note', { note: 'x' }, { member, source: 'telepathy' })).status, 400);
  for (const body of [{ data: {}, completeness: 'complete' }, { data: {}, state: 'confirmed_by_user' }, { data: {}, revision: 9 }]) {
    const r = await app.call(`/api/v1/households/${owner.householdId}/records/member_note/main?memberId=${member}`, { method: 'PUT', token: owner.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
});

test('revision: If-Match conflicts, create-if-absent, malformed header', opts, async t => {
  const { app, db, owner, put, rec } = await setup(t);
  const member = owner.memberId;
  const first = await put(owner, 'member_note', { note: 'one' }, { member, ifMatch: 0 });
  assert.equal(first.status, 200);
  assert.equal(first.data.revision, 1);
  const stale = await put(owner, 'member_note', { note: 'two' }, { member, ifMatch: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
  assert.equal((await put(owner, 'member_note', { note: 'two' }, { member, ifMatch: 1 })).data.revision, 2);
  assert.equal((await put(owner, 'member_note', { note: 'three' }, { member })).data.revision, 3);
  assert.equal((await put(owner, 'member_note', { note: 'x' }, { member, ifMatch: 'abc' })).status, 400);
  const del = await app.call(rec(owner, 'member_note', 'main', `?memberId=${member}`), { method: 'DELETE', token: owner.token, headers: { 'If-Match': '1' } });
  assert.equal(del.status, 409);
  assert.equal(await count(db, 'person_records'), 1);
  const ok = await app.call(rec(owner, 'member_note', 'main', `?memberId=${member}`), { method: 'DELETE', token: owner.token, headers: { 'If-Match': '3' } });
  assert.equal(ok.status, 200);
  assert.equal((await app.call(rec(owner, 'member_note', 'main', `?memberId=${member}`), { token: owner.token })).data.error.code, 'RECORD_NOT_FOUND');
  assert.equal((await app.call(rec(owner, 'member_note', 'main', `?memberId=${member}`), { method: 'DELETE', token: owner.token })).status, 404);
});

test('duplicate concurrent submit makes one row: one create wins, the other conflicts', opts, async t => {
  const { db, owner, put } = await setup(t);
  const results = await Promise.all([0, 1].map(() => put(owner, 'member_note', { note: 'same' }, { member: owner.memberId, ifMatch: 0 })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal(await count(db, 'person_records'), 1);
  // Without If-Match both replace: still one row.
  await Promise.all([0, 1, 2].map(() => put(owner, 'member_note', { note: 'again' }, { member: owner.memberId })));
  assert.equal(await count(db, 'person_records'), 1);
  assert.equal(Number((await db.one('SELECT revision FROM person_records')).revision), 4);
});

test('validation: strict keys, caps, slots, unknown types, prototype keys, size limit', opts, async t => {
  const { app, db, owner, put, rec, grant } = await setup(t);
  await grant(owner, 'health_profile');
  const member = owner.memberId;
  const bad = [
    ['unknown field', 'member_note', { note: 'a', extra: 1 }],
    ['note too long', 'member_note', { note: 'x'.repeat(201) }],
    ['bad enum', 'self_profile', { occupationBand: 'astronaut' }],
    ['height out of range', 'health_context', { heightCm: 400 }],
    ['float height', 'health_context', { heightCm: 170.5 }],
    ['string height', 'health_context', { heightCm: '170' }],
    ['duplicate condition', 'health_context', { conditions: [{ condition: 'asthma' }, { condition: 'asthma' }] }],
    ['condition missing', 'health_context', { conditions: [{ note: 'n' }] }],
    ['too many medicines', 'health_context', { medicines: Array.from({ length: 11 }, (_, i) => `Med${i}`) }],
    ['future year', 'health_context', { surgeries: [{ kind: 'cardiac', year: 2999 }] }],
    ['bad phone', 'emergency_contact', { name: 'A', mobile: '12345' }],
    ['bad email', 'advisor', { name: 'A', email: 'nope' }],
    ['share over 100', 'nominee', { sharePct: 101 }],
    ['negative spend', 'out_of_pocket_spend', { amountMinor: -1 }],
    ['future spend date', 'out_of_pocket_spend', { paidOn: '2999-01-01' }],
    ['not an object', 'member_note', 'text'],
  ];
  for (const [label, type, data] of bad) {
    const r = await put(owner, type, data, { member: type === 'member_note' || type === 'health_context' ? member : undefined });
    assert.equal(r.status, 400, `${label}: ${r.text}`);
    assert.equal(r.data.error.code, 'INVALID_REQUEST', label);
  }
  // Under-18 nominee date of birth is refused (age band only).
  await grant(owner, 'family_data');
  assert.equal((await put(owner, 'nominee', { name: 'Child', dateOfBirth: '2020-01-01' })).status, 400);
  assert.equal((await put(owner, 'nominee', { name: 'Child', ageBand: '6-12' })).status, 200);
  assert.equal((await put(owner, 'nominee', { name: 'Adult', dateOfBirth: '1980-01-01' }, { slot: 'n2' })).status, 200);
  // Unknown type, bad or wrong slots, missing member.
  assert.equal((await app.call(rec(owner, 'astrology'), { token: owner.token })).data.error.code, 'RECORD_TYPE_UNKNOWN');
  assert.equal((await put(owner, 'member_note', { note: 'a' }, { member, slot: 'two' })).status, 400);
  assert.equal((await put(owner, 'nominee', { name: 'A' }, { slot: 'bad/slot' })).status, 404);
  assert.equal((await put(owner, 'nominee', { name: 'A' }, { slot: 'x'.repeat(41) })).status, 400);
  assert.equal((await put(owner, 'member_note', { note: 'a' })).status, 400);
  assert.equal((await put(owner, 'member_note', { note: 'a' }, { member: 'member-missing' })).data.error.code, 'MEMBER_NOT_FOUND');
  // Size: more than 8 KB of JSON is 413 before anything is validated or stored.
  const big = await put(owner, 'health_context', { emergencyNote: 'x'.repeat(300), preferredDoctor: 'y'.repeat(9000) }, { member });
  assert.equal(big.status, 413);
  assert.equal(big.data.error.code, 'PAYLOAD_TOO_LARGE');
  // Prototype keys and junk bodies.
  const url = rec(owner, 'member_note', 'main', `?memberId=${member}`);
  for (const raw of ['{"data":{"__proto__":{"note":"x"}}}', '{"__proto__":{"data":{}}}', '{"data":{"constructor":{"note":"x"}}}', '{"data":{"note":"a"},"prototype":1}', '[]', 'null', '"text"', '{"data":[]}', '{not json']) {
    const r = await app.call(url, { method: 'PUT', token: owner.token, raw });
    assert.equal(r.status, 400, raw);
  }
  assert.equal(await count(db, 'person_records', "record_type = 'member_note'"), 0);
  // Slot capacity: an emergency contact list holds five.
  for (let n = 1; n <= 5; n += 1) assert.equal((await put(owner, 'emergency_contact', { name: `Contact ${n}`, mobile: `+9198765000${10 + n}`, rank: n }, { slot: `c${n}` })).status, 200);
  const sixth = await put(owner, 'emergency_contact', { name: 'Sixth', mobile: '+919876500099' }, { slot: 'c6' });
  assert.equal(sixth.status, 429);
  assert.equal(sixth.data.error.code, 'RECORD_CAPACITY_REACHED');
  assert.equal((await put(owner, 'emergency_contact', { name: 'Replaced' }, { slot: 'c3' })).status, 200);
});

test('text is normalised and unsafe characters are refused', opts, async t => {
  const { app, owner, put, rec } = await setup(t);
  const member = owner.memberId;
  const nfc = await put(owner, 'member_note', { note: '  Café order  ' }, { member });
  assert.equal(nfc.data.data.note, 'Café order');
  for (const note of ['bidi ‮ override', 'bell \u0007', 'line sep', 'c1 \u0085 control', 'tab\there', 'nul\u0000x', 'isolate ⁦x']) {
    const r = await put(owner, 'member_note', { note }, { member });
    assert.equal(r.status, 400, JSON.stringify(note));
  }
  // Phone and date tolerance, canonical storage.
  const phones = { '098765 43210': '+919876543210', '+91 98765-43210': '+919876543210', '9876543210': '+919876543210', '(+44) 20 7946 0958': '+442079460958' };
  for (const [typed, stored] of Object.entries(phones)) {
    const r = await put(owner, 'emergency_contact', { name: 'Typed', mobile: typed });
    assert.equal(r.data.data?.mobile, stored, typed);
  }
  const spend = await put(owner, 'out_of_pocket_spend', { amountMinor: 250050, paidOn: '03/11/2024', category: 'medicines' }, { slot: 's1' });
  assert.equal(spend.data.data.paidOn, '2024-11-03');
  assert.equal((await app.call(rec(owner, 'out_of_pocket_spend', 's1'), { token: owner.token })).data.data.amountMinor, 250050);
});

test('Aadhaar, PAN, card, CVV, password and OTP shapes are rejected everywhere free text is accepted', opts, async t => {
  const { app, db, owner, put, base } = await setup(t);
  const member = owner.memberId;
  const secrets = ['1234 5678 9012', '123456789012', 'my aadhaar 2345-6789-0123', 'ABCDE1234F', 'pan abcde1234f here', '4111 1111 1111 1111', '4111111111111111', '4111-1111-1111-1111', 'cvv 123', 'CVV: 4321', 'password: hunter2', 'my password is hunter2', 'otp is 123456', 'UPI PIN = 1234'];
  for (const secret of secrets) {
    assert.ok(containsSensitiveIdentifier(secret), secret);
    const r = await put(owner, 'member_note', { note: secret }, { member });
    assert.equal(r.status, 400, secret);
    assert.equal(r.data.error.code, 'SENSITIVE_IDENTIFIER_REJECTED', secret);
    assert.ok(!r.text.includes(secret.replace(/^.*?(\d)/, '$1')), 'the value is never echoed');
  }
  // Other free-text fields and routes.
  assert.equal((await put(owner, 'emergency_contact', { name: 'ABCDE1234F' })).data.error.code, 'SENSITIVE_IDENTIFIER_REJECTED');
  assert.equal((await put(owner, 'advisor', { name: 'Fine', firm: '123456789012' })).data.error.code, 'SENSITIVE_IDENTIFIER_REJECTED');
  const member1 = await app.call(`${base(owner)}/members`, { method: 'POST', token: owner.token, body: { displayName: 'ABCDE1234F', memberKind: 'adult' } });
  assert.equal(member1.data.error.code, 'SENSITIVE_IDENTIFIER_REJECTED');
  const member2 = await app.call(`${base(owner)}/members`, { method: 'POST', token: owner.token, body: { displayName: 'Fine Name', relationshipLabel: '4111 1111 1111 1111', memberKind: 'adult' } });
  assert.equal(member2.data.error.code, 'SENSITIVE_IDENTIFIER_REJECTED');
  const place = await app.call(`${base(owner)}/places/registered_address`, { method: 'PUT', token: owner.token, body: { label: '123456789012', address: { line1: 'Plot 1', city: 'Zebraville', state: 'Karnataka', pincode: '560034' } } });
  assert.equal(place.data.error.code, 'SENSITIVE_IDENTIFIER_REJECTED');
  // Ordinary numbers still save: a 10-digit phone in a note, a pincode, an amount.
  for (const ok of ['Call 9876543210 after 5 pm', 'Pincode 560034, flat 12', 'Paid 25,000 on 03/11']) assert.equal((await put(owner, 'member_note', { note: ok }, { member })).status, 200, ok);
  // Nothing was stored for the rejected ones and the audit trail has no rejected value.
  assert.equal(await count(db, 'household_members', 'household_id = ?', [owner.householdId]), 1);
  const audit = JSON.stringify(await db.many('SELECT event_payload_json FROM audit_events'));
  for (const secret of ['ABCDE1234F', '123456789012', '4111']) assert.ok(!audit.includes(secret), `audit leaks ${secret}`);
});

test('sealed AAD binds a payload to its row: moved ciphertext does not open', opts, async t => {
  const { app, db, owner, put, rec } = await setup(t);
  await put(owner, 'emergency_contact', { name: 'First Contact', mobile: '+919876500001' }, { slot: 'a' });
  await put(owner, 'emergency_contact', { name: 'Second Contact', mobile: '+919876500002' }, { slot: 'b' });
  const [one, two] = await db.many("SELECT id, payload_ciphertext FROM person_records ORDER BY slot");
  await db.run('UPDATE person_records SET payload_ciphertext = ? WHERE id = ?', [two.payload_ciphertext, one.id]);
  const r = await app.call(rec(owner, 'emergency_contact', 'a'), { token: owner.token });
  assert.notEqual(r.status, 200);
  assert.ok(!r.text.includes('Second Contact') && !r.text.includes('First Contact') && !r.text.includes('9876500002'));
  assert.equal((await app.call(rec(owner, 'emergency_contact', 'b'), { token: owner.token })).data.data.name, 'Second Contact');
  // The same holds for a sealed member mobile moved to another member.
  const a = await app.call(`/api/v1/households/${owner.householdId}/members`, { method: 'POST', token: owner.token, body: { displayName: 'Adult A', memberKind: 'adult', mobile: '+919876511111' } });
  const b = await app.call(`/api/v1/households/${owner.householdId}/members`, { method: 'POST', token: owner.token, body: { displayName: 'Adult B', memberKind: 'adult', mobile: '+919876522222' } });
  assert.equal(a.status, 201);
  const rowB = await db.one('SELECT mobile_ciphertext FROM household_members WHERE id = ?', [b.data.id]);
  await db.run('UPDATE household_members SET mobile_ciphertext = ? WHERE id = ?', [rowB.mobile_ciphertext, a.data.id]);
  const listed = await app.call(`/api/v1/households/${owner.householdId}/members`, { token: owner.token });
  assert.notEqual(listed.status, 200);
  assert.ok(!listed.text.includes('9876522222'));
});

test('cross-household access is refused for every record route', opts, async t => {
  const { app, db, owner, other, put, rec, grant, base } = await setup(t);
  await grant(owner, 'health_profile');
  assert.equal((await put(owner, 'member_note', { note: 'mine' }, { member: owner.memberId })).status, 200);
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member: owner.memberId })).status, 200);
  const ownerUrl = rec(owner, 'member_note', 'main', `?memberId=${owner.memberId}`);
  for (const [method, url, body] of [
    ['GET', ownerUrl], ['PUT', ownerUrl, { data: { note: 'hijack' } }], ['DELETE', ownerUrl],
    ['GET', `${base(owner)}/records`], ['GET', `${base(owner)}/records?type=health_context`],
  ]) {
    const r = await app.call(url, { method, token: other.token, ...(body ? { body } : {}) });
    assert.equal(r.status, 404, `${method} ${url}`);
    assert.equal(r.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  }
  // A member id from another household inside my own household path is not found; mine is not touched.
  const foreign = await app.call(rec(other, 'member_note', 'main', `?memberId=${owner.memberId}`), { method: 'PUT', token: other.token, body: { data: { note: 'x' } } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'MEMBER_NOT_FOUND');
  assert.equal((await app.call(`${base(owner)}/records?memberId=${other.memberId}`, { token: owner.token })).data.error.code, 'MEMBER_NOT_FOUND');
  assert.equal(await count(db, 'person_records', 'household_id = ?', [other.householdId]), 0);
  assert.equal((await app.call(ownerUrl, { token: owner.token })).data.data.note, 'mine');
  // No session, no access.
  assert.equal((await app.call(ownerUrl)).status, 401);
  // The trigger refuses a record whose member is in another household.
  await assert.rejects(db.run(`INSERT INTO person_records (id, household_id, subject_member_id, record_type, slot, payload_ciphertext, source, created_at, updated_at)
    VALUES ('prec-x', ?, ?, 'member_note', 'main', 'enc2.k.a.b.c', 'user_typed', 'now', 'now')`, [other.householdId, owner.memberId]));
});

test('dependants and health context need the owner or the guardian adult', opts, async t => {
  const { app, services, owner, put, grant, base } = await setup(t);
  const kid = await app.call(`${base(owner)}/members`, { method: 'POST', token: owner.token, body: { displayName: 'Kid Synthetic', memberKind: 'dependent', ageBand: '6-12' } });
  assert.equal(kid.status, 201);
  const mk = async (name, role) => {
    const adult = await services.households.createAdult({ displayName: name });
    await services.households.addRole({ householdId: owner.householdId, adultUserId: adult.id, role });
    const member = await services.households.addMember({ householdId: owner.householdId, adultUserId: adult.id, displayName: name });
    const session = await services.auth.issueSession({ adultUserId: adult.id });
    return { token: session.token, adultId: adult.id, memberId: member.id, householdId: owner.householdId };
  };
  const guardian = await mk('Guardian Synthetic', 'member');
  const bystander = await mk('Bystander Synthetic', 'member');
  const noGuardian = await put(owner, 'member_note', { note: 'n' }, { member: kid.data.id, token: bystander.token });
  assert.equal(noGuardian.status, 403);
  assert.equal(noGuardian.data.error.code, 'GUARDIAN_REQUIRED');
  // The owner names the guardian; the guardian can then use the dependant's records, the bystander still cannot.
  const set = await app.call(`${base(owner)}/members/${kid.data.id}`, { method: 'PATCH', token: owner.token, body: { guardianMemberId: guardian.memberId } });
  assert.equal(set.status, 200, set.text);
  assert.equal(set.data.guardianMemberId, guardian.memberId);
  assert.equal((await put(owner, 'member_note', { note: 'by guardian' }, { member: kid.data.id, token: guardian.token })).status, 200);
  assert.equal((await put(owner, 'member_note', { note: 'by owner' }, { member: kid.data.id })).status, 200);
  assert.equal((await put(owner, 'member_note', { note: 'again' }, { member: kid.data.id, token: bystander.token })).data.error.code, 'GUARDIAN_REQUIRED');
  const read = await app.call(`${base(owner)}/records/member_note/main?memberId=${kid.data.id}`, { token: bystander.token });
  assert.equal(read.status, 403);
  const listing = await app.call(`${base(owner)}/records`, { token: bystander.token });
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.data.records, []);
  assert.equal((await app.call(`${base(owner)}/records`, { token: guardian.token })).data.records.length, 1);
  // Health context: the guardian needs their own consent as well.
  await grant(owner, 'health_profile');
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member: kid.data.id, token: guardian.token })).data.error.code, 'CONSENT_REQUIRED');
  await grant(guardian, 'health_profile');
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member: kid.data.id, token: guardian.token })).status, 200);
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member: kid.data.id, token: bystander.token })).data.error.code, 'GUARDIAN_REQUIRED');
  // A real adult's own health context is theirs: the owner cannot write another account holder's records.
  const protectedWrite = await put(owner, 'health_context', { tobacco: 'never' }, { member: guardian.memberId });
  assert.equal(protectedWrite.status, 403);
  assert.equal(protectedWrite.data.error.code, 'MEMBER_PROTECTED');
  // A viewer cannot write at all.
  const viewer = await mk('Viewer Synthetic', 'viewer');
  assert.equal((await put(owner, 'member_note', { note: 'v' }, { member: owner.memberId, token: viewer.token })).data.error.code, 'HOUSEHOLD_WRITE_FORBIDDEN');
});

test('health context and nominees need consent; revoking it erases those records in the same transaction', opts, async t => {
  const { app, db, services, owner, other, put, rec, grant, base } = await setup(t);
  const member = owner.memberId;
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member })).data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await put(owner, 'nominee', { name: 'N' })).data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await app.call(rec(owner, 'health_context', 'main', `?memberId=${member}`), { token: owner.token })).data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await app.call(`${base(owner)}/records?type=nominee`, { token: owner.token })).data.error.code, 'CONSENT_REQUIRED');
  // Consent for another purpose or another category does not count; neither does someone else's or an expired one.
  await services.consents.grant({ householdId: owner.householdId, subjectAdultId: owner.adultId, purpose: 'document_processing', scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'health_profile' }] });
  await grant(owner, 'family_data', { expiresAt: '2020-01-01T00:00:00.000Z' });
  await grant(other, 'health_profile');
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member })).data.error.code, 'CONSENT_REQUIRED');
  assert.equal((await put(owner, 'nominee', { name: 'N' })).data.error.code, 'CONSENT_REQUIRED');
  // Ungated types never need it.
  assert.equal((await put(owner, 'emergency_contact', { name: 'E' }, { slot: 'c1' })).status, 200);

  const health = await grant(owner, 'health_profile');
  const family = await grant(owner, 'family_data');
  const unrelated = await grant(owner, 'family_data');
  assert.equal((await put(owner, 'health_context', { tobacco: 'never', conditions: [{ condition: 'asthma' }] }, { member })).status, 200);
  assert.equal((await put(owner, 'nominee', { name: 'Nominee One', sharePct: 100 })).status, 200);
  assert.equal((await put(owner, 'member_note', { note: 'stays' }, { member })).status, 200);
  assert.equal((await put(other, 'emergency_contact', { name: 'Other' }, { slot: 'c1' })).status, 200);
  const listed = await app.call(`${base(owner)}/records`, { token: owner.token });
  assert.equal(listed.data.records.length, 4);

  await services.consents.revoke({ grantId: health.id, revokedByAdultId: owner.adultId, reason: 'test' });
  assert.equal(await count(db, 'person_records', "record_type = 'health_context'"), 0, 'health context erased with its consent');
  assert.equal(await count(db, 'person_records', "record_type = 'nominee'"), 1, 'nominee kept: another category');
  assert.equal(await count(db, 'person_records', "record_type IN ('member_note', 'emergency_contact')"), 3, 'ungated types and other households kept');
  const erasedAudit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'person_records.erased'");
  const payload = JSON.parse(erasedAudit.event_payload_json);
  assert.equal(payload.count, 1);
  assert.deepEqual(payload.recordTypes, ['health_context']);
  assert.ok(!JSON.stringify(payload).includes('asthma'));
  assert.equal((await put(owner, 'health_context', { tobacco: 'never' }, { member })).data.error.code, 'CONSENT_REQUIRED');
  const afterList = await app.call(`${base(owner)}/records`, { token: owner.token });
  assert.deepEqual(afterList.data.withheld, ['health_context']);

  // A second revoke writes nothing; revoking the other category erases nominees only.
  await services.consents.revoke({ grantId: health.id, revokedByAdultId: owner.adultId });
  assert.equal(await count(db, 'audit_events', "action = 'person_records.erased'"), 1);
  await services.consents.revoke({ grantId: family.id, revokedByAdultId: owner.adultId });
  assert.equal(await count(db, 'person_records', "record_type = 'nominee'"), 0);
  assert.ok(unrelated.id);
});

test('household erasure and member removal delete person records; other households are untouched', opts, async t => {
  const { app, db, services, owner, other, put, grant, base } = await setup(t);
  for (const who of [owner, other]) {
    await grant(who, 'health_profile');
    await put(who, 'health_context', { tobacco: 'never' }, { member: who.memberId });
    await put(who, 'member_note', { note: 'note' }, { member: who.memberId });
  }
  const kid = await app.call(`${base(owner)}/members`, { method: 'POST', token: owner.token, body: { displayName: 'Kid', memberKind: 'dependent', ageBand: '0-5', dependentOnMemberId: owner.memberId } });
  assert.equal(kid.status, 201);
  assert.equal(kid.data.dependentOnMemberId, owner.memberId);
  assert.equal((await put(owner, 'member_note', { note: 'kid note' }, { member: kid.data.id })).status, 200);
  assert.equal(await count(db, 'person_records'), 5);
  const removed = await app.call(`${base(owner)}/members/${kid.data.id}`, { method: 'DELETE', token: owner.token });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(await count(db, 'person_records', 'subject_member_id = ?', [kid.data.id]), 0);
  assert.equal(await count(db, 'person_records'), 4);
  const audit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'household_member.removed'");
  assert.equal(JSON.parse(audit.event_payload_json).personRecordsErased, 1);
  const erased = await services.userDataRepository.eraseForHousehold({ householdId: owner.householdId });
  assert.equal(erased.person_records, 2);
  assert.equal(await count(db, 'person_records', 'household_id = ?', [owner.householdId]), 0);
  assert.equal(await count(db, 'person_records', 'household_id = ?', [other.householdId]), 2);
});

test('member details: sealed, hashed, rules for under-18, duplicate mobile, revision', opts, async t => {
  const { app, db, owner, base } = await setup(t);
  const members = `${base(owner)}/members`;
  const adult = await app.call(members, { method: 'POST', token: owner.token, body: {
    displayName: 'Rohan Synthetic', memberKind: 'adult', relationshipLabel: 'Spouse', dateOfBirth: '1988-06-01', gender: 'male', mobile: '098765 43210',
    email: 'Rohan.Quillberry@Example.test', preferredChannel: 'whatsapp', livesWithHousehold: true,
  } });
  assert.equal(adult.status, 201, adult.text);
  assert.equal(adult.data.mobile, '+919876543210');
  assert.equal(adult.data.email, 'rohan.quillberry@example.test');
  assert.equal(adult.data.gender, 'male');
  assert.equal(adult.data.preferredChannel, 'whatsapp');
  assert.equal(adult.data.livesWithHousehold, true);
  assert.equal(adult.data.revision, 1);
  assert.ok(!('mobile_hash' in adult.data) && !JSON.stringify(adult.data).includes('hash'));
  const raw = await db.one('SELECT * FROM household_members WHERE id = ?', [adult.data.id]);
  assert.match(raw.mobile_ciphertext, /^enc2\./);
  assert.match(raw.email_ciphertext, /^enc2\./);
  assert.match(raw.mobile_hash, /^[0-9a-f]{64}$/);
  const dump = JSON.stringify(raw);
  for (const fragment of ['9876543210', 'Quillberry', 'example.test', 'rohan.']) assert.ok(!dump.includes(fragment), `member row leaks ${fragment}`);
  assert.ok(!raw.mobile_ciphertext.includes('9876543210') && !raw.email_ciphertext.includes('Quillberry'));
  // Same mobile twice in one household is refused; another household may use it.
  const dup = await app.call(members, { method: 'POST', token: owner.token, body: { displayName: 'Dup', memberKind: 'adult', mobile: '+91 98765 43210' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'MEMBER_MOBILE_IN_USE');
  // Under 18: age band only, no date of birth, no contact fields.
  for (const body of [
    { displayName: 'Kid', memberKind: 'dependent', dateOfBirth: '2018-05-20' },
    { displayName: 'Kid', memberKind: 'dependent', ageBand: '6-12', dateOfBirth: '2018-05-20' },
    { displayName: 'Kid', memberKind: 'dependent', ageBand: '6-12', mobile: '+919876500055' },
    { displayName: 'Kid', memberKind: 'dependent', ageBand: '13-17', email: 'kid@example.test' },
    { displayName: 'Kid', memberKind: 'dependent', email: 'kid@example.test' },
    { displayName: 'Adult', memberKind: 'adult', dateOfBirth: '1990-01-01', ageBand: '61+' },
    { displayName: 'Bad', memberKind: 'adult', gender: 'robot' },
    { displayName: 'Bad', memberKind: 'adult', preferredChannel: 'pigeon' },
    { displayName: 'Bad', memberKind: 'adult', livesWithHousehold: 'yes' },
    { displayName: 'Bad', memberKind: 'adult', mobile: '123' },
    { displayName: 'Bad', memberKind: 'adult', guardianMemberId: 'member-missing' },
    { displayName: 'Bad', memberKind: 'adult', dependentOnMemberId: { x: 1 } },
  ]) {
    const r = await app.call(members, { method: 'POST', token: owner.token, body });
    assert.ok([400, 404].includes(r.status), `${JSON.stringify(body)} -> ${r.status} ${r.text}`);
  }
  assert.equal((await db.many('SELECT id FROM household_members WHERE household_id = ?', [owner.householdId])).length, 2);
  // A dependant aged 18+ may have contact details; an under-18 band can be set but then nothing contact-like can be added.
  const grown = await app.call(members, { method: 'POST', token: owner.token, body: { displayName: 'Grown', memberKind: 'dependent', ageBand: '18-30', email: 'grown@example.test' } });
  assert.equal(grown.status, 201, grown.text);
  const kid = await app.call(members, { method: 'POST', token: owner.token, body: { displayName: 'Kid', memberKind: 'dependent', ageBand: '6-12', gender: 'female', dependentOnMemberId: owner.memberId, guardianMemberId: owner.memberId } });
  assert.equal(kid.status, 201, kid.text);
  assert.equal(kid.data.dateOfBirth, null);
  const noContact = await app.call(`${members}/${kid.data.id}`, { method: 'PATCH', token: owner.token, body: { mobile: '+919876500077' } });
  assert.equal(noContact.status, 400);
  // PATCH with revision: stale If-Match conflicts, current succeeds, null clears.
  const stale = await app.call(`${members}/${adult.data.id}`, { method: 'PATCH', token: owner.token, body: { gender: 'other' }, headers: { 'If-Match': '5' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'REVISION_CONFLICT');
  const patched = await app.call(`${members}/${adult.data.id}`, { method: 'PATCH', token: owner.token, body: { gender: 'other', mobile: null, email: '' }, headers: { 'If-Match': '1' } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.data.revision, 2);
  assert.equal(patched.data.mobile, null);
  assert.equal(patched.data.email, null);
  const cleared = await db.one('SELECT mobile_ciphertext, mobile_hash, email_ciphertext FROM household_members WHERE id = ?', [adult.data.id]);
  assert.deepEqual({ ...cleared }, { mobile_ciphertext: null, mobile_hash: null, email_ciphertext: null });
  // The mobile can now be used by someone else.
  assert.equal((await app.call(members, { method: 'POST', token: owner.token, body: { displayName: 'Reuse', memberKind: 'adult', mobile: '9876543210' } })).status, 201);
  // Audit: field names only.
  const audit = JSON.stringify(await db.many("SELECT event_payload_json FROM audit_events WHERE action LIKE 'household_member.%'"));
  assert.ok(audit.includes('detailFields') && audit.includes('mobile'));
  for (const fragment of ['9876543210', 'Quillberry', 'example.test']) assert.ok(!audit.includes(fragment), `audit leaks ${fragment}`);
});

test('another household cannot read member contact details; a real adult is protected', opts, async t => {
  const { app, owner, other, base } = await setup(t);
  const made = await app.call(`${base(owner)}/members`, { method: 'POST', token: owner.token, body: { displayName: 'Contact Synthetic', memberKind: 'adult', mobile: '+919876500123' } });
  assert.equal(made.status, 201);
  assert.equal((await app.call(`${base(owner)}/members`, { token: other.token })).status, 404);
  const hijack = await app.call(`${base(owner)}/members/${made.data.id}`, { method: 'PATCH', token: other.token, body: { mobile: '+919876500124' } });
  assert.equal(hijack.status, 404);
  const self = await app.call(`${base(owner)}/members/${owner.memberId}`, { method: 'PATCH', token: owner.token, body: { gender: 'female', mobile: '+919876500200' } });
  assert.equal(self.status, 200, self.text);
  assert.equal(self.data.mobile, '+919876500200');
});

test('record writes are limited to 60 per adult per minute', opts, async t => {
  const { owner, other, put } = await setup(t);
  for (let n = 0; n < 60; n += 1) assert.equal((await put(owner, 'member_note', { note: `n${n}` }, { member: owner.memberId })).status, 200, `write ${n}`);
  const limited = await put(owner, 'member_note', { note: 'over' }, { member: owner.memberId });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'USER_DATA_RATE_LIMITED');
  assert.equal((await put(other, 'member_note', { note: 'fine' }, { member: other.memberId })).status, 200, 'another adult is not affected');
});

test('the new table is locked down: row level security on, no Data API grants', opts, async t => {
  const { db } = await setup(t);
  const rls = await db.one("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.person_records'::regclass");
  assert.equal(rls.relrowsecurity, true);
  const grants = await db.many(`SELECT r.rolname FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated')
    AND (has_table_privilege(r.oid, 'public.person_records'::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR has_any_column_privilege(r.oid, 'public.person_records'::regclass, 'SELECT, INSERT, UPDATE, REFERENCES'))`);
  assert.deepEqual(grants, []);
});
