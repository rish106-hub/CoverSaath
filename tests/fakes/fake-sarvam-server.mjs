// Fake Sarvam Document AI (Digitise) server for deterministic tests. No real provider, key or spend.
// Implements exactly the flow src/integrations/sarvam/doc-ai-client.js uses:
//   POST /doc-ai/v1/job/digitise            multipart: file, language, output_format → { job_id, status }
//   GET  /doc-ai/v1/job/:id/status          → { status, usage }
//   GET  /doc-ai/v1/job/:id/download-url    → { method, url }   (https URL on a fake host; see egress guard)
//   GET  /results/:id.zip                   → result ZIP with metadata/page_NNN.json per page
// Page text comes from registered documents (page text keyed by the first drawn line of each PDF page).
//
// Failure modes (set in process via setFailure() or over HTTP via POST /__control):
//   { stage: 'create'|'status'|'download'|'any', mode: '429'|'500'|'timeout'|'malformed_zip'|'wrong_page_count'|'job_failed',
//     times: N (default 1; Infinity for always), skip: N (let the first N matching requests through) }

import http from 'node:http';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFArray, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

export const SARVAM_FAKE_PAGE_LIMIT = 10;
export const SARVAM_FAKE_DOWNLOAD_HOST = 'results.sarvam-fake.test';

const normalise = text => String(text).replace(/₹/g, 'Rs.').replace(/[^\x20-\x7E\n]/g, '-').replace(/\s+/g, '').toLowerCase();

/** Minimal ZIP writer (stored entries) accepted by src/modules/policy-breakdown/ocr/zip-reader.js. */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const nameBytes = Buffer.from(name);
    const data = Buffer.from(content);
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26); local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0x21, 14); central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** Text drawn on each page of a (pdf-lib generated) PDF, in order. */
async function drawnTextPerPage(bytes) {
  const document = await PDFDocument.load(bytes, { updateMetadata: false });
  return document.getPages().map(page => {
    const contents = page.node.Contents();
    const streams = contents instanceof PDFArray ? contents.asArray().map(ref => document.context.lookup(ref)) : [contents];
    const lines = [];
    for (const stream of streams) {
      if (!stream) continue;
      const raw = stream instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(stream).decode()) : Buffer.from(stream.getContents());
      // pdf-lib writes shown text as <hex> Tj; literal (text) Tj is also accepted.
      for (const match of raw.toString('latin1').matchAll(/(?:<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\)])*)\))\s*Tj/g)) {
        lines.push(match[1] !== undefined ? Buffer.from(match[1].replace(/\s/g, ''), 'hex').toString('latin1') : match[2].replace(/\\([()\\])/g, '$1'));
      }
    }
    return lines.join('\n');
  });
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType ?? '');
  if (!boundary) return null;
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const fields = {};
  let position = buffer.indexOf(delimiter);
  while (position !== -1) {
    const next = buffer.indexOf(delimiter, position + delimiter.length);
    if (next === -1) break;
    const part = buffer.subarray(position + delimiter.length + 2, next - 2);
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const body = part.subarray(split + 4);
    if (name) fields[name] = /filename="/.test(head) ? { filename: /filename="([^"]*)"/.exec(head)?.[1], bytes: body } : body.toString('utf8');
    position = next;
  }
  return fields;
}

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks)));
  request.on('error', reject);
});

