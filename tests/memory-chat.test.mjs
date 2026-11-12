import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { ProviderCallRepository } from '../src/backend/repositories/index.js';
import { createModelRouter, createVoyageEmbedClient } from '../src/integrations/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../src/features/ai-analysis/chat-runtime.js';
import { createEmbedRunner } from '../src/features/ai-analysis/embed-runner.js';
import { classifyChatMessage } from '../src/features/insurance-rules/chat-intent.js';
import { planProcedure } from '../src/features/insurance-rules/procedure-planning.js';
import { formatFactValue } from '../src/features/insurance-rules/fact-format.js';
import { eraseMemoryForConsentGrant, eraseMemoryForDocuments, eraseMemoryForHousehold } from '../src/backend/repositories/memory-erasure.js';
import { createApiServer } from '../src/server/server.js';
import { parseRenderedReference } from '../src/features/ai-analysis/prompt-pack.js';

// Memory and chat v1 (migrations 053-054, ADR 0031, ADR 0029): the success path (confirmed fact -> answer citing its id, redaction counts
// in provider_calls), fallbacks, ownership, erasure of chunks, threads, turns and traces, and the voice fields. Synthetic data only. No live
// provider call: the model is a local agent stub and the embedding provider a local fixture client. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const UIN = 'ABCHLIP12345V012021';
const ENV = {
  HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'true', CHAT_MODEL_ENABLED: 'true', MODEL_PROVIDERS: 'anthropic,voyage',
  ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_INPUT_USD_PER_MILLION: '3', ANTHROPIC_OUTPUT_USD_PER_MILLION: '15',
  ANTHROPIC_CLASSIFY_INPUT_USD_PER_MILLION: '1', ANTHROPIC_CLASSIFY_OUTPUT_USD_PER_MILLION: '5',
  VOYAGE_API_KEY: 'test-voyage-key-not-real', VOYAGE_INPUT_USD_PER_MILLION: '0.06',
};

const vectorOf = text => {
  const digest = createHash('sha256').update(text).digest();
  return Array.from({ length: 1024 }, (_, i) => ((digest[i % 32] - 127.5) / 127.5) + (i % 7) * 0.001);
};
const embedClient = (calls, hook) => ({ model: 'voyage-3.5', async embed({ texts }) { calls.push(...texts); await hook?.(); return { vectors: texts.map(vectorOf), totalTokens: texts.length * 10, model: 'voyage-3.5' }; } });
const answerStub = (sent, answer = 'Hello {{PERSON_1}}. Your room rent limit is INR 5,000 per day, from the insurer wording.', hook = null) => settings => ({
  async generate({ prompt }) {
    await hook?.();
    sent.push(`${settings.instructions}\n${prompt}`);
    const facts = parseRenderedReference(prompt).payload.facts ?? [];
    const room = facts.find(fact => /room rent/i.test(JSON.stringify(fact.label))) ?? facts.find(fact => /passage/i.test(JSON.stringify(fact.label)) && /ambulance/i.test(JSON.stringify(fact.value)));
    return { output: room ? { status: 'extracted_unverified', answer, factsUsed: [room.fact_id] } : { status: 'unknown', answer: 'No model answer.', factsUsed: [] }, totalUsage: { inputTokens: 100, outputTokens: 20 } };
  },
});

const SCOPE = recipient => ({ resource_type: 'household', action: 'derive', data_category: 'insurance_question', recipient });
// FOR LEGAL REVIEW: the grant that opens the chat and embedding providers (purpose coverage_reconstruction, one scope per recipient).
async function grantProviders(pool, id, recipients = ['anthropic', 'voyage']) {
  for (const recipient of recipients) await insert(pool, 'consent_scopes', { id: `scope-${id}-${recipient}`, consent_grant_id: id, ...SCOPE(recipient) });
}

async function scenario(t, { env: override = {}, budget = 1, facts = true, clauses = true, recipients = ['anthropic', 'voyage'], onGenerate = null, onEmbed = null, answer = undefined, agent = null } = {}) {
  const fresh = await freshDatabase(t);
  const { db, handle } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const w of [a, b]) {
    const key = w.household.split('-')[1];
    w.profileGrant = `pi-${key}`; w.coverageGrant = `cr-${key}`;
    await insert(handle.pool, 'consent_grants', { id: w.profileGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'profile_intake' });
    await insert(handle.pool, 'consent_grants', { id: w.coverageGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'coverage_reconstruction' });
  }
  await grantProviders(handle.pool, a.coverageGrant, recipients);
  const env = { ...ENV, ...override };
  const sent = [];
  const embedded = [];
  const providerCalls = new ProviderCallRepository(db);
  const gateway = createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: budget }),
    loadModel: async ({ provider }) => ({ stub: true, provider }), createAgent: agent?.(sent) ?? answerStub(sent, answer, () => onGenerate?.(handle, a)), embedClientFor: () => embedClient(embedded, () => onEmbed?.(handle, a)),
  });
  const services = createBackendServices(db, { env, modelGateway: gateway });
  const crypto = services.columnCrypto;
  // The household's people: a name that must never reach a prompt.
  await handle.pool.query('UPDATE household_members SET display_name = $1 WHERE id = $2', [crypto.seal('household_members', 'display_name', a.member, 'Asha Verma'), a.member]);
  await insert(handle.pool, 'policy_profiles', { id: 'profile-a', household_id: a.household, case_id: a.case, document_id: a.document, source_version: '1', uin: UIN, uin_state: 'reported',
    policy_name_enc: 'enc2.k1.AAAA.BBBB.CCCC', policy_name_state: 'reported', confirmation_source: 'user_statement', confirmed_at: at, confirmed_by_adult_id: a.adult });
  const holding = await services.policyHoldings.create({ householdId: a.household, adultId: a.adult, documentId: a.document, kind: 'retail_health', policyId: a.policy });
  await handle.pool.query("UPDATE policy_holdings SET status = 'ready' WHERE id = $1", [holding.id]);
  const ids = {};
  if (facts) {
    const ida = async (factKey, value) => { ids[factKey] = (await services.memoryFacts.insertFact({
      householdId: a.household, holdingId: holding.id, factKey, tier: 'ida_wording', status: 'reviewed_reference', value: { value, alternatives: [] }, consentGrantId: a.coverageGrant,
      provenance: { sourceDocumentId: a.document }, referenceRef: { refId: 'ref-1', cacheKey: 'cache-1', version: '1', quote: 'as published' },
    })).fact.id; };
    await ida('room_rent_limit', { amountMinor: 500_000 });
    await ida('waiting_initial', { days: 30 });
    await ida('copay_percent', { bp: 1000 });
    ids.start_date = (await services.memoryFacts.insertFact({
      householdId: a.household, adultId: a.adult, holdingId: holding.id, factKey: 'start_date', tier: 'user_declaration', status: 'user_confirmed',
      value: { value: { iso: '2026-01-01' }, alternatives: [] }, consentGrantId: a.profileGrant, captureMethod: 'typed',
    })).fact.id;
  }
  if (clauses) {
    const clause = (id, text, page) => insert(handle.pool, 'policy_clauses', { id, household_id: a.household, case_id: a.case, document_id: a.document, page, text: crypto.seal('policy_clauses', 'text', id, text), digest: createHash('sha256').update(text).digest('hex') });
    await clause('clause-a-1', 'Asha Verma is insured. The room rent for a private room is limited to INR 5,000 per day under this plan.', 1);
    await clause('clause-a-2', 'Ambulance charges are paid up to INR 2,000 per trip.', 2);
  }
  const turn = async ({ adultId = a.adult, threadId, body }) => {
    const out = [];
    const run = await services.chatV1.startTurn({ principal: { adultId }, threadId, body });
    await run.run((event, data) => out.push([event, data]));
    return out;
  };
  const thread = async (extra = {}) => (await services.chatV1.createThread({ principal: { adultId: a.adult }, body: { household_id: a.household, holding_id: holding.id, ...extra } })).thread;
  const count = async (table, household = a.household) => Number((await db.one(`SELECT count(*) AS c FROM ${table} WHERE household_id = ?`, [household])).c);
  return { ...fresh, services, a, b, env, sent, embedded, holding, ids, turn, thread, count, providerCalls };
}
const answerOf = out => out.find(([event]) => event === 'answer')[1];

