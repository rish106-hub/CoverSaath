import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createApiServer } from '../src/server/server.js';

// Sync (ADR 0028, migration 046): change log, cursor pull, snapshot, batched idempotent push. Synthetic data only.
// Needs PostgreSQL (TEST_DATABASE_URL); REQUIRE_POSTGRES=1 makes a missing server an error.

const bootstrapToken = 'coversaath-test-bootstrap-token-0017';
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

async function setup(t, serviceOptions) {
  const fixture = await freshDatabase(t);
  const { db } = fixture;
  const app = await start(db);
  t.after(() => app.stop());
  const owner = await household(app, 'Synthetic');
  const other = await household(app, 'Other');
  const path = (who, rest) => `/api/v1/households/${who.householdId}/${rest}`;
  const services = serviceOptions ? createBackendServices(db, serviceOptions) : fixture.services;
  const push = (who, items, target = who) => app.call(path(target, 'sync/push'), { method: 'POST', token: who.token, body: { items } });
  const pull = (who, query = '', target = who) => app.call(path(target, `changes${query}`), { token: who.token });
  const put = (who, rest, body, ifMatch) => app.call(path(who, rest), { method: 'PUT', token: who.token, body, headers: ifMatch === undefined ? {} : { 'If-Match': String(ifMatch) } });
  return { app, db, services, owner, other, path, push, pull, put };
}

let counter = 0;
const mid = () => `mutation-${Date.now()}-${(counter += 1)}`;
const prefsItem = (owner, data, baseRevision = 0, extra = {}) => ({ mutationId: mid(), entity: 'preferences', id: owner.adultId, op: 'upsert', baseRevision, data: { prefs: data }, ...extra });
const ADDRESS = { line1: 'Plot 42 Sentinelgali Road', city: 'Zebraville', state: 'Karnataka', pincode: '560034', country: 'IN' };
const count = async (db, table, where = '1=1', params = []) => Number((await db.one(`SELECT count(*) AS c FROM ${table} WHERE ${where}`, params)).c);

test('two clients converge: each device pushes, each pulls with data, and both end on the same state', opts, async t => {
  const { owner, push, pull, put, path, app } = await setup(t);
  // Device A writes preferences and a scenario through push; device B writes onboarding through the ordinary PUT route.
  const a = await push(owner, [
    prefsItem(owner, { theme: 'dark' }),
    { mutationId: mid(), entity: 'scenarios', id: 'tax', op: 'upsert', baseRevision: 0, data: { tool: 'tax', inputs: { regime: 'old', annualIncome: 900000 } } },
  ]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data.results.map(r => r.status), ['applied', 'applied']);
  assert.equal((await put(owner, 'onboarding', { state: { step: 3, way: 'talk' } })).status, 200);

  const fromZero = await pull(owner, '?since=0&include=data');
  assert.equal(fromZero.status, 200);
  assert.deepEqual([...new Set(fromZero.data.items.map(i => i.entity))].sort(), ['members', 'onboarding', 'preferences', 'scenarios']);
  const dataOf = entity => fromZero.data.items.filter(i => i.entity === entity).at(-1).data;
  assert.equal(dataOf('preferences').prefs.theme, 'dark');
  assert.equal(dataOf('scenarios').inputs.annualIncome, 900000);
  assert.equal(dataOf('onboarding').state.way, 'talk');
  assert.equal(fromZero.data.hasMore, false);
  // A cursor at `next` sees nothing new; a later write shows up after it.
  const idle = await pull(owner, `?since=${fromZero.data.next}`);
  assert.deepEqual(idle.data.items, []);
  assert.equal(idle.data.next, fromZero.data.next);
  await put(owner, 'preferences', { prefs: { theme: 'light' } }, 1);
  const delta = await pull(owner, `?since=${fromZero.data.next}&include=data`);
  assert.equal(delta.data.items.length, 1);
  assert.equal(delta.data.items[0].revision, 2);
  assert.equal(delta.data.items[0].data.prefs.theme, 'light');
  // The feed agrees with the ordinary readers.
  const direct = await app.call(path(owner, 'preferences'), { token: owner.token });
  assert.deepEqual(delta.data.items[0].data.prefs, direct.data.prefs);
});

