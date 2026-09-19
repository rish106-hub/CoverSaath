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
