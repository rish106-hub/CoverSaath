import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { ANALYTICS_EVENTS, ANALYTICS_EVENT_NAMES, ANALYTICS_CONSENT_SCOPE, sanitizeAnalyticsEvent } from '../src/contracts/analytics-events.js';
import { distinctIdHash } from '../src/backend/repositories/analytics-outbox-repository.js';
import { createPosthogClient } from '../src/integrations/index.js';
import { startAnalyticsDrain } from '../src/server/worker.js';
import { CHAT_INTENTS } from '../src/features/ai-analysis/gateway-contract.js';
import { DECLARATION_KINDS } from '../src/backend/repositories/declaration-repository.js';
import { PAID_VIA, PAYMENT_CHANNELS } from '../src/backend/repositories/premium-repository.js';
import { createApiServer } from '../src/server/server.js';
import { UPLOAD_DOCUMENT_KINDS } from '../src/backend/services/document-upload-service.js';

// Product analytics outbox (migration 057, ADR 0033, complete.md D6). Synthetic data only; no live PostHog call: the client is a local stub.
const opts = postgresTestOptions();
const SALT = 'test-analytics-salt-not-a-secret';
const ENV = { ANALYTICS_ENABLED: 'true', ANALYTICS_DISTINCT_ID_SALT: SALT };

async function world(t, env = ENV) {
  const fresh = await freshDatabase(t);
  const a = await seedWorld(fresh.handle.pool, 'a');
  const b = await seedWorld(fresh.handle.pool, 'b');
  const services = createBackendServices(fresh.db, { env });
  return { ...fresh, a, b, services };
}
async function grantAnalytics(pool, w, { id = `an-${w.household}`, revoked = false } = {}) {
  await insert(pool, 'consent_grants', { id, household_id: w.household, subject_adult_id: w.adult, purpose: 'analytics', ...(revoked ? { revoked_at: at } : {}) });
  await insert(pool, 'consent_scopes', {
    id: `${id}-scope`, consent_grant_id: id, resource_type: ANALYTICS_CONSENT_SCOPE.resourceType, action: ANALYTICS_CONSENT_SCOPE.action,
    data_category: ANALYTICS_CONSENT_SCOPE.dataCategory, recipient: ANALYTICS_CONSENT_SCOPE.recipient,
  });
}
const stubClient = () => {
  const sent = [];
  return { sent, send: async input => { sent.push(input); } };
};

test('the nine events are exactly the plan section 4 list', () => {
  assert.deepEqual([...ANALYTICS_EVENT_NAMES].sort(), ['chat_turn', 'conflict_resolved', 'cover_uploaded', 'declaration_added', 'hospital_search', 'insurer_confirmed', 'parse_completed', 'premium_recorded', 'voice_turn']);
});

test('the allowlist vocabularies mirror the code that produces them (drift)', () => {
  assert.deepEqual([...ANALYTICS_EVENTS.cover_uploaded.kind.values], [...UPLOAD_DOCUMENT_KINDS]);
  assert.deepEqual([...ANALYTICS_EVENTS.declaration_added.kind.values], [...DECLARATION_KINDS]);
  assert.deepEqual([...ANALYTICS_EVENTS.premium_recorded.channel.values], [...PAYMENT_CHANNELS]);
  assert.deepEqual([...ANALYTICS_EVENTS.premium_recorded.via.values], [...PAID_VIA]);
  assert.deepEqual([...ANALYTICS_EVENTS.chat_turn.intent.values], [...CHAT_INTENTS]);
});

