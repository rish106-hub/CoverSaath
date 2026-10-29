import { isIP } from 'node:net';
import { failure } from './errors.js';

const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
const allowedHosts = new Set(['127.0.0.1:8787', 'localhost:8787', '127.0.0.1:5173', 'localhost:5173']);

// `publicHosts` is the exact set of hostnames a hosted deployment answers to (config PUBLIC_HOSTS).
// Empty by default, which keeps the server local-only. The origin and cross-site checks still apply.
export function assertLocalRequest(req, { publicHosts = [] } = {}) {
  const boundPort = req.socket.localPort;
  const localBoundHosts = [`127.0.0.1:${boundPort}`, `localhost:${boundPort}`];
  if (!allowedHosts.has(req.headers.host) && !localBoundHosts.includes(req.headers.host) && !publicHosts.includes(req.headers.host)) throw failure(403, 'Local access only.');
  if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) throw failure(403, 'Origin not permitted.');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw failure(403, 'Cross-site access is blocked.');
}

const loopbackAddress = /^(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/;

const forwardingHeaders = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'x-client-ip', 'x-original-host'];

// True only when the TCP peer is a loopback address, no proxy forwarding header is present
// and the local request guard passes. Headers alone never qualify: a same-host proxy can
// rewrite Host to 127.0.0.1, so any sign of forwarding means the real caller is elsewhere.
export function isLoopbackRequest(req) {
  if (!loopbackAddress.test(req.socket?.remoteAddress ?? '')) return false;
  if (forwardingHeaders.some(name => req.headers[name] !== undefined)) return false;
  try {
    assertLocalRequest(req);
    return true;
  } catch {
    return false;
  }
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

// Rate-limit key. Behind Fly's proxy every socket peer is the proxy, so with `trustFlyClientIp` the
// key is the Fly-Client-IP header, which Fly's edge sets and overwrites on every request. Anything
// that is not an IP address falls back to the socket peer, so a bad header can never mint new keys.
export function clientRateKey(req, { trustFlyClientIp = false } = {}) {
  const peer = req.socket?.remoteAddress ?? 'local-unknown';
  if (!trustFlyClientIp) return peer;
  const header = req.headers['fly-client-ip'];
  return typeof header === 'string' && isIP(header.trim()) !== 0 ? header.trim() : peer;
}
