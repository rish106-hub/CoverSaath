import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { INSURER_BLOCK_HEADING, MEMORY_DOCUMENT_SECTIONS, PROSE_NOTICE } from '../src/backend/services/memory-document.js';
import { packCacheKey, signatureFor } from '../src/backend/services/reference-data-port.js';
import { ProviderCallRepository } from '../src/backend/repositories/index.js';
import { createModelRouter } from '../src/integrations/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../src/features/ai-analysis/chat-runtime.js';
import { parseRenderedReference } from '../src/features/ai-analysis/prompt-pack.js';
import { INSURER_UNCHECKED_LABEL } from '../src/features/insurance-rules/fact-source-label.js';
import { checkProseLine } from '../src/features/chat-answer-guard/index.js';
import { parsePack } from '../src/integrations/insurance-data/schemas.js';
import { mapFssFacts } from '../src/features/policy-facts/fss-fact-map.js';

// ADR 0039 (plan C5): insurer-tier lines, the "Insurer terms your document doesn't state" block and Open questions in policy.md, the optional prose pass
// behind POLICY_DOC_PROSE_ENABLED and its line guard, and insurer wording in chat v1. Synthetic data only; the model is a local stub, never a live call.
// Needs PostgreSQL (TEST_DATABASE_URL); REQUIRE_POSTGRES=1 makes a missing database an error instead of a skip.

const opts = postgresTestOptions();
const MARK = 'Quillberry-marker';
const VERSION = 'ver_c5_a';
const ROOM_QUOTE = 'Room rent is limited to INR 5,000 per day for a single private room.';
const LONG_QUOTE = `Pre-existing diseases are covered only after a continuous waiting period of 30 days has run from the start of cover, ${'and the period restarts for each fresh enhancement of the sum insured, '}so check the schedule.`;
const ENV = {
  HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'true', CHAT_MODEL_ENABLED: 'true', MODEL_PROVIDERS: 'anthropic', POLICY_DOC_PROSE_ENABLED: 'true',
  ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_INPUT_USD_PER_MILLION: '3', ANTHROPIC_OUTPUT_USD_PER_MILLION: '15',
  ANTHROPIC_CLASSIFY_INPUT_USD_PER_MILLION: '1', ANTHROPIC_CLASSIFY_OUTPUT_USD_PER_MILLION: '5',
};

// The prose stub: rewrites "What is the X? VALUE" as "The X is VALUE." (same words), or whatever `mode` says. Records every prompt it received.
const REWORD = text => text.replace(/^(?:What|How long) (?:is|are) (?:the )?(.*?)\? (.*)$/, 'The $1 is $2.');
const proseAgent = (sent, mode, hook = null) => settings => ({
  async generate({ prompt }) {
    sent.push(`${settings.instructions}\n${prompt}`);
    if (hook) await hook();
    const lines = parseRenderedReference(prompt).payload.lines ?? [];
    return { output: { status: 'extracted_unverified', lines: lines.map(line => ({ line_id: line.line_id, text: mode(line.text) })) }, totalUsage: { inputTokens: 100, outputTokens: 20 } };
  },
});

