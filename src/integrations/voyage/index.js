import { defineModelProvider } from '../shared/model-provider.js';

// Voyage AI embeddings (ADR 0031). Endpoint, body and response shape follow the Voyage embeddings API reference
// (POST https://api.voyageai.com/v1/embeddings; Authorization: Bearer; body { input, model, input_type, output_dimension, truncation };
// response { data: [{ embedding, index }], usage: { total_tokens } }). Key: VOYAGE_API_KEY, from the environment only. Rate:
// VOYAGE_INPUT_USD_PER_MILLION must be set from Voyage's price list (never guessed), else the route is not_configured.
//
// This file only moves text to Voyage and vectors back. It never sees a household: the caller (the gateway embed runner) passes text that
// already went through the privacy gate. Policy: one attempt, a hard timeout, no retry (an embedding is paid for per call; the pipeline
// job retries with backoff and every write after it is idempotent). Errors carry a code only, never the response body.
export const VOYAGE_EMBED_DIMENSIONS = 1024;
export const VOYAGE_PROVIDER = defineModelProvider({
  id: 'voyage', sdk: 'voyage', keyEnv: 'VOYAGE_API_KEY', envPrefix: 'VOYAGE', models: { default: 'voyage-3.5' }, embeddingOnly: true,
});

const ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const MAX_TEXTS = 64;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

/** createVoyageEmbedClient({ apiKey, model, fetchImpl, timeoutMs }) -> { embed({ texts, inputType, signal }) -> { vectors, totalTokens, model } } */
export function createVoyageEmbedClient({ apiKey, model = VOYAGE_PROVIDER.models.default, fetchImpl = globalThis.fetch, timeoutMs = 20_000 } = {}) {
  if (typeof apiKey !== 'string' || apiKey === '') throw Object.assign(new TypeError('A Voyage key is required.'), { code: 'provider_key_missing', modelDispatched: false });
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch function is required.');
  return Object.freeze({
    model,
    async embed({ texts, inputType = null, signal } = {}) {
      if (!Array.isArray(texts) || texts.length === 0 || texts.length > MAX_TEXTS || texts.some(text => typeof text !== 'string' || text === '')) {
        fail('embed_input_invalid', 'Embedding input must be 1 to 64 non-empty texts.');
      }
      if (inputType !== null && !['document', 'query'].includes(inputType)) fail('embed_input_invalid', 'inputType must be null, document or query.');
      const timeout = AbortSignal.timeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ input: texts, model, ...(inputType ? { input_type: inputType } : {}), output_dimension: VOYAGE_EMBED_DIMENSIONS, truncation: false }),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch {
        fail('provider_unreachable', 'The embedding provider could not be reached.');
      }
      if (!response.ok) fail(`provider_http_${response.status}`, 'The embedding provider refused the request.');
      let body;
      try { body = await response.json(); } catch { fail('provider_response_invalid', 'The embedding response was not JSON.'); }
      const rows = Array.isArray(body?.data) ? [...body.data].sort((a, b) => a?.index - b?.index) : [];
      const tokens = body?.usage?.total_tokens;
      if (rows.length !== texts.length || !Number.isInteger(tokens) || tokens < 0
        || rows.some((row, index) => row?.index !== index || !Array.isArray(row.embedding) || row.embedding.length !== VOYAGE_EMBED_DIMENSIONS
          || row.embedding.some(value => !Number.isFinite(value)))) {
        fail('provider_response_invalid', 'The embedding response did not match the request.');
      }
      return Object.freeze({ vectors: rows.map(row => row.embedding), totalTokens: tokens, model });
    },
  });
}
