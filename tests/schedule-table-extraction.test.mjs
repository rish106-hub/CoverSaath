// Deterministic extraction from schedule tables as Sarvam returns them (rows joined by " | "). Synthetic values only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFacts } from '../src/features/policy-facts/deterministic-extractors.js';
import { verifyEvidence } from '../src/features/policy-facts/evidence-verify.js';

const chunk = (text, page = 3) => ({ id: `c${page}`, page, blockIndexes: [0], text });
const byType = facts => Object.fromEntries(facts.map(fact => [fact.factType, fact]));

test('a label/value row with several pairs yields each labelled fact with a tight quote', () => {
  const text = [
    'Policyholder Name | ASHA TESTER | Policy Number | 1234567890 | Issuance Date | 01-04-2026',
    'Correspondence Address | 1 Test Road, Testville | Period of Insurance | From 01-04-2026 10:00 AM to 31-03-2027 Midnight',
    'Transaction No. | T0001 | Premium Frequency | Full Pay',
  ].join('\n');
  const c = chunk(text);
  const { facts } = extractFacts([c]);
  const found = byType(facts);
  assert.deepEqual(found.issue_date.value, { iso: '2026-04-01' });
  assert.equal(found.issue_date.evidence[0].quote, 'Issuance Date | 01-04-2026');
  assert.deepEqual(found.policy_period.value, { startIso: '2026-04-01', endIso: '2027-03-31', days: 365 });
  assert.match(found.policy_period.evidence[0].quote, /^Period of Insurance \| From/);
  for (const fact of facts.filter(item => item.state === 'extracted_unverified')) {
    assert.ok(verifyEvidence({ factType: fact.factType, value: fact.value, quote: fact.evidence[0].quote, page: 3, blockIndex: 0 }, c).ok, fact.factType);
  }
});

test('a header row above one value row pairs by column; a header cell is never read as a value', () => {
  const { facts } = extractFacts([chunk('Intermediary Name | Intermediary Code | Intermediary Contact Number\nTEST BROKING LTD | 900000000001 | 9000000000')]);
  const found = byType(facts);
  assert.deepEqual(found.seller_name.value, { text: 'TEST BROKING LTD' });
  assert.deepEqual(found.seller_code.value, { text: '900000000001' });
  assert.ok(!facts.some(fact => fact.value?.text === 'Intermediary Code | Intermediary Contact Number'));
});

test('several values after one label stay ambiguous; schedule-of-benefits rows and the premium sentence are read', () => {
  const text = [
    'Base Premium (A) | 10,000 | 5,000 | 2,000',
    '2.12 | PED wait period applicable from policy inception | 3 Years',
    'This is to certify that we have received an amount of ₹ 17,000 towards premium from the proposer.',
  ].join('\n');
  const { facts } = extractFacts([chunk(text, 6)]);
  const found = byType(facts);
  assert.equal(found.premium_base, undefined);
  assert.equal(found.waiting_ped.value.days, 1095);
  assert.deepEqual(found.premium_total.value, { amountMinor: 1700000, currency: 'INR' });
});

test('a text value is one cell; a "Label: value" line whose value holds a pipe is still read', () => {
  const { facts } = extractFacts([chunk('Agent Name | TEST AGENCY | 9000000000\nGrace Period: 30 days | renewal only')]);
  const found = byType(facts);
  assert.deepEqual(found.seller_name.value, { text: 'TEST AGENCY' });
  assert.equal(found.grace_period?.value?.days, 30);
});
