import { createProviderBoundary, ProviderAuthorizationError } from '../shared/index.js';
import { createGnaniTransport } from './gnani-transport.js';
import { createTtsCache } from './tts-cache.js';

export const GNANI_LIMITS = Object.freeze({ maxAudioBytes: 512 * 1024, maxDurationMs: 30_000, maxTtsWords: 25 });
const MIMES = new Set(['audio/ogg;codecs=opus', 'audio/webm;codecs=opus', 'audio/wav']);
const LANGS = new Set(['en-IN', 'hi-IN']);
const BREAKER_THRESHOLD = 3;
const BREAKER_OPEN_MS = 60_000;

const fail = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode, retryable: false });

// Off unless GNANI_VOICE_ENABLED is exactly 'true'. Wire format is UNVERIFIED (see gnani-transport.js), so
// capabilities stay `configured_not_verified`. `transfer` and `verifyWebhook` stay refused.
export function createGnaniVoiceProvider({ env = process.env, transport = null, fetchImpl, now = Date.now, cache = createTtsCache() } = {}) {
  const enabled = env?.GNANI_VOICE_ENABLED === 'true';
  const boundary = createProviderBoundary({
    provider: 'Gnani',
    env,
    requiredSettings: ['GNANI_API_KEY_ID'],
    role: 'Consented speech transcription and read-back. Calling and transfer are not verified capabilities.',
  });
  const baseConfigured = typeof env?.GNANI_BASE_URL === 'string' && env.GNANI_BASE_URL.trim() !== '';
  let resolved = transport;
  const getTransport = () => {
    if (resolved) return resolved;
    resolved = createGnaniTransport({
      baseUrl: env.GNANI_BASE_URL, apiKeyId: env.GNANI_API_KEY_ID, apiSecret: env.GNANI_API_SECRET || null, fetchImpl,
      timeoutMs: env.GNANI_TIMEOUT_MS === undefined ? 10_000 : Number(env.GNANI_TIMEOUT_MS),
    });
    return resolved;
  };

  let failures = 0;
  let openedAt = null;
  const breakerCheck = () => {
    if (openedAt === null) return;
    if (now() - openedAt < BREAKER_OPEN_MS) throw fail('VOICE_PROVIDER_CIRCUIT_OPEN', 'Voice is temporarily unavailable. Use text.', 503);
    openedAt = null; // half-open: one trial call
    failures = BREAKER_THRESHOLD - 1;
  };
  async function guarded(work) {
    breakerCheck();
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
    }
  }

  function authorize(authorization) {
    // Off (or half configured): behave exactly like the old refuse-only stub, no network.
    if (!enabled || !baseConfigured) return boundary.refuse({ authorization });
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
        throw fail('VOICE_DURATION_INVALID', 'Maximum duration must be between 1 ms and 30 s.', 422);
      }
      const result = await guarded(() => getTransport().transcribe({ audio, mime, lang, maxDurationMs }));
      if (result.durationMs > maxDurationMs) throw fail('VOICE_AUDIO_TOO_LONG', 'Audio is longer than the allowed duration.', 422);
      return { transcript: result.transcript, lang, durationMs: result.durationMs, provider: 'gnani' };
    },
    async synthesize({ authorization, text, lang, voice = 'default' } = {}) {
      authorize(authorization);
      if (typeof text !== 'string' || text.trim() === '') throw fail('VOICE_TEXT_INVALID', 'Text is required.', 422);
      if (text.trim().split(/\s+/).length > GNANI_LIMITS.maxTtsWords) throw fail('VOICE_TEXT_TOO_LONG', 'Speech text is limited to 25 words.', 422);
      if (!LANGS.has(lang)) throw fail('VOICE_LANGUAGE_UNSUPPORTED', 'Language is not supported.', 422);
      if (typeof voice !== 'string' || voice.length < 1 || voice.length > 40) throw fail('VOICE_VOICE_INVALID', 'Voice is invalid.', 422);
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
