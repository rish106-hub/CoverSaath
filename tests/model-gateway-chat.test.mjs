// ADR 0030: provider-routed gateway tasks, the household redaction gate, routing and the provider_calls audit.
// Synthetic data only. No live provider call: the AI SDK agent is a local stub.
import assert from 'node:assert/strict';
import test from 'node:test';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { seedWorld } from './support/postgres-fixtures.mjs';
import { createModelRouter } from '../src/integrations/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../src/features/ai-analysis/chat-runtime.js';
import { gateText, gateTextForHousehold, sealModelInput } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { validateTaskOutput } from '../src/features/ai-analysis/schemas.js';
import { unknownOutput } from '../src/features/ai-analysis/gateway-contract.js';
import { redactionReport } from '../src/backend/repositories/provider-call-repository.js';

const opts = postgresTestOptions();
const NAMES = [{ kind: 'NAME', value: 'Asha Verma' }, { kind: 'NAME', value: 'Ravi Verma' }];
const loadKnownIdentifiers = async householdId => { assert.equal(typeof householdId, 'string'); return NAMES; };

// Synthetic personal data, every value invented. Each pattern below must find nothing in an outbound payload.
const FIXTURE = [
  'Hi, I am Asha Verma and my husband is Ravi.',
  'Aadhaar 2345 6789 0123, PAN ABCDE1234F, mobile 9876543210, email asha.verma@example.test.',
  'DOB 14/03/1985. Policy no: HDF/2024/0099887. Member ID: MBR-445566. Pincode 560034.',
  'Asha asked whether room rent is capped.',
].join(' ');
const LEAK_PATTERNS = [
  /\b\d{4}\s?\d{4}\s?\d{4}\b/, /\b[A-Z]{5}\d{4}[A-Z]\b/, /\b[6-9]\d{9}\b/, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[a-z]{2,}/i,
  /14\/03\/1985/, /HDF\/2024\/0099887/, /MBR-445566/, /\b560034\b/, /Asha/i, /Ravi/i, /Verma/i,
];

const ENV = {
  CHAT_MODEL_ENABLED: 'true', MODEL_PROVIDERS: 'anthropic', ANTHROPIC_API_KEY: 'test-key-not-real',
  ANTHROPIC_INPUT_USD_PER_MILLION: '3', ANTHROPIC_OUTPUT_USD_PER_MILLION: '15',
  ANTHROPIC_CLASSIFY_INPUT_USD_PER_MILLION: '1', ANTHROPIC_CLASSIFY_OUTPUT_USD_PER_MILLION: '5',
};

async function chatInput(householdId, question = FIXTURE) {
  const { gated, rehydrate } = await gateTextForHousehold(question, { householdId, loadKnownIdentifiers });
  const fact = await gateTextForHousehold('Room rent limit', { householdId, loadKnownIdentifiers });
  const value = await gateTextForHousehold('1% of sum insured per day', { householdId, loadKnownIdentifiers });
  const input = sealModelInput('chat_answer', { payload: { question: gated, history: [], facts: [{ fact_id: 'fact_0123456789abcdef01234567', label: fact.gated, value: value.gated }] } });
  return { input, rehydrate };
}

function stubAgent(sent, output) {
  return settings => ({ generate: async ({ prompt }) => { sent.push(`${settings.instructions}\n${prompt}`); return { output, totalUsage: { inputTokens: 100, outputTokens: 20 } }; } });
}

test('the household gate leaves no synthetic PII in the payload and rehydrates only person tokens', async () => {
  const { gated, rehydrate } = await gateTextForHousehold(FIXTURE, { householdId: 'h1', loadKnownIdentifiers });
  for (const pattern of LEAK_PATTERNS) assert.doesNotMatch(gated.text, pattern, String(pattern));
  assert.match(gated.text, /\{\{PERSON_1\}\}/);
  assert.match(gated.text, /560XXX/, 'a pincode keeps its first three digits');
  assert.equal(rehydrate('Hello {{PERSON_1}}, see {{PERSON_2}}.'), 'Hello Asha Verma, see Ravi Verma.');
  assert.equal(rehydrate('Phone {{PHONE_1}}'), 'Phone {{PHONE_1}}');
  assert.equal(gated.placeholderCount > 5, true);
});

