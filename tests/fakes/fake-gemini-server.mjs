// Fake Google Generative Language server (generateContent) for deterministic tests. No key, no spend.
// Matches what @ai-sdk/google 4.x sends: POST {base}/models/{model}:generateContent with systemInstruction,
// contents and generationConfig.responseSchema; it reads candidates[0].content.parts[].text and usageMetadata.
// Each section extractor/verifier is answered from the synthetic-pack gold fixtures; the section and role are
// read from the prompt text produced by src/modules/policy-breakdown/agents/prompts.js.
//
// Failure modes (setFailure() in process, or POST /__control):
//   { mode: '429'|'500'|'timeout'|'invalid_json'|'schema_invalid', times: N (default 1, null = always), skip: N,
//     section?: 1-9, role?: 'extractor'|'verifier' }

import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { loadSyntheticPack, goldToOutput } from '../fixtures/policy-breakdown/synthetic-pack.mjs';
import { sectionByNumber } from '../../src/modules/policy-breakdown/sections/index.js';
import { sectionOutputSchema } from '../../src/modules/policy-breakdown/contracts.js';

const SECTION_IDS = ['section-01-document-authority', 'section-02-people', 'section-03-time', 'section-04-treatment', 'section-05-exclusions', 'section-06-money', 'section-07-hospital-access', 'section-08-claims', 'section-09-renewal'];
const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 16);
const estimateTokens = characters => Math.ceil(characters / 3.5);
const MIN_CACHE_TOKENS = 1024; // the real API only caches prefixes above a minimum size

const readBody = request => new Promise((resolve, reject) => {
  const chunks = [];
  request.on('data', chunk => chunks.push(chunk));
  request.on('end', () => resolve(Buffer.concat(chunks)));
  request.on('error', reject);
});

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}

