import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { JobQueueRepository } from '../src/backend/repositories/job-queue-repository.js';
import { buildJobHandlers } from '../src/server/worker.js';
import { parseFacts } from '../src/integrations/insurance-data/schemas.js';
import { mapFssFacts, fssEvidence } from '../src/features/policy-facts/fss-fact-map.js';
import { collateSlot, resolveSlot, assertMachineRowAuthority } from '../src/features/insurance-rules/collate.js';
import { planProcedure, procedureInputFacts } from '../src/features/insurance-rules/procedure-planning.js';
import { buildDeterministicAnswer } from '../src/features/insurance-rules/chat-answer.js';
import { factSourceLabel, modelSlotSuffix, INSURER_UNCHECKED_LABEL } from '../src/features/insurance-rules/fact-source-label.js';
import { resolvedConfirmedFacts } from '../src/backend/services/memory-service.js';
import { insurerFactPlaces } from '../src/backend/services/fss-reference-facts.js';
import { guardTurnAnswer } from '../src/backend/services/chat-answer-card.js';
import { getPolicyFactKey } from '../src/contracts/policy-facts.js';
import { createFssReferenceFacts } from '../src/backend/services/fss-reference-facts.js';

// ADR 0036: model-extracted insurer facts are shown as "not checked". Synthetic data only. The DB tests need TEST_DATABASE_URL.

const opts = postgresTestOptions();
const SHA = 'a'.repeat(64);
const QUOTE = 'A co-payment of 10% applies to every claim.';
const evidence = (extra = {}) => ({ document_id: 'doc_synth_1', page_number: 12, sha256: SHA, quote_included: true, quote: QUOTE, ...extra });
const fact = (extra = {}) => ({
  fact_id: 'f_copay', fact_type: 'copay', value: { kind: 'copay', percentage: 10 }, verification_status: 'extracted_unverified',
  conditions: [], exceptions: [], evidence: [evidence()], ...extra,
});
const parse = (facts, { synthetic = false, coverage = {} } = {}) => parseFacts({ version_id: 'v1', uin_raw: null, wording_version: 'W1', version_synthetic: synthetic, coverage, facts });
const one = (f, o) => parse([f], o).facts[0];

// ---- parseEvidence / parseFact -------------------------------------------------------------------------------------------------
test('parse: an extracted_unverified fact with a page and a valid quote keeps its value, outcome unchecked, quote kept exactly', () => {
  const parsed = one(fact());
  assert.equal(parsed.outcome, 'unchecked');
  assert.equal(parsed.value.percentage, 10);
  assert.equal(parsed.evidence[0].quote, QUOTE);
  // Never trimmed: what is shown stays verbatim.
  assert.equal(one(fact({ evidence: [evidence({ quote: `  ${QUOTE} ` })] })).evidence[0].quote, `  ${QUOTE} `);
});

test('parse: no value is kept without a parsed quote (quote_included false, absent, under 12, over 200, control character)', () => {
  const blanked = f => { const parsed = one(f); assert.equal(parsed.outcome, 'unknown'); assert.equal(parsed.value, null); assert.equal(parsed.valueText, null); };
  blanked(fact({ evidence: [evidence({ quote_included: false, quote: undefined })] }));
  blanked(fact({ evidence: [evidence({ quote_included: false })] }));
  blanked(fact({ evidence: [evidence({ quote: undefined })] }));
  blanked(fact({ evidence: [evidence({ quote: 'Eleven char' })] }));
  blanked(fact({ evidence: [evidence({ quote: 'x'.repeat(201) })] }));
  blanked(fact({ evidence: [evidence({ quote: 'A co-payment\nof 10% applies.' })] }));
  blanked(fact({ evidence: [] }));
  assert.equal(one(fact({ evidence: [evidence({ quote: 'x'.repeat(12) })] })).outcome, 'unchecked');
  assert.equal(one(fact({ evidence: [evidence({ quote: 'x'.repeat(200) })] })).outcome, 'unchecked');
  // One good item among bad ones is enough; the gate is on the parsed items.
  assert.equal(one(fact({ evidence: [evidence({ quote_included: false }), evidence()] })).outcome, 'unchecked');
});

