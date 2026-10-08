import { failure } from '../../shared/http/index.js';

// Same-origin reverse proxy for PostHog at /ingest, so the page CSP keeps connect-src 'self' and the
// browser never talks to a third party directly.
//  - The upstream is fixed by configuration (region), never taken from the request.
//  - Nothing is forwarded unless the knowvia_consent cookie records analytics=granted. The client also
//    starts PostHog opted out; this check is the server-side backstop.
//  - Cookies, Authorization and client IP headers are not forwarded, so PostHog sees the server, not the user.
const MAX_BODY_BYTES = 512 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const forwardedRequestHeaders = ['content-type', 'content-encoding', 'user-agent', 'accept', 'accept-encoding'];
const forwardedResponseHeaders = ['content-type', 'content-encoding', 'cache-control'];

export function hasAnalyticsConsent(req) {
  const value = req.headers.cookie?.match(/(?:^|;\s*)knowvia_consent=([^;]*)/)?.[1];
  if (!value) return false;
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return false; }
  return decoded.split('|').includes('analytics=granted');
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw failure(413, 'Request is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createAnalyticsProxy({ upstream, fetchImpl = globalThis.fetch }) {
  /** Handles /ingest/**. Returns true when it handled the request. */
  return async function proxyAnalytics(req, res, url) {
    if (url.pathname !== '/ingest' && !url.pathname.startsWith('/ingest/')) return false;
    if (!upstream) throw failure(404, 'Analytics is not configured.');
    if (!['GET', 'POST', 'OPTIONS'].includes(req.method)) throw failure(405, 'Method not supported.');
    if (!hasAnalyticsConsent(req)) {
      // Drain without forwarding; 204 keeps the SDK quiet.
      for await (const chunk of req) void chunk;
      res.writeHead(204);
      res.end();
      return true;
    }
    const rest = url.pathname.slice('/ingest'.length) || '/';
    const base = rest.startsWith('/static/') ? upstream.assets : upstream.api;
    const target = new URL(rest + url.search, base);
    const headers = {};
    for (const name of forwardedRequestHeaders) if (req.headers[name]) headers[name] = req.headers[name];
    const body = req.method === 'POST' ? await readRawBody(req) : undefined;
    let upstreamResponse;
    try {
      upstreamResponse = await fetchImpl(target, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch {
      throw failure(502, 'Analytics upstream unavailable.');
    }
    const payload = Buffer.from(await upstreamResponse.arrayBuffer());
    res.removeHeader('Content-Security-Policy');
    res.removeHeader('Content-Type');
    for (const name of forwardedResponseHeaders) {
      const value = upstreamResponse.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    res.writeHead(upstreamResponse.status >= 300 && upstreamResponse.status < 400 ? 502 : upstreamResponse.status);
    res.end(payload);
    return true;
  };
}
