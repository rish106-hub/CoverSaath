import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClauses, investigate } from '../src/features/policy-evidence/index.js';
import { INVESTIGATE_SCHEMA, STRUCTURING_INSTRUCTIONS, EVIDENCE_INVESTIGATE_TASK } from '../src/features/ai-analysis/structuring-contract.js';
import { validateAnswer } from '../src/contracts/index.js';

// Synthetic policy only. One large table clause mixes "At Actuals" (no limit) with "Not Covered" items, so the keyword
// classifier labels the whole clause 'exclusion' even though the finding quoted from it is a plain benefit.
const stored = { pages: [
  { page: 6, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Benefits Table' },
    { tag: 'paragraph', text: 'Room Rent At Actuals. Ambulance Rs. 2,000 per claim. Cosmetic procedures Not Covered.' },
  ] },
  { page: 9, status: 'stored', blocks: [
    { tag: 'section-title', text: 'Sub-limits' },
    { tag: 'paragraph', text: 'Cataract surgery is capped at Rs. 40,000 per eye.' },
  ] },
] };
const clauses = buildClauses(stored, { documentId: 'doc-1', sourceVersion: 'v1' }).clauses;
const byPage = page => clauses.find(clause => clause.page === page);
const item = (page, quote, extra = {}) => ({ clause_ids: [byPage(page).clauseId], quote, subject: 'room rent', conditions: [], exceptions: [], ...extra });
const call = first => async ({ task }) => ({ json: task === 'policy_evidence_investigate' ? first : { overrides: [] }, usage: { inputTokens: 1, outputTokens: 1 } });
const ask = (findings, question = 'What is the room rent and ambulance cover?') => investigate({ question, clauses, consentCheck: async () => {}, call: call({ findings }) });

test('F-B setup: the benefits table really is labelled exclusion by the keyword classifier', () => {
  assert.equal(byPage(6).kind, 'exclusion');
});

test('F-B: effect "covers" buckets a finding as covered even when the cited clause is labelled exclusion', async () => {
  const { answer } = await ask([item(6, 'Room Rent At Actuals', { effect: 'covers' })]);
  assert.equal(answer.covered.length, 1);
  assert.equal(answer.limited_or_excluded.length, 0);
  assert.equal(answer.covered[0].effect, 'covers');
  assert.deepEqual(validateAnswer(answer), []);
});

test('F-B: effect limits and excludes land in limited_or_excluded whatever the clause label', async () => {
  const { answer } = await ask([
    item(6, 'Ambulance Rs. 2,000 per claim', { effect: 'limits' }),
    item(6, 'Cosmetic procedures Not Covered', { effect: 'excludes' }),
    item(9, 'capped at Rs. 40,000 per eye', { effect: 'limits' }),
  ]);
  assert.equal(answer.limited_or_excluded.length, 3);
  assert.equal(answer.covered.length, 0);
});

test('F-B: effect conditions goes to conditions; informs is neither covered nor limited', async () => {
  const { answer } = await ask([
    item(9, 'capped at Rs. 40,000 per eye', { effect: 'conditions' }),
    item(6, 'Room Rent At Actuals', { effect: 'informs' }),
  ]);
  assert.equal(answer.covered.length, 0);
  assert.equal(answer.limited_or_excluded.length, 0);
  assert.ok(answer.conditions.some(entry => entry.text === 'capped at Rs. 40,000 per eye'));
  assert.ok(answer.conditions.some(entry => entry.text === 'Room Rent At Actuals' && entry.effect === 'informs'));
});

test('F-B: missing, unknown or non-string effect falls back to conditions, never covered', async () => {
  for (const effect of [undefined, null, 'covered', 'COVERS', 'proven', 7, { x: 1 }]) {
    const { answer } = await ask([item(6, 'Room Rent At Actuals', effect === undefined ? {} : { effect })]);
    assert.equal(answer.covered.length, 0, `effect ${JSON.stringify(effect)}`);
    assert.equal(answer.limited_or_excluded.length, 0);
    assert.ok(answer.conditions.some(entry => entry.text === 'Room Rent At Actuals' && entry.effect === 'conditions'));
  }
});

