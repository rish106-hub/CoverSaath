import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelRouter, MODEL_ROUTES } from '../src/integrations/model-routing/index.js';
import { CHAT_PROVIDERS, CHAT_PROVIDER_SCOPES, chatScopeFor } from '../src/contracts/data-purpose-registry.js';

// Model routing order and the consent scope per routed provider. Synthetic keys only; nothing is called.
const keys = names => Object.fromEntries(names.flatMap(name => [[`${name}_API_KEY`, 'test-key-not-real'], [`${name}_INPUT_USD_PER_MILLION`, '1'], [`${name}_OUTPUT_USD_PER_MILLION`, '4'],
  [`${name}_CLASSIFY_INPUT_USD_PER_MILLION`, '1'], [`${name}_CLASSIFY_OUTPUT_USD_PER_MILLION`, '4']]));

test('chat tasks route Gemini first, then anthropic, openai, deepseek, kimi; embed stays voyage', () => {
  for (const task of ['chat_answer', 'intent_classify', 'fact_extract']) assert.deepEqual(MODEL_ROUTES[task].map(route => route.provider), ['gemini', 'anthropic', 'openai', 'deepseek', 'kimi']);
  assert.deepEqual(MODEL_ROUTES.embed.map(route => route.provider), ['voyage']);
});

test('the default MODEL_PROVIDERS (unset) still enables anthropic only', () => {
  const router = createModelRouter({ env: keys(['ANTHROPIC', 'GEMINI']) });
  assert.equal(router.resolve('chat_answer').provider, 'anthropic');
  assert.deepEqual(router.candidates('chat_answer').map(route => route.provider), ['anthropic']);
});

test('candidates are the ready providers in order; resolve follows the first and can pin one', () => {
  const env = { MODEL_PROVIDERS: 'gemini,anthropic,openai,deepseek,kimi,voyage', ...keys(['GEMINI', 'ANTHROPIC', 'OPENAI', 'DEEPSEEK', 'KIMI']), MOONSHOT_API_KEY: 'test-key-not-real' };
  const router = createModelRouter({ env });
  assert.deepEqual(router.candidates('chat_answer').map(route => route.provider), ['gemini', 'anthropic', 'openai', 'deepseek', 'kimi'], 'every chat provider has an SDK adapter');
  assert.equal(router.resolve('chat_answer').provider, 'gemini');
  assert.equal(router.resolve('chat_answer', { provider: 'anthropic' }).provider, 'anthropic');
  assert.equal(router.resolve('chat_answer', { provider: 'deepseek' }).sdk, 'deepseek');
  assert.equal(router.resolve('chat_answer', { provider: 'voyage' }).reason, 'no_route');
  assert.equal(router.resolve('chat_answer', { provider: 'gemini' }).model, router.resolve('chat_answer').model);
});

test('a missing key or rate skips that provider only; unavailable reasons come from enabled providers first', () => {
  const env = { MODEL_PROVIDERS: 'gemini,anthropic', ...keys(['ANTHROPIC']), GEMINI_API_KEY: '' };
  const router = createModelRouter({ env });
  assert.deepEqual(router.candidates('chat_answer').map(route => route.provider), ['anthropic']);
  assert.equal(createModelRouter({ env: { MODEL_PROVIDERS: 'gemini,anthropic' } }).resolve('chat_answer').reason, 'key_missing');
  assert.equal(createModelRouter({ env: { MODEL_PROVIDERS: 'voyage' } }).resolve('chat_answer').reason, 'provider_not_enabled');
  assert.deepEqual(createModelRouter({ env: {} }).candidates('chat_answer'), []);
});

test('drift: every chat route provider has a registered consent scope naming exactly that recipient, and nothing else does', () => {
  const routed = new Set(['chat_answer', 'intent_classify', 'fact_extract'].flatMap(task => MODEL_ROUTES[task].map(route => route.provider)));
  assert.deepEqual([...routed].sort(), [...CHAT_PROVIDERS].sort());
  assert.deepEqual(Object.keys(CHAT_PROVIDER_SCOPES).sort(), [...CHAT_PROVIDERS].sort());
  for (const provider of CHAT_PROVIDERS) assert.equal(chatScopeFor(provider).recipient, provider);
  assert.throws(() => chatScopeFor('voyage'), { code: 'CHAT_PROVIDER_UNKNOWN' });
  assert.throws(() => chatScopeFor('google-gemini'), { code: 'CHAT_PROVIDER_UNKNOWN' });
});
