import test from 'node:test';
import assert from 'node:assert/strict';
import { ANSWER_CARD_CONTRACT, ANSWER_CARD_ACTION_KINDS, ANSWER_CARD_STATUSES, validateAnswerCardShape } from '../src/contracts/index.js';

const card = (over = {}) => ({
  contract: ANSWER_CARD_CONTRACT, status: 'evidence_found', verdict: 'covered', ruleResultId: 'rr1',
  headline: 'Covered after 2 years', explanation: 'Synthetic explanation.',
  conditions: [{ kind: 'waiting_period', text: '2-year wait', sourceIds: ['s1'] }],
  sources: [{ id: 's1', factIds: ['f1'], tier: 'own_pdf', status: 'extracted_unverified', page: 1, clause: null, quote: 'two years' }],
  actions: [{ kind: 'find_hospital', label: 'Find a hospital' }], followups: ['What documents?'],
  speech: { lang: 'en', text: 'Your policy says: covered.' }, ...over,
});

test('enums are frozen', () => {
  assert.ok(Object.isFrozen(ANSWER_CARD_ACTION_KINDS));
  assert.deepEqual([...ANSWER_CARD_STATUSES], ['evidence_found', 'unknown', 'out_of_scope']);
});

test('valid card passes', () => assert.deepEqual(validateAnswerCardShape(card()), { valid: true, errors: [] }));

const bad = [
  ['not an object', null, 'card_not_object'],
  ['wrong contract', card({ contract: 'x' }), 'contract'],
  ['bad status', card({ status: 'maybe' }), 'status'],
  ['bad verdict', card({ verdict: 'will_pay' }), 'verdict'],
  ['headline 91 chars', card({ headline: 'a'.repeat(91) }), 'headline_too_long'],
  ['explanation 281 chars', card({ explanation: 'a'.repeat(281) }), 'explanation_too_long'],
  ['quote 161 chars', card({ sources: [{ ...card().sources[0], quote: 'a'.repeat(161) }] }), 'sources[0].quote_too_long'],
  ['7 conditions', card({ conditions: Array.from({ length: 7 }, () => card().conditions[0]) }), 'conditions_too_many'],
  ['9 sources', card({ sources: Array.from({ length: 9 }, () => card().sources[0]) }), 'sources_too_many'],
  ['4 actions', card({ actions: Array.from({ length: 4 }, () => card().actions[0]) }), 'actions_too_many'],
  ['4 followups', card({ followups: ['a', 'b', 'c', 'd'] }), 'followups_too_many'],
  ['26 words speech', card({ speech: { lang: 'en', text: Array(26).fill('w').join(' ') } }), 'speech_too_long'],
  ['bad condition kind', card({ conditions: [{ kind: 'x', text: 't', sourceIds: [] }] }), 'conditions[0].kind'],
  ['bad source tier', card({ sources: [{ ...card().sources[0], tier: 'web' }] }), 'sources[0].tier'],
  ['bad action kind', card({ actions: [{ kind: 'pay', label: 'x' }] }), 'actions[0]'],
];
for (const [name, input, error] of bad) {
  test(`shape rejects ${name}`, () => {
    const result = validateAnswerCardShape(input);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes(error), result.errors.join());
  });
}

test('limits are inclusive', () => {
  assert.equal(validateAnswerCardShape(card({ headline: 'a'.repeat(90), explanation: 'a'.repeat(280), speech: { lang: 'en', text: Array(25).fill('w').join(' ') } })).valid, true);
});
