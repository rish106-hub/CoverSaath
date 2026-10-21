import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { sectionDocument } from '../src/features/policy-structuring/sectioner.js';
import { extractChunks } from '../src/features/policy-structuring/extractor.js';
import { decideStates, reconcile } from '../src/features/policy-structuring/reconciler.js';
import { buildCoverageReport, scoreStructuring } from '../src/features/policy-structuring/coverage-report.js';

// Synthetic only: fictional insurer, members and numbers; the provider is a fake.
const table = rows => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
const pages = [
  { page: 1, blocks: [
    { tag: 'header', text: 'Zephyr Mutual Health (synthetic)' },
    { tag: 'headline', text: 'Schedule of Benefits' },
    { tag: 'paragraph', text: 'Sum Insured: Rs. 5,00,000. PED waiting period: 3 Years.' },
    { tag: 'table', text: table([['Benefit', 'Limit'], ['Wellness Points', 'Quillon Rewards 250']]) },
  ] },
  { page: 2, blocks: [
    { tag: 'section-title', text: 'Waiting Periods' },
    { tag: 'paragraph', text: 'Pre-existing diseases: 36 / 24 / 12 months depending on plan.' },
    { tag: 'image', text: 'Model description of a chart.' },
  ] },
  { page: 3, blocks: [{ tag: 'paragraph', text: 'Grievance contact: Fennimore Desk, fictional office.' }] },
  { page: 4, blocks: [{ tag: 'paragraph', text: 'Room rent: Rs. 4,000 per day.' }] },
];
const sectioned = sectionDocument(pages);
const FIXTURE_TEXT = ['Zephyr', 'Sum Insured', '5,00,000', 'Quillon', 'Wellness', 'Pre-existing', 'Fennimore', 'Room rent', '36 / 24', '3 Years'];

const answers = {
  'p1-b1': chunk => [
    { chunk_id: chunk.chunk_id, registry_key: 'd.sum_insured', value: 'Rs. 5,00,000', subject: 'policy', evidence_quote: 'Sum Insured: Rs. 5,00,000', page: 1, block_index: 2 },
    { chunk_id: chunk.chunk_id, registry_key: 'f.ped_waiting_period', value: '3 Years', subject: 'policy', evidence_quote: 'PED waiting period: 3 Years.', page: 1, block_index: 2 },
    { chunk_id: chunk.chunk_id, registry_key: 'd.sum_insured', value: 'Rs. 50,00,000', subject: 'policy', evidence_quote: 'Sum Insured: Rs. 50,00,000', page: 1, block_index: 2 },
  ],
  'p1-b3': chunk => [{ chunk_id: chunk.chunk_id, proposed: { proposed_key: 'wellness_points', category: 'e', label: 'Wellness points' }, value: 'Quillon Rewards 250', subject: 'policy', evidence_quote: 'Wellness Points | Quillon Rewards 250', page: 1, block_index: 3 }],
  'p2-b0': chunk => [{ chunk_id: chunk.chunk_id, registry_key: 'f.ped_waiting_period', value: '36 / 24 / 12 months', subject: 'policy', evidence_quote: '36 / 24 / 12 months depending on plan', page: 2, block_index: 1 }],
  'p3-b0': () => [],
};

async function journey() {
  const call = async ({ payload }) => {
    if (payload.chunks.some(chunk => chunk.chunk_id === 'p4-b0')) throw Object.assign(new Error('x'), { code: 'PROVIDER_TIMEOUT' });
    return { json: { items: payload.chunks.flatMap(chunk => answers[chunk.chunk_id](chunk)) }, usage: { inputTokens: 40, outputTokens: 10 } };
  };
  const consentCheck = () => {};
  const extraction = await extractChunks({ chunks: sectioned.chunks, registryVersion, call, consentCheck, limits: { maxChunksPerCall: 4 } });
  const reconciliation = await reconcile({ ...extraction, call: async () => ({ json: { conflicts: [] }, usage: { inputTokens: 7, outputTokens: 3 } }), consentCheck });
  return { extraction, reconciliation, decisions: decideStates({ accepted: extraction.accepted, conflicts: reconciliation.conflicts }) };
}

