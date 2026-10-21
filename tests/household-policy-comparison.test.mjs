// WP4: cross-policy comparison is conservative. Possible overlap is not payment; limits are never added. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandoff, run, enrolled, sublimit, sumInsured, exclusion, policyPeriod, MEMBER_A, MEMBER_B } from './support/household-fixtures.mjs';

const S = { procedureText: 'cataract surgery', memberId: MEMBER_A, plannedDate: '2026-11-14' };
const two = (p1, p2, over = {}) => makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000), ...p1.facts ?? []], ...p1.over }, { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000), ...p2.facts ?? []], ...p2.over }], ...over });
const cmp = (handoff, scenario = S) => run(scenario, [handoff]).comparisons;

test('two established policies documenting the same topic give a possible overlap with separate cited values', () => {
  const c = cmp(two({}, {}));
  assert.equal(c.possibleOverlap.length, 1);
  const o = c.possibleOverlap[0];
  assert.deepEqual([o.state, o.rule, o.topic, o.memberScoped], ['possible_overlap', 'sublimit', 'cataract', true]);
  assert.deepEqual(o.policies.map(p => p.value.amountMinor).sort(), [3000000, 5000000]);
  assert.ok(o.policies.every(p => p.citations.length > 0));
  assert.match(o.note, /not confirmed coordination/);
  assert.ok(c.unresolvedCoordination.some(u => u.code === 'coordination_not_established'));
  assert.ok(!JSON.stringify(c).includes('8000000'), 'limits are never added');
});

test('the overlap needs an exact date', () => {
  const c = cmp(two({}, {}), { procedureText: 'cataract surgery', memberId: MEMBER_A });
  const noDate = run({ procedureText: 'cataract surgery', memberId: MEMBER_A }, [makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 1)] }, { id: 'P2', facts: [enrolled(), sublimit('cataract', 2)] }] })]).comparisons;
  assert.equal(noDate.possibleOverlap.length, 0);
  assert.ok(noDate.reasons.includes('exact_date_required_for_overlap'));
  assert.equal(c.possibleOverlap.length, 0);
});

test('no overlap when the member is not named', () => {
  const handoff = makeHandoff({ memberId: null, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [sublimit('cataract', 1)] }, { id: 'P2', facts: [sublimit('cataract', 2)] }] });
  const c = run({ procedureText: 'cataract surgery', plannedDate: '2026-11-14' }, [handoff]).comparisons;
  assert.equal(c.possibleOverlap.length, 0);
  assert.ok(c.reasons.includes('member_not_identified'));
});

test('policies enrolling different members do not overlap for this member', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', facts: [enrolled(MEMBER_A), sublimit('cataract', 3000000)] },
    { id: 'P2', facts: [enrolled(MEMBER_B), sublimit('cataract', 5000000)] }, // enrols B, not A
  ] });
  const c = cmp(handoff);
  assert.equal(c.possibleOverlap.length, 0);
  assert.ok(c.reasons.includes('member_applicability_unresolved_for_some_policies'));
  assert.ok(c.evidenceGaps.some(g => g.gapType === 'unresolved_member_applicability'));
});

test('a policy associated only by user report or unverified association is not compared as established', () => {
  const c = cmp(two({}, { over: { verified: false } }));
  assert.equal(c.possibleOverlap.length, 0);
});

test('a policy with a model-read (unreviewed) term does not overlap', () => {
  const c = cmp(makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] },
    { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000, { review: 'model' })] },
  ] }));
  assert.equal(c.possibleOverlap.length, 0);
  assert.ok(c.evidenceGaps.some(g => g.reasonCode === 'not_stated_in_this_policys_evidence'), 'a gap, not an exclusion');
});

test('a policy period that excludes the date removes that policy from the overlap', () => {
  const c = cmp(two({}, { facts: [policyPeriod('2024-01-01', '2024-12-31')] }));
  assert.equal(c.possibleOverlap.length, 0);
});

