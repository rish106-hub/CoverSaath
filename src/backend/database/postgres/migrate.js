import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabaseError } from './errors.js';

export const postgresMigrationDirectory = fileURLToPath(new URL('./migrations', import.meta.url));

// One fixed advisory-lock key for the whole migration run (a session lock, held on one connection).
const MIGRATION_LOCK_KEY = '7283541900012';

export function postgresMigrationFiles(directory = postgresMigrationDirectory) {
  return readdirSync(directory)
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

export function migrationChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

async function applyMigration(client, version, sql) {
  const checksum = migrationChecksum(sql);
  await client.query('BEGIN');
  try {
    const existing = await client.query('SELECT checksum FROM schema_migrations WHERE version = $1', [version]);
    if (existing.rowCount > 0) {
      if (existing.rows[0].checksum !== checksum) {
        throw new PostgresDatabaseError('POSTGRES_MIGRATION_CHECKSUM_CHANGED', `Applied migration changed: ${version}`);
      }
      await client.query('COMMIT');
      return false;
    }
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version, checksum, applied_at) VALUES ($1, $2, $3)',
      [version, checksum, new Date().toISOString()],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof PostgresDatabaseError) throw error;
    throw new PostgresDatabaseError('POSTGRES_MIGRATION_FAILED', `Migration failed: ${version}`, { cause: error });
  }
}

// Applies every pending migration file, each in its own transaction, under one session advisory
// lock so concurrent runners apply each file exactly once. Returns the versions applied by this run.
// The pool's statement and lock timeouts apply to migration statements. Only the advisory-lock wait
// disables lock_timeout on the checked-out connection; it is restored as soon as the lock is held.
// The wait is still bounded by the pool's statement_timeout.
export async function runPostgresMigrations(pool, { directory = postgresMigrationDirectory } = {}) {
  const files = postgresMigrationFiles(directory).map(version => ({
    version,
    sql: readFileSync(resolve(directory, version), 'utf8'),
  }));
  let client;
  try {
    client = await pool.connect();
  } catch (error) {
    throw new PostgresDatabaseError('POSTGRES_MIGRATION_FAILED', 'PostgreSQL migration runner could not connect.', { cause: error });
  }
  let destroyClient = false;
  let lockHeld = false;
  let previousLockTimeout;
  try {
    previousLockTimeout = (await client.query("SELECT current_setting('lock_timeout') AS value")).rows[0].value;
    await client.query("SELECT set_config('lock_timeout', '0', false)");
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    lockHeld = true;
    // lock_timeout 0 covers only the advisory-lock wait. Migration statements run under the pool's
    // lock_timeout so DDL never queues indefinitely behind a long transaction.
    await client.query("SELECT set_config('lock_timeout', $1, false)", [previousLockTimeout]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at text NOT NULL
    )`);
    const applied = [];
    for (const { version, sql } of files) {
      if (await applyMigration(client, version, sql)) applied.push(version);
    }
    return applied;
  } catch (error) {
    if (error instanceof PostgresDatabaseError) throw error;
    throw new PostgresDatabaseError('POSTGRES_MIGRATION_FAILED', 'PostgreSQL migration runner failed.', { cause: error });
  } finally {
    if (lockHeld) {
      try {
        const unlocked = await client.query('SELECT pg_advisory_unlock($1::bigint) AS unlocked', [MIGRATION_LOCK_KEY]);
        if (unlocked.rows[0]?.unlocked !== true) destroyClient = true;
      } catch {
        destroyClient = true;
      }
    }
    if (!destroyClient && previousLockTimeout !== undefined) {
      try {
        await client.query("SELECT set_config('lock_timeout', $1, false)", [previousLockTimeout]);
      } catch {
        destroyClient = true;
      }
    }
    client.release(destroyClient);
  }
}
