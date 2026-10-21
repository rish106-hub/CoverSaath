// Phase 5: continuity-based waiting period completion, strict typed validation, conditional results, layered policies.
// Synthetic data only. No network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionCatalogue, evaluateRules, toHandoff, assertHandoffContract } from '../src/features/decision-catalogue/index.js';

const clauseRows = [{ id: 'c1', documentId: 'd1', sourceVersion: '1', page: 1, digest: 'dg1' }, { id: 'c2', documentId: 'd2', sourceVersion: '1', page: 1, digest: 'dg2' }];
const fact = over => ({ policyId: 'P1', policyAssociation: { basis: 'printed_policy_number' }, documentId: 'd1', sourceVersion: '1', sourceType: 'issued_schedule', clauseIds: ['c1'], topic: '', ...over });
const reviewed = candidates => ({ origin: 'human_review', reviewStatus: 'accepted', verifiedPolicyIds: ['P1', 'P2'], candidates });
const build = (batches, pol = [{ policyId: 'P1', kind: 'personal' }]) => buildDecisionCatalogue({ householdId: 'h1', clauseRows, batches, policies: pol, asOf: '2026-06-30' });
// Continuity is always one member's, so completion is asked for a named member.
const MEMBER = { memberId: 'member-a', scope: 'member' };
const wp = (cat, asOf, topic = 'pre_existing', memberId = 'member-a') => evaluateRules(cat.facts, { policyId: 'P1', topic, asOf, memberId }, ['waiting_period'])[0];
const WP = fact({ factType: 'waiting_period', topic: 'pre_existing', value: { months: 24 } });

test('a policy start date alone is not continuity', () => {
  const cat = build([reviewed([WP, fact({ factType: 'policy_period', value: { start: '2024-07-01', end: '2026-12-31' } })])]);
  assert.deepEqual(wp(cat, '2026-08-01').completion, { state: 'unknown', reason: 'continuity_not_evidenced' });
});

test('model-reported continuity cannot complete a waiting period', () => {
  const model = { origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates: [fact({ sourceType: 'user_statement', factType: 'continuous_cover', subject: MEMBER, value: { since: '2020-01-01', uninterrupted: true } })] };
  assert.equal(wp(build([reviewed([WP]), model]), '2026-08-01').completion.reason, 'continuity_not_evidenced');
});

test('verified continuity completes only on the right day; credited prior cover is shown', () => {
  const cat = build([reviewed([WP, fact({ factType: 'continuous_cover', subject: MEMBER, value: { since: '2024-07-01', uninterrupted: true, creditedPriorCover: true } })])]);
  assert.equal(wp(cat, '2026-06-30').completion.state, 'not_completed');
  const done = wp(cat, '2026-07-01').completion;
  assert.equal(done.state, 'completed');
  assert.equal(done.creditedPriorCover, true);
  assert.ok(done.continuityCitations.length > 0);
  assert.equal(wp(cat, null).completion.reason, 'as_of_date_missing');
});

test('an interrupted cover record never completes a waiting period', () => {
  const cat = build([reviewed([WP, fact({ factType: 'continuous_cover', subject: MEMBER, value: { since: '2020-01-01', uninterrupted: false } })])]);
  assert.deepEqual(wp(cat, '2026-08-01').completion, { state: 'unknown', reason: 'cover_interrupted' });
});

test('an unknown or unverified waiting period has no completion', () => {
  const cat = build([reviewed([fact({ factType: 'continuous_cover', subject: MEMBER, value: { since: '2020-01-01', uninterrupted: true } })])]);
  assert.equal(wp(cat, '2026-08-01').completion.reason, 'waiting_period_not_established');
});

test('strict typed validation: zero or malformed caps, rates and durations are not known values', () => {
  const bad = [
    ['sum_insured', { amountMinor: 0, currency: 'INR' }],
    ['room_rent_limit', { kind: 'amount', amountMinor: 0, currency: 'INR', basis: 'day' }],
    ['room_rent_limit', { kind: 'percent_of_sum_insured', basisPoints: 0 }],
    ['deductible', { amountMinor: 0, currency: 'INR', type: 'per_claim' }],
    ['copay', { basisPoints: 10001 }],
    ['copay', { basisPoints: 12.5 }],
    ['waiting_period', { months: -1 }],
    ['restoration', {}],
    ['restoration', { kind: 'percent_of_sum_insured', basisPoints: 10000, times: 0 }],
    ['bonus', { basisPointsPerYear: 5000, maxBasisPoints: 1000 }],
    ['bonus', { note: 'up to 50 percent' }],
    ['continuous_cover', { since: '2024-02-30', uninterrupted: true }],
    ['continuous_cover', { since: '2024-02-01', uninterrupted: 'yes' }],
  ];
  for (const [factType, value] of bad) {
    const cat = build([reviewed([fact({ factType, value })])]);
    const rule = cat.policies[0].rules.find(r => r.rule === factType && r.topic === '');
    assert.notEqual(rule.result.status, 'known', `${factType} ${JSON.stringify(value)}`);
    assert.equal(rule.result.value, null);
  }
  const good = build([reviewed([
    fact({ factType: 'restoration', value: { kind: 'percent_of_sum_insured', basisPoints: 10000, times: 1 } }),
    fact({ factType: 'bonus', value: { basisPointsPerYear: 500, maxBasisPoints: 10000, reducesOnClaim: false } }),
  ])]);
  for (const id of ['restoration', 'bonus']) assert.equal(good.policies[0].rules.find(r => r.rule === id).result.status, 'known');
});

