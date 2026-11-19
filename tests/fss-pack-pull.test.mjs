import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { seedWorld } from './support/postgres-fixtures.mjs';
import { startApp, scenario, fixture } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { ReferenceCacheRepository } from '../src/backend/repositories/reference-cache-repository.js';
import { JobQueueRepository } from '../src/backend/repositories/job-queue-repository.js';
import { createFssHandoffService, FSS_PULL_JOB_KIND } from '../src/backend/services/fss-handoff-service.js';
import { createFssPullHandler } from '../src/backend/jobs/fss-handoff-handler.js';
import { packCacheKey } from '../src/backend/services/reference-data-port.js';
import { createInsuranceDataClient } from '../src/integrations/index.js';
import { signNotice } from '../src/integrations/insurance-data/index.js';
import { REFERENCE_ENDPOINTS, SERVICE_ENDPOINTS } from '../src/integrations/insurance-data/client.js';
import { parsePack } from '../src/integrations/insurance-data/schemas.js';
import { mapFssFacts } from '../src/features/policy-facts/fss-fact-map.js';
import { householdLock } from '../src/backend/database/postgres/locks.js';
import { buildJobHandlers } from '../src/server/worker.js';

// Plan C1: a matched FSS handoff pulls the UIN pack (insurance-data-api docs/contracts/uin-pack-v1.md) into the reference cache, links the holding,
// and queues collate. Synthetic data only. The service tests need PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const SECRET = 'synthetic-notice-secret-0123456789';
const UIN = 'SYNHLIP26001V012526';
const VERSION = 'ver_pack_1';
const SHA_DOC = 'd'.repeat(64);
const SHA_PAGE = 'e'.repeat(64);
const ENV = { HOLDINGS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true', FSS_HANDOFF_ENABLED: 'true', FSS_NOTICE_SECRET: SECRET, REFERENCE_DATA_BASE_URL: 'https://fss.example.invalid', REFERENCE_DATA_API_KEY: 'stub-key-not-real', REFERENCE_DATA_TIMEOUT_MS: '150' };
const PAGE_TEXT = [
  'Waiting period: 30 days from the policy start date for any illness except accident.',
  'Pre-existing diseases are covered after 36 months of continuous coverage with us.',
  'Co-payment of 20% applies to every claim made by a person aged above 60 years.',
  'Room rent is limited to Rs. 5,000 per day for a single private room.',
  'Pre-hospitalisation medical expenses are covered for 60 days before admission.',
  'Post-hospitalisation medical expenses are covered for 90 days after discharge.',
  'You may return this policy within a free look period of 15 days of receipt.',
  'Day care procedures are covered when they need less than 24 hours of stay.',
  'Treatment under AYUSH systems is covered up to the sum insured.',
].join('\n');
const quoteOf = needle => PAGE_TEXT.split('\n').find(line => line.includes(needle));
const evidence = needle => [{ document_id: 'doc_pack_1', page_number: 4, quote: quoteOf(needle), page_sha256: SHA_PAGE }];

const packFact = (id, type, value, status, over = {}) => ({ fact_id: id, fact_type: type, value, status, shown: true, evidence: evidence('Waiting period'), ...over });
function rawPack(over = {}) {
  return {
    pack_version: 'f'.repeat(64),
    product: { product_id: 'prod_pack_1', product_name: 'Synthetic Plan', insurer_id: 'ins_pack_1', insurer_name: 'Synthetic Insurer', line_of_business: 'health' },
    version: { version_id: VERSION, wording_version: 'W1', effective_from: '2026-01-01', effective_to: null },
    documents: [{ document_id: 'doc_pack_1', sha256: SHA_DOC, pages: [{ page_number: 4, text: PAGE_TEXT, page_sha256: SHA_PAGE }] }],
    facts: [
      packFact('pf-initial', 'waiting_initial', { kind: 'duration', duration: { value: 30, unit: 'days' }, text: '30 days' }, 'extracted_unverified'),
      packFact('pf-ped', 'waiting_ped', { kind: 'duration', duration: { value: 36, unit: 'months' }, text: '36 months' }, 'independently_verified', { evidence: evidence('Pre-existing') }),
      packFact('pf-hidden', 'copay_percent', { kind: 'percent', percentage: 20, text: '20%' }, 'extracted_unverified', { shown: false, evidence: evidence('Co-payment') }),
      packFact('pf-scoped', 'room_rent_limit', { kind: 'limit', amount: 5000, currency: 'INR', limit_type: 'fixed_amount_per_day', text: 'Rs 5,000', scope: 'plan: gold' }, 'extracted_unverified', { evidence: evidence('Room rent') }),
      packFact('pf-noquote', 'waiting_initial', { kind: 'duration', duration: { value: 9, unit: 'days' }, text: '9 days' }, 'extracted_unverified', { evidence: [{ document_id: 'doc_pack_1', page_number: 4, quote: 'a quote that is not on the page at all', page_sha256: SHA_PAGE }] }),
    ],
    limitations: [],
    ...over,
  };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// A client over a local stub fetch: `mode` is a function (url, init) -> Response | Promise, or a status number. Counts the requests.
function packClient(mode, calls = []) {
  const fetchImpl = (url, init = {}) => {
    calls.push(new URL(String(url)).pathname);
    if (typeof mode === 'function') return Promise.resolve(mode(url, init));
    if (mode === 304) return Promise.resolve({ ok: false, status: 304, headers: { get: () => null }, text: async () => '' });
    return Promise.resolve(typeof mode === 'number' ? new Response('upstream detail', { status: mode }) : json(rawPack()));
  };
  return createInsuranceDataClient({ env: ENV, fetchImpl });
}

// --- parsePack and the endpoint (no database) ---

test('parsePack: shown false and unchecked-without-a-quote facts are absent; verified and unchecked keep their status; a scoped fact is conditional', () => {
  const pack = parsePack(rawPack());
  assert.deepEqual(pack.facts.map(fact => fact.factId), ['pf-initial', 'pf-ped', 'pf-scoped']);
  const byId = Object.fromEntries(pack.facts.map(fact => [fact.factId, fact]));
  assert.equal(byId['pf-initial'].outcome, 'unchecked');
  assert.equal(byId['pf-initial'].factType, 'initial_waiting_period');
  assert.equal(byId['pf-ped'].outcome, 'verified');
  assert.equal(byId['pf-ped'].evidence[0].sha256, SHA_DOC, 'the document sha comes from the pack documents');
  assert.deepEqual(byId['pf-scoped'].conditions, ['plan: gold']);
  assert.equal(pack.product.productId, 'prod_pack_1');
  assert.equal(pack.documents[0].sourcePages[0].pageNumber, 4);
});

test('parsePack: strict shape and the contract bounds fail the whole pack closed', () => {
  const bad = body => assert.throws(() => parsePack(body), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  bad(null);
  bad({ ...rawPack(), pack_version: 'short' });
  bad({ ...rawPack(), facts: [{ ...rawPack().facts[0], status: 'reviewed' }] });
  bad({ ...rawPack(), facts: [{ ...rawPack().facts[0], shown: 'yes' }] });
  bad({ ...rawPack(), facts: Array.from({ length: 2001 }, () => rawPack().facts[0]) });
  bad({ ...rawPack(), documents: Array.from({ length: 21 }, () => rawPack().documents[0]) });
  bad({ ...rawPack(), documents: [{ ...rawPack().documents[0], pages: [{ page_number: 1, text: 'x'.repeat(40_001), page_sha256: SHA_PAGE }] }] });
  const big = { page_number: 1, text: 'y'.repeat(39_000), page_sha256: SHA_PAGE };
  bad({ ...rawPack(), documents: [{ ...rawPack().documents[0], pages: Array.from({ length: 130 }, (_, i) => ({ ...big, page_number: i + 1 })) }] });
  bad({ ...rawPack(), facts: [{ ...rawPack().facts[0], evidence: Array.from({ length: 6 }, () => rawPack().facts[0].evidence[0]) }] });
});

test('products.packByUin is a service endpoint only, GET by UIN, and a 304 is a coded no-op', async () => {
  assert.ok('products.packByUin' in SERVICE_ENDPOINTS);
  assert.ok(!('products.packByUin' in REFERENCE_ENDPOINTS), 'never reachable from the import-file allow-list');
  const calls = [];
  const ok = await packClient(() => json(rawPack()), calls).read('products.packByUin', { uin: UIN });
  assert.equal(calls[0], `/v1/products/by-uin/${UIN}/pack`);
  assert.equal(ok.data.facts.length, 3);
  await assert.rejects(packClient(304).read('products.packByUin', { uin: UIN }), { code: 'REFERENCE_DATA_NOT_MODIFIED', retryable: false });
  await assert.rejects(packClient(404).read('products.packByUin', { uin: UIN }), { code: 'REFERENCE_DATA_NOT_FOUND', retryable: false });
  await assert.rejects(packClient(500).read('products.packByUin', { uin: UIN }), { retryable: true });
  await assert.rejects(packClient(() => json({ nope: true })).read('products.packByUin', { uin: UIN }), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

test('handoff.pack is a service endpoint: GET by the FSS handoff id, no UIN in the request; 404 is permanent, 409 is retryable and never trips the breaker', async () => {
  assert.ok('handoff.pack' in SERVICE_ENDPOINTS);
  assert.ok(!('handoff.pack' in REFERENCE_ENDPOINTS), 'never reachable from the import-file allow-list');
  const calls = [];
  const ok = await packClient(() => json(rawPack()), calls).read('handoff.pack', { handoffId: 'h-1' });
  assert.deepEqual(calls, ['/v1/handoffs/h-1/pack']);
  assert.equal(ok.data.facts.length, 3);
  await assert.rejects(packClient(404).read('handoff.pack', { handoffId: 'h-1' }), { code: 'REFERENCE_DATA_NOT_FOUND', retryable: false });
  await assert.rejects(packClient(409).read('handoff.pack', { handoffId: 'h-1' }), { code: 'REFERENCE_DATA_CONFLICT', retryable: true });
  await assert.rejects(packClient(500).read('handoff.pack', { handoffId: 'h-1' }), { retryable: true });
  await assert.rejects(packClient(200).read('handoff.pack', { handoffId: '../x' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  await assert.rejects(packClient(200).read('handoff.pack', { uin: UIN }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
  // Five 409s in a row do not open the breaker (a not-yet-matched handoff is not an outage).
  const client = packClient(409);
  for (let i = 0; i < 8; i += 1) await assert.rejects(client.read('handoff.pack', { handoffId: 'h-1' }), { code: 'REFERENCE_DATA_CONFLICT' });
});

// FSS sends { kind: 'bool', text: 'yes' | 'no' } for a yes/no key and { kind: 'duration', duration: { value, unit } } for a period (insurance-data-api profile-facts.ts).
const SEVEN = [
  ['waiting_initial', { kind: 'duration', duration: { value: 30, unit: 'days' }, text: '30 days' }, 'Waiting period', 'waiting_initial', { days: 30 }],
  ['waiting_ped', { kind: 'duration', duration: { value: 36, unit: 'months' }, text: '36 months' }, 'Pre-existing', 'waiting_ped', { days: 1095 }],
  ['pre_hospitalisation_days', { kind: 'duration', duration: { value: 60, unit: 'days' }, text: '60 days' }, 'Pre-hospitalisation', 'pre_hospitalisation_days', { days: 60 }],
  ['post_hospitalisation_days', { kind: 'duration', duration: { value: 90, unit: 'days' }, text: '90 days' }, 'Post-hospitalisation', 'post_hospitalisation_days', { days: 90 }],
  ['free_look_period', { kind: 'duration', duration: { value: 15, unit: 'days' }, text: '15 days' }, 'free look period', 'free_look_period', { days: 15 }],
  ['day_care_covered', { kind: 'bool', text: 'yes' }, 'Day care', 'day_care_covered', { value: true }],
  ['clause_ayush', { kind: 'bool', text: 'yes' }, 'AYUSH', 'clause_ayush', { text: 'AYUSH treatment is covered' }],
];
const sevenFacts = () => SEVEN.map(([type, value, needle], i) => packFact(`pf-seven-${i}`, type, value, 'extracted_unverified', { evidence: evidence(needle) }));

for (const [type, value, needle, key, expected] of SEVEN) {
  test(`fact map: pack fact ${type} maps to ${key}, verified and unchecked, with its quote`, () => {
    for (const status of ['independently_verified', 'extracted_unverified']) {
      const pack = parsePack(rawPack({ facts: [packFact('pf-one', type, value, status, { evidence: evidence(needle) })] }));
      const [row, ...rest] = mapFssFacts(pack.facts);
      assert.equal(rest.length, 0);
      assert.equal(row.factKey, key);
      assert.equal(row.unchecked, status === 'extracted_unverified');
      for (const [field, wanted] of Object.entries(expected)) assert.deepEqual(row.value[field], wanted);
      assert.ok(row.fact.evidence[0].quote.includes(needle));
    }
  });
}

test('fact map: the FSS names of the same keys map too; a conditional, an unclear or a wrong-kind value never maps', () => {
  const one = (type, value, over = {}) => mapFssFacts(parsePack(rawPack({ facts: [packFact('pf-x', type, value, 'extracted_unverified', { evidence: evidence('Day care'), ...over })] })).facts);
  assert.equal(one('day_care', { kind: 'bool', text: 'no' })[0].value.value, false);
  assert.equal(one('ayush', { kind: 'bool', text: 'no' })[0].value.text, 'AYUSH treatment is not covered');
  assert.equal(one('pre_hospitalization_days', { kind: 'duration', duration: { value: 2, unit: 'months' } })[0].value.days, 60);
  assert.equal(one('post_hospitalization_days', { kind: 'duration', duration: { value: 1, unit: 'years' } })[0].value.days, 365);
  assert.deepEqual(one('day_care_covered', { kind: 'bool', text: 'maybe' }), [], 'not yes or no');
  assert.deepEqual(one('day_care_covered', { kind: 'text', text: 'yes' }), [], 'wrong kind');
  assert.deepEqual(one('clause_ayush', { kind: 'bool' }), [], 'no text');
  assert.deepEqual(one('free_look_period', { kind: 'duration', duration: { value: 15, unit: 'hours' } }), [], 'unit the slot cannot hold');
  assert.deepEqual(one('day_care_covered', { kind: 'bool', text: 'yes', scope: 'plan: gold' }), [], 'scope is a condition');
  // `value.conditions` (a variant's age, zone, plan or sum insured) is a condition too: the fact is not the headline term.
  assert.deepEqual(one('day_care_covered', { kind: 'bool', text: 'yes', conditions: ['age 18 to 35'] }), []);
  assert.deepEqual(one('free_look_period', { kind: 'duration', duration: { value: 15, unit: 'days' }, conditions: ['zone: A'] }), []);
  assert.throws(() => one('day_care_covered', { kind: 'bool', text: 'yes', conditions: [7] }), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
});

// --- the service, on a real database ---

async function world(t, { reader = packClient(200), extraDocs = 0 } = {}) {
  const fresh = await freshDatabase(t);
  const a = await seedWorld(fresh.handle.pool, 'a');
  const services = createBackendServices(fresh.db, { env: ENV, referenceClient: reader });
  const holding = await services.policyHoldings.create({ householdId: a.household, adultId: a.adult, documentId: a.document, kind: 'retail_health', policyId: a.policy });
  const real = services.holdingPipelineRepository;
  const holdingRepository = {
    getHolding: async args => { const row = await real.getHolding(args); return row && { ...row, policyProfileId: 'pp-pack-test' }; },
    holdingDocument: args => real.holdingDocument(args),
    readableDocuments: args => real.readableDocuments(args),
    confirmedUin: async () => UIN,
    confirmedNames: async () => new Map(),
  };
  const events = [];
  const collated = [];
  const handoffCalls = { get: 0 };
  const handoffClient = { create: async () => { throw new Error('not used'); }, get: async () => { handoffCalls.get += 1; return { handoffId: 'h-1', requestId: handoffCalls.requestId, state: 'matched', versionId: VERSION }; } };
  const service = createFssHandoffService({
    repository: services.fssHandoffs, holdingRepository, jobQueue: services.jobQueue, referenceCache: new ReferenceCacheRepository(fresh.db),
    onPulled: async ({ holding: h }) => { collated.push(h.id); }, env: ENV, client: handoffClient, reader, onEvent: event => events.push(event),
  });
  return { ...fresh, a, services, holding: { ...holding, householdId: a.household }, service, events, collated, handoffCalls, reader };
}
const cacheRows = s => s.db.many("SELECT key, body FROM reference_cache WHERE key LIKE 'handoff.pack.%'");
const pullJobs = s => s.db.many('SELECT id, status, payload_json AS payload FROM job_queue WHERE kind = ?', [FSS_PULL_JOB_KIND]);
const noticeFor = (requestId, state = 'matched', versionId = VERSION) => {
  const body = JSON.stringify({ handoff_id: 'h-1', request_id: requestId, state, ...(state === 'matched' ? { version_id: versionId } : {}) });
  return { rawBody: body, header: signNotice(body, SECRET) };
};
async function accepted(s) {
  const { requestId } = await s.service.queueForHolding({ holding: s.holding });
  await s.services.fssHandoffs.recordAccepted({ requestId, fssHandoffId: 'h-1', state: 'accepted' });
  s.handoffCalls.requestId = requestId;
  return requestId;
}

test('first matched notice queues one pull job (ids only); a duplicate queues no second one, even after the first finished', opts, async t => {
  const s = await world(t);
  const requestId = await accepted(s);
  assert.deepEqual(await s.service.receiveNotice(noticeFor(requestId)), { result: 'applied' });
  const first = await pullJobs(s);
  assert.equal(first.length, 1);
  const payload = typeof first[0].payload === 'string' ? JSON.parse(first[0].payload) : first[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ['holdingId', 'requestId']);
  assert.deepEqual(await s.service.receiveNotice(noticeFor(requestId)), { result: 'duplicate' });
  await s.db.run("UPDATE job_queue SET status = 'succeeded', finished_at = now() WHERE kind = ?", [FSS_PULL_JOB_KIND]);
  assert.deepEqual(await s.service.receiveNotice(noticeFor(requestId)), { result: 'duplicate' });
  assert.equal((await pullJobs(s)).length, 1, 'the repeat after completion queued nothing');
  const noMatch = noticeFor(requestId, 'no_match');
  assert.deepEqual(await s.service.receiveNotice(noMatch), { result: 'ignored' });
  assert.equal((await pullJobs(s)).length, 1);
});

test('the poll path queues one pull job on the first matched answer only; a final send answer does too', opts, async t => {
  const s = await world(t);
  const requestId = await accepted(s);
  await s.db.run("UPDATE fss_handoffs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE request_id = ?", [requestId]);
  assert.deepEqual(await s.service.poll(), { polled: 1 });
  assert.equal((await pullJobs(s)).length, 1);
  assert.deepEqual(await s.service.poll(), { polled: 0 }, 'a decided handoff is no longer open');
  assert.equal((await pullJobs(s)).length, 1);

  const send = await world(t);
  const sendClient = { create: async r => ({ handoffId: 'h-2', requestId: r.requestId, state: 'matched', versionId: VERSION }) };
  const withSend = createFssHandoffService({
    repository: send.services.fssHandoffs, jobQueue: send.services.jobQueue, env: ENV, client: sendClient, reader: send.reader, onEvent: () => {},
    holdingRepository: { getHolding: async a => ({ ...(await send.services.holdingPipelineRepository.getHolding(a)), policyProfileId: null }), holdingDocument: a => send.services.holdingPipelineRepository.holdingDocument(a), confirmedNames: async () => new Map([[send.holding.id, { insurerName: 'Test Insurer', productName: 'Test Plan' }]]), confirmedUin: async () => null },
  });
  const queued = await withSend.queueForHolding({ holding: send.holding });
  assert.equal(await withSend.send({ householdId: send.a.household, holdingId: send.holding.id, requestId: queued.requestId }), 'matched');
  assert.equal((await pullJobs(send)).length, 1);
});

test('pull: links the holding, caches facts and page chunks by version (no household data), drops shown:false, queues collate', opts, async t => {
  const calls = [];
  const s = await world(t, { reader: packClient(() => json(rawPack()), calls) });
  const requestId = await accepted(s);
  await s.service.receiveNotice(noticeFor(requestId));
  const args = { householdId: s.a.household, holdingId: s.holding.id, requestId };
  assert.equal(await s.service.pull(args), 'pulled');
  const link = await s.services.fssHandoffs.linkFor(s.holding.id);
  assert.deepEqual({ productId: link.productId, versionId: link.versionId, matchedBy: link.matchedBy, confidence: link.confidence }, { productId: 'prod_pack_1', versionId: VERSION, matchedBy: 'uin', confidence: 'high' });
  const rows = await cacheRows(s);
  assert.deepEqual(rows.map(row => row.key).sort(), [packCacheKey('facts', VERSION), packCacheKey('pages', VERSION)].sort());
  const facts = rows.find(row => row.key === packCacheKey('facts', VERSION)).body;
  assert.deepEqual(facts.facts.map(fact => fact.factId), ['pf-initial', 'pf-ped', 'pf-scoped']);
  assert.ok(!facts.facts.some(fact => fact.factId === 'pf-hidden'), 'shown:false is absent');
  const pages = rows.find(row => row.key === packCacheKey('pages', VERSION)).body;
  assert.ok(pages.chunks.length >= 1 && pages.chunks[0].documentId === 'doc_pack_1' && pages.chunks[0].pageNumber === 4);
  const everything = JSON.stringify(rows);
  for (const secret of [s.a.household, s.holding.id, requestId, UIN, s.a.adult]) assert.ok(!everything.includes(secret), 'reference_cache holds public text only');
  assert.deepEqual(s.collated, [s.holding.id]);
  assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).lastOutcome, 'pulled');
  assert.equal(calls.length, 1);
});

test('pull: an erased holding is dropped and counted, and nothing is written', opts, async t => {
  const s = await world(t);
  const requestId = await accepted(s);
  await s.service.receiveNotice(noticeFor(requestId));
  await s.db.run('DELETE FROM policy_holdings WHERE id = ?', [s.holding.id]);
  assert.equal(await s.service.pull({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'skipped', 'the handoff cascaded away with the holding');
  assert.equal((await cacheRows(s)).length, 0);

  // Erased while the pack is being read: the re-check before the write drops it.
  const racing = await world(t, { reader: packClient(() => json(rawPack())) });
  const id = await accepted(racing);
  await racing.service.receiveNotice(noticeFor(id));
  const original = racing.reader.read.bind(racing.reader);
  racing.reader.read = async (...args) => { const out = await original(...args); await racing.db.run('DELETE FROM policy_holdings WHERE id = ?', [racing.holding.id]); return out; };
  // The erased holding takes its handoff with it, so run the race with the holding only checked through the document: use the document's lifecycle instead.
  assert.ok(['dropped', 'skipped'].includes(await racing.service.pull({ householdId: racing.a.household, holdingId: racing.holding.id, requestId: id })));
  assert.equal((await cacheRows(racing)).length, 0);
  assert.equal(await racing.services.fssHandoffs.linkFor(racing.holding.id), null);
});

test('pull: consent revoked while the pack is read means no write, no link, no collate', opts, async t => {
  const reader = packClient(() => json(rawPack()));
  const s = await world(t, { reader });
  const requestId = await accepted(s);
  await s.service.receiveNotice(noticeFor(requestId));
  const original = reader.read.bind(reader);
  reader.read = async (...args) => {
    const out = await original(...args);
    await s.db.run("UPDATE consent_grants SET revoked_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [s.a.consent]);
    return out;
  };
  assert.equal(await s.service.pull({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'dropped');
  assert.equal((await cacheRows(s)).length, 0);
  assert.equal(await s.services.fssHandoffs.linkFor(s.holding.id), null);
  assert.deepEqual(s.collated, []);
  assert.ok(s.events.some(event => event.type === 'fss.pull_dropped'));
  // Revoked before the pull starts: dropped without calling FSS.
  const before = await world(t, { reader: packClient(() => json(rawPack()), []) });
  const id = await accepted(before);
  await before.service.receiveNotice(noticeFor(id));
  await before.db.run("UPDATE consent_grants SET revoked_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [before.a.consent]);
  assert.equal(await before.service.pull({ householdId: before.a.household, holdingId: before.holding.id, requestId: id }), 'dropped');
});

test('pull: 404 is permanent (outcome stored, no throw); 409, 429, 5xx and timeout rethrow for backoff; bad shape and a wrong version write nothing', opts, async t => {
  const cases = [
    [404, null, 'pack_not_available'],
    [409, 'throws', 'handoff_not_matched'],
    [429, 'throws', 'rate_limited'],
    [500, 'throws', 'unavailable'],
    [() => json({ not: 'a pack' }), null, 'response_invalid'],
    [() => json(rawPack({ version: { ...rawPack().version, version_id: 'ver_other' } })), null, 'version_mismatch'],
  ];
  for (const [mode, rethrow, outcome] of cases) {
    const s = await world(t, { reader: packClient(mode) });
    const requestId = await accepted(s);
    await s.service.receiveNotice(noticeFor(requestId));
    const args = { householdId: s.a.household, holdingId: s.holding.id, requestId };
    if (rethrow) await assert.rejects(s.service.pull(args), { retryable: true });
    else assert.notEqual(await s.service.pull(args), 'pulled');
    assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).lastOutcome, outcome, `${typeof mode === 'number' ? mode : outcome}`);
    assert.equal((await cacheRows(s)).length, 0);
    assert.equal(await s.services.fssHandoffs.linkFor(s.holding.id), null);
    assert.deepEqual(s.collated, []);
  }
  const hung = await world(t, { reader: packClient((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))) });
  const id = await accepted(hung);
  await hung.service.receiveNotice(noticeFor(id));
  await assert.rejects(hung.service.pull({ householdId: hung.a.household, holdingId: hung.holding.id, requestId: id }), { retryable: true });
  assert.equal((await hung.services.fssHandoffs.byRequestId(id)).lastOutcome, 'unavailable');
});

test('pull: the queue retries a retryable failure with backoff and the job handler is wired in the worker', opts, async t => {
  const s = await world(t, { reader: packClient(500) });
  const requestId = await accepted(s);
  await s.service.receiveNotice(noticeFor(requestId));
  const handler = createFssPullHandler({ service: s.service });
  await assert.rejects(handler({ job: { kind: 'x' } }), { code: 'JOB_PAYLOAD_INVALID' });
  const worker = createJobWorker({ queue: new JobQueueRepository(s.db), handlers: { [FSS_PULL_JOB_KIND]: handler }, workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const outcome = await worker.runOnce();
  assert.notEqual(outcome.outcome, 'succeeded');
  const job = (await pullJobs(s))[0];
  assert.equal(job.status, 'queued', 'rescheduled, not dead');
  assert.ok(FSS_PULL_JOB_KIND in buildJobHandlers(s.services, ENV));
  assert.ok(!(FSS_PULL_JOB_KIND in buildJobHandlers(s.services, { HOLDINGS_ENABLED: 'true' })));
});

test('pull: a handoff that is not matched, or another holding, is skipped; the pack is read by the handoff id and no UIN is sent', opts, async t => {
  const calls = [];
  const s = await world(t, { reader: packClient(() => json(rawPack()), calls) });
  const requestId = await accepted(s);
  assert.equal(await s.service.pull({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'skipped', 'still accepted');
  await s.service.receiveNotice(noticeFor(requestId));
  assert.equal(await s.service.pull({ householdId: 'household-other', holdingId: s.holding.id, requestId }), 'skipped');
  assert.equal(calls.length, 0);
  assert.equal(await s.service.pull({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'pulled');
  assert.deepEqual(calls, ['/v1/handoffs/h-1/pack'], 'the handoff pack route, never the by-UIN route');
  assert.ok(!calls.join(' ').includes(UIN));
});

test('pull: a 404 pack_not_available is recorded once and never retried; a 409 handoff_not_matched is retried by the queue and then succeeds', opts, async t => {
  const calls = [];
  const gone = await world(t, { reader: packClient(() => json({ error: 'pack_not_available' }, 404), calls) });
  const requestId = await accepted(gone);
  await gone.service.receiveNotice(noticeFor(requestId));
  const handler = createFssPullHandler({ service: gone.service });
  const worker = createJobWorker({ queue: new JobQueueRepository(gone.db), handlers: { [FSS_PULL_JOB_KIND]: handler }, workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  assert.equal((await worker.runOnce()).outcome, 'succeeded', 'a permanent miss completes the job: no retry storm');
  assert.equal((await pullJobs(gone))[0].status, 'succeeded');
  assert.equal(calls.length, 1);
  assert.equal((await gone.services.fssHandoffs.byRequestId(requestId)).lastOutcome, 'pack_not_available');
  assert.equal(await worker.runOnce(), null, 'nothing left to run');

  let status = 409;
  const later = await world(t, { reader: packClient(() => (status === 409 ? json({ error: 'handoff_not_matched' }, 409) : json(rawPack()))) });
  const id = await accepted(later);
  await later.service.receiveNotice(noticeFor(id));
  const retry = createJobWorker({ queue: new JobQueueRepository(later.db), handlers: { [FSS_PULL_JOB_KIND]: createFssPullHandler({ service: later.service }) }, workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  assert.notEqual((await retry.runOnce()).outcome, 'succeeded');
  assert.equal((await pullJobs(later))[0].status, 'queued', 'rescheduled with backoff');
  assert.equal((await later.services.fssHandoffs.byRequestId(id)).lastOutcome, 'handoff_not_matched');
  status = 200;
  assert.equal(await later.service.pull({ householdId: later.a.household, holdingId: later.holding.id, requestId: id }), 'pulled');
});

test('outbox: the matched state and its pull job commit together; a failed enqueue rolls the state back and the replayed notice queues it', opts, async t => {
  const s = await world(t);
  const requestId = await accepted(s);
  let fail = true;
  const flaky = { enqueue: async job => { if (fail) throw new Error('queue down'); return s.services.jobQueue.enqueue(job); } };
  const service = createFssHandoffService({
    repository: s.services.fssHandoffs, holdingRepository: s.services.holdingPipelineRepository, jobQueue: flaky, referenceCache: new ReferenceCacheRepository(s.db),
    env: ENV, reader: s.reader, client: { get: async () => ({ handoffId: 'h-1', requestId, state: 'matched', versionId: VERSION }) },
  });
  await assert.rejects(service.receiveNotice(noticeFor(requestId)), /queue down/);
  const after = await s.services.fssHandoffs.byRequestId(requestId);
  assert.equal(after.state, 'accepted', 'no matched state without its job');
  assert.equal(after.versionId, null);
  assert.equal((await pullJobs(s)).length, 0);
  fail = false;
  assert.deepEqual(await service.receiveNotice(noticeFor(requestId)), { result: 'applied' });
  assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).state, 'matched');
  assert.equal((await pullJobs(s)).length, 1);
  assert.deepEqual(await service.receiveNotice(noticeFor(requestId)), { result: 'duplicate' });
  assert.equal((await pullJobs(s)).length, 1);
  // The same through the poll: a failed enqueue leaves the handoff open for the next hour.
  const polled = await world(t);
  const id = await accepted(polled);
  await polled.db.run("UPDATE fss_handoffs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE request_id = ?", [id]);
  const brokenPoll = createFssHandoffService({
    repository: polled.services.fssHandoffs, holdingRepository: polled.services.holdingPipelineRepository, jobQueue: { enqueue: async () => { throw new Error('queue down'); } },
    env: ENV, reader: polled.reader, client: { get: async () => ({ handoffId: 'h-1', requestId: id, state: 'matched', versionId: VERSION }) },
  });
  await assert.rejects(brokenPoll.poll(), /queue down/);
  assert.equal((await polled.services.fssHandoffs.byRequestId(id)).state, 'accepted');
});

test('link: the consent re-check and the link are one transaction under the household lock; a revocation committing first wins', opts, async t => {
  const reader = packClient(() => json(rawPack()));
  const s = await world(t, { reader });
  const requestId = await accepted(s);
  await s.service.receiveNotice(noticeFor(requestId));
  const original = reader.read.bind(reader);
  let revoking = null;
  reader.read = async (...args) => {
    const out = await original(...args);
    // A revocation transaction takes the household lock, revokes, and commits a moment later. It holds the lock before the pull goes on.
    let locked;
    const ready = new Promise(resolve => { locked = resolve; });
    revoking = s.db.transaction(async () => {
      await s.db.run("UPDATE consent_grants SET revoked_at = '2099-01-01T00:00:00.000Z' WHERE id = ?", [s.a.consent]);
      locked();
      await new Promise(resolve => setTimeout(resolve, 300));
    }, { locks: [householdLock(s.a.household)] });
    await ready;
    return out;
  };
  assert.equal(await s.service.pull({ householdId: s.a.household, holdingId: s.holding.id, requestId }), 'dropped', 'the re-check waited for the lock and saw the revocation');
  await revoking;
  assert.equal(await s.services.fssHandoffs.linkFor(s.holding.id), null);
  assert.equal((await cacheRows(s)).length, 0);
  assert.deepEqual(s.collated, []);
});

test('link: a link that the scope trigger refuses leaves the enclosing transaction usable and the pull dropped', opts, async t => {
  const s = await world(t);
  const result = await s.services.fssHandoffs.withHousehold(s.a.household, async () => {
    await assert.rejects(s.services.fssHandoffs.link({ householdId: s.a.household, holdingId: 'hold-does-not-exist', productId: 'p-1', versionId: VERSION, matchedBy: 'uin', confidence: 'high' }), { code: 'HOLDING_NOT_FOUND' });
    return s.db.one('SELECT 1 AS ok');
  });
  assert.equal(Number(result.ok), 1);
});

test('poll: two pollers never claim the same handoff (FOR UPDATE SKIP LOCKED); the claim moves the row out of the window', opts, async t => {
  const s = await world(t);
  const requestId = await accepted(s);
  await s.db.run("UPDATE fss_handoffs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE request_id = ?", [requestId]);
  const claims = await Promise.all([1, 2, 3, 4].map(() => s.services.fssHandoffs.claimForPoll({ olderThanIso: '2021-01-01T00:00:00.000Z' })));
  assert.equal(claims.flat().length, 1, 'exactly one poller got it');
  assert.equal((await s.services.fssHandoffs.claimForPoll({ olderThanIso: '2021-01-01T00:00:00.000Z' })).length, 0);
  // Two service pollers: one FSS get in total.
  const again = await world(t);
  const id = await accepted(again);
  await again.db.run("UPDATE fss_handoffs SET updated_at = '2020-01-01T00:00:00.000Z' WHERE request_id = ?", [id]);
  const results = await Promise.all([again.service.poll(), again.service.poll()]);
  assert.equal(results.reduce((sum, item) => sum + item.polled, 0), 1);
  assert.equal(again.handoffCalls.get, 1);
});

test('the signature form: a source-change style header (sha256=<hex>) is refused with the same coded 401, never applied', opts, async t => {
  const s = await world(t);
  const requestId = await accepted(s);
  const body = JSON.stringify({ handoff_id: 'h-1', request_id: requestId, state: 'matched', version_id: VERSION });
  await assert.rejects(s.service.receiveNotice({ rawBody: body, header: `sha256=${'a'.repeat(64)}` }), { code: 'FSS_NOTICE_SIGNATURE_INVALID' });
  assert.equal((await s.services.fssHandoffs.byRequestId(requestId)).state, 'accepted');
  assert.equal((await pullJobs(s)).length, 0);
});

// --- end to end: send answer -> pull job -> collate -> ida_wording rows -> revocation erases rows and link ---

const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const n = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);

test('end to end: matched handoff pulls the pack, collate writes ida_wording rows from it, and revocation erases rows and link', opts, async t => {
  fixture.pages = [page(['Sum Insured: Rs. 5,00,000/-', 'Co-payment: 10%']), page(['Schedule of benefits'])];
  const env = { POLICY_FACTS_ENABLED: 'true', ...ENV };
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'Holding' });
  const calls = [];
  const referenceClient = packClient(url => {
    const path = new URL(String(url)).pathname;
    return path.endsWith('/pack') ? json(rawPack({ facts: [...rawPack().facts, ...sevenFacts().slice(2), packFact('pf-dc-hidden', 'day_care_covered', { kind: 'bool', text: 'yes', conditions: ['age 18 to 35'] }, 'extracted_unverified', { evidence: evidence('Day care') })] })) : json({ error: 'not_found' }, 404);
  }, calls);
  const handoffClient = {
    create: async request => ({ handoffId: 'h-e2e', requestId: request.requestId, state: 'matched', versionId: VERSION }),
    get: async () => { throw new Error('poll not used'); },
  };
  const services = createBackendServices(app.database, { env, referenceClient, handoffClient });
  const holdingId = `hold-${s.documentId}`.slice(0, 100);
  const at = new Date().toISOString();
  await app.database.run("DELETE FROM job_queue WHERE kind = 'holding.detect_insurer'");
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run(`INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'retail_health', 'insurer_pending', ?, ?)`, [holdingId, s.householdId, s.documentId, at, at]);
  const sourceVersion = (await app.database.one('SELECT source_version FROM document_uploads WHERE id = ?', [s.documentId])).source_version;
  await services.policyProfiles.confirm({ householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, idempotencyKey: 'confirm-key-0001',
    statement: Object.freeze({ uin: UIN, insurerName: 'Synthetic Insurer', policyName: 'Synthetic Plan', expectedVersion: 0 }) });
  const profile = await services.policyProfiles.get({ householdId: s.householdId, documentId: s.documentId, sourceVersion });
  await services.policyHoldings.link({ householdId: s.householdId, adultId: s.adultId, holdingId, policyProfileId: profile.id });
  await services.policyHoldings.setStatus({ householdId: s.householdId, adultId: s.adultId, holdingId, status: 'product_reported' });
  const worker = createJobWorker({ queue: new JobQueueRepository(app.database), handlers: buildJobHandlers(services, env), workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const drain = async () => { for (let i = 0; i < 60; i += 1) if (!await worker.runOnce()) break; };

  await services.holdings.startPipeline({ householdId: s.householdId, holdingId });
  await drain();
  assert.equal(await n(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.fss_pull'"), 1);
  assert.equal(calls.filter(path => path.endsWith('/pack')).length, 1);
  const link = await services.fssHandoffs.linkFor(holdingId);
  assert.equal(link.versionId, VERSION);
  const ida = await app.database.many("SELECT fact_key, status FROM household_memory_facts WHERE holding_id = ? AND source_tier = 'ida_wording' AND superseded_at IS NULL ORDER BY fact_key", [holdingId]);
  const byKey = Object.fromEntries(ida.map(row => [row.fact_key, row.status]));
  // All seven shown fact types reach the rows; shown:false, the unmatched quote, the scoped variant and the conditional variant never do.
  assert.deepEqual(Object.keys(byKey), ['clause_ayush', 'day_care_covered', 'free_look_period', 'post_hospitalisation_days', 'pre_hospitalisation_days', 'waiting_initial', 'waiting_ped']);
  assert.equal(byKey.waiting_ped, 'reviewed_reference');
  for (const key of Object.keys(byKey).filter(name => name !== 'waiting_ped')) assert.equal(byKey[key], 'extracted_unverified', key);
  const holdings = await services.policyHoldings.list({ householdId: s.householdId, adultId: s.adultId });
  assert.equal((await services.holdings.summaries({ householdId: s.householdId, holdings })).get(holdingId).wordingState, 'fss');

  const grant = (await app.database.one('SELECT consent_grant_id FROM document_uploads WHERE id = ?', [s.documentId])).consent_grant_id;
  await services.consents.revoke({ grantId: grant, revokedByAdultId: s.adultId, reason: 'user_request' });
  assert.equal(await n(app, "SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ? AND source_tier = 'ida_wording'", [s.householdId]), 0);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM holding_fss_links WHERE household_id = ?', [s.householdId]), 0);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM fss_handoffs WHERE household_id = ?', [s.householdId]), 0);
  // The cache keeps only public insurer text; no household id is in any pulled key or body.
  const cached = JSON.stringify(await app.database.many("SELECT key, body FROM reference_cache WHERE key LIKE 'handoff.pack.%'"));
  assert.ok(!cached.includes(s.householdId) && !cached.includes(holdingId));
});