test('success: memorise embeds redacted passages, a room-rent question cites the confirmed fact id, redaction counts are audited', opts, async t => {
  const { services, db, a, sent, embedded, holding, ids, turn, thread, count, providerCalls } = await scenario(t);
  const result = await services.holdings.memorise({ householdId: a.household, holdingId: holding.id });
  assert.equal(result.embedded, 6, '4 confirmed facts and 2 own-PDF clauses');
  assert.equal(await count('memory_chunks'), 6);
  // Redacted before embedding: the provider saw placeholders, never the name.
  assert.ok(embedded.length === 6 && embedded.every(text => !/Asha|Verma/.test(text)), 'no household name in any embedded text');
  assert.ok(embedded.some(text => /\{\{PERSON_1\}\}/.test(text)), 'the clause name became a placeholder');
  const raw = await db.many('SELECT chunk_text_enc FROM memory_chunks WHERE household_id = ?', [a.household]);
  assert.ok(raw.every(row => /^enc2[.]/.test(row.chunk_text_enc)));
  const embedRows = (await providerCalls.listForHousehold(a.household)).filter(row => row.purpose === 'embed');
  assert.ok(embedRows.length >= 1 && embedRows.every(row => row.status === 'ok' && row.provider === 'voyage'));
  assert.ok(embedRows.some(row => JSON.parse(row.redaction_report_json).placeholders > 0), 'redaction counts > 0 in provider_calls');
  // A second run embeds nothing new (idempotent) and writes nothing.
  assert.equal((await services.holdings.memorise({ householdId: a.household, holdingId: holding.id })).embedded, 0);
  assert.equal(await count('memory_chunks'), 6);

  const conversation = await thread();
  const out = await turn({ threadId: conversation.id, body: { message: 'Asha asks: how much room rent does my policy allow per day?' } });
  assert.deepEqual(out.map(([event]) => event).filter((event, i, all) => all.indexOf(event) === i), ['meta', 'delta', 'answer', 'done']);
  const answer = answerOf(out);
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.equal(answer.status, 'evidence_found');
  assert.equal(answer.intent, 'coverage_question');
  assert.deepEqual(answer.facts_used.map(item => [item.fact_id, item.fact_key, item.status]), [[ids.room_rent_limit, 'room_rent_limit', 'reviewed_reference']]);
  assert.match(answer.answer, /Hello Asha/, 'person tokens are restored in the reply only');
  assert.match(answer.facts_used[0].value_text, /5,000/);
  // Never a decrypted name or the UIN in a prompt or a response body.
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0], /Asha|Verma/);
  assert.match(sent[0], /PERSON_1/);
  for (const text of [sent[0], JSON.stringify(out), ...embedded]) assert.doesNotMatch(text, new RegExp(UIN));
  const chatRows = (await providerCalls.listForHousehold(a.household)).filter(row => row.purpose === 'chat_answer');
  assert.equal(chatRows.length, 1);
  assert.ok(JSON.parse(chatRows[0].redaction_report_json).placeholders > 0);
  // Stored: sealed turns, an assistant summary and a trace naming the fact.
  assert.equal(await count('chat_turns'), 2);
  const turnRows = await db.many('SELECT * FROM chat_turns WHERE household_id = ? ORDER BY turn_index', [a.household]);
  assert.ok(turnRows.every(row => /^enc2[.]/.test(row.content_enc)));
  assert.equal(JSON.stringify(turnRows).includes('room rent'), false, 'no plaintext of the conversation at rest');
  assert.deepEqual([turnRows[1].role, turnRows[1].answer_source, turnRows[1].provider, turnRows[1].model], ['assistant', 'model', 'anthropic', 'claude-sonnet-5-5']);
  assert.match(turnRows[1].redacted_prompt_hash, /^[0-9a-f]{64}$/);
  const trace = await services.chatRepository.trace({ householdId: a.household, turnId: answer.turn_id });
  assert.deepEqual([trace.mode, trace.factIds.includes(ids.room_rent_limit), trace.holdingIds], ['facts_only', true, [holding.id]]);
});

test('procedure planning: waiting period, sub-limit, room rent and co-pay are computed in code; no model needed', opts, async t => {
  const { services, a, turn, thread, providerCalls, holding } = await scenario(t, { env: { CHAT_MODEL_ENABLED: 'false' } });
  const conversation = await thread();
  const out = await turn({ threadId: conversation.id, body: { message: 'We are planning a knee surgery soon', procedure: { planned_date: '2026-01-20', estimated_cost_inr: 250000, room_rent_per_day_inr: 8000, stay_days: 3 } } });
  const answer = answerOf(out);
  assert.equal(answer.intent, 'procedure_planning');
  assert.equal(answer.answer_source, 'deterministic');
  const byId = Object.fromEntries(answer.computed.checks.map(check => [check.id, check]));
  assert.equal(byId['waiting:waiting_initial'].status, 'attention', 'the 30-day waiting period ends 2026-01-31, after the planned date');
  assert.equal(byId.room_rent.status, 'attention');
  assert.equal(byId.copay.status, 'info');
  assert.deepEqual(answer.computed.summary, { estimateMinor: 25_000_000, insurerShareMinor: 21_600_000, youPayMinor: 3_400_000, basis: 'estimate_from_terms_on_record' });
  assert.equal(answer.status, 'evidence_found');
  assert.ok(answer.facts_used.length >= 3);
  assert.match(answer.answer, /not an approval/);
  assert.equal((await providerCalls.listForHousehold(a.household)).length, 0, 'flag off: no provider call, no audit row');
  assert.ok(holding.id);
  // Planning arithmetic on its own: sub-limit and missing inputs.
  const facts = { sub_limit: { id: 'l', value: { amountMinor: 20_000_000 } }, copay_percent: { id: 'c', value: { bp: 1000 } } };
  const plan = planProcedure({ facts, procedure: { estimatedCostMinor: 25_000_000 } });
  assert.deepEqual(plan.summary, { estimateMinor: 25_000_000, insurerShareMinor: 18_000_000, youPayMinor: 7_000_000, basis: 'estimate_from_terms_on_record' });
  assert.equal(planProcedure({ facts: { waiting_initial: { id: 'w', value: { days: 30 } } }, procedure: {} }).checks[0].status, 'unknown');
  assert.ok(services);
});

