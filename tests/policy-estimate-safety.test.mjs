import test from 'node:test';
import assert from 'node:assert/strict';

import { estimatePlannedProcedure } from '../src/modules/policy-breakdown/consumers/estimate.js';

const parameter = (key, evidenceState, value, extra = {}) => ({
  key,
  label: key,
  section: 3,
  evidenceState,
  value,
  critical: false,
  visibility: 'cover',
  review: { state: 'unreviewed' },
  ...extra,
});
const proven = (key, value, extra) => parameter(key, 'Proven', value, extra);
const calculated = (key, value, extra) => parameter(key, 'Calculated', value, extra);
const notFoundInPack = key => parameter(key, 'Unknown', null, {
  stateReason: 'not_found_in_source_pack',
  verification: { verifier: 'not_required' },
});

const member = { id: 'member-2', displayName: 'Priya Sharma', relationship: 'mother' };
const billMinor = 100_000_000;
const request = condition => ({
  procedure: 'general_inpatient',
  admissionDate: '2027-01-15',
  condition,
  hospital: { networkStatus: 'network', zone: 'zone_b', excluded: false },
  billLines: [{ head: 'surgeon_fees', amountMinor: billMinor }],
});

const baseParameters = extra => ({
  sum_insured_amount: proven('sum_insured_amount', { kind: 'money', amountMinor: 150_000_000 }),
  deductible_amount: proven('deductible_amount', { kind: 'money', amountMinor: 0 }),
  copay_general_percent: proven('copay_general_percent', { kind: 'percent', percent: 0 }),
  copay_age_percent: proven('copay_age_percent', { kind: 'percent', percent: 0 }),
  copay_zone_percent: proven('copay_zone_percent', { kind: 'percent', percent: 0 }),
  copay_non_network_percent: proven('copay_non_network_percent', { kind: 'percent', percent: 0 }),
  insured_members: proven('insured_members', { kind: 'text_list', items: ['Priya Sharma'] }),
  policy_start_date: proven('policy_start_date', { kind: 'date', date: '2026-01-01' }),
  policy_end_date: proven('policy_end_date', { kind: 'date', date: '2027-12-31' }),
  member_effective_date: calculated('member_effective_date', { kind: 'date', date: '2026-08-01' }),
  waiting_period_start_basis: proven('waiting_period_start_basis', { kind: 'enum', enumValue: 'current_period_start' }),
  initial_waiting_period_days: proven('initial_waiting_period_days', { kind: 'days', count: 30 }),
  ped_waiting_period_months: proven('ped_waiting_period_months', { kind: 'months', count: 36 }),
  specified_disease_waiting_months: proven('specified_disease_waiting_months', { kind: 'months', count: 24 }),
  standard_exclusions: proven('standard_exclusions', { kind: 'text_list', items: [] }),
  ...extra,
});

test('known waiting-period blocker makes the primary ₹10L scenario zero payout and full household exposure', () => {
  const result = estimatePlannedProcedure({
    parameters: baseParameters({ policy_end_date: proven('policy_end_date', { kind: 'date', date: '2031-12-31' }) }),
    member,
    asOf: '2026-10-07',
    input: request({ name: 'kidney stones', preExisting: false, specifiedDisease: true }),
  });

  const wait = result.eligibility.checks.find(check => check.id === 'specified_disease_wait');
  assert.equal(wait.outcome, 'not_met');
  assert.match(wait.message, /2026-08-01/, 'a later Calculated member cover start controls the wait');
  assert.equal(result.status, 'coverage_blocked');
  assert.equal(result.display.headline, 'Coverage blocker found');
  assert.deepEqual(result.insurerPaysMinor, { low: 0, high: 0 });
  assert.deepEqual(result.householdPaysMinor, { low: billMinor, high: billMinor });
  assert.equal(result.insurerPaysIfEligibleMinor, null, 'a known blocker must not coexist with a positive payout for the same scenario');
});

test('a specified-disease wait absent from the uploaded pack remains unresolved and fail-closed', () => {
  const result = estimatePlannedProcedure({
    parameters: baseParameters({ specified_disease_waiting_months: notFoundInPack('specified_disease_waiting_months') }),
    member,
    asOf: '2026-10-07',
    input: request({ name: 'kidney stones', preExisting: false, specifiedDisease: true }),
  });

  assert.equal(result.eligibility.checks.find(check => check.id === 'specified_disease_wait').outcome, 'unknown');
  assert.equal(result.status, 'coverage_not_established');
  assert.equal(result.display.headline, 'Coverage not established');
  assert.deepEqual(result.insurerPaysMinor, { low: 0, high: 0 });
  assert.deepEqual(result.householdPaysMinor, { low: billMinor, high: billMinor });
  assert.deepEqual(result.insurerPaysIfEligibleMinor, { low: billMinor, high: billMinor }, 'the optimistic calculation is secondary and explicitly conditional');
});

