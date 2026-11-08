// Reference-data import (ADR 0021). Loads a local JSON file of public reference responses into the reference cache so the
// ReferenceDataPort can serve them with no second service. Usage:
//   node --env-file-if-exists=.env.local scripts/reference-import.mjs --file <path> [--ttl-days N] [--dry-run] [--allow-owner-approved] [--yes]
// --dry-run validates the file and prints counts; it needs no database. Without it, DATABASE_URL is required.
// A write to a non-loopback database host needs --yes; the host name (never user, password or query) is printed first.
// Prints counts only, never a key, name or value. Synthetic data only unless the owner has recorded source rights
// (data_class "owner_approved" plus --allow-owner-approved). FOR LEGAL REVIEW before any non-synthetic import.
import { readFile, stat } from 'node:fs/promises';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { ReferenceCacheRepository } from '../src/backend/repositories/index.js';
import { DEFAULT_IMPORT_TTL_DAYS, importReferenceData } from '../src/backend/services/reference-data-import.js';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const args = process.argv.slice(2);
const options = { file: null, ttlDays: DEFAULT_IMPORT_TTL_DAYS, dryRun: false, allowOwnerApproved: false, yes: false };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--file' || arg === '--ttl-days') {
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) {
      process.stderr.write(`Option ${arg} needs a value.\n`);
      process.exit(2);
    }
    if (arg === '--file') options.file = value;
    else options.ttlDays = Number(value);
  } else if (arg === '--yes') options.yes = true;
  else if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--allow-owner-approved') options.allowOwnerApproved = true;
  else {
    process.stderr.write('Unknown option. Use --file, --ttl-days, --dry-run, --allow-owner-approved and --yes.\n');
    process.exit(2);
  }
}
if (!options.file) {
  process.stderr.write('Missing --file <path>.\n');
  process.exit(2);
}

let pool;
try {
  let document;
  try {
    if ((await stat(options.file)).size > MAX_FILE_BYTES) throw new Error('too large');
    document = JSON.parse(await readFile(options.file, 'utf8'));
  } catch {
    throw Object.assign(new Error('Import file is not readable JSON within 8 MB.'), { code: 'REFERENCE_IMPORT_UNREADABLE' });
  }
  let database = null;
  let repository = null;
  if (!options.dryRun) {
    let host = null;
    try { host = new URL(process.env.DATABASE_URL ?? '').hostname || null; } catch { host = null; }
    process.stderr.write(`Target database host: ${host ?? 'unknown'}\n`);
    if (!LOOPBACK_HOSTS.has(host) && !options.yes) {
      throw Object.assign(new Error('Non-loopback database host needs --yes.'), { code: 'REFERENCE_IMPORT_CONFIRM_REQUIRED' });
    }
    pool = createPostgresPool(postgresPoolOptionsFromEnv(process.env));
    database = createDatabase(pool);
    repository = new ReferenceCacheRepository(database);
  }
  const summary = await importReferenceData({ database, repository, document, ...options });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  // Import errors carry an entry index only; other errors print their code only.
  const detail = code === 'REFERENCE_IMPORT_INVALID' ? `: ${error.message}` : '';
  process.stderr.write(`Reference import failed (${code})${detail}\n`);
  process.exitCode = 1;
} finally {
  await pool?.end();
}
