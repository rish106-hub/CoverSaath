import { createProviderBoundary, ProviderAuthorizationError } from '../shared/index.js';
import { createGnaniTransport, MIME_EXTENSIONS } from './gnani-transport.js';
import { createTtsCache } from './tts-cache.js';

export const GNANI_LIMITS = Object.freeze({ maxAudioBytes: 512 * 1024, maxDurationMs: 15_000, maxTtsWords: 25 });
// webm is not accepted by Gnani STT: the client encodes 16 kHz mono WAV (15 s is about 480 KB plus header).
const MIMES = new Set(Object.keys(MIME_EXTENSIONS));
const LANGS = new Set(['en-IN', 'hi-IN', 'hi-en']); // hi-en: Hinglish
const MAX_QUEUE = 5;
const MIN_DURATION_MS = 100;
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;

// Duration of a PCM WAV from its header, else null (Gnani's response carries no duration).
function wavDurationMs(audio) {
  const text = (offset, length) => String.fromCharCode(...audio.subarray(offset, offset + length));
  if (audio.byteLength < 44 || text(0, 4) !== 'RIFF' || text(8, 4) !== 'WAVE') return null;
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength);
  let byteRate = null;
  for (let offset = 12; offset + 8 <= audio.byteLength;) {
    const id = text(offset, 4);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ' && offset + 20 <= audio.byteLength) byteRate = view.getUint32(offset + 16, true);
    if (id === 'data') return byteRate ? Math.round((Math.min(size, audio.byteLength - offset - 8) / byteRate) * 1000) : null;
    offset += 8 + size + (size % 2);
  }
  return null;
}

const busy = () => Object.assign(new Error('Voice is busy. Type instead.'), { code: 'VOICE_PROVIDER_BUSY', statusCode: 503, retryable: true });
const fail = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode, retryable: false });

