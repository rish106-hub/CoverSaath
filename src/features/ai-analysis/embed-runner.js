import { PROMPT_VERSION } from './prompts.js';
import { AI_CONTRACT_VERSION } from './responsibility-matrix.js';
import { isGatewayRequest } from './model-gateway.js';

// Gateway runner for the `embed` task (ADR 0031). Like ai-sdk-runner.js it serves only a request the gateway built after its
// sealed-input check, so an embedding call is gated, budgeted and audited exactly like a chat call. The provider client is
// injected (src/integrations/voyage); this file holds no key and no URL.
//
// No input_type is sent (the same vector space serves stored passages and questions; Voyage documents null as valid).
export function createEmbedRunner({ client, provider, model, inputUsdPerMillion } = {}) {
  if (!client || typeof client.embed !== 'function') throw new TypeError('An embedding client is required.');
  for (const [label, value] of Object.entries({ provider, model })) if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  if (!Number.isFinite(inputUsdPerMillion) || inputUsdPerMillion <= 0) throw new TypeError('inputUsdPerMillion must be a verified positive rate.');
  return async function runEmbed(request) {
    if (!isGatewayRequest(request)) throw Object.assign(new Error('Model input did not come from the privacy gate.'), { code: 'ungated_model_input', modelDispatched: false });
    const startedAt = Date.now();
    // A sealed input holds each gated slot as its text.
    const texts = request.input.payload.texts.map(entry => entry.text);
    const result = await client.embed({ texts, signal: request.abortSignal });
    const dimensions = result.vectors[0]?.length ?? 0;
    return {
      output: { status: 'extracted_unverified', dimensions, vectors: result.vectors },
      metadata: {
        contractVersion: AI_CONTRACT_VERSION, mode: 'live', provider, model, modelVersion: model, promptVersion: PROMPT_VERSION,
        inputTokens: result.totalTokens, outputTokens: 0, totalTokens: result.totalTokens, calls: 1, latencyMs: Date.now() - startedAt,
        costUsd: (result.totalTokens * inputUsdPerMillion) / 1_000_000,
      },
    };
  };
}
