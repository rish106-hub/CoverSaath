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
//
// Chat-model order: Gemini first, then anthropic, openai, deepseek, kimi. A caller moves to the next entry only when the earlier one
// is unavailable (typed) or its call failed, and only after that provider's own current consent grant is confirmed (chat-runtime.js
// callRouted; the router itself never decides consent). openai, deepseek and kimi have no SDK adapter yet and resolve to a typed
// `no_sdk_adapter` until one is added. FOR LEGAL REVIEW: deepseek and kimi are cross-border processors; keep them out of
// MODEL_PROVIDERS until that review (recommended: MODEL_PROVIDERS=gemini,anthropic,openai,voyage). The default stays "anthropic".
const CHAT_ORDER = ['gemini', 'anthropic', 'openai', 'deepseek', 'kimi'];
const chatRoute = tier => Object.freeze(CHAT_ORDER.map(provider => Object.freeze({ provider, tier })));
export const MODEL_ROUTES = Object.freeze({
  chat_answer: chatRoute('default'),
  intent_classify: chatRoute('classify'),
  fact_extract: chatRoute('default'),
  embed: Object.freeze([{ provider: 'voyage', tier: 'default' }]),
});

const positiveRate = value => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
};

/**
 * `resolve(purpose, { provider? })` -> { status: 'ready', provider, model, modelVersion, apiKey, inputUsdPerMillion, outputUsdPerMillion }
 * or { status: 'unavailable', reason, provider?, model? }. The first ready entry wins; with `provider` only that entry is considered.
 * `candidates(purpose)` -> every ready route in order (the failover list). Keys come from `env` only. Never throws for a missing key.
 */
export function createModelRouter({ env = process.env, routes = MODEL_ROUTES } = {}) {
  const enabled = new Set(String(env.MODEL_PROVIDERS ?? 'anthropic').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  const evaluate = ({ provider: id, tier }) => {
    const provider = PROVIDERS[id];
    if (!provider || !enabled.has(id)) return { status: 'unavailable', reason: 'provider_not_enabled', provider: id, disabled: true };
    const suffix = tier === 'classify' ? '_CLASSIFY' : '';
    const model = (env[`${provider.envPrefix}${suffix}_MODEL`] || provider.models[tier] || provider.models.default);
    if (!provider.sdk) return { status: 'unavailable', reason: 'no_sdk_adapter', provider: id, model };
    const apiKey = env[provider.keyEnv];
    const inputUsdPerMillion = positiveRate(env[`${provider.envPrefix}${suffix}_INPUT_USD_PER_MILLION`]);
    const outputUsdPerMillion = provider.embeddingOnly ? 0 : positiveRate(env[`${provider.envPrefix}${suffix}_OUTPUT_USD_PER_MILLION`]);
    if (typeof apiKey !== 'string' || !apiKey) return { status: 'unavailable', reason: 'key_missing', provider: id, model };
    if (!inputUsdPerMillion || (!provider.embeddingOnly && !outputUsdPerMillion)) return { status: 'unavailable', reason: 'rates_missing', provider: id, model };
    return { status: 'ready', provider: id, sdk: provider.sdk, model, modelVersion: model, apiKey, inputUsdPerMillion, outputUsdPerMillion };
  };
  const strip = ({ disabled, ...rest }) => rest;
  const all = (purpose, only) => (routes[purpose] ?? []).filter(entry => !only || entry.provider === only).map(evaluate);
  return Object.freeze({
    resolve(purpose, { provider: only } = {}) {
      if (!routes[purpose]) return { status: 'unavailable', reason: 'no_route' };
      const results = all(purpose, only);
      const ready = results.find(result => result.status === 'ready');
      if (ready) return ready;
      // Report the first enabled provider's reason; a provider that is merely not enabled only explains an otherwise empty route.
      const reason = results.find(result => !result.disabled) ?? results[0];
      return reason ? strip(reason) : { status: 'unavailable', reason: 'no_route' };
    },
    candidates(purpose) {
      return all(purpose).filter(result => result.status === 'ready');
    },
  });
}
