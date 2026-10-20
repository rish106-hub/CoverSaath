import test from 'node:test';
import assert from 'node:assert/strict';
import { readingMatches, scoreCriticalFields } from '../src/features/policy-structuring/index.js';

// Synthetic golden and review result only.
const golden = {
  base_sum_insured: { value: 'Rs. 10,00,000', page: 1, confirmed: true },
  ped_waiting_period: { value: '36 months', page: 2, confirmed: true },
  initial_waiting_period: { value: '30 days', page: 2, confirmed: true },
  room_rent_limit: { value: 'Single private room', page: 3, confirmed: true },
  policy_number: { value: 'SYN-0001', page: 1, confirmed: true },
  co_payment: { value: '10%', page: null, confirmed: true },
  policy_period_start: { value: '01/04/2026', page: 1, confirmed: true },
};
const reading = (value, extra = {}) => ({ value, normalized: null, subject: 'policy', page: 1, blockIndex: 0, quote: value, selected: false, ...extra });
const review = {
  parameters: [
    { key: 'd.sum_insured', state: 'extracted_unverified', readings: [reading('₹10,00,000', { selected: true })] },
    { key: 'f.ped_waiting_period', state: 'conflicting', readings: [reading('3 years'), reading('48 months')] },
    { key: 'f.initial_waiting_period', state: 'extracted_unverified', readings: [reading('60 days', { selected: true })] },
    { key: 'd.room_rent_limit', state: 'conflicting', readings: [reading('Shared room'), reading('Twin sharing')] },
    { key: 'b.policy_period', state: 'extracted_unverified', readings: [reading('From 1-Apr-2026 to 31-Mar-2027', { selected: true })] },
  ],
};

test('readingMatches compares money, durations and dates by meaning, numbers strictly', () => {
  assert.equal(readingMatches('Rs. 10,00,000', reading('₹10,00,000')), true);
  assert.equal(readingMatches('36 months', reading('3 years')), false, 'durations compare amount and unit; no 30/365-day conversion');
  assert.equal(readingMatches('36 months', reading('36 Months of continuous coverage')), true);
  assert.equal(readingMatches('01/04/2026', reading('1-Apr-2026')), true);
  assert.equal(readingMatches('01/04/2026', reading('1-Apr-2025')), false);
  assert.equal(readingMatches(['A', 'B'], reading('A and B')), true);
  assert.equal(readingMatches(['A', 'C'], reading('A and B')), false);
});

test('readingMatches rejects digit-run substring matches (typed evaluator defect)', () => {
  assert.equal(readingMatches('5,000', reading('50,000')), false);
  assert.equal(readingMatches('Rs. 5,000', reading('₹50,000')), false);
  assert.equal(readingMatches('1', reading('10')), false);
  assert.equal(readingMatches('1%', reading('10%')), false);
  assert.equal(readingMatches('60 days', reading('160 days')), false);
  assert.equal(readingMatches('01/04/2026', reading('01/04/2025')), false);
  assert.equal(readingMatches('SYN-0001', reading('SYN-00011')), false);
});

test('readingMatches compares typed values by meaning', () => {
  assert.equal(readingMatches('1 lakh', reading('₹1,00,000')), true);
  assert.equal(readingMatches('Rs. 5,000', reading('5000')), true, 'the money normaliser accepts a bare amount');
  assert.equal(readingMatches('Rs. 5,000', reading('Rs. 5,000 or 10% of SI')), false, 'a typed golden needs a parseable typed reading');
  assert.equal(readingMatches('Rs. 4,000 per day', reading('Rs. 4,000 per claim')), false);
  assert.equal(readingMatches('Rs. 4,000', reading('Rs. 4,000 per day')), true);
  assert.equal(readingMatches('5,000', reading('5000')), true);
  assert.equal(readingMatches('10%', reading('10 per cent')), true);
  assert.equal(readingMatches('30 days', reading('thirty (30) days')), true);
  assert.equal(readingMatches('30 days', reading('1 month')), false);
  assert.equal(readingMatches('Rs. 10,00,000', reading('Sum insured as per schedule')), false);
  assert.equal(readingMatches('Rs. 10,00,000', reading('ten lakh', { normalized: { kind: 'money', amountMinor: 100_000_000, currency: 'INR' } })), true);
  assert.equal(readingMatches('31/03/2027', reading('From 1-Apr-2026 to 31-Mar-2027')), true);
  assert.equal(readingMatches('Single private room', reading('Single private room (AC)')), true);
  assert.equal(readingMatches('private room', reading('Semiprivate room')), false);
});

test('scoreCriticalFields classifies every critical outcome and never counts a conflict as correct', () => {
  const { fields, totals } = scoreCriticalFields(golden, review, { modelForbiddenKeys: ['a.contract_and_member_identifiers'] });
  assert.equal(fields.base_sum_insured.outcome, 'correct');
  assert.equal(fields.ped_waiting_period.outcome, 'conflicting_without_correct');
  assert.equal(fields.initial_waiting_period.outcome, 'wrong');
  assert.equal(fields.room_rent_limit.outcome, 'conflicting_without_correct');
  assert.equal(fields.policy_number.outcome, 'unknown_by_design');
  assert.equal(fields.co_payment.outcome, 'missed');
  assert.equal(fields.policy_period_start.outcome, 'correct');
  assert.equal(totals.wrong, 1);
  assert.equal(totals.correct, 2);
});
