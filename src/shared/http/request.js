import { failure } from './errors.js';

export async function readBody(req, { limitBytes = 16_384 } = {}) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure(415, 'Use JSON.', 'UNSUPPORTED_MEDIA_TYPE');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limitBytes) throw failure(413, 'Request is too large.', 'REQUEST_TOO_LARGE');
  }
  try {
    const value = JSON.parse(body || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw failure(400, 'Provide a JSON object.', 'INVALID_JSON_BODY');
  }
}

// Reads a raw binary body of one exact media type, never buffering more than limitBytes + one chunk.
// A declared Content-Length above the limit is refused before any byte is read.
export async function readBinaryBody(req, { contentType, limitBytes }) {
  const declaredType = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (declaredType !== contentType) throw failure(415, `Use ${contentType}.`, 'UNSUPPORTED_MEDIA_TYPE');
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && (!/^\d{1,12}$/.test(declaredLength) || Number(declaredLength) > limitBytes)) {
    throw failure(413, 'Request is too large.', 'REQUEST_TOO_LARGE');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw failure(413, 'Request is too large.', 'REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export function prepareJsonResponse(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
}

export function sendJson(res, status, value) {
  res.writeHead(status);
  res.end(JSON.stringify(value));
}
