import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAiSdkRunner } from './ai-sdk-runner.js';
import { createModelGateway } from './model-gateway.js';
import { createBudgetScope, createRunBudget, positive, readConfig } from './live-coverage-runtime.js';
import { isStructuringTask } from './structuring-contract.js';

// Live model calls for policy structuring (ADR 0006) go only through the model gateway: task allowlist,
// prompt contract, input cap, budget reservation per call, concurrency, timeout and output shape check.
// Every call is preceded by the caller's document-specific consent check; a refused check is marked as
// never dispatched so its reservation is released. Chunk text reaches this module already privacy-gated
// (policy-structuring gateChunks); quotes are checked against that gated text by the validator.
export const STRUCTURING_GATEWAY_LIMITS = Object.freeze({
  maxInputBytes: 64_000, maxOutputTokens: 16_000, timeoutMs: 240_000, maxConcurrentCalls: 1,
});

function readStructuringConfig(env) {
  const base = readConfig(env);
  const maxInputBytes = positive(env.STRUCTURING_MAX_INPUT_BYTES ?? STRUCTURING_GATEWAY_LIMITS.maxInputBytes, 'STRUCTURING_MAX_INPUT_BYTES', { max: 96_000, integer: true });
  const maxOutputTokens = positive(env.STRUCTURING_MAX_OUTPUT_TOKENS ?? STRUCTURING_GATEWAY_LIMITS.maxOutputTokens, 'STRUCTURING_MAX_OUTPUT_TOKENS', { max: 32_000, integer: true });
  const timeoutMs = positive(env.STRUCTURING_TIMEOUT_MS ?? STRUCTURING_GATEWAY_LIMITS.timeoutMs, 'STRUCTURING_TIMEOUT_MS', { max: 300_000, integer: true });
  // Bytes stand in for input tokens (one token is at least one byte), so the reservation is an upper bound.
  const reservationUsd = ((maxInputBytes * base.inputRate) + (maxOutputTokens * base.outputRate)) / 1_000_000;
  if (reservationUsd > base.runBudgetUsd) {
    throw Object.assign(new Error('Per-call reservation exceeds the run budget.'), { code: 'LIVE_AI_CONFIG_INVALID', statusCode: 503 });
  }
  return Object.freeze({ ...base, maxInputBytes, maxOutputTokens, timeoutMs, reservationUsd });
}

/**
 * Returns createCall({ consentCheck, onCall }) => call({ task, payload }) => { json, usage, costUsd }.
 * One run budget per createCall (one document run); the project budget is shared with live analysis when
 * `projectBudget` (createSharedProjectBudget) is passed, else one per factory. onCall receives
 * counts only (task, tokens, cost, outcome), never prompts or output.
 */
export function createStructuringModelCallFactory({ env = process.env, loadModel, createAgent, projectBudget } = {}) {
  let project;
  return ({ consentCheck, onCall = () => {} } = {}) => {
    if (typeof consentCheck !== 'function') {
      throw Object.assign(new Error('A consent check is required for live model dispatch.'), { code: 'LIVE_AI_CONFIG_INVALID', statusCode: 503 });
    }
    const config = readStructuringConfig(env);
    project ||= projectBudget ? projectBudget.get(config.projectBudgetUsd) : createBudgetScope(config.projectBudgetUsd);
    const modelRunner = createAiSdkRunner({
      loadModel: loadModel ?? (async () => createGoogleGenerativeAI({ apiKey: config.apiKey })(config.model)),
      provider: 'google', model: config.model, modelVersion: config.modelVersion,
      inputUsdPerMillion: config.inputRate, outputUsdPerMillion: config.outputRate, createAgent,
    });
    const runner = async request => {
      try {
        await consentCheck();
      } catch (error) {
        throw Object.assign(error, { modelDispatched: false });
      }
      return modelRunner(request);
    };
    const gateway = createModelGateway({
      mode: 'live', liveRunner: runner, budget: createRunBudget(config.runBudgetUsd, project),
      limits: {
        maxInputBytes: config.maxInputBytes, maxOutputTokens: config.maxOutputTokens, timeoutMs: config.timeoutMs,
        maxRetries: 0, maxReservationUsd: config.reservationUsd, maxConcurrentCalls: STRUCTURING_GATEWAY_LIMITS.maxConcurrentCalls,
      },
    });
    return async ({ task, payload }) => {
      if (!isStructuringTask(task)) throw Object.assign(new Error('Not a structuring task.'), { code: 'unsupported_ai_task' });
      let result;
      try {
        result = await gateway.execute({ task, input: { payload }, reservationUsd: config.reservationUsd });
      } catch (error) {
        onCall({ task, outcome: error?.code ?? 'error', inputTokens: 0, outputTokens: 0, costUsd: 0 });
        throw error;
      }
      const { inputTokens, outputTokens, costUsd } = result.metadata;
      onCall({ task, outcome: 'ok', inputTokens, outputTokens, costUsd });
      return { json: result.output, usage: { inputTokens, outputTokens }, costUsd };
    };
  };
}
