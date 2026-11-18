// A benefit line that quotes the sum insured is a limit, not schedule content; a question with several topics is answered topic by topic.
// Pure code, synthetic wording only (no real policy text).
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyClause, looksLikeSchedule } from '../src/features/policy-evidence/clauses.js';
import { selectClauseAnswer, selectClauseAnswers, splitTopics } from '../src/features/insurance-rules/clause-answer.js';

test('a benefit line that mentions the sum insured stays readable (limit), a schedule block does not', () => {
  const room = 'Room rent: up to 1% of the Sum Insured per day for a single private room.';
  assert.equal(classifyClause('Room rent', room), 'limit');
  assert.equal(looksLikeSchedule('Room rent', room), false);
  const bonus = 'Cumulative bonus: 10% of the Basic Sum Insured, maximum up to 100%.';
  assert.equal(looksLikeSchedule('Cumulative bonus', bonus), false);
  assert.equal(looksLikeSchedule('Policy Schedule', 'Policy Schedule\nPolicy number: TEST-1\nSum insured Rs 5,00,000'), true);
  assert.equal(looksLikeSchedule(null, 'Sum insured Rs 5,00,000\nPremium Rs 12,000'), true);
});

const clauses = [
  { id: 'c1', documentId: 'd', page: 4, text: 'Room Rent At Actuals for every insured person.', kind: 'limit', sectionPath: [], blockIndexes: [0] },
  { id: 'c2', documentId: 'd', page: 6, text: 'Joint replacement surgery is covered after the waiting period.', kind: 'benefit', sectionPath: [], blockIndexes: [0] },
  { id: 'c3', documentId: 'd', page: 9, text: 'Cosmetic treatment is excluded.', kind: 'exclusion', sectionPath: [], blockIndexes: [0] },
];

test('a question with several topics is split, and each topic gets its own window', () => {
  assert.deepEqual(splitTopics('What is the room rent limit, and is joint replacement covered?'), ['What is the room rent limit', 'is joint replacement covered']);
  const picks = selectClauseAnswers({ question: 'What is the room rent limit, and is joint replacement covered?', clauses });
  assert.deepEqual(picks.map(pick => pick.clause.id), ['c1', 'c2']);
  assert.deepEqual(picks.map(pick => pick.page), [4, 6]);
});

test('the combined question used to match nothing; one topic with no wording leaves the others answered', () => {
  const question = 'Is knee replacement covered, room rent limit, co-pay?';
  assert.equal(selectClauseAnswer({ question, clauses }), null);
  const picks = selectClauseAnswers({ question, clauses });
  assert.ok(picks.some(pick => pick.clause.id === 'c1'));
  assert.ok(!picks.some(pick => pick.clause.id === 'c3'));
});

test('a single-topic question gives the same answer as before', () => {
  const question = 'Is cosmetic treatment covered?';
  assert.equal(selectClauseAnswers({ question, clauses }).length, 1);
  assert.equal(selectClauseAnswers({ question, clauses })[0].clause.id, selectClauseAnswer({ question, clauses }).clause.id);
  assert.deepEqual(selectClauseAnswers({ question: 'Does it cover dental?', clauses }), []);
});

test('a label-like line beats a line that only mentions the term later; the unknown answer says nothing was found, not that nothing exists', async () => {
  const { NOT_IN_DOCUMENTS_TEXT } = await import('../src/features/insurance-rules/clause-answer.js');
  const picked = selectClauseAnswer({
    question: 'What is the room rent limit?',
    clauses: [
      { id: 'a', documentId: 'd', page: 5, text: 'Modification of Room Rent Discount 0', kind: 'limit', sectionPath: [], blockIndexes: [0] },
      { id: 'b', documentId: 'd', page: 6, text: '4.1.a Room Rent At Actuals', kind: 'limit', sectionPath: [], blockIndexes: [0] },
    ],
  });
  assert.equal(picked.clause.id, 'b');
  assert.match(NOT_IN_DOCUMENTS_TEXT, /did not find this/);
  assert.match(NOT_IN_DOCUMENTS_TEXT, /may simply not be printed/);
});
