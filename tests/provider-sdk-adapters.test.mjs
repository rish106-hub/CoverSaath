// Provider SDK adapters (openai, deepseek, kimi via Moonshot, anthropic): routing, key handling, consent and audit.
// Synthetic keys only. No live provider call: models are built locally (no network on construction) and the agent is a stub.
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { seedWorld } from './support/postgres-fixtures.mjs';
import { createModelRouter } from '../src/integrations/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../src/features/ai-analysis/chat-runtime.js';
import { createProviderModelLoader } from '../src/features/ai-analysis/ai-sdk-runner.js';
import { gateTextForHousehold, sealModelInput } from '../src/features/ai-analysis/privacy-evidence-gate.js';

const opts = postgresTestOptions();
const SECRET = 'sk-test-not-a-real-key-0123456789';
const KEY_ENV = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', kimi: 'MOONSHOT_API_KEY' };
const PREFIX = { anthropic: 'ANTHROPIC', openai: 'OPENAI', deepseek: 'DEEPSEEK', kimi: 'KIMI' };
const SDK = { anthropic: 'anthropic', openai: 'openai', deepseek: 'deepseek', kimi: 'moonshotai' };
const loadKnownIdentifiers = async () => [];

const rates = names => Object.fromEntries(names.flatMap(name => [`${PREFIX[name]}_INPUT_USD_PER_MILLION`, `${PREFIX[name]}_OUTPUT_USD_PER_MILLION`,
  `${PREFIX[name]}_CLASSIFY_INPUT_USD_PER_MILLION`, `${PREFIX[name]}_CLASSIFY_OUTPUT_USD_PER_MILLION`].map(key => [key, '2'])));
const keyed = (names, extra = {}) => ({ CHAT_MODEL_ENABLED: 'true', ...Object.fromEntries(names.map(name => [KEY_ENV[name], SECRET])), ...rates(names), ...extra });

async function chatInput() {
  const { gated } = await gateTextForHousehold('Is room rent capped?', { householdId: 'h1', loadKnownIdentifiers });
  const fact = await gateTextForHousehold('Room rent limit', { householdId: 'h1', loadKnownIdentifiers });
  const value = await gateTextForHousehold('1% of sum insured per day', { householdId: 'h1', loadKnownIdentifiers });
  return sealModelInput('chat_answer', { payload: { question: gated, history: [], facts: [{ fact_id: 'fact_0123456789abcdef01234567', label: fact.gated, value: value.gated }] } });
}

const ANSWER = { status: 'extracted_unverified', answer: 'Room rent is capped at 1% of the sum insured per day.', factsUsed: ['fact_0123456789abcdef01234567'] };
const stubAgent = (seen, output = ANSWER) => settings => ({ generate: async () => { seen.push({ model: settings.model, temperature: settings.temperature, instructions: settings.instructions }); return { output, totalUsage: { inputTokens: 50, outputTokens: 10 } }; } });

test('each adapter builds a real SDK language model from its key without a network call', async () => {
  for (const provider of ['anthropic', 'openai', 'deepseek', 'kimi']) {
    const route = createModelRouter({ env: keyed([provider], { MODEL_PROVIDERS: provider }) }).resolve('chat_answer');
    assert.equal(route.status, 'ready', provider);
    assert.equal(route.sdk, SDK[provider]);
    const model = await createProviderModelLoader({ provider: route.sdk, apiKey: SECRET })({ model: route.model });
    assert.equal(typeof model.doGenerate, 'function', `${provider} yields a language model`);
  }
  await assert.rejects(createProviderModelLoader({ provider: 'nonesuch', apiKey: SECRET })({ model: 'm' }), { code: 'provider_sdk_missing', modelDispatched: false });
  await assert.rejects(createProviderModelLoader({ provider: 'openai', apiKey: '' })({ model: 'm' }), { code: 'provider_key_missing', modelDispatched: false });
});

test('missing key or missing rates is a typed unavailable, so the router falls through to the next provider', () => {
  const env = { MODEL_PROVIDERS: 'gemini,anthropic,openai,deepseek,kimi', ...keyed(['openai', 'kimi']), DEEPSEEK_API_KEY: '', OPENAI_OUTPUT_USD_PER_MILLION: '' };
  const router = createModelRouter({ env });
  assert.deepEqual(router.candidates('chat_answer').map(route => route.provider), ['kimi'], 'openai has no output rate, deepseek no key, gemini and anthropic no key');
  assert.equal(router.resolve('chat_answer', { provider: 'deepseek' }).reason, 'key_missing');
  assert.equal(router.resolve('chat_answer', { provider: 'openai' }).reason, 'rates_missing');
  assert.equal(router.resolve('chat_answer', { provider: 'kimi' }).provider, 'kimi');
  assert.equal(createModelRouter({ env: { MODEL_PROVIDERS: 'kimi', KIMI_API_KEY: SECRET, ...rates(['kimi']) } }).resolve('chat_answer').reason, 'key_missing', 'Kimi reads MOONSHOT_API_KEY only');
});

test('a provider not in MODEL_PROVIDERS is skipped even with a key; deepseek and kimi are never in the default', () => {
  const env = keyed(['openai', 'deepseek', 'kimi', 'anthropic']);
  assert.deepEqual(createModelRouter({ env }).candidates('chat_answer').map(route => route.provider), ['anthropic'], 'default MODEL_PROVIDERS is anthropic only');
  assert.deepEqual(createModelRouter({ env: { ...env, MODEL_PROVIDERS: 'openai' } }).candidates('chat_answer').map(route => route.provider), ['openai']);
  assert.equal(createModelRouter({ env: { ...env, MODEL_PROVIDERS: 'openai' } }).resolve('chat_answer', { provider: 'deepseek' }).reason, 'provider_not_enabled');
  assert.deepEqual(createModelRouter({ env: { ...env, MODEL_PROVIDERS: 'openai,deepseek,kimi' } }).candidates('chat_answer').map(route => route.provider), ['openai', 'deepseek', 'kimi']);
});