test('sanitize: a property outside the allowlist, a free-text value or a wrong shape is rejected', () => {
  assert.deepEqual(sanitizeAnalyticsEvent('cover_uploaded', { kind: 'policy_wording', pages: 12 }).properties, { kind: 'policy_wording', pages: 12 });
  for (const [event, props] of [
    ['cover_uploaded', { kind: 'policy_wording', filename: 'x.pdf' }],
    ['cover_uploaded', { kind: 'my mother Asha Test policy' }],
    ['premium_recorded', { channel: 'upi', via: 'self', amount: 12000 }],
    ['premium_recorded', { channel: 'upi', via: 'agent', agent_name: 'Someone' }],
    ['parse_completed', { facts: 1.5, conflicts: 0, ms: 1 }],
    ['parse_completed', { facts: -1 }],
    ['insurer_confirmed', { manual: 'yes' }],
    ['chat_turn', { intent: 'general', message: 'is knee surgery covered' }],
    ['not_an_event', {}],
    ['__proto__', {}],
  ]) assert.throws(() => sanitizeAnalyticsEvent(event, props), { code: /^ANALYTICS_(PROPERTY|EVENT)_REJECTED$/ }, `${event} ${JSON.stringify(props)}`);
  assert.equal(sanitizeAnalyticsEvent('voice_turn', { seconds: 99_999 }).properties.seconds, 3600, 'counts clamp to their maximum');
});

test('the contract holds no free-text shape: every property is an enum, a bounded count or a boolean', () => {
  for (const spec of Object.values(ANALYTICS_EVENTS)) for (const shape of Object.values(spec)) assert.ok(['enum', 'count', 'boolean'].includes(shape.kind));
  assert.ok(!/@|\bname\b|\buin\b|policy_?number|amount/i.test(Object.values(ANALYTICS_EVENTS).flatMap(spec => Object.keys(spec)).join(' ')));
});

test('the distinct id is a salted hash, never the raw household id, and needs a real salt', () => {
  const hash = distinctIdHash('household-a', SALT);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes('household'));
  assert.notEqual(hash, distinctIdHash('household-a', `${SALT}-other`));
  assert.throws(() => distinctIdHash('household-a', ''), { code: 'ANALYTICS_SALT_MISSING' });
  assert.throws(() => distinctIdHash('household-a', 'short'), { code: 'ANALYTICS_SALT_MISSING' });
});

test('the repository rejects an event with an unlisted property before anything is stored', opts, async t => {
  const { services, a, db } = await world(t);
  await assert.rejects(services.analytics.repository.enqueue({ householdId: a.household, event: 'cover_uploaded', properties: { kind: 'policy_wording', note: 'x' }, salt: SALT }), { code: 'ANALYTICS_PROPERTY_REJECTED' });
  assert.equal((await db.many('SELECT id FROM analytics_outbox')).length, 0);
});

test('flag off: nothing is enqueued, even with consent and a salt', opts, async t => {
  for (const env of [{ ANALYTICS_DISTINCT_ID_SALT: SALT }, { ...ENV, ANALYTICS_ENABLED: 'TRUE' }, { ...ENV, ANALYTICS_ENABLED: '1' }, { ...ENV, ANALYTICS_ENABLED: 'false' }]) {
    const { services, a, handle, db } = await world(t, env);
    await grantAnalytics(handle.pool, a);
    assert.equal(await services.analytics.track({ householdId: a.household, event: 'cover_uploaded', properties: { kind: 'policy_wording' } }), false);
    assert.equal((await db.many('SELECT id FROM analytics_outbox')).length, 0);
  }
});

test('no salt: nothing is enqueued', opts, async t => {
  const { services, a, handle, db } = await world(t, { ANALYTICS_ENABLED: 'true' });
  await grantAnalytics(handle.pool, a);
  assert.equal(await services.analytics.track({ householdId: a.household, event: 'cover_uploaded', properties: { kind: 'policy_wording' } }), false);
  assert.equal((await db.many('SELECT id FROM analytics_outbox')).length, 0);
});

test('no analytics consent: nothing is enqueued (other purposes, a revoked grant and another household do not count)', opts, async t => {
  const { services, a, b, handle, db } = await world(t);
  const track = householdId => services.analytics.track({ householdId, event: 'cover_uploaded', properties: { kind: 'policy_wording' } });
  assert.equal(await track(a.household), false, 'no grant at all (the seed grant is document_processing)');
  await grantAnalytics(handle.pool, a, { id: 'an-revoked', revoked: true });
  assert.equal(await track(a.household), false, 'a revoked grant');
  await grantAnalytics(handle.pool, b);
  assert.equal(await track(a.household), false, 'another household consent');
  await insert(handle.pool, 'consent_grants', { id: 'an-noscope', household_id: a.household, subject_adult_id: a.adult, purpose: 'analytics' });
  assert.equal(await track(a.household), false, 'a grant without the usage-events scope');
  assert.equal((await db.many('SELECT id FROM analytics_outbox WHERE household_id = ?', [a.household])).length, 0);
});

