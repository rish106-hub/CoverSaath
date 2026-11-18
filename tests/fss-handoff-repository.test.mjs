import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { seedWorld } from './support/postgres-fixtures.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { FSS_FINAL_STATES, FSS_OPEN_STATES } from '../src/backend/repositories/fss-handoff-repository.js';
import { HANDOFF_STATES } from '../src/integrations/insurance-data/index.js';
import { eraseMemoryForDocuments, eraseMemoryForHousehold } from '../src/backend/repositories/memory-erasure.js';

// FSS handoff state (migration 068, ADR 0037): one open task per holding, idempotent and monotonic notices, the holding-to-product link,
// and erasure with the holding, the document and the household. Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();

async function world(t) {
  const fresh = await freshDatabase(t);
  const { db, handle } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  const services = createBackendServices(db, { env: { HOLDINGS_ENABLED: 'true' } });
  const holdingOf = async w => (await services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy })).id;
  const holdingA = await holdingOf(a);
  const holdingB = await holdingOf(b);
  return { ...fresh, a, b, holdingA, holdingB, repo: services.fssHandoffs };
}
const count = (s, table) => s.db.one(`SELECT count(*)::int AS n FROM ${table}`).then(row => row.n);

test('queue: one open handoff per holding; a repeat returns it; a foreign holding is a 404', opts, async t => {
  const s = await world(t);
  const first = await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA });
  assert.equal(first.created, true);
  assert.equal(first.handoff.state, 'queued');
  assert.match(first.handoff.requestId, /^req-[0-9a-f-]{36}$/);
  const again = await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA });
  assert.deepEqual([again.created, again.handoff.id], [false, first.handoff.id]);
  await assert.rejects(s.repo.queue({ householdId: s.a.household, holdingId: s.holdingB }), { code: 'HOLDING_NOT_FOUND' });
  assert.equal(await count(s, 'fss_handoffs'), 1);
  // The database itself refuses a second open row for the holding, whatever the code does.
  await assert.rejects(s.db.run(`INSERT INTO fss_handoffs (id, household_id, holding_id, request_id, state, created_at, updated_at) VALUES ('x1', ?, ?, 'req-duplicate-0001', 'queued', 'now', 'now')`, [s.a.household, s.holdingA]), /fss_handoffs_one_open_per_holding/);
});

test('notices: accepted, then final; a repeat is a duplicate, a later different state is ignored, an unknown request id is dropped', opts, async t => {
  const s = await world(t);
  const { handoff } = await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA });
  assert.equal(await s.repo.recordAccepted({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'accepted' }), true);
  assert.equal(await s.repo.recordAccepted({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'accepted' }), false);
  assert.equal((await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'working' })).result, 'applied');
  assert.equal((await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'accepted' })).result, 'ignored', 'no step backwards');
  const matched = await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'matched', versionId: 'v-9' });
  assert.equal(matched.result, 'applied');
  assert.deepEqual([matched.handoff.state, matched.handoff.versionId, typeof matched.handoff.decidedAt], ['matched', 'v-9', 'string']);
  assert.equal((await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'matched', versionId: 'v-9' })).result, 'duplicate');
  assert.equal((await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'no_match' })).result, 'ignored', 'a final state never changes');
  assert.equal((await s.repo.applyNotice({ requestId: 'req-does-not-exist', fssHandoffId: 'h-1', state: 'matched', versionId: 'v-9' })).result, 'unknown');
  assert.equal((await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-other', state: 'working' })).result, 'ignored', 'another FSS handoff id never rewrites it');
  assert.deepEqual((await s.repo.byRequestId(handoff.requestId)).state, 'matched');
  // Once decided, the holding may start a new handoff.
  assert.equal((await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA })).created, true);
});

test('notices: a version id only on matched; bad ids and states are refused before any write', opts, async t => {
  const s = await world(t);
  const { handoff } = await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA });
  for (const bad of [{ state: 'no_match', versionId: 'v-1' }, { state: 'queued' }, { state: 'failed' }, { state: 'matched', versionId: 'bad id with spaces' }]) {
    await assert.rejects(s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', ...bad }), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: '', state: 'working' }), { code: 'INVALID_REQUEST' });
  assert.equal((await s.repo.byRequestId(handoff.requestId)).state, 'queued');
});

test('send failures: three attempts then failed; a late final notice may still decide a failed handoff', opts, async t => {
  const s = await world(t);
  const { handoff } = await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA });
  assert.equal(await s.repo.recordSendFailure({ requestId: handoff.requestId, outcome: 'unavailable' }), 'queued');
  assert.equal(await s.repo.recordSendFailure({ requestId: handoff.requestId, outcome: 'timeout' }), 'queued');
  assert.equal(await s.repo.recordSendFailure({ requestId: handoff.requestId, outcome: 'unavailable' }), 'failed');
  assert.equal(await s.repo.recordSendFailure({ requestId: handoff.requestId, outcome: 'unavailable' }), null, 'a failed handoff is not retried');
  const row = await s.repo.byRequestId(handoff.requestId);
  assert.deepEqual([row.state, row.attempts, row.lastOutcome], ['failed', 3, 'unavailable']);
  assert.equal((await s.repo.applyNotice({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'no_match' })).result, 'applied');
  await assert.rejects(s.repo.recordSendFailure({ requestId: handoff.requestId, outcome: 'Bad Outcome!' }), { code: 'INVALID_REQUEST' });
});

