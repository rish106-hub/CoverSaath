// WP5: deterministic context-gap rules G01 to G10. Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextGaps } from '../src/features/household-reasoning/index.js';
import { makeHandoff, run, okSource, enrolled, sublimit, sumInsured, waitingPeriod, continuity, MEMBER_A, MEMBER_B } from './support/household-fixtures.mjs';

const gapsOf = (scenario, handoffs, options) => {
  const r = run(scenario, handoffs, options);
  return buildContextGaps({ scenario: r.scenario, normalized: r.normalized, positions: r.positions, comparisons: r.comparisons });
};
const find = (gaps, key) => gaps.find(g => g.gapKey === key);
const keys = gaps => gaps.map(g => g.gapKey);
const S = { procedureText: 'cataract surgery', memberId: MEMBER_A };
const one = (facts, scope = {}, over = {}) => makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts, ...over }], ...scope });

test('G01: no eligible current source -> insufficient, document request, no inferred policy contents', () => {
  const gaps = gapsOf({ ...S, reportedPolicyType: 'family' }, [], { sourcesOverride: [{ sourceIndex: 0, status: 'revalidation_required', reason: 'answer_stale' }] });
  assert.ok(keys(gaps).includes('no_current_source'));
  assert.equal(find(gaps, 'no_current_source').expectedResolver, 'DOCUMENT');
  assert.equal(find(gaps, 'no_current_source').priority, 'P0');
  assert.equal(find(gaps, 'no_current_source').eligibleQuestionId, null, 'a stale source is revalidated, not asked about');
  assert.ok(keys(gaps).includes('source_revalidation_required'));
});

test('G01: empty policy evidence from a usable source still yields reviewed-evidence and schedule gaps', () => {
  const gaps = gapsOf(S, [one([])]);
  assert.ok(keys(gaps).includes('no_reviewed_evidence'));
  assert.equal(find(gaps, 'no_reviewed_evidence').expectedResolver, 'REVIEW');
  assert.equal(find(gaps, 'membership_unestablished').expectedResolver, 'DOCUMENT');
});

test('G02: the member is requested when unidentified and never inferred from a relation', () => {
  const gaps = gapsOf({ procedureText: 'cataract surgery', reportedMemberRelation: 'father' }, [makeHandoff({ memberId: null, policies: [{ id: 'P1', facts: [] }] })]);
  const g = find(gaps, 'member_unidentified');
  assert.deepEqual([g.expectedResolver, g.eligibleQuestionId, g.priority, g.blocking, g.reason], ['USER', 'Q_MEMBER', 'P0', true, 'relation_reported_member_not_selected']);
  assert.equal(find(gapsOf(S, [one([enrolled()])]), 'member_unidentified'), undefined);
  const viaAnswer = gapsOf({ procedureText: 'cataract surgery', answers: { member_id: MEMBER_A } }, [one([enrolled()])]);
  assert.equal(find(viaAnswer, 'member_unidentified'), undefined);
  const skipped = find(gapsOf({ procedureText: 'cataract surgery', answers: { member_id: 'SKIPPED' } }, [makeHandoff({ memberId: null, policies: [{ id: 'P1', facts: [] }] })]), 'member_unidentified');
  assert.equal(skipped.currentState, 'user_skipped');
});

test('G03: known member but no enrolment evidence -> a schedule is preferred over asking from memory', () => {
  const g = find(gapsOf(S, [one([sublimit('cataract', 3000000)])]), 'membership_unestablished');
  assert.deepEqual([g.expectedResolver, g.eligibleQuestionId, g.priority, g.reason], ['DOCUMENT', 'Q_POLICY_SCHEDULE', 'P0', 'member_enrolment_not_evidenced']);
  assert.ok(g.relatedRuleKeys.includes('member_enrolment/'));
  assert.equal(find(gapsOf(S, [one([enrolled()])]), 'membership_unestablished'), undefined, 'documented enrolment needs no schedule');
  const yes = find(gapsOf({ ...S, answers: { policy_schedule_available: 'YES' } }, [one([])]), 'membership_unestablished');
  assert.equal(yes.currentState, 'user_has_document_not_yet_processed');
});