export async function createFakeSarvamServer({ apiKey = null, pollsBeforeComplete = 1, hangMs = 30_000, downloadHost = SARVAM_FAKE_DOWNLOAD_HOST } = {}) {
  const registered = []; // { key: normalised text, text }
  const jobs = new Map();
  const failures = [];
  const requests = [];
  let jobCounter = 0;
  const sockets = new Set();

  function matchFailure(stage) {
    for (const failure of failures) {
      if (failure.stage !== 'any' && failure.stage !== stage) continue;
      if (failure.skip > 0) { failure.skip -= 1; continue; }
      if (failure.times <= 0) continue;
      failure.times -= 1;
      return failure;
    }
    return null;
  }

  const sendJson = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  async function applyFailure(stage, response) {
    const failure = matchFailure(stage);
    if (!failure) return null;
    if (failure.mode === '429') { sendJson(response, 429, { detail: 'Rate limit exceeded (fake).' }); return 'handled'; }
    if (failure.mode === '500') { sendJson(response, 500, { detail: 'Internal error (fake).' }); return 'handled'; }
    if (failure.mode === 'timeout') { await new Promise(resolve => { const timer = setTimeout(resolve, hangMs); response.on('close', () => { clearTimeout(timer); resolve(); }); }); if (!response.writableEnded) response.destroy(); return 'handled'; }
    return failure; // content-shaping modes are applied by the caller
  }

  // A drawn page may be a truncated, re-wrapped copy of the registered text, so match on the normalised prefix.
  function matchRegistered(drawn) {
    const key = normalise(drawn);
    const hit = key ? registered.find(item => item.key.startsWith(key)) : null;
    return hit ? hit.text : `UNREGISTERED PAGE ${drawn.slice(0, 40)}`;
  }

  function resultZip(job, failure) {
    if (failure?.mode === 'malformed_zip') return Buffer.from('this is not a zip archive');
    const pages = failure?.mode === 'wrong_page_count' ? job.pages.slice(0, -1) : job.pages;
    return buildZip(pages.map((text, index) => [`metadata/page_${String(index + 1).padStart(3, '0')}.json`, JSON.stringify({ page_num: index + 1, blocks: [{ block_id: `p${index + 1}-b1`, text, bbox: [0, 0, 1, 1] }] })]));
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    const entry = { method: request.method, path: url.pathname, at: Date.now() };
    requests.push(entry);
    try {
      if (url.pathname === '/__control') {
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
        if (body.reset) { failures.length = 0; }
        if (body.failure) api.setFailure(body.failure);
        if (body.registerPages) api.registerDocument({ pages: body.registerPages });
        return sendJson(response, 200, api.stats());
      }
      if (url.pathname === '/__stats') return sendJson(response, 200, api.stats());
      if (request.method === 'GET' && /^\/results\/[^/]+\.zip$/.test(url.pathname)) {
        const job = jobs.get(url.pathname.split('/')[2].replace(/\.zip$/, ''));
        if (!job) return sendJson(response, 404, { detail: 'Result not found.' });
        const handled = await applyFailure('download', response);
        if (handled === 'handled') return undefined;
        const zip = resultZip(job, handled);
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': zip.length });
        return response.end(zip);
      }
      const base = '/doc-ai/v1';
      if (!url.pathname.startsWith(`${base}/`)) return sendJson(response, 404, { detail: 'Not found.' });
      if (apiKey && request.headers['api-subscription-key'] !== apiKey) return sendJson(response, 403, { detail: 'Invalid API subscription key.' });
      if (!request.headers['api-subscription-key']) return sendJson(response, 403, { detail: 'Missing API subscription key.' });
      const route = url.pathname.slice(base.length);
      if (request.method === 'POST' && route === '/job/digitise') {
        const raw = await readBody(request);
        const handled = await applyFailure('create', response);
        if (handled === 'handled') return undefined;
        const fields = parseMultipart(raw, request.headers['content-type']);
        if (!fields?.file?.bytes?.length) return sendJson(response, 422, { detail: 'file is required' });
        if (fields.output_format !== 'json') return sendJson(response, 422, { detail: 'output_format must be json in this fake' });
        let texts;
        try { texts = await drawnTextPerPage(fields.file.bytes); } catch { return sendJson(response, 400, { detail: 'File could not be read as a PDF.' }); }
        if (texts.length > SARVAM_FAKE_PAGE_LIMIT) return sendJson(response, 400, { detail: `A job accepts at most ${SARVAM_FAKE_PAGE_LIMIT} pages; this file has ${texts.length}.` });
        const id = `fake-job-${String(++jobCounter).padStart(4, '0')}-${createHash('sha256').update(fields.file.bytes).digest('hex').slice(0, 8)}`;
        jobs.set(id, { id, language: fields.language, pages: texts.map(text => matchRegistered(text)), polls: 0, failure: handled });
        return sendJson(response, 202, { job_id: id, status: 'pending', run_id: `run-${id}` });
      }
      const match = /^\/job\/([^/]+)\/(status|download-url)$/.exec(route);
      if (request.method === 'GET' && match) {
        const job = jobs.get(decodeURIComponent(match[1]));
        if (!job) return sendJson(response, 404, { detail: 'Job not found.' });
        const handled = await applyFailure(match[2] === 'status' ? 'status' : 'download-url', response);
        if (handled === 'handled') return undefined;
        if (match[2] === 'status') {
          job.polls += 1;
          const failedJob = handled?.mode === 'job_failed';
          const status = failedJob ? 'failed' : job.polls > pollsBeforeComplete ? 'completed' : 'running';
          return sendJson(response, 200, { job_id: job.id, status, usage: status === 'completed' ? { pages_processed: job.pages.length } : null });
        }
        return sendJson(response, 200, { method: 'GET', url: `https://${downloadHost}/results/${job.id}.zip` });
      }
      return sendJson(response, 404, { detail: 'Not found.' });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 500, { detail: `fake server error: ${error.message}` });
    }
    return undefined;
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

  const api = {
    server,
    get origin() { return `http://127.0.0.1:${server.address().port}`; },
    get baseUrl() { return `${api.origin}${'/doc-ai/v1'}`; },
    downloadHost,
    /** pages: [{ pageNumber, text }]. The PDF under test must have been built from the same text (buildSyntheticPdf). */
    registerDocument({ pages }) { for (const page of pages) registered.push({ key: normalise(page.text), text: page.text }); },
    setFailure({ stage = 'any', mode, times = 1, skip = 0 }) {
      if (!['429', '500', 'timeout', 'malformed_zip', 'wrong_page_count', 'job_failed'].includes(mode)) throw new Error(`Unknown failure mode ${mode}.`);
      failures.push({ stage, mode, times: times === null ? Infinity : times, skip });
    },
    clearFailures() { failures.length = 0; },
    stats() {
      const count = path => requests.filter(item => item.path.includes(path)).length;
      return { requests: requests.filter(item => !item.path.startsWith('/__')).length, jobs: jobs.size, creates: count('/job/digitise'), statusPolls: count('/status'), downloads: count('/results/'), pendingFailures: failures.filter(item => item.times > 0).length };
    },
    requests,
    reset() { failures.length = 0; requests.length = 0; jobs.clear(); jobCounter = 0; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
  return api;
}

export async function startFakeSarvamServer(options = {}) {
  const fake = await createFakeSarvamServer(options);
  await new Promise(resolve => fake.server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return fake;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { loadSyntheticPack } = await import('../fixtures/policy-breakdown/synthetic-pack.mjs');
  const fake = await startFakeSarvamServer({ port: Number(process.env.FAKE_SARVAM_PORT ?? 8791), apiKey: process.env.SARVAM_API_KEY || null });
  fake.registerDocument(loadSyntheticPack({ pack: process.env.FAKE_PACK ?? 'a' }));
  console.log(`fake-sarvam ${fake.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fake.close().then(() => process.exit(0)));
}