test('clear waiting-period eligibility retains the ordinary estimate contract', () => {
  const result = estimatePlannedProcedure({
    parameters: baseParameters({ policy_end_date: proven('policy_end_date', { kind: 'date', date: '2031-12-31' }) }),
    member,
    asOf: '2026-10-07',
    input: { ...request({ name: 'kidney stones', preExisting: false, specifiedDisease: false }), admissionDate: '2030-01-15' },
  });

  assert.equal(result.status, 'estimate');
  assert.equal(result.display.headline, 'Planning estimate');
  assert.deepEqual(result.insurerPaysMinor, { low: billMinor, high: billMinor });
  assert.deepEqual(result.householdPaysMinor, { low: 0, high: 0 });
});

test('non-network cashless failure does not falsely zero a reimbursement estimate', () => {
  const result = estimatePlannedProcedure({
    parameters: baseParameters({ policy_end_date: proven('policy_end_date', { kind: 'date', date: '2031-12-31' }), cashless_non_network_available: proven('cashless_non_network_available', { kind: 'boolean', flag: false }) }),
    member,
    asOf: '2026-10-07',
    input: {
      admissionDate: '2030-10-20',
      procedure: 'general_inpatient',
      condition: { name: 'appendicitis', preExisting: false, specifiedDisease: false },
      hospital: { networkStatus: 'non_network', excluded: false },
      billLines: [{ head: 'surgeon_fees', amountMinor: 100_000_000 }],
    },
  });

  assert.equal(result.eligibility.verdict, 'blocker_found', 'cashless route is blocked');
  assert.deepEqual(result.coverageBlockers, []);
  assert.equal(result.status, 'estimate');
  assert.deepEqual(result.insurerPaysMinor, { low: 100_000_000, high: 100_000_000 });
});

test('unknown member eligibility and a reported negative PED answer cannot produce a full-payout headline', () => {
  const parameters = baseParameters({ insured_members: notFoundInPack('insured_members') });
  const result = estimatePlannedProcedure({
    parameters,
    member,
    asOf: '2026-10-07',
    input: request({ name: 'kidney stones', preExisting: false, specifiedDisease: false }),
  });
  assert.equal(result.eligibility.checks.find(check => check.id === 'member_insured').outcome, 'unknown');
  assert.equal(result.eligibility.checks.find(check => check.id === 'ped_wait').outcome, 'attention');
  assert.equal(result.status, 'coverage_not_established');
  assert.deepEqual(result.insurerPaysMinor, { low: 0, high: 0 });
  assert.deepEqual(result.householdPaysMinor, { low: billMinor, high: billMinor });
});

test('cashless availability preserves true false and unknown as separate operational states', () => {
  const input = { ...request({ name: 'appendicitis', preExisting: true, specifiedDisease: true }), admissionDate: '2030-01-15', hospital: { networkStatus: 'non_network', excluded: false } };
  const longPolicy = { policy_end_date: proven('policy_end_date', { kind: 'date', date: '2031-12-31' }) };
  const unknown = estimatePlannedProcedure({ parameters: baseParameters(longPolicy), member, asOf: '2026-10-07', input });
  assert.equal(unknown.eligibility.checks.find(check => check.id === 'cashless_route').outcome, 'unknown');
  const unavailable = estimatePlannedProcedure({ parameters: baseParameters({ ...longPolicy, cashless_non_network_available: proven('cashless_non_network_available', { kind: 'boolean', flag: false }) }), member, asOf: '2026-10-07', input });
  assert.equal(unavailable.eligibility.checks.find(check => check.id === 'cashless_route').outcome, 'not_met');
  const available = estimatePlannedProcedure({ parameters: baseParameters({ ...longPolicy, cashless_non_network_available: proven('cashless_non_network_available', { kind: 'boolean', flag: true }) }), member, asOf: '2026-10-07', input });
  assert.equal(available.eligibility.checks.find(check => check.id === 'cashless_route').outcome, 'attention');
});
