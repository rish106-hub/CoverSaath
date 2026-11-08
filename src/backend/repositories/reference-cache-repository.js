// Cache of PUBLIC reference data (insurers, products, versions, facts) fetched by the future ReferenceDataPort
// (migration 033). It never holds household data: callers pass an allow-listed key and a response body from the
// reference service, nothing else. Freshness and lease expiry use database time, so machine clock skew does not matter.

export const REFERENCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const REFERENCE_LEASE_MS = 30_000;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]*$/;

/** True when the row is marked fresh and has not passed stale_after, judged at `nowMs`. Pure helper for callers holding a row. */
export function isReferenceFresh(row, nowMs = Date.now()) {
  return Boolean(row) && row.status === 'fresh' && new Date(row.staleAfter).getTime() > nowMs;
}

const assertKey = key => {
  if (typeof key !== 'string' || key.length < 1 || key.length > 200 || !KEY_PATTERN.test(key)) {
    throw Object.assign(new Error('Invalid reference cache key.'), { code: 'REFERENCE_CACHE_KEY_INVALID' });
  }
  return key;
};

const toRow = row => row && ({
  key: row.key, etag: row.etag, body: row.body, signature: row.signature, status: row.status,
  fetchedAt: row.fetched_at, staleAfter: row.stale_after, fresh: row.fresh,
});

export class ReferenceCacheRepository {
  constructor(database, { ttlMs = REFERENCE_CACHE_TTL_MS } = {}) {
    this.database = database;
    this.ttlMs = ttlMs;
  }

  /** Returns the cached row (with `fresh`: status is fresh and not past stale_after, by database time) or null. */
  async get(key) {
    return toRow(await this.database.one(
      `SELECT key, etag, body, signature, status, fetched_at, stale_after,
              (status = 'fresh' AND stale_after > now()) AS fresh
       FROM reference_cache WHERE key = ?`, [assertKey(key)]));
  }

  /** Inserts or replaces the entry for `key`, marks it fresh and sets stale_after to now plus the TTL. Returns the stored row. */
  async put({ key, etag = null, body, signature, ttlMs = this.ttlMs }) {
    if (body === undefined || body === null || typeof body !== 'object') {
      throw Object.assign(new Error('Reference cache body must be a JSON object or array.'), { code: 'REFERENCE_CACHE_BODY_INVALID' });
    }
    if (typeof signature !== 'string' || signature.length === 0) {
      throw Object.assign(new Error('Reference cache entries need a signature.'), { code: 'REFERENCE_CACHE_SIGNATURE_REQUIRED' });
    }
    return toRow(await this.database.one(
      `INSERT INTO reference_cache AS cache (key, etag, body, signature, fetched_at, stale_after, status)
       VALUES (?, ?, CAST(? AS jsonb), ?, now(), now() + (CAST(? AS bigint) * interval '1 millisecond'), 'fresh')
       ON CONFLICT (key) DO UPDATE SET etag = EXCLUDED.etag, body = EXCLUDED.body, signature = EXCLUDED.signature,
         fetched_at = EXCLUDED.fetched_at, stale_after = EXCLUDED.stale_after, status = 'fresh'
       RETURNING key, etag, body, signature, status, fetched_at, stale_after, (stale_after > now()) AS fresh`,
      [assertKey(key), etag, JSON.stringify(body), signature, String(ttlMs)]));
  }

  /** Marks one entry stale (a refresh failed). The body stays so it can be served labelled stale. Returns true when a row changed. */
  async markStale(key) {
    return (await this.database.run("UPDATE reference_cache SET status = 'stale' WHERE key = ? AND status <> 'stale'", [assertKey(key)])).changes === 1;
  }

  /** Marks every entry past stale_after as stale. Returns the number changed. */
  async markExpiredStale() {
    return (await this.database.run("UPDATE reference_cache SET status = 'stale' WHERE status = 'fresh' AND stale_after <= now()")).changes;
  }

  /** Deletes one entry. Returns true when a row was removed. */
  async remove(key) {
    return (await this.database.run('DELETE FROM reference_cache WHERE key = ?', [assertKey(key)])).changes === 1;
  }

  /**
   * Takes the refresh lease for `key` as `owner` (16 to 64 chars) for `leaseMs`. Returns true when taken. An unexpired
   * lease held by someone else refuses; an expired one (a crashed refresher) is taken over in the same statement.
   */
  async acquireLease({ key, owner, leaseMs = REFERENCE_LEASE_MS }) {
    const row = await this.database.one(
      `INSERT INTO reference_cache_leases AS lease (key, owner, expires_at)
       VALUES (?, ?, now() + (CAST(? AS bigint) * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET owner = EXCLUDED.owner, claimed_at = now(), expires_at = EXCLUDED.expires_at
       WHERE lease.expires_at <= now()
       RETURNING owner`, [assertKey(key), owner, String(leaseMs)]);
    return row?.owner === owner;
  }

  /** Extends a lease its holder still owns. False when it expired and another process took it. */
  async renewLease({ key, owner, leaseMs = REFERENCE_LEASE_MS }) {
    return (await this.database.run(
      `UPDATE reference_cache_leases SET expires_at = now() + (CAST(? AS bigint) * interval '1 millisecond')
       WHERE key = ? AND owner = ?`, [String(leaseMs), assertKey(key), owner])).changes === 1;
  }

  /** Releases a lease only if `owner` still holds it. */
  async releaseLease({ key, owner }) {
    return (await this.database.run('DELETE FROM reference_cache_leases WHERE key = ? AND owner = ?', [assertKey(key), owner])).changes === 1;
  }

  /** Deletes expired leases. */
  async purgeExpiredLeases() {
    return (await this.database.run('DELETE FROM reference_cache_leases WHERE expires_at <= now()')).changes;
  }
}