test('G03: a verified non-enrolment is documented, not a gap', () => {
  const handoff = one([{ type: 'member_enrolment', value: { status: 'not_enrolled' }, member: MEMBER_A }]);
  assert.equal(find(gapsOf(S, [handoff]), 'membership_unestablished'), undefined);
});

test('G04: a month without an exact date asks for the date only when it could change applicability', () => {
  const dated = [enrolled(), sublimit('cataract', 3000000, { effective: { from: '2026-04-01', to: '2027-03-31' } })];
  const material = find(gapsOf({ ...S, plannedMonth: '2026-11' }, [one(dated)]), 'exact_date_required');
  assert.deepEqual([material.expectedResolver, material.eligibleQuestionId, material.priority, material.currentState, material.blocking], ['USER', 'Q_EXACT_DATE', 'P1', 'month_only', true]);
  assert.ok(material.relatedRuleKeys.includes('sublimit/cataract'));
  const undetermined = find(gapsOf({ ...S, plannedMonth: '2026-11' }, [one([enrolled()])]), 'exact_date_materiality_undetermined');
  assert.deepEqual([undetermined.eligibleQuestionId, undetermined.blocking, undetermined.priority], [null, false, 'P2']);
  const supplied = gapsOf({ ...S, plannedDate: '2026-11-14' }, [one([enrolled()], { asOf: '2026-11-14' })]);
  assert.ok(!keys(supplied).some(k => k.startsWith('exact_date')), 'an exact date already supplied raises no date gap');
  const waiting = gapsOf(S, [one([enrolled(), waitingPeriod(24)])]);
  assert.ok(keys(waiting).includes('exact_date_required'), 'waiting-period completion needs a date');
});

test('G04: "I do not know" is kept as an answer; the date stays required and is not asked again', () => {
  const dated = [enrolled(), sublimit('cataract', 3000000, { effective: { from: '2026-04-01', to: '2027-03-31' } })];
  const g = find(gapsOf({ ...S, plannedMonth: '2026-11', answers: { exact_date: 'I_DO_NOT_KNOW' } }, [one(dated)]), 'exact_date_required');
  assert.equal(g.currentState, 'user_unknown');
  assert.equal(g.blocking, true);
});

test('G05: a generic procedure name needs the estimate name; a specific one does not', () => {
  const generic = find(gapsOf({ memberId: MEMBER_A, procedureText: 'some surgery' }, [one([enrolled()])]), 'procedure_unspecific');
  assert.deepEqual([generic.expectedResolver, generic.eligibleQuestionId, generic.priority], ['USER', 'Q_PROCEDURE_DETAIL', 'P1']);
  assert.ok(find(gapsOf({ memberId: MEMBER_A }, [one([enrolled()])]), 'procedure_unspecific'));
  assert.equal(find(gapsOf(S, [one([enrolled()])]), 'procedure_unspecific'), undefined);
  assert.equal(find(gapsOf({ memberId: MEMBER_A, procedureText: 'surgery', answers: { procedure_detail: 'cataract surgery' } }, [one([enrolled()])]), 'procedure_unspecific'), undefined);
  assert.equal(find(gapsOf({ scenarioType: 'general_benefit', memberId: MEMBER_A, procedureText: undefined }, [one([enrolled()])]), 'procedure_unspecific'), undefined, 'only a planned procedure needs an estimate name');
});

test('G06: a hospital named without a branch asks for the branch and emits a dynamic check; asking never verifies the network', () => {
  const h = { ...S, hospital: { name: 'Healtworld Hospital', city: 'Durgapur' } };
  const gaps = gapsOf(h, [one([enrolled()])]);
  const branch = find(gaps, 'hospital_branch_missing');
  assert.deepEqual([branch.eligibleQuestionId, branch.priority], ['Q_HOSPITAL_BRANCH', 'P1']);
  assert.equal(find(gaps, 'hospital_city_missing'), undefined);
  const net = find(gaps, 'hospital_network_unverified');
  assert.deepEqual([net.expectedResolver, net.currentState], ['DYNAMIC_EXTERNAL', 'not_performed']);
  const withAddress = gapsOf({ ...h, hospital: { ...h.hospital, branch: 'Benachity, Durgapur' } }, [one([enrolled()])]);
  assert.equal(find(withAddress, 'hospital_branch_missing'), undefined);
  assert.ok(find(withAddress, 'hospital_network_unverified'), 'a full address still leaves the network unverified');
});

