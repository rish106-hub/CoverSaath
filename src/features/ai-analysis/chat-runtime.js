import { createAiSdkRunner, createProviderModelLoader } from './ai-sdk-runner.js';
import { createModelGateway } from './model-gateway.js';
import { createLedgerScope, createBudgetScope } from './live-coverage-runtime.js';
import { GATEWAY_TASK_LIST, unknownOutput } from './gateway-contract.js';
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

export function createChatModelGateway({ env = process.env, router, providerCalls = null, budgetFor, loadModel, createAgent, limits = CHAT_GATEWAY_LIMITS, onEvent } = {}) {
  if (!router || typeof router.resolve !== 'function') throw new TypeError('A model router is required.');
  const enabled = flagOn(env);
  const runners = new Map();
  const pending = [];

  const runnerFor = route => {
    const key = `${route.provider}:${route.model}`;
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
    const route = router.resolve(request.task);
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

  return Object.freeze({
    enabled,
    /** call({ task, input, householdId, signal }) -> { output, metadata }. `input` must be a sealed model input for `task`. */
    async call({ task, input, householdId = null, signal } = {}) {
      if (!GATEWAY_TASK_LIST.includes(task)) throw Object.assign(new Error(`Task ${task} is not a gateway task.`), { code: 'unsupported_ai_task' });
      if (!enabled) {
        return { output: unknownOutput(task), metadata: { contractVersion: AI_CONTRACT_VERSION, mode: 'live', provider: 'none', model: 'none', modelVersion: 'none', promptVersion: PROMPT_VERSION, inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0, latencyMs: 0, costUsd: 0, unavailableReason: 'flag_off' } };
      }
      const route = router.resolve(task);
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
  });
}