test('fallbacks: budget spent, no key and no embeddings still answer deterministically; clauses are matched by keyword', opts, async t => {
  const spent = await scenario(t, { budget: 0.0000001 });
  const c1 = await spent.thread();
  const a1 = answerOf(await spent.turn({ threadId: c1.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(a1.answer_source, 'deterministic');
  assert.equal(a1.model_status, 'budget_refused');
  assert.equal(a1.facts_used[0].fact_key, 'room_rent_limit');
  assert.match(a1.answer, /5,000/);
});

test('no provider keys: embeddings are skipped, chat works from facts and a keyword match over clauses', opts, async t => {
  const s = await scenario(t, { env: { ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '' } });
  const result = await s.services.holdings.memorise({ householdId: s.a.household, holdingId: s.holding.id });
  assert.equal(result.embedded, 0);
  assert.equal(result.embedSkipped, 'embeddings_unavailable');
  assert.equal(await s.count('memory_chunks'), 0);
  const conversation = await s.thread();
  const keyed = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about the ambulance?' } }));
  assert.equal(keyed.answer_source, 'deterministic');
  assert.match(keyed.answer, /From your policy document \(page 2\)/);
  const trace = await s.services.chatRepository.trace({ householdId: s.a.household, turnId: keyed.turn_id });
  assert.equal(trace.mode, 'keyword');
  const noKey = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(noKey.model_status, 'key_missing');
  assert.equal(noKey.facts_used[0].fact_key, 'room_rent_limit');
});

test('vector retrieval: with embeddings the nearest passages are retrieved and cited as chunks', opts, async t => {
  const s = await scenario(t, { facts: false });
  assert.equal((await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id })).embedded, 2);
  const query = vectorOf('the room rent for a private room is limited');
  const hits = await s.services.memoryChunks.search({ householdId: s.a.household, embedding: query, limit: 5 });
  assert.equal(hits.length, 2);
  assert.ok(hits.every(hit => typeof hit.score === 'number' && !/Asha|Verma/.test(hit.text)));
  assert.equal((await s.services.memoryChunks.search({ householdId: s.b.household, embedding: query, limit: 5 })).length, 0, 'another household sees none');
  // Chat with no confirmed fact: the embedded question retrieves chunks and the trace names them.
  const conversation = await s.thread();
  const out = await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about room rent?' } });
  const trace = await s.services.chatRepository.trace({ householdId: s.a.household, turnId: answerOf(out).turn_id });
  assert.equal(trace.mode, 'vector');
  assert.equal(trace.chunkIds.length, 2);
});

test('ownership: another household cannot read, write or probe a thread, holding or chunk; flags are exact', opts, async t => {
  const s = await scenario(t);
  const conversation = await s.thread();
  await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id });
  const code = expected => error => { assert.equal(error.code, expected, `${error.code}: ${error.message}`); return true; };
  await assert.rejects(s.services.chatRepository.getThread({ threadId: conversation.id, adultId: s.b.adult }), code('CHAT_THREAD_NOT_FOUND'));
  await assert.rejects(s.services.chatV1.startTurn({ principal: { adultId: s.b.adult }, threadId: conversation.id, body: { message: 'hello' } }), code('CHAT_THREAD_NOT_FOUND'));
  await assert.rejects(s.services.chatV1.startTurn({ principal: { adultId: s.a.adult }, threadId: 'thread-missing', body: { message: 'hello' } }), code('CHAT_THREAD_NOT_FOUND'));
  await assert.rejects(s.services.chatV1.createThread({ principal: { adultId: s.b.adult }, body: { household_id: s.a.household } }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(s.services.chatV1.createThread({ principal: { adultId: s.b.adult }, body: { household_id: s.b.household, holding_id: s.holding.id } }), code('HOLDING_NOT_FOUND'));
  assert.deepEqual(await s.services.chatRepository.recentTurns({ householdId: s.b.household, threadId: conversation.id }), []);
  assert.equal(await s.services.memoryChunks.count({ householdId: s.b.household }), 0);
  assert.equal(await s.services.chatRepository.mayReadHoldingFacts({ householdId: s.a.household, adultId: s.b.adult }), false, 'another household\'s adult may not read this household\'s facts (F7)');
  assert.equal(await s.services.chatRepository.mayReadHoldingFacts({ householdId: s.a.household, adultId: s.a.adult }), true);
  assert.ok(await s.services.memoryChunks.count({ householdId: s.a.household }) > 0);
  // Input is validated: unknown fields, empty and oversized messages, bad procedure.
  for (const body of [{ message: 'x', extra: 1 }, { message: '' }, { message: 'y'.repeat(1001) }, { message: 'x', input_kind: 'video' }, { message: 'x', procedure: { stay_days: -1 } }, { message: 'x', procedure: { name: 'knee' } }, { message: 'x', audio_document_id: 'doc' }]) {
    await assert.rejects(s.services.chatV1.startTurn({ principal: { adultId: s.a.adult }, threadId: conversation.id, body }), code('CHAT_REQUEST_INVALID'));
  }
  // Off unless MEMORY_ENABLED is exactly "true".
  for (const flag of [undefined, 'TRUE', '1']) {
    const off = createBackendServices(s.db, { env: { ...ENV, MEMORY_ENABLED: flag }, modelGateway: { enabled: false } });
    await assert.rejects(off.chatV1.createThread({ principal: { adultId: s.a.adult }, body: { household_id: s.a.household } }), code('MEMORY_DISABLED'));
    assert.deepEqual(await off.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id }), { embedded: 0, removed: 0, refused: 0, skipped: 'memory_disabled' });
  }
});

