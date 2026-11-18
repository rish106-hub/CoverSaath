import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { fail, str } from './holdings-common.js';

// FSS handoff state (migration 068, ADR 0037, docs/contracts/fss-handoff-v1.md): one task per holding handed to FSS, and the mapping of
// a holding to the FSS product it matched. Identifiers, closed enums, a counter and times only: never an insurer name, product name or UIN.
// Callers are jobs and the signed-notice receiver (no person behind them), so the household scope is the holding's own household, enforced
// by the migration's scope trigger. A repeated notice is idempotent; a final state never changes; an unknown request id is dropped.

export const FSS_OPEN_STATES = Object.freeze(['queued', 'accepted', 'working']);
export const FSS_FINAL_STATES = Object.freeze(['matched', 'no_match', 'needs_review', 'unavailable', 'rights_blocked', 'failed']);
const FSS_NOTICE_STATES = Object.freeze(['accepted', 'working', 'matched', 'no_match', 'needs_review', 'unavailable', 'rights_blocked']);
export const FSS_MATCHED_BY = Object.freeze(['alias', 'uin', 'manual']);
export const FSS_CONFIDENCE = Object.freeze(['high', 'medium', 'low']);
export const FSS_MAX_ATTEMPTS = 3;
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
const FSS_ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const OUTCOME = /^[a-z][a-z0-9_]{1,59}$/;
const invalid = message => fail('INVALID_REQUEST', message, 400);

