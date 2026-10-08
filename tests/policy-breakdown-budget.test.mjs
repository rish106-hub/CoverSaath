import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobBudget, createLiveModelRunner, readBreakdownModelConfig } from '../src/modules/policy-breakdown/agents/model-runner.js';

const config = { ...readBreakdownModelConfig({ LLM_PROVIDER: 'google', GEMINI_API_KEY: 'test-key-not-real', BREAKDOWN_LLM_MODEL: 'test-model', BREAKDOWN_INPUT_USD_PER_MILLION: '0.1', BREAKDOWN_OUTPUT_USD_PER_MILLION: '0.4' }), timeoutMs: 1_000 };
const runOnce = async generate => {
  const budget = createJobBudget(10);
  const runner = createLiveModelRunner({ config, loadModel: async () => ({}), generate });
  await runner.run({ agent: 'test', system: 's', prompt: 'p', schema: { type: 'object' }, budget }).catch(() => {});
  return budget.snapshot();
};

test('a provider 4xx rejection settles at zero cost', async () => {
  const snapshot = await runOnce(async () => { throw Object.assign(new Error('Bad Request'), { statusCode: 400 }); });
  assert.equal(snapshot.reservedUsd, 0);
  assert.equal(snapshot.spentUsd, 0);
});

test('a 5xx or network failure settles at the worst case', async () => {
  const snapshot = await runOnce(async () => { throw Object.assign(new Error('Server error'), { statusCode: 503 }); });
  assert.equal(snapshot.reservedUsd, 0);
  assert.ok(snapshot.spentUsd > 0);
});

test('an empty structured output is settled once at the billed cost', async () => {
  const snapshot = await runOnce(async () => ({ output: null, usage: { inputTokens: 1000, outputTokens: 10 } }));
  assert.equal(snapshot.reservedUsd, 0);
  assert.ok(snapshot.spentUsd > 0);
});
