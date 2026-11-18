import assert from 'node:assert/strict';
import test from 'node:test';
import { needsRouter } from '../src/features/insurance-rules/chat-router.js';

// needsRouter is pure: no database, no model. Synthetic questions only.
test('English questions that match a topic stay on the free keyword path', () => {
  for (const message of ['What is the room rent limit?', 'Is ICU covered, any limit?', 'How long before pre-existing diseases are covered?', 'What is my sum insured?']) {
    assert.equal(needsRouter({ message, factKeys: ['room_rent_limit'] }), false, message);
  }
});

test('Hinglish and non-ASCII text go to the router even when a topic word matches', () => {
  for (const message of ['room rent ki limit kitni hai', 'mera sum insured kitna hai?', 'pre existing bimari kab se cover hogi?', 'claim kaise karna hai, kya chahiye', 'कमरे का किराया']) {
    assert.equal(needsRouter({ message, factKeys: ['room_rent_limit'] }), true, message);
  }
});

test('no topic always routes; a procedure never does; empty text never does', () => {
  assert.equal(needsRouter({ message: 'hello', factKeys: [] }), true);
  assert.equal(needsRouter({ message: 'room rent ki limit kitni hai', factKeys: ['room_rent_limit'], hasProcedure: true }), false);
  assert.equal(needsRouter({ message: '   ', factKeys: [] }), false);
});
