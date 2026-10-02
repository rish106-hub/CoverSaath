import { failure } from './errors.js';

const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
const allowedHosts = new Set(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173']);

export function assertLocalRequest(req) {
  const boundPort = req.socket.localPort;
  const localBoundHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
  if (!allowedHosts.has(req.headers.host) && !localBoundHosts.includes(req.headers.host)) throw failure(403, 'Local access only.');
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw failure(403, 'Origin not permitted.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Cross-site access is blocked.');
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
