import { randomUUID } from 'node:crypto';

// Shared runtime limits in PostgreSQL (migration 023, ADR 0014): a fixed-window request counter and a model spend ledger
// that several API machines (and restarts) share. Both are small atomic statements; neither stores a client address or
// any household data.

const MICRO = 1_000_000;
export const toMicroUsd = (usd, round = Math.ceil) => round(usd * MICRO);

export class RuntimeLimitsRepository {
  constructor(database, { clock = () => Date.now() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  /** Counts one request for `keyHash` in the fixed window containing now. Returns the window count after this request. */
  async consumeRequest(keyHash, windowMs) {
    const windowStart = Math.floor(this.clock() / windowMs) * windowMs;
    const { rows } = await this.database.query(
      `INSERT INTO rate_limit_buckets AS bucket (key_hash, window_start, request_count) VALUES (?, CAST(? AS bigint), 1)
       ON CONFLICT (key_hash, window_start) DO UPDATE SET request_count = bucket.request_count + 1
       RETURNING request_count`, [keyHash, String(windowStart)]);
    return { count: rows[0].request_count, windowStart, resetAt: windowStart + windowMs };
  }

  /** Deletes counters of windows that ended before `olderThanMs`. */
  async purgeRequestWindows(olderThanMs) {
    return (await this.database.run('DELETE FROM rate_limit_buckets WHERE window_start < CAST(? AS bigint)', [String(this.clock() - olderThanMs)])).changes;
  }

  /**
   * Reserves `amountUsd` in `scope` when reserved + spent + amount stays within `maxUsd`; otherwise returns null.
   * One UPDATE is the whole check, so concurrent machines cannot overspend.
   */
  async reserveBudget({ scope, amountUsd, maxUsd, task = null }) {
    const amount = toMicroUsd(amountUsd);
    const max = toMicroUsd(maxUsd, Math.floor);
    const id = randomUUID();
    return await this.database.transaction(async () => {
      await this.database.run('INSERT INTO model_budget_scopes (scope) VALUES (?) ON CONFLICT (scope) DO NOTHING', [scope]);
      const updated = await this.database.run(
        `UPDATE model_budget_scopes SET reserved_micro_usd = reserved_micro_usd + CAST(? AS bigint), updated_at = now()
         WHERE scope = ? AND reserved_micro_usd + spent_micro_usd + CAST(? AS bigint) <= CAST(? AS bigint)`,
        [String(amount), scope, String(amount), String(max)]);
      if (updated.changes !== 1) return null;
      await this.database.run(
        'INSERT INTO model_budget_reservations (id, scope, amount_micro_usd, task) VALUES (?, ?, CAST(? AS bigint), ?)',
        [id, scope, String(amount), typeof task === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(task) ? task : null]);
      return { id, amountUsd };
    });
  }

  /** Records the actual cost of a reservation (0 releases it). Settling twice changes nothing. Returns true when it settled. */
  async settleBudget({ id, actualUsd }) {
    const actual = toMicroUsd(actualUsd);
    return await this.database.transaction(async () => {
      const reservation = await this.database.one(
        `UPDATE model_budget_reservations SET state = ?, actual_micro_usd = CAST(? AS bigint), settled_at = now()
         WHERE id = ? AND state = 'reserved' RETURNING scope, amount_micro_usd`,
        [actual > 0 ? 'settled' : 'released', actual > 0 ? String(actual) : null, id]);
      if (!reservation) return false;
      await this.database.run(
        `UPDATE model_budget_scopes SET reserved_micro_usd = reserved_micro_usd - CAST(? AS bigint),
           spent_micro_usd = spent_micro_usd + CAST(? AS bigint), updated_at = now() WHERE scope = ?`,
        [String(reservation.amount_micro_usd), String(actual), reservation.scope]);
      return true;
    });
  }

  async budgetSnapshot(scope, maxUsd) {
    const row = await this.database.one('SELECT reserved_micro_usd, spent_micro_usd FROM model_budget_scopes WHERE scope = ?', [scope]);
    const reservedUsd = (row?.reserved_micro_usd ?? 0) / MICRO;
    const spentUsd = (row?.spent_micro_usd ?? 0) / MICRO;
    return { maxUsd, reservedUsd, spentUsd, availableUsd: maxUsd - reservedUsd - spentUsd };
  }
}
