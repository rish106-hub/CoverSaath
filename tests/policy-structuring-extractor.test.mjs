import test from 'node:test';
import assert from 'node:assert/strict';
import { POLICY_PARAMETER_REGISTRY_VERSION as registryVersion } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { EXTRACTION_SCHEMA, extractChunks, registryCatalog, STRUCTURING_LIMITS } from '../src/modules/policy-structuring/extractor.js';

// Synthetic only: fictional insurer and numbers. `call` is a fake provider.
const chunk = (id, page, text, blockIndexes = [0]) => ({ id, page, blockIndexes, kind: 'text', title: null, text });
const chunks = Array.from({ length: 10 }, (_, at) => chunk(`p${at + 1}-b0`, at + 1, `Sum Insured: Rs. ${at + 1},00,000 under Zephyr Mutual Health (synthetic).`));
const sumItem = c => ({ chunk_id: c.id, registry_key: 'd.sum_insured', value: c.text.match(/Rs\. [\d,]+/)[0], subject: 'policy', evidence_quote: c.text.match(/Sum Insured: Rs\. [\d,]+/)[0], page: c.page, block_index: 0 });

function fakeCall(respond) {
  const log = [];
  const call = async request => {
    log.push(request);
    return respond(request, log.length);
  };
  return { call, log };
}
const echo = ({ payload }) => ({ json: { items: payload.chunks.map(c => sumItem({ id: c.chunk_id, page: c.page, text: c.text })) }, usage: { inputTokens: 100, outputTokens: 20 } });
const consent = () => { const check = () => { check.count += 1; }; check.count = 0; return check; };

test('registry catalog lists only model-extractable keys and the schema has no state field', () => {
  const catalog = registryCatalog(registryVersion);
  assert.ok(catalog.some(entry => entry.key === 'd.sum_insured' && entry.valueType === 'money'));
  assert.ok(!catalog.some(entry => entry.key === 'a.contract_and_member_identifiers'));
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['key', 'label', 'valueType']);
  assert.ok(!('state' in EXTRACTION_SCHEMA.properties.items.items.properties));
  assert.throws(() => registryCatalog('nope'), { code: 'STRUCTURING_INPUT_INVALID' });
});

test('batches by chunk count and char limit, checks consent before every call, accounts every chunk', async () => {
  const { call, log } = fakeCall(echo);
  const consentCheck = consent();
  const result = await extractChunks({ chunks, registryVersion, call, consentCheck, limits: { maxChunksPerCall: 4 } });
  assert.deepEqual(log.map(request => request.payload.chunks.length), [4, 4, 2]);
  assert.equal(consentCheck.count, 3);
  assert.equal(result.calls, 3);
  assert.deepEqual(result.usage, { inputTokens: 300, outputTokens: 60 });
  assert.equal(result.accepted.length, 10);
  assert.ok(chunks.every(c => result.chunkOutcomes[c.id].status === 'extracted'));
  assert.ok(log.every(request => !JSON.stringify(request.system).includes('Zephyr')));
  const byChars = fakeCall(echo);
  await extractChunks({ chunks, registryVersion, call: byChars.call, consentCheck: consent(), limits: { maxCharsPerCall: chunks[0].text.length * 3 } });
  assert.ok(byChars.log.every(request => request.payload.chunks.length <= 3));
});

test('call cap and token cap skip the remaining chunks with reasons', async () => {
  const capped = fakeCall(echo);
  const byCalls = await extractChunks({ chunks, registryVersion, call: capped.call, consentCheck: consent(), limits: { maxChunksPerCall: 2, maxCallsPerDocument: 2 } });
  assert.equal(capped.log.length, 2);
  assert.deepEqual(chunks.slice(4).map(c => byCalls.chunkOutcomes[c.id]), Array(6).fill({ status: 'skipped', reason: 'call_cap' }));
  const estimated = fakeCall(echo);
  const perChunk = Math.ceil(chunks[0].text.length / 4);
  const byEstimate = await extractChunks({ chunks, registryVersion, call: estimated.call, consentCheck: consent(), limits: { maxChunksPerCall: 1, maxInputTokensPerDocument: 100 + perChunk - 1 } });
  assert.equal(estimated.log.length, 1);
  assert.equal(byEstimate.chunkOutcomes[chunks[1].id].reason, 'token_cap');
  const reported = fakeCall(() => ({ json: { items: [] }, usage: { inputTokens: 10, outputTokens: 999 } }));
  const byUsage = await extractChunks({ chunks, registryVersion, call: reported.call, consentCheck: consent(), limits: { maxChunksPerCall: 5, maxOutputTokensPerDocument: 500 } });
  assert.equal(reported.log.length, 1);
  assert.deepEqual(chunks.slice(5).map(c => byUsage.chunkOutcomes[c.id].reason), Array(5).fill('token_cap'));
  assert.equal(byUsage.chunkOutcomes[chunks[0].id].reason, 'none_returned');
});