test('consent: a revoked document grant writes no chunk (re-checked inside the write)', opts, async t => {
  const s = await scenario(t);
  await s.db.run("UPDATE consent_grants SET revoked_at = ? WHERE id = ?", [new Date().toISOString(), s.a.consent]);
  const result = await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id });
  assert.equal(result.embedded, 0);
  assert.equal(await s.count('memory_chunks'), 0);
});

test('erasure: household, document and consent erasure delete chunks, threads, turns and traces; other households stay', opts, async t => {
  const s = await scenario(t);
  const { a, b, db, handle } = s;
  await s.services.memory.embedHolding({ householdId: a.household, holdingId: s.holding.id });
  // A household-wide thread (no holding) whose trace names a fact: erased by the trace overlap rule, not by the holding.
  const wide = await s.services.chatV1.createThread({ principal: { adultId: a.adult }, body: { household_id: a.household } });
  await s.turn({ threadId: wide.thread.id, body: { message: 'what is the room rent limit?' } });
  const own = await s.thread();
  await s.turn({ threadId: own.id, body: { message: 'what is the waiting period?' } });
  // Another household with rows in every new store.
  await insert(handle.pool, 'policy_holdings', { id: 'h-b', household_id: b.household, document_id: b.document });
  await insert(handle.pool, 'memory_chunks', { id: 'c-b', household_id: b.household, holding_id: 'h-b', consent_grant_id: b.consent, source_document_id: b.document });
  await insert(handle.pool, 'chat_threads', { id: 't-b', household_id: b.household, holding_id: 'h-b', created_by_adult_id: b.adult });
  await insert(handle.pool, 'chat_turns', { id: 'u-b', household_id: b.household, thread_id: 't-b', role: 'assistant' });
  await insert(handle.pool, 'retrieval_traces', { id: 'r-b', household_id: b.household, thread_id: 't-b', turn_id: 'u-b' });
  const stores = ['memory_chunks', 'chat_threads', 'chat_turns', 'retrieval_traces'];
  for (const store of stores) assert.ok(await s.count(store) > 0, store);

  // 1. Revoking the grant the facts were written under erases the facts and every thread whose trace names one.
  const revoked = await eraseMemoryForConsentGrant(db, { householdId: a.household, consentGrantId: a.coverageGrant });
  assert.ok(revoked.threads === 2 && revoked.facts > 0, JSON.stringify(revoked));
  assert.equal(await s.count('chat_threads'), 0);
  assert.equal(await s.count('chat_turns'), 0);
  assert.equal(await s.count('retrieval_traces'), 0);
  assert.equal(await s.count('memory_chunks'), 0, 'chunks hang on the embedding grant (audit F1), so revoking it erases them');
  // 2. Document erasure deletes its chunks (a chunk under the document grant, as before F1).
  await insert(handle.pool, 'memory_chunks', { id: 'c-a1', household_id: a.household, holding_id: s.holding.id, consent_grant_id: a.consent, source_document_id: a.document });
  const documents = await eraseMemoryForDocuments(db, { householdId: a.household, documentIds: [a.document] });
  assert.ok(documents.chunks > 0);
  assert.equal(await s.count('memory_chunks'), 0);
  // 3. Household erasure wipes everything left, a fresh set included.
  const again = await s.thread().catch(() => null);
  assert.equal(again, null, 'the holding is gone with its document');
  await insert(handle.pool, 'policy_holdings', { id: 'h-a2', household_id: a.household, document_id: a.document });
  await insert(handle.pool, 'memory_chunks', { id: 'c-a2', household_id: a.household, holding_id: 'h-a2', consent_grant_id: a.consent, source_document_id: a.document });
  await insert(handle.pool, 'chat_threads', { id: 't-a2', household_id: a.household, created_by_adult_id: a.adult });
  await insert(handle.pool, 'chat_turns', { id: 'u-a2', household_id: a.household, thread_id: 't-a2', role: 'assistant' });
  await insert(handle.pool, 'retrieval_traces', { id: 'r-a2', household_id: a.household, thread_id: 't-a2', turn_id: 'u-a2' });
  const household = await eraseMemoryForHousehold(db, { householdId: a.household });
  assert.ok(household.chunks === 1 && household.threads === 1, JSON.stringify(household));
  for (const store of stores) assert.equal(await s.count(store), 0, store);
  for (const store of stores) assert.equal(await s.count(store, b.household), 1, `${store}: the other household is untouched`);
});

test('voice: the transcript is stored sealed; the audio link only under VOICE_AUDIO_RETAIN exactly true', opts, async t => {
  const off = await scenario(t, { env: { CHAT_MODEL_ENABLED: 'false' } });
  const conversation = await off.thread();
  const spoken = 'what is the room rent limit voicenote-marker';
  const out = answerOf(await off.turn({ threadId: conversation.id, body: { message: spoken, input_kind: 'voice', audio_document_id: off.a.document } }));
  assert.equal(out.audio_retained, false);
  const row = await off.db.one("SELECT * FROM chat_turns WHERE household_id = ? AND input_kind = 'voice'", [off.a.household]);
  assert.match(row.transcript_enc, /^enc2[.]/);
  assert.equal(JSON.stringify(row).includes('voicenote-marker'), false);
  assert.equal(row.audio_document_id, null);
  assert.equal(off.services.columnCrypto.open('chat_turns', 'transcript_enc', row.id, row.transcript_enc), spoken);
});

