// UNVERIFIED wire format. No Gnani documentation was read live. Paths, headers, query names and response
// fields below are a placeholder design. Swapping the real contract means editing this one file only;
// the provider (voice-provider.js) sees only { transcript, durationMs } and { audio, mime }.
// Credentials stay in headers on this server boundary. Audio, transcripts and text are never logged here.
const MAX_JSON_BYTES = 64 * 1024;
const MAX_AUDIO_RESPONSE_BYTES = 2 * 1024 * 1024;
const fail = (code, message, retryable = false, statusCode = 502) => Object.assign(new Error(message), { code, retryable, statusCode });

export function validateGnaniBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) return url.origin;
  return null;
}

function providerError(status) {
  if (status === 401) return fail('VOICE_PROVIDER_AUTHENTICATION_FAILED', 'Gnani rejected the server credential.', false, 503);
  if (status === 403) return fail('VOICE_PROVIDER_FORBIDDEN', 'Gnani refused this request.', false, 403);
  if (status === 429) return fail('VOICE_PROVIDER_RATE_LIMITED', 'Gnani rate limit reached.', true, 429);
  if (status === 413) return fail('VOICE_PROVIDER_INPUT_TOO_LARGE', 'Gnani rejected the input size.', false, 413);
  if (status === 400 || status === 415 || status === 422) return fail('VOICE_PROVIDER_INPUT_REJECTED', 'Gnani rejected the input.', false, 422);
  if (status >= 500) return fail('VOICE_PROVIDER_UNAVAILABLE', 'Gnani is unavailable.', true, 503);
  return fail('VOICE_PROVIDER_FAILED', 'Gnani request failed.', false, 502);
}

async function readBytes(response, max) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > max) throw fail('VOICE_PROVIDER_RESPONSE_TOO_LARGE', 'Gnani response is too large.');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > max) throw fail('VOICE_PROVIDER_RESPONSE_TOO_LARGE', 'Gnani response is too large.');
  return bytes;
}

export function createGnaniTransport({ baseUrl, apiKeyId, apiSecret = null, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const origin = validateGnaniBaseUrl(baseUrl);
  if (!origin) throw new TypeError('Gnani base URL must be https (loopback http is allowed for tests).');
  if (typeof apiKeyId !== 'string' || apiKeyId.trim() === '') throw new TypeError('Gnani API key id is required.');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new TypeError('Invalid Gnani timeout.');
  const auth = { 'x-api-key-id': apiKeyId.trim(), ...(apiSecret ? { 'x-api-secret': apiSecret } : {}) };

  async function send(path, init) {
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), headers: { ...auth, ...init.headers } });
    } catch {
      throw fail('VOICE_PROVIDER_NETWORK', 'Gnani request failed or timed out.', true, 503);
    }
    if (!response.ok) throw providerError(response.status);
    return response;
  }

  return Object.freeze({
    async transcribe({ audio, mime, lang, maxDurationMs }) {
      const response = await send(`/v1/stt?lang=${encodeURIComponent(lang)}&max_duration_ms=${maxDurationMs}`, {
        method: 'POST', headers: { 'content-type': mime }, body: audio,
      });
      let body;
      try { body = JSON.parse(new TextDecoder().decode(await readBytes(response, MAX_JSON_BYTES))); } catch (error) {
        if (error?.code) throw error;
        throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned malformed JSON.');
      }
      if (body === null || typeof body !== 'object' || typeof body.transcript !== 'string'
        || !Number.isFinite(body.duration_ms) || body.duration_ms < 0) {
        throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned an unexpected response.');
      }
      return { transcript: body.transcript, durationMs: Math.round(body.duration_ms) };
    },
    async synthesize({ text, lang, voice }) {
      const response = await send('/v1/tts', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang, voice }),
      });
      const mime = (response.headers?.get?.('content-type') ?? '').split(';')[0].trim();
      if (!/^audio\//.test(mime)) throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned an unexpected response.');
      const audio = await readBytes(response, MAX_AUDIO_RESPONSE_BYTES);
      if (audio.byteLength === 0) throw fail('VOICE_PROVIDER_RESPONSE_INVALID', 'Gnani returned empty audio.');
      return { audio, mime };
    },
  });
}
