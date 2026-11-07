// Owner verification after the S1 cutover (docs/runbooks/db-roles.md). Read-only: forbidden statements run in
// transactions that are always rolled back. Prints check names, pass/fail and SQLSTATE codes only; never a URL,
// password or driver message. Exit code 1 if any check fails or the old credential is not proven rejected.
//
//   RUNTIME_DATABASE_URL    the new knowvia_runtime URL (required)
//   MIGRATION_DATABASE_URL  the new knowvia_migrator URL (optional)
//   OLD_DATABASE_URL        the URL with the exposed/rotated credential; it must be refused (optional but advised)
//   DATABASE_SSL_CA_PATH    PEM CA for the hosted database (optional)
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';
import { probeCredentialRejected, probeMigratorRole, probeRuntimeRole } from './lib/db-role-probe.mjs';

// One path builds the pool options for every URL (including the validated, size-capped DATABASE_SSL_CA_PATH read),
// so this script holds no file read and no env-controlled branch of its own. Output names the variable and a code only.
function optionsFor(name) {
  try {
    return postgresPoolOptionsFromEnv({ DATABASE_URL: process.env[name], DATABASE_SSL_CA_PATH: process.env.DATABASE_SSL_CA_PATH });
  } catch (error) {
    process.stderr.write(error?.code === 'DATABASE_URL_REQUIRED' ? `${name} is required.\n` : `${name} options could not be built (${typeof error?.code === 'string' ? error.code : 'UNKNOWN'}).\n`);
    process.exit(1);
  }
}
const present = name => typeof process.env[name] === 'string' && process.env[name].trim() !== '';

const report = [];
let failed = false;
const add = (scope, items) => {
  for (const item of items) {
    report.push({ scope, ...item });
    if (!item.ok) failed = true;
  }
};

async function withPool(name, work) {
  const pool = createPostgresPool({ ...optionsFor(name), max: 2, applicationName: 'coversaath-verify-roles' });
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
  const outcome = await probeCredentialRejected(optionsFor('OLD_DATABASE_URL'));
  add('old_credential', [{ check: 'old_credential_rejected', ok: outcome.result === 'rejected', detail: outcome }]);
} else {
  report.push({ scope: 'old_credential', check: 'old_credential_rejected', ok: false, detail: { result: 'not_checked' } });
  failed = true;
}

process.stdout.write(`${JSON.stringify({ passed: !failed, checks: report }, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
