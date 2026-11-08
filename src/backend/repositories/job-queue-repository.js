import { randomUUID } from 'node:crypto';

// Postgres job queue (migration 034, plan B4). A job is a row of identifiers: kind, household, optional document and consent
// grant, and a small payload of identifier values. It never holds document text, OCR output, model output or household fields.
//
// Lifecycle: queued -> running (claimed, leased) -> succeeded | queued again with backoff (retry) | dead (dead letter).
// claim() uses FOR UPDATE SKIP LOCKED, so concurrent workers never take the same job. A running job whose lease expired
// (the worker crashed or stalled) is claimed again, or dead-lettered when it has used all its attempts. Every later call
// (heartbeat, complete, fail) is fenced by the worker id AND the attempt number returned by claim(), so a worker that lost its
// lease cannot finish, fail or renew a job that another worker now holds. They return false in that case (also when the row
// was erased by a consent revocation); the handler must then stop and must not commit anything.

export const JOB_STATUSES = Object.freeze(['queued', 'running', 'succeeded', 'dead']);
export const DEFAULT_LEASE_MS = 60_000;
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_BACKOFF = Object.freeze({ baseMs: 5_000, maxMs: 15 * 60_000 });

const KIND = /^[a-z0-9_.-]{1,64}$/;
const WORKER_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,128}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const PAYLOAD_KEY = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MAX_PAYLOAD_KEYS = 8;
const MAX_CLAIM_KINDS = 32;
const LEASE_EXPIRED = 'JOB_LEASE_EXPIRED';

const invalid = message => Object.assign(new Error(message), { code: 'JOB_QUEUE_INPUT_INVALID', statusCode: 400 });

function identifier(value, name, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw invalid(`${name} is required.`);
  }
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid(`${name} must be an identifier.`);
  return value;
}

function positiveInteger(value, name, max) {
  if (!Number.isInteger(value) || value < 1 || value > max) throw invalid(`${name} must be an integer from 1 to ${max}.`);
  return value;
}

// The payload may hold identifier-shaped string values only. Free text, nested objects, numbers and long values are refused,
// so document text and household fields cannot enter the queue through it.
function serializePayload(payload) {
  if (payload === undefined || payload === null) return '{}';
  if (typeof payload !== 'object' || Array.isArray(payload)) throw invalid('payload must be an object of identifiers.');
  const entries = Object.entries(payload);
  if (entries.length > MAX_PAYLOAD_KEYS) throw invalid('payload has too many keys.');
  for (const [key, value] of entries) {
    if (!PAYLOAD_KEY.test(key)) throw invalid('payload keys must be short camelCase names.');
    if (typeof value !== 'string' || !IDENTIFIER.test(value)) throw invalid('payload values must be identifiers.');
  }
  return JSON.stringify(Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : 1))));
}

/** Delay before retry number `attempt` (1 = first failure): baseMs * 2^(attempt-1), capped at maxMs. */
export function retryDelayMs(attempt, { baseMs, maxMs } = DEFAULT_BACKOFF) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(Math.max(attempt, 1) - 1, 30));
}

const iso = value => (value instanceof Date ? value.toISOString() : value ?? null);

function present(row) {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    householdId: row.household_id,
    documentId: row.document_id,
    consentGrantId: row.consent_grant_id,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attempt: row.attempts,
    maxAttempts: row.max_attempts,
    runAfter: iso(row.run_after),
    lockedBy: row.locked_by,
    leaseExpiresAt: iso(row.lease_expires_at),
    lastErrorCode: row.last_error_code,
  });
}

const COLUMNS = `id, kind, household_id, document_id, consent_grant_id, payload_json, status, attempts, max_attempts,
  run_after, locked_by, lease_expires_at, last_error_code`;

