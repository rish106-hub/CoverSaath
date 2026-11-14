import test from 'node:test';
import assert from 'node:assert/strict';
import { createGnaniVoiceProvider, createTtsCache, isCacheableSpeech, GNANI_LIMITS } from '../src/integrations/gnani/index.js';
import { startGnaniStub } from '../scripts/gnani-stub.mjs';

const grant = { authorized: true, purpose: 'voice_intake', recipients: ['gnani'] };
const audio = new Uint8Array([1, 2, 3, 4]);
const turn = extra => ({ authorization: grant, audio, mime: 'audio/wav', lang: 'en-IN', maxDurationMs: 15_000, ...extra });
const envFor = url => ({ GNANI_VOICE_ENABLED: 'true', GNANI_BASE_URL: url, GNANI_API_KEY_ID: 'test-key-id', GNANI_TTS_VOICE: 'test-voice' });
const code = expected => error => error.code === expected;
const sttOk = (extra = {}) => new Response(JSON.stringify({ success: true, request_id: 'r1', transcript: 'ok', model: 'prisma-v3.0', ...extra }), { status: 200 });
const withStatus = (status, body = {}) => async () => new Response(JSON.stringify(body), { status });
const offline = fetchImpl => createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl });
function wav(ms) { // PCM 16 kHz mono 16-bit header with `ms` of silence
  const data = Math.round(16 * 2 * ms);
  const bytes = new Uint8Array(44 + data);
  const view = new DataView(bytes.buffer);
  bytes.set([...'RIFF'].map(c => c.charCodeAt(0)), 0); view.setUint32(4, 36 + data, true);
  bytes.set([...'WAVEfmt '].map(c => c.charCodeAt(0)), 8); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  bytes.set([...'data'].map(c => c.charCodeAt(0)), 36); view.setUint32(40, data, true);
  return bytes;
}

test('disabled by default: no network, refuses like the old stub', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('no'); };
  const off = createGnaniVoiceProvider({ env: { GNANI_API_KEY_ID: 'k', GNANI_VOICE_ENABLED: 'yes' }, fetchImpl });
  await assert.rejects(() => off.transcribe(turn()), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
  await assert.rejects(() => off.synthesize({ authorization: grant, text: 'hello', lang: 'en-IN' }), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
  await assert.rejects(() => off.transcribe({ authorization: null }), code('PROVIDER_AUTHORIZATION_REQUIRED'));
  assert.equal(calls, 0);
  assert.equal(createGnaniVoiceProvider({ env: {} }).health().status, 'not_configured');
});