test('voice audio is retained only when the flag is exactly true and the document is the household\'s', opts, async t => {
  const on = await scenario(t, { env: { CHAT_MODEL_ENABLED: 'false', VOICE_AUDIO_RETAIN: 'true' } });
  const conversation = await on.thread();
  const kept = answerOf(await on.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?', input_kind: 'voice', audio_document_id: on.a.document } }));
  assert.equal(kept.audio_retained, true);
  assert.equal((await on.db.one("SELECT audio_document_id FROM chat_turns WHERE input_kind = 'voice'")).audio_document_id, on.a.document);
  await assert.rejects(on.services.chatV1.startTurn({ principal: { adultId: on.a.adult }, threadId: conversation.id, body: { message: 'hi', input_kind: 'voice', audio_document_id: on.b.document } }), error => error.code === 'DOCUMENT_NOT_FOUND');
});

test('intent rules and fact formatting are deterministic', () => {
  assert.deepEqual(classifyChatMessage('What is the room rent limit?'), { intent: 'coverage_question', factKeys: ['room_rent_limit', 'room_category'] });
  assert.equal(classifyChatMessage('How long is the waiting period for pre-existing diseases?').intent, 'waiting_period');
  assert.equal(classifyChatMessage('We are planning a cataract surgery next month').intent, 'procedure_planning');
  assert.equal(classifyChatMessage('anything', { hasProcedure: true }).intent, 'procedure_planning');
  assert.equal(classifyChatMessage('   ').intent, 'unknown');
  assert.equal(classifyChatMessage('hello there').intent, 'general');
  assert.equal(formatFactValue('money', { amountMinor: 500_000 }), 'INR 5,000');
  assert.equal(formatFactValue('percent', { bp: 1250 }), '12.5%');
  assert.equal(formatFactValue('duration', { days: 30 }), '30 days');
  assert.equal(formatFactValue('bool', { value: false }), 'no');
  assert.equal(formatFactValue('money', { amountMinor: -1 }), null);
  assert.equal(formatFactValue('money', null), null);
});

test('voyage client: request shape, response checks, coded errors, no key means no client', async () => {
  const seen = [];
  const ok = texts => ({ ok: true, status: 200, json: async () => ({ object: 'list', data: texts.map((_, index) => ({ object: 'embedding', index, embedding: vectorOf(String(index)) })).reverse(), model: 'voyage-3.5', usage: { total_tokens: 7 } }) });
  const client = createVoyageEmbedClient({ apiKey: 'k-not-real', fetchImpl: async (url, init) => { seen.push({ url, init }); return ok(JSON.parse(init.body).input); } });
  const result = await client.embed({ texts: ['one', 'two'], inputType: 'query' });
  assert.equal(seen[0].url, 'https://api.voyageai.com/v1/embeddings');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k-not-real');
  assert.deepEqual(JSON.parse(seen[0].init.body), { input: ['one', 'two'], model: 'voyage-3.5', input_type: 'query', output_dimension: 1024, truncation: false });
  assert.equal(result.vectors.length, 2);
  assert.equal(result.vectors[0].length, 1024);
  assert.deepEqual(result.vectors[0], vectorOf('0'), 'vectors come back in input order');
  assert.equal(result.totalTokens, 7);
  const failing = status => createVoyageEmbedClient({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status, json: async () => ({ detail: 'secret-body' }) }) });
  await assert.rejects(failing(429).embed({ texts: ['a'] }), error => error.code === 'provider_http_429' && !/secret-body/.test(error.message));
  await assert.rejects(createVoyageEmbedClient({ apiKey: 'k', fetchImpl: async () => { throw new Error('boom key=k'); } }).embed({ texts: ['a'] }), error => error.code === 'provider_unreachable' && !/boom/.test(error.message));
  await assert.rejects(createVoyageEmbedClient({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ index: 0, embedding: [1, 2] }], usage: { total_tokens: 1 } }) }) }).embed({ texts: ['a'] }), { code: 'provider_response_invalid' });
  await assert.rejects(client.embed({ texts: [] }), { code: 'embed_input_invalid' });
  assert.throws(() => createVoyageEmbedClient({}), { code: 'provider_key_missing' });
  // Routing: embed goes to Voyage only when enabled, keyed and priced; otherwise a typed unavailable.
  const route = env => createModelRouter({ env }).resolve('embed');
  assert.equal(route({ ...ENV }).status, 'ready');
  assert.equal(route({ ...ENV }).model, 'voyage-3.5');
  assert.equal(route({ ...ENV, VOYAGE_API_KEY: '' }).reason, 'key_missing');
  assert.equal(route({ ...ENV, VOYAGE_INPUT_USD_PER_MILLION: '' }).reason, 'rates_missing');
  assert.equal(route({ ...ENV, MODEL_PROVIDERS: 'anthropic' }).reason, 'provider_not_enabled');
  assert.equal(JSON.stringify(route({ ...ENV, VOYAGE_API_KEY: '' })).includes('test-voyage'), false);
  // The runner serves only a request the gateway built after its sealed-input check.
  const runner = createEmbedRunner({ client, provider: 'voyage', model: 'voyage-3.5', inputUsdPerMillion: 0.06 });
  await assert.rejects(runner({ task: 'embed', input: { payload: { texts: [{ text: { text: 'forged' } }] } } }), { code: 'ungated_model_input' });
});

async function startApp(database, env) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-test-bootstrap-token-0018', ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* an event stream */ }
    return { status: response.status, type: response.headers.get('content-type'), data };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

test('routes: threads and an SSE turn; a foreign household is the same 404; off unless MEMORY_ENABLED is true', opts, async t => {
  const fresh = await freshDatabase(t);
  const owners = {};
  const off = await startApp(fresh.db, {});
  t.after(() => off.stop());
  for (const name of ['one', 'two']) {
    const r = await off.call('/api/v1/households', { method: 'POST', token: 'coversaath-test-bootstrap-token-0018', body: { displayName: `${name} household`, owner: { displayName: `${name} owner`, contactEmail: `${name}.synthetic@example.test` } } });
    assert.equal(r.status, 201);
    owners[name] = { token: r.data.session.token, householdId: r.data.household.id };
  }
  const disabled = await off.call('/api/v1/chat/threads', { method: 'POST', token: owners.one.token, body: { household_id: owners.one.householdId } });
  assert.deepEqual([disabled.status, disabled.data.error.code], [503, 'MEMORY_DISABLED']);
  const on = await startApp(fresh.db, { MEMORY_ENABLED: 'true' });
  t.after(() => on.stop());
  const created = await on.call('/api/v1/chat/threads', { method: 'POST', token: owners.one.token, body: { household_id: owners.one.householdId } });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.data.thread).sort(), ['created_at', 'holding_id', 'household_id', 'id']);
  const turnPath = `/api/v1/chat/threads/${created.data.thread.id}/turns`;
  const streamed = await on.call(turnPath, { method: 'POST', token: owners.one.token, body: { message: 'What is the room rent limit?' } });
  assert.equal(streamed.status, 200);
  assert.match(streamed.type, /^text\/event-stream/);
  const names = [...streamed.data.matchAll(/^event: (\w+)$/gm)].map(match => match[1]);
  assert.deepEqual([names[0], names.at(-2), names.at(-1)], ['meta', 'answer', 'done']);
  assert.match(streamed.data, /"status":"unknown"/, 'no confirmed fact: unknown, decided by code');
  const foreign = await on.call(turnPath, { method: 'POST', token: owners.two.token, body: { message: 'hello' } });
  assert.deepEqual([foreign.status, foreign.data.error.code], [404, 'CHAT_THREAD_NOT_FOUND']);
  assert.equal((await on.call('/api/v1/chat/threads', { method: 'POST', token: owners.two.token, body: { household_id: owners.one.householdId } })).status, 404);
  const bad = await on.call(turnPath, { method: 'POST', token: owners.one.token, body: { message: 'hi', surprise: true } });
  assert.deepEqual([bad.status, bad.data.error.code], [400, 'CHAT_REQUEST_INVALID']);
  assert.equal((await on.call(turnPath, { method: 'POST', body: { message: 'hi' } })).status, 401);
});