test('parse: synthetic versions, a shown:false fact, other statuses and unusable families stay hidden; verified is unchanged', () => {
  assert.equal(one(fact(), { synthetic: true }).value, null);
  assert.equal(one(fact({ shown: false })).value, null);
  assert.equal(one(fact({ shown: true })).outcome, 'unchecked');
  assert.equal(one(fact({ verification_status: 'candidate' })).value, null);
  assert.equal(one(fact(), { coverage: { copay: 'conflicting_evidence' } }).outcome, 'conflicting');
  assert.equal(one(fact(), { coverage: { copay: 'not_permitted' } }).value, null);
  const verified = fact({ verification_status: 'independently_verified' });
  assert.equal(one(verified, { coverage: { copay: 'verified' } }).outcome, 'verified');
  assert.equal(one(verified, { coverage: { copay: 'awaiting_review' } }).outcome, 'unknown', 'verified still needs its family');
  assert.equal(one({ ...verified, shown: false }, { coverage: { copay: 'verified' } }).value, null);
});

test('parse: a quote with bidi overrides or isolates, zero-width or direction marks, a BOM, or only spaces is rejected (the fact stays hidden)', () => {
  const blanked = quote => { const parsed = one(fact({ evidence: [evidence({ quote })] })); assert.equal(parsed.outcome, 'unknown', JSON.stringify(quote)); assert.equal(parsed.value, null); };
  for (const mark of ['\u202a', '\u202b', '\u202c', '\u202d', '\u202e', '\u2066', '\u2067', '\u2068', '\u2069', '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\ufeff']) blanked(`A co-payment of 10%${mark} applies to every claim.`);
  blanked(' '.repeat(20));
  blanked('\u00a0'.repeat(20));
  assert.equal(one(fact({ evidence: [evidence({ quote: 'A co-payment of 10% applies.' })] })).outcome, 'unchecked');
});

test('parse: shown is strict (missing or true shows; false, "false", 0, null or anything else hides)', () => {
  assert.equal(one(fact()).outcome, 'unchecked');
  assert.equal(one(fact({ shown: true })).outcome, 'unchecked');
  for (const shown of [false, 'false', 'true', 0, 1, null, '', {}]) assert.equal(one(fact({ shown })).value, null, `shown ${JSON.stringify(shown)}`);
  const verified = fact({ verification_status: 'independently_verified' });
  for (const shown of ['false', 0, null]) assert.equal(one({ ...verified, shown }, { coverage: { copay: 'verified' } }).value, null);
  assert.equal(one({ ...verified, shown: true }, { coverage: { copay: 'verified' } }).outcome, 'verified');
});

// ---- map ------------------------------------------------------------------------------------------------------------------------
test('map: unchecked maps with unchecked true; verified maps with unchecked false; the quote and its page are carried into the sealed reference', () => {
  const unchecked = one(fact());
  const [row] = mapFssFacts([unchecked]);
  assert.deepEqual([row.factKey, row.value, row.unchecked], ['copay_percent', { bp: 1000 }, true]);
  const reference = fssEvidence({ fact: unchecked, versionId: 'v1', cacheKey: 'k' });
  assert.equal(reference.quote, QUOTE);
  assert.equal(reference.quotePage, 12);
  assert.equal(reference.verificationStatus, 'extracted_unverified');
  const [verifiedRow] = mapFssFacts([one(fact({ verification_status: 'independently_verified' }), { coverage: { copay: 'verified' } })]);
  assert.equal(verifiedRow.unchecked, false);
  assert.equal(mapFssFacts([one(fact({ evidence: [evidence({ quote_included: false })] }))]).length, 0, 'a hidden fact does not map');
  assert.equal(fssEvidence({ fact: { factId: 'x', factType: 'copay', evidence: [] }, versionId: 'v', cacheKey: 'k' }).quote, null);
});

// ---- collate / resolve ---------------------------------------------------------------------------------------------------------
const days = n => ({ days: n, original: [] });
const own = (value, factId = 'pf-1') => ({ factId, origin: 'deterministic', state: 'extracted_unverified', value, alternatives: [] });
const unchecked = (value, extra = {}) => ({ refId: 'ref-u', origin: 'reference', unchecked: true, value, quote: QUOTE, ...extra });
const reviewed = (value, extra = {}) => ({ refId: 'ref-r', origin: 'reference', value, ...extra });