export async function createFakeGeminiServer({ pack = 'a', apiKey = null, hangMs = 30_000, latencyMs = 0, modelVersion = 'fake-gemini' } = {}) {
  let loadedPack = loadSyntheticPack({ pack });
  const failures = [];
  const requests = [];
  const sockets = new Set();

  const sendJson = (response, status, body) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };
  const googleError = (response, status, message, state) => sendJson(response, status, { error: { code: status, message, status: state } });

  function matchFailure(call) {
    for (const failure of failures) {
      if (failure.section && failure.section !== call.section) continue;
      if (failure.role && failure.role !== call.role) continue;
      if (failure.skip > 0) { failure.skip -= 1; continue; }
      if (failure.times <= 0) continue;
      failure.times -= 1;
      return failure;
    }
    return null;
  }

  // Prompt contract v2: the per-call tail holds "<<<8 YOUR TASK — ROLE: EXTRACTOR|VERIFIER>>>\nSection N. ...".
  // v1 fallback: "independent VERIFIER" in system and "SECTION: N." in system.
  function identify(system, prompt) {
    const v2 = /<<<8 YOUR TASK — ROLE: (EXTRACTOR|VERIFIER)>>>\s*Section (\d+)\./.exec(prompt);
    const role = v2 ? v2[1].toLowerCase() : /independent VERIFIER/.test(system) ? 'verifier' : 'extractor';
    const section = Number(v2 ? v2[2] : /(?:YOUR )?SECTION: (\d+)\./.exec(system)?.[1] ?? 0);
    return { role, section, pageCount: (prompt.match(/<<<PAGE \d+ BEGIN/g) ?? []).length };
  }

  function answer({ section, role }) {
    const definition = sectionByNumber(section);
    const gold = loadedPack.gold[SECTION_IDS[section - 1]];
    if (!definition || !gold) return null;
    const parameters = role === 'verifier' ? definition.parameters.filter(parameter => parameter.critical) : definition.parameters;
    const schema = sectionOutputSchema({ ...definition, parameters });
    const allowed = new Set(schema.properties.parameters.items.properties.key.enum);
    return { parameters: gold.filter(item => allowed.has(item.key)).map(item => goldToOutput(item, loadedPack.pages)) };
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fake');
    try {
      if (url.pathname === '/__control') {
        const body = JSON.parse((await readBody(request)).toString('utf8') || '{}');
        if (body.reset) { failures.length = 0; requests.length = 0; }
        if (body.pack) api.setPack(body.pack);
        if (body.failure) api.setFailure(body.failure);
        return sendJson(response, 200, api.stats());
      }
      if (url.pathname === '/__stats') return sendJson(response, 200, api.stats());
      const match = /^\/v1beta\/models\/([^/:]+):generateContent$/.exec(url.pathname);
      if (request.method !== 'POST' || !match) return googleError(response, 404, `Not found: ${url.pathname}`, 'NOT_FOUND');
      if (apiKey ? request.headers['x-goog-api-key'] !== apiKey : !request.headers['x-goog-api-key']) return googleError(response, 403, 'API key not valid (fake).', 'PERMISSION_DENIED');
      const rawBody = (await readBody(request)).toString('utf8');
      const body = JSON.parse(rawBody);
      const system = (body.systemInstruction?.parts ?? []).map(part => part.text ?? '').join('\n');
      const prompt = (body.contents ?? []).flatMap(content => content.parts ?? []).map(part => part.text ?? '').join('\n');
      const call = identify(system, prompt);
      const record = {
        index: requests.length + 1, at: Date.now(), model: match[1], ...call,
        systemSha: sha(system), promptSha: sha(prompt), systemChars: system.length, promptChars: prompt.length,
        hasResponseSchema: Boolean(body.generationConfig?.responseSchema ?? body.generationConfig?.responseJsonSchema),
        temperature: body.generationConfig?.temperature, maxOutputTokens: body.generationConfig?.maxOutputTokens,
        system, prompt, outcome: 'pending', cachedContentTokenCount: 0,
      };
      requests.push(record);
      if (latencyMs) await new Promise(resolve => setTimeout(resolve, latencyMs));
      const failure = matchFailure(call);
      if (failure) {
        record.outcome = failure.mode;
        if (failure.mode === '429') return googleError(response, 429, 'Resource has been exhausted (fake).', 'RESOURCE_EXHAUSTED');
        if (failure.mode === '500') return googleError(response, 500, 'Internal error (fake).', 'INTERNAL');
        if (failure.mode === 'timeout') {
          await new Promise(resolve => { const timer = setTimeout(resolve, hangMs); response.on('close', () => { clearTimeout(timer); resolve(); }); });
          if (!response.writableEnded) response.destroy();
          return undefined;
        }
      }
      let output = answer(call);
      if (!output) { record.outcome = 'unidentified_section'; return googleError(response, 400, `Fake could not identify the section in the prompt (section=${call.section}).`, 'INVALID_ARGUMENT'); }
      let text = JSON.stringify(output);
      if (failure?.mode === 'invalid_json') text = '{"parameters": [ this is not json';
      if (failure?.mode === 'schema_invalid') text = JSON.stringify({ parameters: [{ key: 'not_a_real_key', found: 'maybe' }] });
      // Implicit-cache model: the cached share is the longest identical prefix (system, then prompt) seen in an earlier call.
      const combined = `${system}\u0000${prompt}`;
      let best = 0;
      for (const earlier of requests.slice(0, -1)) best = Math.max(best, commonPrefixLength(combined, `${earlier.system}\u0000${earlier.prompt}`));
      const promptTokenCount = estimateTokens(combined.length);
      const cached = estimateTokens(best) >= MIN_CACHE_TOKENS ? Math.min(promptTokenCount, estimateTokens(best)) : 0;
      record.cachedContentTokenCount = cached;
      record.outcome = failure ? failure.mode : 'ok';
      const candidatesTokenCount = estimateTokens(text.length);
      return sendJson(response, 200, {
        candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount, cachedContentTokenCount: cached, candidatesTokenCount, totalTokenCount: promptTokenCount + candidatesTokenCount },
        modelVersion,
      });
    } catch (error) {
      if (!response.headersSent) googleError(response, 500, `fake server error: ${error.message}`, 'INTERNAL');
    }
    return undefined;
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

  const api = {
    server,
    get origin() { return `http://127.0.0.1:${server.address().port}`; },
    /** Value for BREAKDOWN_LLM_BASE_URL. */
    get baseUrl() { return `${api.origin}/v1beta`; },
    setPack(name) { loadedPack = loadSyntheticPack({ pack: name }); },
    get pack() { return loadedPack; },
    setFailure({ mode, times = 1, skip = 0, section = null, role = null }) {
      if (!['429', '500', 'timeout', 'invalid_json', 'schema_invalid'].includes(mode)) throw new Error(`Unknown failure mode ${mode}.`);
      failures.push({ mode, times: times === null ? Infinity : times, skip, section, role });
    },
    clearFailures() { failures.length = 0; },
    /** Every recorded request, including full system/prompt text. */
    requests,
    stats() {
      const bySection = {};
      for (const item of requests) { const key = `${item.section}:${item.role}`; bySection[key] = (bySection[key] ?? 0) + 1; }
      return {
        total: requests.length, ok: requests.filter(item => item.outcome === 'ok').length,
        failed: requests.filter(item => !['ok', 'pending'].includes(item.outcome)).length,
        bySection, distinctPromptShas: new Set(requests.map(item => item.promptSha)).size,
        cachedTokens: requests.reduce((sum, item) => sum + item.cachedContentTokenCount, 0),
        pendingFailures: failures.filter(item => item.times > 0).length,
      };
    },
    reset() { failures.length = 0; requests.length = 0; },
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); },
  };
  return api;
}

export async function startFakeGeminiServer(options = {}) {
  const fake = await createFakeGeminiServer(options);
  await new Promise(resolve => fake.server.listen(options.port ?? 0, '127.0.0.1', resolve));
  return fake;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fake = await startFakeGeminiServer({ port: Number(process.env.FAKE_GEMINI_PORT ?? 8792), pack: process.env.FAKE_PACK ?? 'a' });
  console.log(`fake-gemini ${fake.origin}`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => fake.close().then(() => process.exit(0)));
}