test('transfer and verifyWebhook stay refused even when enabled', async () => {
  const provider = offline(async () => { throw new Error('no'); });
  await assert.rejects(() => provider.transfer({ authorization: true }), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
  await assert.rejects(() => provider.verifyWebhook(), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
});

test('rejects non-https base URL except loopback', async () => {
  const provider = createGnaniVoiceProvider({ env: envFor('http://example.com') });
  await assert.rejects(() => provider.transcribe(turn()), error => error instanceof TypeError);
});

test('requires the exact voice_intake grant naming gnani', async () => {
  const provider = offline(async () => { throw new Error('must not call'); });
  for (const authorization of [
    undefined, true, { authorized: true },
    { authorized: false, purpose: 'voice_intake', recipients: ['gnani'] },
    { authorized: true, purpose: 'document_processing', recipients: ['gnani'] },
    { authorized: true, purpose: 'voice_intake', recipients: ['sarvam'] },
    { authorized: true, purpose: 'voice_intake', recipient: 'gnani' },
  ]) {
    await assert.rejects(() => provider.transcribe(turn({ authorization })), code('PROVIDER_AUTHORIZATION_REQUIRED'));
    await assert.rejects(() => provider.synthesize({ authorization, text: 'hi', lang: 'en-IN' }), code('PROVIDER_AUTHORIZATION_REQUIRED'));
  }
});

test('caps are checked before any network: 512 KB, duration, mime (webm refused), language, tts words, voice', async () => {
  let calls = 0;
  const provider = offline(async () => { calls += 1; return sttOk(); });
  assert.equal(GNANI_LIMITS.maxAudioBytes, 512 * 1024);
  assert.equal(GNANI_LIMITS.maxDurationMs, 15_000);
  await assert.rejects(() => provider.transcribe(turn({ audio: new Uint8Array(512 * 1024 + 1) })), code('VOICE_AUDIO_TOO_LARGE'));
  await assert.rejects(() => provider.transcribe(turn({ audio: new Uint8Array(0) })), code('VOICE_AUDIO_INVALID'));
  await assert.rejects(() => provider.transcribe(turn({ maxDurationMs: 15_001 })), code('VOICE_DURATION_INVALID'));
  await assert.rejects(() => provider.transcribe(turn({ maxDurationMs: 0 })), code('VOICE_DURATION_INVALID'));
  await assert.rejects(() => provider.transcribe(turn({ mime: 'audio/webm;codecs=opus' })), code('VOICE_AUDIO_TYPE_UNSUPPORTED'));
  await assert.rejects(() => provider.transcribe(turn({ mime: 'audio/flac' })), code('VOICE_AUDIO_TYPE_UNSUPPORTED'));
  await assert.rejects(() => provider.transcribe(turn({ lang: 'ta-IN' })), code('VOICE_LANGUAGE_UNSUPPORTED'));
  await assert.rejects(() => provider.transcribe(turn({ audio: wav(16_000), maxDurationMs: 15_000 })), code('VOICE_AUDIO_TOO_LONG'));
  await assert.rejects(() => provider.transcribe(turn({ audio: wav(50) })), code('VOICE_AUDIO_INVALID'));
  const words = n => Array.from({ length: n }, () => 'word').join(' ');
  await assert.rejects(() => provider.synthesize({ authorization: grant, text: words(26), lang: 'en-IN' }), code('VOICE_TEXT_TOO_LONG'));
  await assert.rejects(() => provider.synthesize({ authorization: grant, text: 'hi', lang: 'ta-IN' }), code('VOICE_LANGUAGE_UNSUPPORTED'));
  assert.equal(calls, 0);
  // exactly 512 KB is allowed
  assert.equal((await provider.transcribe(turn({ audio: new Uint8Array(512 * 1024) }))).provider, 'gnani');
  assert.equal(calls, 1);
});

test('TTS needs GNANI_TTS_VOICE (no default voice in code)', async () => {
  let calls = 0;
  const env = { ...envFor('http://127.0.0.1:9') };
  delete env.GNANI_TTS_VOICE;
  const provider = createGnaniVoiceProvider({ env, fetchImpl: async () => { calls += 1; return new Response(''); } });
  await assert.rejects(() => provider.synthesize({ authorization: grant, text: 'hello', lang: 'en-IN' }), code('VOICE_VOICE_NOT_CONFIGURED'));
  assert.equal(calls, 0);
});

test('happy paths against the stub: multipart STT, binary TTS, header auth only', async () => {
  const seen = [];
  const stub = await startGnaniStub({ onRequest: request => seen.push(request) });
  try {
    const provider = createGnaniVoiceProvider({ env: envFor(stub.url) });
    const heard = await provider.transcribe(turn({ audio: wav(1500), lang: 'hi-en' }));
    assert.deepEqual(heard, { transcript: 'synthetic test transcript', lang: 'hi-en', durationMs: 1500, provider: 'gnani', requestId: 'stub-request-1' });
    const ogg = await provider.transcribe(turn({ mime: 'audio/ogg;codecs=opus', lang: 'hi-IN' }));
    assert.equal(ogg.durationMs, null);
    const spoken = await provider.synthesize({ authorization: grant, text: 'Please upload a policy.', lang: 'en-IN' });
    assert.equal(spoken.mime, 'audio/ogg');
    assert.ok(spoken.audio instanceof Uint8Array && spoken.audio.byteLength > 0);
    assert.equal(seen[0].path, '/stt/v3');
    assert.match(seen[0].headers['content-type'], /^multipart\/form-data/);
    assert.equal(seen[0].headers['x-api-key-id'], 'test-key-id');
    assert.match(seen[0].headers['x-api-request-id'], /^[0-9a-f-]{36}$/);
    assert.ok(!seen[0].path.includes('test-key-id'));
    const form = await new Response(seen[0].body, { headers: { 'content-type': seen[0].headers['content-type'] } }).formData();
    assert.equal(form.get('language_code'), 'hi-IN,en-IN');
    assert.equal(form.get('model'), 'prisma-v3.0');
    assert.equal(form.get('audio_file').name, 'audio.wav');
    const tts = JSON.parse(seen[2].body.toString());
    assert.equal(seen[2].path, '/api/v1/tts/inference');
    assert.deepEqual([tts.voice, tts.model, tts.language, tts.speed], ['test-voice', 'timbre-v3.0', 'en-IN', 1]);
    assert.equal(tts.audio_config.encoding, 'oggopus');
  } finally { await stub.close(); }
});

test('truncated transcript is refused; empty transcript is not an error', async () => {
  await assert.rejects(() => offline(async () => sttOk({ truncated: true })).transcribe(turn()), error => error.code === 'VOICE_TRANSCRIPT_TRUNCATED' && error.retryable === false);
  const empty = await offline(async () => sttOk({ transcript: '' })).transcribe(turn());
  assert.equal(empty.transcript, '');
  await assert.rejects(() => offline(async () => new Response('not json', { status: 200 })).transcribe(turn()), code('VOICE_PROVIDER_RESPONSE_INVALID'));
});

test('each provider error class maps to a coded client-safe error', async () => {
  const flat = { success: false, message: 'secret detail', status_code: 500 };
  const cases = [
    [400, { success: false, error: { type: 'INVALID_LANGUAGE_CODE', message: 'secret detail' } }, 'VOICE_PROVIDER_INPUT_REJECTED', false],
    [400, { success: false, error: { type: 'UNSUPPORTED_AUDIO_FORMAT', message: 'secret detail' } }, 'VOICE_PROVIDER_INPUT_REJECTED', false],
    [400, { success: false, error: { type: 'EMPTY_AUDIO', message: 'secret detail' } }, 'VOICE_AUDIO_INVALID', false],
    [400, { success: false, error: { type: 'MAX_AUDIO_DURATION_EXCEEDED', message: 'secret detail' } }, 'VOICE_AUDIO_TOO_LONG', false],
    [422, { detail: [{ msg: 'secret detail' }] }, 'VOICE_PROVIDER_INPUT_REJECTED', false],
    [401, { detail: { error_code: 'INVALID_API_KEY', message: 'secret detail', status_code: 401 } }, 'VOICE_PROVIDER_AUTHENTICATION_FAILED', false],
    [402, { detail: { error_code: 'NO_CREDIT', message: 'secret detail', status_code: 402 } }, 'VOICE_PROVIDER_ENTITLEMENT_REQUIRED', false],
    [403, { detail: { error_code: 'SCOPE_NOT_ALLOWED', message: 'secret detail', status_code: 403 } }, 'VOICE_PROVIDER_FORBIDDEN', false],
    [429, { detail: { error_code: 'RATE_LIMITED', message: 'secret detail', status_code: 429 } }, 'VOICE_PROVIDER_RATE_LIMITED', true],
    [500, { success: false, error: { type: 'TRANSCRIPTION_FAILED', message: 'secret detail' } }, 'VOICE_PROVIDER_UNAVAILABLE', true],
    [500, { success: false, error: { type: 'INTERNAL_SERVER_ERROR', message: 'secret detail' } }, 'VOICE_PROVIDER_UNAVAILABLE', true],
    [504, { success: false, error: { type: 'UPSTREAM_TIMEOUT', message: 'secret detail' } }, 'VOICE_PROVIDER_TIMEOUT', true],
  ];
  for (const [status, body, expected, retryable] of cases) {
    await assert.rejects(() => offline(withStatus(status, body)).transcribe(turn()),
      error => error.code === expected && error.retryable === retryable && !/secret detail/.test(error.message), `${status} ${expected}`);
  }
  await assert.rejects(() => offline(withStatus(500, flat)).synthesize({ authorization: grant, text: 'hi', lang: 'en-IN' }),
    error => error.code === 'VOICE_PROVIDER_UNAVAILABLE' && !/secret detail/.test(error.message));
  await assert.rejects(() => offline(async () => { throw new Error('boom'); }).transcribe(turn()), error => error.code === 'VOICE_PROVIDER_NETWORK' && error.retryable === true);
});

test('breaker counts only retryable failures (429 opens it, 402 does not), opens 60 s, then recovers', async () => {
  let clock = 1_000;
  let calls = 0;
  let mode = 429;
  const fetchImpl = async () => { calls += 1; return mode === 'ok' ? sttOk() : new Response('{}', { status: mode }); };
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl, now: () => clock });
  mode = 402;
  for (let i = 0; i < 5; i += 1) await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_ENTITLEMENT_REQUIRED'));
  assert.equal(provider.health().breakerOpen, false);
  mode = 429;
  for (let i = 0; i < 3; i += 1) await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_RATE_LIMITED'));
  const before = calls;
  assert.equal(provider.health().breakerOpen, true);
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_BUSY'));
  assert.equal(calls, before);
  clock += 59_000;
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_BUSY'));
  clock += 2_000;
  mode = 'ok';
  assert.equal((await provider.transcribe(turn())).transcript, 'ok');
  assert.equal(provider.health().breakerOpen, false);
  mode = 500;
  await assert.rejects(() => provider.transcribe(turn()));
  await assert.rejects(() => provider.transcribe(turn()));
  assert.equal(provider.health().breakerOpen, false);
});