test('flag on and consent: one row with the hash, the allowlisted properties and no raw id', opts, async t => {
  const { services, a, handle, db } = await world(t);
  await grantAnalytics(handle.pool, a);
  assert.equal(await services.analytics.track({ householdId: a.household, event: 'premium_recorded', properties: { channel: 'upi', via: 'agent' } }), true);
  assert.equal(await services.analytics.track({ householdId: a.household, event: 'premium_recorded', properties: { channel: 'upi', agent_name: 'x' } }), false, 'a rejected event is swallowed');
  const rows = await db.many('SELECT * FROM analytics_outbox');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].distinct_id_hash, distinctIdHash(a.household, SALT));
  assert.deepEqual(JSON.parse(rows[0].properties_json), { channel: 'upi', via: 'agent' });
  assert.equal(rows[0].sent_at, null);
  assert.ok(!JSON.stringify(rows[0]).includes(a.household.replace('household-', 'household-')) || rows[0].household_id === a.household, 'only the household_id column names it');
  assert.ok(![rows[0].distinct_id_hash, rows[0].properties_json, rows[0].event].some(value => value.includes(a.household)));
});

test('drain sends through the client with the hash and allowlisted properties, then marks the row sent', opts, async t => {
  const { services, a, handle, db } = await world(t);
  await grantAnalytics(handle.pool, a);
  await services.analytics.track({ householdId: a.household, event: 'cover_uploaded', properties: { kind: 'policy_schedule', pages: 7 } });
  const client = stubClient();
  assert.deepEqual({ ...await services.analytics.drain({ client }) }, { sent: 1, failed: 0, dropped: 0, purged: 0 });
  assert.deepEqual(client.sent, [{ distinctId: distinctIdHash(a.household, SALT), event: 'cover_uploaded', properties: { kind: 'policy_schedule', pages: 7 } }]);
  assert.ok((await db.one('SELECT sent_at FROM analytics_outbox')).sent_at);
  assert.equal((await services.analytics.drain({ client })).sent, 0, 'a sent row is never sent twice');
  assert.equal(client.sent.length, 1);
});

test('drain: a failing client leaves the row unsent for the next drain; no client or flag off sends and reads nothing', opts, async t => {
  const { services, a, handle, db } = await world(t);
  await grantAnalytics(handle.pool, a);
  await services.analytics.track({ householdId: a.household, event: 'voice_turn', properties: { seconds: 4 } });
  const failing = { send: async () => { throw Object.assign(new Error('down'), { code: 'POSTHOG_SEND_FAILED' }); } };
  assert.equal((await services.analytics.drain({ client: failing })).failed, 1);
  assert.equal((await db.one('SELECT sent_at FROM analytics_outbox')).sent_at, null);
  assert.equal((await services.analytics.drain({ client: null })).skipped, true, 'no key: the drain is a no-op');
  const off = createBackendServices(db, { env: { ANALYTICS_DISTINCT_ID_SALT: SALT } });
  const client = stubClient();
  assert.equal((await off.analytics.drain({ client })).skipped, true);
  assert.equal(client.sent.length, 0);
  assert.equal((await services.analytics.drain({ client })).sent, 1, 'the next drain retries');
});