test('the household gate refuses ciphertext, raw token syntax and a missing loader', async () => {
  await assert.rejects(gateTextForHousehold('value enc2.k1.AAAAAAAAAAAA.BBBB.CCCC', { householdId: 'h1', loadKnownIdentifiers }), { code: 'RESTRICTED_EVIDENCE' });
  await assert.rejects(gateTextForHousehold('ask {{PERSON_1}} now', { householdId: 'h1', loadKnownIdentifiers }), { code: 'RESTRICTED_EVIDENCE' });
  await assert.rejects(gateTextForHousehold('ask <NAME_1> now', { householdId: 'h1', loadKnownIdentifiers }), { code: 'RESTRICTED_EVIDENCE' });
  await assert.rejects(gateTextForHousehold('hello', { householdId: 'h1' }), { code: 'PRIVACY_GATE_MALFORMED' });
  await assert.rejects(gateTextForHousehold('hello', { householdId: 'h1', loadKnownIdentifiers: async () => { throw new Error('boom'); } }), /boom/);
});

test('names reach the gate only through the loader: a prompt builder never sees them', async () => {
  let loaded = 0;
  const loader = async () => { loaded += 1; return NAMES; };
  await gateTextForHousehold('Asha here', { householdId: 'h1', loadKnownIdentifiers: loader });
  assert.equal(loaded, 1);
  // Document-style gating without seeds leaves a lone first name; the household profile does not.
  assert.match(gateText('Asha said hello', { knownIdentifiers: NAMES }).text, /Asha/);
  assert.doesNotMatch((await gateTextForHousehold('Asha said hello', { householdId: 'h1', loadKnownIdentifiers: loader })).gated.text, /Asha/);
});

test('outbound payload holds no PII and the audit row holds counts and a digest, never text', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'gw');
  const sent = [];
  const gateway = createChatModelGateway({
    env: ENV, router: createModelRouter({ env: ENV }), providerCalls: services.providerCalls,
    budgetFor: createHouseholdDayBudget({ maxUsd: 1 }), loadModel: async () => ({ stub: true }),
    createAgent: stubAgent(sent, { status: 'extracted_unverified', answer: 'Room rent is capped at 1% of the sum insured per day.', factsUsed: ['fact_0123456789abcdef01234567'] }),
  });
  const { input } = await chatInput(household);
  const result = await gateway.call({ task: 'chat_answer', input, householdId: household });
  assert.equal(result.output.status, 'extracted_unverified');
  assert.equal(sent.length, 1);
  for (const pattern of LEAK_PATTERNS) assert.doesNotMatch(sent[0], pattern, String(pattern));
  const rows = await services.providerCalls.listForHousehold(household);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual([row.purpose, row.provider, row.model, row.status], ['chat_answer', 'anthropic', 'claude-sonnet-5-5', 'ok']);
  assert.match(row.payload_sha256, /^[0-9a-f]{64}$/);
  assert.equal(row.input_tokens, 100);
  assert.ok(row.cost_paise > 0);
  const report = JSON.parse(row.redaction_report_json);
  assert.ok(report.placeholders >= 6 && report.gatedSlots === 3 && report.gateVersion);
  assert.deepEqual(Object.keys(report).sort(), ['gateVersion', 'gatedBytes', 'gatedSlots', 'placeholders', 'promptVersion', 'reasonCodes']);
  // The prompt version is a code label (grounded prompt pack), never prompt text.
  assert.match(report.promptVersion, /^grounded-pack-v\d+\/chat_answer@grounded-v\d+$/);
  assert.doesNotMatch(JSON.stringify(row), /room rent|Asha|HDF|sum insured/i, 'no payload text in the row');
});

test('no key: the call returns a typed unknown, dispatches nothing and is audited', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'nk');
  const env = { ...ENV, ANTHROPIC_API_KEY: '' };
  let loaded = 0;
  const gateway = createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls: services.providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    loadModel: async () => { loaded += 1; return {}; }, createAgent: () => { throw new Error('must not run'); },
  });
  const { input } = await chatInput(household);
  const result = await gateway.call({ task: 'chat_answer', input, householdId: household });
  assert.equal(result.output.status, 'unknown');
  assert.equal(result.metadata.calls, 0);
  assert.equal(result.metadata.unavailableReason, 'key_missing');
  assert.equal(loaded, 0);
  const [row] = await services.providerCalls.listForHousehold(household);
  assert.equal(row.status, 'provider_unavailable');
  assert.equal(row.input_tokens + row.output_tokens + row.cost_paise, 0);
});

