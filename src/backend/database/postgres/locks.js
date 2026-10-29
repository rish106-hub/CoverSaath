// Transaction-scoped advisory lock keys (S3.2 design, section 3 and decision 5).
//
// Lock order for every transaction: household advisory lock -> consent_grants row FOR UPDATE ->
// workflow_runs rows FOR UPDATE by id -> workflow_tasks rows -> the rest. Take the household lock
// first, before any row lock; advisory locks are re-entrant inside one transaction, so a nested
// call (for example AuditRepository.append) that takes the same lock again does not block.
//
// A key is the first 64 bits of SHA-256(namespace NUL key), as a signed bigint in decimal text,
// passed to pg_advisory_xact_lock(bigint). A hash collision only serialises two unrelated
// transactions; it never lets two holders in at once.
import { createHash } from 'node:crypto';
import { PostgresDatabaseError } from './errors.js';

export const LOCK_NAMESPACES = Object.freeze({
  // Serialises one household's audit chain and derived-data writes.
  HOUSEHOLD: 'household',
  // The same, for rows whose household is NULL (one global key, decision 5).
  HOUSEHOLD_NONE: 'household_none',
  // Serialises one idempotency key (scope + key) across concurrent requests.
  IDEMPOTENCY: 'idempotency',
  // Serialises session issuance so the capacity check holds. The capacity is global (one
  // count of all active sessions), so callers take this lock with one fixed key, not per adult.
  SESSION_CAPACITY: 'session_capacity',
});

const namespaces = new Set(Object.values(LOCK_NAMESPACES));
const GLOBAL_KEY = 'global';

function invalid(message) {
  return new PostgresDatabaseError('DATABASE_LOCK_INVALID', message);
}

/** The signed 64-bit advisory key for (namespace, key), as decimal text. */
export function advisoryLockKey(namespace, key) {
  if (!namespaces.has(namespace)) throw invalid('Unknown advisory lock namespace.');
  if (typeof key !== 'string' || key === '' || key.length > 512) throw invalid('An advisory lock key must be a non-empty string.');
  const digest = createHash('sha256').update(namespace).update('\0').update(key).digest();
  return digest.readBigInt64BE(0).toString();
}

/** [namespace, key] for a household; a NULL household uses the global key. */
export function householdLock(householdId) {
  if (householdId === null || householdId === undefined) return [LOCK_NAMESPACES.HOUSEHOLD_NONE, GLOBAL_KEY];
  return [LOCK_NAMESPACES.HOUSEHOLD, householdId];
}

export function idempotencyLock(scope, key) {
  if (typeof scope !== 'string' || scope === '' || scope.includes('\0')) throw invalid('An idempotency lock scope is required.');
  if (typeof key !== 'string' || key === '') throw invalid('An idempotency lock key is required.');
  return [LOCK_NAMESPACES.IDEMPOTENCY, `${scope}\0${key}`];
}

export function sessionCapacityLock(key) {
  return [LOCK_NAMESPACES.SESSION_CAPACITY, key];
}
