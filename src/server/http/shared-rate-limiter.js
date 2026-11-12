import { createHmac } from 'node:crypto';
import { failure } from '../../shared/http/index.js';

/**
 * Request limiter shared by every API machine (ADR 0014). The per-process limiter always runs first. It fails
 * closed: if the database counter fails, onFallback is told and the request is refused (503), never judged by the local
 * count alone. Keys reach the database only as a keyed hash. Pass { shared: false } for traffic
 * that should not cost a database write (health probes).
 * `store.consumeRequest(keyHash, windowMs)` resolves { count, resetAt }.
 */
export function createSharedRateLimiter({ local, store, hmacKey, limit, windowMs = 60_000, onFallback = () => {} }) {
  if (!local || !store || !Buffer.isBuffer(hmacKey)) throw new TypeError('A local limiter, a store and an HMAC key are required.');
  return Object.freeze({
    async check(key, { shared = true } = {}) {
      const localResult = local.check(key);
      if (!shared) return localResult;
      let counted;
      try {
        const keyHash = createHmac('sha256', hmacKey).update(String(key)).digest('hex').slice(0, 32);
        counted = await store.consumeRequest(keyHash, windowMs);
      } catch (error) {
        onFallback(error);
        throw failure(503, 'Request limit unavailable.');
      }
      if (counted.count > limit) throw failure(429, 'Request rate limit exceeded.');
      return { limit, remaining: Math.max(0, limit - counted.count), resetAt: counted.resetAt };
    },
  });
}