test('flag off: typed unknown, no provider, no audit row', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'fo');
  for (const flag of [undefined, 'TRUE', '1', 'yes']) {
    const env = { ...ENV, CHAT_MODEL_ENABLED: flag };
    const gateway = createChatModelGateway({ env, router: createModelRouter({ env }), providerCalls: services.providerCalls, createAgent: () => { throw new Error('must not run'); } });
    assert.equal(gateway.enabled, false);
    const result = await gateway.call({ task: 'intent_classify', input: {}, householdId: household });
    assert.deepEqual(result.output, unknownOutput('intent_classify'));
    assert.equal(result.metadata.unavailableReason, 'flag_off');
  }
  assert.equal((await services.providerCalls.listForHousehold(household)).length, 0);
});

test('only gate-minted input passes: a hand-made payload is refused before any provider', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'ug');
  const gateway = createChatModelGateway({
    env: ENV, router: createModelRouter({ env: ENV }), providerCalls: services.providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    createAgent: () => { throw new Error('must not run'); },
  });
  const forged = { payload: { question: 'Asha 9876543210', history: [], facts: [] } };
  await assert.rejects(gateway.call({ task: 'chat_answer', input: forged, householdId: household }), { code: 'ungated_model_input' });
  const [row] = await services.providerCalls.listForHousehold(household);
  assert.equal(row.status, 'ungated_model_input');
  assert.equal(row.payload_sha256, null);
});

test('routing: deepseek, kimi and openai are config entries that answer typed unknown; routes follow purpose and tier', () => {
  for (const provider of ['deepseek', 'kimi', 'openai']) {
    const env = { MODEL_PROVIDERS: provider, [`${provider.toUpperCase()}_API_KEY`]: 'k' };
    const route = createModelRouter({ env, routes: { chat_answer: [{ provider, tier: 'default' }] } }).resolve('chat_answer');
    assert.deepEqual([route.status, route.reason, route.provider], ['unavailable', 'no_sdk_adapter', provider]);
  }
  const router = createModelRouter({ env: ENV });
  assert.equal(router.resolve('chat_answer').model, 'claude-sonnet-5-5');
  assert.equal(router.resolve('fact_extract').model, 'claude-sonnet-5-5');
  assert.equal(router.resolve('intent_classify').model, 'claude-haiku-5-5');
  assert.equal(router.resolve('embed').reason, 'provider_not_enabled');
  assert.equal(createModelRouter({ env: { ...ENV, MODEL_PROVIDERS: 'openai' } }).resolve('chat_answer').reason, 'provider_not_enabled');
  assert.equal(createModelRouter({ env: { ...ENV, ANTHROPIC_OUTPUT_USD_PER_MILLION: '' } }).resolve('chat_answer').reason, 'rates_missing');
  assert.equal(JSON.stringify(createModelRouter({ env: { ...ENV, ANTHROPIC_API_KEY: '' } }).resolve('chat_answer')).includes('test-key'), false);
});

