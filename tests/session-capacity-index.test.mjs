// P1-3: the session capacity count compares fixed-width UTC ISO text and is served by a partial index.
// Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { AuthRepository } from '../src/backend/repositories/index.js';

const pg = postgresTestOptions();
const NOW = Date.parse('2026-10-20T09:00:00.000Z');
const iso = ms => new Date(ms).toISOString();

async function world(t, maxActiveSessions) {
  const { db } = await freshDatabase(t, { clock: () => new Date(NOW) });
  const auth = new AuthRepository(db, { clock: () => new Date(NOW), maxActiveSessions });
  await db.run(`INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at)
    VALUES ('adult-s1', 'Synthetic adult', 'en-IN', 'active', ?, ?)`, [iso(NOW), iso(NOW)]);
  let n = 0;
  const seed = ({ expiresAt, revokedAt = null }) => db.run(`INSERT INTO api_sessions
    (id, adult_user_id, token_sha256, issued_at, expires_at, revoked_at, created_at) VALUES (?, 'adult-s1', ?, ?, ?, ?, ?)`,
  [`session-seed-${n}`, String(n++).padStart(64, '0'), iso(NOW - 3_600_000), expiresAt, revokedAt, iso(NOW - 3_600_000)]);
  return { db, auth, seed };
}

test('expired, unswept sessions do not count toward capacity', pg, async t => {
  const { auth, seed } = await world(t, 1);
  await seed({ expiresAt: iso(NOW - 1) });
  await seed({ expiresAt: iso(NOW - 3_000) });
  assert.ok((await auth.issueSession({ adultUserId: 'adult-s1' })).token);
});

test('revoked sessions do not count toward capacity', pg, async t => {
  const { auth, seed } = await world(t, 1);
  await seed({ expiresAt: iso(NOW + 3_600_000), revokedAt: iso(NOW - 1000) });
  assert.ok((await auth.issueSession({ adultUserId: 'adult-s1' })).token);
});

test('a session expiring exactly now is not live; one millisecond later is', pg, async t => {
  const boundary = await world(t, 1);
  await boundary.seed({ expiresAt: iso(NOW) });
  assert.ok((await boundary.auth.issueSession({ adultUserId: 'adult-s1' })).token);
});

test('a session expiring one millisecond after now counts', pg, async t => {
  const { auth, seed } = await world(t, 1);
  await seed({ expiresAt: iso(NOW + 1) });
  await assert.rejects(auth.issueSession({ adultUserId: 'adult-s1' }), { code: 'SESSION_CAPACITY_REACHED', statusCode: 429 });
});

test('capacity limit is enforced across live sessions', pg, async t => {
  const { auth, seed } = await world(t, 2);
  await seed({ expiresAt: iso(NOW + 60_000) });
  await seed({ expiresAt: iso(NOW + 120_000) });
  await assert.rejects(auth.issueSession({ adultUserId: 'adult-s1' }), { code: 'SESSION_CAPACITY_REACHED' });
});

test('expires_at must be fixed-width UTC ISO text', pg, async t => {
  const { seed } = await world(t, 1);
  for (const bad of ['2026-10-20T09:00:00Z', 'not-a-date', '2026-10-20T14:30:00.000+05:30', '2026-10-20 09:00:00.000Z']) {
    await assert.rejects(seed({ expiresAt: bad }), { code: '23514' }, bad);
  }
});

test('the planner can serve the live-session predicate from the partial index', pg, async t => {
  const { db } = await world(t, 1);
  const plan = await db.transaction(async () => {
    await db.run('SET LOCAL enable_seqscan = off');
    return db.many('EXPLAIN SELECT count(*) AS count FROM api_sessions WHERE revoked_at IS NULL AND expires_at > ?', [iso(NOW)]);
  });
  const text = plan.map(row => Object.values(row)[0]).join('\n');
  assert.match(text, /api_sessions_live_expiry_idx/);
});
