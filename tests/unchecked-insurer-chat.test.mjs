import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { ProviderCallRepository } from '../src/backend/repositories/index.js';
import { createModelRouter } from '../src/integrations/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../src/features/ai-analysis/chat-runtime.js';
import { parseRenderedReference } from '../src/features/ai-analysis/prompt-pack.js';
import { INSURER_UNCHECKED_LABEL } from '../src/features/insurance-rules/fact-source-label.js';

// ADR 0036 in a chat turn: an unchecked insurer fact (ida_wording, extracted_unverified) is served only with a quote, cited with the
// insurer's page and quote, labelled by tier and status in the model slot, and the card always carries the canonical label whatever the
// model wrote. Synthetic data only; the model is a local stub. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const QUOTE = 'Room rent is limited to INR 5,000 per day.';
const ENV = {
  HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'true', CHAT_MODEL_ENABLED: 'true', MODEL_PROVIDERS: 'anthropic',
  ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_INPUT_USD_PER_MILLION: '3', ANTHROPIC_OUTPUT_USD_PER_MILLION: '15',
  ANTHROPIC_CLASSIFY_INPUT_USD_PER_MILLION: '1', ANTHROPIC_CLASSIFY_OUTPUT_USD_PER_MILLION: '5',
};
// The model answers without the label (a model may drop it).
const agent = (sent, answer) => settings => ({
  async generate({ prompt }) {
    sent.push(`${settings.instructions}\n${prompt}`);
    const facts = parseRenderedReference(prompt).payload.facts ?? [];
    const room = facts.find(fact => /room rent/i.test(JSON.stringify(fact.label)));
    return { output: room ? { status: 'extracted_unverified', answer, factsUsed: [room.fact_id] } : { status: 'unknown', answer: 'No model answer.', factsUsed: [] }, totalUsage: { inputTokens: 100, outputTokens: 20 } };
  },
});

async function scenario(t, { env: override = {}, answer = 'Your room rent limit is INR 5,000 per day.' } = {}) {
  const fresh = await freshDatabase(t);
  const { db, handle } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  a.coverageGrant = 'cr-a';
  await insert(handle.pool, 'consent_grants', { id: a.coverageGrant, household_id: a.household, subject_adult_id: a.adult, purpose: 'coverage_reconstruction' });
  await insert(handle.pool, 'consent_scopes', { id: 'scope-a-anthropic', consent_grant_id: a.coverageGrant, resource_type: 'household', action: 'derive', data_category: 'insurance_question', recipient: 'anthropic' });
  const env = { ...ENV, ...override };
  const sent = [];
  const gateway = createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls: new ProviderCallRepository(db), budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    loadModel: async ({ provider }) => ({ stub: true, provider }), createAgent: agent(sent, answer),
  });
  const services = createBackendServices(db, { env, modelGateway: gateway });
  const holding = await services.policyHoldings.create({ householdId: a.household, adultId: a.adult, documentId: a.document, kind: 'retail_health', policyId: a.policy });
  await handle.pool.query("UPDATE policy_holdings SET status = 'ready' WHERE id = $1", [holding.id]);
  const insurer = async (factKey, value, quote, quotePage) => (await services.memoryFacts.insertFact({
    householdId: a.household, holdingId: holding.id, factKey, tier: 'ida_wording', status: 'extracted_unverified', value: { value, alternatives: [] }, consentGrantId: a.coverageGrant,
    provenance: { sourceDocumentId: a.document }, referenceRef: { refId: `ref-${factKey}`, cacheKey: 'cache-1', version: '1', quote, quotePage },
  })).fact.id;
  const ids = {
    room: await insurer('room_rent_limit', { amountMinor: 500_000, currency: 'INR' }, QUOTE, 7),
    // No quote: not served, not cited.
    copay: await insurer('copay_percent', { bp: 1000 }, null, null),
  };
  const turn = async message => {
    const thread = (await services.chatV1.createThread({ principal: { adultId: a.adult }, body: { household_id: a.household, holding_id: holding.id } })).thread;
    const out = [];
    const run = await services.chatV1.startTurn({ principal: { adultId: a.adult }, threadId: thread.id, body: { message } });
    await run.run((event, data) => out.push([event, data]));
    return out;
  };
  return { ...fresh, a, sent, holding, ids, turn, services, at };
}
const answerOf = out => out.find(([event]) => event === 'answer')[1];
const metaOf = out => out.find(([event]) => event === 'meta')[1];

test('chat turn (model path): a fact without a quote is not served; the insurer place gives the card page and quote; the slot is labelled; the card carries the label the model dropped', opts, async t => {
  const s = await scenario(t);
  const out = await s.turn('How much room rent does my policy allow per day?');
  assert.equal(metaOf(out).facts_available, 1, 'the unchecked copay fact has no quote, so it is not served');
  const answer = answerOf(out);
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.deepEqual(answer.facts_used.map(item => [item.fact_id, item.fact_key, item.status]), [[s.ids.room, 'room_rent_limit', 'extracted_unverified']]);
  // Slot suffix: the model is told, in the label, that this is the insurer's wording and not checked.
  assert.equal(s.sent.length, 1);
  assert.ok(s.sent[0].includes(`(${INSURER_UNCHECKED_LABEL})`), 'the model slot label carries the tier and status label');
  assert.equal(s.sent[0].includes('copay'), false);
  // The card: insurer tier and status, the insurer page, the quote as the only evidence text; the label added by code.
  const { card } = answer;
  assert.equal(card.status, 'evidence_found');
  assert.equal(card.verdict, 'unknown');
  assert.deepEqual([card.sources[0].tier, card.sources[0].status, card.sources[0].page, card.sources[0].quote], ['ida_wording', 'extracted_unverified', 7, QUOTE]);
  assert.ok(card.explanation.includes(INSURER_UNCHECKED_LABEL), 'explanation carries the canonical label');
  assert.ok(card.explanation.length <= 280);
  assert.ok(card.answer.includes(INSURER_UNCHECKED_LABEL), 'answer carries the canonical label');
});

test('chat turn (no model): the deterministic answer and the card name the unchecked insurer source; no cited fact for the quote-less copay', opts, async t => {
  const s = await scenario(t, { env: { ANTHROPIC_API_KEY: '' } });
  const answer = answerOf(await s.turn('How much room rent does my policy allow per day?'));
  assert.equal(answer.answer_source, 'deterministic');
  assert.match(answer.answer, /From the insurer's wording, not checked/);
  assert.equal(answer.card.sources[0].tier, 'ida_wording');
  assert.equal(answer.card.sources[0].page, 7);
  assert.equal(answer.card.sources.some(source => source.factIds.includes(s.ids.copay)), false);
});
