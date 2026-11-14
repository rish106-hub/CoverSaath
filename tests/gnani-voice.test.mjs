import test from 'node:test';
import assert from 'node:assert/strict';
import { createGnaniVoiceProvider, createTtsCache, isCacheableSpeech } from '../src/integrations/gnani/index.js';
import { startGnaniStub } from '../scripts/gnani-stub.mjs';

const grant = { authorized: true, purpose: 'voice_intake', recipients: ['gnani'] };
const audio = new Uint8Array([1, 2, 3, 4]);
const turn = extra => ({ authorization: grant, audio, mime: 'audio/wav', lang: 'en-IN', maxDurationMs: 30_000, ...extra });
const envFor = url => ({ GNANI_VOICE_ENABLED: 'true', GNANI_BASE_URL: url, GNANI_API_KEY_ID: 'test-key-id', GNANI_API_SECRET: 'test-secret' });
const code = expected => error => error.code === expected;

test('disabled by default: no network, refuses like the old stub', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('no'); };
  const off = createGnaniVoiceProvider({ env: { GNANI_API_KEY_ID: 'k', GNANI_BASE_URL: 'http://127.0.0.1:1', GNANI_VOICE_ENABLED: 'yes' }, fetchImpl });
  await assert.rejects(() => off.transcribe(turn()), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
  await assert.rejects(() => off.synthesize({ authorization: grant, text: 'hello', lang: 'en-IN' }), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
  await assert.rejects(() => off.transcribe({ authorization: null }), code('PROVIDER_AUTHORIZATION_REQUIRED'));
  assert.equal(calls, 0);
  assert.equal(createGnaniVoiceProvider({ env: {} }).health().status, 'not_configured');
});

test('transfer and verifyWebhook stay refused even when enabled', async () => {
  const stub = await startGnaniStub();
  try {
    const provider = createGnaniVoiceProvider({ env: envFor(stub.url) });
    await assert.rejects(() => provider.transfer({ authorization: true }), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
    await assert.rejects(() => provider.verifyWebhook(), code('PROVIDER_CONTRACT_NOT_VERIFIED'));
  } finally { await stub.close(); }
});

test('rejects non-https base URL except loopback', async () => {
  const provider = createGnaniVoiceProvider({ env: envFor('http://example.com') });
  await assert.rejects(() => provider.transcribe(turn()), error => error instanceof TypeError);
});

test('requires the exact voice_intake grant naming gnani', async () => {
  const stub = await startGnaniStub();
  try {
    const provider = createGnaniVoiceProvider({ env: envFor(stub.url) });
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
  } finally { await stub.close(); }
});

test('caps: audio size, duration, mime, language, tts words', async () => {
  const stub = await startGnaniStub();
  try {
    const provider = createGnaniVoiceProvider({ env: envFor(stub.url) });
    await assert.rejects(() => provider.transcribe(turn({ audio: new Uint8Array(512 * 1024 + 1) })), code('VOICE_AUDIO_TOO_LARGE'));
    await assert.rejects(() => provider.transcribe(turn({ audio: new Uint8Array(0) })), code('VOICE_AUDIO_INVALID'));
    await assert.rejects(() => provider.transcribe(turn({ maxDurationMs: 30_001 })), code('VOICE_DURATION_INVALID'));
    await assert.rejects(() => provider.transcribe(turn({ maxDurationMs: 0 })), code('VOICE_DURATION_INVALID'));
    await assert.rejects(() => provider.transcribe(turn({ mime: 'audio/mp3' })), code('VOICE_AUDIO_TYPE_UNSUPPORTED'));
    await assert.rejects(() => provider.transcribe(turn({ lang: 'ta-IN' })), code('VOICE_LANGUAGE_UNSUPPORTED'));
    const words = n => Array.from({ length: n }, () => 'word').join(' ');
    await assert.rejects(() => provider.synthesize({ authorization: grant, text: words(26), lang: 'en-IN' }), code('VOICE_TEXT_TOO_LONG'));
    const ok = await provider.synthesize({ authorization: grant, text: words(25), lang: 'en-IN' });
    assert.equal(ok.mime, 'audio/wav');
    // exactly 512 KB is allowed
    assert.equal((await provider.transcribe(turn({ audio: new Uint8Array(512 * 1024) }))).provider, 'gnani');
  } finally { await stub.close(); }
});

test('over-long transcript duration from provider is refused', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ transcript: 'x', duration_ms: 9000 }), { status: 200 });
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl });
  await assert.rejects(() => provider.transcribe(turn({ maxDurationMs: 5000 })), code('VOICE_AUDIO_TOO_LONG'));
});

