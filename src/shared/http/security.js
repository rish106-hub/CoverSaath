import { failure } from './errors.js';

const localOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173'];
const localHosts = ['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173'];

/**
 * Host/Origin guard. Local development hosts are always allowed; deployed hosts (for example the Cloud Run
 * domain) are added explicitly through configuration, never inferred from the request.
 */
export function createRequestGuard({ allowedHosts = [], allowedOrigins = [] } = {}) {
  const hosts = new Set([...localHosts, ...allowedHosts]);
  const origins = new Set([...localOrigins, ...allowedOrigins]);
  return function assertAllowedRequest(req) {
    const boundPort = req.socket.localPort;
    const localBoundHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
    if (!hosts.has(req.headers.host) && !localBoundHosts.includes(req.headers.host)) throw failure(403, 'Host not permitted.');
    if (req.headers.origin && !origins.has(req.headers.origin)) throw failure(403, 'Origin not permitted.');
    if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Cross-site access is blocked.');
  };
}

export const assertLocalRequest = createRequestGuard();

/**
 * Rate-limit key for a request. Behind Cloud Run every socket peer is Google's front end, so with
 * `trustProxyHops` > 0 the client is read from X-Forwarded-For, counting hops from the right: entries a
 * client prepends itself cannot move the key.
 */
export function clientKey(req, { trustProxyHops = 0 } = {}) {
  if (trustProxyHops > 0) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',').map(part => part.trim()).filter(Boolean);
    const hop = forwarded[forwarded.length - trustProxyHops];
    if (hop) return hop;
  }
  return req.socket.remoteAddress ?? 'local-unknown';
}

export function createRateLimiter({ limit = 600, windowMs = 60_000, clock = () => Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) throw new TypeError('Rate limit must be an integer between 1 and 100000.');
  if (!Number.isInteger(windowMs) || windowMs < 1_000 || windowMs > 3_600_000) throw new TypeError('Rate-limit window must be between 1000 and 3600000 ms.');
  const clients = new Map();
  return Object.freeze({
    check(key) {
      const now = clock();
      const current = clients.get(key);
      const entry = !current || current.resetAt <= now ? { count: 0, resetAt: now + windowMs } : current;
      entry.count += 1;
      clients.set(key, entry);
      if (clients.size > 10_000) for (const [client, value] of clients) if (value.resetAt <= now) clients.delete(client);
      if (entry.count > limit) throw failure(429, 'Request rate limit exceeded.');
      return { limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
    },
  });
}