test('G06: city is asked when it is the missing fact; a cashless scenario without a name asks for the hospital first', () => {
  const noCity = gapsOf({ ...S, hospital: { name: 'Healtworld Hospital' } }, [one([enrolled()])]);
  assert.ok(find(noCity, 'hospital_city_missing') && find(noCity, 'hospital_branch_missing'));
  const cashless = gapsOf({ ...S, scenarioType: 'cashless_information' }, [one([enrolled()])]);
  assert.ok(find(cashless, 'hospital_name_missing'));
  assert.equal(find(cashless, 'hospital_city_missing'), undefined, 'city and branch wait for a name');
  assert.equal(find(cashless, 'hospital_network_unverified').blocking, true);
});

test('G06: hospital questions do not arise in a non-hospital scenario', () => {
  const gaps = gapsOf({ ...S, scenarioType: 'general_benefit', topic: 'cataract' }, [one([enrolled()])]);
  assert.ok(!keys(gaps).some(k => k.startsWith('hospital_')));
  assert.ok(!keys(gapsOf({ ...S, scenarioType: 'policy_comparison' }, [one([enrolled()])])).some(k => k.startsWith('hospital_')));
});

test('G06: an unverified cashless claim in the policy stays a pending check', () => {
  const handoff = one([enrolled(), { type: 'network_status', value: { provider: 'Synthetic Hospital', status: 'network' } }]);
  const gaps = gapsOf({ ...S, scenarioType: 'cashless_information', hospital: { name: 'Synthetic Hospital', city: 'X', branch: 'Y' } }, [handoff]);
  assert.ok(find(gaps, 'policy_dynamic_checks_pending'));
  assert.equal(find(gaps, 'policy_dynamic_checks_pending').expectedResolver, 'DYNAMIC_EXTERNAL');
});

test('G07: a known waiting period without verified continuity asks for a continuity document, not a ruling', () => {
  const handoff = one([enrolled(), waitingPeriod(24)], { asOf: '2026-11-14' });
  const g = find(gapsOf({ ...S, plannedDate: '2026-11-14' }, [handoff]), 'continuity_unverified');
  assert.deepEqual([g.expectedResolver, g.eligibleQuestionId, g.reason], ['DOCUMENT', 'Q_CONTINUITY_DOCUMENT', 'continuity_not_evidenced']);
  const reported = find(gapsOf({ ...S, plannedDate: '2026-11-14', answers: { uninterrupted_cover_reported: 'YES' } }, [handoff]), 'continuity_unverified');
  assert.equal(reported.reason, 'uninterrupted_cover_reported_not_verified', 'a reported statement stays user_reported');
});

test('G07: verified continuity for the right member closes the gap; another member\'s continuity does not', () => {
  const ok = one([enrolled(), waitingPeriod(24), continuity('2023-01-01')], { asOf: '2026-11-14' });
  const closed = gapsOf({ ...S, plannedDate: '2026-11-14' }, [ok]);
  assert.equal(find(closed, 'continuity_unverified'), undefined);
  const wrong = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled(), waitingPeriod(24), continuity('2023-01-01', MEMBER_B)] }] });
  assert.ok(find(gapsOf({ ...S, plannedDate: '2026-11-14' }, [wrong]), 'continuity_unverified'), 'wrong-member continuity is not used');
});

test('G08: each layer is judged separately; a second policy is requested only when the question needs it', () => {
  const layered = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled()] }, { id: 'P2', facts: [sumInsured(1)] }] });
  const layer = find(gapsOf(S, [layered]), 'layer_applicability_unresolved');
  assert.equal(layer.relatedPolicyIds.length, 1);
  assert.equal(layer.priority, 'P2');
  const comparison = find(gapsOf({ ...S, scenarioType: 'policy_comparison' }, [one([enrolled()])]), 'second_policy_not_provided');
  assert.deepEqual([comparison.eligibleQuestionId, comparison.expectedResolver], ['Q_OTHER_POLICY', 'USER']);
  const topUp = find(gapsOf({ ...S, reportedPolicyType: 'top_up' }, [one([enrolled()])]), 'second_policy_not_provided');
  assert.equal(topUp.reason, 'reported_top_up_without_base_policy_evidence');
  assert.equal(find(gapsOf(S, [one([enrolled()])]), 'second_policy_not_provided'), undefined, 'a single-policy question never asks for another policy');
  const yes = find(gapsOf({ ...S, scenarioType: 'policy_comparison', answers: { other_policy_available: 'YES' } }, [one([enrolled()])]), 'second_policy_not_provided');
  assert.deepEqual([yes.expectedResolver, yes.eligibleQuestionId], ['DOCUMENT', null]);
});

