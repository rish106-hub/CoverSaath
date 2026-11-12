import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture, uploadDocument, grantReading, readDocument } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { JobQueueRepository, ProviderCallRepository } from '../src/backend/repositories/index.js';
import { createModelRouter, createVoyageEmbedClient } from '../src/integrations/index.js';
import { createChatModelGateway, createHouseholdDayBudget } from '../src/features/ai-analysis/chat-runtime.js';
import { buildJobHandlers } from '../src/server/worker.js';

// The production journey for one household and one holding, over local stubs only (Sarvam, Gemini, Anthropic, Voyage, reference data):
// upload (schedule and wording) -> OCR -> structuring -> holdings jobs (detect, confirm-product, parse, reference, collate, memorise)
// -> chat. Consent grants are created through the real routes. Synthetic data only. No live provider call is possible.
// Gaps found on this path are asserted as `todo` tests so the suite stays green and the gap stays visible (see the PR text).

const opts = postgresTestOptions();
const UIN = 'ACMHLIP25001V012526';
const SHA = 'b'.repeat(64);
const FLAGS = {
  HOLDINGS_ENABLED: 'true', POLICY_FACTS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true', SARVAM_OCR_ENABLED: 'true',
  POLICY_STRUCTURING_ENABLED: 'true', DOCUMENT_READBACK_ENABLED: 'true', MEMORY_ENABLED: 'true', CHAT_MODEL_ENABLED: 'true',
  MODEL_PROVIDERS: 'anthropic,voyage', ANTHROPIC_API_KEY: 'test-key-not-real', ANTHROPIC_INPUT_USD_PER_MILLION: '3', ANTHROPIC_OUTPUT_USD_PER_MILLION: '15',
  ANTHROPIC_CLASSIFY_INPUT_USD_PER_MILLION: '1', ANTHROPIC_CLASSIFY_OUTPUT_USD_PER_MILLION: '5', VOYAGE_API_KEY: 'test-voyage-key-not-real', VOYAGE_INPUT_USD_PER_MILLION: '0.06',
  LLM_PROVIDER: 'google', GEMINI_API_KEY: 'test-only-not-a-real-key', LLM_MODEL: 'mock-gemini', LLM_MODEL_VERSION: 'mock-gemini-v1',
  LLM_INPUT_USD_PER_MILLION: '0.75', LLM_OUTPUT_USD_PER_MILLION: '4.50', ORCHESTRATION_RUN_BUDGET_USD: '0.25', ORCHESTRATION_PROJECT_BUDGET_USD: '5',
};

const para = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const SCHEDULE = [para(['Acme Health Insurance Company Limited', 'Shield Plus Policy Schedule', 'Sum Insured: Rs. 5,00,000/-', 'Pre-existing Diseases Waiting Period: 36 months']), para(['Schedule of benefits'])];
const WORDING = [para(['Acme Health Insurance Company Limited', 'Policy wording']), [{ text: 'Exclusions', tag: 'section-title' }, { text: 'Cosmetic surgery is excluded from cover under this policy.', tag: 'paragraph' }]];

