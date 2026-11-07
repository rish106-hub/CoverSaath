// ADR 0017 D3 / D5 / WP3: the gateway refuses input that is not sealed, in both modes, before any reservation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryBudget, createModelGateway } from '../src/features/ai-analysis/index.js';
import { PRIVACY_EVIDENCE_GATE_VERSION, sealModelInput } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { sanitizePayload } from '../src/backend/repositories/app-event-repository.js';
import { validDraft } from './support/privacy-corpus.mjs';
import { AI_CONTRACT_VERSION } from '../src/features/ai-analysis/responsibility-matrix.js';
import { PROMPT_VERSION } from '../src/features/ai-analysis/prompts.js';

const TASK = 'policy_evidence_investigate';
const OTHER = 'policy_structuring_extract';
const metadata = (mode, overrides = {}) => ({
  provider: 'test', model: 'm', modelVersion: '1', contractVersion: AI_CONTRACT_VERSION, promptVersion: PROMPT_VERSION, mode,
  inputTokens: mode === 'live' ? 10 : 0, outputTokens: mode === 'live' ? 5 : 0, totalTokens: mode === 'live' ? 15 : 0, calls: mode === 'live' ? 1 : 0,
  latencyMs: 1, costUsd: 0, ...overrides,
});
const result = mode => ({ output: { findings: [] }, metadata: metadata(mode) });

function harness(mode) {
  const calls = { reserve: 0, runner: 0, fixture: 0, settle: 0 };
  const events = [];
  const inner = createMemoryBudget(1);
  const budget = { reserve: async (...args) => { calls.reserve += 1; return inner.reserve(...args); }, settle: async (...args) => { calls.settle += 1; return inner.settle(...args); } };
  const seen = [];
  const gateway = mode === 'live'
    ? createModelGateway({ mode, budget, onEvent: event => events.push(event), liveRunner: async request => { calls.runner += 1; seen.push(request.input); return result('live'); } })
    : createModelGateway({ mode, onEvent: event => events.push(event), fixtures: { [TASK]: async ({ input }) => { calls.fixture += 1; seen.push(input); return result('fixture'); } } });
  return { gateway, calls, events, seen };
}

for (const mode of ['fixture', 'live']) {
  test(`${mode}: unsealed input is refused before reservation, runner and fixture`, async () => {
    const { gateway, calls, events } = harness(mode);
    const sealed = sealModelInput(TASK, validDraft(TASK));
    const unsealed = [
      JSON.parse(JSON.stringify(sealed)), structuredClone(sealed), { ...sealed }, { payload: { questions: [{ text: 'Raw question 4417' }], checklist: ['benefit'], clauses: [] } },
      null, 'text', undefined, new Proxy(sealed, {}),
    ];
    for (const input of unsealed) {
      await assert.rejects(gateway.execute({ task: TASK, input, reservationUsd: mode === 'live' ? 0.01 : 0 }), { code: 'ungated_model_input' });
    }
    assert.deepEqual(calls, { reserve: 0, runner: 0, fixture: 0, settle: 0 });
    assert.equal(events.length, unsealed.length);
    for (const event of events) assert.deepEqual(event, { task: TASK, outcome: 'ungated_model_input', latencyMs: 0, dispatched: false, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    assert.equal(JSON.stringify(events).includes('4417'), false);
  });

  test(`${mode}: input sealed for another task is refused`, async () => {
    const { gateway, calls } = harness(mode);
    const sealed = sealModelInput(OTHER, validDraft(OTHER));
    await assert.rejects(gateway.execute({ task: TASK, input: sealed, reservationUsd: mode === 'live' ? 0.01 : 0 }), { code: 'ungated_model_input' });
    assert.equal(calls.reserve + calls.runner + calls.fixture, 0);
  });

  test(`${mode}: sealed input dispatches and the provider side sees a plain clone`, async () => {
    const { gateway, calls, seen } = harness(mode);
    const sealed = sealModelInput(TASK, validDraft(TASK));
    const response = await gateway.execute({ task: TASK, input: sealed, reservationUsd: mode === 'live' ? 0.01 : 0 });
    assert.equal(response.metadata.mode, mode);
    assert.equal(calls.runner + calls.fixture, 1);
    const [received] = seen;
    assert.notEqual(received, sealed);
    assert.equal(Object.isFrozen(received), false);
    assert.equal(Object.isFrozen(received.payload), false);
    assert.equal(Object.getOwnPropertySymbols(received).length, 0);
    assert.deepEqual(received, JSON.parse(JSON.stringify(sealed)));
  });
}

test('a live ok event carries the gate counts and nothing identifying; the app-event payload keeps them', async () => {
  const { gateway, events } = harness('live');
  const sealed = sealModelInput(TASK, validDraft(TASK));
  await gateway.execute({ task: TASK, input: sealed, reservationUsd: 0.01 });
  const [event] = events;
  assert.equal(event.outcome, 'ok');
  assert.equal(event.gateVersion, PRIVACY_EVIDENCE_GATE_VERSION);
  for (const key of ['gatedSlots', 'placeholders', 'reasonCodes', 'gatedBytes']) assert.ok(Number.isInteger(event[key]) && event[key] >= 0, key);
  assert.ok(event.gatedSlots >= 2);
  const counts = Object.fromEntries(['gateVersion', 'gatedSlots', 'placeholders', 'reasonCodes', 'gatedBytes'].map(key => [key, event[key]]));
  for (const value of Object.values(counts)) {
    assert.equal(/^[0-9a-f]{64}$/.test(String(value)), false);
    assert.equal(/^[A-Z_]{6,}$/.test(String(value)), false);
    assert.equal(/<[A-Z_]+_\d+>/.test(String(value)), false);
  }
  assert.deepEqual(sanitizePayload({ task: event.task, ...counts }), { task: TASK, ...counts });
});

test('a failed live call still reports counts, never text', async () => {
  const budget = createMemoryBudget(1);
  const events = [];
  const gateway = createModelGateway({ mode: 'live', budget, onEvent: event => events.push(event), liveRunner: async () => { throw Object.assign(new Error('boom'), { code: 'provider_down' }); } });
  await assert.rejects(gateway.execute({ task: TASK, input: sealModelInput(TASK, validDraft(TASK)), reservationUsd: 0.01 }), { code: 'provider_down' });
  assert.equal(events[0].outcome, 'provider_down');
  assert.ok(events[0].gatedSlots >= 2);
});