test('a failed half-open trial reopens the breaker immediately', async () => {
  let clock = 0;
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl: withStatus(503), now: () => clock });
  for (let i = 0; i < 3; i += 1) await assert.rejects(() => provider.transcribe(turn()));
  clock += 61_000;
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_UNAVAILABLE'));
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_BUSY'));
});

test('single-flight: one active request, queue of 5 waits in order, the 6th queued is refused', async () => {
  let active = 0;
  let peak = 0;
  const started = [];
  const gates = [];
  const fetchImpl = async () => {
    active += 1; peak = Math.max(peak, active);
    started.push(started.length);
    await new Promise(resolve => gates.push(resolve));
    active -= 1;
    return sttOk();
  };
  const provider = offline(fetchImpl);
  const flights = Array.from({ length: 6 }, () => provider.transcribe(turn())); // 1 active + 5 queued
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(started.length, 1); // the second call waits
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_BUSY')); // 6th waiting is refused
  assert.equal(provider.health().breakerOpen, false);
  for (let i = 0; i < 6; i += 1) {
    while (gates.length <= i) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(started.length, i + 1);
    gates[i]();
  }
  const results = await Promise.all(flights);
  assert.equal(results.length, 6);
  assert.equal(peak, 1);
  // slot freed: works again
  const again = provider.transcribe(turn());
  while (gates.length < 7) await new Promise(resolve => setTimeout(resolve, 5));
  gates[6]();
  await again;
});

