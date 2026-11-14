// Wire format from docs.gnani.ai (read 2026-11-14); not exercised live.
// Docs ("last verified 5 Aug 2026"): https://docs.gnani.ai (Vachana STT v3 REST, TTS inference, auth and error pages).
// Base https://api.vachana.ai. Auth: header X-API-Key-ID only. Optional X-API-Request-ID (random uuid; the response
// request_id is kept for correlation). Swapping the contract means editing this one file only.
// STT  POST /stt/v3 multipart: audio_file (filename extension sets the format; wav mp3 ogg flac aac m4a, NOT webm),
//      language_code (en-IN | hi-IN | "hi-IN,en-IN" for Hinglish), model (prisma-v3.0). REST max 30 s, min 0.1 s (we cap clips at 15 s).
// TTS  POST /api/v1/tts/inference JSON, model timbre-v3.0; 200 is raw audio/ogg bytes (not JSON). v3.0 voices speak
//      all 10 supported languages, so no voice list is hardcoded here; the voice name comes from GNANI_TTS_VOICE.
// TODO: streaming STT over WSS /stt/v3/stream (raw PCM s16le 1024-byte frames, VAD headers) is out of scope for v1.
// Credentials stay in headers on this server boundary. Audio, transcripts and text are never logged here, and the
// provider's own error message is never surfaced to clients.
import { randomUUID } from 'node:crypto';

export const DEFAULT_GNANI_BASE_URL = 'https://api.vachana.ai';
const STT_MODEL = 'prisma-v3.0';
const TTS_MODEL = 'timbre-v3.0';
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MIME_EXTENSIONS = Object.freeze({
  'audio/wav': 'wav', 'audio/ogg;codecs=opus': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
});
const STT_LANGUAGE_CODES = Object.freeze({ 'en-IN': 'en-IN', 'hi-IN': 'hi-IN', 'hi-en': 'hi-IN,en-IN' });
const AUDIO_CONFIG = Object.freeze({ sample_rate: 24000, num_channels: 1, sample_width: 2, encoding: 'oggopus', container: 'ogg' });
const fail = (code, message, retryable = false, statusCode = 502) => Object.assign(new Error(message), { code, retryable, statusCode });

// Outbound host is pinned: https on Gnani's own domain, or loopback http for the local stub and tests. An operator
// misconfiguration (or a tampered env) can never point the server credential and user audio at another host (SSRF).
const GNANI_HOST = /^(?:[a-z0-9-]+\.)*vachana\.ai$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export function validateGnaniBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password) return null;
  if (url.protocol === 'https:' && GNANI_HOST.test(url.hostname) && !url.port) return url.origin;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url.origin;
  return null;
}

