// Deterministic chat answer path over the synthetic eval policy: honest unknown, clause-level windows, exclusion wording.
// Pure code, no database, no provider, synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildClauses } from '../src/features/policy-evidence/clauses.js';
import { syntheticStoredPages } from '../scripts/fixtures/synthetic-eval-policy.mjs';
import { buildDeterministicAnswer } from '../src/features/insurance-rules/chat-answer.js';
import { NOT_IN_DOCUMENTS_TEXT, clearsRelevanceFloor, contentTerms, expandQuery, selectClauseAnswer } from '../src/features/insurance-rules/clause-answer.js';

const set = JSON.parse(await readFile(new URL('../scripts/fixtures/synthetic-policy-questions.json', import.meta.url), 'utf8'));
const clauses = ['schedule', 'terms'].flatMap(kind => buildClauses(syntheticStoredPages(kind), { documentId: `doc-${kind}`, sourceVersion: 'v1' }).clauses
  .map(clause => ({ id: clause.clauseId, documentId: clause.documentId, page: clause.page, text: clause.text, kind: clause.kind, sectionPath: clause.sectionPath, blockIndexes: clause.blockIndexes })));

// What the chat turn does when no confirmed fact answers: pick the clause window or say unknown.
function answerFor(question) {
  const picked = selectClauseAnswer({ question, clauses });
  const hits = picked ? [{ ...picked.clause, window: picked.text, excluded: picked.excluded }] : [];
  const built = buildDeterministicAnswer({ intent: 'coverage_question', factKeys: [], facts: [], clauses: hits, searchedClauses: true });
  return { picked, built };
}

test('expected-unknown questions q081-q100: at least 18 of 20 are unknown with the fixed sentence and no source', () => {
  const unknown = set.questions.filter(item => Number(item.id.slice(1)) >= 81 && item.expectedAnswer === 'unknown');
  assert.equal(unknown.length, 20);
  const honest = unknown.filter(item => { const { picked, built } = answerFor(item.question); return picked === null && built.status === 'unknown' && built.text === NOT_IN_DOCUMENTS_TEXT; });
  assert.ok(honest.length >= 18, `only ${honest.length} of 20 were unknown`);
});

test('known questions: answered from a clause window of at most 300 characters, never a whole page', () => {
  const known = set.questions.filter(item => item.expectedAnswer !== 'unknown');
  let answered = 0;
  for (const item of known) {
    const { picked, built } = answerFor(item.question);
    if (!picked) continue;
    answered += 1;
    assert.ok(picked.text.length <= 300, `${item.id} window is ${picked.text.length} chars`);
    assert.ok(picked.clause.text.length > picked.text.length || picked.clause.text.split('\n').length === 1, `${item.id} pasted a whole page`);
    assert.equal(built.status, 'unknown', 'no confirmed fact: the status stays code-owned and the quote is labelled as printed wording');
    assert.match(built.text, /From your policy document|excludes this/);
    assert.ok(Number.isInteger(picked.page));
  }
  assert.ok(answered >= 70, `only ${answered} of ${known.length} known questions found a clause`);
});

test('the right clause: a few known questions land on their own sentence and page', () => {
  const expectations = { sum_insured: /Sum insured: Rs\. 5,00,000/, copay: /Co-payment: 10%/, policy_end: /Policy end date/ };
  for (const [id, pattern] of Object.entries(expectations)) {
    const item = set.questions.find(entry => entry.expectedFactKey === id);
    const { picked } = answerFor(item.question);
    assert.ok(picked, id);
    assert.match(picked.text, pattern, id);
    assert.equal(picked.page, item.expectedSource.page, id);
  }
});

test('exclusion: cosmetic surgery is answered as excluded and cited, through the synonym aesthetic too', () => {
  for (const question of ['Is cosmetic surgery covered?', 'Is aesthetic surgery covered?', 'Does the plan pay for plastic surgery?']) {
    const { picked, built } = answerFor(question);
    assert.ok(picked, question);
    assert.equal(picked.excluded, true);
    assert.equal(picked.page, 3);
    assert.match(built.text, /excludes this \(page 3\): Cosmetic or plastic surgery is excluded/);
  }
  assert.equal(answerFor('Is dental treatment covered?').picked.excluded, true);
});

test('block index and window context: a source keeps the block it came from', () => {
  const picked = selectClauseAnswer({ question: 'Is dental treatment covered?', clauses });
  assert.equal(picked.blockIndex, picked.clause.blockIndexes[1], 'second printed line of the exclusions page');
});

test('relevance floor and synonyms', () => {
  assert.deepEqual(contentTerms('What is the PED waiting period?').slice(0, 1), ['preexist']);
  assert.equal(clearsRelevanceFloor('Is there co-pay?', 'Co-payment: 10% of every admissible claim'), true);
  assert.equal(clearsRelevanceFloor('What is the co-payment for senior citizens above 60?', 'Co-payment: 10% of every admissible claim'), false);
  assert.equal(clearsRelevanceFloor('How is the weather?', 'Co-payment: 10%'), false);
  assert.match(expandQuery('Is cosmetic surgery covered?'), /aesthetic/);
  assert.equal(selectClauseAnswer({ question: 'What is this?', clauses }), null);
});
