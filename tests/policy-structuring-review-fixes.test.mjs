import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/features/coverage-analysis/policy-parameter-registry.js';
import { extractChunks, reconcile, validateExtractedItems } from '../src/features/policy-structuring/index.js';

// Fixes from the independent W2-W4 review. Synthetic data only.

const chunk = Object.freeze({
  id: 'p1-b0', page: 1, blockIndexes: [0], kind: 'text', title: 'Schedule',
  text: 'Initial waiting period: 30 days from the first policy start date.',
});

test('a value that only normalises equal to its quote is stored as the verbatim quote', () => {
  const quote = 'Initial waiting period: 30 days from the first policy start date.';
  const { accepted } = validateExtractedItems([{
    chunk_id: 'p1-b0', page: 1, block_index: 0, subject: 'policy', registry_key: 'f.initial_waiting_period',
    value: '30 days except for accidents', evidence_quote: quote,
  }], { chunk, registryVersion });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].value.text, quote);
  assert.equal(accepted[0].note.valueSource, 'quote');
  const verbatim = validateExtractedItems([{
    chunk_id: 'p1-b0', page: 1, block_index: 0, subject: 'policy', registry_key: 'f.initial_waiting_period',
    value: '30 days', evidence_quote: quote,
  }], { chunk, registryVersion });
  assert.equal(verbatim.accepted[0].value.text, '30 days');
  assert.equal(verbatim.accepted[0].note.valueSource, 'value');
});

for (const code of ['reservation_exceeded', 'budget_refused']) {
  test(`a ${code} gateway error stops every further paid call for the document`, async () => {
    const chunks = Array.from({ length: 9 }, (_, index) => ({
      id: `p${index + 1}-b0`, page: index + 1, blockIndexes: [0], kind: 'text', title: null, text: `Room rent limit: ${index + 1},000 per day.`,
    }));
    let calls = 0;
    const call = async () => {
      calls += 1;
      throw Object.assign(new Error('stop'), { code });
    };
    const extraction = await extractChunks({ chunks, registryVersion, call, consentCheck: () => {}, limits: { maxChunksPerCall: 1 } });
    assert.equal(calls, 1);
    assert.equal(extraction.budgetStopped, true);
    assert.ok(Object.values(extraction.chunkOutcomes).every(outcome => outcome.status === 'skipped' && outcome.reason === 'budget_stop'));
    assert.equal(Object.keys(extraction.chunkOutcomes).length, chunks.length);
  });
}

test('reconcile makes no paid call after a budget stop, and deterministic conflicts stand', async () => {
  const item = (value, page) => ({
    kind: 'registry', parameterKey: 'f.ped_waiting_period', valueType: 'duration',
    value: { text: value, normalized: null, subject: 'policy' }, evidenceQuote: `PED waiting period: ${value}`,
    page, blockIndex: 0, chunkId: `p${page}-b0`, subjectInSource: false, state: 'extracted_unverified', note: {},
  });
  let calls = 0;
  const result = await reconcile({
    accepted: [item('3 years', 1), item('36 months', 2)], proposals: [],
    call: async () => { calls += 1; return { json: { conflicts: [] } }; }, consentCheck: () => {}, budgetStopped: true,
  });
  assert.equal(calls, 0);
  assert.ok(result.skipped.some(entry => entry.reason === 'budget_stop'));
  assert.ok(result.conflicts.some(conflict => conflict.target.key === 'f.ped_waiting_period'));
});
