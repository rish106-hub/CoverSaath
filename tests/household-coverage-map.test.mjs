// WP3: one coverage position per policy; no fact crosses a member, policy or date boundary. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandoff, run, enrolled, notEnrolled, sublimit, sumInsured, waitingPeriod, exclusion, policyPeriod, MEMBER_A, MEMBER_B } from './support/household-fixtures.mjs';

const S = { procedureText: 'cataract surgery', memberId: MEMBER_A };
const one = (facts, over = {}, scope = {}) => makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', kind: 'family_floater', coverBasis: 'shared', facts, ...over }], ...scope });
const term = (position, rule, topic = '') => [...position.documentedTerms, ...position.documentedRestrictions].find(t => t.rule === rule && t.topic === topic);

test('a documented, enrolled member gets an established position with cited terms and restrictions', () => {
  const { positions } = run(S, [one([enrolled(), sublimit('cataract', 3000000), sumInsured(50000000), waitingPeriod(24)])]);
  const [p] = positions;
  assert.equal(p.memberApplicability.state, 'established');
  assert.ok(p.memberApplicability.citations.length > 0);
  assert.equal(p.associationState, 'verified');
  assert.deepEqual(p.policyType, { kind: 'family_floater', coverBasis: 'shared', resolved: true });
  assert.equal(term(p, 'sublimit', 'cataract').restrictionKind, 'limit_or_condition');
  assert.ok(p.documentedRestrictions.some(r => r.rule === 'sublimit' && r.topic === 'cataract'), 'a sublimit is a documented restriction on its own policy');
  assert.ok(p.documentedRestrictions.some(r => r.rule === 'waiting_period'));
  assert.equal(term(p, 'sum_insured').appliesToMember, 'established');
  assert.ok([...p.documentedTerms, ...p.documentedRestrictions].every(t => t.citations.length > 0 && t.provenance === 'reviewed_contractual_evidence'));
  assert.ok(p.citations.length >= 3);
});

test('a policy-wide benefit alone does not prove the member is insured', () => {
  const { positions } = run(S, [one([sublimit('cataract', 3000000), sumInsured(50000000)])]);
  const [p] = positions;
  assert.equal(p.memberApplicability.state, 'unresolved');
  assert.equal(p.memberApplicability.reasonCode, 'enrolment_not_evidenced');
  assert.equal(term(p, 'sublimit', 'cataract').appliesToMember, 'unresolved', 'the term stays visible but is flagged');
  assert.ok(p.uncertainties.some(u => u.gapType === 'unresolved_member_applicability'));
});

test('without a named member, applicability is not specified, not guessed from a relation', () => {
  const { positions } = run({ procedureText: 'cataract surgery', reportedMemberRelation: 'father' }, [makeHandoff({ memberId: null, policies: [{ id: 'P1', facts: [enrolled()] }] })]);
  assert.equal(positions[0].memberApplicability.state, 'member_not_specified');
});

test("one member's enrolment never applies to another member", () => {
  // The handoff is scoped to member B; member A's enrolment fact is filtered out by Block 3.
  const handoff = makeHandoff({ memberId: MEMBER_B, policies: [{ id: 'P1', facts: [enrolled(MEMBER_A)] }] });
  const { positions } = run({ ...S, memberId: MEMBER_B }, [handoff]);
  assert.equal(positions[0].memberApplicability.state, 'unresolved');
  assert.deepEqual(positions[0].memberApplicability.citations, []);
});

test('a documented non-enrolment is a cited restriction on that policy only', () => {
  const { positions } = run(S, [one([notEnrolled()])]);
  assert.equal(positions[0].memberApplicability.state, 'not_enrolled');
  const r = positions[0].documentedRestrictions.find(x => x.restrictionKind === 'non_enrolment');
  assert.ok(r && r.citations.length > 0);
});

test('policy kinds are preserved and never guessed', () => {
  for (const kind of ['personal', 'family_floater', 'group', 'top_up', 'super_top_up', 'unresolved']) {
    const { positions } = run(S, [one([], { kind })]);
    assert.equal(positions[0].policyType.kind, kind);
    assert.equal(positions[0].policyType.resolved, kind !== 'unresolved');
  }
});

test('a reported policy type never overrides evidence; it is recorded as user_reported', () => {
  const unresolved = run({ ...S, reportedPolicyType: 'family' }, [one([], { kind: 'unresolved' })]).positions[0];
  assert.equal(unresolved.policyType.kind, 'unresolved');
  assert.ok(unresolved.uncertainties.some(u => u.reasonCode === 'reported_policy_type_unverified' && u.provenance === 'user_reported'));
  const differs = run({ ...S, reportedPolicyType: 'family' }, [one([], { kind: 'personal' })]).positions[0];
  assert.equal(differs.policyType.kind, 'personal');
  assert.ok(differs.uncertainties.some(u => u.reasonCode === 'reported_policy_type_differs_from_evidence'));
  const agrees = run({ ...S, reportedPolicyType: 'family' }, [one([], { kind: 'family_floater' })]).positions[0];
  assert.ok(!agrees.uncertainties.some(u => u.rule === 'policy_type'));
});

test('unverified, conflicting and unknown findings are listed separately from documented terms', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', verified: false, facts: [sublimit('cataract', 3000000), enrolled()] }] });
  const { positions } = run(S, [handoff]);
  assert.equal(positions[0].documentedTerms.length + positions[0].documentedRestrictions.length, 0);
  assert.ok(positions[0].uncertainties.some(u => u.rule === 'sublimit' && u.topic === 'cataract' && u.state === 'unverified' && u.candidateAvailable === true));
  assert.ok(!JSON.stringify(positions).includes('3000000'));
});