// ---- Provider consent (audit F1, invariant 2): no chat or embed call without a current, exact grant. FOR LEGAL REVIEW (wording). ----
const revoke = (pool, id) => pool.query('UPDATE consent_grants SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), id]);
const providerCalls = async s => (await s.providerCalls.listForHousehold(s.a.household)).length;
const assistantTurns = s => s.db.many("SELECT * FROM chat_turns WHERE household_id = ? AND role = 'assistant'", [s.a.household]);

test('provider consent: no grant means no embed call and no chat model call (deterministic answer, coded status)', opts, async t => {
  const s = await scenario(t, { recipients: [] });
  const memorised = await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id });
  assert.deepEqual([memorised.embedded, memorised.skipped], [0, 'consent_required']);
  assert.equal(s.embedded.length, 0, 'nothing went to the embedding provider');
  assert.equal(await s.count('memory_chunks'), 0);
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'deterministic');
  assert.equal(answer.model_status, 'consent_required');
  assert.equal(answer.facts_used[0].fact_key, 'room_rent_limit', 'the confirmed fact still answers');
  assert.equal(s.sent.length, 0, 'nothing went to the chat model');
  assert.equal(await providerCalls(s), 0, 'no provider_calls row: nothing was dispatched');
  assert.equal((await assistantTurns(s))[0].consent_grant_id, null);
  // A turn that would have retrieved passages by vector also sends nothing.
  await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about ambulance?' } });
  assert.equal(s.embedded.length, 0);
});

