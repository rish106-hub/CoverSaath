import { ToolLoopAgent, Output, isStepCount, jsonSchema } from 'ai';
import { PROMPT_VERSION } from './prompts.js';
import { AI_CONTRACT_VERSION } from './responsibility-matrix.js';
import { isGatewayRequest } from './model-gateway.js';

function rate(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`${label} must be a verified positive rate.`);
  return value;
}

export function createAiSdkRunner({ loadModel, provider, model, modelVersion, inputUsdPerMillion, outputUsdPerMillion, createAgent = settings => new ToolLoopAgent(settings) } = {}) {
  if (typeof loadModel !== 'function') throw new TypeError('loadModel is required.');
  for (const [label, value] of Object.entries({ provider, model, modelVersion })) {
    if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${label} is required.`);
  }
  const inputRate = rate(inputUsdPerMillion, 'inputUsdPerMillion');
  const outputRate = rate(outputUsdPerMillion, 'outputUsdPerMillion');

  return async function runWithAiSdk(request) {
    // A provider call is made only for a request the gateway built after its sealed-input check (ADR 0017). Handing the
    // runner a hand-made request, from any module that managed to build one, fails here before the model is loaded.
    if (!isGatewayRequest(request)) throw Object.assign(new Error('Model input did not come from the privacy gate.'), { code: 'ungated_model_input', modelDispatched: false });
    const { task, prompt, outputSchema, maxOutputTokens, maxRetries, abortSignal } = request;
    const startedAt = Date.now();
    const languageModel = await loadModel({ provider, model, modelVersion });
    const agent = createAgent({
      id: `knowvia-${task}`,
      model: languageModel,
      instructions: prompt.system,
      tools: {},
      stopWhen: isStepCount(1),
      maxOutputTokens,
      maxRetries,
      output: Output.object({ schema: jsonSchema(outputSchema) }),
    });
    const result = await agent.generate({ prompt: prompt.evidence, abortSignal });
    const inputTokens = result.totalUsage?.inputTokens;
    const outputTokens = result.totalUsage?.outputTokens;
    if (![inputTokens, outputTokens].every(value => Number.isInteger(value) && value >= 0)) {
      throw Object.assign(new Error('Provider usage is missing.'), { code: 'usage_unknown' });
    }
    return {
      output: result.output,
      metadata: {
        contractVersion: AI_CONTRACT_VERSION,
        mode: 'live',
        provider,
        model,
        modelVersion,
        promptVersion: PROMPT_VERSION,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
        calls: 1,
        latencyMs: Date.now() - startedAt,
        costUsd: ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000,
      },
    };
  };
}
