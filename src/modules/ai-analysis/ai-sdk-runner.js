import { ToolLoopAgent, Output, isStepCount, jsonSchema } from 'ai';
import { PROMPT_VERSION } from './prompts.js';

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

  return async function runWithAiSdk({ task, prompt, outputSchema, maxOutputTokens, maxRetries, abortSignal }) {
    const languageModel = await loadModel({ provider, model, modelVersion });
    const agent = createAgent({
      id: `coversaath-${task}`,
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
        mode: 'live',
        provider,
        model,
        modelVersion,
        promptVersion: PROMPT_VERSION,
        inputTokens,
        outputTokens,
        costUsd: ((inputTokens * inputRate) + (outputTokens * outputRate)) / 1_000_000,
      },
    };
  };
}
