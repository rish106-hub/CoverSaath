// probe:pooler: checks that a DATABASE_URL behind the Supabase transaction pooler (port 6543) keeps the guarantees the API
// relies on. Read-only: it runs SHOW and one empty transaction with a transaction-scoped advisory lock, and writes nothing.
// OWNER APPROVAL REQUIRED before pointing it at any hosted database. Output holds the port and setting values only, never
// the connection string. Exit code 1 if the port is not 6543 or a setting from src/backend/database/postgres/pool.js did not take effect.
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../src/backend/database/postgres/index.js';

const EXPECTED = Object.freeze({ statement_timeout: '30s', lock_timeout: '5s', idle_in_transaction_session_timeout: '30s' });

let options;
try {
  options = postgresPoolOptionsFromEnv(process.env);
} catch (error) {
  process.stderr.write(`Database configuration is invalid (${error.code ?? 'UNKNOWN'}).\n`);
  process.exit(1);
}

let port;
try {
  port = new URL(options.connectionString).port || '5432';
} catch {
  // Fixed message only: the parse error would repeat the connection string, password included.
  process.stderr.write('DATABASE_URL must be a postgres:// or postgresql:// URL.\n');
  process.exit(1);
}
const pool = createPostgresPool({ ...options, max: 1 });
const report = { port, settings: {}, advisoryTransactionLock: false, ok: false };
try {
  for (const name of Object.keys(EXPECTED)) {
    const { rows } = await pool.query(`SHOW ${name}`);
    report.settings[name] = { value: rows[0][name], expected: EXPECTED[name], applied: rows[0][name] === EXPECTED[name] };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(7283541900099::bigint)');
    await client.query('COMMIT');
    report.advisoryTransactionLock = true;
  } catch (error) {
    report.error = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.release();
  }
  report.ok = port === '6543' && report.advisoryTransactionLock && Object.values(report.settings).every(setting => setting.applied);
} catch (error) {
  report.error = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
} finally {
  await pool.end();
}
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