test('drain re-checks consent: unsent rows of a household that withdrew are deleted, not sent', opts, async t => {
  const { services, a, b, handle, db } = await world(t);
  await grantAnalytics(handle.pool, a);
  await grantAnalytics(handle.pool, b);
  for (const w of [a, b]) await services.analytics.track({ householdId: w.household, event: 'hospital_search', properties: { results: 3 } });
  await db.run('UPDATE consent_grants SET revoked_at = ? WHERE household_id = ? AND purpose = ?', [at, a.household, 'analytics']);
  const client = stubClient();
  assert.deepEqual({ ...await services.analytics.drain({ client }) }, { sent: 1, failed: 0, dropped: 1, purged: 0 });
  assert.equal(client.sent[0].distinctId, distinctIdHash(b.household, SALT));
  assert.equal((await db.many('SELECT id FROM analytics_outbox WHERE household_id = ?', [a.household])).length, 0);
});

test('drain refuses a stored row that carries a property outside the allowlist', opts, async t => {
  const { services, a, handle, db } = await world(t);
  await grantAnalytics(handle.pool, a);
  await insert(handle.pool, 'analytics_outbox', { id: 'bad-row', household_id: a.household, event: 'cover_uploaded', distinct_id_hash: distinctIdHash(a.household, SALT), properties_json: JSON.stringify({ kind: 'policy_wording', email: 'x' }) });
  const client = stubClient();
  assert.equal((await services.analytics.drain({ client })).dropped, 1);
  assert.equal(client.sent.length, 0);
  assert.equal((await db.many('SELECT id FROM analytics_outbox')).length, 0);
});

test('sent rows are purged after seven days', opts, async t => {
  const { a, handle, db } = await world(t);
  const old = '2026-01-01T00:00:00.000Z';
  await insert(handle.pool, 'analytics_outbox', { id: 'old-sent', household_id: a.household, distinct_id_hash: 'b'.repeat(64), properties_json: '{}', sent_at: old, created_at: old });
  const services = createBackendServices(db, { env: ENV, clock: () => new Date('2026-02-01T00:00:00.000Z') });
  assert.equal((await services.analytics.drain({ client: stubClient() })).purged, 1);
});

test('erasure: household erasure deletes the household outbox rows and only those', opts, async t => {
  const { services, a, b, handle, db } = await world(t);
  for (const w of [a, b]) {
    await grantAnalytics(handle.pool, w);
    await services.analytics.track({ householdId: w.household, event: 'cover_uploaded', properties: { kind: 'policy_wording' } });
  }
  assert.equal((await db.many('SELECT id FROM analytics_outbox')).length, 2);
  const result = await services.analytics.repository.eraseForHousehold(a.household);
  assert.equal(result, 1);
  assert.deepEqual((await db.many('SELECT household_id FROM analytics_outbox')).map(row => row.household_id), [b.household]);
  assert.match(readFileSync(new URL('../src/backend/repositories/erasure-repository.js', import.meta.url), 'utf8'), /DELETE FROM analytics_outbox WHERE household_id = \?/);
});

test('the outbox table cannot hold a free-text event name or a raw id hash', opts, async t => {
  const { a, handle } = await world(t);
  await assert.rejects(insert(handle.pool, 'analytics_outbox', { id: 'x1', household_id: a.household, event: 'Free Text Event', distinct_id_hash: 'a'.repeat(64) }), /violates check constraint/);
  await assert.rejects(insert(handle.pool, 'analytics_outbox', { id: 'x2', household_id: a.household, distinct_id_hash: a.household }), /violates check constraint/);
  await assert.rejects(insert(handle.pool, 'analytics_outbox', { id: 'x3', household_id: a.household, distinct_id_hash: 'a'.repeat(64), properties_json: '[]' }), /violates check constraint/);
});

