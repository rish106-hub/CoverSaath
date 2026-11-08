// Reference-data import (ADR 0021). Loads a local JSON file of public reference responses into the reference cache so the
// ReferenceDataPort can serve them with no second service. Usage:
//   node --env-file-if-exists=.env.local scripts/reference-import.mjs --file <path> [--ttl-days N] [--dry-run] [--allow-owner-approved]
// --dry-run validates the file and prints counts; it needs no database. Without it, DATABASE_URL is required.
// Prints counts only, never a key, name or value. Synthetic data only unless the owner has recorded source rights
// (data_class "owner_approved" plus --allow-owner-approved). FOR LEGAL REVIEW before any non-synthetic import.
import { readFile } from 'node:fs/promises';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { createDatabase } from '../src/backend/database/postgres/db.js';
import { ReferenceCacheRepository } from '../src/backend/repositories/index.js';
import { DEFAULT_IMPORT_TTL_DAYS, importReferenceData } from '../src/backend/services/reference-data-import.js';

const args = process.argv.slice(2);
const options = { file: null, ttlDays: DEFAULT_IMPORT_TTL_DAYS, dryRun: false, allowOwnerApproved: false };
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--file') options.file = args[++index] ?? null;
  else if (arg === '--ttl-days') options.ttlDays = Number(args[++index]);
  else if (arg === '--dry-run') options.dryRun = true;
  else if (arg === '--allow-owner-approved') options.allowOwnerApproved = true;
  else {
    process.stderr.write('Unknown option. Use --file, --ttl-days, --dry-run and --allow-owner-approved.\n');
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
  try { document = JSON.parse(await readFile(options.file, 'utf8')); } catch {
    throw Object.assign(new Error('Import file is not readable JSON.'), { code: 'REFERENCE_IMPORT_UNREADABLE' });
  }
  let database = null;
  let repository = null;
  if (!options.dryRun) {
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
