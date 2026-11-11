import { ANTHROPIC_PROVIDER } from '../anthropic/index.js';
import { GEMINI_PROVIDER } from '../gemini/index.js';
import { DEEPSEEK_PROVIDER } from '../deepseek/index.js';
import { KIMI_PROVIDER } from '../kimi/index.js';
import { OPENAI_PROVIDER } from '../openai/index.js';
import { VOYAGE_PROVIDER } from '../voyage/index.js';

const PROVIDERS = Object.freeze(Object.fromEntries([ANTHROPIC_PROVIDER, GEMINI_PROVIDER, DEEPSEEK_PROVIDER, KIMI_PROVIDER, OPENAI_PROVIDER, VOYAGE_PROVIDER].map(p => [p.id, p])));

// Routing by purpose is data, not code: ordered { provider, tier } preferences. `MODEL_PROVIDERS` (comma list, default
// "anthropic") says which providers are enabled; the first enabled, configured entry wins. `embed` routes to Voyage (ADR 0031);
// enable it with MODEL_PROVIDERS=anthropic,voyage. Without VOYAGE_API_KEY it answers a typed unknown and embeddings are skipped.
export const MODEL_ROUTES = Object.freeze({
  chat_answer: Object.freeze([{ provider: 'anthropic', tier: 'default' }]),
  intent_classify: Object.freeze([{ provider: 'anthropic', tier: 'classify' }]),
  fact_extract: Object.freeze([{ provider: 'anthropic', tier: 'default' }]),
  embed: Object.freeze([{ provider: 'voyage', tier: 'default' }]),
});

const positiveRate = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * Resolves a purpose to { status: 'ready', provider, model, modelVersion, apiKey, inputUsdPerMillion, outputUsdPerMillion }
 * or { status: 'unavailable', reason, provider?, model? }. Keys come from `env` only. Never throws for a missing key.
 */
export function createModelRouter({ env = process.env, routes = MODEL_ROUTES } = {}) {
  const enabled = new Set(String(env.MODEL_PROVIDERS ?? 'anthropic').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  return Object.freeze({
    resolve(purpose) {
      const entries = routes[purpose];
      if (!entries) return { status: 'unavailable', reason: 'no_route' };
      let first = null;
      for (const { provider: id, tier } of entries) {
        const provider = PROVIDERS[id];
        if (!provider || !enabled.has(id)) { first ??= { status: 'unavailable', reason: 'provider_not_enabled', provider: id }; continue; }
        const suffix = tier === 'classify' ? '_CLASSIFY' : '';
        const model = (env[`${provider.envPrefix}${suffix}_MODEL`] || provider.models[tier] || provider.models.default);
        if (!provider.sdk) { first ??= { status: 'unavailable', reason: 'no_sdk_adapter', provider: id, model }; continue; }
        const apiKey = env[provider.keyEnv];
        const inputUsdPerMillion = positiveRate(env[`${provider.envPrefix}${suffix}_INPUT_USD_PER_MILLION`]);
        const outputUsdPerMillion = provider.embeddingOnly ? 0 : positiveRate(env[`${provider.envPrefix}${suffix}_OUTPUT_USD_PER_MILLION`]);
        if (typeof apiKey !== 'string' || !apiKey) { first ??= { status: 'unavailable', reason: 'key_missing', provider: id, model }; continue; }
        if (!inputUsdPerMillion || (!provider.embeddingOnly && !outputUsdPerMillion)) { first ??= { status: 'unavailable', reason: 'rates_missing', provider: id, model }; continue; }
        return { status: 'ready', provider: id, sdk: provider.sdk, model, modelVersion: model, apiKey, inputUsdPerMillion, outputUsdPerMillion };
      }
      return first ?? { status: 'unavailable', reason: 'no_route' };
    },
  });
}
