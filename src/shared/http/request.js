import { failure } from './errors.js';

export async function readBody(req, { limitBytes = 16_384 } = {}) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw failure(415, 'Use JSON.');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > limitBytes) throw failure(413, 'Request is too large.');
  }
  try {
    const value = JSON.parse(body || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw failure(400, 'Provide a JSON object.');
  }
}

export function prepareJsonResponse(res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

export function sendJson(res, status, value) {
  res.writeHead(status);
  res.end(JSON.stringify(value));
}
