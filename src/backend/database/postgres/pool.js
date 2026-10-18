import pg from 'pg';
import { PostgresDatabaseError } from './errors.js';

const DEFAULTS = Object.freeze({
  max: 10,
  statementTimeoutMs: 30_000,
  lockTimeoutMs: 5_000,
  idleInTransactionTimeoutMs: 30_000,
  connectionTimeoutMs: 10_000,
  applicationName: 'cover_saath',
});

function requireInteger(name, value, { min }) {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new PostgresDatabaseError('DATABASE_POOL_OPTION_INVALID', `Pool option ${name} must be an integer of at least ${min}.`);
  }
  return value;
}

// The session timeouts and the application name always come from the pool options, never from the
// connection string, so every pooled connection carries them (ADR 0004, D8).
function sanitizedConnectionString(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new PostgresDatabaseError('DATABASE_URL_INVALID', 'DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new PostgresDatabaseError('DATABASE_URL_INVALID', 'DATABASE_URL must be a postgres:// or postgresql:// URL.');
  }
  url.searchParams.delete('options');
  url.searchParams.delete('application_name');
  url.searchParams.delete('statement_timeout');
  url.searchParams.delete('lock_timeout');
  url.searchParams.delete('idle_in_transaction_session_timeout');
  url.searchParams.delete('replication');
  return url.toString();
}

// Builds the pool. It does not connect, never logs the URL and is not yet wired into the runtime.
// `onError` receives idle-client errors (a dropped connection). The default ignores them so an idle
// failure cannot crash the process; the next query on a fresh connection surfaces the problem.
export function createPostgresPool({
  connectionString,
  max = DEFAULTS.max,
  statementTimeoutMs = DEFAULTS.statementTimeoutMs,
  lockTimeoutMs = DEFAULTS.lockTimeoutMs,
  idleInTransactionTimeoutMs = DEFAULTS.idleInTransactionTimeoutMs,
  connectionTimeoutMs = DEFAULTS.connectionTimeoutMs,
  applicationName = DEFAULTS.applicationName,
  onError = () => {},
} = {}) {
  if (typeof connectionString !== 'string' || connectionString.trim() === '') {
    throw new PostgresDatabaseError('DATABASE_URL_REQUIRED', 'DATABASE_URL is required.');
  }
  requireInteger('max', max, { min: 1 });
  requireInteger('statementTimeoutMs', statementTimeoutMs, { min: 1 });
  requireInteger('lockTimeoutMs', lockTimeoutMs, { min: 1 });
  requireInteger('idleInTransactionTimeoutMs', idleInTransactionTimeoutMs, { min: 1 });
  requireInteger('connectionTimeoutMs', connectionTimeoutMs, { min: 1 });
  const name = String(applicationName).replace(/[^\x20-\x7e]/g, '?').slice(0, 63);
  if (name === '') {
    throw new PostgresDatabaseError('DATABASE_POOL_OPTION_INVALID', 'Pool option applicationName must not be empty.');
  }
  const pool = new pg.Pool({
    connectionString: sanitizedConnectionString(connectionString.trim()),
    max,
    application_name: name,
    connectionTimeoutMillis: connectionTimeoutMs,
    options: [
      `-c statement_timeout=${statementTimeoutMs}`,
      `-c lock_timeout=${lockTimeoutMs}`,
      `-c idle_in_transaction_session_timeout=${idleInTransactionTimeoutMs}`,
    ].join(' '),
  });
  pool.on('error', onError);
  return pool;
}