async function world(t, { env: override = {}, mode = REWORD, hook = null, consent = true } = {}) {
  const fresh = await freshDatabase(t);
  const { db, handle } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const w of [a, b]) w.coverageGrant = `cr-${w.household.split('-')[1]}`;
  await insert(handle.pool, 'consent_grants', { id: a.coverageGrant, household_id: a.household, subject_adult_id: a.adult, purpose: 'coverage_reconstruction' });
  await insert(handle.pool, 'consent_grants', { id: b.coverageGrant, household_id: b.household, subject_adult_id: b.adult, purpose: 'coverage_reconstruction' });
  if (consent) await insert(handle.pool, 'consent_scopes', { id: 'scope-a-anthropic', consent_grant_id: a.coverageGrant, resource_type: 'household', action: 'derive', data_category: 'insurance_question', recipient: 'anthropic' });
  const env = { ...ENV, ...override };
  const sent = [];
  const gateway = createChatModelGateway({
    env, router: createModelRouter({ env }), providerCalls: new ProviderCallRepository(db), budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
    loadModel: async ({ provider }) => ({ stub: true, provider }), createAgent: proseAgent(sent, mode, hook ? () => hook({ handle, a }) : null),
  });
  const services = createBackendServices(db, { env, modelGateway: gateway });
  const holdings = {};
  for (const w of [a, b]) {
    holdings[w.household] = await services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy });
    await handle.pool.query("UPDATE policy_holdings SET status = 'ready' WHERE id = $1", [holdings[w.household].id]);
  }
  a.holding = holdings[a.household];
  b.holding = holdings[b.household];
  const base = w => ({ householdId: w.household, holdingId: w.holding.id, policyId: w.policy, consentGrantId: w.coverageGrant, provenance: { sourceDocumentId: w.document, sourcePageId: w.page } });
  const own = (factKey, value, extra = {}) => services.memoryFacts.insertFact({ ...base(a), factKey, tier: 'own_pdf', status: 'extracted_unverified', value: { value, alternatives: [] }, ...extra });
  const insurer = (factKey, value, quote, quotePage, { status = 'extracted_unverified', extra = {} } = {}) => services.memoryFacts.insertFact({
    ...base(a), factKey, tier: 'ida_wording', status, value: { value, alternatives: [] }, provenance: { sourceDocumentId: a.document },
    referenceRef: { source: 'fss', refId: `ref-${factKey}`, cacheKey: 'cache-1', version: '1', quote, quotePage, evidence: quotePage ? [{ pageNumber: quotePage }] : [], verificationStatus: status === 'reviewed_reference' ? 'verified' : 'extracted_unverified' }, ...extra,
  });
  const render = (w = a) => services.memoryDocument.render({ householdId: w.household, holdingId: w.holding.id, adultId: w.adult });
  const prose = (w = a, extra = {}) => services.memoryDocument.renderWithProse({ householdId: w.household, holdingId: w.holding.id, adultId: w.adult, ...extra });
  return { ...fresh, a, b, services, sent, own, insurer, render, prose, env };
}

const sectionOf = (text, heading) => text.split(`## ${heading}\n`)[1].split('\n## ')[0];
const bullets = text => text.split('\n').filter(line => line.startsWith('- '));

async function seedTiers(s) {
  await s.own('sum_insured', { amountMinor: 50_000_000 });
  await s.own('waiting_ped', { days: 1095 });
  // Insurer only: room rent (quote and page), initial waiting period (long quote), copay (no quote: an open question).
  await s.insurer('room_rent_limit', { amountMinor: 500_000, currency: 'INR' }, ROOM_QUOTE, 7);
  await s.insurer('waiting_initial', { days: 30 }, LONG_QUOTE, 9);
  await s.insurer('copay_percent', { bp: 1000 }, null, null);
  // The own PDF has the slot: the insurer value is not shown (own wins), and it is not in the block.
  await s.insurer('waiting_ped', { days: 730 }, 'Pre-existing diseases are covered after 24 months of continuous cover.', 3);
}

