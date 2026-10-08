// Preloaded (node --import) into the API process under test. Guarantees no real network egress:
//  - fetch() and raw sockets may only reach loopback; anything else is recorded to E2E_EGRESS_LOG and refused.
//  - The fake Sarvam result host (https://*.sarvam-fake.test) is rewritten to the fake server's loopback origin,
//    because the real client only accepts public https download URLs. Defaults in src/ are not weakened.
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const logPath = process.env.E2E_EGRESS_LOG;
const fakeSarvamOrigin = process.env.E2E_SARVAM_FAKE_ORIGIN;

function violation(kind, target) {
  if (logPath) { try { appendFileSync(logPath, `${JSON.stringify({ kind, target, at: new Date().toISOString() })}\n`); } catch { /* best effort */ } }
  throw Object.assign(new Error(`E2E egress blocked (${kind}): ${target}`), { code: 'E2E_EGRESS_BLOCKED' });
}

const realFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, init) {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const url = new URL(raw);
  if (fakeSarvamOrigin && url.hostname.endsWith('.sarvam-fake.test')) {
    const target = new URL(url.pathname + url.search, fakeSarvamOrigin);
    return realFetch(target, init);
  }
  if (!LOOPBACK.has(url.hostname)) violation('fetch', url.origin);
  return realFetch(input, init);
};

const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const first = args[0];
  const options = Array.isArray(first) ? first[0] : first;
  let host;
  if (options && typeof options === 'object') host = options.path ? undefined : options.host ?? 'localhost';
  else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) host = typeof args[1] === 'string' ? args[1] : 'localhost';
  if (host !== undefined && !LOOPBACK.has(String(host))) violation('socket', String(host));
  return realConnect.apply(this, args);
};
