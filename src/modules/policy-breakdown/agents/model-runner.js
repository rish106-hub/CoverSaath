import { generateText, jsonSchema, Output } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

// Model runner for the policy breakdown. Separate from the case-analysis gateway because a whole
// policy wording (often 100–400 KB of text) must reach each section agent. Limits are explicit and capped.

export class ModelRunnerError extends Error {
  constructor(code, message, { statusCode = 503 } = {}) {
    super(message);
    this.name = 'ModelRunnerError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, options) => { throw new ModelRunnerError(code, message, options); };

function bounded(value, name, { fallback, min = 0, max, integer = false }) {
  const parsed = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= min || parsed > max || (integer && !Number.isInteger(parsed))) {
    fail('BREAKDOWN_AI_CONFIG_INVALID', `${name} must be within its safety bound (${min} < value ≤ ${max}).`);
  }
  return parsed;
}

/** Reads live configuration by name only. Throws when anything required is missing. */
export function readBreakdownModelConfig(env = process.env) {
  if (!['google', 'gemini'].includes(env.LLM_PROVIDER)) fail('BREAKDOWN_AI_NOT_CONFIGURED', 'Live breakdown requires LLM_PROVIDER=google.');
  const apiKey = env.GOOGLE_GENERATIVE_AI_API_KEY ?? env.GEMINI_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) fail('BREAKDOWN_AI_NOT_CONFIGURED', 'A server-only Gemini API key is required.');
  const model = (env.BREAKDOWN_LLM_MODEL || env.LLM_MODEL || '').trim();
  if (!model) fail('BREAKDOWN_AI_NOT_CONFIGURED', 'BREAKDOWN_LLM_MODEL or LLM_MODEL is required.');
  return Object.freeze({
    apiKey,
    provider: 'google',
    model,
    inputUsdPerMillion: bounded(env.BREAKDOWN_INPUT_USD_PER_MILLION ?? env.LLM_INPUT_USD_PER_MILLION, 'BREAKDOWN_INPUT_USD_PER_MILLION', { max: 100 }),
    outputUsdPerMillion: bounded(env.BREAKDOWN_OUTPUT_USD_PER_MILLION ?? env.LLM_OUTPUT_USD_PER_MILLION, 'BREAKDOWN_OUTPUT_USD_PER_MILLION', { max: 400 }),
    jobBudgetUsd: bounded(env.BREAKDOWN_JOB_BUDGET_USD, 'BREAKDOWN_JOB_BUDGET_USD', { fallback: 5, max: 50 }),
    maxInputCharacters: bounded(env.BREAKDOWN_MAX_INPUT_CHARACTERS, 'BREAKDOWN_MAX_INPUT_CHARACTERS', { fallback: 1_200_000, max: 3_000_000, integer: true }),
    maxOutputTokens: bounded(env.BREAKDOWN_MAX_OUTPUT_TOKENS, 'BREAKDOWN_MAX_OUTPUT_TOKENS', { fallback: 16_000, max: 65_000, integer: true }),
    timeoutMs: bounded(env.BREAKDOWN_TIMEOUT_MS, 'BREAKDOWN_TIMEOUT_MS', { fallback: 240_000, max: 900_000, integer: true }),
    maxConcurrentCalls: bounded(env.BREAKDOWN_MAX_CONCURRENT_CALLS, 'BREAKDOWN_MAX_CONCURRENT_CALLS', { fallback: 3, max: 12, integer: true }),
  });
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < limit) { active += 1; return; }
      await new Promise(resolve => queue.push(resolve));
    },
    release() {
      const next = queue.shift();
      if (next) next(); else active -= 1;
    },
  };
}

/** Per-job spend ledger. Reserve the worst case before a call, settle the actual cost after. */
export function createJobBudget(maxUsd, { spentUsd = 0 } = {}) {
  let reserved = 0;
  let spent = spentUsd;
  return Object.freeze({
    reserve(amountUsd) {
      if (spent + reserved + amountUsd > maxUsd) fail('BREAKDOWN_BUDGET_EXHAUSTED', 'The breakdown job budget would be exceeded. Increase BREAKDOWN_JOB_BUDGET_USD or reduce passes.', { statusCode: 402 });
      reserved += amountUsd;
      return amountUsd;
    },
    settle(reservedUsd, actualUsd) {
      reserved -= reservedUsd;
      spent += actualUsd ?? 0;
    },
    snapshot() { return { maxUsd, reservedUsd: reserved, spentUsd: spent }; },
  });
}