test('collate: an own value and an unchecked insurer value -> own wins, the insurer row is dropped, no conflict (even when they differ)', () => {
  for (const insurerDays of [1095, 730]) {
    const slot = collateSlot({ factKey: 'waiting_ped', own: [own(days(1095))], ida: [unchecked(days(insurerDays))] });
    assert.equal(slot.conflict, null);
    assert.equal(slot.ida, null);
    assert.equal(slot.own.status, 'extracted_unverified');
    const resolved = resolveSlot({ factKey: 'waiting_ped', own: { id: 'm-own', ...slot.own } });
    assert.deepEqual([resolved.status, resolved.sourceTier], ['extracted_unverified', 'own_pdf']);
  }
});

test('collate: an unchecked insurer value alone is held as ida_wording extracted_unverified and resolves as not checked, never promoted', () => {
  const slot = collateSlot({ factKey: 'waiting_ped', ida: [unchecked(days(1095))] });
  assert.equal(slot.conflict, null);
  assert.equal(slot.own, null);
  assert.deepEqual([slot.ida.tier, slot.ida.status, slot.ida.value, slot.ida.modelSourced], ['ida_wording', 'extracted_unverified', days(1095), false]);
  assertMachineRowAuthority(slot.ida);
  const resolved = resolveSlot({ factKey: 'waiting_ped', ida: { id: 'm-ida', ...slot.ida } });
  assert.deepEqual([resolved.status, resolved.sourceTier, resolved.checkWithInsurer, resolved.sourceIds], ['extracted_unverified', 'ida_wording', true, ['m-ida']]);
  assert.deepEqual(resolved.value, days(1095));
  // Two different unchecked values are not shown (nothing is guessed, no conflict).
  assert.equal(collateSlot({ factKey: 'waiting_ped', ida: [unchecked(days(1095)), unchecked(days(730), { refId: 'ref-u2' })] }).ida, null);
});

test('collate: a reviewed insurer value beats an unchecked one and agrees or conflicts as before; reviewed beats own and unchecked at read time', () => {
  const both = collateSlot({ factKey: 'waiting_ped', ida: [unchecked(days(730)), reviewed(days(1095))] });
  assert.deepEqual([both.ida.status, both.ida.value], ['reviewed_reference', days(1095)]);
  assert.equal(collateSlot({ factKey: 'waiting_ped', own: [own(days(1095))], ida: [reviewed(days(1095))] }).ida.status, 'reviewed_reference');
  assert.deepEqual(collateSlot({ factKey: 'copay_percent', own: [own({ bp: 2000 })], ida: [reviewed({ bp: 1000 })] }).conflict, { reason: 'own_vs_insurer' });
  const resolved = resolveSlot({ factKey: 'waiting_ped', own: { id: 'o', status: 'extracted_unverified', value: days(730), alternatives: [] }, ida: { id: 'i', status: 'reviewed_reference', value: days(1095), alternatives: [] } });
  assert.equal(resolved.status, 'reviewed_reference');
  // Read-time order: own PDF beats an unchecked insurer row that is somehow still stored next to it.
  const both2 = resolveSlot({ factKey: 'waiting_ped', own: { id: 'o', status: 'extracted_unverified', value: days(730), alternatives: [] }, ida: { id: 'i', status: 'extracted_unverified', value: days(1095), alternatives: [] } });
  assert.deepEqual([both2.status, both2.sourceTier, both2.sourceIds], ['extracted_unverified', 'own_pdf', ['o']]);
});

test('collate: authority refuses an unchecked insurer row that rests on model output or lacks the reference marker', () => {
  const row = collateSlot({ factKey: 'waiting_ped', ida: [unchecked(days(1095))] }).ida;
  assert.throws(() => assertMachineRowAuthority({ ...row, modelSourced: true }), { code: 'COLLATE_AUTHORITY_REFUSED' });
  assert.throws(() => assertMachineRowAuthority({ ...row, reference: { ...row.reference, unchecked: false } }), { code: 'COLLATE_AUTHORITY_REFUSED' });
  // A model-proposed unchecked item never becomes a row.
  const refused = collateSlot({ factKey: 'waiting_ped', ida: [unchecked(days(1095), { origin: 'model_proposed' })] });
  assert.equal(refused.ida, null);
  assert.deepEqual([...refused.refused], ['MODEL_REFERENCE_REFUSED']);
  // A personal value never takes an insurer row.
  assert.equal(collateSlot({ factKey: 'sum_insured', ida: [unchecked({ amountMinor: 1 })] }).ida, null);
});