test('F-B: contract carries effect in the schema enum and the instructions', () => {
  const props = INVESTIGATE_SCHEMA.properties.findings.items.properties;
  assert.deepEqual(props.effect.enum, ['covers', 'limits', 'excludes', 'conditions', 'informs']);
  assert.ok(INVESTIGATE_SCHEMA.properties.findings.items.required.includes('effect'));
  assert.match(STRUCTURING_INSTRUCTIONS[EVIDENCE_INVESTIGATE_TASK], /effect/);
});

test('F-C: a subject named in no read clause adds a "not named in the documents read" unknown', async () => {
  const { answer } = await ask([item(9, 'capped at Rs. 40,000 per eye', { effect: 'limits' })], 'Is glaucoma treatment covered?');
  const unknown = answer.unknowns.find(text => /not named/.test(text));
  assert.ok(unknown, 'unknown present');
  assert.match(unknown, /glaucoma/);
  assert.match(unknown, /not uploaded|full policy wording/);
});

test('F-C: a subject present in a read clause adds no such unknown (plurals and case tolerated)', async () => {
  const { answer } = await ask([item(9, 'capped at Rs. 40,000 per eye', { effect: 'limits' })], 'Are CATARACT surgeries covered?');
  assert.equal(answer.unknowns.some(text => /not named/.test(text)), false);
});

test('F-C: also fires when the model returns no findings; generic words are not subjects', async () => {
  const { answer } = await ask([], 'Does my policy cover the treatment?');
  assert.equal(answer.unknowns.some(text => /not named/.test(text)), false, 'only generic words');
  const second = await ask([], 'Does my policy cover dialysis?');
  assert.ok(second.answer.unknowns.some(text => /not named/.test(text) && /dialysis/.test(text)));
});

test('F-B review: a covers label on a quote that states a restriction is routed to conditions, not covered', async () => {
  const { answer } = await ask([item(6, 'Cosmetic procedures Not Covered', { effect: 'covers' }), item(9, 'capped at Rs. 40,000 per eye', { effect: 'covers' })]);
  assert.equal(answer.covered.length, 0);
  assert.equal(answer.conditions.filter(entry => entry.effect === 'conditions').length, 2);
});

test('F-B review: a covers finding is still swept and an override moves it to limited', async () => {
  const seen = [];
  const sweepCall = async ({ task, payload }) => {
    seen.push(task);
    if (task === 'policy_evidence_investigate') return { json: { findings: [item(6, 'Room Rent At Actuals', { effect: 'covers' })] } };
    return { json: { overrides: [{ clause_ids: [byPage(9).clauseId], quote: 'capped at Rs. 40,000 per eye', effect: 'limits', target_finding_ids: ['f1'] }] } };
  };
  const { answer } = await investigate({ question: 'What is the room rent?', clauses, consentCheck: async () => {}, call: sweepCall });
  assert.ok(seen.includes('policy_evidence_override_sweep'));
  assert.equal(answer.covered.length, 1);
  assert.equal(answer.limited_or_excluded.length, 1);
  assert.equal(answer.state, 'conditional');
});

test('F-B review: same quote with conflicting effects keeps both', async () => {
  const { answer } = await ask([item(6, 'Room Rent At Actuals', { effect: 'covers' }), item(6, 'Room Rent At Actuals', { effect: 'excludes' })]);
  assert.equal(answer.covered.length, 1);
  assert.equal(answer.limited_or_excluded.length, 1);
});

test('F-C review: terms come from the gated question, so redacted names are not echoed', async () => {
  const { answer } = await investigate({ question: 'Is dialysis covered for Priya Examplesingh?', clauses, consentCheck: async () => {}, knownIdentifiers: [{ kind: 'NAME', value: 'Priya Examplesingh' }], call: call({ findings: [] }) });
  const text = answer.unknowns.join(' ');
  assert.match(text, /dialysis/);
  assert.match(text, /not named/);
  assert.doesNotMatch(text, /priya|examplesingh/i);
});