test('a throwing consent check aborts with no further calls', async () => {
  const { call, log } = fakeCall(echo);
  let checks = 0;
  const consentCheck = () => { checks += 1; if (checks === 2) throw Object.assign(new Error('revoked'), { code: 'CONSENT_REVOKED' }); };
  await assert.rejects(extractChunks({ chunks, registryVersion, call, consentCheck, limits: { maxChunksPerCall: 2 } }), { code: 'CONSENT_REVOKED' });
  assert.equal(log.length, 1);
});

test('provider error, timeout and malformed JSON skip only their batch and continue', async () => {
  const { call, log } = fakeCall((request, n) => {
    if (n === 1) throw Object.assign(new Error('boom'), { code: 'ADJUDICATOR_PROVIDER' });
    if (n === 2) throw Object.assign(new Error('slow'), { name: 'TimeoutError' });
    if (n === 3) return { json: 'not json', usage: {} };
    if (n === 4) throw Object.assign(new Error('slow'), { code: 'PROVIDER_TIMEOUT' });
    return echo(request);
  });
  const result = await extractChunks({ chunks, registryVersion, call, consentCheck: consent(), limits: { maxChunksPerCall: 2 } });
  assert.equal(log.length, 5);
  assert.equal(result.calls, 5);
  assert.deepEqual(chunks.map(c => result.chunkOutcomes[c.id].reason ?? result.chunkOutcomes[c.id].status),
    ['provider_error', 'provider_error', 'timeout', 'timeout', 'malformed_response', 'malformed_response', 'timeout', 'timeout', 'extracted', 'extracted']);
});

test('unknown chunk ids, item cap, duplicates and overflow proposals', async () => {
  const [first, second] = chunks;
  const proposed = { chunk_id: first.id, proposed: { proposed_key: 'synthetic_floater_note', category: 'unassigned', label: 'Floater note' }, value: 'Zephyr Mutual Health', subject: 'policy', evidence_quote: 'Zephyr Mutual Health (synthetic)', page: 1, block_index: 0 };
  const { call } = fakeCall(() => ({ json: { items: [
    sumItem(first), sumItem(first), { ...sumItem(first), extra: 'ignored' },
    { ...sumItem(first), chunk_id: 'p99-b0' }, 'junk', proposed,
    ...Array.from({ length: 4 }, () => ({ ...sumItem(second), evidence_quote: 'not in text' })),
  ] }, usage: { inputTokens: 1, outputTokens: 1 } }));
  const result = await extractChunks({ chunks: [first, second], registryVersion, call, consentCheck: consent(), limits: { maxItemsPerChunk: 3 } });
  assert.equal(result.accepted.length, 1);
  assert.deepEqual(result.proposals.map(item => item.proposedKey), []);
  const reasons = result.rejected.map(entry => entry.reason).sort();
  // chunk 1: three duplicates kept as one, the proposal is the 4th item and hits the cap of 3.
  assert.deepEqual(reasons, ['item_cap', 'item_cap', 'not_object', 'quote_not_in_chunk', 'quote_not_in_chunk', 'quote_not_in_chunk', 'unknown_chunk']);
  assert.ok(result.rejected.every(entry => entry.chunkId === null || chunks.some(c => c.id === entry.chunkId)));
  assert.deepEqual(result.chunkOutcomes[second.id], { status: 'no_items', reason: 'all_items_rejected' });
  assert.equal(result.rawItems, 10);
  const roomy = fakeCall(() => ({ json: { items: [sumItem(first), proposed] }, usage: {} }));
  const withProposal = await extractChunks({ chunks: [first, second], registryVersion, call: roomy.call, consentCheck: consent() });
  assert.deepEqual(withProposal.proposals.map(item => [item.proposedKey, item.category]), [['synthetic_floater_note', 'unassigned']]);
  assert.deepEqual(withProposal.chunkOutcomes[second.id], { status: 'no_items', reason: 'none_returned' });
});

test('chunk text travels only in the payload; oversize chunks are skipped; inputs are validated', async () => {
  const { call, log } = fakeCall(echo);
  const big = chunk('p20-b0', 20, 'y'.repeat(STRUCTURING_LIMITS.maxCharsPerCall + 1));
  const result = await extractChunks({ chunks: [chunks[0], big], registryVersion, call, consentCheck: consent() });
  assert.deepEqual(result.chunkOutcomes[big.id], { status: 'skipped', reason: 'chunk_too_large' });
  assert.equal(log.length, 1);
  assert.ok(!log[0].system.includes(chunks[0].text));
  assert.equal(log[0].payload.chunks[0].text, chunks[0].text);
  await assert.rejects(extractChunks({ chunks, registryVersion, call }), { code: 'STRUCTURING_INPUT_INVALID' });
  await assert.rejects(extractChunks({ chunks, registryVersion, consentCheck: consent() }), { code: 'STRUCTURING_INPUT_INVALID' });
  await assert.rejects(extractChunks({ chunks: [chunks[0], chunks[0]], registryVersion, call, consentCheck: consent() }), { code: 'STRUCTURING_INPUT_INVALID' });
});
