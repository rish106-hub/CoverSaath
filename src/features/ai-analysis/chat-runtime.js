import { createAiSdkRunner, createProviderModelLoader } from './ai-sdk-runner.js';
import { createModelGateway } from './model-gateway.js';
import { createLedgerScope, createBudgetScope } from './live-coverage-runtime.js';
import { GATEWAY_TASK_LIST, unknownOutput } from './gateway-contract.js';
import { createEmbedRunner } from './embed-runner.js';
import { AI_CONTRACT_VERSION } from './responsibility-matrix.js';
import { PROMPT_VERSION } from './prompts.js';

// Provider-routed model calls for chat, intent, fact extraction and embedding (ADR 0030). The one path that builds a gateway
// for these tasks. Everything here sits behind CHAT_MODEL_ENABLED (off unless exactly "true"): with the flag off, `call`
// returns the task's typed unknown without touching a provider, a key or the database.
//
// Routing is data (src/integrations model-routing, MODEL_PROVIDERS). A route with no key, no rates, no SDK adapter or no
// entry answers a typed unknown through the gateway (nothing dispatched, reservation released). Keys come from the
// environment inside the router only. Each gateway event becomes one provider_calls row (counts and a payload digest).
export const CHAT_GATEWAY_LIMITS = Object.freeze({ maxInputBytes: 48_000, maxOutputTokens: 1_500, timeoutMs: 30_000, maxConcurrentCalls: 2 });
const UNAVAILABLE_RESERVATION_USD = 0.000001;

// A failure that must stop the chain rather than move to the next provider: the gate, the budget, the caller's own abort and
// consent are the same for every provider, so retrying elsewhere would not help (or would bypass them).
const NO_FAILOVER = new Set(['ungated_model_input', 'budget_refused', 'budget_not_configured', 'reservation_limit', 'reservation_exceeded', 'input_limit', 'aborted',
  'invalid_gateway_config', 'live_not_configured', 'unsupported_ai_task', 'CONSENT_REQUIRED']);

function flagOn(env) { return env.CHAT_MODEL_ENABLED === 'true'; }

function reservationFor(route, limits) {
  if (route.status !== 'ready') return UNAVAILABLE_RESERVATION_USD;
  return ((limits.maxInputBytes * route.inputUsdPerMillion) + (limits.maxOutputTokens * route.outputUsdPerMillion)) / 1_000_000;
}

/** A per-household, per-day budget scope over the runtime-limits ledger (RuntimeLimitsRepository), or an in-memory one. */
export function createHouseholdDayBudget({ ledger = null, maxUsd, clock = () => new Date() } = {}) {
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw Object.assign(new Error('A per-household daily budget is required.'), { code: 'LIVE_AI_CONFIG_INVALID' });
  const memory = new Map();
  return householdId => {
    const scope = `chat:${householdId}:${clock().toISOString().slice(0, 10)}`;
    if (ledger) return createLedgerScope(ledger, scope, maxUsd);
    // SCALE: per-process; the ledger variant above is the multi-machine one.
    if (!memory.has(scope)) memory.set(scope, createBudgetScope(maxUsd));
    return memory.get(scope);
  };
}