test('conditions, exceptions and overrides stay attached to the term', () => {
  const { positions } = run(S, [one([enrolled(), sublimit('cataract', 3000000, { conditions: ['Only after the waiting period'], exceptions: ['Not for cosmetic lenses'], overrides: ['Endorsement 3 revises this'] })])]);
  const t = term(positions[0], 'sublimit', 'cataract');
  assert.equal(t.conditional, true);
  assert.deepEqual(t.conditions, ['Only after the waiting period']);
  assert.deepEqual(t.exceptions, ['Not for cosmetic lenses']);
  assert.deepEqual(t.overrides, ['Endorsement 3 revises this']);
});

test('a missing topic-specific term is an evidence gap, never an exclusion', () => {
  const { positions } = run(S, [one([enrolled(), sumInsured(50000000)])]);
  const p = positions[0];
  assert.ok(p.uncertainties.some(u => u.reasonCode === 'topic_evidence_absent' && u.gapType === 'evidence_gap'));
  assert.ok(!p.documentedRestrictions.some(r => r.topic === 'cataract'), 'no restriction is created from silence');
  assert.ok(!JSON.stringify(p).toLowerCase().includes('uncovered'));
});

test('a superseded wording is never revived to fill a term the newer wording does not state', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [
    enrolled(), sublimit('cataract', 3000000, { version: '1', familyId: 'wording' }), sumInsured(50000000, { version: '2', familyId: 'wording' }),
  ] }] });
  const { positions } = run(S, [handoff]);
  assert.equal(term(positions[0], 'sublimit', 'cataract'), undefined, 'version 1 sublimit is not used once version 2 exists');
  assert.ok(term(positions[0], 'sum_insured'));
});

test('a future endorsement is not applied before it is in effect', () => {
  const facts = [enrolled(), sublimit('cataract', 3000000, { sourceType: 'endorsement', effective: { from: '2027-01-01' } })];
  const handoff = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts }] });
  const { positions } = run({ ...S, plannedDate: '2026-11-14' }, [handoff]);
  assert.equal(term(positions[0], 'sublimit', 'cataract'), undefined);
});

test('a dated fact with only a planned month stays as_of_required; the month is not turned into a day', () => {
  const facts = [enrolled(), sublimit('cataract', 3000000, { effective: { from: '2026-04-01', to: '2027-03-31' } })];
  const { positions, scenario } = run({ ...S, plannedMonth: '2026-11' }, [one(facts)]);
  assert.equal(scenario.effective.plannedDate, null);
  assert.equal(term(positions[0], 'sublimit', 'cataract'), undefined);
  assert.ok(positions[0].uncertainties.some(u => u.rule === 'sublimit' && u.reasonCode === 'as_of_required'));
  assert.ok(positions[0].limitations.some(l => /planned month is known/.test(l)));
  // With an exact date inside the window the same fact applies.
  const dated = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts }] });
  assert.ok(term(run({ ...S, plannedDate: '2026-11-14' }, [dated]).positions[0], 'sublimit', 'cataract'));
});

test('a dynamic network item is a pending check, never a known value', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(), { type: 'network_status', value: { provider: 'Synthetic Hospital', status: 'network' } }] }] });
  const { positions } = run({ ...S, scenarioType: 'cashless_information' }, [handoff]);
  assert.equal(positions[0].dynamicChecks.length, 1);
  assert.equal(positions[0].dynamicChecks[0].status, 'not_performed');
  assert.equal(term(positions[0], 'network_status'), undefined);
  assert.ok(!JSON.stringify(positions).includes('Synthetic Hospital'));
});

test('limits stay on their own policy and nothing is totalled or recommended', () => {
  const h = makeHandoff({ memberId: MEMBER_A, policies: [
    { id: 'P1', facts: [enrolled(), sumInsured(50000000)] }, { id: 'P2', facts: [enrolled(), sumInsured(20000000)] },
  ] });
  const { positions, preview } = run(S, [h]);
  assert.equal(positions.length, 2);
  const json = JSON.stringify(preview());
  assert.ok(!json.includes('70000000'), 'no sum of limits');
  assert.ok(!/recommend|suitable|best policy|purchase/i.test(json));
  assert.ok(positions.every(p => p.limitations.some(l => /not added/.test(l))));
});

test('a policy period that does not contain the exact date is shown as documented, not hidden', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled(), policyPeriod('2025-01-01', '2025-12-31')] }] });
  const { positions } = run({ ...S, plannedDate: '2026-11-14' }, [handoff]);
  assert.ok(term(positions[0], 'policy_period'));
});

test('exclusions are documented restrictions only when known and cited', () => {
  const { positions } = run(S, [one([enrolled(), exclusion('cataract')])]);
  const r = positions[0].documentedRestrictions.find(x => x.rule === 'exclusion');
  assert.ok(r && r.restrictionKind === 'exclusion' && r.citations.length > 0);
  const unreviewed = run(S, [one([enrolled(), exclusion('cataract', { review: 'model' })])]).positions[0];
  assert.equal(unreviewed.documentedRestrictions.filter(x => x.rule === 'exclusion').length, 0, 'a model-read exclusion is not a documented restriction');
});

test('a waiting-period completion gap is listed only where waiting periods are relevant', () => {
  const facts = [enrolled(), waitingPeriod(24)];
  const emergency = run({ ...S, scenarioType: 'emergency_admission' }, [one(facts)]).positions[0];
  assert.ok(!emergency.uncertainties.some(u => u.rule === 'waiting_period_completion'));
  const planned = run(S, [one(facts)]).positions[0];
  assert.ok(planned.uncertainties.some(u => u.rule === 'waiting_period_completion'));
});