const estimateTokens = characters => Math.ceil(characters / 3.5);

/**
 * Live Gemini runner. `run()` returns { output, usage, costUsd, latencyMs, model, provider }.
 * One retry is allowed only when the response fails schema parsing.
 */
export function createLiveModelRunner({ env = process.env, config = readBreakdownModelConfig(env), loadModel, generate = generateText } = {}) {
  const semaphore = createSemaphore(config.maxConcurrentCalls);
  const languageModel = loadModel ? null : createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model);
  return Object.freeze({
    mode: 'live',
    provider: config.provider,
    model: config.model,
    config,
    async run({ agent, system, prompt, schema, budget, maxOutputTokens = config.maxOutputTokens, signal }) {
      const characters = system.length + prompt.length;
      if (characters > config.maxInputCharacters) fail('BREAKDOWN_INPUT_TOO_LARGE', `Prompt for ${agent} exceeds BREAKDOWN_MAX_INPUT_CHARACTERS.`, { statusCode: 413 });
      const worstCaseUsd = ((estimateTokens(characters) * config.inputUsdPerMillion) + (maxOutputTokens * config.outputUsdPerMillion)) / 1_000_000;
      const attempts = 2;
      let lastError;
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const reservation = budget.reserve(worstCaseUsd);
        const started = Date.now();
        await semaphore.acquire();
        try {
          const model = languageModel ?? await loadModel(config);
          const result = await generate({
            model,
            system,
            prompt,
            temperature: 0,
            maxOutputTokens,
            maxRetries: 1,
            abortSignal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)].filter(Boolean)),
            output: Output.object({ schema: jsonSchema(schema) }),
          });
          const usage = result.totalUsage ?? result.usage ?? {};
          const inputTokens = Number.isInteger(usage.inputTokens) ? usage.inputTokens : estimateTokens(characters);
          const outputTokens = Number.isInteger(usage.outputTokens) ? usage.outputTokens : maxOutputTokens;
          const costUsd = ((inputTokens * config.inputUsdPerMillion) + (outputTokens * config.outputUsdPerMillion)) / 1_000_000;
          budget.settle(reservation, costUsd);
          if (result.output == null || typeof result.output !== 'object') fail('BREAKDOWN_OUTPUT_INVALID', `${agent} returned no structured output.`);
          return { output: result.output, usage: { inputTokens, outputTokens }, costUsd, latencyMs: Date.now() - started, model: config.model, provider: config.provider, attempt };
        } catch (error) {
          // A failed call may still have been billed; settle conservatively at the reservation.
          budget.settle(reservation, error?.code === 'BREAKDOWN_OUTPUT_INVALID' ? 0 : worstCaseUsd);
          lastError = error;
          const schemaFailure = error?.code === 'BREAKDOWN_OUTPUT_INVALID' || /NoObjectGenerated|schema|parse/i.test(`${error?.name} ${error?.message}`);
          if (!schemaFailure || attempt === attempts || signal?.aborted) break;
        } finally {
          semaphore.release();
        }
      }
      const error = new ModelRunnerError(lastError?.code ?? 'BREAKDOWN_MODEL_CALL_FAILED', `${agent} failed: ${String(lastError?.message ?? 'unknown error').slice(0, 300)}`);
      throw error;
    },
  });
}

/**
 * Fixture runner: no network, no cost. `responder({ agent, system, prompt, schema })` returns the output.
 * Used by tests and by the fixture evaluation set.
 */
export function createFixtureModelRunner({ responder }) {
  if (typeof responder !== 'function') throw new TypeError('A fixture responder is required.');
  return Object.freeze({
    mode: 'fixture',
    provider: 'fixture',
    model: 'fixture',
    config: { jobBudgetUsd: 0 },
    async run({ agent, system, prompt, schema }) {
      const started = Date.now();
      const output = await responder({ agent, system, prompt, schema });
      return { output: structuredClone(output), usage: { inputTokens: 0, outputTokens: 0 }, costUsd: 0, latencyMs: Date.now() - started, model: 'fixture', provider: 'fixture', attempt: 1 };
    },
  });
}