test('transcripts and text never reach the console', async () => {
  const spies = {};
  const logged = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) {
    spies[method] = console[method];
    console[method] = (...args) => logged.push(args.join(' '));
  }
  const stub = await startGnaniStub();
  try {
    const provider = createGnaniVoiceProvider({ env: envFor(stub.url) });
    await provider.transcribe(turn());
    await provider.synthesize({ authorization: grant, text: 'Distinct sentence marker.', lang: 'en-IN' });
    await assert.rejects(() => provider.transcribe(turn({ mime: 'bad' })));
  } finally {
    Object.assign(console, spies);
    await stub.close();
  }
  assert.deepEqual(logged.filter(line => /synthetic test transcript|Distinct sentence marker/.test(line)), []);
});

test('cache policy: static strings cached, numbers, dates, amounts and names never', async () => {
  for (const text of ['Please upload your policy document.', 'क्या आप पॉलिसी अपलोड करना चाहते हैं?']) assert.equal(isCacheableSpeech(text), true, text);
  for (const text of [
    'Your cover is 5 lakh', 'Sum insured is five lakh', 'Premium is Rs 500', 'Cover is ₹5,00,000', 'Waiting ends in March',
    'पांच लाख का कवर', '५ लाख', 'दो हज़ार रुपये', 'ek crore ka cover', 'twenty hazaar', 'Renewal on 12/03/2027', 'Due today', '', '   ',
  ]) assert.equal(isCacheableSpeech(text), false, text);

  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'content-type': 'audio/ogg' } }); };
  const provider = offline(fetchImpl);
  const say = (text, lang = 'en-IN') => provider.synthesize({ authorization: grant, text, lang, voice: 'a' });
  await say('Please upload your policy.'); await say('Please upload your policy.');
  assert.equal(calls, 1);
  await say('Please upload your plan.');
  assert.equal(calls, 2);
  await say('Cover is 5 lakh'); await say('Cover is 5 lakh');
  assert.equal(calls, 4);
  await say('Please upload your policy.', 'hi-IN');
  assert.equal(calls, 5); // key includes lang
});

