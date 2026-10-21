import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgresDatabaseError } from './errors.js';

export const postgresMigrationDirectory = fileURLToPath(new URL('./migrations', import.meta.url));
export const postgresTestMigrationRoot = fileURLToPath(new URL('../../../../.local/postgres-test-migrations/', import.meta.url));

// One fixed advisory-lock key for the whole migration run (a session lock, held on one connection).
const MIGRATION_LOCK_KEY = '7283541900012';

export function loadPostgresMigrations(directory = postgresMigrationDirectory) {
  const root = realpathSync(resolve(directory));
  const productionRoot = realpathSync(postgresMigrationDirectory);
  const testRoot = resolve(postgresTestMigrationRoot);
  const insideProductionRoot = root === productionRoot || root.startsWith(productionRoot + sep);
  const insideTestRoot = root.startsWith(testRoot + sep);
  if (!insideProductionRoot && !insideTestRoot) {
    throw new PostgresDatabaseError('POSTGRES_MIGRATION_PATH_NOT_ALLOWED', 'The migration directory is not allowed.');
  }
  // Restrict entries to regular files with fixed migration names, then resolve symlinks before reading.
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^\d{3}_[a-z0-9_]+\.sql$/.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(entry => {
      const migrationPath = realpathSync(resolve(root, entry.name));
      const offset = relative(root, migrationPath);
      if (!offset || offset.startsWith('..') || isAbsolute(offset) || offset.includes('/') || offset.includes('\\')) {
        throw new PostgresDatabaseError('POSTGRES_MIGRATION_PATH_NOT_ALLOWED', 'A migration file path is not allowed.');
      }
      return { version: entry.name, sql: readFileSync(migrationPath, 'utf8') };
    });
}

export function postgresMigrationFiles(directory = postgresMigrationDirectory) {
  return loadPostgresMigrations(directory).map(migration => migration.version);
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
    // Migration SQL is loaded only from a fixed, validated migration root. Parameter binding cannot
    // represent PostgreSQL DDL. The checksum makes later edits fail closed.
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
  // The directory is supplied by code (tests use scratch directories), never by a request.
  // Filenames must match NNN_name.sql and each resolved path must stay inside the directory.
  // Errors never include filesystem paths.
  const files = loadPostgresMigrations(directory);
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