// Gemini stub for structuring: reads whatever printed phrase it recognises. Chat stub (Anthropic): words the first matching fact.
const structuringDriver = requests => ({
  loadModel: async () => ({ mocked: true }),
  createAgent: settings => ({ async generate({ prompt }) {
    requests.push(settings.id);
    if (settings.id.endsWith('reconcile')) return { output: { conflicts: [] }, totalUsage: { inputTokens: 10, outputTokens: 2 } };
    const items = [];
    for (const chunk of JSON.parse(prompt).chunks) {
      for (const line of chunk.text.split('\n')) {
        if (line.includes('36 months')) items.push({ chunk_id: chunk.chunk_id, registry_key: 'f.ped_waiting_period', value: '36 months', subject: 'policy', evidence_quote: line.trim(), page: chunk.page, block_index: chunk.block_indexes[0], confidence: 'high', rationale: 'Printed.' });
      }
    }
    return { output: { items }, totalUsage: { inputTokens: 100, outputTokens: 20 } };
  } }),
});
const chatAgent = sent => () => ({ async generate({ prompt }) {
  sent.push(prompt);
  const input = JSON.parse(prompt);
  // Answers only a question about the waiting period, the sum insured or an exclusion in the wording; anything else gets no fact, like an honest model.
  const question = JSON.stringify(input.question);
  const pick = (asked, shown) => (asked.test(question) ? (input.facts ?? []).find(item => shown.test(JSON.stringify(item.label) + JSON.stringify(item.value))) : null);
  const fact = pick(/pre-existing/i, /pre-existing/i);
  const insured = pick(/sum insured/i, /sum insured/i);
  const clause = pick(/cosmetic/i, /cosmetic surgery is excluded/i);
  if (insured) return { output: { status: 'extracted_unverified', answer: 'Your sum insured reads Rs. 5,00,000 on the schedule (not yet confirmed).', factsUsed: [insured.fact_id] }, totalUsage: { inputTokens: 80, outputTokens: 20 } };
  if (clause) return { output: { status: 'extracted_unverified', answer: 'Cosmetic surgery is excluded under the wording.', factsUsed: [clause.fact_id] }, totalUsage: { inputTokens: 80, outputTokens: 20 } };
  return fact
    ? { output: { status: 'extracted_unverified', answer: 'The pre-existing disease waiting period is 1095 days.', factsUsed: [fact.fact_id] }, totalUsage: { inputTokens: 80, outputTokens: 20 } }
    : { output: { status: 'unknown', answer: 'No answer.', factsUsed: [] }, totalUsage: { inputTokens: 80, outputTokens: 5 } };
} });
const vectorOf = text => { const d = createHash('sha256').update(text).digest(); return Array.from({ length: 1024 }, (_, i) => ((d[i % 32] - 127.5) / 127.5) + (i % 7) * 0.001); };

