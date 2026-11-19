// Numbered schedule rows, code-labelled lines and printed text limits. Synthetic rows only, shaped like an insurer schedule.
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFacts } from '../src/features/policy-facts/deterministic-extractors.js';
import { verifyEvidence } from '../src/features/policy-facts/evidence-verify.js';
import { classifyChatMessage } from '../src/features/insurance-rules/chat-intent.js';
import { extractProductUins } from '../src/features/decision-catalogue/index.js';
import { getPolicyFactKey } from '../src/contracts/policy-facts.js';

const chunk = (text, page = 3) => ({ id: `c${page}`, page, blockIndexes: [0], text });
const byType = facts => Object.fromEntries(facts.map(fact => [fact.factType, fact]));

test('numbered rows without a separator are read: text limits, pre and post hospitalisation days', () => {
  const text = [
    '1.1.a Room Rent  At Actuals',
    '1.1.b ICU Charges At Actuals',
    '1.5 Pre-Hospitalization 45 days',
    '1.6 Post-Hospitalization 90 days',
    '1.7 Free text line that is just a sentence about cover',
  ].join('\n');
  const c = chunk(text, 6);
  const found = byType(extractFacts([c]).facts);
  assert.deepEqual(found.room_rent_text.value, { text: 'At Actuals' });
  assert.equal(found.room_rent_text.state, 'extracted_unverified');
  assert.equal(found.room_rent_text.evidence[0].page, 6);
  assert.equal(found.room_rent_text.evidence[0].quote, '1.1.a Room Rent  At Actuals');
  assert.deepEqual(found.icu_limit_text.value, { text: 'At Actuals' });
  assert.equal(found.pre_hospitalisation_days.value.days, 45);
  assert.equal(found.post_hospitalisation_days.value.days, 90);
  assert.equal(found.room_rent_limit, undefined, 'a text limit is not an amount');
  for (const fact of Object.values(found).filter(item => item.state === 'extracted_unverified')) {
    assert.ok(verifyEvidence({ factType: fact.factType, value: fact.value, quote: fact.evidence[0].quote, page: 6, blockIndex: 0 }, c).ok, fact.factType);
  }
});

test('numbered cells and code-labelled lines are read: initial and specific-disease waiting periods', () => {
  const text = [
    'Initial waiting Period (Code-Excl03): 30 days',
    'Specified disease/procedure waiting Period (Code-Excl02): 24 months',
    '2.3 | Room Rent | Single Private Room',
    '2.4 Room Rent Limit | Rs 5,000',
  ].join('\n');
  const found = byType(extractFacts([chunk(text, 16)]).facts);
  assert.equal(found.waiting_initial.value.days, 30);
  assert.equal(found.waiting_initial.evidence[0].quote, 'Initial waiting Period (Code-Excl03): 30 days');
  assert.equal(found.waiting_specific.scopeKey, 'specific_diseases');
  assert.equal(found.waiting_specific.value.days, 730);
  assert.equal(found.waiting_specific.evidence[0].page, 16);
  assert.equal(found.room_rent_limit.value.amountMinor, 500000);
});

test('a sentence is not read as a numbered row, and an amount is not also a text limit', () => {
  const text = ['The insurer pays Room Rent at its discretion for 3 days', '1.2 Room Rent | Rs 4,000'].join('\n');
  const found = byType(extractFacts([chunk(text, 2)]).facts);
  assert.equal(found.room_rent_limit.value.amountMinor, 400000);
  assert.equal(found.room_rent_text, undefined);
});

test('two different printed values for a text limit conflict and hold no value', () => {
  const found = byType(extractFacts([chunk('1.1 Room Rent  At Actuals', 3), chunk('1.1 Room Rent  Single Private Room', 9)]).facts);
  assert.equal(found.room_rent_text.state, 'conflicting');
  assert.equal(found.room_rent_text.value, null);
});

test('new fact types are in the memory registry and the chat topic map', () => {
  for (const key of ['room_rent_text', 'icu_limit_text', 'pre_hospitalisation_days', 'post_hospitalisation_days']) assert.ok(getPolicyFactKey(key), key);
  assert.ok(classifyChatMessage('what is my room rent limit?').factKeys.includes('room_rent_text'));
  assert.ok(classifyChatMessage('is icu covered?').factKeys.includes('icu_limit_text'));
});

test('extractProductUins prefers the product UIN over an add-on UIN and keeps real conflicts', () => {
  const product = 'SYNTHHLIP26001V012526';
  const addOn = 'SYNTHHLIA24002V012324';
  const other = 'OTHERHLIP26003V012526';
  assert.deepEqual(extractProductUins(`Add-on UIN: ${addOn}\nPolicy schedule\nProduct UIN: ${product}`), [product]);
  assert.deepEqual(extractProductUins(`UIN: ${product}\nOptional cover add-on UIN: ${addOn}`), [product]);
  assert.deepEqual(extractProductUins(`UIN: ${product}`), [product]);
  assert.deepEqual(extractProductUins(`Product UIN: ${product}\nProduct UIN: ${other}`).sort(), [other, product].sort());
  assert.deepEqual(extractProductUins(`UIN: ${product}\nUIN: ${other}`).sort(), [other, product].sort());
  assert.deepEqual(extractProductUins(`Add-on UIN: ${addOn}`), [addOn]);
  assert.deepEqual(extractProductUins('no uin here'), []);
});