test('policy.md: insurer-only terms go to their own block with label, page and a quote of at most 160 characters; copay without a quote is an open question', opts, async t => {
  const s = await world(t);
  await seedTiers(s);
  const text = await s.render();
  const headings = [...text.matchAll(/^## (.+)$/gm)].map(match => match[1]);
  assert.deepEqual(headings, [...MEMORY_DOCUMENT_SECTIONS]);
  assert.ok(headings.includes(INSURER_BLOCK_HEADING));
  const block = sectionOf(text, INSURER_BLOCK_HEADING);
  assert.match(block, /- What is the room rent limit per day\? INR 5,000 \(From the insurer's wording, not checked\) Check with the insurer\. Quote: "Room rent is limited to INR 5,000 per day for a single private room\." \[insurer_wording, p\.7\]/);
  const initial = bullets(block).find(line => line.includes('initial waiting'));
  assert.ok(initial, block);
  assert.match(initial, /30 days \(From the insurer's wording, not checked\)/);
  assert.match(initial, /\[insurer_wording, p\.9\]$/);
  const quote = initial.match(/Quote: "([^"]*)"/)[1];
  assert.ok(quote.length <= 160, `${quote.length}`);
  assert.ok(quote.endsWith('…') && LONG_QUOTE.startsWith(quote.slice(0, -1)));
  // Not listed twice, and not in the topic section it would have been in.
  assert.equal(sectionOf(text, 'Cover and limits').includes('room rent'), false);
  assert.equal(sectionOf(text, 'Waiting periods').includes('initial waiting'), false);
  // Own wins: the own value stays in its topic section, the insurer's different value for the slot is nowhere.
  assert.match(sectionOf(text, 'Waiting periods'), /pre-existing diseases\? 1095 days \(read from your document, not verified\)/);
  assert.equal(text.includes('730'), false);
  assert.equal(block.includes('pre-existing'), false);
  // Open questions: the copay has an insurer value without a quote, so it is not shown and is an open question.
  assert.equal(text.includes('10%'), false);
  assert.match(sectionOf(text, 'Open questions'), /- .*co-?payment.*\[unknown\]/i);
  for (const line of bullets(text)) assert.match(line, /\[[^\]]+\]$/, line);
});

test('policy.md: the block is a fixed section; a holding with no insurer rows says none recorded and every own-PDF line is unchanged', opts, async t => {
  const s = await world(t);
  await s.own('sum_insured', { amountMinor: 50_000_000 });
  await s.own('waiting_ped', { days: 1095 });
  const text = await s.render();
  assert.equal(sectionOf(text, INSURER_BLOCK_HEADING).trim(), '- None recorded. [unknown]');
  assert.match(sectionOf(text, 'Cover and limits'), /- What is the sum insured\? INR 5,00,000 \(read from your document, not verified\) \[[a-z_]+, p\.[0-9]+\]/);
  assert.match(sectionOf(text, 'Waiting periods'), /- How long is the waiting period for pre-existing diseases\? 1095 days \(read from your document, not verified\)/);
  assert.equal(text.includes('insurer wording'), false);
});

test('policy.md: a reviewed insurer value that agrees with the own reading stays in its topic section as (insurer wording); a stated own value beats an unchecked insurer one', opts, async t => {
  const s = await world(t);
  await s.own('waiting_initial', { days: 30 });
  await s.insurer('waiting_initial', { days: 30 }, 'Waiting period of 30 days applies to any illness.', 4, { status: 'reviewed_reference' });
  await s.own('copay_percent', { bp: 1000 });
  await s.insurer('copay_percent', { bp: 2000 }, 'Co-payment of 20% applies to every claim made.', 5);
  const text = await s.render();
  assert.match(sectionOf(text, 'Waiting periods'), /initial waiting period\? 30 days \(insurer wording\)/);
  assert.equal(sectionOf(text, INSURER_BLOCK_HEADING).includes('initial'), false);
  const copay = bullets(text).find(line => /co-?payment/i.test(line) && !line.includes('[unknown]'));
  assert.ok(copay, text);
  assert.match(copay, /10%/);
  assert.equal(text.includes('20%'), false);
});

test('pack path: a fact with shown false is dropped by the parse, and a stated_nil value maps to no fact key (so policy.md can never show either)', () => {
  const page = 'Initial waiting period is 30 days. Room rent is nil under this plan.';
  const sha = 'a'.repeat(64);
  const evidence = quote => [{ document_id: 'd1', page_number: 1, quote, page_sha256: sha }];
  const fact = (id, type, value, over = {}) => ({ fact_id: id, fact_type: type, value, status: 'extracted_unverified', shown: true, evidence: evidence('Initial waiting period is 30 days'), ...over });
  const pack = parsePack({
    pack_version: 'f'.repeat(64), product: { product_id: 'p', product_name: 'X', insurer_id: 'i', insurer_name: 'I', line_of_business: 'health' },
    version: { version_id: VERSION, wording_version: '1' }, documents: [{ document_id: 'd1', sha256: 'd'.repeat(64), pages: [{ page_number: 1, text: page, page_sha256: sha }] }],
    facts: [
      fact('a', 'waiting_initial', { kind: 'duration', duration: { value: 30, unit: 'days' }, text: '30 days' }),
      fact('b', 'waiting_ped', { kind: 'duration', duration: { value: 30, unit: 'days' }, text: '30 days' }, { shown: false }),
      fact('c', 'room_rent_limit', { kind: 'stated_nil', text: 'stated as none' }, { evidence: evidence('Room rent is nil') }),
    ], limitations: [],
  });
  assert.deepEqual(pack.facts.map(item => item.factId), ['a', 'c'], 'shown false is dropped');
  assert.deepEqual(mapFssFacts(pack.facts).map(item => item.factKey), ['waiting_initial'], 'stated_nil is never mapped');
});

test('prose pass: flag off (or not exactly true) serves the deterministic render and never calls a model', opts, async t => {
  for (const flag of [undefined, 'TRUE', 'false']) {
    const s = await world(t, { env: { POLICY_DOC_PROSE_ENABLED: flag } });
    await seedTiers(s);
    const out = await s.prose();
    assert.equal(out.source, 'deterministic');
    assert.equal(out.text, await s.render());
    assert.deepEqual(s.sent, []);
  }
});

test('prose pass: fact sentences are reworded, label, quote and citation stay as code wrote them, nothing else is sent, and nothing is stored', opts, async t => {
  const s = await world(t);
  await seedTiers(s);
  await insert(s.handle.pool, 'consent_grants', { id: 'pi-a', household_id: s.a.household, subject_adult_id: s.a.adult, purpose: 'profile_intake' });
  await s.services.declarations.create({ householdId: s.a.household, adultId: s.a.adult, memberId: s.a.member, kind: 'pre_existing_disease', label: `${MARK} hypertension`, declaredOn: '2024-05-01', declaredToInsurer: true, holdingId: s.a.holding.id, consentGrantId: 'pi-a' });
  await s.handle.pool.query('UPDATE policies SET policy_number_masked = $1 WHERE id = $2', [s.services.columnCrypto.seal('policies', 'policy_number_masked', s.a.policy, 'SYNTH-0000-5678-9012'), s.a.policy]);
  const plain = await s.render();
  const out = await s.prose();
  assert.equal(out.source, 'prose', out.reason);
  assert.ok(out.text.includes(PROSE_NOTICE));
  assert.match(out.text, /- The room rent limit per day is INR 5,000\. \(From the insurer's wording, not checked\) Check with the insurer\. Quote: "Room rent is limited to INR 5,000 per day for a single private room\." \[insurer_wording, p\.7\]/);
  // Every tail (label, quote, citation) of the plain render is intact: the quotes and pages in the served text are the stored ones.
  for (const line of bullets(plain).filter(item => item.includes('Quote: "'))) {
    const tail = line.slice(line.indexOf(' (')); // from the label on
    assert.ok(out.text.includes(tail), tail);
  }
  // Policy, People, Declared conditions, Premiums and Conflicts are the deterministic text.
  for (const heading of ['Policy', 'People covered', 'Declared conditions', 'Premiums and dues', 'Conflicts to resolve', 'Open questions']) assert.equal(sectionOf(out.text, heading), sectionOf(plain, heading), heading);
  // What the model saw: sentences only. No label, quote, citation, name, declaration, UIN or policy number.
  assert.equal(s.sent.length, 1);
  const prompt = s.sent[0];
  assert.ok(prompt.includes('What is the room rent limit per day?'));
  for (const hidden of [MARK, 'Quote:', 'insurer_wording', 'not checked', 'Declared conditions', 'Check with the insurer', '5678', 'SYNTH-0000']) assert.equal(prompt.includes(hidden), false, hidden);
  // Nothing stored: no table holds the reworded sentence or the notice.
  const tables = (await s.db.many("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")).map(row => row.table_name);
  for (const table of tables) {
    const dump = (await s.handle.pool.query(`SELECT row_to_json(x)::text AS j FROM public."${table}" x`)).rows.map(row => row.j).join('\n');
    assert.equal(dump.includes('The room rent limit per day is INR 5,000'), false, table);
    assert.equal(dump.includes('Wording simplified by a model'), false, table);
  }
});

test('prose pass: a line that fails the guard (a changed number, a new fact, advice) serves the deterministic render', opts, async t => {
  const cases = [
    ['changed number', text => REWORD(text).replace('5,000', '6,000')],
    ['new word', text => `${REWORD(text)} This is the best cover available.`],
    ['dropped negation', text => REWORD(text).replace(/ not /g, ' ')],
    ['advice', text => `You should claim. ${REWORD(text)}`],
    ['markup', text => `[x] ${REWORD(text)}`],
  ];
  for (const [name, mode] of cases) {
    const s = await world(t, { mode });
    await seedTiers(s);
    await s.own('clause_exclusion', { text: 'Cosmetic treatment is not covered.' });
    const out = await s.prose();
    assert.equal(out.source, 'deterministic', name);
    assert.match(out.reason, /^guard:/, name);
    assert.equal(out.text, await s.render(), name);
  }
  // The guard itself.
  assert.deepEqual(checkProseLine({ source: 'What is the room rent limit per day? INR 5,000', text: 'The room rent limit per day is INR 5,000.' }), []);
  assert.ok(checkProseLine({ source: 'What is the room rent limit per day? INR 5,000', text: 'The room rent limit per day is INR 5,000 and always paid.' }).includes('no_new_facts'));
  assert.ok(checkProseLine({ source: 'Cosmetic treatment is not covered.', text: 'Cosmetic treatment is covered.' }).includes('no_new_facts'));
  assert.ok(checkProseLine({ source: 'Call the insurer', text: 'Call the insurer on 1800 123 4567' }).includes('contact_trusted'));
});

test('prose pass: a model that drops a line, answers unknown, or times out serves the deterministic render', opts, async t => {
  const dropped = await world(t, { mode: () => '' });
  await seedTiers(dropped);
  assert.equal((await dropped.prose()).source, 'deterministic');
  const slow = await world(t, { env: { POLICY_DOC_PROSE_TIMEOUT_MS: '100' }, hook: () => new Promise(resolve => setTimeout(resolve, 600)) });
  await seedTiers(slow);
  const out = await slow.prose();
  assert.equal(out.source, 'deterministic');
  assert.equal(out.reason, 'PROSE_TIMEOUT');
  assert.equal(out.text, await slow.render());
});

test('prose pass: no current chat grant means no model call and the deterministic render; the document grant being withdrawn is the coded 403, not a fallback', opts, async t => {
  const none = await world(t, { consent: false });
  await seedTiers(none);
  const out = await none.prose();
  assert.equal(out.source, 'deterministic');
  assert.deepEqual(none.sent, []);
  const s = await world(t);
  await seedTiers(s);
  await s.handle.pool.query('UPDATE consent_grants SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), s.a.consent]);
  await assert.rejects(s.prose(), error => error.code === 'CONSENT_REQUIRED');
});

test('prose pass: consent withdrawn while the model call runs serves the deterministic render and stores nothing', opts, async t => {
  const s = await world(t, { hook: async ({ handle, a }) => { await handle.pool.query('UPDATE consent_grants SET revoked_at = $1 WHERE id = $2', [new Date().toISOString(), a.coverageGrant]); } });
  await seedTiers(s);
  const before = (await s.handle.pool.query('SELECT (SELECT count(*) FROM household_memory_facts) AS facts, (SELECT count(*) FROM memory_chunks) AS chunks')).rows[0];
  const out = await s.prose();
  assert.equal(s.sent.length, 1, 'the call was made while consent was current');
  assert.equal(out.source, 'deterministic');
  assert.match(out.reason, /CONSENT_REQUIRED|consent_required/);
  assert.equal(out.text, await s.render());
  assert.equal(out.text.includes('Wording simplified'), false);
  const after = (await s.handle.pool.query('SELECT (SELECT count(*) FROM household_memory_facts) AS facts, (SELECT count(*) FROM memory_chunks) AS chunks')).rows[0];
  assert.deepEqual(after, before);
});

test('policy.md: another household is denied, for the plain render and the prose render alike', opts, async t => {
  const s = await world(t);
  await seedTiers(s);
  await assert.rejects(s.services.memoryDocument.render({ householdId: s.a.household, holdingId: s.a.holding.id, adultId: s.b.adult }), error => error.code === 'HOLDING_NOT_FOUND');
  await assert.rejects(s.services.memoryDocument.renderWithProse({ householdId: s.b.household, holdingId: s.a.holding.id, adultId: s.a.adult }), error => error.code === 'HOLDING_NOT_FOUND');
  await assert.rejects(s.services.memoryDocument.renderWithProse({ holdingId: s.a.holding.id, adultId: s.b.adult }), error => error.code === 'HOLDING_NOT_FOUND');
  assert.deepEqual(s.sent, []);
});

// ---- chat v1: insurer wording ----------------------------------------------------------------------------------------------------------

const PACK_LINES = [
  'Cataract surgery is covered after a waiting period of 24 months from the policy start date.',
  'Policyholder name: Synthetic Person applies to cataract surgery claims.',
  'Ambulance charges are paid up to the limit stated in the schedule for each hospital stay.',
];
const pack = (versionId = VERSION, lines = PACK_LINES) => ({
  packVersion: 'f'.repeat(64), product: { productId: 'prod_c5' }, version: { versionId },
  documents: [{ documentId: `doc_${versionId}`, sha256: 'd'.repeat(64), pages: [{ pageNumber: 7, pageSha256: 'a'.repeat(64) }] }],
  chunks: [{ id: `doc_${versionId}:p7:c0`, documentId: `doc_${versionId}`, pageNumber: 7, text: lines.join('\n') }],
});

async function chatWorld(t, { link = true, lines = PACK_LINES } = {}) {
  const s = await world(t, { consent: false });
  const body = pack(VERSION, lines);
  if (link) await s.services.fssHandoffs.link({ householdId: s.a.household, holdingId: s.a.holding.id, productId: 'prod_c5', versionId: VERSION, matchedBy: 'uin', confidence: 'high' });
  await s.services.referenceCache.put({ key: packCacheKey('pages', VERSION), body, signature: signatureFor(body) });
  const turn = async (w, message, extra = {}) => {
    const thread = (await s.services.chatV1.createThread({ principal: { adultId: w.adult }, body: { household_id: w.household, holding_id: w.holding.id } })).thread;
    const out = [];
    const run = await s.services.chatV1.startTurn({ principal: { adultId: w.adult }, threadId: thread.id, body: { message, ...extra } });
    await run.run((event, data) => out.push([event, data]));
    return out;
  };
  return { ...s, turn, body };
}
const answerOf = out => out.find(([event]) => event === 'answer')?.[1];
const QUESTION = 'What is the waiting period for cataract surgery?';

test('chat v1: when the own documents lack a term, the card cites the insurer wording with tier ida_wording, the label, the page and a quote of at most 160 characters', opts, async t => {
  const s = await chatWorld(t);
  const out = await s.turn(s.a, QUESTION);
  const answer = answerOf(out);
  assert.ok(answer, JSON.stringify(out.filter(([event]) => event === 'error')));
  assert.equal(answer.status, 'evidence_found');
  assert.equal(answer.answer_source, 'deterministic');
  const { card } = answer;
  assert.equal(card.status, 'evidence_found');
  assert.equal(card.verdict, 'unknown');
  assert.equal(card.sources.length, 1, 'the identity-labelled line is dropped');
  const [source] = card.sources;
  assert.deepEqual([source.tier, source.status, source.page], ['ida_wording', 'extracted_unverified', 7]);
  assert.ok(source.quote.length <= 160);
  assert.ok(s.body.chunks[0].text.includes(source.quote), 'the quote is exact against the cached pack text');
  assert.ok(card.explanation.includes(INSURER_UNCHECKED_LABEL) && card.answer.includes(INSURER_UNCHECKED_LABEL));
  assert.equal(card.legalReview, 'pending');
  // Its own kind of source in the stream, never a household page.
  const insurerSources = answer.sources.filter(item => item.kind === 'insurer_wording');
  assert.equal(insurerSources.length, 1);
  assert.equal(insurerSources[0].page, 7);
  assert.equal(answer.sources.some(item => item.kind === 'wording' || item.document_id), false);
  // No model, no chunks, no facts, no rules.
  assert.deepEqual(s.sent, []);
  assert.deepEqual(answer.facts_used, []);
  assert.equal(answer.computed, null);
  assert.equal(Number((await s.handle.pool.query('SELECT count(*) AS n FROM memory_chunks')).rows[0].n), 0);
});

test('chat v1: insurer text is never called "your documents", and the label is by tier', opts, async t => {
  const s = await chatWorld(t);
  const answer = answerOf(await s.turn(s.a, QUESTION));
  for (const text of [answer.answer, answer.card.headline, answer.card.explanation, answer.card.answer]) assert.equal(/\byour (own )?documents?\b/i.test(text), false, text);
  assert.match(answer.answer, /^The documents you uploaded don't say\./);
  assert.match(answer.answer, /general product text for your linked plan, not read from the documents you uploaded/);
  assert.equal(/read from your (policy )?(document|schedule)/i.test(answer.answer), false);
});

test('chat v1: no link, no pack, or a pack of another version gives the plain unknown card, never insurer text', opts, async t => {
  const unlinked = await chatWorld(t, { link: false });
  const a = answerOf(await unlinked.turn(unlinked.a, QUESTION));
  assert.equal(a.sources.some(item => item.kind === 'insurer_wording'), false);
  assert.equal(a.card.sources.length, 0);
  assert.equal(a.card.status, 'unknown');
  const other = await chatWorld(t, { link: false });
  const otherBody = pack('ver_other');
  await other.services.fssHandoffs.link({ householdId: other.a.household, holdingId: other.a.holding.id, productId: 'prod_c5', versionId: 'ver_other', matchedBy: 'uin', confidence: 'high' });
  await other.services.referenceCache.put({ key: packCacheKey('pages', 'ver_other'), body: pack(VERSION), signature: signatureFor(pack(VERSION)) });
  void otherBody;
  assert.equal(answerOf(await other.turn(other.a, QUESTION)).card.sources.length, 0, 'a row whose body names another version is dropped');
});

test('chat v1: rules never see insurer facts or passages, a procedure question reads no insurer text', opts, async t => {
  const s = await chatWorld(t);
  await s.insurer('room_rent_limit', { amountMinor: 500_000, currency: 'INR' }, ROOM_QUOTE, 7);
  const out = await s.turn(s.a, 'I plan a cataract surgery on 2027-03-01. Will room rent be a problem?', { procedure: { planned_date: '2027-03-01', room_rent_per_day_inr: 9000, estimated_cost_inr: 120000, stay_days: 2 } });
  const answer = answerOf(out);
  assert.ok(answer, JSON.stringify(out));
  for (const check of answer.computed?.checks ?? []) assert.equal(JSON.stringify(check.fact_ids ?? []).includes('ref-room_rent_limit'), false);
  assert.equal(JSON.stringify(answer.computed ?? {}).includes('5,000'), false);
  assert.equal(answer.facts_used.some(item => item.source_tier === 'ida_wording'), false);
  assert.equal(answer.sources.some(item => item.kind === 'insurer_wording'), false);
  assert.equal(answer.card.sources.some(item => item.quote.includes('cataract')), false);
});

test('chat v1: another household cannot read the thread or the insurer lines, and linesFor refuses a foreign household', opts, async t => {
  const s = await chatWorld(t);
  const thread = (await s.services.chatV1.createThread({ principal: { adultId: s.a.adult }, body: { household_id: s.a.household, holding_id: s.a.holding.id } })).thread;
  await assert.rejects(s.services.chatV1.startTurn({ principal: { adultId: s.b.adult }, threadId: thread.id, body: { message: QUESTION } }), error => ['CHAT_THREAD_NOT_FOUND', 'HOUSEHOLD_FORBIDDEN', 'FORBIDDEN'].includes(error.code) || error.statusCode === 404 || error.statusCode === 403);
  const wording = (await import('../src/backend/services/insurer-wording-service.js')).createInsurerWording({ fssHandoffs: s.services.fssHandoffs, referenceCache: s.services.referenceCache, holdingRepository: s.services.holdingPipelineRepository });
  assert.deepEqual(await wording.linesFor({ householdId: s.b.household, holdingIds: [s.a.holding.id], question: QUESTION }), []);
  assert.equal((await wording.linesFor({ householdId: s.a.household, holdingIds: [s.a.holding.id], question: QUESTION })).length, 1);
});

test('revocation empties everything: policy.md, chat insurer lines, the link and the insurer rows', opts, async t => {
  const s = await chatWorld(t);
  await s.insurer('room_rent_limit', { amountMinor: 500_000, currency: 'INR' }, ROOM_QUOTE, 7);
  assert.equal(answerOf(await s.turn(s.a, QUESTION)).card.sources.length, 1);
  assert.equal((await s.render()).includes('insurer_wording'), true);
  await s.services.consents.revoke({ grantId: s.a.consent, revokedByAdultId: s.a.adult, reason: 'user_request' });
  await assert.rejects(s.render(), error => ['HOLDING_NOT_FOUND', 'CONSENT_REQUIRED'].includes(error.code));
  const wording = (await import('../src/backend/services/insurer-wording-service.js')).createInsurerWording({ fssHandoffs: s.services.fssHandoffs, referenceCache: s.services.referenceCache, holdingRepository: s.services.holdingPipelineRepository });
  assert.deepEqual(await wording.linesFor({ householdId: s.a.household, holdingIds: [s.a.holding.id], question: QUESTION }), []);
  for (const table of ['household_memory_facts', 'holding_fss_links', 'memory_chunks']) {
    assert.equal(Number((await s.handle.pool.query(`SELECT count(*) AS n FROM public.${table} WHERE household_id = $1`, [s.a.household])).rows[0].n), 0, table);
  }
  void at;
});
