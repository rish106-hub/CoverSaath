import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

// Serves the Vite build (dist/) from the same origin as the API, so the browser needs no CORS and
// connect-src can stay 'self'. Analytics goes through the same-origin /ingest proxy.
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

export const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createStaticFileHandler({ rootDir }) {
  const root = resolve(rootDir);
  const cache = new Map();

  async function load(path) {
    if (cache.has(path)) return cache.get(path);
    try {
      const info = await stat(path);
      if (!info.isFile()) return null;
      const file = { body: await readFile(path), type: contentTypes[extname(path)] ?? 'application/octet-stream' };
      // The build is immutable for the life of the process; cache only small files to bound memory.
      if (file.body.length <= 2_000_000) cache.set(path, file);
      return file;
    } catch {
      return null;
    }
  }

  /** Returns true when it handled the request. */
  return async function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { return false; }
    if (pathname.includes('\0')) return false;
    const target = resolve(join(root, pathname));
    if (target !== root && !target.startsWith(root + sep)) return false;
    let file = pathname.endsWith('/') ? null : await load(target);
    // Client-side routes fall back to index.html; missing asset files stay 404.
    if (!file && !extname(pathname)) file = await load(join(root, 'index.html'));
    if (!file) return false;
    const isHtml = file.type.startsWith('text/html');
    res.setHeader('Content-Type', file.type);
    res.setHeader('Cache-Control', !isHtml && pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    if (isHtml) res.setHeader('Content-Security-Policy', HTML_CONTENT_SECURITY_POLICY);
    else res.removeHeader('Content-Security-Policy');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.writeHead(200);
    res.end(req.method === 'HEAD' ? undefined : file.body);
    return true;
  };
}