async function readBytes(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw fail('VOICE_PROVIDER_RESPONSE_TOO_LARGE', 'Gnani response is too large.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > max) throw fail('VOICE_PROVIDER_RESPONSE_TOO_LARGE', 'Gnani response is too large.');
  return bytes;
}

async function readErrorBody(response) {
  try { return JSON.parse(new TextDecoder().decode(await readBytes(response, MAX_JSON_BYTES))); } catch { return null; }
}

// Maps status and body to a coded, client-safe error. Retryable: 429, 500, 503, 504 only.
function providerError(status, body) {
  const type = body?.error?.type;
  const authCode = body?.detail?.error_code;
  if (status === 401) return fail('VOICE_PROVIDER_AUTHENTICATION_FAILED', 'Gnani rejected the server credential.', false, 503);
  if (status === 402) return fail('VOICE_PROVIDER_ENTITLEMENT_REQUIRED', 'Gnani credit or entitlement rejected the request.', false, 503);
  if (status === 403) return fail('VOICE_PROVIDER_FORBIDDEN', authCode === 'SCOPE_NOT_ALLOWED' ? 'Gnani key scope does not allow this.' : 'Gnani refused this request.', false, 403);
  if (status === 429) return fail('VOICE_PROVIDER_RATE_LIMITED', 'Gnani rate limit reached.', true, 429);
  if (status === 504) return fail('VOICE_PROVIDER_TIMEOUT', 'Gnani timed out upstream.', true, 503);
  if (status === 503) return fail('VOICE_PROVIDER_UNAVAILABLE', 'Gnani is unavailable.', true, 503);
  if (status === 500) return fail('VOICE_PROVIDER_UNAVAILABLE', 'Gnani failed to process the request.', true, 503);
  if (status === 400 && type === 'MAX_AUDIO_DURATION_EXCEEDED') return fail('VOICE_AUDIO_TOO_LONG', 'Audio is longer than the allowed duration.', false, 422);
  if (status === 400 && type === 'EMPTY_AUDIO') return fail('VOICE_AUDIO_INVALID', 'Audio is empty.', false, 422);
  if (status === 400 || status === 413 || status === 415 || status === 422) return fail('VOICE_PROVIDER_INPUT_REJECTED', 'Gnani rejected the input.', false, 422);
  return fail('VOICE_PROVIDER_FAILED', 'Gnani request failed.', false, 502);
}

export function createGnaniTransport({ baseUrl = DEFAULT_GNANI_BASE_URL, apiKeyId, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const origin = validateGnaniBaseUrl(baseUrl);
  if (!origin) throw new TypeError('Gnani base URL must be https on vachana.ai (loopback http is allowed for tests).');
  if (typeof apiKeyId !== 'string' || apiKeyId.trim() === '') throw new TypeError('Gnani API key id is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('Invalid Gnani timeout.');

  async function send(path, init) {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'X-API-Key-ID': apiKeyId.trim(), 'X-API-Request-ID': randomUUID(), ...init.headers },
      });
    } catch {
      throw fail('VOICE_PROVIDER_NETWORK', 'Gnani request failed or timed out.', true, 503);
    }
    if (!response.ok) throw providerError(response.status, await readErrorBody(response));
    return response;
  }

  return Object.freeze({
    async transcribe({ audio, mime, lang }) {
      const extension = MIME_EXTENSIONS[mime];
      const languageCode = STT_LANGUAGE_CODES[lang];
      if (!extension || !languageCode) throw fail('VOICE_PROVIDER_INPUT_REJECTED', 'Gnani rejected the input.', false, 422);
      const form = new FormData();
      form.append('audio_file', new Blob([audio], { type: mime.split(';')[0] }), `audio.${extension}`);
      form.append('language_code', languageCode);
      form.append('model', STT_MODEL);
      const response = await send('/stt/v3', { method: 'POST', body: form });
      let body;
      try { body = JSON.parse(new TextDecoder().decode(await readBytes(response, MAX_JSON_BYTES))); } catch (error) {
        if (error?.code) throw error;
        throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned malformed JSON.');
      }
      if (body === null || typeof body !== 'object' || body.success !== true || typeof body.transcript !== 'string') {
        throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned an unexpected response.');
      }
      if (body.truncated === true) throw fail('VOICE_TRANSCRIPT_TRUNCATED', 'The recording was cut off. Try a shorter message.', false, 422);
      return { transcript: body.transcript, requestId: typeof body.request_id === 'string' ? body.request_id.slice(0, 100) : null };
    },
    async synthesize({ text, lang, voice }) {
      const response = await send('/api/v1/tts/inference', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, voice, model: TTS_MODEL, language: lang, speed: 1.0, audio_config: AUDIO_CONFIG }),
      });
      const mime = (response.headers?.get?.('content-type') ?? '').split(';')[0].trim();
      if (!/^audio\//.test(mime)) throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned an unexpected response.');
      const audio = await readBytes(response, MAX_AUDIO_RESPONSE_BYTES);
      if (audio.byteLength === 0) throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned empty audio.');
      return { audio, mime };
    },
  });
}
