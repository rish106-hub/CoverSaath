import { createHash } from 'node:crypto';
import { createRateLimiter, failure } from '../../shared/http/index.js';

/**
 * Fixed-window limiter for per-adult service limits that every API machine shares (ADR 0014 D9). The per-process window runs
 * first, so a key it already refused never reaches the database; otherwise one upsert counts the call in `rate_limit_buckets`
 * (`store.consumeRequest(keyHash, windowMs, nowMs)`, RuntimeLimitsRepository). Keys are opaque ids (adult id, refresh-token
 * hash) and reach the database only as a SHA-256 digest. A database failure fails closed: onFallback is told and `check`
 * rejects (503), so a machine never lets a call through on its local count alone; the call it guards needs the database
 * anyway. Without a store it is the per-process limiter alone (unit tests, RATE_LIMIT_BACKEND=memory). `check` rejects
 * with a 429 failure when the limit is reached.
 */
export function createSharedWindowLimiter({ limit, windowMs = 60_000, clock = () => Date.now(), store = null, onFallback = () => {} }) {
  const local = createRateLimiter({ limit, windowMs, clock });
  return Object.freeze({
    async check(key) {
      local.check(key);
      if (!store) return;
      let counted;
      try {
        const keyHash = createHash('sha256').update('service-limit-v1\0').update(String(key)).digest('hex').slice(0, 32);
        counted = await store.consumeRequest(keyHash, windowMs, clock());
      } catch (error) {
        onFallback(error);
        throw failure(503, 'Service limit unavailable.');
      }
      if (counted.count > limit) throw failure(429, 'Request rate limit exceeded.');
    },
  });
}
