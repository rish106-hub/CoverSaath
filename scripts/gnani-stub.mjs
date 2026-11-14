// Local stand-in for Gnani (loopback only). Canned responses for the UNVERIFIED wire format in
// src/integrations/gnani/gnani-transport.js. Synthetic only; never logs bodies.
// Usage: node scripts/gnani-stub.mjs [port]   (or import startGnaniStub in tests)
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export function startGnaniStub({ port = 0, onRequest = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      onRequest({ method: req.method, path: url.pathname, query: url.searchParams, headers: req.headers, body });
      if (!req.headers['x-api-key-id']) { res.writeHead(401); return res.end(); }
      if (req.method === 'POST' && url.pathname === '/v1/stt') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ transcript: 'synthetic test transcript', duration_ms: Math.min(1500, Number(url.searchParams.get('max_duration_ms')) || 1500) }));
      }
      if (req.method === 'POST' && url.pathname === '/v1/tts') {
        res.writeHead(200, { 'content-type': 'audio/wav' });
        return res.end(Buffer.from('RIFFsyntheticwav'));
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'not_found' } }));
    });
  });
  return new Promise(resolve => server.listen(port, '127.0.0.1', () => resolve({
    server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(done => server.close(done)),
  })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { url } = await startGnaniStub({ port: Number(process.argv[2] ?? 3998) });
  console.log(`gnani-stub listening ${url}`);
}
