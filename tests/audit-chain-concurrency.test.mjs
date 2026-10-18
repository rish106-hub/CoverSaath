// S3.2 WP0: the audit hash chain stays linear under concurrent appends on PostgreSQL (design
// section 3: AuditRepository.append takes the household advisory lock). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../src/backend/database/database.js';
import { householdLock } from '../src/backend/database/postgres/locks.js';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const at = '2026-10-18T09:00:00.000Z';
const pgOptions = postgresTestOptions();

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}

async function seedHouseholds(db, ids) {
  for (const id of ids) {
    await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [id, 'Synthetic household', at, at]);
  }
}

// Every event links to the one before it in id order and recomputes to its stored hash.
async function assertLinearChain(db, householdId, expectedLength) {
  const rows = householdId === null
    ? await db.many('SELECT * FROM audit_events WHERE household_id IS NULL ORDER BY id')
    : await db.many('SELECT * FROM audit_events WHERE household_id = ? ORDER BY id', [householdId]);
  assert.equal(rows.length, expectedLength, `${householdId} chain length`);
  let previous = null;
  for (const row of rows) {
    assert.equal(typeof row.id, 'number');
    assert.equal(row.previous_event_hash, previous, `${householdId} event ${row.id} must link to the previous event`);
    const material = JSON.stringify(stable({
      householdId: row.household_id, caseId: row.case_id, actorType: row.actor_type, actorId: row.actor_id,
      action: row.action, resourceType: row.resource_type, resourceId: row.resource_id,
      payload: JSON.parse(row.event_payload_json), previous, occurredAt: row.occurred_at,
    }));
    assert.equal(row.event_hash, createHash('sha256').update(material).digest('hex'));
    previous = row.event_hash;
  }
  const links = rows.map(row => row.previous_event_hash);
  assert.equal(new Set(links).size, links.length, `${householdId} chain must not fork`);
}

const event = (householdId, index) => ({
  householdId, action: 'synthetic.event', resourceType: 'synthetic', resourceId: `resource-${index}`, payload: { index },
});

test('50 concurrent appends to one household form one linear chain', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedHouseholds(db, ['h-chain']);
  const audit = new AuditRepository(db, { clock: () => new Date(at) });
  const results = await Promise.all(Array.from({ length: 50 }, (_, index) => audit.append(event('h-chain', index))));
  assert.equal(new Set(results.map(result => result.id)).size, 50);
  for (const result of results) {
    assert.equal(typeof result.id, 'number');
    assert.match(result.eventHash, /^[0-9a-f]{64}$/);
  }
  await assertLinearChain(db, 'h-chain', 50);
});

test('concurrent appends across households and the NULL chain keep each chain linear', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedHouseholds(db, ['h-a', 'h-b']);
  const audit = new AuditRepository(db);
  const households = ['h-a', 'h-b', null];
  await Promise.all(Array.from({ length: 60 }, (_, index) => audit.append(event(households[index % 3], index))));
  for (const householdId of households) await assertLinearChain(db, householdId, 20);
});

test('appends inside caller transactions join them and roll back with them', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  await seedHouseholds(db, ['h-tx']);
  const audit = new AuditRepository(db);
  await audit.append(event('h-tx', 0));
  await assert.rejects(db.transaction(async () => {
    await audit.append(event('h-tx', 1));
    throw new Error('caller failure');
  }), /caller failure/);
  await assertLinearChain(db, 'h-tx', 1);

  // A caller that takes the household lock first (lock order) can append without deadlocking, and
  // concurrent callers interleave without forking.
  await Promise.all(Array.from({ length: 10 }, (_, index) => db.transaction(async () => {
    await db.run('UPDATE households SET updated_at = ? WHERE id = ?', [at, 'h-tx']);
    await audit.append(event('h-tx', 100 + index));
    await audit.append(event('h-tx', 200 + index));
  }, { locks: [householdLock('h-tx')] })));
  await assertLinearChain(db, 'h-tx', 21);
  assert.equal((await audit.listForCase('missing-case')).length, 0);
});

test('a PostgreSQL append with missing fields rejects instead of throwing synchronously', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const audit = new AuditRepository(db);
  const pending = audit.append({ action: 'x', resourceType: 'y' });
  assert.ok(pending instanceof Promise);
  await assert.rejects(pending, /required/);
});

test('the node:sqlite runtime keeps the synchronous audit chain', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  runMigrations(database);
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('h-sqlite', 'Synthetic', at, at);
  const audit = new AuditRepository(database, { clock: () => new Date(at) });
  const first = audit.append(event('h-sqlite', 0));
  const second = audit.append(event('h-sqlite', 1));
  const unscoped = audit.append(event(null, 2));
  assert.equal(typeof first.id, 'number');
  assert.equal(first.previousEventHash, null);
  assert.equal(second.previousEventHash, first.eventHash);
  assert.equal(unscoped.previousEventHash, null);
  assert.throws(() => audit.append({ action: 'x' }), /required/);
  assert.deepEqual(audit.listForCase('missing-case'), []);
  database.close();
});
