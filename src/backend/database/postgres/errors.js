// Coded errors for the PostgreSQL layer. The code is a stable UPPER_SNAKE identifier and the
// message is client-safe: it never contains a connection string, SQL text or driver output.
import pg from 'pg';

export class PostgresDatabaseError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'PostgresDatabaseError';
    this.code = code;
  }
}

// Errors raised while the database interface (db.js) talked to the server. Connection failures
// carry no SQLSTATE, so classification only treats them as database errors when db.js saw them;
// an ECONNREFUSED from another integration is not a database outage.
const fromDatabaseCall = new WeakSet();

export function markDatabaseError(error) {
  if (error !== null && typeof error === 'object') fromDatabaseCall.add(error);
  return error;
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

// Decision 2: server conditions are 503, not client errors. 40001 and 40P01 reach here only after
// the transaction retries are spent.
const TRANSIENT_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '55P03', // lock_not_available (lock_timeout)
  '57014', // query_canceled (statement_timeout)
  '57P01', '57P02', '57P03', // admin_shutdown, crash_shutdown, cannot_connect_now
  '25P03', // idle_in_transaction_session_timeout: the server closed the session
]);
const TRANSIENT_CLASSES = new Set(['08', '53']); // connection_exception, insufficient_resources

const CONNECTION_LOSS_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN',
]);
const CONNECTION_LOSS_MESSAGES = [
  /^Connection terminated/,
  /^timeout exceeded when trying to connect$/,
  /^Client has encountered a connection error and is not queryable$/,
  /^Client was closed and is not queryable$/,
];

const MESSAGES = Object.freeze({
  BACKEND_REQUEST_FAILED: 'The request could not be completed.',
  DATABASE_UNAVAILABLE: 'The database is temporarily unavailable. Try again later.',
});

function classified(code, statusCode, { sqlstate = null, retryable = false } = {}) {
  const error = new PostgresDatabaseError(code, MESSAGES[code]);
  error.statusCode = statusCode;
  error.retryable = retryable;
  error.sqlstate = sqlstate;
  return error;
}

function sqlstateOf(error) {
  if (error instanceof pg.DatabaseError) return SQLSTATE.test(error.code ?? '') ? error.code : 'XX000';
  if (fromDatabaseCall.has(error) && typeof error.code === 'string' && SQLSTATE.test(error.code)) return error.code;
  return null;
}

function isConnectionLoss(error) {
  if (!fromDatabaseCall.has(error)) return false;
  if (typeof error.code === 'string' && CONNECTION_LOSS_CODES.has(error.code)) return true;
  return typeof error.message === 'string' && CONNECTION_LOSS_MESSAGES.some(pattern => pattern.test(error.message));
}

export function isRetryableTransactionError(error) {
  const sqlstate = sqlstateOf(error);
  return sqlstate === '40001' || sqlstate === '40P01';
}

/**
 * Maps a driver error to a client-safe coded error, or returns null when `error` is not a database
 * error (application errors keep their own code). The result never carries the driver message,
 * `detail`, `hint`, `table`, `column`, `constraint`, `where` or the original error.
 *
 * Parity with the SQLite runtime (decision 2): constraint violations (class 23) are 409 and
 * trigger aborts (P0001), data exceptions (class 22) and other statement errors are 400, all with
 * BACKEND_REQUEST_FAILED. Transient server conditions are 503 DATABASE_UNAVAILABLE.
 */
export function classifyDatabaseError(error) {
  if (error === null || typeof error !== 'object') return null;
  const sqlstate = sqlstateOf(error);
  if (sqlstate) {
    if (TRANSIENT_SQLSTATES.has(sqlstate) || TRANSIENT_CLASSES.has(sqlstate.slice(0, 2))) {
      return classified('DATABASE_UNAVAILABLE', 503, { sqlstate, retryable: true });
    }
    if (sqlstate.startsWith('23')) return classified('BACKEND_REQUEST_FAILED', 409, { sqlstate });
    return classified('BACKEND_REQUEST_FAILED', 400, { sqlstate });
  }
  if (isConnectionLoss(error)) return classified('DATABASE_UNAVAILABLE', 503, { retryable: true });
  return null;
}