test('an older policy version superseded by a newer one cannot contribute the old value', () => {
  const h = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] },
    { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000, { version: '1', familyId: 'w' }), sumInsured(1000000, { version: '2', familyId: 'w' })] },
  ] });
  assert.equal(cmp(h).possibleOverlap.length, 0);
});

test('conflicting values for one benefit across inputs suppress that overlap and mark the comparison', () => {
  const a = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', answerId: 'a1', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }, { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000)] }] });
  const b = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', answerId: 'a2', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3500000, { documentId: 'doc-v2' })] }] });
  const { comparisons } = run(S, [a, b]);
  assert.equal(comparisons.possibleOverlap.length, 0);
  assert.ok(comparisons.reasons.includes('source_conflict_present'));
  assert.ok(comparisons.evidenceGaps.some(g => g.reasonCode === 'cross_input_conflict'));
});

test('base plus top-up: the threshold is flagged, nothing is stacked', () => {
  const h = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', kind: 'personal', coverBasis: 'individual', facts: [enrolled(), sumInsured(30000000)] },
    { id: 'P2', kind: 'super_top_up', coverBasis: 'shared', facts: [enrolled(), sumInsured(100000000), { type: 'deductible', value: { amountMinor: 30000000, currency: 'INR', type: 'per_claim' } }] },
  ] });
  const { comparisons, preview } = run(S, [h]);
  assert.ok(comparisons.unresolvedCoordination.some(u => u.code === 'top_up_threshold_not_established'));
  assert.ok(comparisons.unresolvedCoordination.some(u => u.code === 'coordination_not_established'));
  assert.equal(comparisons.possibleOverlap.length, 0, 'sum insured and a deductible are not an overlapping benefit');
  const json = JSON.stringify(preview());
  assert.ok(!json.includes('130000000') && !json.includes('70000000'), 'no stacked or net amount is produced');
});

test('a topic documented in one policy and absent in another is an evidence gap on the other', () => {
  const h = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }, { id: 'P2', facts: [enrolled(), sumInsured(1)] },
  ] });
  const { comparisons, positions } = run(S, [h]);
  const gap = comparisons.evidenceGaps.find(g => g.reasonCode === 'not_stated_in_this_policys_evidence');
  assert.ok(gap);
  const p2 = positions.find(p => p.documentedTerms.some(t => t.rule === 'sum_insured'));
  assert.equal(gap.policyId, p2.policyId);
  assert.equal(comparisons.documentedRestrictions.filter(r => r.policyId === p2.policyId && r.topic === 'cataract').length, 0);
});

test('a documented exclusion in one policy is not read as a household-wide exclusion while the other policy is unresolved', () => {
  const h = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', facts: [enrolled(), exclusion('cataract')] }, { id: 'P2', facts: [sumInsured(5000000)] }, // P2: member not evidenced
  ] });
  const { comparisons, positions } = run(S, [h]);
  const restriction = comparisons.documentedRestrictions.find(r => r.rule === 'exclusion');
  assert.equal(restriction.scope, 'this_policy_only');
  assert.ok(restriction.citations.length > 0);
  const p2 = positions.find(p => p.memberApplicability.state === 'unresolved');
  assert.ok(p2);
  assert.ok(comparisons.evidenceGaps.some(g => g.policyId === p2.policyId && g.gapType === 'unresolved_member_applicability'));
  assert.ok(!comparisons.documentedRestrictions.some(r => r.policyId === p2.policyId));
  assert.ok(!/uncovered|household-wide|not covered/i.test(JSON.stringify(comparisons)));
});

test('a single policy reports why no comparison is possible', () => {
  const c = cmp(makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled()] }] }));
  assert.equal(c.status, 'not_comparable');
  assert.deepEqual(c.reasons, ['single_policy_only']);
  assert.deepEqual(c.unresolvedCoordination, []);
});

test('comparison output is deterministic and independent of source order', () => {
  const a = two({}, {});
  const first = JSON.stringify(run(S, [a]).comparisons);
  assert.equal(JSON.stringify(run(S, [a]).comparisons), first);
  const reordered = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000)] }, { id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] },
  ] });
  assert.equal(JSON.stringify(run(S, [reordered]).comparisons), first);
});
