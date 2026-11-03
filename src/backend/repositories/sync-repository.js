import { SYNC_FEED_ENTITIES, SYNC_LIMITS } from '../../contracts/sync.js';
import { householdLock } from '../database/postgres/locks.js';

// Per-household change log, snapshot cursor, push dedupe and log retention (ADR 0017, migration 031). The log holds ids, revisions and
// operations only, never a value. Entity data is read by the services that already own the readers; this file never opens a sealed
// column. Push dedupe uses idempotency_keys (scope `sync:<adult>`, key `<household>:<mutation id>`) and stores a status and a
// revision, never a value, so replaying an old mutation costs a fresh read, not a stored copy.

const DAY_MS = 24 * 60 * 60 * 1000;

export class SyncRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  #now() { return this.clock().toISOString(); }

  /** Low-water mark: a cursor below it has lost entries and must take a snapshot. 0 until the first trim. */
  async minSeq(householdId) {
    return (await this.database.one('SELECT min_seq FROM household_sync_state WHERE household_id = ?', [householdId]))?.min_seq ?? 0;
  }

  /** Highest seq logged for the household (0 when none). Seq order is commit order within a household (migration 031). */
  async maxSeq(householdId) {
    return (await this.database.one('SELECT COALESCE(max(seq), 0) AS top FROM household_changes WHERE household_id = ?', [householdId])).top;
  }

  /** Entries after `since` that this adult may see, oldest first. At most `limit` rows. */
  listChanges({ householdId, adultId, since, limit }) {
    return this.database.many(`SELECT seq, entity, entity_id, op, revision, at FROM household_changes
      WHERE household_id = ? AND seq > ? AND entity = ANY(?::text[]) AND (subject_adult_id IS NULL OR subject_adult_id = ?)
      ORDER BY seq LIMIT ?`, [householdId, since, [...SYNC_FEED_ENTITIES], adultId, limit]);
  }

  // ---- Natural-key lookups (ids only), so a client may name a row by tool, permission or place slot ------------------------

  /** Row ids of the adult's scenarios and permissions ([{ id, tool }] and [{ id, permission }]); at most 7 and 6 rows. */
  scenarioRows(householdId, adultId) {
    return this.database.many('SELECT id, tool FROM tool_scenarios WHERE household_id = ? AND adult_user_id = ?', [householdId, adultId]);
  }

  permissionRows(householdId, adultId) {
    return this.database.many('SELECT id, permission FROM device_permissions WHERE household_id = ? AND adult_user_id = ?', [householdId, adultId]);
  }

  /** The place a (kind, member, slot) names, with the same lookup the PUT route uses. */
  async placeId({ householdId, adultId, kind, memberId, slot }) {
    const row = kind === 'current_location'
      ? await this.database.one(`SELECT id FROM household_places WHERE household_id = ? AND adult_user_id = ? AND kind = 'current_location'`, [householdId, adultId])
      : await this.database.one(`SELECT id FROM household_places WHERE household_id = ? AND kind = ? AND COALESCE(member_id, '') = ? AND slot IS NOT DISTINCT FROM ?`, [householdId, kind, memberId ?? '', slot]);
    return row?.id ?? null;
  }

  async placeById(householdId, placeId) {
    return (await this.database.one('SELECT id, kind, slot, member_id, adult_user_id, revision FROM household_places WHERE id = ? AND household_id = ?', [placeId, householdId])) ?? null;
  }

  // ---- Push dedupe ---------------------------------------------------------------------------------------------------------

  /** The stored outcome for a mutation, or null (an expired record counts as none). */
  async findMutation({ adultId, householdId, mutationId }) {
    const row = await this.database.one('SELECT request_digest, response_json, expires_at FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?',
      [`sync:${adultId}`, `${householdId}:${mutationId}`]);
    if (!row || row.expires_at <= this.#now()) return null;
    return { requestDigest: row.request_digest, outcome: JSON.parse(row.response_json) };
  }

  /** Records a stable outcome ({ status, code?, revision? }; never a value). An expired record under the key is replaced. */
  async storeMutation({ adultId, householdId, mutationId, requestDigest, outcome }) {
    const at = this.#now();
    const expiresAt = new Date(Date.parse(at) + SYNC_LIMITS.mutationTtlDays * DAY_MS).toISOString();
    await this.database.run(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
      VALUES (?, ?, ?, 200, ?, ?, ?)
      ON CONFLICT (scope, idempotency_key) DO UPDATE SET request_digest = EXCLUDED.request_digest, response_status = 200,
        response_json = EXCLUDED.response_json, expires_at = EXCLUDED.expires_at, created_at = EXCLUDED.created_at`,
    [`sync:${adultId}`, `${householdId}:${mutationId}`, requestDigest, JSON.stringify(outcome), expiresAt, at]);
  }

  // ---- Retention and erasure -----------------------------------------------------------------------------------------------

  /**
   * Removes log entries older than the retention window (30 days) and raises each household's min_seq to the highest seq removed, so
   * older cursors get CURSOR_EXPIRED. Also removes expired push-dedupe records. Safe to run at any time and more than once. Not
   * scheduled by any code in this repository: a maintenance job calls it (ADR 0017). Resolves counts only.
   */
  async purgeChangeLog({ retentionDays = SYNC_LIMITS.retentionDays } = {}) {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS).toISOString();
    const db = this.database;
    return db.transaction(async () => {
      const removed = (await db.one('SELECT public.purge_household_changes(?) AS removed', [cutoff])).removed;
      const keys = (await db.run(`DELETE FROM idempotency_keys WHERE scope LIKE 'sync:%' AND expires_at <= ?`, [now.toISOString()])).changes;
      await this.audit?.append({ householdId: null, actorType: 'system', actorId: 'sync-repository', action: 'sync.log_purged', resourceType: 'sync', resourceId: 'household_changes', payload: { removed, expiredMutations: keys, retentionDays } });
      return Object.freeze({ removed, expiredMutations: keys });
    });
  }

  /**
   * Deletes the household's change log, sync state and push-dedupe records (counts-only audit). The household foreign keys cascade
   * the first two on a real household delete; no delete flow exists yet, so the erasure flow that adds one must also call this and
   * UserDataRepository.eraseForHousehold. Call it after the data erasures: they log their own deletes.
   */
  async eraseForHousehold({ householdId, reasonCode = 'household_erasure', actorId = 'sync-repository', actorType = 'system' }) {
    const db = this.database;
    return db.transaction(async () => {
      const changes = (await db.run('DELETE FROM household_changes WHERE household_id = ?', [householdId])).changes;
      const state = (await db.run('DELETE FROM household_sync_state WHERE household_id = ?', [householdId])).changes;
      const mutations = (await db.run(`DELETE FROM idempotency_keys WHERE scope LIKE 'sync:%' AND starts_with(idempotency_key, ?)`, [`${householdId}:`])).changes;
      await this.audit?.append({ householdId, actorType, actorId, action: 'sync.erased', resourceType: 'household', resourceId: householdId, payload: { reasonCode, changes, state, mutations } });
      return Object.freeze({ household_changes: changes, household_sync_state: state, mutations });
    }, { locks: [householdLock(householdId)] });
  }
}