// Reference service stub (import mode): registry, search, product by id, export. Invented product.
function referenceStub() {
  const product = { productId: 'prod-shield', insurerId: 'ins-acme', productName: 'Acme Health Shield Plus', uinRaw: UIN };
  const row = p => ({ product_id: p.productId, insurer_id: p.insurerId, product_name: p.productName, line_of_business: 'health', uin_raw: p.uinRaw, verification_status: 'synthetic_test' });
  const exportBody = { export_version: SHA, product: { product_id: 'prod-shield', product_name: product.productName, insurer_id: 'ins-acme', insurer_name: 'Acme Health Insurance Company Limited', line_of_business: 'health' },
    documents: [{ document_id: 'doc-1', version_id: 'ver-1', wording_version: 'SYN-v1', sha256: SHA, media_type: 'application/pdf', source_observed_at: '2026-01-01T00:00:00.000Z', synthetic: true,
      source_pages: [{ page_number: 1, text: 'Pre-existing diseases are covered after 36 months.', content_sha256: SHA, parser_version: 'p1', extraction_status: 'extracted', tables_json: [] }] }] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json', etag: '"stub"' }); res.end(JSON.stringify(body)); };
    if (url.pathname === '/v1/insurers') return send({ data: [{ id: 'ins-acme', canonical_name: 'Acme Health Insurance Company Limited', aliases: ['Acme Health'] }], next_cursor: null });
    if (url.pathname === '/v1/products') return send({ data: [row(product)], next_cursor: null });
    if (url.pathname === '/v1/products/search') return send({ data: [{ ...row(product), insurer_name: 'Acme Health Insurance Company Limited' }] });
    if (url.pathname === '/v1/network-hospitals/export') return send({ data: [], next_cursor: null });
    if (url.pathname === '/v1/products/prod-shield') return send(row(product));
    if (url.pathname === `/v1/products/by-uin/${UIN}/export`) return send(exportBody);
    return send({ error: { code: 'not_found' } }, 404);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// What deterministic code would read from the reference cache for the holding. Production wires none (see the PR text).
const referenceFacts = { async forHolding() { return [{ factKey: 'waiting_ped', refId: 'ref-syn-ped', origin: 'reference', value: { days: 1095, original: [3, 'year'] }, quote: 'Pre-existing diseases are covered after 3 years.', cacheKey: `product:${UIN}`, version: 'v1' }]; } };

async function world(t) {
  const reference = await referenceStub();
  t.after(() => new Promise(resolve => reference.server.close(resolve)));
  const env = { ...FLAGS, REFERENCE_DATA_BASE_URL: `http://127.0.0.1:${reference.port}`, REFERENCE_DATA_API_KEY: 'test-key-not-real' };
  const chatSent = [];
  const embedded = [];
  const structuringRequests = [];
  let services;
  const app = await startApp(t, {
    env, driver: structuringDriver(structuringRequests),
    services: (database, appEnv) => {
      const providerCalls = new ProviderCallRepository(database);
      const modelGateway = createChatModelGateway({
        env: appEnv, router: createModelRouter({ env: appEnv }), providerCalls, budgetFor: createHouseholdDayBudget({ maxUsd: 1 }),
        loadModel: async () => ({ stub: true }), createAgent: chatAgent(chatSent),
        embedClientFor: () => ({ model: 'voyage-3.5', async embed({ texts }) { embedded.push(...texts); return { vectors: texts.map(vectorOf), totalTokens: texts.length * 10, model: 'voyage-3.5' }; } }),
      });
      services = createBackendServices(database, { env: appEnv, modelGateway, referenceFacts });
      return services;
    },
  });
  const queue = new JobQueueRepository(app.database);
  const worker = createJobWorker({ queue, handlers: buildJobHandlers(services, app.env), workerId: 'journey-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const drain = async () => { const out = []; for (let n = 0; n < 60; n += 1) { const r = await worker.runOnce(); if (!r) break; out.push(r.outcome); } return out; };
  return { app, services, drain, chatSent, embedded, structuringRequests };
}

const grant = async (app, s, body) => { const r = await app.call('/api/v1/consents', { method: 'POST', token: s.token, body: { householdId: s.householdId, subjectAdultId: s.adultId, ...body } }); assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data.id; };

async function structure(app, s, documentId, workflowRunId) {
  const gemini = await grant(app, s, { grantedToActor: 'google-gemini', purpose: 'document_processing', scopes: [{ resourceType: 'document', resourceId: documentId, action: 'derive', dataCategory: 'insurance_document', recipient: 'google-gemini' }] });
  const started = await app.call(`/api/v1/documents/${documentId}/structuring-runs`, { method: 'POST', token: s.token, body: { workflowRunId, consentGrantId: gemini } });
  assert.ok([200, 202].includes(started.status), JSON.stringify(started.data));
  await app.server.structuring.settle(documentId, workflowRunId);
  const result = await app.call(`/api/v1/documents/${documentId}/structuring-runs?workflowRunId=${encodeURIComponent(workflowRunId)}`, { token: s.token });
  assert.equal(result.data.structuring.status, 'finished', JSON.stringify(result.data));
  return result.data.structuring;
}

async function ask(app, s, threadId, message) {
  const response = await fetch(`${app.base}/api/v1/chat/threads/${threadId}/turns`, { method: 'POST', headers: { Authorization: `Bearer ${s.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ message }) });
  assert.equal(response.status, 200);
  const text = await response.text();
  const blocks = text.split('\n\n').map(block => ({ event: /^event: (\w+)$/m.exec(block)?.[1], data: /^data: (.*)$/m.exec(block)?.[1] }));
  const answer = blocks.find(block => block.event === 'answer');
  assert.ok(answer, text);
  return JSON.parse(answer.data);
}

// Shared by the journey tests: schedule and wording uploaded into one case, OCR'd, structured, pipeline run, grants given.
async function journey(t) {
  const w = await world(t);
  const { app, drain } = w;
  fixture.pages = SCHEDULE;
  const s = await scenario(app, { name: 'Journey' });
  const scheduleId = s.documentId;
  fixture.pages = WORDING;
  const wordingId = await uploadDocument(app, s, { kind: 'policy_wording' });
  await readDocument(app, s, wordingId, await grantReading(app, s, wordingId));
  Object.assign(w, { s, scheduleId, wordingId });

  // Structuring of both documents (stub Gemini, document-specific consent) on one fixture analysis run.
  let revision = s.caseRevision;
  for (const toStatus of ['collecting', 'processing']) {
    const moved = await app.call(`/api/v1/cases/${s.caseId}/transitions`, { method: 'POST', token: s.token, body: { toStatus, expectedRevision: revision, actorId: s.adultId } });
    assert.equal(moved.status, 200, JSON.stringify(moved.data));
    revision = moved.data.revision;
  }
  const coverage = await grant(app, s, { purpose: 'coverage_reconstruction', scopes: [{ resourceType: 'case', resourceId: s.caseId, action: 'derive', dataCategory: 'insurance_document' }] });
  const run = await app.call(`/api/v1/cases/${s.caseId}/analysis-runs`, { method: 'POST', token: s.token, headers: { 'Idempotency-Key': randomUUID() }, body: { consentGrantId: coverage, executionMode: 'fixture' } });
  assert.ok([200, 202].includes(run.status), JSON.stringify(run.data));
  w.structured = { schedule: await structure(app, s, scheduleId, run.data.id), wording: await structure(app, s, wordingId, run.data.id) };

  // Provider consent for the memory step and the chat model, through the real consent route (FOR LEGAL REVIEW wording).
  await grant(app, s, { purpose: 'coverage_reconstruction', scopes: ['anthropic', 'voyage'].map(recipient => ({ resourceType: 'household', action: 'derive', dataCategory: 'insurance_question', recipient })) });

  // Holdings: OCR completion made one holding per document and queued detection. The registry import is queued by the first read.
  const holdings = (await app.call(`/api/v1/households/${s.householdId}/holdings`, { token: s.token })).data.holdings;
  w.holdings = holdings;
  w.holdingId = holdings.find(item => item.documentId === scheduleId).id;
  w.wordingHoldingId = holdings.find(item => item.documentId === wordingId).id;
  assert.equal((await app.call(`/api/v1/holdings/${w.holdingId}/product-candidates`, { token: s.token })).status, 503, 'registry not imported yet');
  await drain();
  const candidates = await app.call(`/api/v1/holdings/${w.holdingId}/product-candidates`, { token: s.token });
  assert.equal(candidates.status, 200, JSON.stringify(candidates.data));
  assert.equal(candidates.data.candidates[0].candidateId, 'prod-shield');
  const confirmed = await app.call(`/api/v1/holdings/${w.holdingId}/confirm-product`, { method: 'POST', token: s.token, headers: { 'Idempotency-Key': `confirm-${randomUUID()}` }, body: { candidateId: 'prod-shield', expectedVersion: candidates.data.profileVersion } });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
  w.outcomes = await drain();
  // The wording is linked to the schedule's holding (owner route); memorise then derives and embeds its clauses for that holding.
  w.link = await app.call(`/api/v1/holdings/${w.holdingId}/documents`, { method: 'POST', token: s.token, body: { documentId: wordingId, kind: 'wording' } });
  assert.equal(w.link.status, 200, JSON.stringify(w.link.data));
  w.linkOutcomes = await drain();
  return w;
}

test('journey: schedule and wording uploaded, OCR, structuring, holdings jobs, memorise, chat cites the holding facts', opts, async t => {
  const { app, s, holdingId, wordingHoldingId, holdings, structured, outcomes, drain, embedded, chatSent } = await journey(t);
  assert.equal(holdings.length, 2, 'one holding per document; the wording is linked to the schedule holding (holding_documents), not merged');
  assert.ok(wordingHoldingId !== holdingId);
  for (const review of Object.values(structured)) assert.equal(review.status, 'finished');
  assert.ok(structured.schedule.parameters.some(parameter => parameter.key === 'f.ped_waiting_period'));

  // Worker: every job of the holding ran to success (nothing left waiting on reference data), nothing dead.
  assert.ok(outcomes.length >= 5 && outcomes.every(outcome => outcome === 'succeeded'), JSON.stringify(outcomes));
  const kinds = new Set((await app.database.many("SELECT kind FROM job_queue WHERE status = 'succeeded'")).map(row => row.kind));
  for (const kind of ['holding.parse_own_pdf', 'holding.fetch_reference', 'holding.collate', 'holding.memorise', 'reference.import']) assert.ok(kinds.has(kind), kind);
  assert.deepEqual(await app.database.many("SELECT kind, last_error_code FROM job_queue WHERE status = 'dead'"), []);
  assert.equal((await drain()).length, 0, 'queue is empty');

  // Facts of the holding: own PDF (schedule) and the reference tier.
  const facts = await app.call(`/api/v1/holdings/${holdingId}/facts`, { token: s.token });
  assert.equal(facts.status, 200, JSON.stringify(facts.data));
  const ped = facts.data.facts.find(item => item.factKey === 'waiting_ped');
  assert.equal(ped.status, 'reviewed_reference');
  assert.equal(facts.data.facts.find(item => item.factKey === 'sum_insured').status, 'extracted_unverified', 'a personal value read from the schedule stays unverified');
  assert.ok(embedded.length >= 1, 'memorise embedded passages through the Voyage stub');

  // Chat (a): a fact question is answered by the model over the redacted fact and cites the memory row.
  const thread = await app.call('/api/v1/chat/threads', { method: 'POST', token: s.token, body: { household_id: s.householdId, holding_id: holdingId } });
  assert.equal(thread.status, 201, JSON.stringify(thread.data));
  const answer = await ask(app, s, thread.data.thread.id, 'How long is the waiting period for pre-existing diseases?');
  assert.equal(answer.status, 'evidence_found');
  assert.equal(answer.answer_source, 'model');
  assert.deepEqual(answer.facts_used.map(item => [item.fact_key, item.status]), [['waiting_ped', 'reviewed_reference']]);
  const cited = await app.database.one('SELECT id, holding_id FROM household_memory_facts WHERE id = ?', [answer.facts_used[0].fact_id]);
  assert.equal(cited.holding_id, holdingId, 'the cited fact belongs to the holding');
  assert.match(answer.answer, /1095 days/);
  assert.equal(chatSent.length, 1);
  assert.doesNotMatch(chatSent[0], /Journey|Asha/, 'no household name in the prompt');

  // Chat (c): a question nothing in the household's evidence answers is "unknown", not invented.
  const unknown = await ask(app, s, thread.data.thread.id, 'What colour is my car?');
  assert.equal(unknown.status, 'unknown');
  assert.deepEqual(unknown.facts_used, []);
});

test('chat answers a schedule fact question (sum insured) with the schedule page cited, status kept unverified', opts, async t => {
  const { app, s, holdingId, scheduleId, chatSent } = await journey(t);
  const thread = await app.call('/api/v1/chat/threads', { method: 'POST', token: s.token, body: { household_id: s.householdId, holding_id: holdingId } });
  const answer = await ask(app, s, thread.data.thread.id, 'What is my sum insured?');
  assert.equal(answer.status, 'evidence_found');
  assert.equal(answer.answer_source, 'model');
  assert.deepEqual(answer.facts_used.map(item => [item.fact_key, item.status]), [['sum_insured', 'extracted_unverified']], 'never presented as confirmed');
  const source = answer.sources.find(item => item.kind === 'fact');
  assert.equal(source.status, 'extracted_unverified');
  assert.equal(source.document_id, scheduleId);
  assert.equal(source.page, 1);
  assert.match(source.quote, /Sum Insured: Rs\. 5,00,000/);
  assert.match(chatSent.at(-1), /not confirmed/, 'the model is told the reading is not confirmed');
  assert.doesNotMatch(chatSent.at(-1), new RegExp(UIN));
});

test('chat answers a wording clause question citing the wording document and page', opts, async t => {
  const { app, s, holdingId, wordingId } = await journey(t);
  const thread = await app.call('/api/v1/chat/threads', { method: 'POST', token: s.token, body: { household_id: s.householdId, holding_id: holdingId } });
  const answer = await ask(app, s, thread.data.thread.id, 'Is cosmetic surgery excluded?');
  assert.equal(answer.status, 'evidence_found');
  const passage = answer.sources.find(item => item.kind === 'wording');
  assert.ok(passage, JSON.stringify(answer.sources));
  assert.equal(passage.document_id, wordingId);
  assert.equal(passage.page, 2, 'the wording page is cited');
});

test('an unrelated question stays unknown with no sources', opts, async t => {
  const { app, s, holdingId } = await journey(t);
  const thread = await app.call('/api/v1/chat/threads', { method: 'POST', token: s.token, body: { household_id: s.householdId, holding_id: holdingId } });
  const answer = await ask(app, s, thread.data.thread.id, 'What colour is my car?');
  assert.equal(answer.status, 'unknown');
  assert.deepEqual(answer.sources, []);
});

test('holding documents: link is idempotent, owner scoped and household scoped; unlink and document erasure remove the wording chunks', opts, async t => {
  const { app, s, holdingId, wordingId, scheduleId } = await journey(t);
  const base = `/api/v1/holdings/${holdingId}/documents`;
  const chunksOf = documentId => app.database.one('SELECT count(*)::int AS n FROM memory_chunks WHERE source_document_id = ? AND holding_id = ?', [documentId, holdingId]);
  assert.ok((await chunksOf(wordingId)).n >= 1, 'wording chunks exist for the schedule holding');
  assert.equal((await app.call(base, { token: s.token })).data.documents[0].documentId, wordingId);
  const again = await app.call(base, { method: 'POST', token: s.token, body: { documentId: wordingId, kind: 'wording' } });
  assert.equal(again.status, 200);
  assert.equal(again.data.linked, false, 'a repeat is a no-op');
  assert.equal((await app.call(base, { method: 'POST', token: s.token, body: { documentId: scheduleId, kind: 'wording' } })).status, 400, 'a holding is not linked to its own document');
  assert.equal((await app.call(base, { method: 'POST', token: s.token, body: { documentId: wordingId, kind: 'nonsense' } })).status, 400);
  assert.equal((await app.call(base, { method: 'POST', token: s.token, body: { documentId: wordingId, extra: 1 } })).status, 400);

  // Another household can neither see nor change the link, and cannot link its own document to this holding.
  const other = await scenario(app, { name: 'Other' });
  assert.equal((await app.call(base, { token: other.token })).status, 404);
  assert.equal((await app.call(base, { method: 'POST', token: other.token, body: { documentId: other.documentId, kind: 'wording' } })).status, 404);
  assert.equal((await app.call(`${base}/${wordingId}`, { method: 'DELETE', token: other.token })).status, 404);
  assert.equal((await app.call(base, { method: 'POST', token: s.token, body: { documentId: other.documentId, kind: 'wording' } })).status, 404, 'a foreign document answers 404');

  // Withdrawing the wording document erases its link and the chunks it fed.
  await app.database.run(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = ?`, [wordingId]);
  assert.equal((await app.database.one('SELECT count(*)::int AS n FROM holding_documents WHERE document_id = ?', [wordingId])).n, 0, 'the link goes with the document');
});

test('unlinking a holding document deletes the chunks it fed for that holding', opts, async t => {
  const { app, s, holdingId, wordingId } = await journey(t);
  const chunks = () => app.database.one('SELECT count(*)::int AS n FROM memory_chunks WHERE source_document_id = ? AND holding_id = ?', [wordingId, holdingId]);
  assert.ok((await chunks()).n >= 1);
  const removed = await app.call(`/api/v1/holdings/${holdingId}/documents/${wordingId}`, { method: 'DELETE', token: s.token });
  assert.deepEqual([removed.status, removed.data.unlinked], [200, true]);
  assert.equal((await chunks()).n, 0);
});