test('happy paths against the stub, credentials sent as headers only', async () => {
  const seen = [];
  const stub = await startGnaniStub({ onRequest: request => seen.push(request) });
  try {
    const provider = createGnaniVoiceProvider({ env: envFor(stub.url) });
    const heard = await provider.transcribe(turn({ lang: 'hi-IN', mime: 'audio/ogg;codecs=opus' }));
    assert.deepEqual(heard, { transcript: 'synthetic test transcript', lang: 'hi-IN', durationMs: 1500, provider: 'gnani' });
    const spoken = await provider.synthesize({ authorization: grant, text: 'Please upload a policy.', lang: 'en-IN', voice: 'asha' });
    assert.equal(spoken.mime, 'audio/wav');
    assert.ok(spoken.audio instanceof Uint8Array && spoken.audio.byteLength > 0);
    assert.equal(seen[0].headers['x-api-key-id'], 'test-key-id');
    assert.ok(!seen[0].path.includes('test-key-id'));
    assert.equal(seen[0].headers['content-type'], 'audio/ogg;codecs=opus');
  } finally { await stub.close(); }
});

test('provider errors are coded and client-safe', async () => {
  const statuses = { 401: 'VOICE_PROVIDER_AUTHENTICATION_FAILED', 403: 'VOICE_PROVIDER_FORBIDDEN', 422: 'VOICE_PROVIDER_INPUT_REJECTED' };
  for (const [status, expected] of Object.entries(statuses)) {
    const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl: async () => new Response('secret detail', { status: Number(status) }) });
    await assert.rejects(() => provider.transcribe(turn()), error => error.code === expected && !/secret detail/.test(error.message));
  }
});

test('breaker opens after 3 consecutive failures for 60 s, then recovers', async () => {
  let clock = 1_000;
  let calls = 0;
  let healthy = false;
  const fetchImpl = async () => {
    calls += 1;
    if (!healthy) return new Response('', { status: 503 });
    return new Response(JSON.stringify({ transcript: 'ok', duration_ms: 100 }), { status: 200 });
  };
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl, now: () => clock });
  for (let i = 0; i < 3; i += 1) await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_UNAVAILABLE'));
  assert.equal(calls, 3);
  assert.equal(provider.health().breakerOpen, true);
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_CIRCUIT_OPEN'));
  assert.equal(calls, 3);
  clock += 59_000;
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_CIRCUIT_OPEN'));
  clock += 2_000;
  healthy = true;
  assert.equal((await provider.transcribe(turn())).transcript, 'ok');
  assert.equal(provider.health().breakerOpen, false);
  // a success resets the count: two failures then success then two failures does not open
  healthy = false;
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_UNAVAILABLE'));
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_UNAVAILABLE'));
  assert.equal(provider.health().breakerOpen, false);
});

test('a failed half-open trial reopens the breaker immediately', async () => {
  let clock = 0;
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl: async () => new Response('', { status: 503 }), now: () => clock });
  for (let i = 0; i < 3; i += 1) await assert.rejects(() => provider.transcribe(turn()));
  clock += 61_000;
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_UNAVAILABLE'));
  await assert.rejects(() => provider.transcribe(turn()), code('VOICE_PROVIDER_CIRCUIT_OPEN'));
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
  const fetchImpl = async () => { calls += 1; return new Response(new Uint8Array([9, 9]), { status: 200, headers: { 'content-type': 'audio/wav' } }); };
  const provider = createGnaniVoiceProvider({ env: envFor('http://127.0.0.1:9'), fetchImpl });
  const say = text => provider.synthesize({ authorization: grant, text, lang: 'en-IN', voice: 'a' });
  await say('Please upload your policy.'); await say('Please upload your policy.');
  assert.equal(calls, 1);
  await say('Please upload your policy.'.replace('policy', 'plan'));
  assert.equal(calls, 2);
  await say('Cover is 5 lakh'); await say('Cover is 5 lakh');
  assert.equal(calls, 4);
  await provider.synthesize({ authorization: grant, text: 'Please upload your policy.', lang: 'hi-IN', voice: 'a' });
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