test('router results never carry the key into logs or errors, and models are provider-specific', () => {
  const env = keyed(['openai', 'deepseek'], { MODEL_PROVIDERS: 'openai,deepseek', OPENAI_MODEL: 'gpt-test', DEEPSEEK_CLASSIFY_MODEL: 'ds-test' });
  const router = createModelRouter({ env });
  assert.equal(router.resolve('chat_answer', { provider: 'openai' }).model, 'gpt-test');
  assert.equal(router.resolve('intent_classify', { provider: 'deepseek' }).model, 'ds-test');
  const unavailable = createModelRouter({ env: { ...env, OPENAI_OUTPUT_USD_PER_MILLION: '' } }).resolve('chat_answer', { provider: 'openai' });
  assert.equal(JSON.stringify(unavailable).includes(SECRET), false);
});

test('success: each adapter answers through the gateway at temperature 0 with the system prompt in instructions and an audit row', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'psa');
  for (const provider of ['anthropic', 'openai', 'deepseek', 'kimi']) {
    const env = keyed([provider], { MODEL_PROVIDERS: provider });
    const seen = [];
    const loaded = [];
    const gateway = createChatModelGateway({
      env, router: createModelRouter({ env }), providerCalls: services.providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
      loadModel: async args => { loaded.push(args.provider); return { stub: true }; }, createAgent: stubAgent(seen),
    });
    const result = await gateway.call({ task: 'chat_answer', input: await chatInput(), householdId: household });
    assert.equal(result.output.status, 'extracted_unverified', provider);
    assert.equal(result.metadata.provider, provider);
    assert.match(result.metadata.promptVersion, /^[\w.-]+/);
    assert.deepEqual(loaded, [provider]);
    assert.equal(seen[0].temperature, 0);
    assert.match(seen[0].instructions, /<persona>/, 'rendered system prompt goes in the system role');
  }
  const rows = await services.providerCalls.listForHousehold(household);
  assert.deepEqual(rows.map(row => row.provider).sort(), ['anthropic', 'deepseek', 'kimi', 'openai']);
  for (const row of rows) { assert.equal(row.status, 'ok'); assert.match(JSON.parse(row.redaction_report_json).promptVersion, /^grounded-pack-v\d+\/chat_answer@/); }
});

test('failover: a missing-key provider is not dispatched, consent is checked per provider and a missing grant sends nothing', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'psc');
  const env = keyed(['openai', 'deepseek'], { MODEL_PROVIDERS: 'anthropic,openai,deepseek' });
  const dispatched = [];
  const asked = [];
  const input = await chatInput();
  const run = authorize => createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls: services.providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    loadModel: async ({ provider }) => { dispatched.push(provider); return {}; }, createAgent: stubAgent([]),
  }).callRouted({ task: 'chat_answer', input, householdId: household, authorize });
  // anthropic has no key: skipped. openai consent missing: nothing sent to it. deepseek consented: answers.
  const result = await run(async provider => { asked.push(provider); return provider === 'deepseek' ? { grant: provider } : null; });
  assert.deepEqual(asked, ['openai', 'deepseek']);
  assert.deepEqual(dispatched, ['deepseek']);
  assert.equal(result.metadata.provider, 'deepseek');
  // No grant for any provider: nothing dispatched at all.
  dispatched.length = 0;
  const none = await run(async () => null);
  assert.deepEqual(dispatched, []);
  assert.equal(none.metadata.calls, 0);
  assert.equal(none.metadata.unavailableReason, 'consent_required');
});

test('error mapping: a failing provider fails over to the next consented one; if all fail the caller gets a typed, client-safe error', async () => {
  const env = keyed(['openai', 'kimi'], { MODEL_PROVIDERS: 'openai,kimi' });
  const input = await chatInput();
  const failing = failFor => settings => ({ generate: async () => { if (failFor.includes(settings.model.stubFor)) throw Object.assign(new Error(`upstream said ${SECRET}`), { statusCode: 500 }); return { output: ANSWER, totalUsage: { inputTokens: 5, outputTokens: 5 } }; } });
  const build = failFor => createChatModelGateway({
    env, router: createModelRouter({ env }), budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    loadModel: async ({ provider }) => ({ stubFor: provider }), createAgent: failing(failFor),
  });
  const ok = await build(['openai']).callRouted({ task: 'chat_answer', input, householdId: 'h1', authorize: async provider => ({ provider }) });
  assert.equal(ok.metadata.provider, 'kimi');
  await assert.rejects(build(['openai', 'kimi']).callRouted({ task: 'chat_answer', input, householdId: 'h1', authorize: async provider => ({ provider }) }),
    error => error.code === 'provider_failure' && !error.message.includes(SECRET));
});

test('no key value reaches any event, audit row or error text', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'psl');
  const env = keyed(['openai'], { MODEL_PROVIDERS: 'openai' });
  const events = [];
  const gateway = createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls: services.providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }), onEvent: event => events.push(event),
    loadModel: async () => ({}), createAgent: stubAgent([]),
  });
  await gateway.call({ task: 'chat_answer', input: await chatInput(), householdId: household });
  const rows = await services.providerCalls.listForHousehold(household);
  assert.equal(JSON.stringify([events, rows]).includes(SECRET), false);
});
