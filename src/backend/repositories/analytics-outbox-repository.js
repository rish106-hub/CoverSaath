import { createHmac, randomUUID } from 'node:crypto';
import { ANALYTICS_CONSENT_SCOPE, ANALYTICS_PURPOSE, sanitizeAnalyticsEvent } from '../../contracts/analytics-events.js';

// Analytics outbox (migration 057, ADR 0033). One row per allowlisted event. Household-linked so erasure deletes it; the household id never
// leaves this table (the distinct id is an HMAC of it). Properties are re-validated on enqueue AND on drain, so a row written by a bug or a
// manual edit still cannot send a key outside the allowlist.

const SALT_MIN = 16;
const RETAIN_SENT_MS = 7 * 24 * 60 * 60 * 1000;
const DRAIN_BATCH = 50;

/** Salted hash of a household id: HMAC-SHA256 under the salt, hex. Throws when the salt is too short to be a secret. */
export function distinctIdHash(householdId, salt) {
  if (typeof salt !== 'string' || salt.length < SALT_MIN) throw Object.assign(new Error('The analytics salt is not configured.'), { code: 'ANALYTICS_SALT_MISSING' });
  return createHmac('sha256', salt).update(String(householdId)).digest('hex');
}

export class AnalyticsOutboxRepository {
  constructor(database, { clock = () => new Date() } = {}) {
    this.database = database;
    this.clock = clock;
  }

  /** True when the household holds an active analytics grant that covers the usage-events scope (revoked and expired grants do not count). */
  async hasConsent(householdId, db = this.database) {
    const at = this.clock().toISOString();
    const row = await db.one(`SELECT 1 AS ok FROM consent_grants g
      JOIN consent_scopes s ON s.consent_grant_id = g.id
      WHERE g.household_id = ? AND g.purpose = ? AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR julianday(g.expires_at) > julianday(CAST(? AS text)))
        AND s.resource_type = ? AND s.action = ? AND s.data_category = ? AND s.recipient = ?
      LIMIT 1`, [householdId, ANALYTICS_PURPOSE, at, ANALYTICS_CONSENT_SCOPE.resourceType, ANALYTICS_CONSENT_SCOPE.action, ANALYTICS_CONSENT_SCOPE.dataCategory, ANALYTICS_CONSENT_SCOPE.recipient]);
    return Boolean(row);
  }

  /** Validates against the allowlist (throws on a rejected event or property) and stores one row. Does not check the flag or consent. */
  async enqueue({ householdId, event, properties = {}, salt }) {
    const clean = sanitizeAnalyticsEvent(event, properties);
    if (typeof householdId !== 'string' || householdId.length === 0 || householdId.length > 256) throw Object.assign(new Error('A household is required.'), { code: 'ANALYTICS_HOUSEHOLD_REQUIRED' });
    const id = randomUUID();
    await this.database.run(
      'INSERT INTO analytics_outbox (id, household_id, event, distinct_id_hash, properties_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, householdId, clean.event, distinctIdHash(householdId, salt), JSON.stringify(clean.properties), this.clock().toISOString()],
    );
    return id;
  }

  /**
   * Sends up to one batch of unsent rows through `send({ distinctId, event, properties })`. Rows are locked (SKIP LOCKED) while they are sent, so
   * two workers never send the same row. A household without an active analytics grant has its unsent rows deleted instead of sent
   * (consent re-checked at send time). A send that throws leaves the row unsent for the next drain. Returns counts only.
   */
  async drain({ send, limit = DRAIN_BATCH }) {
    const counts = { sent: 0, failed: 0, dropped: 0, purged: 0 };
    await this.database.transaction(async () => {
      const rows = await this.database.many(
        'SELECT id, household_id, event, distinct_id_hash, properties_json FROM analytics_outbox WHERE sent_at IS NULL ORDER BY created_at, id LIMIT ? FOR UPDATE SKIP LOCKED',
        [Math.min(Math.max(limit, 1), 200)],
      );
      const consent = new Map();
      for (const row of rows) {
        if (!consent.has(row.household_id)) consent.set(row.household_id, await this.hasConsent(row.household_id));
        let clean;
        try { clean = sanitizeAnalyticsEvent(row.event, JSON.parse(row.properties_json)); } catch { clean = null; }
        if (!consent.get(row.household_id) || !clean) {
          await this.database.run('DELETE FROM analytics_outbox WHERE id = ?', [row.id]);
          counts.dropped += 1;
          continue;
        }
        try {
          await send({ distinctId: row.distinct_id_hash, event: clean.event, properties: clean.properties });
          await this.database.run('UPDATE analytics_outbox SET sent_at = ? WHERE id = ?', [this.clock().toISOString(), row.id]);
          counts.sent += 1;
        } catch {
          counts.failed += 1;
        }
      }
      const purged = await this.database.run('DELETE FROM analytics_outbox WHERE sent_at IS NOT NULL AND julianday(sent_at) < julianday(CAST(? AS text))',
        [new Date(this.clock().getTime() - RETAIN_SENT_MS).toISOString()]);
      counts.purged = purged.changes;
    });
    return Object.freeze(counts);
  }

  async listForHousehold(householdId, { limit = 100 } = {}) {
    return this.database.many('SELECT * FROM analytics_outbox WHERE household_id = ? ORDER BY created_at, id LIMIT ?', [householdId, Math.min(Math.max(limit, 1), 1000)]);
  }

  async eraseForHousehold(householdId) {
    const result = await this.database.run('DELETE FROM analytics_outbox WHERE household_id = ?', [householdId]);
    return result.changes;
  }
}