// ---- never a verdict -----------------------------------------------------------------------------------------------------------
test('never a verdict: an ida_wording extracted_unverified fact never reaches planProcedure, a computed check or a served fact', () => {
  const resolvedRow = (factKey, value) => ({ id: `m-${factKey}`, scopeKey: '', factKey, tier: 'ida_wording', status: 'extracted_unverified', value, alternatives: [], captureMethod: null, resolvesFactIds: [] });
  const rows = [resolvedRow('waiting_ped', days(1095)), resolvedRow('copay_percent', { bp: 1000 }), resolvedRow('room_rent_limit', { amountMinor: 500_000, currency: 'INR' })];
  // Default serving (rules, memory chunks, anything confirmed-only) excludes them entirely.
  assert.deepEqual(resolvedConfirmedFacts(rows), []);
  // Chat may read them as unverified, but they carry the insurer tier and status, and the planning filter drops them.
  const served = resolvedConfirmedFacts(rows, { includeUnverified: true });
  assert.equal(served.length, 3);
  assert.ok(served.every(item => item.sourceTier === 'ida_wording' && item.status === 'extracted_unverified' && item.checkWithInsurer === true));
  assert.deepEqual(procedureInputFacts(served), []);
  const plan = planProcedure({ facts: Object.fromEntries(procedureInputFacts(served).map(item => [item.factKey, { id: item.sourceIds[0], status: item.status, value: item.value }])), procedure: { estimatedCostMinor: 100_000, plannedDate: '2027-01-01' } });
  assert.deepEqual(plan.checks, []);
  assert.deepEqual(plan.factIds, []);
  // The same filter keeps reviewed and confirmed facts and drops own-PDF unverified too.
  const mix = [{ status: 'reviewed_reference', factKey: 'a' }, { status: 'user_confirmed', factKey: 'b' }, { status: 'extracted_unverified', sourceTier: 'own_pdf', factKey: 'c' }, { status: 'conflicting', factKey: 'd' }];
  assert.deepEqual(procedureInputFacts(mix).map(item => item.factKey), ['a', 'b']);
});

