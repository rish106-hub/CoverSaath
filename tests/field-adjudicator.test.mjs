import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFields, normalizeValue } from '../src/features/ai-analysis/eval-extractor.js';
import { classify, scoreFields } from '../src/features/ai-analysis/eval-scorer.js';
import { adjudicate, selectDisputes, acceptVerdict, buildRequest } from '../src/features/ai-analysis/field-adjudicator.js';

// Synthetic only: no real person, insurer record or policy number.
const table = rows => `<table>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</table>`;
const pages = [
  { page: 1, blocks: [
    { tag: 'paragraph', text: 'Your Health insurance policy reference no 1111111111 is confirmed.' },
    { tag: 'image', text: 'Model-written description: Policy Number 9999999999' },
  ] },
  { page: 2, blocks: [{ tag: 'table', text: table([['Policy Number', '1111111112'], ['Room Rent', 'At Actuals']]) }] },
];
const grant = { granted: true, recipient: 'gemini', documentId: 'synthetic-doc' };

test('extractor flags disagreeing signals as conflicting and ignores image descriptions', () => {
  const { policy_number: field } = extractFields(pages, ['policy_number']);
  assert.equal(field.state, 'conflicting');
  assert.equal(field.value, '1111111112');
  assert.equal(field.second.value, '1111111111');
});

test('no disagreement means no dispute and no provider call', async () => {
  const agreeing = extractFields([{ page: 1, blocks: [{ tag: 'table', text: table([['Room Rent', 'At Actuals']]) }] }], ['room_rent_limit']);
  const disputes = selectDisputes(agreeing, {});
  assert.deepEqual(disputes, []);
  let calls = 0;
  const result = await adjudicate({ disputes, pages, grant, call: async () => { calls += 1; return { json: { results: [] } }; } });
  assert.equal(calls, 0);
  assert.equal(result.calls, 0);
});

test('adjudicator refuses to run without a document-specific Gemini grant', async () => {
  for (const bad of [undefined, { granted: false, recipient: 'gemini', documentId: 'd' }, { granted: true, recipient: 'sarvam', documentId: 'd' }, { granted: true, recipient: 'gemini' }]) {
    await assert.rejects(adjudicate({ disputes: [], pages, grant: bad, call: async () => ({}) }), error => error.code === 'ADJUDICATOR_CONSENT');
  }
});

test('a missing field is only disputed when a page hint says it is present', () => {
  const extracted = extractFields(pages, ['co_payment', 'room_rent_limit']);
  assert.deepEqual(selectDisputes(extracted, {}), []);
  assert.deepEqual(selectDisputes(extracted, { co_payment: 2 }).map(item => item.field), ['co_payment']);
});

test('verdicts whose evidence quote is not in the supplied snippets are rejected', async () => {
  const disputes = selectDisputes(extractFields(pages, ['policy_number']), {});
  const request = buildRequest(disputes, pages);
  assert.equal(acceptVerdict({ field: 'policy_number', verdict: 'a', value: 'x', evidence_quote: 'invented text', page: 2 }, request).accepted, false);
  const good = acceptVerdict({ field: 'policy_number', verdict: 'a', value: 'x', evidence_quote: 'Policy Number | 1111111112', page: 2 }, request);
  assert.equal(good.accepted, true);
  assert.equal(good.state, 'extracted_unverified');
  assert.equal(good.value, '1111111112');
});

test('negative control: unknown verdict stays conflicting and never supplies a value', async () => {
  const disputes = selectDisputes(extractFields(pages, ['policy_number']), {});
  const result = await adjudicate({
    disputes, pages, grant,
    call: async () => ({ json: { results: [{ field: 'policy_number', verdict: 'unknown', value: '', evidence_quote: '', page: 0 }] }, usage: { inputTokens: 10, outputTokens: 2 } }),
  });
  assert.equal(result.calls, 1);
  assert.equal(result.results[0].accepted, false);
  assert.equal(result.results[0].state, 'conflicting');
  assert.equal(result.results[0].value, null);
});

test('call count is capped per document', async () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ field: `f${index}`, reason: 'conflicting', a: { value: 'x', page: 1, blockIndex: 0 }, b: { value: 'y', page: 1, blockIndex: 0 } }));
  let calls = 0;
  const result = await adjudicate({ disputes: many, pages, grant, call: async () => { calls += 1; return { json: { results: [] } }; } });
  assert.equal(calls, 2);
  assert.equal(result.skipped.length, 24);
});

test('scorer classifies match, mismatch, missing and hallucinated; unconfirmed fields are excluded', () => {
  assert.equal(classify('15,00,000', '1500000'), 'match');
  assert.equal(classify('17-06-2026', '2026-06-17'), 'match');
  assert.equal(classify('A', 'B'), 'mismatch');
  assert.equal(classify('A', null), 'missing');
  assert.equal(classify('unknown', 'B'), 'hallucinated');
  assert.equal(classify('A', 'A', () => false), 'hallucinated');
  const golden = { fields: { policy_number: { value: '1111111112', confirmed: true }, room_rent_limit: { value: 'x', confirmed: false } } };
  const score = scoreFields(golden, extractFields(pages, ['policy_number', 'room_rent_limit']));
  assert.deepEqual(Object.keys(score.fields), ['policy_number']);
  assert.equal(score.summary.criticalAccuracy, 1);
  assert.equal(normalizeValue('Rs. 5,000'), '5000');
});
