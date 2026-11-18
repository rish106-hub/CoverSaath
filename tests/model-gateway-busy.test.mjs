// A model call that cannot get a slot answers "busy" quickly instead of waiting out its own timeout; the chat limit is a setting.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBudget, createModelGateway, CHAT_GATEWAY_LIMITS, chatGatewayLimits } from '../src/features/ai-analysis/index.js';
import { sealModelInput } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { validDraft } from './support/privacy-corpus.mjs';
import { AI_CONTRACT_VERSION } from '../src/features/ai-analysis/responsibility-matrix.js';
import { PROMPT_VERSION } from '../src/features/ai-analysis/prompts.js';

const TASK = 'policy_evidence_investigate';
const meta = { provider: 'test', model: 'm', modelVersion: '1', contractVersion: AI_CONTRACT_VERSION, promptVersion: PROMPT_VERSION, mode: 'live', inputTokens: 10, outputTokens: 5, totalTokens: 15, calls: 1, latencyMs: 1, costUsd: 0 };

test('with one slot taken, a second call answers gateway_busy after the queue timeout, and the first still finishes', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const gateway = createModelGateway({
    mode: 'live', budget: createMemoryBudget(1), limits: { maxConcurrentCalls: 1, queueTimeoutMs: 40 },
    liveRunner: async () => { await gate; return { output: { findings: [] }, metadata: meta }; },
  });
  const call = () => gateway.execute({ task: TASK, input: sealModelInput(TASK, validDraft(TASK)), reservationUsd: 0.001 });
  const first = call();
  await new Promise(resolve => setTimeout(resolve, 10));
  const started = Date.now();
  await assert.rejects(call(), { code: 'gateway_busy' });
  assert.ok(Date.now() - started < 1000);
  release();
  await first;
  const again = createModelGateway({ mode: 'live', budget: createMemoryBudget(1), limits: { maxConcurrentCalls: 1, queueTimeoutMs: 40 }, liveRunner: async () => ({ output: { findings: [] }, metadata: meta }) });
  await again.execute({ task: TASK, input: sealModelInput(TASK, validDraft(TASK)), reservationUsd: 0.001 });
});

test('the chat limit is 4 per machine by default, set by CHAT_MAX_CONCURRENT_CALLS between 1 and 8, and a bad value keeps the default', () => {
  assert.equal(CHAT_GATEWAY_LIMITS.maxConcurrentCalls, 4);
  assert.equal(CHAT_GATEWAY_LIMITS.queueTimeoutMs, 5000);
  assert.equal(chatGatewayLimits({ CHAT_MAX_CONCURRENT_CALLS: '6' }).maxConcurrentCalls, 6);
  for (const bad of ['0', '9', 'x', '', '2.5']) assert.equal(chatGatewayLimits({ CHAT_MAX_CONCURRENT_CALLS: bad }).maxConcurrentCalls, 4);
  assert.equal(chatGatewayLimits({}).maxConcurrentCalls, 4);
});