test('push is idempotent: the same mutationId replays, a changed body under it is refused', opts, async t => {
  const { owner, push, db, pull } = await setup(t);
  const item = prefsItem(owner, { theme: 'dark', reducedMotion: true });
  const first = await push(owner, [item]);
  assert.equal(first.data.results[0].status, 'applied');
  assert.equal(first.data.results[0].revision, 1);
  const again = await push(owner, [item]);
  assert.equal(again.status, 200);
  assert.equal(again.data.results[0].status, 'applied');
  assert.equal(again.data.results[0].revision, 1);
  assert.equal(again.data.results[0].replayed, true);
  assert.equal(await count(db, 'audit_events', "action = 'preferences.set'"), 1, 'the write ran once');
  assert.equal((await pull(owner, '?since=0')).data.items.filter(i => i.entity === 'preferences').length, 1);
  const reused = await push(owner, [{ ...item, data: { prefs: { theme: 'light' } } }]);
  assert.equal(reused.data.results[0].status, 'rejected');
  assert.equal(reused.data.results[0].code, 'MUTATION_ID_REUSED');
  // The dedupe record holds a status and a revision, never a value.
  const keys = await db.many("SELECT * FROM idempotency_keys WHERE scope LIKE 'sync:%'");
  assert.equal(keys.length, 1);
  assert.ok(!JSON.stringify(keys).includes('dark'));
  assert.deepEqual(JSON.parse(keys[0].response_json), { status: 'applied', revision: 1 });
});

test('the same mutationId in two households never aliases, and concurrent pushes serialise without loss or deadlock', opts, async t => {
  const { owner, other, push, pull, db } = await setup(t);
  const shared = mid();
  const a = await push(owner, [prefsItem(owner, { theme: 'dark' }, 0, { mutationId: shared })]);
  const b = await push(other, [prefsItem(other, { theme: 'light' }, 0, { mutationId: shared })]);
  assert.equal(a.data.results[0].replayed, undefined);
  assert.equal(b.data.results[0].replayed, undefined);
  assert.equal(b.data.results[0].status, 'applied');
  // Eight parallel pushes for one household: the change log is gap-free in commit order and holds every write once.
  const tools = ['tax', 'premium_rise', 'hospital_bill', 'inflation', 'compare_weights', 'stress_levers', 'review_state'];
  const writes = await Promise.all(tools.map(tool => push(owner, [{ mutationId: mid(), entity: 'scenarios', id: tool, op: 'upsert', baseRevision: 0, data: { tool, inputs: tool === 'review_state' ? { items: {} } : {} } }])));
  assert.ok(writes.every(r => r.data.results[0].status === 'applied'));
  const seqs = (await pull(owner, '?since=0')).data.items.filter(i => i.entity === 'scenarios');
  assert.equal(seqs.length, 7);
  assert.equal(new Set(seqs.map(i => i.id)).size, 7);
  const times = (await db.many('SELECT at FROM household_changes WHERE household_id = ? ORDER BY seq', [owner.householdId])).map(r => r.at);
  assert.deepEqual(times, [...times].sort(), 'seq order is time order');
});

test('a stale baseRevision returns the server copy, and an overlapping key is not merged', opts, async t => {
  const { owner, push, put } = await setup(t);
  await put(owner, 'preferences', { prefs: { theme: 'dark', voiceLanguage: 'ta-IN' } });
  const stale = await push(owner, [prefsItem(owner, { theme: 'light' }, 0)]);
  const result = stale.data.results[0];
  assert.equal(result.status, 'conflict');
  assert.equal(result.code, 'REVISION_CONFLICT');
  assert.equal(result.serverCopy.revision, 1);
  assert.deepEqual(result.serverCopy.data.prefs, { theme: 'dark', voiceLanguage: 'ta-IN' });
  // Same key changed on both sides, with baseData supplied: still a conflict, never a silent overwrite.
  await put(owner, 'preferences', { prefs: { theme: 'light', voiceLanguage: 'ta-IN' } }, 1);
  const clash = await push(owner, [prefsItem(owner, { theme: 'system', voiceLanguage: 'ta-IN' }, 1, { baseData: { prefs: { theme: 'dark', voiceLanguage: 'ta-IN' } } })]);
  assert.equal(clash.data.results[0].status, 'conflict');
  assert.equal(clash.data.results[0].serverCopy.data.prefs.theme, 'light');
  // No baseData: no merge attempt.
  await put(owner, 'preferences', { prefs: { theme: 'light', voiceLanguage: 'hi-IN' } }, 2);
  const blind = await push(owner, [prefsItem(owner, { theme: 'light', reducedMotion: true }, 2)]);
  assert.equal(blind.data.results[0].status, 'conflict');
  // A conflict replays as the same conflict.
  const item = prefsItem(owner, { theme: 'system' }, 0);
  const one = (await push(owner, [item])).data.results[0];
  const two = (await push(owner, [item])).data.results[0];
  assert.equal(one.status, 'conflict');
  assert.equal(two.replayed, true);
  assert.equal(two.code, 'REVISION_CONFLICT');
  assert.equal(two.serverCopy.revision, 3);
});