test('a known value that depends on conditions, exceptions or overrides is marked conditional', () => {
  const cat = build([reviewed([
    fact({ factType: 'room_rent_limit', topic: 'room rent', value: { kind: 'actuals' }, conditions: ['single private room'], overrides: ['endorsement 3'] }),
    fact({ factType: 'sum_insured', value: { amountMinor: 1000000, currency: 'INR' } }),
  ])]);
  const handoff = toHandoff({ catalogue: cat });
  assertHandoffContract(handoff);
  const get = (rule, topic) => handoff.policies[0].items.find(i => i.rule === rule && i.topic === topic);
  assert.equal(get('room_rent_limit', 'room rent').state, 'known');
  assert.equal(get('room_rent_limit', 'room rent').conditional, true);
  assert.equal(get('sum_insured', '').conditional, false);
});

test('layered policies stay independent: a top-up is not added, and waiting periods do not cross layers', () => {
  const pol = [{ policyId: 'P1', kind: 'personal' }, { policyId: 'P2', kind: 'super_top_up' }];
  const cat = build([reviewed([
    WP,
    fact({ policyId: 'P2', documentId: 'd2', clauseIds: ['c2'], factType: 'sum_insured', value: { amountMinor: 100000000, currency: 'INR' } }),
    fact({ factType: 'sum_insured', value: { amountMinor: 50000000, currency: 'INR' } }),
  ])], pol);
  assert.equal(cat.combinedConfirmedCover, null);
  assert.equal(cat.coordination.state, 'unresolved');
  assert.equal(cat.coordination.notes[0].policyId, 'P2');
  const layer = id => cat.policies.find(p => p.policyId === id);
  assert.equal(layer('P1').rules.find(r => r.rule === 'sum_insured').result.value.amountMinor, 50000000);
  assert.equal(layer('P2').rules.find(r => r.rule === 'sum_insured').result.value.amountMinor, 100000000);
  assert.equal(layer('P2').rules.find(r => r.rule === 'waiting_period' && r.topic === 'pre_existing'), undefined, 'P1 waiting period is not evaluated on P2');
});

test('a policy-wide continuity record never completes a waiting period, named member or not; enrolment is always per member', () => {
  const memberB = { memberId: 'member-b', scope: 'member' };
  const policyWide = fact({ factType: 'continuous_cover', value: { since: '2020-01-01', uninterrupted: true } });
  const cat = build([reviewed([WP, policyWide, fact({ factType: 'member_enrolment', value: { status: 'enrolled' } })])]);
  const forMember = evaluateRules(cat.facts, { policyId: 'P1', topic: 'pre_existing', asOf: '2026-08-01', memberId: 'member-b' }, ['waiting_period'])[0];
  assert.deepEqual(forMember.completion, { state: 'unknown', reason: 'continuity_not_evidenced' });
  assert.deepEqual(wp(cat, '2026-08-01', 'pre_existing', null).completion, { state: 'unknown', reason: 'continuity_not_evidenced' }, 'a floater record would otherwise cover a member who joined later');
  const enrolment = memberId => evaluateRules(cat.facts, { policyId: 'P1', memberId }, ['member_enrolment'])[0].result;
  for (const memberId of [null, 'member-b']) {
    assert.equal(enrolment(memberId).status, 'unknown');
    assert.ok(enrolment(memberId).excluded.some(item => item.reason === 'member_scope_missing'));
  }
  const own = build([reviewed([WP, fact({ factType: 'continuous_cover', subject: memberB, value: { since: '2024-01-01', uninterrupted: true } })])]);
  assert.equal(evaluateRules(own.facts, { policyId: 'P1', topic: 'pre_existing', asOf: '2026-08-01', memberId: 'member-b' }, ['waiting_period'])[0].completion.state, 'completed');
});

test('a newer family version that is not in effect yet does not displace the one that is, so a real conflict stays a conflict', () => {
  const rows = [
    { id: 'a1', documentId: 'da', sourceVersion: '1', page: 1, digest: 'ga1' }, { id: 'a2', documentId: 'da', sourceVersion: '2', page: 1, digest: 'ga2' },
    { id: 'b1', documentId: 'db', sourceVersion: '1', page: 1, digest: 'gb1' },
  ];
  const cap = amount => ({ kind: 'amount', amountMinor: amount, currency: 'INR', basis: 'per_day' });
  const cat = buildDecisionCatalogue({ householdId: 'h1', clauseRows: rows, policies: [{ policyId: 'P1', kind: 'personal' }], batches: [reviewed([
    fact({ documentId: 'da', sourceVersion: '1', familyId: 'fam-a', clauseIds: ['a1'], factType: 'room_rent_limit', value: cap(10000), effective: { from: '2026-01-01', to: '2026-12-31' } }),
    fact({ documentId: 'da', sourceVersion: '2', familyId: 'fam-a', clauseIds: ['a2'], factType: 'room_rent_limit', value: cap(30000), effective: { from: '2027-01-01' } }),
    fact({ documentId: 'db', sourceVersion: '1', familyId: 'fam-b', clauseIds: ['b1'], factType: 'room_rent_limit', value: cap(20000) }),
  ])] });
  const at = asOf => evaluateRules(cat.facts, { policyId: 'P1', asOf }, ['room_rent_limit'])[0].result;
  assert.equal(at('2026-06-01').status, 'conflict');
  assert.ok(!at('2026-06-01').excluded.some(item => item.reason === 'older_version'));
  assert.equal(at('2027-06-01').status, 'conflict', 'v2 and family B disagree once v2 is in effect');
  assert.ok(at('2027-06-01').excluded.some(item => item.reason === 'not_in_effect'));
});