test('model output status is only extracted_unverified, conflicting or unknown; grounding is checked by code', () => {
  const facts = [{ fact_id: 'fact_0123456789abcdef01234567', label: 'Room rent', value: '1% of sum insured' }];
  const input = { payload: { question: 'What is the limit?', history: [], facts } };
  const ok = { status: 'extracted_unverified', answer: 'The limit is 1% of the sum insured.', factsUsed: [facts[0].fact_id] };
  assert.deepEqual(validateTaskOutput('chat_answer', ok, input), ok);
  assert.throws(() => validateTaskOutput('chat_answer', { ...ok, status: 'confirmed' }, input), { code: 'invalid_schema' });
  assert.throws(() => validateTaskOutput('chat_answer', { ...ok, status: 'proven' }, input), { code: 'invalid_schema' });
  assert.throws(() => validateTaskOutput('chat_answer', { ...ok, factsUsed: ['fact_ffffffffffffffffffffffff'] }, input), { code: 'missing_citation' });
  assert.throws(() => validateTaskOutput('chat_answer', { ...ok, answer: 'Your claim is guaranteed to be paid.' }, input), { code: 'unsupported_claim' });
  const extract = { payload: { text: 'Waiting period is 24 months.', keys: ['waiting_period'] } };
  assert.doesNotThrow(() => validateTaskOutput('fact_extract', { status: 'extracted_unverified', facts: [{ key: 'waiting_period', value: '24 months', quote: 'Waiting period is 24 months.', status: 'extracted_unverified' }] }, extract));
  assert.throws(() => validateTaskOutput('fact_extract', { status: 'extracted_unverified', facts: [{ key: 'waiting_period', value: '12 months', quote: 'Waiting period is 12 months.', status: 'extracted_unverified' }] }, extract), { code: 'quote_not_found' });
  assert.throws(() => validateTaskOutput('fact_extract', { status: 'unknown', facts: [{ key: 'other', value: null, quote: '', status: 'unknown' }] }, extract), { code: 'field_not_requested' });
  assert.doesNotThrow(() => validateTaskOutput('intent_classify', { status: 'unknown', intent: 'unknown' }, { payload: { text: 'hi', intents: ['general'] } }));
  assert.doesNotThrow(() => validateTaskOutput('embed', unknownOutput('embed'), { payload: { texts: [{ text: 'a' }] } }));
});

test('redactionReport keeps counts only', () => {
  const report = redactionReport({ gateVersion: 'knowvia-privacy-evidence-v11', gatedSlots: 2, placeholders: 5, reasonCodes: 1, gatedBytes: 40, text: 'Asha', kinds: ['NAME'] });
  assert.deepEqual(report, { gateVersion: 'knowvia-privacy-evidence-v11', gatedSlots: 2, placeholders: 5, reasonCodes: 1, gatedBytes: 40 });
});

test('provider_calls: ownership scope and erasure', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const a = await seedWorld(handle.pool, 'pa');
  const b = await seedWorld(handle.pool, 'pb');
  const event = { task: 'chat_answer', outcome: 'ok', provider: 'anthropic', model: 'claude-sonnet-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0.001, gatedSlots: 1, placeholders: 1, reasonCodes: 1, gatedBytes: 4 };
  await services.providerCalls.record({ ...event, householdId: a.household });
  await services.providerCalls.record({ ...event, householdId: b.household });
  await services.providerCalls.record({ ...event, householdId: null });
  assert.equal((await services.providerCalls.listForHousehold(a.household)).length, 1, 'household A reads only its own rows');
  await assert.rejects(services.providerCalls.record({ ...event, householdId: 'no-such-household' }), /household/);
  await assert.rejects(handle.pool.query("UPDATE provider_calls SET status = 'x'"), /append-only/);
  assert.equal(await services.providerCalls.eraseForHousehold(a.household), 1);
  assert.equal((await services.providerCalls.listForHousehold(a.household)).length, 0);
  assert.equal((await services.providerCalls.listForHousehold(b.household)).length, 1, 'household B untouched');
});

test('embedding calls pass the same gate and audit: gated text, typed unknown without a route, forged input refused', opts, async t => {
  const { services, handle } = await freshDatabase(t);
  const { household } = await seedWorld(handle.pool, 'em');
  const gateway = createChatModelGateway({
    env: ENV, router: createModelRouter({ env: ENV }), providerCalls: services.providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    createAgent: () => { throw new Error('must not run'); },
  });
  const { gated } = await gateTextForHousehold(FIXTURE, { householdId: household, loadKnownIdentifiers }); const gatedText = gated.text ?? gated;
  for (const pattern of LEAK_PATTERNS) assert.doesNotMatch(gatedText, pattern);
  const input = sealModelInput('embed', { payload: { texts: [{ text: gated }] } });
  const result = await gateway.call({ task: 'embed', input, householdId: household });
  assert.equal(result.output.status, 'unknown');
  assert.equal(result.metadata.calls, 0);
  await assert.rejects(gateway.call({ task: 'embed', input: { payload: { texts: [{ text: 'Asha 9876543210' }] } }, householdId: household }), { code: 'ungated_model_input' });
  const rows = await services.providerCalls.listForHousehold(household);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.purpose === 'embed'));
  assert.ok(rows.some(row => row.status === 'ungated_model_input' && row.payload_sha256 === null));
  assert.doesNotMatch(JSON.stringify(rows), /Asha|9876543210/);
});