test('disjoint keys of preferences and scenarios merge automatically; review_state merges per item', opts, async t => {
  const { owner, push, put, path, app } = await setup(t);
  await put(owner, 'preferences', { prefs: { theme: 'dark' } });
  // Another device adds voiceLanguage (revision 2). This device, still on revision 1, adds reducedMotion.
  await put(owner, 'preferences', { prefs: { theme: 'dark', voiceLanguage: 'ta-IN' } }, 1);
  const merged = (await push(owner, [prefsItem(owner, { theme: 'dark', reducedMotion: true }, 1, { baseData: { prefs: { theme: 'dark' } } })])).data.results[0];
  assert.equal(merged.status, 'merged');
  assert.equal(merged.revision, 3);
  assert.deepEqual(merged.data.prefs, { theme: 'dark', voiceLanguage: 'ta-IN', reducedMotion: true });
  const stored = await app.call(path(owner, 'preferences'), { token: owner.token });
  assert.deepEqual(stored.data.prefs, { theme: 'dark', voiceLanguage: 'ta-IN', reducedMotion: true });
  assert.equal(stored.data.revision, 3);

  // review_state: the server accepted fact1, this device rejected fact2 against revision 1.
  await put(owner, 'scenarios/review_state', { inputs: { items: { fact1: { status: 'pending' }, fact2: { status: 'pending' } } } });
  await put(owner, 'scenarios/review_state', { inputs: { items: { fact1: { status: 'accepted' }, fact2: { status: 'pending' } } } }, 1);
  const review = (await push(owner, [{
    mutationId: mid(), entity: 'scenarios', id: 'review_state', op: 'upsert', baseRevision: 1,
    baseData: { inputs: { items: { fact1: { status: 'pending' }, fact2: { status: 'pending' } } } },
    data: { tool: 'review_state', inputs: { items: { fact1: { status: 'pending' }, fact2: { status: 'rejected' } } } },
  }])).data.results[0];
  assert.equal(review.status, 'merged');
  assert.deepEqual(review.data.inputs.items, { fact1: { status: 'accepted' }, fact2: { status: 'rejected' } });

  // Money and member entities never merge: a stale write to a place is a conflict even with baseData.
  await put(owner, 'places/registered_address', { address: ADDRESS });
  await put(owner, 'places/registered_address', { address: { ...ADDRESS, city: 'Quillville' } }, 1);
  const place = (await push(owner, [{
    mutationId: mid(), entity: 'places', id: 'registered', op: 'upsert', baseRevision: 1,
    baseData: { address: ADDRESS }, data: { kind: 'registered_address', address: { ...ADDRESS, landmark: 'Near the Zebrafountain' } },
  }])).data.results[0];
  assert.equal(place.status, 'conflict');
  assert.equal(place.serverCopy.data.address.city, 'Quillville');
});

