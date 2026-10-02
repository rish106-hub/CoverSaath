import { buildPromptContract, PROMPT_VERSION } from './prompts.js';
import { TASK_OUTPUT_SCHEMAS, validateTaskOutput } from './schemas.js';
import { assertModelTask } from './responsibility-matrix.js';
import { AI_CONTRACT_VERSION } from './responsibility-matrix.js';

const DEFAULT_LIMITS = Object.freeze({ maxInputBytes: 48_000, maxOutputTokens: 1_500, timeoutMs: 30_000, maxRetries: 0, maxReservationUsd: 0.05, maxConcurrentCalls: 3 });

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function positiveNumber(value, label, { allowZero = false } = {}) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) fail('invalid_gateway_config', `${label} is invalid.`);
}

function limitsWithDefaults(limits) {
  const value = { ...DEFAULT_LIMITS, ...limits };
  positiveNumber(value.maxInputBytes, 'maxInputBytes');
  positiveNumber(value.maxOutputTokens, 'maxOutputTokens');
  positiveNumber(value.timeoutMs, 'timeoutMs');
  if (!Number.isInteger(value.maxRetries) || value.maxRetries < 0 || value.maxRetries > 2) fail('invalid_gateway_config', 'maxRetries must be between zero and two.');
  if (!Number.isInteger(value.maxConcurrentCalls) || value.maxConcurrentCalls < 1 || value.maxConcurrentCalls > 8) fail('invalid_gateway_config', 'maxConcurrentCalls must be between one and eight.');
  positiveNumber(value.maxReservationUsd, 'maxReservationUsd', { allowZero: true });
  return Object.freeze(value);
}

function validateExecutionResult(result, request, mode) {
  if (!result || typeof result !== 'object') fail('invalid_model_result', 'Model gateway returned no result.');
  const metadata = result.metadata;
  if (!metadata || typeof metadata.provider !== 'string' || typeof metadata.model !== 'string' || typeof metadata.modelVersion !== 'string') {
    fail('invalid_model_result', 'Provider, model and model version must be recorded.');
  }
  if (metadata.contractVersion !== AI_CONTRACT_VERSION || metadata.promptVersion !== PROMPT_VERSION || metadata.mode !== mode) fail('invalid_model_result', 'Contract, prompt version or execution mode is not recorded correctly.');
  if (![metadata.inputTokens, metadata.outputTokens, metadata.totalTokens, metadata.calls].every(value => Number.isInteger(value) && value >= 0)) fail('invalid_model_result', 'Token and call metrics must be recorded.');
  if (metadata.totalTokens !== metadata.inputTokens + metadata.outputTokens) fail('invalid_model_result', 'Token totals are inconsistent.');
  if ((mode === 'live' && metadata.calls < 1) || (mode === 'fixture' && metadata.calls !== 0)) fail('invalid_model_result', 'Call count does not match execution mode.');
  if (!Number.isFinite(metadata.latencyMs) || metadata.latencyMs < 0) fail('invalid_model_result', 'Latency must be recorded.');
  if (!Number.isFinite(metadata.costUsd) || metadata.costUsd < 0) fail('invalid_model_result', 'Actual model cost must be recorded.');
  if (mode === 'fixture' && (metadata.inputTokens !== 0 || metadata.outputTokens !== 0 || metadata.costUsd !== 0)) fail('invalid_model_result', 'Fixture execution cannot report provider usage or cost.');
  return { output: validateTaskOutput(request.task, result.output, request.input), metadata: structuredClone(metadata) };
}

