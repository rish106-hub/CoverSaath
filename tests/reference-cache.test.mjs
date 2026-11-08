import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { ReferenceCacheRepository, REFERENCE_CACHE_TTL_MS, isReferenceFresh } from '../src/backend/repositories/reference-cache-repository.js';

// D3: public reference-data cache and refresh lease (migration 033). Synthetic keys and bodies only.
const body = { insurer: 'example-insurer', products: [{ uin: 'EXAMPLE-UIN-0001' }] };
const sig = 'sig-synthetic-0001';
const ownerA = 'owner-aaaaaaaaaaaaaaaa';
const ownerB = 'owner-bbbbbbbbbbbbbbbb';

test('the 24 hour TTL helper and pure freshness check', () => {
  assert.equal(REFERENCE_CACHE_TTL_MS, 86_400_000);
  const now = Date.now();
  assert.equal(isReferenceFresh({ status: 'fresh', staleAfter: new Date(now + 1000) }, now), true);
  assert.equal(isReferenceFresh({ status: 'fresh', staleAfter: new Date(now - 1) }, now), false);
  assert.equal(isReferenceFresh({ status: 'stale', staleAfter: new Date(now + 1000) }, now), false);
  assert.equal(isReferenceFresh(null, now), false);
});

test('reference_cache has no household, case, member or consent column and holds only the reviewed columns', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  for (const table of ['reference_cache', 'reference_cache_leases']) {
    const columns = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ? ORDER BY ordinal_position", [table])).map(row => row.column_name);
    assert.ok(columns.length > 0);
    assert.deepEqual(columns.filter(name => /household|case|member|adult|consent|user|policy_number|document/.test(name)), [], `${table} must not hold household data`);
    const foreign = await db.one("SELECT count(*)::int AS n FROM pg_constraint WHERE conrelid = ?::regclass AND contype = 'f'", [`public.${table}`]);
    assert.equal(foreign.n, 0, `${table} must not reference household tables`);
  }
  const cache = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'reference_cache' ORDER BY ordinal_position")).map(row => row.column_name);
  assert.deepEqual(cache, ['key', 'etag', 'body', 'signature', 'fetched_at', 'stale_after', 'status']);
});

test('RLS is on and the Data API roles hold nothing on the new tables', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const rows = await db.many("SELECT relname, relrowsecurity FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname IN ('reference_cache', 'reference_cache_leases') ORDER BY relname");
  assert.deepEqual(rows.map(row => [row.relname, row.relrowsecurity]), [['reference_cache', true], ['reference_cache_leases', true]]);
});

test('put inserts, get returns fresh with a 24 hour window, put again replaces in place', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new ReferenceCacheRepository(db);
  assert.equal(await repo.get('insurers/example'), null);
  const first = await repo.put({ key: 'insurers/example', etag: '"v1"', body, signature: sig });
  assert.equal(first.status, 'fresh');
  assert.equal(first.fresh, true);
  const window = new Date(first.staleAfter).getTime() - new Date(first.fetchedAt).getTime();
  assert.ok(Math.abs(window - REFERENCE_CACHE_TTL_MS) < 5000);
  const read = await repo.get('insurers/example');
  assert.deepEqual(read.body, body);
  assert.equal(read.etag, '"v1"');
  assert.equal(read.signature, sig);
  assert.equal(read.fresh, true);
  await repo.put({ key: 'insurers/example', etag: '"v2"', body: { ...body, rev: 2 }, signature: 'sig-synthetic-0002' });
  const after = await repo.get('insurers/example');
  assert.equal(after.etag, '"v2"');
  assert.equal(after.body.rev, 2);
  assert.equal(Number((await db.one("SELECT count(*) AS n FROM reference_cache")).n), 1);
});

test('markStale keeps the body, marks it not fresh, and put makes it fresh again', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new ReferenceCacheRepository(db);
  await repo.put({ key: 'products/p1', body, signature: sig });
  assert.equal(await repo.markStale('products/p1'), true);
  assert.equal(await repo.markStale('products/p1'), false);
  assert.equal(await repo.markStale('products/missing'), false);
  const stale = await repo.get('products/p1');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.fresh, false);
  assert.deepEqual(stale.body, body);
  await repo.put({ key: 'products/p1', body, signature: sig });
  assert.equal((await repo.get('products/p1')).fresh, true);
});