test('G09: a conflict goes to review and is never put to the user to arbitrate', () => {
  const a = makeHandoff({ memberId: MEMBER_A, answerId: 'a1', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }] });
  const b = makeHandoff({ memberId: MEMBER_A, answerId: 'a2', policies: [{ id: 'P1', facts: [sublimit('cataract', 4000000, { documentId: 'doc-v2' })] }] });
  const gaps = gapsOf(S, [a, b]);
  const g = find(gaps, 'source_conflict');
  assert.deepEqual([g.expectedResolver, g.priority, g.eligibleQuestionId, g.blocking], ['REVIEW', 'P0', null, true]);
  assert.ok(g.relatedRuleKeys.includes('sublimit/cataract'));
  assert.ok(gaps.filter(x => x.eligibleQuestionId).every(x => !/conflict|wording|which/i.test(x.gapKey)));
});

test('G09: a stale source asks for an updated document, not a user choice', () => {
  const gaps = gapsOf(S, [], { sourcesOverride: [okSource(one([enrolled()]), 0), { sourceIndex: 1, status: 'revalidation_required', reason: 'answer_stale' }] });
  const g = find(gaps, 'source_revalidation_required');
  assert.deepEqual([g.expectedResolver, g.eligibleQuestionId, g.priority], ['DOCUMENT', null, 'P0']);
});

test('G10: consent is enforced before the engine; a gap never mentions an unauthorised source', () => {
  // The engine only sees authorised handoffs or an unavailable marker with a closed reason code.
  const gaps = gapsOf(S, [], { sourcesOverride: [{ sourceIndex: 0, status: 'revalidation_required', reason: 'Source belongs to household 123' }] });
  assert.ok(!JSON.stringify(gaps).includes('household 123'));
});

test('a user-reported benefit never changes the gaps that evidence determines', () => {
  const evidence = [enrolled(), { type: 'exclusion', topic: 'cataract', value: { kind: 'permanent' } }];
  const plain = gapsOf(S, [one(evidence)]);
  const claimed = gapsOf({ ...S, procedureText: 'cataract surgery, my policy covers cataract up to 50000 and nothing is excluded', topic: 'cataract covered in full' }, [one(evidence)]);
  assert.deepEqual(keys(claimed), keys(plain));
});

test('gaps are deterministic, sorted and carry every contract field', () => {
  const handoff = one([enrolled(), waitingPeriod(24)]);
  const a = gapsOf({ ...S, hospital: { name: 'Healtworld Hospital' } }, [handoff]);
  const b = gapsOf({ ...S, hospital: { name: 'Healtworld Hospital' } }, [handoff]);
  assert.deepEqual(a, b);
  assert.deepEqual(keys(a), [...keys(a)].sort());
  for (const g of a) {
    for (const field of ['gapKey', 'sourceClass', 'reason', 'impact', 'priority', 'currentState', 'expectedResolver', 'blocking', 'eligibleQuestionId', 'relatedPolicyIds', 'relatedRuleKeys']) assert.ok(field in g, `${g.gapKey} lacks ${field}`);
  }
});

test('G05: explicit uncertainty text stays nonspecific and still asks for the procedure', () => {
  for (const procedureText of ["I don't know", 'not sure', 'I_DO_NOT_KNOW', 'SKIPPED', 'unknown yet', 'surgery, not decided']) {
    const gap = find(gapsOf({ memberId: MEMBER_A, procedureText }, [one([enrolled()])]), 'procedure_unspecific');
    assert.equal(gap?.eligibleQuestionId, 'Q_PROCEDURE_DETAIL', procedureText);
  }
});