// ---- labels --------------------------------------------------------------------------------------------------------------------
test('labels: chosen by tier and status together, never "read from your policy" for the insurer tier', () => {
  assert.equal(INSURER_UNCHECKED_LABEL, "From the insurer's wording, not checked");
  assert.equal(factSourceLabel({ sourceTier: 'ida_wording', status: 'extracted_unverified' }), INSURER_UNCHECKED_LABEL);
  assert.equal(factSourceLabel({ sourceTier: 'own_pdf', status: 'extracted_unverified' }), 'read from your policy schedule, not yet confirmed by you');
  assert.equal(factSourceLabel({ sourceTier: 'ida_wording', status: 'reviewed_reference' }), "from the insurer's published terms");
  assert.equal(factSourceLabel({ status: 'user_confirmed' }), 'confirmed by you');
  assert.equal(modelSlotSuffix({ sourceTier: 'ida_wording', status: 'extracted_unverified' }), `(${INSURER_UNCHECKED_LABEL})`);
  assert.equal(modelSlotSuffix({ sourceTier: 'own_pdf', status: 'extracted_unverified' }), '(read from the policy document, not confirmed)');
  assert.equal(modelSlotSuffix({ sourceTier: 'ida_wording', status: 'reviewed_reference' }), null);
  const entry = getPolicyFactKey('waiting_ped');
  const answer = (sourceTier, status) => buildDeterministicAnswer({ intent: 'fact_lookup', factKeys: ['waiting_ped'], facts: [{ factKey: 'waiting_ped', entry, status, value: days(1095), sourceIds: ['x'], sourceTier, checkWithInsurer: true, holdingId: 'h' }] }).text;
  assert.match(answer('ida_wording', 'extracted_unverified'), /\(From the insurer's wording, not checked\)/);
  assert.doesNotMatch(answer('ida_wording', 'extracted_unverified'), /your policy/);
  assert.match(answer('own_pdf', 'extracted_unverified'), /read from your policy schedule/);
});

test('chat: an unchecked insurer fact is cited only with its insurer page and quote; with no quote there is no place, so it is not cited', () => {
  const row = (reference, extra = {}) => ({ id: 'm-1', tier: 'ida_wording', status: 'extracted_unverified', reference, ...extra });
  assert.deepEqual(insurerFactPlaces([row({ quote: QUOTE, quotePage: 12 })]).get('m-1'), { documentId: null, page: 12, quote: QUOTE });
  assert.equal(insurerFactPlaces([row({ quote: null, quotePage: null })]).size, 0);
  assert.equal(insurerFactPlaces([row({ quote: QUOTE }, { tier: 'own_pdf' }), row({ quote: QUOTE }, { status: 'reviewed_reference' })]).size, 0);
  // The guard grounds the answer in the insurer quote: card tier ida_wording, status extracted_unverified, verdict unknown.
  const released = guardTurnAnswer({ status: 'evidence_found', text: 'A co-payment of 10% applies to every claim.', facts: [{ factId: 'm-1', factKey: 'copay_percent', status: 'extracted_unverified', tier: 'ida_wording', page: 12, quote: QUOTE, valueText: '10%' }] });
  assert.equal(released.released, true, JSON.stringify(released.failedChecks));
  assert.deepEqual([released.card.sources[0].tier, released.card.sources[0].status, released.card.sources[0].page, released.card.verdict], ['ida_wording', 'extracted_unverified', 12, 'unknown']);
  // Without a quote the fact is not evidence: the formatted value alone never stands in for the insurer's words.
  const none = guardTurnAnswer({ status: 'evidence_found', text: 'A co-payment of 10% applies to every claim.', facts: [{ factId: 'm-1', factKey: 'copay_percent', status: 'extracted_unverified', tier: 'ida_wording', page: null, quote: '', valueText: '' }] });
  assert.equal(none.card.sources.length, 0);
});

// ---- the real reader over a stub port that returns real parseFacts output --------------------------------------------------------
const roomFact = (extra = {}) => fact({ fact_id: 'f_room', fact_type: 'room_rent_limit', value: { kind: 'room_rent_limit', limit_type: 'fixed_amount_per_day', amount: 5000, currency: 'INR' },
  evidence: [evidence({ page_number: 7, quote: 'Room rent is limited to INR 5,000 per day.' })], ...extra });
const pedFact = () => fact({ fact_id: 'f_ped', fact_type: 'pre_existing_disease_waiting_period', value: { kind: 'waiting_period', duration: { value: 24, unit: 'months' } },
  evidence: [evidence({ page_number: 9, quote: 'Pre-existing diseases are covered after 24 months.' })] });
const hiddenFact = () => fact({ fact_id: 'f_hidden', fact_type: 'initial_waiting_period', value: { kind: 'waiting_period', duration: { value: 30, unit: 'days' } }, evidence: [evidence({ quote_included: false })] });
function stubPort(facts) {
  const data = {
    'insurers.resolve': { status: 'resolved', insurer: { id: 'ins1' } },
    'products.search': { products: [{ productId: 'p1', lineOfBusiness: 'health', uinRaw: null, verificationStatus: 'verified', productName: 'Synthetic Care' }] },
    'products.versions': { data: [{ versionId: 'v1', freshness: 'current', effectiveFrom: null, effectiveTo: null }] },
  };
  const parsed = parse(facts);
  const live = [];
  return {
    live,
    resolveInsurer: async () => { live.push('resolve'); return { data: data['insurers.resolve'] }; },
    searchProducts: async () => ({ data: data['products.search'] }),
    listVersions: async () => ({ data: data['products.versions'] }),
    getAllFacts: async () => ({ data: parsed }),
    peek: async endpoint => ({ data: data[endpoint] }),
    peekFacts: async ({ cursor }) => (cursor ? null : { data: parsed }),
  };
}
const stubRepository = { holdingDocument: async () => null, ownCandidates: async () => [], confirmedUin: async () => null, confirmedNames: async ({ holdings }) => new Map(holdings.map(item => [item.id, { insurerName: 'Synthetic Insurer', productName: 'Synthetic Care' }])) };
const readerFor = facts => createFssReferenceFacts({ port: stubPort(facts), repository: stubRepository, env: { REFERENCE_DATA_ENABLED: 'true' } });
const holdingStub = { id: 'hold-1', documentId: 'doc-1', policyProfileId: null };

test('reader: refresh attaches when the only mapped facts are unchecked; a hidden fact alone is not usable', async () => {
  assert.equal(await readerFor([roomFact(), hiddenFact()]).refresh({ householdId: 'h', holding: holdingStub }), 'attached');
  assert.notEqual(await readerFor([hiddenFact()]).refresh({ householdId: 'h', holding: holdingStub }), 'attached');
});

test('reader: forHolding turns real parseFacts output into unchecked reference items with the quote and page sealed in the reference, ready to collate', async () => {
  const items = await readerFor([roomFact(), pedFact(), hiddenFact()]).forHolding({ householdId: 'h', holding: holdingStub });
  assert.deepEqual(items.map(item => item.factKey).sort(), ['room_rent_limit', 'waiting_ped']);
  const room = items.find(item => item.factKey === 'room_rent_limit');
  assert.equal(room.unchecked, true);
  assert.deepEqual([room.quote, room.reference.quote, room.reference.quotePage, room.reference.verificationStatus], ['Room rent is limited to INR 5,000 per day.', 'Room rent is limited to INR 5,000 per day.', 7, 'extracted_unverified']);
  // Collate: the insurer row is written as ida_wording extracted_unverified and its reference travels with it.
  const slot = collateSlot({ factKey: 'room_rent_limit', ida: [room] });
  assert.deepEqual([slot.ida.tier, slot.ida.status, slot.conflict], ['ida_wording', 'extracted_unverified', null]);
  assert.equal(slot.ida.reference.quote, 'Room rent is limited to INR 5,000 per day.');
  assert.equal(slot.ida.reference.reference.quotePage, 7);
  assert.equal(slot.ida.reference.reference.quote, 'Room rent is limited to INR 5,000 per day.');
  assert.equal(slot.ida.reference.unchecked, true);
});

test('chat: for an unchecked insurer fact the evidence is the quote only; a number found only in the formatted value does not ground the answer', () => {
  const draft = tier => guardTurnAnswer({ status: 'evidence_found', text: 'The co-payment is 10%.', facts: [{ factId: 'm-1', factKey: 'copay_percent', status: 'extracted_unverified', tier, page: 12, quote: 'A co-payment applies to every claim.', valueText: '10%' }] });
  assert.equal(draft('ida_wording').released, false, 'the insurer quote has no 10, so the value text may not stand in for it');
  assert.equal(draft('own_pdf').released, true, 'own-document readings keep quote plus value as before');
});

// ---- database: write, seal, display, erase ------------------------------------------------------------------------------------
const ON = { POLICY_FACTS_ENABLED: 'true', HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'true' };
const SCHEDULE = ['Sum Insured: Rs. 5,00,000/-', 'Pre-existing Diseases Waiting Period: 36 months', 'Co-payment: 20%'];
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const CACHE_KEY = 'versions.facts:synthetic';
const reference = (factKey, value, extra = {}) => ({
  factKey, value, origin: 'reference', unchecked: true, refId: `fss:f_${factKey}`, cacheKey: CACHE_KEY, version: 'W1', quote: QUOTE,
  reference: { source: 'fss', refId: `fss:f_${factKey}`, versionId: 'v1', factId: `f_${factKey}`, verificationStatus: 'extracted_unverified', evidence: [{ documentId: 'doc_synth_1', pageNumber: 12, sha256: SHA }], cacheKey: CACHE_KEY, quote: QUOTE, quotePage: 12, origin: 'reference', unchecked: true },
  ...extra,
});
const referenceFacts = { async forHolding() { return [
  reference('waiting_ped', days(730)), // the schedule has a PED wait: own wins, no row, no conflict
  reference('room_rent_limit', { amountMinor: 500_000, currency: 'INR' }), // the schedule is silent: shown as not checked
]; } };
const count = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);

async function world(t, referenceFactsPort = referenceFacts) {
  fixture.pages = [page(SCHEDULE), page(['Schedule of benefits'])];
  const app = await startApp(t, { env: ON });
  const s = await scenario(app, { name: 'Holding' });
  const services = createBackendServices(app.database, { env: ON, referenceFacts: referenceFactsPort });
  const at = new Date().toISOString();
  s.holdingId = `hold-${s.documentId}`.slice(0, 100);
  await app.database.run("DELETE FROM job_queue WHERE kind = 'holding.detect_insurer'");
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run(`INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'retail_health', 'product_reported', ?, ?)`, [s.holdingId, s.householdId, s.documentId, at, at]);
  const worker = createJobWorker({ queue: new JobQueueRepository(app.database), handlers: buildJobHandlers(services, ON), workerId: 'test-worker', leaseMs: 60_000, heartbeatMs: 20_000 });
  const drain = async () => { for (let n = 0; n < 50; n += 1) if (!await worker.runOnce()) break; };
  await services.holdings.startPipeline({ householdId: s.householdId, holdingId: s.holdingId });
  await drain();
  return { app, s, services };
}

test('pipeline: an unchecked insurer fact is written as ida_wording extracted_unverified, sealed with its quote, shown with a label; an own value drops it', opts, async t => {
  const { app, s, services } = await world(t);
  const rows = await app.database.many('SELECT * FROM household_memory_facts WHERE holding_id = ? AND superseded_at IS NULL', [s.holdingId]);
  const ida = rows.filter(row => row.source_tier === 'ida_wording');
  assert.deepEqual(ida.map(row => [row.fact_key, row.status]), [['room_rent_limit', 'extracted_unverified']], 'own PDF has waiting_ped, so its unchecked insurer row is dropped');
  assert.equal(rows.some(row => row.fact_key === 'waiting_ped' && row.source_tier === 'own_pdf' && row.status === 'extracted_unverified'), true);
  assert.equal(await count(app, 'SELECT count(*) AS n FROM memory_conflicts WHERE household_id = ?', [s.householdId]), 0, 'an unchecked row never makes a conflict');
  // Raw column: sealed envelope, no plaintext quote, value or marker.
  for (const column of ['reference_ref_enc', 'value_enc']) {
    assert.match(ida[0][column], /^enc[0-9]+[.]/, column);
    assert.equal(ida[0][column].includes('co-payment'), false);
    assert.equal(ida[0][column].includes('500000'), false);
  }
  // The owner's read opens it: status, tier, quote and page from the sealed reference; the resolved fact says check with the insurer.
  const holding = await services.holdingPipelineRepository.getHolding({ householdId: s.householdId, holdingId: s.holdingId });
  const view = await services.holdings.facts({ holding });
  const room = view.facts.find(item => item.factKey === 'room_rent_limit');
  assert.deepEqual([room.status, room.sourceTier, room.checkWithInsurer], ['extracted_unverified', 'ida_wording', true]);
  assert.deepEqual([room.sources[0].tier, room.sources[0].status, room.sources[0].quote, room.sources[0].reference.pageNumber], ['ida_wording', 'extracted_unverified', QUOTE, 12]);
  // The memory document labels it by tier and status.
  const doc = await fetch(`${app.base}/api/v1/holdings/${s.holdingId}/memory-document`, { headers: { Authorization: `Bearer ${s.token}` } });
  const markdown = await doc.text();
  assert.equal(doc.status, 200, markdown);
  assert.match(markdown, /room rent limit per day\? INR 5,000 \(From the insurer's wording, not checked\) Check with the insurer\./);
});

test('database: the tier and status pairing accepts ida_wording extracted_unverified and still refuses user statuses on a machine tier', opts, async t => {
  const { app, s } = await world(t);
  const row = await app.database.one("SELECT * FROM household_memory_facts WHERE holding_id = ? AND source_tier = 'ida_wording' AND superseded_at IS NULL", [s.holdingId]);
  assert.equal(row.status, 'extracted_unverified');
  await assert.rejects(app.database.run("UPDATE household_memory_facts SET status = 'user_confirmed' WHERE id = ?", [row.id]));
});

test('erasure: revocation erases the unchecked insurer rows; deleting the holding erases them too', opts, async t => {
  const { app, s, services } = await world(t);
  const idaRows = () => count(app, "SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ? AND source_tier = 'ida_wording' AND status = 'extracted_unverified'", [s.householdId]);
  assert.equal(await idaRows(), 1);
  const grant = (await app.database.one('SELECT consent_grant_id FROM document_uploads WHERE id = ?', [s.documentId])).consent_grant_id;
  await services.consents.revoke({ grantId: grant, revokedByAdultId: s.adultId, reason: 'user_request' });
  assert.equal(await idaRows(), 0, 'revocation erased the unchecked insurer row');
  assert.equal(await count(app, 'SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ? AND reference_ref_enc IS NOT NULL', [s.householdId]), 0);

  const second = await world(t);
  assert.equal(await count(second.app, "SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ? AND source_tier = 'ida_wording' AND status = 'extracted_unverified'", [second.s.householdId]), 1);
  const deleted = await second.app.call(`/api/v1/documents/${second.s.documentId}`, { method: 'DELETE', token: second.s.token });
  assert.ok([200, 202].includes(deleted.status), JSON.stringify(deleted.data));
  assert.equal(await count(second.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ?', [second.s.householdId]), 0);
});

test('pipeline: the real reader over parsed FSS facts reaches the sealed reference with its quote, page and unchecked marker; the own PED wait wins', opts, async t => {
  const { app, s } = await world(t, createFssReferenceFacts({ port: stubPort([roomFact(), pedFact(), hiddenFact()]), repository: stubRepository, env: { ...ON, REFERENCE_DATA_ENABLED: 'true' } }));
  const rows = await app.database.many("SELECT * FROM household_memory_facts WHERE holding_id = ? AND source_tier = 'ida_wording' AND superseded_at IS NULL", [s.holdingId]);
  assert.deepEqual(rows.map(row => [row.fact_key, row.status]), [['room_rent_limit', 'extracted_unverified']]);
  const services = createBackendServices(app.database, { env: ON });
  const [memory] = (await services.holdingPipelineRepository.currentMemory({ householdId: s.householdId, holdingId: s.holdingId })).filter(row => row.tier === 'ida_wording');
  assert.equal(memory.reference.quote, 'Room rent is limited to INR 5,000 per day.');
  assert.equal(memory.reference.quotePage, 7);
  assert.equal(memory.reference.verificationStatus, 'extracted_unverified', 'the unchecked marker travels with the sealed reference');
  assert.equal(rows[0].reference_ref_enc.includes('Room rent'), false, 'sealed at rest');
});

test('refresh: a reviewed insurer row whose only change is the quote keeps its id, opens no conflict and keeps a resolved conflict resolved', opts, async t => {
  let quote = null;
  const reviewed = () => ({ factKey: 'copay_percent', value: { bp: 1000 }, origin: 'reference', refId: 'fss:f_copay', cacheKey: CACHE_KEY, version: 'W1', quote,
    reference: { source: 'fss', refId: 'fss:f_copay', versionId: 'v1', factId: 'f_copay', verificationStatus: 'independently_verified', evidence: [{ documentId: 'doc_synth_1', pageNumber: 12, sha256: SHA }], cacheKey: CACHE_KEY, quote, quotePage: quote ? 12 : null, origin: 'reference' } });
  const { app, s, services } = await world(t, { async forHolding() { return [reviewed()]; } });
  const current = () => app.database.many("SELECT id, source_tier, status FROM household_memory_facts WHERE holding_id = ? AND superseded_at IS NULL ORDER BY id", [s.holdingId]);
  const conflicts = () => app.database.many('SELECT id, resolution FROM memory_conflicts WHERE holding_id = ? ORDER BY id', [s.holdingId]);
  const before = await current();
  const ida = before.find(row => row.source_tier === 'ida_wording');
  assert.equal(ida.status, 'conflicting', 'differing own and reviewed insurer values are both held as conflicting');
  const openConflicts = await conflicts();
  assert.equal(openConflicts.length, 1, 'the schedule says 20%, the reviewed insurer reading says 10%');
  // The person resolves it, choosing the insurer reading.
  const holding = await services.holdingPipelineRepository.getHolding({ householdId: s.householdId, holdingId: s.holdingId });
  await services.holdings.resolveConflict({ holding, conflictId: openConflicts[0].id, adultId: s.adultId, body: { chosenFactId: ida.id } });
  const resolved = await conflicts();
  assert.notEqual(resolved[0].resolution, 'pending');
  const rowsAfterResolve = await current();
  // A refresh that only adds the quote.
  quote = QUOTE;
  const result = await services.holdings.collate({ householdId: s.householdId, holdingId: s.holdingId });
  assert.ok(result, 'collate ran');
  assert.deepEqual((await current()).map(row => row.id), rowsAfterResolve.map(row => row.id), 'no row was replaced');
  assert.deepEqual(await conflicts(), resolved, 'no conflict opened or reopened; the resolved one stays resolved');
  assert.equal((await current()).some(row => row.id === ida.id), true, 'the reviewed row keeps its id');
});