test('an update of a deleted row returns DELETED; deleting twice is harmless; unsupported things are rejected per item', opts, async t => {
  const { owner, push, put, path, app } = await setup(t);
  const created = (await push(owner, [{ mutationId: mid(), entity: 'places', id: 'home-1', op: 'upsert', baseRevision: 0, data: { kind: 'registered_address', address: ADDRESS } }])).data.results[0];
  assert.equal(created.status, 'applied');
  const places = await app.call(path(owner, 'places'), { token: owner.token });
  const placeId = places.data.places[0].id;
  const removed = (await push(owner, [{ mutationId: mid(), entity: 'places', id: placeId, op: 'delete', baseRevision: 1, data: {} }])).data.results[0];
  assert.equal(removed.status, 'applied');
  assert.equal((await app.call(path(owner, 'places'), { token: owner.token })).data.places.length, 0);
  const late = (await push(owner, [{ mutationId: mid(), entity: 'places', id: placeId, op: 'upsert', baseRevision: 1, data: { kind: 'registered_address', address: ADDRESS } }])).data.results[0];
  assert.equal(late.status, 'conflict');
  assert.equal(late.code, 'DELETED');
  assert.equal(late.serverCopy, undefined);
  const twice = (await push(owner, [{ mutationId: mid(), entity: 'places', id: placeId, op: 'delete', baseRevision: 1 }])).data.results[0];
  assert.equal(twice.status, 'applied');

  // Per-item rejections never fail the batch; the valid item still applies.
  await put(owner, 'preferences', { prefs: { theme: 'dark' } });
  const batch = (await push(owner, [
    { mutationId: mid(), entity: 'claims', id: 'x1', op: 'upsert', baseRevision: 0, data: {} },
    { mutationId: mid(), entity: 'preferences', id: owner.adultId, op: 'delete', baseRevision: 1 },
    { mutationId: mid(), entity: 'preferences', id: 'someone-else', op: 'upsert', baseRevision: 0, data: { prefs: { theme: 'dark' } } },
    prefsItem(owner, { theme: 'bogus' }, 1),
    { mutationId: mid(), entity: 'preferences', id: owner.adultId, op: 'upsert', baseRevision: 1, data: { prefs: { theme: 'light' }, extra: 1 } },
    prefsItem(owner, { theme: 'light' }, 1),
  ])).data.results;
  assert.deepEqual(batch.map(r => r.status), ['rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'applied']);
  assert.deepEqual(batch.slice(0, 5).map(r => r.code), ['SYNC_ENTITY_UNSUPPORTED', 'SYNC_OPERATION_UNSUPPORTED', 'SYNC_ID_MISMATCH', 'INVALID_REQUEST', 'INVALID_REQUEST']);
  assert.equal((await app.call(path(owner, 'preferences'), { token: owner.token })).data.prefs.theme, 'light');
  // Envelope limits: 0 and 51 items are 400.
  assert.equal((await push(owner, [])).status, 400);
  assert.equal((await push(owner, Array.from({ length: 51 }, () => prefsItem(owner, { theme: 'dark' })))).status, 400);
  const full = await push(owner, Array.from({ length: 50 }, () => prefsItem(owner, { theme: 'dark' }, 2)));
  assert.equal(full.status, 200);
  assert.equal(full.data.results.length, 50);
  assert.equal(full.data.results.filter(r => r.status === 'applied' || r.status === 'conflict').length, 50);
});

test('a cursor below the trimmed floor is 410 CURSOR_EXPIRED; the snapshot is the way back', opts, async t => {
  const { owner, services, db, pull, put, app, path } = await setup(t);
  await put(owner, 'preferences', { prefs: { theme: 'dark' } });
  await put(owner, 'onboarding', { state: { step: 1 } });
  const before = await pull(owner, '?since=0');
  const top = before.data.next;
  // Nothing is older than 30 days yet: the purge removes nothing and the cursor stays valid.
  assert.deepEqual({ ...await services.syncRepository.purgeChangeLog() }, { removed: 0, expiredMutations: 0 });
  assert.equal((await pull(owner, '?since=0')).status, 200);
  // Age the log, then trim.
  await db.run("UPDATE household_changes SET at = '2020-01-01T00:00:00.000Z' WHERE household_id = ?", [owner.householdId]);
  const purged = await services.syncRepository.purgeChangeLog();
  assert.ok(purged.removed >= 2);
  assert.equal((await db.one('SELECT min_seq FROM household_sync_state WHERE household_id = ?', [owner.householdId])).min_seq, top);
  const expired = await pull(owner, '?since=0');
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error.code, 'CURSOR_EXPIRED');
  assert.equal((await pull(owner, `?since=${top}`)).status, 200, 'a cursor at the floor is still valid');
  assert.equal((await pull(owner, `?since=${top + 1000}`)).status, 410, 'a cursor from the future is not honoured');
  const snap = await app.call(path(owner, 'snapshot'), { token: owner.token });
  assert.equal(snap.status, 200);
  assert.equal(snap.data.seq, top);
  assert.ok(snap.data.items.some(i => i.entity === 'preferences' && i.data.prefs.theme === 'dark'));
  assert.equal((await pull(owner, `?since=${snap.data.seq}`)).status, 200);
  await put(owner, 'preferences', { prefs: { theme: 'light' } }, 1);
  assert.equal((await pull(owner, `?since=${snap.data.seq}`)).data.items.length, 1);
  // Purge audit names counts only.
  const audit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'sync.log_purged' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(Object.keys(JSON.parse(audit.event_payload_json)).sort(), ['expiredMutations', 'removed', 'retentionDays']);
});

test('the snapshot pages at one seq and, with the changes after it, equals the final state even when writes land between pages', opts, async t => {
  const { owner, db } = await setup(t, { syncLimits: { changesMax: 2 } });
  const services = createBackendServices(db, { syncLimits: { changesMax: 2 } });
  const principal = { adultId: owner.adultId };
  const hid = owner.householdId;
  const ud = services.userData;
  await ud.setPreferences(principal, hid, { prefs: { theme: 'dark' } });
  await ud.setOnboarding(principal, hid, { state: { step: 1 } });
  await ud.setScenario(principal, hid, 'tax', { inputs: { regime: 'old' } });
  await ud.setPermission(principal, hid, 'camera', { state: 'granted', surface: 'settings' });
  await ud.setPlace(principal, hid, 'registered_address', {}, { address: ADDRESS });

  const pages = [await services.sync.snapshot(principal, hid, {})];
  assert.equal(pages[0].items.length, 2);
  assert.equal(pages[0].hasMore, true);
  const startSeq = pages[0].seq;
  // Writes between pages: one existing entity changes, one new entity appears.
  await ud.setPreferences(principal, hid, { prefs: { theme: 'light' } }, '1');
  await ud.setScenario(principal, hid, 'premium_rise', { inputs: { currentPremium: 12000 } });
  while (pages.at(-1).hasMore) pages.push(await services.sync.snapshot(principal, hid, { cursor: pages.at(-1).cursor }));
  assert.ok(pages.every(page => page.seq === startSeq), 'every page is anchored to one seq');
  assert.ok(pages.every(page => page.items.length <= 2));
  const state = new Map();
  for (const page of pages) for (const item of page.items) state.set(`${item.entity}:${item.id}`, item);
  // Replay the log after the snapshot seq over the snapshot.
  const delta = await services.sync.changes(principal, hid, { since: String(startSeq), include: 'data' });
  for (const item of delta.items) if (item.op === 'upsert') state.set(`${item.entity}:${item.id}`, { entity: item.entity, id: item.id, data: item.data });
  const prefs = state.get(`preferences:${owner.adultId}`).data.prefs;
  assert.deepEqual(prefs, { theme: 'light' });
  assert.ok([...state.values()].some(i => i.entity === 'scenarios' && i.data.tool === 'premium_rise'));
  const finalSnapshot = [];
  let page = await services.sync.snapshot(principal, hid, {});
  finalSnapshot.push(...page.items);
  while (page.hasMore) { page = await services.sync.snapshot(principal, hid, { cursor: page.cursor }); finalSnapshot.push(...page.items); }
  assert.deepEqual(new Set(finalSnapshot.map(i => `${i.entity}:${i.id}`)), new Set(state.keys()));
  // A cursor for another household is refused.
  await assert.rejects(services.sync.snapshot(principal, 'household-other', { cursor: pages[0].cursor }), error => error.code === 'HOUSEHOLD_NOT_FOUND' || error.code === 'INVALID_REQUEST');
  await assert.rejects(services.sync.snapshot(principal, hid, { cursor: 'not-a-cursor' }), error => error.code === 'INVALID_REQUEST');
});

test('bounds: limit 200 is accepted and 201 refused; include=data stops at the byte budget and next resumes', opts, async t => {
  const { owner, db, pull } = await setup(t);
  assert.equal((await pull(owner, '?limit=200')).status, 200);
  for (const bad of ['?limit=201', '?limit=0', '?limit=abc', '?since=-1', '?include=all', '?x=1']) assert.equal((await pull(owner, bad)).status, 400, bad);
  // Tiny byte budget (the production budget is 256 KB): the response keeps at least one item, flags hasMore and resumes from next.
  const services = createBackendServices(db, { syncLimits: { responseBytes: 700 } });
  const principal = { adultId: owner.adultId };
  const hid = owner.householdId;
  await services.userData.setPreferences(principal, hid, { prefs: { theme: 'dark', sources: ['documents', 'email'] } });
  await services.userData.setOnboarding(principal, hid, { state: { step: 1, way: 'upload', people: { self: true } } });
  await services.userData.setScenario(principal, hid, 'tax', { inputs: { regime: 'old', annualIncome: 100000 } });
  await services.userData.setScenario(principal, hid, 'hospital_bill', { inputs: { billAmount: 120000, sumInsured: 500000 } });
  const seen = [];
  let since = 0;
  let rounds = 0;
  for (;;) {
    const page = await services.sync.changes(principal, hid, { since: String(since), include: 'data' });
    assert.ok(page.items.length >= 1 || !page.hasMore);
    if (page.hasMore) assert.ok(page.items.length < 5, 'trimmed by the byte budget');
    seen.push(...page.items.map(i => i.seq));
    since = page.next;
    rounds += 1;
    if (!page.hasMore || rounds > 20) break;
  }
  assert.ok(rounds > 1, 'the budget forced more than one page');
  const all = (await services.sync.changes(principal, hid, { since: '0' })).items.map(i => i.seq);
  assert.deepEqual(seen, all, 'paging by next misses and repeats nothing');
  // Page size 2 by count: hasMore and next agree.
  const small = await services.sync.changes(principal, hid, { since: '0', limit: '2' });
  assert.equal(small.items.length, 2);
  assert.equal(small.hasMore, true);
  assert.equal(small.next, small.items[1].seq);
});

test('every route refuses another household, a household of another session, and a missing token', opts, async t => {
  const { owner, other, app, path, push, pull } = await setup(t);
  await app.call(path(owner, 'preferences'), { method: 'PUT', token: owner.token, body: { prefs: { theme: 'dark' } } });
  for (const [label, call] of [
    ['changes', () => pull(other, '?since=0', owner)],
    ['snapshot', () => app.call(path(owner, 'snapshot'), { token: other.token })],
    ['push', () => push(other, [prefsItem(other, { theme: 'light' })], owner)],
  ]) {
    const r = await call();
    assert.equal(r.status, 404, label);
    assert.equal(r.data.error.code, 'HOUSEHOLD_NOT_FOUND', label);
    assert.ok(!JSON.stringify(r.data).includes('dark'), label);
  }
  for (const [label, call] of [
    ['changes', () => app.call(path(owner, 'changes?since=0'))],
    ['snapshot', () => app.call(path(owner, 'snapshot'))],
    ['push', () => app.call(path(owner, 'sync/push'), { method: 'POST', body: { items: [] } })],
  ]) assert.equal((await call()).status, 401, label);
  // The other household's data is untouched by the refused push.
  assert.equal((await app.call(path(other, 'preferences'), { token: other.token })).data.revision, 0);
  // Wrong methods are not routes.
  assert.equal((await app.call(path(owner, 'changes'), { method: 'POST', token: owner.token, body: {} })).status, 404);
});

test('a direct SQL write that bypasses the app still lands in the change log, and revision moves', opts, async t => {
  const { owner, db, put, pull, services } = await setup(t);
  await put(owner, 'permissions/camera', { state: 'granted', surface: 'settings' });
  const first = await pull(owner, '?since=0');
  const top = first.data.next;
  // No application code, no SET LOCAL: a bare UPDATE that forgets the revision.
  await db.run("UPDATE device_permissions SET state = 'denied' WHERE adult_user_id = ?", [owner.adultId]);
  const row = await db.one('SELECT revision, updated_at FROM device_permissions WHERE adult_user_id = ?', [owner.adultId]);
  assert.equal(row.revision, 2, 'the touch trigger moved the revision');
  const after = await pull(owner, `?since=${top}`);
  assert.equal(after.data.items.length, 1);
  assert.equal(after.data.items[0].entity, 'permissions');
  assert.equal(after.data.items[0].revision, 2);
  const logged = await db.one('SELECT actor_adult_id FROM household_changes WHERE seq = ?', [after.data.items[0].seq]);
  assert.equal(logged.actor_adult_id, null, 'no actor leaks from an earlier request');
  // A member row written outside the app, and a delete, are logged too (members are served; cases and documents are logged only).
  await db.run("UPDATE household_members SET relationship_label = 'self' WHERE id = ?", [owner.memberId]);
  await db.run("DELETE FROM device_permissions WHERE adult_user_id = ?", [owner.adultId]);
  const tail = (await pull(owner, `?since=${after.data.next}`)).data.items;
  assert.deepEqual(tail.map(i => [i.entity, i.op]), [['members', 'upsert'], ['permissions', 'delete']]);
  assert.equal(tail[1].revision, 3, 'a delete carries the next revision');
  const raw = await db.many('SELECT entity FROM household_changes WHERE household_id = ?', [owner.householdId]);
  assert.ok(raw.length >= 4);
  // The application's own write path does not double-bump.
  await services.userData.setPermission({ adultId: owner.adultId }, owner.householdId, 'microphone', { state: 'granted', surface: 'settings' });
  await services.userData.setPermission({ adultId: owner.adultId }, owner.householdId, 'microphone', { state: 'denied', surface: 'settings' }, '1');
  assert.equal((await db.one("SELECT revision FROM device_permissions WHERE permission = 'microphone'")).revision, 2);
});

test('the actor is recorded for app writes and is transaction-local', opts, async t => {
  const { owner, db, put, push } = await setup(t);
  await put(owner, 'preferences', { prefs: { theme: 'dark' } });
  await push(owner, [{ mutationId: mid(), entity: 'onboarding', id: owner.adultId, op: 'upsert', baseRevision: 0, data: { state: { step: 2 } } }]);
  const rows = await db.many("SELECT entity, actor_adult_id FROM household_changes WHERE entity IN ('preferences', 'onboarding') ORDER BY seq");
  assert.deepEqual(rows.map(r => r.actor_adult_id), [owner.adultId, owner.adultId]);
  assert.equal((await db.one("SELECT current_setting('knowvia.actor', true) AS actor")).actor ?? '', '');
  const setting = await db.one("SELECT current_setting('knowvia.actor', true) AS actor");
  assert.ok(!setting.actor, 'SET LOCAL ended with its transaction');
});

test('private rows stay private: another adult in the household sees neither the ids nor the data of your preferences', opts, async t => {
  const { owner, services, put, pull, path, app } = await setup(t);
  const second = await services.households.createAdult({ displayName: 'Second Synthetic', contactEmail: 'second@example.test' });
  await services.households.addRole({ householdId: owner.householdId, adultUserId: second.id, role: 'member' });
  await services.households.addMember({ householdId: owner.householdId, adultUserId: second.id, displayName: 'Second Synthetic' });
  const session = await services.auth.issueSession({ adultUserId: second.id });
  const mate = { token: session.token, householdId: owner.householdId, adultId: second.id };
  await put(owner, 'preferences', { prefs: { theme: 'dark' } });
  await put(owner, 'permissions/camera', { state: 'granted', surface: 'settings' });
  await put(mate, 'preferences', { prefs: { theme: 'light' } });
  const seen = (await pull(mate, '?since=0&include=data', owner)).data.items;
  assert.ok(seen.some(i => i.entity === 'preferences' && i.id === second.id && i.data.prefs.theme === 'light'));
  assert.ok(!seen.some(i => i.id === owner.adultId), 'the owner preference row is not shown');
  assert.ok(!seen.some(i => i.entity === 'permissions'), 'the owner permission row is not shown');
  assert.ok(!JSON.stringify(seen).includes('"dark"'));
  const snap = await app.call(path(owner, 'snapshot'), { token: mate.token });
  assert.ok(!JSON.stringify(snap.data).includes('"dark"'));
  // And the mate cannot push over the owner's preferences by naming the owner's id.
  const attempt = await app.call(path(owner, 'sync/push'), { method: 'POST', token: mate.token, body: { items: [prefsItem(owner, { theme: 'light' })] } });
  assert.equal(attempt.data.results[0].code, 'SYNC_ID_MISMATCH');
});

test('the change log and the push records hold no values; erasure removes the log, the state and the records', opts, async t => {
  const { owner, other, db, services, push, pull, put, app, path } = await setup(t);
  await push(owner, [
    prefsItem(owner, { theme: 'dark', voiceLanguage: 'ta-IN' }),
    { mutationId: mid(), entity: 'places', id: 'home-1', op: 'upsert', baseRevision: 0, data: { kind: 'registered_address', label: 'Quillhome label', address: ADDRESS } },
  ]);
  await put(owner, 'scenarios/tax', { inputs: { annualIncome: 1234567 } });
  await push(other, [prefsItem(other, { theme: 'light' })]);
  const logged = JSON.stringify(await db.many('SELECT * FROM household_changes'));
  const records = JSON.stringify(await db.many('SELECT * FROM idempotency_keys'));
  for (const fragment of ['Sentinelgali', 'Zebraville', 'Karnataka', '560034', 'Quillhome', 'ta-IN', 'dark', '1234567']) {
    assert.ok(!logged.includes(fragment), `change log leaks ${fragment}`);
    assert.ok(!records.includes(fragment), `push records leak ${fragment}`);
  }
  const columns = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'household_changes' ORDER BY ordinal_position")).map(r => r.column_name);
  assert.deepEqual(columns, ['seq', 'household_id', 'entity', 'entity_id', 'op', 'revision', 'subject_adult_id', 'actor_adult_id', 'at']);
  const auditText = JSON.stringify(await db.many("SELECT event_payload_json FROM audit_events WHERE action IN ('sync.push', 'sync.snapshot')"));
  for (const fragment of ['Sentinelgali', 'ta-IN', 'dark']) assert.ok(!auditText.includes(fragment));
  assert.ok(auditText.includes('applied'));
  await app.call(path(owner, 'snapshot'), { token: owner.token });
  assert.ok(await count(db, 'household_changes', 'household_id = ?', [owner.householdId]) > 0);
  assert.ok(await count(db, 'household_sync_state') === 0);
  await db.run("UPDATE household_changes SET at = '2020-01-01T00:00:00.000Z' WHERE household_id = ?", [owner.householdId]);
  await services.syncRepository.purgeChangeLog();
  assert.equal(await count(db, 'household_sync_state', 'household_id = ?', [owner.householdId]), 1);
  await push(owner, [prefsItem(owner, { theme: 'light' }, 1)]);

  // Erasure: data first (it logs its deletes), then the sync store. The other household is untouched.
  await services.userDataRepository.eraseForHousehold({ householdId: owner.householdId });
  assert.ok(await count(db, 'household_changes', 'household_id = ?', [owner.householdId]) > 0, 'the data erasure logged its own deletes');
  const erased = await services.syncRepository.eraseForHousehold({ householdId: owner.householdId });
  assert.ok(erased.household_changes > 0);
  assert.equal(erased.household_sync_state, 1);
  assert.equal(erased.mutations, 3);
  for (const table of ['household_changes', 'household_sync_state']) assert.equal(await count(db, table, 'household_id = ?', [owner.householdId]), 0, table);
  assert.equal(await count(db, 'idempotency_keys', "scope = ?", [`sync:${owner.adultId}`]), 0);
  assert.ok(await count(db, 'household_changes', 'household_id = ?', [other.householdId]) > 0);
  assert.equal(await count(db, 'idempotency_keys', "scope = ?", [`sync:${other.adultId}`]), 1);
  assert.equal((await pull(owner, '?since=0')).data.items.length, 0);
  const audit = await db.one("SELECT event_payload_json FROM audit_events WHERE action = 'sync.erased'");
  assert.deepEqual(Object.keys(JSON.parse(audit.event_payload_json)).sort(), ['changes', 'mutations', 'reasonCode', 'state']);
});

test('both sync tables cascade from the household, deny the Data API, and the log triggers exist', opts, async t => {
  const { db } = await freshDatabase(t);
  const fks = await db.many(`SELECT conrelid::regclass::text AS tbl, confrelid::regclass::text AS parent, confdeltype FROM pg_constraint
    WHERE contype = 'f' AND conrelid::regclass::text IN ('household_changes', 'household_sync_state')`);
  assert.equal(fks.length, 2);
  for (const fk of fks) assert.equal(fk.confdeltype, 'c', `${fk.tbl} -> ${fk.parent}`);
  const rls = await db.many("SELECT relname, relrowsecurity FROM pg_class WHERE relname IN ('household_changes', 'household_sync_state')");
  assert.ok(rls.length === 2 && rls.every(r => r.relrowsecurity));
  const triggers = (await db.many("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgname LIKE '%_sync_%' ORDER BY tgname")).map(r => r.tgname);
  assert.deepEqual(triggers, [
    'adult_preferences_sync_log', 'adult_preferences_sync_touch', 'device_permissions_sync_log', 'device_permissions_sync_touch',
    'document_uploads_sync_log', 'household_members_sync_log', 'household_places_sync_log', 'household_places_sync_touch',
    'onboarding_progress_sync_log', 'onboarding_progress_sync_touch', 'policies_sync_log', 'service_cases_sync_log',
    'tool_scenarios_sync_log', 'tool_scenarios_sync_touch',
  ]);
  // The helper is rerunnable: attaching twice leaves one trigger of each name.
  await db.run("SELECT public.attach_household_sync('public.policies', 'policies')");
  assert.equal(await count(db, 'pg_trigger', "tgname = 'policies_sync_log'"), 1);
});

test('a household delete cascades the log and sync state away (nothing is orphaned)', opts, async t => {
  const { db, services } = await freshDatabase(t);
  const adult = await services.households.createAdult({ displayName: 'Cascade Synthetic', contactEmail: 'cascade@example.test' });
  const created = await db.transaction(async () => {
    const hid = 'household-cascade-1';
    await db.run("INSERT INTO households (id, display_name, status, created_at, updated_at) VALUES (?, 'Cascade household', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", [hid]);
    await db.run("INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES ('member-cascade-1', ?, ?, 'Cascade Synthetic', 'adult', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')", [hid, adult.id]);
    await db.run("INSERT INTO household_sync_state (household_id, min_seq, updated_at) VALUES (?, 0, '2026-01-01T00:00:00.000Z')", [hid]);
    return hid;
  });
  assert.equal(await count(db, 'household_changes', 'household_id = ?', [created]), 1);
  await db.run('DELETE FROM household_members WHERE household_id = ?', [created]);
  assert.equal(await count(db, 'household_changes', 'household_id = ?', [created]), 2, 'the member delete was logged');
  await db.run('DELETE FROM households WHERE id = ?', [created]);
  assert.equal(await count(db, 'household_changes', 'household_id = ?', [created]), 0);
  assert.equal(await count(db, 'household_sync_state', 'household_id = ?', [created]), 0);
});
