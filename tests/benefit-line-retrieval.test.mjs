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

test('a question of frame words only ("waiting periods") finds the waiting-period lines; a heading brings the line under it', async () => {
  const { isHeading } = await import('../src/features/insurance-rules/clause-answer.js');
  const waiting = selectClauseAnswer({
    question: 'What are my waiting periods?',
    clauses: [
      { id: 'w', documentId: 'd', page: 16, text: 'Initial waiting Period: 30 days for all illnesses except accidents.', kind: 'waiting_period', sectionPath: [], blockIndexes: [0] },
      { id: 'x', documentId: 'd', page: 3, text: 'Cosmetic treatment is excluded.', kind: 'exclusion', sectionPath: [], blockIndexes: [0] },
    ],
  });
  assert.equal(waiting.clause.id, 'w');
  assert.ok(isHeading('Premium Details (Rs)'));
  assert.ok(!isHeading('Room Rent up to 1% of the sum insured.'));
  const premium = selectClauseAnswer({
    question: 'What is my premium?',
    clauses: [{ id: 'p', documentId: 'd', page: 4, text: 'Premium Details (Rs)\nBasic premium 40,000 GST 7,200', kind: 'schedule_fact', sectionPath: [], blockIndexes: [0, 1] }],
  });
  assert.match(premium.text, /Premium Details \(Rs\) Basic premium 40,000/);
});

test('the not-found answer names the topic asked about', async () => {
  const { buildDeterministicAnswer } = await import('../src/features/insurance-rules/chat-answer.js');
  const built = buildDeterministicAnswer({ intent: 'coverage_question', factKeys: ['copay_percent', 'copay_zone_percent'], facts: [], clauses: [], searchedClauses: true });
  assert.match(built.text, /did not find a co-payment in your policy documents/);
  assert.equal(built.status, 'unknown');
});

test('before the plan is confirmed, chat says so instead of searching passages', async () => {
  const { buildDeterministicAnswer } = await import('../src/features/insurance-rules/chat-answer.js');
  const built = buildDeterministicAnswer({ intent: 'coverage_question', factKeys: ['premium_total'], facts: [], clauses: [], searchedClauses: false, awaitingPlan: true });
  assert.match(built.text, /not confirmed which plan/);
  assert.equal(built.status, 'unknown');
});

test('a multi-topic question gives one block per topic, including a not-found line', async () => {
  const { selectTopicAnswers } = await import('../src/features/insurance-rules/clause-answer.js');
  const { buildDeterministicAnswer } = await import('../src/features/insurance-rules/chat-answer.js');
  const question = 'Is knee replacement covered, room rent limit, co-pay?';
  const { answers, missing } = selectTopicAnswers({ question, clauses });
  assert.deepEqual(answers.map(pick => pick.clause.id), ['c1']);
  assert.deepEqual(missing, ['Is knee replacement covered', 'co-pay']);
  const built = buildDeterministicAnswer({ intent: 'coverage_question', factKeys: [], facts: [], clauses: answers.map(pick => ({ ...pick.clause, window: pick.text })), searchedClauses: true, missingTopics: missing });
  assert.match(built.text, /Room Rent At Actuals/);
  assert.match(built.text, /did not find "Is knee replacement covered"/);
  assert.match(built.text, /did not find "co-pay"/);
  assert.deepEqual(selectTopicAnswers({ question: 'Does it cover dental?', clauses }), { answers: [], missing: [] });
});

test('"which insurer and plan do I have" is a holding question, answered from the confirmed plan with a source label', async () => {
  const { isIdentityQuestion } = await import('../src/features/insurance-rules/chat-intent.js');
  const { buildDeterministicAnswer } = await import('../src/features/insurance-rules/chat-answer.js');
  for (const yes of ['Which insurer and plan do I have?', 'who is my insurer', 'What plan am I on?', 'which insurance do I have']) assert.ok(isIdentityQuestion(yes), yes);
  for (const no of ['What is my premium?', 'Is knee surgery covered?', 'Which room is covered?']) assert.ok(!isIdentityQuestion(no), no);
  const built = buildDeterministicAnswer({ intent: 'general', factKeys: [], facts: [], holdingLines: ['- From the plan you confirmed: Test Insurer - Test Plan.'] });
  assert.match(built.text, /From the plan you confirmed: Test Insurer - Test Plan/);
  assert.equal(built.status, 'evidence_found');
});

test('every answer block names its source: schedule facts, wording clauses, insurer terms', async () => {
  const { buildDeterministicAnswer } = await import('../src/features/insurance-rules/chat-answer.js');
  const fact = (status, tier) => ({ factKey: 'sum_insured', entry: { label: 'The sum insured', type: 'money' }, status, value: { amountMinor: 500000, currency: 'INR' }, sourceIds: ['f1'], sourceTier: tier, checkWithInsurer: false });
  assert.match(buildDeterministicAnswer({ intent: 'coverage_question', factKeys: ['sum_insured'], facts: [fact('extracted_unverified', 'own_pdf')] }).text, /from your policy schedule/);
  assert.match(buildDeterministicAnswer({ intent: 'coverage_question', factKeys: ['sum_insured'], facts: [fact('reviewed_reference', 'ida_wording')] }).text, /from the insurer's published terms/);
  assert.match(buildDeterministicAnswer({ intent: 'coverage_question', factKeys: [], facts: [], clauses: [{ id: 'c', page: 4, window: 'Room Rent At Actuals' }], searchedClauses: true }).text, /From your policy wording \(page 4\)/);
});

test('policy number, member id and UIN questions get a fixed answer; ordinary questions do not', async () => {
  const { isRegistryIdQuestion, REGISTRY_ID_ANSWER } = await import('../src/features/insurance-rules/chat-intent.js');
  for (const yes of ['What is the UIN of my product?', 'what is my policy number', 'member id?', 'Policy No', 'e-card number']) assert.ok(isRegistryIdQuestion(yes), yes);
  for (const no of ['What is my premium?', 'Which insurer do I have?', 'Is knee surgery covered?', 'What is my sum insured?']) assert.ok(!isRegistryIdQuestion(no), no);
  assert.match(REGISTRY_ID_ANSWER, /do not show or keep/);
  assert.doesNotMatch(REGISTRY_ID_ANSWER, /\d{4,}/);
});