test('an entry past stale_after reads as not fresh and markExpiredStale flips only expired rows', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new ReferenceCacheRepository(db);
  await repo.put({ key: 'a/old', body, signature: sig, ttlMs: 1 });
  await repo.put({ key: 'a/new', body, signature: sig });
  await db.run("UPDATE reference_cache SET stale_after = now() - interval '1 second' WHERE key = 'a/old'");
  assert.equal((await repo.get('a/old')).fresh, false);
  assert.equal(await repo.markExpiredStale(), 1);
  assert.equal((await repo.get('a/old')).status, 'stale');
  assert.equal((await repo.get('a/new')).status, 'fresh');
  assert.equal(await repo.remove('a/old'), true);
  assert.equal(await repo.get('a/old'), null);
});

test('keys and values are validated in code and by the database', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new ReferenceCacheRepository(db);
  for (const key of ['', 'Has Space', 'asha@example.test', 'UPPER', 'x'.repeat(201), null]) {
    await assert.rejects(() => repo.put({ key, body, signature: sig }), { code: 'REFERENCE_CACHE_KEY_INVALID' });
    await assert.rejects(() => repo.get(key), { code: 'REFERENCE_CACHE_KEY_INVALID' });
  }
  await assert.rejects(() => repo.put({ key: 'ok/key', body: 'text', signature: sig }), { code: 'REFERENCE_CACHE_BODY_INVALID' });
  await assert.rejects(() => repo.put({ key: 'ok/key', body, signature: '' }), { code: 'REFERENCE_CACHE_SIGNATURE_REQUIRED' });
  await assertDbError(db.run("INSERT INTO reference_cache (key, body, signature, stale_after) VALUES ('Bad Key', '{}', 's', now())"), { sqlstate: '23514' });
  await assertDbError(db.run("INSERT INTO reference_cache (key, body, signature, stale_after, status) VALUES ('ok', '{}', 's', now(), 'weird')"), { sqlstate: '23514' });
});

test('lease: one holder at a time, only the owner renews or releases, expiry allows takeover', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new ReferenceCacheRepository(db);
  assert.equal(await repo.acquireLease({ key: 'insurers/example', owner: ownerA }), true);
  assert.equal(await repo.acquireLease({ key: 'insurers/example', owner: ownerB }), false);
  assert.equal(await repo.renewLease({ key: 'insurers/example', owner: ownerB }), false);
  assert.equal(await repo.releaseLease({ key: 'insurers/example', owner: ownerB }), false);
  assert.equal(await repo.renewLease({ key: 'insurers/example', owner: ownerA }), true);
  assert.equal(await repo.acquireLease({ key: 'other/key', owner: ownerB }), true, 'leases are per key');
  await db.run("UPDATE reference_cache_leases SET expires_at = now() - interval '1 second' WHERE key = 'insurers/example'");
  assert.equal(await repo.renewLease({ key: 'insurers/example', owner: ownerB }), false);
  assert.equal(await repo.acquireLease({ key: 'insurers/example', owner: ownerB }), true, 'expired lease is taken over');
  assert.equal(await repo.renewLease({ key: 'insurers/example', owner: ownerA }), false, 'the old holder lost it');
  assert.equal(await repo.releaseLease({ key: 'insurers/example', owner: ownerB }), true);
  assert.equal(await repo.acquireLease({ key: 'insurers/example', owner: ownerA }), true);
});

test('concurrent acquire grants exactly one holder and purge removes only expired leases', postgresTestOptions(), async t => {
  const { db } = await freshDatabase(t);
  const repo = new ReferenceCacheRepository(db);
  const owners = Array.from({ length: 8 }, (_, i) => `owner-concurrent-${String(i).padStart(4, '0')}`);
  const results = await Promise.all(owners.map(owner => repo.acquireLease({ key: 'race/key', owner })));
  assert.equal(results.filter(Boolean).length, 1);
  await repo.acquireLease({ key: 'dead/key', owner: ownerA, leaseMs: 1 });
  await db.run("UPDATE reference_cache_leases SET expires_at = now() - interval '1 second' WHERE key = 'dead/key'");
  assert.equal(await repo.purgeExpiredLeases(), 1);
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM reference_cache_leases')).n), 1);
  await assertDbError(db.run("INSERT INTO reference_cache_leases (key, owner, expires_at) VALUES ('k', 'short', now())"), { sqlstate: '23514' });
});