export function createChatModelGateway({ env = process.env, router, providerCalls = null, budgetFor, loadModel, createAgent, embedClientFor = null, limits = CHAT_GATEWAY_LIMITS, onEvent } = {}) {
  if (!router || typeof router.resolve !== 'function') throw new TypeError('A model router is required.');
  const enabled = flagOn(env);
  const runners = new Map();
  const pending = [];

  const runnerFor = route => {
    const key = `${route.provider}:${route.model}`;
    if (!runners.has(key) && route.sdk === 'voyage') {
      // Embeddings (ADR 0031): the client is built by the composition root from the route (key and URL live under src/integrations).
      const client = embedClientFor?.(route);
      if (!client) return async () => ({ unavailable: true, provider: route.provider, model: route.model, reason: 'no_embed_client' });
      runners.set(key, createEmbedRunner({ client, provider: route.provider, model: route.model, inputUsdPerMillion: route.inputUsdPerMillion }));
    }
    if (!runners.has(key)) {
      runners.set(key, createAiSdkRunner({
        loadModel: loadModel ?? createProviderModelLoader({ provider: route.sdk, apiKey: route.apiKey }),
        provider: route.provider, model: route.model, modelVersion: route.modelVersion,
        inputUsdPerMillion: route.inputUsdPerMillion, outputUsdPerMillion: route.outputUsdPerMillion, createAgent,
      }));
    }
    return runners.get(key);
  };

  const liveRunner = async request => {
    // `request.provider` pins the attempt to one provider (callRouted); absent, the first ready route answers.
    const route = router.resolve(request.task, request.provider ? { provider: request.provider } : undefined);
    if (route.status !== 'ready') return { unavailable: true, provider: route.provider, model: route.model, reason: route.reason };
    return runnerFor(route)(request);
  };

  const record = async event => {
    try { onEvent?.(event); } catch { /* telemetry must not affect a call */ }
    if (!providerCalls) return;
    try { await providerCalls.record(event); } catch { /* an audit write failure must not fail the household's answer; the digest is also on the event */ }
  };
  // The gateway's emit is synchronous; collect the row writes of a call and let `call` await them before it returns.
  const gateway = createModelGateway({
    mode: 'live', liveRunner,
    onEvent: event => { pending.push(record(event)); },
    limits: { ...limits, maxRetries: 0, maxReservationUsd: 0.5 },
  });

  const unknownResult = (task, reason) => ({ output: unknownOutput(task), metadata: { contractVersion: AI_CONTRACT_VERSION, mode: 'live', provider: 'none', model: 'none', modelVersion: 'none', promptVersion: PROMPT_VERSION, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, latencyMs: 0, costUsd: 0, unavailableReason: reason } });

  const api = {
    enabled,
    /** The ready routes for `task` in failover order: [{ provider, model }] (no key, no rate, no SDK or not enabled: absent). */
    candidates(task) { return (router.candidates?.(task) ?? []).map(({ provider, model }) => ({ provider, model })); },
    /**
     * Failover chain (Gemini, then anthropic, openai, deepseek, kimi: MODEL_ROUTES). For each ready provider in order:
     * `authorize(provider)` must resolve the caller's current exact consent for THAT provider and re-check it (a non-null value, or null to skip
     * the provider: nothing is sent to it); then the gated input is dispatched to it alone. The chain moves on only when the provider answers
     * a typed unavailable or its call fails; a gate, budget, abort or consent failure stops it. Resolves the first answered call as
     * { output, metadata, authorization } (authorization = what `authorize` returned for the provider that answered), or a typed unknown.
     */
    async callRouted({ task, input, householdId = null, signal, authorize } = {}) {
      if (typeof authorize !== 'function') throw new TypeError('authorize is required.');
      if (!GATEWAY_TASK_LIST.includes(task)) throw Object.assign(new Error(`Task ${task} is not a gateway task.`), { code: 'unsupported_ai_task' });
      if (!enabled) return unknownResult(task, 'flag_off');
      const candidates = router.candidates?.(task) ?? [];
      // No ready provider: one pinned-free call records the typed unavailable (reason, audit row) exactly as a single route does.
      if (candidates.length === 0) return api.call({ task, input, householdId, signal });
      let consentSkips = 0;
      let lastUnavailable = null;
      let lastError = null;
      for (const route of candidates) {
        const authorization = await authorize(route.provider);
        if (authorization === null || authorization === undefined || authorization === false) { consentSkips += 1; continue; }
        try {
          const result = await api.call({ task, input, householdId, signal, provider: route.provider });
          if (result.metadata.calls === 0) { lastUnavailable = result; continue; }
          return { ...result, authorization };
        } catch (error) {
          if (signal?.aborted || NO_FAILOVER.has(error?.code)) throw error;
          lastError = error;
        }
      }
      // Every consented provider failed: a typed failure (never the provider's own message), so the caller falls back to its deterministic path.
      if (lastError) throw Object.assign(new Error('Every routed model provider failed.'), { code: 'provider_failure' });
      return lastUnavailable ?? unknownResult(task, 'consent_required');
    },
    /** call({ task, input, householdId, signal }) -> { output, metadata }. `input` must be a sealed model input for `task`. */
    async call({ task, input, householdId = null, signal, provider = null } = {}) {
      if (!GATEWAY_TASK_LIST.includes(task)) throw Object.assign(new Error(`Task ${task} is not a gateway task.`), { code: 'unsupported_ai_task' });
      if (!enabled) return unknownResult(task, 'flag_off');
      const route = provider ? router.resolve(task, { provider }) : router.resolve(task);
      const budget = budgetFor ? budgetFor(householdId) : undefined;
      try {
        return await gateway.execute({
          task, input, householdId, signal, budget,
          reservationUsd: reservationFor(route, limits), provider: route.provider, model: route.model,
        });
      } finally {
        const writes = pending.splice(0);
        await Promise.all(writes);
      }
    },
  };
  return Object.freeze(api);
}
