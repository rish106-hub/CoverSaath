import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { assertSafeVerifyTarget, safeClientOptions, verifyUserData } from '../scripts/verify-user-data.js';

// scripts/verify-user-data.js (ADR 0015): target guard and the sealed-at-rest check. Synthetic data only.
const opts = postgresTestOptions();

test('the verify target must be a loopback database other than coversaath_dev', () => {
  assert.equal(assertSafeVerifyTarget('postgres://u@localhost:54329/knowvia_p1_check'), 'knowvia_p1_check');
  for (const bad of [undefined, '', 'not a url', 'postgres://u@db.example.test/x', 'postgres://u@localhost/coversaath_dev', 'postgres://u@localhost',
    'postgres://u@localhost/knowvia_p1_check?host=remote.example.test', 'postgres://u@localhost/knowvia_p1_check?database=coversaath_dev', 'postgres://u@localhost/knowvia_p1_check?sslmode=disable']) {
    assert.throws(() => assertSafeVerifyTarget(bad), error => error.code === 'VERIFY_TARGET_REFUSED' && !String(error.message).includes('example.test'));
  }
});

test('the client is built from the validated host, port and database, not the raw string', () => {
  assert.deepEqual(safeClientOptions('postgres://u:p%40ss@[::1]:54329/knowvia_p1_check'), { host: '::1', port: 54329, database: 'knowvia_p1_check', user: 'u', password: 'p@ss' });
});

test('verifyUserData passes on sealed values and fails on a plaintext ciphertext column, without printing values', opts, async t => {
  const { db, handle } = await freshDatabase(t);
  const client = await handle.pool.connect();
  try {
    const clean = await verifyUserData(client);
    assert.equal(clean.ok, true);
    assert.ok(clean.tables.every(item => !item.missing));
    const now = new Date().toISOString();
    const householdId = randomUUID();
    const adultId = randomUUID();
    await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', [householdId, 'Verify household', now, now]);
    await db.run("INSERT INTO adult_users (id, display_name, locale, account_status, created_at, updated_at) VALUES (?, 'Verify adult', 'en-IN', 'invited', ?, ?)", [adultId, now, now]);
    // The column CHECK already refuses plaintext; drop it in this throwaway copy to prove the script catches a bypass.
    await db.run('ALTER TABLE adult_preferences DROP CONSTRAINT adult_preferences_prefs_ciphertext_check');
    await db.run("INSERT INTO adult_preferences (adult_user_id, household_id, prefs_ciphertext, schema_version, revision, updated_at) VALUES (?, ?, 'Sentinelplain', 1, 1, ?)", [adultId, householdId, now]);
    const dirty = await verifyUserData(client);
    assert.equal(dirty.ok, false);
    assert.ok(!JSON.stringify(dirty).includes('Sentinelplain'));
    const prefs = dirty.tables.find(item => item.table === 'adult_preferences');
    assert.equal(prefs.ciphertextColumns[0].notSealed, 1);
  } finally {
    client.release();
  }
});
