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
    throw new PostgresDatabaseError('POSTGRES_MIGRATION_FAILED', `Migration failed: ${version}: ${error.message}`, { cause: error });
  }
}

// Applies every pending migration file, each in its own transaction, under one session advisory
// lock so concurrent runners apply each file exactly once. Returns the versions applied by this run.
// The pool's statement and lock timeouts apply: use a pool configured for migrations when a file
// needs longer.
export async function runPostgresMigrations(pool, { directory = postgresMigrationDirectory } = {}) {
  const files = postgresMigrationFiles(directory).map(version => ({
    version,
    sql: readFileSync(resolve(directory, version), 'utf8'),
  }));
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [MIGRATION_LOCK_KEY]);
    try {
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
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [MIGRATION_LOCK_KEY]).catch(() => {});
    }
  } finally {
    client.release();
  }
}