// Off unless GNANI_VOICE_ENABLED is exactly 'true'. Wire format comes from docs.gnani.ai and is not exercised live
// (see gnani-transport.js), so capabilities stay `configured_not_verified`. `transfer` and `verifyWebhook` stay refused.
export function createGnaniVoiceProvider({ env = process.env, transport = null, fetchImpl, now = Date.now, cache = createTtsCache(), onMetric = () => {}, timers = { setTimeout, clearTimeout } } = {}) {
  const enabled = env?.GNANI_VOICE_ENABLED === 'true';
  const boundary = createProviderBoundary({
    provider: 'Gnani',
    env,
    requiredSettings: ['GNANI_API_KEY_ID'],
    role: 'Consented speech transcription and read-back. Calling and transfer are not verified capabilities.',
  });
  let resolved = transport;
  const getTransport = () => {
    if (resolved) return resolved;
    resolved = createGnaniTransport({
      baseUrl: env.GNANI_BASE_URL || undefined, apiKeyId: env.GNANI_API_KEY_ID, fetchImpl,
      timeoutMs: env.GNANI_TIMEOUT_MS === undefined ? 10_000 : Number(env.GNANI_TIMEOUT_MS),
    });
    return resolved;
  };

  let failures = 0;
  let openedAt = null;
  const breakerCheck = () => {
    if (openedAt === null) return;
    if (now() - openedAt < BREAKER_OPEN_MS) throw busy(); // same code as a full queue: the UI shows "Busy, type instead"
    openedAt = null; // half-open: one trial call
    failures = BREAKER_THRESHOLD - 1;
  };
  // The account allows ONE active request, so calls run single-flight with at most MAX_QUEUE waiting, each for at most
  // queueWaitMs (GNANI_QUEUE_WAIT_MS, default 3000). Past the cap the call is refused and its reference dropped; audio is
  // only ever held in memory. In process only: several machines need a shared DB lease (ADR 0022 D5).
  const queueWaitMs = env?.GNANI_QUEUE_WAIT_MS === undefined ? 3000 : Number(env.GNANI_QUEUE_WAIT_MS);
  const metric = value => { try { onMetric({ name: 'voice_queue_wait_ms', value }); } catch { /* metrics never break a call */ } }; // a number only
  let active = false;
  const waiters = [];
  const acquire = async () => {
    if (!active) { active = true; metric(0); return; }
    if (waiters.length >= MAX_QUEUE) throw busy();
    const startedAt = now();
    await new Promise((resolve, reject) => {
      const waiter = { resolve: () => { timers.clearTimeout(timer); resolve(); } };
      const timer = timers.setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        metric(now() - startedAt);
        reject(busy());
      }, queueWaitMs);
      waiters.push(waiter); // slot is handed over with `active` still true
    });
    metric(now() - startedAt);
  };
  const release = () => { const next = waiters.shift(); if (next) next.resolve(); else active = false; };
  async function guarded(work) {
    breakerCheck();
    await acquire();
    try {
      const result = await work();
      failures = 0;
      return result;
    } catch (error) {
      if (error?.retryable === true) {
        failures += 1;
        if (failures >= BREAKER_THRESHOLD) openedAt = now();
      }
      throw error;
    } finally {
      release();
    }
  }

  function authorize(authorization) {
    // Off (or key missing): behave exactly like the old refuse-only stub, no network.
    if (!enabled || boundary.health().status === 'not_configured') return boundary.refuse({ authorization });
    // Exact current voice_intake grant naming gnani. No recipient list existed on authorizations (Sarvam uses a single
    // `recipient`), so a required `recipients` array is the check here; the caller builds it from the live grant.
    if (authorization?.authorized !== true || authorization?.purpose !== 'voice_intake'
      || !Array.isArray(authorization?.recipients) || !authorization.recipients.includes('gnani')) {
      throw new ProviderAuthorizationError('Gnani');
    }
  }

  return {
    name: 'gnani',
    limits: GNANI_LIMITS,
    capabilities: boundary.capability,
    health() {
      const base = boundary.health();
      return { ...base, enabled, breakerOpen: openedAt !== null && now() - openedAt < BREAKER_OPEN_MS };
    },
    async transcribe({ authorization, audio, mime, lang, maxDurationMs } = {}) {
      authorize(authorization);
      if (!(audio instanceof Uint8Array) || audio.byteLength === 0) throw fail('VOICE_AUDIO_INVALID', 'Audio is required.', 422);
      if (audio.byteLength > GNANI_LIMITS.maxAudioBytes) throw fail('VOICE_AUDIO_TOO_LARGE', 'Audio is larger than 512 KB.', 413);
      if (!MIMES.has(mime)) throw fail('VOICE_AUDIO_TYPE_UNSUPPORTED', 'Audio type is not supported.', 415);
      if (!LANGS.has(lang)) throw fail('VOICE_LANGUAGE_UNSUPPORTED', 'Language is not supported.', 422);
      if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > GNANI_LIMITS.maxDurationMs) {
        throw fail('VOICE_DURATION_INVALID', 'Maximum duration must be between 1 ms and 15 s.', 422);
      }
      const durationMs = mime === 'audio/wav' ? wavDurationMs(audio) : null;
      if (durationMs !== null && durationMs > maxDurationMs) throw fail('VOICE_AUDIO_TOO_LONG', 'Audio is longer than the allowed duration.', 422);
      if (durationMs !== null && durationMs < MIN_DURATION_MS) throw fail('VOICE_AUDIO_INVALID', 'Audio is too short.', 422);
      const result = await guarded(() => getTransport().transcribe({ audio, mime, lang }));
      return { transcript: result.transcript, lang, durationMs, provider: 'gnani', requestId: result.requestId };
    },
    async synthesize({ authorization, text, lang, voice = env?.GNANI_TTS_VOICE } = {}) {
      authorize(authorization);
      if (typeof text !== 'string' || text.trim() === '') throw fail('VOICE_TEXT_INVALID', 'Text is required.', 422);
      if (text.trim().split(/\s+/).length > GNANI_LIMITS.maxTtsWords) throw fail('VOICE_TEXT_TOO_LONG', 'Speech text is limited to 25 words.', 422);
      if (!LANGS.has(lang)) throw fail('VOICE_LANGUAGE_UNSUPPORTED', 'Language is not supported.', 422);
      // No default voice name in code: GNANI_TTS_VOICE must be set. v3.0 voices speak all supported languages.
      if (typeof voice !== 'string' || voice.trim() === '') throw fail('VOICE_VOICE_NOT_CONFIGURED', 'No voice is configured.', 503);
      if (voice.length > 40) throw fail('VOICE_VOICE_INVALID', 'Voice is invalid.', 422);
      const cached = cache.get(text, lang, voice);
      if (cached) return { audio: cached.audio, mime: cached.mime };
      const result = await guarded(() => getTransport().synthesize({ text, lang, voice }));
      cache.set(text, lang, voice, result);
      return result;
    },
    async transfer({ authorization } = {}) {
      return boundary.refuse({ authorization });
    },
    async verifyWebhook() {
      return boundary.refuse({ authorizationRequired: false });
    },
  };
}