export class FssHandoffRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    if (!database) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
  }

  #dto(row) {
    return row ? Object.freeze({
      id: row.id, householdId: row.household_id, holdingId: row.holding_id, requestId: row.request_id, fssHandoffId: row.fss_handoff_id,
      versionId: row.fss_version_id, state: row.state, attempts: row.attempts, lastOutcome: row.last_outcome,
      createdAt: row.created_at, updatedAt: row.updated_at, decidedAt: row.decided_at,
    }) : null;
  }

  /** Queues a handoff for a holding, or returns the open one (at most one open handoff per holding). Resolves { handoff, created }. */
  async queue({ householdId, holdingId }) {
    str(householdId, 'householdId'); str(holdingId, 'holdingId');
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      const open = await db.one(`SELECT * FROM fss_handoffs WHERE holding_id = ? AND household_id = ? AND state IN ('queued', 'accepted', 'working')`, [holdingId, householdId]);
      if (open) return { handoff: this.#dto(open), created: false };
      const id = `fssh-${randomUUID()}`;
      try {
        await db.run(`INSERT INTO fss_handoffs (id, household_id, holding_id, request_id, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
          [id, householdId, holdingId, `req-${randomUUID()}`, at, at]);
      } catch (error) {
        if (/fss row must name a holding/.test(String(error?.message))) fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);
        throw error;
      }
      return { handoff: this.#dto(await db.one('SELECT * FROM fss_handoffs WHERE id = ?', [id])), created: true };
    }, { locks: [householdLock(householdId)] });
  }

  async byRequestId(requestId) {
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return null;
    return this.#dto(await this.database.one('SELECT * FROM fss_handoffs WHERE request_id = ?', [requestId]));
  }

  async forHolding(holdingId) {
    str(holdingId, 'holdingId');
    return this.#dto(await this.database.one('SELECT * FROM fss_handoffs WHERE holding_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', [holdingId]));
  }

  /** A send that FSS accepted (create answered 202 or 200): the FSS handoff id and the state FSS reported. Only moves a queued handoff forward. */
  async recordAccepted({ requestId, fssHandoffId, state }) {
    if (!FSS_ID.test(String(fssHandoffId ?? '')) || !['accepted', 'working'].includes(state)) invalid('fssHandoffId or state is invalid.');
    const at = this.clock().toISOString();
    const changed = await this.database.run(`UPDATE fss_handoffs SET fss_handoff_id = ?, state = ?, updated_at = ? WHERE request_id = ? AND state = 'queued'`, [fssHandoffId, state, at, requestId]);
    return changed.changes > 0;
  }

  /** A failed send: counts the attempt; the third failure marks the handoff 'failed' (listed for support). Resolves the new state or null. */
  async recordSendFailure({ requestId, outcome }) {
    if (!OUTCOME.test(String(outcome ?? ''))) invalid('outcome is invalid.');
    const at = this.clock().toISOString();
    const db = this.database;
    return db.transaction(async () => {
      const row = await db.one(`SELECT * FROM fss_handoffs WHERE request_id = ? AND state = 'queued' FOR UPDATE`, [requestId]);
      if (!row) return null;
      const attempts = row.attempts + 1;
      const failed = attempts >= FSS_MAX_ATTEMPTS;
      await db.run('UPDATE fss_handoffs SET attempts = ?, last_outcome = ?, state = ?, decided_at = ?, updated_at = ? WHERE id = ?',
        [attempts, outcome, failed ? 'failed' : 'queued', failed ? at : null, at, row.id]);
      return failed ? 'failed' : 'queued';
    });
  }

  /**
   * Applies a verified notice (or a poll answer). Resolves { result }: 'applied', 'duplicate' (same state again), 'ignored' (a final
   * state never changes, or the FSS handoff id differs from the stored one) or 'unknown' (no such request id: dropped, e.g. an erased holding).
   */
  async applyNotice({ requestId, fssHandoffId, state, versionId = null }) {
    if (!FSS_NOTICE_STATES.includes(state)) invalid('state is invalid.');
    if (!FSS_ID.test(String(fssHandoffId ?? '')) || (versionId !== null && !FSS_ID.test(String(versionId))) || (versionId !== null && state !== 'matched')) invalid('fssHandoffId or versionId is invalid.');
    const at = this.clock().toISOString();
    const db = this.database;
    return db.transaction(async () => {
      const row = await db.one('SELECT * FROM fss_handoffs WHERE request_id = ? FOR UPDATE', [requestId]);
      if (!row) return { result: 'unknown' };
      if (row.fss_handoff_id && row.fss_handoff_id !== fssHandoffId) return { result: 'ignored' };
      if (row.state === state && (row.fss_version_id ?? null) === versionId) return { result: 'duplicate' };
      // A decided handoff never changes ('failed' is local: a late final notice may still decide it).
      if (FSS_FINAL_STATES.includes(row.state) && row.state !== 'failed') return { result: 'ignored' };
      if (row.state === 'working' && state === 'accepted') return { result: 'ignored' };
      const final = FSS_FINAL_STATES.includes(state);
      await db.run('UPDATE fss_handoffs SET fss_handoff_id = ?, state = ?, fss_version_id = ?, decided_at = ?, updated_at = ? WHERE id = ?',
        [fssHandoffId, state, versionId, final ? at : null, at, row.id]);
      return { result: 'applied', handoff: this.#dto(await db.one('SELECT * FROM fss_handoffs WHERE id = ?', [row.id])) };
    });
  }

  /** Open handoffs FSS accepted but never reported on, oldest first, for the hourly poll. */
  async openForPoll({ olderThanIso, limit = 20 }) {
    const rows = await this.database.many(`SELECT * FROM fss_handoffs WHERE state IN ('accepted', 'working') AND updated_at <= ? ORDER BY updated_at ASC LIMIT ?`, [olderThanIso, Math.min(Math.max(limit, 1), 100)]);
    return rows.map(row => this.#dto(row));
  }

  /** Records (or replaces) the mapping of a holding to the FSS product it matched. */
  async link({ householdId, holdingId, productId, versionId = null, matchedBy, confidence }) {
    str(householdId, 'householdId'); str(holdingId, 'holdingId');
    if (!FSS_ID.test(String(productId ?? '')) || (versionId !== null && !FSS_ID.test(String(versionId))) || !FSS_MATCHED_BY.includes(matchedBy) || !FSS_CONFIDENCE.includes(confidence)) invalid('The link is invalid.');
    const at = this.clock().toISOString();
    try {
      await this.database.run(`INSERT INTO holding_fss_links (holding_id, household_id, fss_product_id, fss_version_id, matched_by, confidence, matched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (holding_id) DO UPDATE SET fss_product_id = EXCLUDED.fss_product_id, fss_version_id = EXCLUDED.fss_version_id, matched_by = EXCLUDED.matched_by, confidence = EXCLUDED.confidence, matched_at = EXCLUDED.matched_at
        WHERE holding_fss_links.household_id = EXCLUDED.household_id`, [holdingId, householdId, productId, versionId, matchedBy, confidence, at]);
    } catch (error) {
      if (/fss row must name a holding/.test(String(error?.message))) fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);
      throw error;
    }
  }

  async linkFor(holdingId) {
    str(holdingId, 'holdingId');
    const row = await this.database.one('SELECT * FROM holding_fss_links WHERE holding_id = ?', [holdingId]);
    return row ? Object.freeze({ holdingId: row.holding_id, householdId: row.household_id, productId: row.fss_product_id, versionId: row.fss_version_id, matchedBy: row.matched_by, confidence: row.confidence, matchedAt: row.matched_at }) : null;
  }
}