test('cache is LRU capped at 500 by default', () => {
  const cache = createTtsCache();
  for (let i = 0; i < 520; i += 1) cache.set(`phrase ${'x'.repeat(i % 7)}${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} ok`, 'en-IN', 'v', { i });
  assert.equal(cache.size, 500);
  const small = createTtsCache({ maxEntries: 2 });
  small.set('alpha', 'en-IN', 'v', 1); small.set('beta', 'en-IN', 'v', 2);
  small.get('alpha', 'en-IN', 'v');
  small.set('gamma', 'en-IN', 'v', 3);
  assert.equal(small.get('beta', 'en-IN', 'v'), null);
  assert.equal(small.get('alpha', 'en-IN', 'v'), 1);
  assert.equal(small.set('has 7 digit', 'en-IN', 'v', 4), false);
});

test('queued call is refused with a retryable busy error after the wait cap (fake clock), and the metric is numbers only', async () => {
  let clock = 0;
  const timersFired = [];
  const timers = { setTimeout: (fn, ms) => { const entry = { fn, ms, cleared: false }; timersFired.push(entry); return entry; }, clearTimeout: entry => { entry.cleared = true; } };
  const metrics = [];
  const gate = [];
  const fetchImpl = async () => { await new Promise(resolve => gate.push(resolve)); return sttOk({ transcript: 'private words' }); };
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl, now: () => clock, timers, onMetric: metric => metrics.push(metric) });
  const first = provider.transcribe(turn());
  await new Promise(resolve => setImmediate(resolve));
  const second = provider.transcribe(turn());
  const secondResult = second.then(() => null, error => error);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timersFired.length, 1);
  assert.equal(timersFired[0].ms, 3000); // GNANI_QUEUE_WAIT_MS default
  clock = 3000;
  timersFired[0].fn();
  const error = await secondResult;
  assert.equal(error.code, 'VOICE_PROVIDER_BUSY');
  assert.equal(error.retryable, true);
  assert.equal(provider.health().breakerOpen, false); // busy does not trip the breaker
  gate[0]();
  await first;
  assert.deepEqual(metrics, [{ name: 'voice_queue_wait_ms', value: 0 }, { name: 'voice_queue_wait_ms', value: 3000 }]);
  for (const metric of metrics) {
    assert.deepEqual(Object.keys(metric).sort(), ['name', 'value']);
    assert.equal(typeof metric.value, 'number');
  }
  assert.ok(!JSON.stringify(metrics).includes('private words'));
  // the freed slot works again
  const third = provider.transcribe(turn());
  await new Promise(resolve => setImmediate(resolve));
  gate[1]();
  assert.equal((await third).transcript, 'private words');
});

test('a queued call that gets its turn cancels its wait timer and reports the wait', async () => {
  let clock = 0;
  const timersMade = [];
  const timers = { setTimeout: (fn, ms) => { const entry = { fn, ms, cleared: false }; timersMade.push(entry); return entry; }, clearTimeout: entry => { entry.cleared = true; } };
  const metrics = [];
  const gate = [];
  const provider = createGnaniVoiceProvider({
    env: { ...envFor('http://127.0.0.1:9'), GNANI_QUEUE_WAIT_MS: '1000' }, now: () => clock, timers, onMetric: metric => metrics.push(metric.value),
    fetchImpl: async () => { await new Promise(resolve => gate.push(resolve)); return sttOk(); },
  });
  const first = provider.transcribe(turn());
  await new Promise(resolve => setImmediate(resolve));
  const second = provider.transcribe(turn());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timersMade[0].ms, 1000);
  clock = 400;
  gate[0]();
  await first;
  while (gate.length < 2) await new Promise(resolve => setImmediate(resolve));
  gate[1]();
  await second;
  assert.equal(timersMade[0].cleared, true);
  assert.deepEqual(metrics, [0, 400]);
});

test('base URL is pinned to vachana.ai over https or loopback http (SSRF)', async () => {
  const { validateGnaniBaseUrl } = await import('../src/integrations/gnani/gnani-transport.js');
  assert.equal(validateGnaniBaseUrl('https://api.vachana.ai'), 'https://api.vachana.ai');
  assert.equal(validateGnaniBaseUrl('https://api.vachana.ai/some/path'), 'https://api.vachana.ai');
  assert.equal(validateGnaniBaseUrl('http://127.0.0.1:4010'), 'http://127.0.0.1:4010');
  for (const bad of [
    'https://evil.example', 'https://vachana.ai.evil.example', 'https://evilvachana.ai', 'http://api.vachana.ai',
    'https://api.vachana.ai:8443', 'https://user:pw@api.vachana.ai', 'http://169.254.169.254', 'http://10.0.0.5:80', 'file:///etc/passwd', 'not a url',
  ]) assert.equal(validateGnaniBaseUrl(bad), null, bad);
});