export function createModelGateway({ mode, liveRunner, fixtures = {}, budget, limits } = {}) {
  if (!['fixture', 'live'].includes(mode)) fail('invalid_gateway_config', 'Choose fixture or live mode explicitly.');
  if (mode === 'live' && typeof liveRunner !== 'function') fail('live_not_configured', 'Live mode needs an explicit model runner.');
  const bounded = limitsWithDefaults(limits);
  let activeCalls = 0;
  const waiters = [];
  const acquire = async signal => {
    if (signal?.aborted) fail('aborted', 'AI task was cancelled before execution.');
    if (activeCalls < bounded.maxConcurrentCalls) { activeCalls += 1; return; }
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal };
      entry.abort = () => {
        const index = waiters.indexOf(entry);
        if (index >= 0) waiters.splice(index, 1);
        reject(Object.assign(new Error('AI task was cancelled while queued.'), { code: 'aborted' }));
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      waiters.push(entry);
    });
  };
  const release = () => {
    const next = waiters.shift();
    if (next) {
      next.signal?.removeEventListener('abort', next.abort);
      next.resolve();
    } else activeCalls -= 1;
  };

  return Object.freeze({
    mode,
    limits: bounded,
    async execute({ task, input, reservationUsd, signal } = {}) {
      assertModelTask(task);
      positiveNumber(reservationUsd, 'reservationUsd', { allowZero: mode === 'fixture' });
      if (reservationUsd > bounded.maxReservationUsd) fail('reservation_limit', 'Request exceeds the per-call cost reservation limit.');
      const contract = buildPromptContract(task, input);
      if (Buffer.byteLength(contract.evidence, 'utf8') > bounded.maxInputBytes) fail('input_limit', 'Prompt evidence exceeds the gateway limit.');
      if (signal?.aborted) fail('aborted', 'AI task was cancelled before execution.');
      if (mode === 'live') {
        if (!budget || typeof budget.reserve !== 'function' || typeof budget.settle !== 'function') fail('budget_not_configured', 'Live mode needs a reservation ledger.');
        const reservation = await budget.reserve(reservationUsd, { task, promptVersion: PROMPT_VERSION });
        if (!reservation) fail('budget_refused', 'The budget ledger refused this model call.');
        const timeoutSignal = AbortSignal.timeout(bounded.timeoutMs);
        const abortSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let result;
        let acquired = false;
        try {
          await acquire(abortSignal);
          acquired = true;
          result = validateExecutionResult(await liveRunner({
            task,
            input: structuredClone(input),
            prompt: contract,
            outputSchema: TASK_OUTPUT_SCHEMAS[task],
            maxOutputTokens: bounded.maxOutputTokens,
            maxRetries: bounded.maxRetries,
            abortSignal,
            reservation: structuredClone(reservation),
          }), { task, input }, mode);
        } catch (error) {
          await budget.settle(reservation, null, { failed: true });
          throw error;
        } finally {
          if (acquired) release();
        }
        await budget.settle(reservation, result.metadata.costUsd);
        if (result.metadata.costUsd > reservation.amountUsd) fail('reservation_exceeded', 'Actual model cost exceeded the reserved amount. Further paid work must stop.');
        return { ...result, reservation: structuredClone(reservation) };
      }

      const fixture = fixtures[task];
      if (!fixture) fail('fixture_missing', `No fixture exists for ${task}. Live mode is not used as fallback.`);
      return validateExecutionResult(typeof fixture === 'function' ? await fixture({ task, input: structuredClone(input), prompt: contract }) : fixture, { task, input }, mode);
    },
  });
}

export function createMemoryBudget(maxUsd) {
  positiveNumber(maxUsd, 'maxUsd', { allowZero: true });
  let reserved = 0;
  let spent = 0;
  let sequence = 0;
  return Object.freeze({
    async reserve(amount, metadata) {
      if (spent + reserved + amount > maxUsd) return null;
      reserved += amount;
      sequence += 1;
      return { id: `reservation-${sequence}`, amountUsd: amount, metadata: structuredClone(metadata) };
    },
    async settle(reservation, actualCostUsd, { failed = false } = {}) {
      if (failed || actualCostUsd === null) return;
      positiveNumber(actualCostUsd, 'actualCostUsd', { allowZero: true });
      reserved -= reservation.amountUsd;
      spent += actualCostUsd;
    },
    snapshot() { return { maxUsd, reservedUsd: reserved, spentUsd: spent, availableUsd: maxUsd - reserved - spent }; },
  });
}