test('provider consent: purpose, recipient, subject, revocation and expiry must all match exactly', opts, async t => {
  // Wrong recipient: a voyage-only grant opens embeddings but not the chat model; an anthropic-only grant the reverse.
  const embedOnly = await scenario(t, { recipients: ['voyage'] });
  assert.ok((await embedOnly.services.memory.embedHolding({ householdId: embedOnly.a.household, holdingId: embedOnly.holding.id })).embedded > 0);
  const c1 = await embedOnly.thread();
  assert.equal(answerOf(await embedOnly.turn({ threadId: c1.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'deterministic');
  assert.equal(embedOnly.sent.length, 0);

  const chatOnly = await scenario(t, { recipients: ['anthropic'] });
  assert.equal((await chatOnly.services.memory.embedHolding({ householdId: chatOnly.a.household, holdingId: chatOnly.holding.id })).skipped, 'consent_required');
  assert.equal(chatOnly.embedded.length, 0);
  const c2 = await chatOnly.thread();
  assert.equal(answerOf(await chatOnly.turn({ threadId: c2.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'model');
  assert.equal(chatOnly.sent.length, 1);

  // Wrong purpose: the right scopes on a profile_intake grant do not open a provider.
  const wrongPurpose = await scenario(t, { recipients: [] });
  await grantProviders(wrongPurpose.handle.pool, wrongPurpose.a.profileGrant);
  const c3 = await wrongPurpose.thread();
  assert.equal(answerOf(await wrongPurpose.turn({ threadId: c3.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'deterministic');
  assert.equal((await wrongPurpose.services.memory.embedHolding({ householdId: wrongPurpose.a.household, holdingId: wrongPurpose.holding.id })).skipped, 'consent_required');
  assert.equal(wrongPurpose.sent.length + wrongPurpose.embedded.length, 0);

  // A NULL-recipient scope never authorises a named recipient.
  const nullRecipient = await scenario(t, { recipients: [] });
  await insert(nullRecipient.handle.pool, 'consent_scopes', { id: 'scope-null', consent_grant_id: nullRecipient.a.coverageGrant, ...SCOPE(null) });
  const c4 = await nullRecipient.thread();
  assert.equal(answerOf(await nullRecipient.turn({ threadId: c4.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'deterministic');

  // Foreign grant, revoked and expired grants do not open it. Revoked and expired grants do not open it either.
  for (const [name, change] of [
    // A foreign household's grant, scopes and all, opens nothing here.
    ['foreign household', async s => { await revoke(s.handle.pool, s.a.coverageGrant); await grantProviders(s.handle.pool, s.b.coverageGrant); }],
    ['revoked', (s) => revoke(s.handle.pool, s.a.coverageGrant)],
    ['expired', (s) => s.handle.pool.query('UPDATE consent_grants SET expires_at = $1 WHERE id = $2', ['2020-01-01T00:00:00.000Z', s.a.coverageGrant])],
  ]) {
    const s = await scenario(t);
    await change(s);
    const conversation = await s.thread();
    assert.equal(answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'deterministic', name);
    assert.equal((await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id })).skipped, 'consent_required', name);
    assert.equal(s.sent.length + s.embedded.length, 0, name);
  }
});

test('provider consent: happy path stores the grant on the model turn and on the chunks', opts, async t => {
  const s = await scenario(t);
  assert.ok((await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id })).embedded > 0);
  const chunkGrants = await s.db.many('SELECT DISTINCT consent_grant_id FROM memory_chunks WHERE household_id = ?', [s.a.household]);
  assert.deepEqual(chunkGrants.map(row => row.consent_grant_id), [s.a.coverageGrant]);
  const conversation = await s.thread();
  assert.equal(answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'model');
  assert.equal(s.sent.length, 1);
  assert.deepEqual((await assistantTurns(s)).map(row => row.consent_grant_id), [s.a.coverageGrant]);
});

test('provider consent: a grant revoked after resolve and before commit writes nothing', opts, async t => {
  // Chat: revoked while the model call is in flight. The turn fails with a coded error; no turn, trace or thread update is written.
  const chat = await scenario(t, { onGenerate: (handle, a) => revoke(handle.pool, a.coverageGrant) });
  const conversation = await chat.thread();
  const out = await chat.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } });
  assert.deepEqual(out.map(([event]) => event).filter(event => event !== 'meta'), ['error']);
  assert.equal(out.find(([event]) => event === 'error')[1].code, 'CONSENT_REQUIRED');
  assert.equal(await chat.count('chat_turns'), 0);
  assert.equal(await chat.count('retrieval_traces'), 0);
  // The repository itself refuses without a current grant for a model answer, and a deterministic turn needs none.
  const base = { householdId: chat.a.household, threadId: conversation.id, user: { text: 'q', inputKind: 'text' }, trace: { mode: 'facts_only' } };
  const model = { text: 'a', intent: 'unknown', answerSource: 'model' };
  const refuse = error => { assert.equal(error.code, 'CONSENT_REQUIRED'); assert.equal(error.statusCode, 403); return true; };
  await assert.rejects(chat.services.chatRepository.appendExchange({ ...base, assistant: model }), refuse);
  await assert.rejects(chat.services.chatRepository.appendExchange({ ...base, assistant: model, consent: { grantId: chat.a.coverageGrant, adultId: chat.a.adult } }), refuse);
  await assert.rejects(chat.services.chatRepository.appendExchange({ ...base, assistant: model, consent: { grantId: chat.a.coverageGrant, adultId: chat.b.adult } }), refuse); // subject mismatch
  assert.equal(await chat.count('chat_turns'), 0);
  await chat.services.chatRepository.appendExchange({ ...base, assistant: { ...model, answerSource: 'deterministic' } });
  assert.equal(await chat.count('chat_turns'), 2);

  // Embed: revoked while the embedding call is in flight. Nothing is written.
  const embed = await scenario(t, { onEmbed: (handle, a) => revoke(handle.pool, a.coverageGrant) });
  const result = await embed.services.memory.embedHolding({ householdId: embed.a.household, holdingId: embed.holding.id });
  assert.equal(result.embedded, 0);
  assert.equal(await embed.count('memory_chunks'), 0);
  // The chunk repository re-checks purpose and recipient itself: a document grant is not an embedding grant.
  const wrong = await scenario(t);
  const written = { householdId: wrong.a.household, holdingId: wrong.holding.id, consentGrantId: wrong.a.consent, scopes: ['confirmed_fact'], desired: [], chunks: [], embeddingModel: 'none' };
  await assert.rejects(wrong.services.memoryChunks.replace({ ...written, embedGrantId: wrong.a.consent }), refuse);
  await assert.rejects(wrong.services.memoryChunks.replace({ ...written, embedGrantId: wrong.a.profileGrant }), refuse);
  await wrong.services.memoryChunks.replace({ ...written, embedGrantId: wrong.a.coverageGrant });
});

test('provider consent: revoking the chat grant erases the chat it made possible (and only that)', opts, async t => {
  const s = await scenario(t, { recipients: ['voyage'] });
  // A separate chat grant for the anthropic recipient: the facts hang on the other grant, so only chat_turns.consent_grant_id can reach the thread.
  await insert(s.handle.pool, 'consent_grants', { id: 'cg-chat', household_id: s.a.household, subject_adult_id: s.a.adult, purpose: 'coverage_reconstruction' });
  await grantProviders(s.handle.pool, 'cg-chat', ['anthropic']);
  const modelled = await s.thread();
  assert.equal(answerOf(await s.turn({ threadId: modelled.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'model');
  assert.deepEqual((await assistantTurns(s)).map(row => row.consent_grant_id), ['cg-chat']);
  const erased = await eraseMemoryForConsentGrant(s.db, { householdId: s.a.household, consentGrantId: 'cg-chat' });
  assert.equal(erased.threads, 1);
  for (const table of ['chat_threads', 'chat_turns', 'retrieval_traces']) assert.equal(await s.count(table), 0, table);
  // Through the consent service: revoke erases the same way, and a later turn falls back to the deterministic answer.
  await insert(s.handle.pool, 'consent_grants', { id: 'cg-chat2', household_id: s.a.household, subject_adult_id: s.a.adult, purpose: 'coverage_reconstruction' });
  await grantProviders(s.handle.pool, 'cg-chat2', ['anthropic']);
  const next = await s.thread();
  assert.equal(answerOf(await s.turn({ threadId: next.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'model');
  await s.services.consents.revoke({ grantId: 'cg-chat2', revokedByAdultId: s.a.adult });
  assert.equal(await s.count('chat_turns'), 0);
  await revoke(s.handle.pool, 'cg-chat'); // the first grant was only erased from, not revoked
  const after = await s.thread();
  assert.equal(answerOf(await s.turn({ threadId: after.id, body: { message: 'what is the room rent limit?' } })).answer_source, 'deterministic');
});

// ---- Audit F5: numbers in a model answer must come from cited facts or computed checks. ----
test('numbers check: an answer whose numbers match the cited fact keeps the model wording', opts, async t => {
  const s = await scenario(t, { answer: 'Your room rent limit is INR 5,000 per day.' });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.equal(answer.model_status, undefined);
  assert.equal(answer.status, 'evidence_found');
});

test('numbers check: a number the cited fact does not hold falls back to the deterministic answer (numbers_unverified)', opts, async t => {
  const s = await scenario(t, { answer: 'Your room rent limit is INR 9,000 per day.' });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'deterministic');
  assert.equal(answer.model_status, 'numbers_unverified');
  assert.doesNotMatch(answer.answer, /9,000/);
  assert.match(answer.facts_used[0].value_text, /5,000/);
  assert.equal((await assistantTurns(s))[0].consent_grant_id, null, 'no model wording was stored');
});

// ---- Audit F7: holding facts are owner-only in chat, like GET /holdings/{id}/facts. ----
test('non-owner member chats without holding facts, conflicts or passages; the owner still gets them', opts, async t => {
  const s = await scenario(t);
  await insert(s.handle.pool, 'adult_users', { id: 'adult-a2' });
  await insert(s.handle.pool, 'household_roles', { id: 'role-a2', household_id: s.a.household, adult_user_id: 'adult-a2', role: 'member' });
  await insert(s.handle.pool, 'household_members', { id: 'member-a2', household_id: s.a.household, adult_user_id: 'adult-a2' });
  const conversation = await s.thread();
  const asMember = await s.turn({ adultId: 'adult-a2', threadId: conversation.id, body: { message: 'what is the room rent limit?' } });
  const meta = asMember.find(([event]) => event === 'meta')[1];
  const memberAnswer = answerOf(asMember);
  assert.equal(meta.facts_available, 0);
  assert.deepEqual(memberAnswer.facts_used, []);
  assert.equal(memberAnswer.answer_source, 'deterministic');
  assert.equal(s.sent.length, 0, 'no fact value went to the model for a non-owner');
  assert.doesNotMatch(JSON.stringify(memberAnswer), /reviewed_reference|room_rent_limit/, 'no holding fact or key is shown');
  const asOwner = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(asOwner.facts_used[0].fact_key, 'room_rent_limit');
});

// ---- Owner scope: chat answers from the policy wording too, names document and page, and never invents. Synthetic wording only. ----
test('wording, keyword path: a clause answer names the wording document and page', opts, async t => {
  const s = await scenario(t, { env: { ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '' } });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about the ambulance?' } }));
  assert.equal(answer.status, 'evidence_found');
  assert.deepEqual(answer.sources.map(item => [item.kind, item.document_id, item.page]), [['wording', s.a.document, 2]]);
});

test('wording, no support: a question the wording and facts do not answer is unknown with no sources', opts, async t => {
  const s = await scenario(t, { env: { ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '' } });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'is dental treatment covered?' } }));
  assert.equal(answer.status, 'unknown');
  assert.deepEqual(answer.sources, []);
  assert.deepEqual(answer.facts_used, []);
  assert.doesNotMatch(answer.answer, /INR \d/);
});

test('wording, vector path: a model answer whose numbers sit in the cited passage is kept and cites document and page', opts, async t => {
  const s = await scenario(t, { facts: false, answer: 'Ambulance charges are paid up to INR 2,000 per trip.' });
  await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about the ambulance?' } }));
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.equal(answer.status, 'evidence_found');
  assert.deepEqual(answer.sources.map(item => [item.document_id, item.page]), [[s.a.document, 2]]);
});

test('wording, vector path: a number absent from the cited passage falls back (numbers_unverified), nothing invented', opts, async t => {
  const s = await scenario(t, { facts: false, answer: 'Ambulance charges are paid up to INR 7,000 per trip.' });
  await s.services.memory.embedHolding({ householdId: s.a.household, holdingId: s.holding.id });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about the ambulance?' } }));
  assert.equal(answer.answer_source, 'deterministic');
  assert.equal(answer.model_status, 'numbers_unverified');
  assert.doesNotMatch(answer.answer, /7,000/);
  assert.equal(answer.status, 'unknown');
  assert.deepEqual(answer.sources, []);
});

// ---- No-key funnel and provider failover (owner goal). Synthetic wording only; local stubs, no live call. ----
const chatRows = s => s.providerCalls.listForHousehold(s.a.household);
async function addWordingDocument(s, text, page) {
  const id = 'document-tc';
  await insert(s.handle.pool, 'document_uploads', { id, household_id: s.a.household, case_id: s.a.case, uploaded_by_adult_id: s.a.adult, consent_grant_id: s.a.consent });
  const clauseId = 'clause-tc-1';
  await insert(s.handle.pool, 'policy_clauses', { id: clauseId, household_id: s.a.household, case_id: s.a.case, document_id: id, page, text: s.services.columnCrypto.seal('policy_clauses', 'text', clauseId, text), digest: createHash('sha256').update(text).digest('hex') });
  return id;
}

test('no keys: schedule fact, T&C clause with document and page, and unknown, all deterministic with no provider call', opts, async t => {
  const s = await scenario(t, { clauses: false, env: { ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '', GEMINI_API_KEY: '' } });
  const tc = await addWordingDocument(s, 'Cataract surgery is admissible only after a waiting period of 24 months from the policy start date.', 7);
  const conversation = await s.thread();
  const fact = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(fact.answer_source, 'deterministic');
  assert.equal(fact.status, 'evidence_found');
  assert.equal(fact.facts_used[0].fact_key, 'room_rent_limit');
  assert.match(fact.answer, /5,000/);
  const clause = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about cataract surgery?' } }));
  assert.equal(clause.answer_source, 'deterministic');
  assert.equal(clause.status, 'evidence_found');
  assert.match(clause.answer, /From your policy document \(page 7\): Cataract surgery is admissible only after a waiting period of 24 months/);
  assert.deepEqual(clause.sources.map(item => [item.kind, item.document_id, item.page]), [['wording', tc, 7]]);
  const unknown = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'is dental treatment covered?' } }));
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual([unknown.sources, unknown.facts_used], [[], []]);
  assert.doesNotMatch(unknown.answer, /INR \d/);
  assert.equal(s.sent.length, 0);
  assert.equal(s.embedded.length, 0);
  assert.ok((await chatRows(s)).every(row => row.status !== 'ok'), 'only typed-unavailable rows; nothing dispatched');
});

test('no keys: another household\'s wording is never searched', opts, async t => {
  const s = await scenario(t, { clauses: false, env: { ANTHROPIC_API_KEY: '', VOYAGE_API_KEY: '' } });
  const text = 'Cataract surgery is admissible only after 24 months.';
  await insert(s.handle.pool, 'policy_clauses', { id: 'clause-b-1', household_id: s.b.household, case_id: s.b.case, document_id: s.b.document, page: 1, text: s.services.columnCrypto.seal('policy_clauses', 'text', 'clause-b-1', text), digest: createHash('sha256').update(text).digest('hex') });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what does the policy say about cataract surgery?' } }));
  assert.equal(answer.status, 'unknown');
  assert.deepEqual(answer.sources, []);
});

const FAILOVER_ENV = {
  MODEL_PROVIDERS: 'gemini,anthropic,voyage', GEMINI_API_KEY: 'test-gemini-key-not-real', GEMINI_INPUT_USD_PER_MILLION: '1', GEMINI_OUTPUT_USD_PER_MILLION: '4',
};
// An agent that fails for the listed providers and answers (like the default stub) for the rest.
const failingFor = (...providers) => sent => settings => settings.model.provider && providers.includes(settings.model.provider)
  ? { async generate() { sent.push(`attempt:${settings.model.provider}`); throw new Error('provider exploded'); } }
  : answerStub(sent)(settings);

test('failover: Gemini answers first when its own grant exists; the grant stored is the answering provider\'s', opts, async t => {
  const s = await scenario(t, { env: FAILOVER_ENV, recipients: ['gemini', 'anthropic', 'voyage'] });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.deepEqual((await chatRows(s)).map(row => [row.provider, row.status]), [['gemini', 'ok']]);
  assert.equal((await assistantTurns(s))[0].provider, 'gemini');
});

test('failover: a failed provider moves to the next consented one; both attempts are audited', opts, async t => {
  const s = await scenario(t, { env: FAILOVER_ENV, recipients: ['gemini', 'anthropic', 'voyage'], agent: failingFor('gemini') });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.deepEqual((await chatRows(s)).map(row => row.provider).sort(), ['anthropic', 'gemini']);
  assert.equal((await assistantTurns(s))[0].provider, 'anthropic');
});

test('failover: a provider without its own grant is never sent to, even when the earlier one failed', opts, async t => {
  const s = await scenario(t, { env: FAILOVER_ENV, recipients: ['gemini', 'voyage'], agent: failingFor('gemini') });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'deterministic');
  assert.equal(answer.model_status, 'provider_failure');
  assert.ok(!s.sent.some(entry => !entry.startsWith('attempt:gemini')), 'nothing reached anthropic');
  assert.deepEqual((await chatRows(s)).map(row => row.provider), ['gemini']);
  assert.equal(answer.facts_used[0].fact_key, 'room_rent_limit');
});

test('failover: only the consented provider is used when the first has no grant (skipped, not called)', opts, async t => {
  const s = await scenario(t, { env: FAILOVER_ENV, recipients: ['anthropic', 'voyage'] });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.deepEqual((await chatRows(s)).map(row => row.provider), ['anthropic']);
});

test('failover: an unconfigured first provider (no key) falls to the next without a call to it', opts, async t => {
  const s = await scenario(t, { env: { ...FAILOVER_ENV, GEMINI_API_KEY: '' }, recipients: ['gemini', 'anthropic', 'voyage'] });
  const conversation = await s.thread();
  const answer = answerOf(await s.turn({ threadId: conversation.id, body: { message: 'what is the room rent limit?' } }));
  assert.equal(answer.answer_source, 'model', answer.model_status);
  assert.deepEqual((await chatRows(s)).map(row => row.provider), ['anthropic']);
});
