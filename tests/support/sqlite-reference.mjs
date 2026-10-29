// Test-only SQLite reference. The SQLite runtime left src/ in S3.2 WP4; the parity tests still build the final
// SQLite schema from the frozen SQLite migration files (deleted in S3.3) to prove the PostgreSQL schema matches it.
// Never import this module from src/ (scripts/check-architecture.mjs bans node:sqlite there).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export {
  criticalIndexes, criticalTriggers, expectedTables, expectedViews, requiredColumns,
} from '../../src/backend/database/postgres/schema-expectations.js';

const migrationDirectory = fileURLToPath(new URL('../../src/backend/database/migrations', import.meta.url));
const legacyMigrationChecksums = Object.freeze({
  '002_integrity_and_provenance.sql': new Set(['afdfdcf9c4f6425bafe5bd2d3e0d5404bdf6378bdf2b172a74badd27af391110']),
});

function digest(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

function migrationFiles(directory) {
  return readdirSync(directory)
    .filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}

export function runMigrations(database, { directory = migrationDirectory } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);
  const applied = database.prepare('SELECT checksum FROM schema_migrations WHERE version = ?');
  const record = database.prepare('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)');
  const refreshChecksum = database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?');
  const completed = [];

  for (const version of migrationFiles(directory)) {
    const sql = readFileSync(resolve(directory, version), 'utf8');
    const checksum = digest(sql);
    database.exec('BEGIN IMMEDIATE');
    try {
      const existing = applied.get(version);
      if (existing) {
        if (existing.checksum !== checksum) {
          if (!legacyMigrationChecksums[version]?.has(existing.checksum)) throw new Error(`Applied migration changed: ${version}`);
          refreshChecksum.run(checksum, version);
        }
        database.exec('COMMIT');
        continue;
      }
      database.exec(sql);
      record.run(version, checksum, new Date().toISOString());
      database.exec('COMMIT');
      completed.push(version);
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Migration failed: ${version}: ${error.message}`, { cause: error });
    }
  }
  return completed;
}

// In-memory SQLite database with every frozen SQLite migration applied.
export function openSqliteReference() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  runMigrations(database);
  return database;
}