test('PostHog adapter: not configured without a key and host; sends through the SDK client with GeoIP off; errors carry a code only', async () => {
  assert.equal(createPosthogClient({ env: {} }), null);
  assert.equal(createPosthogClient({ env: { POSTHOG_API_KEY: 'phc_test_not_real' } }), null, 'no host: never guessed');
  assert.equal(createPosthogClient({ env: { POSTHOG_API_KEY: 'phc_test_not_real', POSTHOG_HOST: 'http://example.test' } }), null, 'https only');
  const calls = [];
  let options;
  const client = createPosthogClient({
    env: { POSTHOG_API_KEY: 'phc_test_not_real', POSTHOG_HOST: 'https://ph.example.test/' },
    clientFactory: (key, opt) => { options = { key, ...opt }; return { captureImmediate: async input => { calls.push(input); }, shutdown: async () => {} }; },
  });
  await client.send({ distinctId: 'a'.repeat(64), event: 'voice_turn', properties: { seconds: 3 } });
  assert.equal(options.host, 'https://ph.example.test');
  assert.equal(options.disableGeoip, true);
  assert.equal(options.fetchRetryCount, 0);
  assert.deepEqual(calls[0], { distinctId: 'a'.repeat(64), event: 'voice_turn', properties: { seconds: 3, $process_person_profile: false }, disableGeoip: true });
  await assert.rejects(client.send({ distinctId: 'household-a', event: 'voice_turn', properties: {} }), { code: 'POSTHOG_INPUT_INVALID' });
  const broken = createPosthogClient({
    env: { POSTHOG_API_KEY: 'phc_test_not_real', POSTHOG_HOST: 'https://ph.example.test' },
    clientFactory: () => ({ captureImmediate: async () => { throw new Error('secret phc_test_not_real body'); }, shutdown: async () => {} }),
  });
  await assert.rejects(broken.send({ distinctId: 'a'.repeat(64), event: 'voice_turn', properties: {} }), error => error.code === 'POSTHOG_SEND_FAILED' && !error.message.includes('phc_'));
});

test('worker drain: no timer without the flag, the salt or a client; a tick sends one batch', opts, async t => {
  const { services, a, handle, db } = await world(t);
  assert.equal(startAnalyticsDrain({ services, env: ENV, client: null }), null, 'no key: no timer');
  const off = createBackendServices(db, { env: {} });
  assert.equal(startAnalyticsDrain({ services: off, env: {}, client: stubClient() }), null);
  await grantAnalytics(handle.pool, a);
  await services.analytics.track({ householdId: a.household, event: 'voice_turn', properties: { seconds: 2 } });
  const closed = [];
  const client = { ...stubClient(), close: async () => closed.push(true) };
  const drain = startAnalyticsDrain({ services, env: { ...ENV, ANALYTICS_DRAIN_MS: '3600000' }, client });
  await drain.tick();
  assert.equal(client.sent.length, 1);
  await drain.stop();
  assert.equal(closed.length, 1);
});

test('HTTP event point: recording a premium enqueues channel and via only (no amount, no agent name or code), and nothing without consent', opts, async t => {
  const { a, b, handle, db, services } = await world(t);
  for (const w of [a, b]) {
    await insert(handle.pool, 'consent_grants', { id: `pi-${w.household}`, household_id: w.household, subject_adult_id: w.adult, purpose: 'profile_intake' });
    w.token = (await services.auth.issueSession({ adultUserId: w.adult })).token;
    w.holding = await services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy });
  }
  await grantAnalytics(handle.pool, a);
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-test-bootstrap-token-0018', HOLDINGS_ENABLED: 'true', ...ENV } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = (w, body) => fetch(`http://127.0.0.1:${server.address().port}/api/v1/households/${w.household}/premiums`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${w.token}` }, body: JSON.stringify({ holdingId: w.holding.id, paidOn: '2026-04-01', ...body }),
  });
  const secret = { amountPaise: 1234500, channel: 'upi', paidVia: 'agent', agentName: 'Quillberry Agent', agentCode: 'AG-777' };
  assert.equal((await post(a, secret)).status, 201);
  assert.equal((await post(b, secret)).status, 201);
  const rows = await db.many('SELECT * FROM analytics_outbox ORDER BY household_id');
  assert.equal(rows.length, 1, 'only the consenting household');
  assert.equal(rows[0].household_id, a.household);
  assert.equal(rows[0].event, 'premium_recorded');
  assert.deepEqual(JSON.parse(rows[0].properties_json), { channel: 'upi', via: 'agent' });
  assert.ok(!JSON.stringify(rows).match(/1234500|Quillberry|AG-777/));
});