test('poll list: only accepted or working handoffs not heard from since the cut-off', opts, async t => {
  const s = await world(t);
  const { handoff } = await s.repo.queue({ householdId: s.a.household, holdingId: s.holdingA });
  assert.deepEqual(await s.repo.openForPoll({ olderThanIso: '9999-01-01T00:00:00.000Z' }), [], 'queued is not polled');
  await s.repo.recordAccepted({ requestId: handoff.requestId, fssHandoffId: 'h-1', state: 'accepted' });
  assert.equal((await s.repo.openForPoll({ olderThanIso: '9999-01-01T00:00:00.000Z' })).length, 1);
  assert.deepEqual(await s.repo.openForPoll({ olderThanIso: '2000-01-01T00:00:00.000Z' }), []);
});

test('link: one mapping per holding, replaced on a new match, closed enums, household must agree', opts, async t => {
  const s = await world(t);
  await s.repo.link({ householdId: s.a.household, holdingId: s.holdingA, productId: 'p-1', versionId: null, matchedBy: 'alias', confidence: 'medium' });
  await s.repo.link({ householdId: s.a.household, holdingId: s.holdingA, productId: 'p-2', versionId: 'v-3', matchedBy: 'uin', confidence: 'high' });
  const link = await s.repo.linkFor(s.holdingA);
  assert.deepEqual([link.productId, link.versionId, link.matchedBy, link.confidence], ['p-2', 'v-3', 'uin', 'high']);
  assert.equal(await count(s, 'holding_fss_links'), 1);
  for (const bad of [{ matchedBy: 'guess' }, { confidence: 'certain' }, { productId: 'has space' }]) {
    await assert.rejects(s.repo.link({ householdId: s.a.household, holdingId: s.holdingA, productId: 'p-1', matchedBy: 'alias', confidence: 'low', ...bad }), { code: 'INVALID_REQUEST' });
  }
  await assert.rejects(s.repo.link({ householdId: s.a.household, holdingId: s.holdingB, productId: 'p-1', matchedBy: 'alias', confidence: 'low' }), { code: 'HOLDING_NOT_FOUND' });
  assert.equal(await s.repo.linkFor(s.holdingB), null);
});

test('erasure: document erasure and household erasure remove handoffs and links of that holding only', opts, async t => {
  const s = await world(t);
  for (const [w, holding] of [[s.a, s.holdingA], [s.b, s.holdingB]]) {
    await s.repo.queue({ householdId: w.household, holdingId: holding });
    await s.repo.link({ householdId: w.household, holdingId: holding, productId: 'p-1', matchedBy: 'alias', confidence: 'low' });
  }
  assert.deepEqual([await count(s, 'fss_handoffs'), await count(s, 'holding_fss_links')], [2, 2]);
  await eraseMemoryForDocuments(s.db, { householdId: s.a.household, documentIds: [s.a.document] });
  assert.deepEqual([await count(s, 'fss_handoffs'), await count(s, 'holding_fss_links')], [1, 1]);
  assert.equal((await s.db.one('SELECT household_id FROM fss_handoffs')).household_id, s.b.household);
  await eraseMemoryForHousehold(s.db, { householdId: s.b.household });
  assert.deepEqual([await count(s, 'fss_handoffs'), await count(s, 'holding_fss_links')], [0, 0]);
});

test('the stored rows hold ids, enums and times only (no name, number or UIN column exists)', opts, async t => {
  const s = await world(t);
  const columns = (await s.db.many(`SELECT table_name, column_name FROM information_schema.columns WHERE table_name IN ('fss_handoffs', 'holding_fss_links') ORDER BY 1, 2`)).map(row => `${row.table_name}.${row.column_name}`);
  assert.ok(columns.length > 10);
  assert.deepEqual(columns.filter(name => /name|uin|number|policy_no|member|text|body|quote/.test(name.split('.')[1])), []);
});

test('the local states cover every state FSS can report, and nothing else is final but the local failed', () => {
  for (const state of HANDOFF_STATES) assert.ok([...FSS_OPEN_STATES, ...FSS_FINAL_STATES].includes(state), state);
  assert.deepEqual(FSS_FINAL_STATES.filter(state => !HANDOFF_STATES.includes(state)), ['failed']);
  assert.deepEqual(FSS_OPEN_STATES.filter(state => !HANDOFF_STATES.includes(state)), ['queued']);
});
