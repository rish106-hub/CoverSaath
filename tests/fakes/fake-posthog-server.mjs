// Fake PostHog ingestion host for E2E. The API's /ingest proxy is pointed here (POSTHOG_TEST_UPSTREAM), so tests
// can prove what PostHog would receive — and that nothing arrives before consent — without any real egress.
// Decodes the posthog-js transports: plain JSON, gzip (compression=gzip-js or Content-Encoding: gzip) and the
// form-encoded base64 `data=` fallback. GET /__events lists decoded events; POST /__reset clears them.
import http from 'node:http';
import { gunzipSync } from 'node:zlib';

function decode(request, url, raw) {
  if (!raw.length) return [];
  let buffer = raw;
  const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  if (isGzip || url.searchParams.get('compression') === 'gzip-js' || request.headers['content-encoding'] === 'gzip') buffer = gunzipSync(buffer);
  let text = buffer.toString('utf8');
  if (String(request.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    const data = new URLSearchParams(text).get('data');
    text = data ? Buffer.from(data, 'base64').toString('utf8') : '[]';
  }
  const parsed = JSON.parse(text);
  const batch = Array.isArray(parsed) ? parsed : Array.isArray(parsed.batch) ? parsed.batch : [parsed];
  return batch.filter(item => item && typeof item.event === 'string');
}

export async function startFakePostHogServer({ port = 0 } = {}) {
  const events = [];
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    if (url.pathname === '/__events') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ events, requests }));
    }
    if (url.pathname === '/__reset') {
      events.length = 0; requests.length = 0;
      response.writeHead(204); return response.end();
    }
    requests.push({ method: request.method, path: url.pathname, cookie: request.headers.cookie ?? null, authorization: request.headers.authorization ?? null });
    if (url.pathname.startsWith('/flags') || url.pathname.startsWith('/decide')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ featureFlags: {}, flags: {}, errorsWhileComputingFlags: false }));
    }
    if (url.pathname.startsWith('/array/') || url.pathname.startsWith('/static/')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end('{}');
    }
    try {
      events.push(...decode(request, url, raw).map(item => ({ event: item.event, distinct_id: item.distinct_id ?? item.properties?.distinct_id ?? null, properties: item.properties ?? {} })));
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":1}');
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end('{"status":0}');
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    events: () => events.slice(),
    requests: () => requests.slice(),
    reset() { events.length = 0; requests.length = 0; },
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