test('full fake journey accounts for every chunk with counts only', async () => {
  const { extraction, reconciliation, decisions } = await journey();
  const report = buildCoverageReport({ sectioned, extraction, reconciliation, commit: { replayed: false, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 0, proposals: 1 } });
  assert.deepEqual(report.chunks, { total: 5, stored: 2, proposed: 1, skipped: 2, unaccounted: 0 });
  assert.deepEqual(report.perChunk, [
    { id: 'p1-b1', page: 1, outcome: 'stored' },
    { id: 'p1-b3', page: 1, outcome: 'proposed' },
    { id: 'p2-b0', page: 2, outcome: 'stored' },
    { id: 'p3-b0', page: 3, outcome: 'skipped', reason: 'none_returned' },
    { id: 'p4-b0', page: 4, outcome: 'skipped', reason: 'timeout' },
  ]);
  assert.deepEqual(report.skippedReasons, { none_returned: 1, timeout: 1 });
  assert.deepEqual(report.dropped, { boilerplate: 1, model_description: 1 });
  assert.deepEqual(report.items, { accepted: 3, proposals: 1, rejected: 1, rejectedReasons: { quote_not_in_chunk: 1 } });
  assert.deepEqual(report.conflicts, { total: 1, deterministic: 1, reconciler: 0 });
  assert.equal(report.calls, 3);
  assert.deepEqual(report.usage, { inputTokens: 47, outputTokens: 13 });
  assert.deepEqual(report.commit, { replayed: false, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 0, proposals: 1 });
  assert.deepEqual(decisions.map(decision => [decision.parameterKey, decision.state]), [['d.sum_insured', 'extracted_unverified'], ['f.ped_waiting_period', 'conflicting']]);
  const json = JSON.stringify(report);
  for (const fragment of FIXTURE_TEXT) assert.ok(!json.includes(fragment), fragment);
});

test('chunks without an outcome are counted as unaccounted', () => {
  const report = buildCoverageReport({ sectioned, extraction: { accepted: [], proposals: [], rejected: [], chunkOutcomes: { 'p1-b1': { status: 'skipped', reason: 'call_cap' } } }, reconciliation: { conflicts: [] } });
  assert.equal(report.chunks.unaccounted, 4);
  assert.equal(report.chunks.skipped, 1);
  assert.equal(report.commit, undefined);
});

test('coverage tallies keep hostile reason names as data properties', () => {
  const report = buildCoverageReport({
    sectioned: { chunks: [{ id: 'synthetic', page: 1 }], dropped: [{ reason: '__proto__' }] },
    extraction: { accepted: [], proposals: [], rejected: [], chunkOutcomes: { synthetic: { status: 'skipped', reason: '__proto__' } } },
    reconciliation: { conflicts: [] },
  });
  assert.equal(Object.hasOwn(report.skippedReasons, '__proto__'), true);
  assert.equal(report.skippedReasons.__proto__, 1);
  assert.equal(report.dropped.__proto__, 1);
});

test('scoreStructuring reports recall, hallucination rate and conflict recall', async () => {
  const { extraction, reconciliation } = await journey();
  const golden = { structuring: {
    expectedKeys: [{ key: 'd.sum_insured', page: 1 }, { key: 'f.ped_waiting_period' }, { key: 'h.intimation_deadline' }, { key: 'd.sum_insured', page: 9 }],
    expectedConflicts: [{ id: 'ped', key: 'f.ped_waiting_period' }, { id: 'room', key: 'd.room_rent_limit' }],
  } };
  assert.deepEqual(scoreStructuring(golden, { extraction, reconciliation }), {
    keyRecall: 0.5, hallucinationRate: 1 / 5, conflictRecall: 0.5,
    missingKeys: ['h.intimation_deadline', 'd.sum_insured'], foundConflicts: ['ped'],
  });
  assert.deepEqual(scoreStructuring({}, {}), { keyRecall: null, hallucinationRate: 0, conflictRecall: null, missingKeys: [], foundConflicts: [] });
});