export class JobQueueRepository {
  constructor(database, { clock = () => new Date(), backoff = DEFAULT_BACKOFF } = {}) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('JobQueueRepository needs the database interface.');
    this.database = database;
    this.clock = clock;
    this.backoff = backoff;
  }

  /**
   * Adds a job. With a `dedupeKey`, a queued or running job with the same key is returned instead of a second one (a retried
   * request enqueues once). Returns { job, created }.
   */
  async enqueue({
    kind, householdId, documentId = null, consentGrantId = null, payload = null, dedupeKey = null,
    maxAttempts = DEFAULT_MAX_ATTEMPTS, runAfter = null,
  }) {
    if (typeof kind !== 'string' || !KIND.test(kind)) throw invalid('kind is invalid.');
    const household = identifier(householdId, 'householdId');
    const document = identifier(documentId, 'documentId', { optional: true });
    const grant = identifier(consentGrantId, 'consentGrantId', { optional: true });
    const dedupe = identifier(dedupeKey, 'dedupeKey', { optional: true });
    positiveInteger(maxAttempts, 'maxAttempts', 20);
    const at = this.clock();
    const due = runAfter === null ? at : new Date(runAfter);
    if (Number.isNaN(due.getTime())) throw invalid('runAfter is invalid.');
    const id = `job-${randomUUID()}`;
    const inserted = await this.database.one(
      `INSERT INTO job_queue (id, kind, household_id, document_id, consent_grant_id, payload_json, dedupe_key, max_attempts, run_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS timestamptz), CAST(? AS timestamptz), CAST(? AS timestamptz))
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('queued', 'running') DO NOTHING
       RETURNING ${COLUMNS}`,
      [id, kind, household, document, grant, serializePayload(payload), dedupe, maxAttempts, due.toISOString(), at.toISOString(), at.toISOString()]);
    if (inserted) return { job: present(inserted), created: true };
    const existing = await this.database.one(
      `SELECT ${COLUMNS} FROM job_queue WHERE dedupe_key = ? AND status IN ('queued', 'running')`, [dedupe]);
    if (existing) return { job: present(existing), created: false };
    // The holder finished between the conflict and the read: the key is free again, so enqueue once more.
    return this.enqueue({ kind, householdId, documentId, consentGrantId, payload, dedupeKey, maxAttempts, runAfter });
  }

  /**
   * Claims one due job of `kinds` for `workerId`, or returns null. Due means queued with run_after reached, or running with an
   * expired lease. One short transaction; rows locked by another claimer are skipped, never waited for. Expired jobs that
   * have used all their attempts are dead-lettered first (JOB_LEASE_EXPIRED) instead of running again.
   */
  async claim({ workerId, kinds, leaseMs = DEFAULT_LEASE_MS }) {
    if (typeof workerId !== 'string' || !WORKER_ID.test(workerId)) throw invalid('workerId is invalid.');
    if (!Array.isArray(kinds) || kinds.length === 0 || kinds.length > MAX_CLAIM_KINDS || kinds.some(kind => typeof kind !== 'string' || !KIND.test(kind))) {
      throw invalid('kinds must list 1 to 32 job kinds.');
    }
    positiveInteger(leaseMs, 'leaseMs', 3_600_000);
    const now = this.clock();
    const at = now.toISOString();
    const leaseEnd = new Date(now.getTime() + leaseMs).toISOString();
    return this.database.transaction(async () => {
      await this.database.run(
        `UPDATE job_queue SET status = 'dead', locked_by = NULL, lease_expires_at = NULL, last_error_code = ?,
           finished_at = CAST(? AS timestamptz), updated_at = CAST(? AS timestamptz)
         WHERE id IN (SELECT id FROM job_queue WHERE status = 'running' AND lease_expires_at <= CAST(? AS timestamptz)
           AND attempts >= max_attempts AND kind = ANY(CAST(? AS text[])) ORDER BY lease_expires_at, id LIMIT 50 FOR UPDATE SKIP LOCKED)`,
        [LEASE_EXPIRED, at, at, at, kinds]);
      const row = await this.database.one(
        `UPDATE job_queue SET status = 'running', locked_by = ?, lease_expires_at = CAST(? AS timestamptz),
           attempts = attempts + 1, updated_at = CAST(? AS timestamptz)
         WHERE id = (SELECT id FROM job_queue
           WHERE kind = ANY(CAST(? AS text[]))
             AND ((status = 'queued' AND run_after <= CAST(? AS timestamptz))
               OR (status = 'running' AND lease_expires_at <= CAST(? AS timestamptz) AND attempts < max_attempts))
           ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED)
         RETURNING ${COLUMNS}`,
        [workerId, leaseEnd, at, kinds, at, at]);
      return row ? present(row) : null;
    });
  }

  /** Renews the lease of a job this worker still holds. False when the lease was lost (or the job erased). */
  async heartbeat({ id, workerId, attempt, leaseMs = DEFAULT_LEASE_MS }) {
    positiveInteger(leaseMs, 'leaseMs', 3_600_000);
    const now = this.clock();
    const result = await this.database.run(
      `UPDATE job_queue SET lease_expires_at = CAST(? AS timestamptz), updated_at = CAST(? AS timestamptz)
       WHERE id = ? AND status = 'running' AND locked_by = ? AND attempts = ?`,
      [new Date(now.getTime() + leaseMs).toISOString(), now.toISOString(), id, workerId, attempt]);
    return result.changes === 1;
  }

  /** Marks the job succeeded. False when this worker no longer holds it. */
  async complete({ id, workerId, attempt }) {
    const at = this.clock().toISOString();
    const result = await this.database.run(
      `UPDATE job_queue SET status = 'succeeded', locked_by = NULL, lease_expires_at = NULL, last_error_code = NULL,
         finished_at = CAST(? AS timestamptz), updated_at = CAST(? AS timestamptz)
       WHERE id = ? AND status = 'running' AND locked_by = ? AND attempts = ?`,
      [at, at, id, workerId, attempt]);
    return result.changes === 1;
  }

  /**
   * Records a failed attempt. A retryable failure with attempts left goes back to 'queued' after the backoff; otherwise the
   * job is dead-lettered. Only a coded failure is stored, never a message. Returns { state: 'retry' | 'dead', runAfter } or
   * null when this worker no longer holds the job.
   */
  async fail({ id, workerId, attempt, errorCode, retryable = true }) {
    const code = typeof errorCode === 'string' && ERROR_CODE.test(errorCode) ? errorCode : 'JOB_FAILED';
    const now = this.clock();
    const at = now.toISOString();
    return this.database.transaction(async () => {
      const held = await this.database.one(
        `SELECT attempts, max_attempts FROM job_queue
         WHERE id = ? AND status = 'running' AND locked_by = ? AND attempts = ? FOR UPDATE`, [id, workerId, attempt]);
      if (!held) return null;
      if (retryable && held.attempts < held.max_attempts) {
        const runAfter = new Date(now.getTime() + retryDelayMs(held.attempts, this.backoff)).toISOString();
        await this.database.run(
          `UPDATE job_queue SET status = 'queued', locked_by = NULL, lease_expires_at = NULL, last_error_code = ?,
             run_after = CAST(? AS timestamptz), updated_at = CAST(? AS timestamptz) WHERE id = ?`, [code, runAfter, at, id]);
        return { state: 'retry', runAfter };
      }
      await this.database.run(
        `UPDATE job_queue SET status = 'dead', locked_by = NULL, lease_expires_at = NULL, last_error_code = ?,
           finished_at = CAST(? AS timestamptz), updated_at = CAST(? AS timestamptz) WHERE id = ?`, [code, at, at, id]);
      return { state: 'dead', runAfter: null };
    });
  }

  async get(id) {
    const row = await this.database.one(`SELECT ${COLUMNS} FROM job_queue WHERE id = ?`, [id]);
    return row ? present(row) : null;
  }

  /** Counts per status (queue depth for metrics) and the number of queued jobs already due. */
  async stats() {
    const rows = await this.database.many('SELECT status, count(*) AS count FROM job_queue GROUP BY status', []);
    const byStatus = Object.fromEntries(JOB_STATUSES.map(status => [status, 0]));
    for (const row of rows) byStatus[row.status] = row.count;
    const due = await this.database.one(
      "SELECT count(*) AS count FROM job_queue WHERE status = 'queued' AND run_after <= CAST(? AS timestamptz)", [this.clock().toISOString()]);
    return Object.freeze({ ...byStatus, due: due.count });
  }

  /** Deletes succeeded jobs that finished before `olderThanMs` ago. Dead jobs are purged separately, later (purgeDead). */
  async purgeSucceeded(olderThanMs) {
    return this.#purgeFinished('succeeded', olderThanMs);
  }

  /** Deletes dead-lettered jobs that finished dying before `olderThanMs` ago. Use a long window: an operator reads these first. */
  async purgeDead(olderThanMs) {
    return this.#purgeFinished('dead', olderThanMs);
  }

  async #purgeFinished(status, olderThanMs) {
    positiveInteger(olderThanMs, 'olderThanMs', 365 * 24 * 3_600_000);
    const cutoff = new Date(this.clock().getTime() - olderThanMs).toISOString();
    return (await this.database.run(
      'DELETE FROM job_queue WHERE status = ? AND finished_at < CAST(? AS timestamptz)', [status, cutoff])).changes;
  }

  /**
   * Erasure (AI.md invariant 3): deletes every job, in any state, of the given documents in this household and every job
   * tied to the consent grant. Joins the caller's transaction. A running worker then fails its next heartbeat or complete and
   * must stop. Returns the number of rows deleted.
   */
  async eraseDerived({ householdId = null, documentIds = [], consentGrantId = null } = {}) {
    if (!Array.isArray(documentIds)) throw invalid('documentIds must be an array.');
    let deleted = 0;
    const documents = [...new Set(documentIds)];
    if (documents.length > 0) {
      const scoped = householdId !== null && householdId !== undefined;
      deleted += (await this.database.run(
        `DELETE FROM job_queue WHERE document_id = ANY(CAST(? AS text[]))${scoped ? ' AND household_id = ?' : ''}`,
        scoped ? [documents, householdId] : [documents])).changes;
    }
    if (consentGrantId) {
      deleted += (await this.database.run('DELETE FROM job_queue WHERE consent_grant_id = ?', [consentGrantId])).changes;
    }
    return deleted;
  }
}
