// Local stand-in for Gnani Vachana (loopback only), implementing the wire format in
// src/integrations/gnani/gnani-transport.js (from docs.gnani.ai). Canned synthetic responses; never logs bodies.
// Usage: node scripts/gnani-stub.mjs [port]   (or import startGnaniStub in tests)
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const STT_EXTENSIONS = new Set(['wav', 'mp3', 'ogg', 'flac', 'aac', 'm4a']);
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

export function startGnaniStub({ port = 0, onRequest = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const body = Buffer.concat(chunks);
      onRequest({ method: req.method, path: url.pathname, headers: req.headers, body });
      if (!req.headers['x-api-key-id']) return json(res, 401, { detail: { error_code: 'MISSING_API_KEY', message: 'missing', status_code: 401 } });
      if (req.method === 'POST' && url.pathname === '/stt/v3') {
        let form;
        try { form = await new Response(body, { headers: { 'content-type': req.headers['content-type'] ?? '' } }).formData(); } catch { return json(res, 422, { detail: [{ msg: 'bad form' }] }); }
        const file = form.get('audio_file');
        if (!file || typeof file === 'string') return json(res, 422, { detail: [{ msg: 'audio_file required' }] });
        const extension = file.name.split('.').pop().toLowerCase();
        if (!STT_EXTENSIONS.has(extension)) return json(res, 400, { success: false, error: { type: 'UNSUPPORTED_AUDIO_FORMAT', message: 'unsupported' } });
        if (!['en-IN', 'hi-IN', 'hi-IN,en-IN'].includes(form.get('language_code'))) return json(res, 400, { success: false, error: { type: 'INVALID_LANGUAGE_CODE', message: 'language' } });
        if (form.get('model') !== 'prisma-v3.0') return json(res, 400, { success: false, error: { type: 'INVALID_MODEL', message: 'model' } });
        return json(res, 200, { success: true, request_id: 'stub-request-1', transcript: 'synthetic test transcript', model: 'prisma-v3.0', processing_time: 0.1, end_to_end_latency: 0.2 });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/tts/inference') {
        res.writeHead(200, { 'content-type': 'audio/ogg' });
        return res.end(Buffer.from('OggSsyntheticopus'));
      }
      json(res, 404, { success: false, message: 'not found', status_code: 404 });
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
