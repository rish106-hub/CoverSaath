// Owner verification after the S1 cutover (docs/runbooks/db-roles.md). Read-only: forbidden statements run in
// transactions that are always rolled back. Prints check names, pass/fail and SQLSTATE codes only; never a URL,
// password or driver message. Exit code 1 if any check fails or the old credential is not proven rejected.
//
//   RUNTIME_DATABASE_URL    the new knowvia_runtime URL (required)
//   MIGRATION_DATABASE_URL  the new knowvia_migrator URL (optional)
//   OLD_DATABASE_URL        the URL with the exposed/rotated credential; it must be refused (optional but advised)
//   DATABASE_SSL_CA_PATH    PEM CA for the hosted database (optional)
import { readFileSync } from 'node:fs';
import { createPostgresPool } from '../src/backend/database/postgres/index.js';
import { probeCredentialRejected, probeMigratorRole, probeRuntimeRole } from './lib/db-role-probe.mjs';

const caPath = process.env.DATABASE_SSL_CA_PATH?.trim();
let sslCa;
if (caPath) {
  try { sslCa = readFileSync(caPath, 'utf8'); } catch { process.stderr.write('DATABASE_SSL_CA_PATH could not be read.\n'); process.exit(1); }
}
const optionsFor = connectionString => ({ connectionString, ...(sslCa ? { sslCa } : {}) });
const present = name => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

if (!present('RUNTIME_DATABASE_URL')) {
  process.stderr.write('RUNTIME_DATABASE_URL is required.\n');
  process.exit(1);
}

const report = [];
let failed = false;
const add = (scope, items) => {
  for (const item of items) {
    report.push({ scope, ...item });
    if (!item.ok) failed = true;
  }
};

async function withPool(name, work) {
  const pool = createPostgresPool({ ...optionsFor(process.env[name]), max: 2, applicationName: 'coversaath-verify-roles' });
  try {
    return await work(pool);
  } finally {
    await pool.end().catch(() => {});
  }
}

try {
  add('runtime', await withPool('RUNTIME_DATABASE_URL', probeRuntimeRole));
  if (present('MIGRATION_DATABASE_URL')) add('migrator', await withPool('MIGRATION_DATABASE_URL', probeMigratorRole));
} catch (error) {
  process.stderr.write(`Verification could not run (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
  process.exit(1);
}
if (present('OLD_DATABASE_URL')) {
  const outcome = await probeCredentialRejected(optionsFor(process.env.OLD_DATABASE_URL));
  add('old_credential', [{ check: 'old_credential_rejected', ok: outcome.result === 'rejected', detail: outcome }]);
} else {
  report.push({ scope: 'old_credential', check: 'old_credential_rejected', ok: false, detail: { result: 'not_checked' } });
  failed = true;
}

process.stdout.write(`${JSON.stringify({ passed: !failed, checks: report }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
