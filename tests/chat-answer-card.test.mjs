import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnCardDraft, guardTurnAnswer, quoteFrom, splitAnswerText } from '../src/backend/services/chat-answer-card.js';
import { isReleasedCard } from '../src/features/chat-answer-guard/index.js';
import { ANSWER_CARD_LIMITS, validateAnswerCardShape } from '../src/contracts/answer-card.js';

// Chat turn -> answer-card/v1, released only through the guard. Synthetic wording only.
const clause = { documentId: 'doc-1', page: 4, ref: 'clause:abc', tier: 'own_pdf', text: 'Listed surgeries are covered after a waiting period of 24 months from the policy start date.' };
const fact = { factId: 'fact-1', factKey: 'room_rent_limit', status: 'reviewed_reference', tier: 'own_pdf', page: 2, quote: 'Room rent: Rs 5,000 per day', valueText: 'Rs 5,000 per day' };

test('a grounded wording answer is released with its source and the turn text', () => {
  const r = guardTurnAnswer({ status: 'evidence_found', text: 'Listed surgeries have a waiting period of 24 months. It runs from the policy start date.', wording: [clause] });
  assert.equal(r.released, true, JSON.stringify(r.failedChecks));
  assert.ok(isReleasedCard(r.card));
  assert.equal(validateAnswerCardShape(r.card).valid, true);
  assert.equal(r.card.headline, 'Listed surgeries have a waiting period of 24 months.');
  assert.equal(r.card.sources[0].page, 4);
  assert.equal(r.card.verdict, 'unknown');
  assert.equal(r.card.speech, null);
});

test('a fact answer is grounded in the fact quote and value', () => {
  const r = guardTurnAnswer({ status: 'evidence_found', text: 'Your room rent limit is Rs 5,000 per day.', facts: [fact] });
  assert.equal(r.released, true, JSON.stringify(r.failedChecks));
  assert.deepEqual(r.card.sources[0].factIds, ['fact-1']);
});

test('fail closed: an ungrounded number, a promise, advice or a phone number drops to the fixed card', () => {
  for (const text of [
    'Listed surgeries have a waiting period of 36 months.',
    'Your claim will be paid in full. The wait is 24 months.',
    'You should buy a top-up plan. The wait is 24 months.',
    'Call 1800-000-0001 for help. The wait is 24 months.',
  ]) {
    const r = guardTurnAnswer({ status: 'evidence_found', text, wording: [clause] });
    assert.equal(r.released, false, text);
    assert.ok(isReleasedCard(r.card), 'the replacement is itself a released card');
    assert.equal(r.card.status, 'unknown');
    assert.doesNotMatch(r.card.answer, /36|paid|buy|1800/);
  }
});

test('no evidence: an unknown card pointing to the policy card, no sources', () => {
  const r = guardTurnAnswer({ status: 'unknown', text: "I couldn't find this in your documents.", wording: [], facts: [] });
  assert.equal(r.released, true, JSON.stringify(r.failedChecks));
  assert.equal(r.card.status, 'unknown');
  assert.deepEqual(r.card.sources, []);
  assert.equal(r.card.actions[0].kind, 'call_insurer');
});

test('limits: long text and long evidence fit the card, quotes stay exact substrings', () => {
  const long = `${'Word '.repeat(60)}end.`;
  const { headline, explanation } = splitAnswerText(long);
  assert.ok(headline.length <= ANSWER_CARD_LIMITS.headline && explanation.length <= ANSWER_CARD_LIMITS.explanation);
  const q = quoteFrom(`${'clause text '.repeat(40)}`);
  assert.ok(q.length <= ANSWER_CARD_LIMITS.quote && q.length > 0);
  const many = Array.from({ length: 12 }, (_, i) => ({ ...clause, ref: `clause:${i}` }));
  const { card } = buildTurnCardDraft({ status: 'evidence_found', text: 'The wait is 24 months.', wording: many });
  assert.equal(card.sources.length, ANSWER_CARD_LIMITS.sources);
});
