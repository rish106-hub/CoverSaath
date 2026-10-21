// WP7: scenarios S1 to S5 on one pipeline, the illustrative cataract journey, and next actions that never claim completion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHandoff, run, enrolled, sublimit, sumInsured, waitingPeriod, exclusion, MEMBER_A } from './support/household-fixtures.mjs';

const JOURNEY = {
  reportedMemberRelation: 'father', procedureText: 'My father needs cataract surgery next month at Healtworld Hospital.', reportedPolicyType: 'family',
  plannedMonth: '2026-11', hospital: { name: 'Healtworld Hospital', city: 'Durgapur' },
};
const types = preview => preview.nextActions.map(a => a.actionType);
const ids = preview => preview.nextQuestions.map(q => q.questionId);

test('illustrative journey: member and policy unestablished -> schedule first, nothing verified, no network claim', () => {
  // Realistic server evidence: documents read, nothing reviewed, so the handoff holds only unreviewed extractions.
  const handoff = makeHandoff({ memberId: null, policies: [{ id: 'unresolved-answer-1', verified: false, facts: [sublimit('cataract', 3000000, { review: 'model' })] }] });
  const p = run(JOURNEY, [handoff]).preview();
  assert.equal(p.assessmentState, 'insufficient_evidence');
  assert.deepEqual(ids(p), ['Q_MEMBER', 'Q_POLICY_SCHEDULE'], 'at most two questions; the schedule is asked while membership is unestablished');
  assert.equal(p.scenario.provenance, 'user_reported');
  assert.equal(p.scenario.reportedPolicyType, 'family');
  assert.equal(p.scenario.dateSemantics, 'month_only_not_an_exact_day');
  assert.equal(p.scenario.plannedDate, null);
  assert.equal(p.scenario.hospital.identity, 'unresolved');
  assert.equal(p.policies[0].policyType.kind, 'unresolved', 'a reported family policy does not make a family floater');
  assert.ok(p.policies[0].uncertainties.some(u => u.reasonCode === 'reported_policy_type_unverified' && u.provenance === 'user_reported'));
  assert.equal(p.policies[0].memberApplicability.state, 'member_not_specified');
  assert.deepEqual(p.policies[0].documentedTerms.concat(p.policies[0].documentedRestrictions), []);
  assert.ok(!JSON.stringify(p.nextQuestions).toLowerCase().includes('cap'), 'no request to transcribe a contractual cataract cap');
  assert.ok(types(p).includes('identify_existing_document') && types(p).includes('independent_review'));
  const check = p.externalChecks.find(c => c.checkId === 'hospital_network_status');
  assert.ok(check && check.status === 'not_performed' && check.facility.identity === 'unresolved');
  assert.equal(check.facility.provenance, 'user_reported');
  assert.ok(!/network facility|in network|is in the/i.test(JSON.stringify(p.nextActions)), 'no network membership asserted');
});

test('illustrative journey, member chosen and schedule evidence reviewed: branch is asked and the date stays open', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', kind: 'family_floater', coverBasis: 'shared', facts: [enrolled(), exclusion('cosmetic'), waitingPeriod(24)] }] });
  const p = run({ ...JOURNEY, memberId: MEMBER_A }, [handoff]).preview();
  assert.equal(p.assessmentState, 'conditional_evidence_summary');
  assert.deepEqual(ids(p), ['Q_EXACT_DATE', 'Q_HOSPITAL_BRANCH']);
  assert.ok(p.policies[0].uncertainties.some(u => u.reasonCode === 'topic_evidence_absent'), 'the cataract term is an evidence gap, not an exclusion');
  assert.ok(types(p).includes('identify_existing_document'), 'the policy document is processed, not retyped by the user');
  assert.ok(types(p).includes('hospital_confirmation') && types(p).includes('insurer_or_tpa_confirmation'));
  assert.ok(p.nextActions.every(a => a.status === 'pending' && a.reasonCode && a.text));
});

test('illustrative journey, after the answers: branch given, date given, evidence now dated', () => {
  const answers = { exact_date: '2026-11-14', hospital_branch: 'Benachity, Durgapur', policy_schedule_available: 'YES' };
  const handoff = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000), waitingPeriod(24)] }] });
  const p = run({ ...JOURNEY, memberId: MEMBER_A, answers }, [handoff]).preview();
  assert.equal(p.scenario.plannedDate, '2026-11-14');
  assert.equal(p.scenario.dateSemantics, 'exact_date');
  assert.ok(!ids(p).includes('Q_EXACT_DATE') && !ids(p).includes('Q_HOSPITAL_BRANCH'), 'answered questions are not repeated');
  assert.deepEqual(ids(p), ['Q_CONTINUITY_DOCUMENT']);
  const cataract = p.policies[0].documentedRestrictions.find(r => r.rule === 'sublimit' && r.topic === 'cataract');
  assert.deepEqual(cataract.value, { kind: 'amount', amountMinor: 3000000, currency: 'INR' });
  assert.equal(p.scenario.answers.hospital_branch.provenance, 'user_reported');
  assert.equal(p.externalChecks[0].facility.branch, 'Benachity, Durgapur');
  assert.equal(p.externalChecks[0].status, 'not_performed', 'an address never verifies the network');
  const waiting = p.policies[0].documentedRestrictions.find(r => r.rule === 'waiting_period');
  assert.equal(waiting.completion.state, 'unknown', 'completion is not computed from continuity that is not evidenced');
});

test('S1 planned procedure: member, applicable terms, dates and procedural restrictions come first', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }] });
  const p = run({ procedureText: 'cataract surgery', memberId: MEMBER_A }, [handoff]).preview();
  assert.equal(p.scenario.scenarioCode, 'S1');
  assert.equal(p.assessmentState, 'evidence_summary_available');
  assert.deepEqual(ids(p), []);
  assert.deepEqual(types(p), ['identify_existing_document'], 'the waiting period is not evidenced, so its document is requested without blocking the summary');
  const complete = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000), waitingPeriod(24), { type: 'continuous_cover', member: MEMBER_A, value: { since: '2023-01-01', uninterrupted: true } }] }] });
  const done = run({ procedureText: 'cataract surgery', memberId: MEMBER_A, plannedDate: '2026-11-14' }, [complete]).preview();
  assert.deepEqual(types(done), ['no_further_context_needed']);
  assert.equal(done.assessmentState, 'evidence_summary_available');
  assert.equal(done.policies[0].documentedRestrictions.find(r => r.rule === 'waiting_period').completion.state, 'completed');
});

test('S2 general question: the topic and evidence completeness drive the summary', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }] });
  const p = run({ scenarioType: 'general_benefit', topic: 'cataract', memberId: MEMBER_A }, [handoff]).preview();
  assert.equal(p.scenario.scenarioCode, 'S2');
  assert.ok(p.policies[0].documentedRestrictions.some(r => r.topic === 'cataract' && r.relevantToScenario));
  const none = run({ scenarioType: 'general_benefit', memberId: MEMBER_A }, [makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled()] }] })]).preview();
  assert.deepEqual(ids(none), ['Q_BENEFIT_TOPIC'], 'an unknown topic yields a bounded unresolved response and a topic question');
});

test('S2 with an unsupported topic stays unresolved and invents nothing', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(), sumInsured(50000000)] }] });
  const p = run({ scenarioType: 'general_benefit', topic: 'quantum healing sessions', memberId: MEMBER_A }, [handoff]).preview();
  assert.ok(p.policies[0].uncertainties.some(u => u.reasonCode === 'topic_evidence_absent'));
  assert.equal(p.policies[0].documentedRestrictions.filter(r => r.topic !== '').length, 0);
  assert.ok(!/not covered|excluded|uncovered/i.test(JSON.stringify(p.policies[0].uncertainties)));
});

test('S3 comparison: two policies, a possible overlap, unresolved coordination', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [
    { id: 'P1', kind: 'personal', facts: [enrolled(), sublimit('cataract', 3000000)] }, { id: 'P2', kind: 'group', facts: [enrolled(), sublimit('cataract', 5000000)] },
  ] });
  const p = run({ scenarioType: 'policy_comparison', procedureText: 'cataract surgery', memberId: MEMBER_A, plannedDate: '2026-11-14' }, [handoff]).preview();
  assert.equal(p.scenario.scenarioCode, 'S3');
  assert.equal(p.comparisons.possibleOverlap.length, 1);
  assert.ok(p.comparisons.unresolvedCoordination.length >= 1);
  assert.ok(!JSON.stringify(p).includes('8000000'));
  const single = run({ scenarioType: 'policy_comparison', procedureText: 'cataract surgery', memberId: MEMBER_A }, [makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled()] }] })]).preview();
  assert.ok(ids(single).includes('Q_OTHER_POLICY'));
});

test('S4 emergency: actionable contact and verification requirements, no claim prediction, no gating', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled(), sumInsured(50000000)] }] });
  const p = run({ scenarioType: 'emergency_admission', memberId: MEMBER_A, hospital: { name: 'Healtworld Hospital' } }, [handoff]).preview();
  assert.equal(p.scenario.scenarioCode, 'S4');
  assert.ok(types(p).includes('insurer_or_tpa_confirmation') && types(p).includes('hospital_confirmation'));
  assert.ok(p.externalChecks.some(c => c.checkId === 'emergency_intimation_process' && c.status === 'not_performed'));
  assert.ok(p.limitations.some(l => /emergency care first/i.test(l)));
  assert.ok(p.nextQuestions.length <= 1 && p.nextQuestions.every(q => !q.required));
  assert.ok(!/approv|reimburse|will pay/i.test(JSON.stringify(p.nextActions)));
  assert.notEqual(p.assessmentState, 'insufficient_evidence');
});

test('S5 cashless: facility identification and an explicit insurer or TPA confirmation requirement', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [enrolled()] }] });
  const p = run({ scenarioType: 'cashless_information', memberId: MEMBER_A, hospital: { name: 'Healtworld Hospital' } }, [handoff]).preview();
  assert.equal(p.scenario.scenarioCode, 'S5');
  assert.deepEqual(ids(p), ['Q_HOSPITAL_BRANCH', 'Q_HOSPITAL_CITY']);
  assert.ok(types(p).includes('insurer_or_tpa_confirmation') && types(p).includes('hospital_confirmation'));
  assert.equal(p.externalChecks[0].status, 'not_performed');
  assert.match(p.externalChecks[0].note, /does not establish/);
  assert.equal(p.assessmentState, 'conditional_evidence_summary', 'enrolment is documented; cashless availability is not');
  assert.ok(p.contextGaps.find(g => g.gapKey === 'hospital_network_unverified').blocking);
});

test('every scenario type produces a contract-valid preview with insufficient evidence too', () => {
  for (const scenarioType of ['planned_procedure', 'general_benefit', 'policy_comparison', 'emergency_admission', 'cashless_information']) {
    const none = run({ scenarioType, procedureText: 'cataract surgery', memberId: MEMBER_A }, [], { sourcesOverride: [{ sourceIndex: 0, status: 'revalidation_required', reason: 'answer_stale' }] }).preview();
    assert.equal(none.assessmentState, 'source_revalidation_required', scenarioType);
    assert.ok(types(none).includes('upload_document'), scenarioType);
    const empty = run({ scenarioType, procedureText: 'cataract surgery', memberId: MEMBER_A }, [makeHandoff({ memberId: MEMBER_A, policies: [{ id: 'P1', facts: [] }] })]).preview();
    assert.ok(['insufficient_evidence'].includes(empty.assessmentState), scenarioType);
  }
});

test('assessment states: conflict, revalidation, conditional and available', () => {
  const a = makeHandoff({ memberId: MEMBER_A, answerId: 'a1', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000)] }] });
  const b = makeHandoff({ memberId: MEMBER_A, answerId: 'a2', policies: [{ id: 'P1', facts: [sublimit('cataract', 4000000, { documentId: 'doc-v2' })] }] });
  assert.equal(run({ procedureText: 'cataract surgery', memberId: MEMBER_A }, [a, b]).preview().assessmentState, 'conflicting_evidence');
  const stale = makeHandoff({ memberId: MEMBER_A, pipelineCurrent: false, policies: [{ id: 'P1', facts: [enrolled()] }] });
  assert.equal(run({ procedureText: 'cataract surgery', memberId: MEMBER_A }, [stale, a]).preview().assessmentState, 'source_revalidation_required');
  assert.equal(run({ procedureText: 'cataract surgery', memberId: MEMBER_A }, [a]).preview().assessmentState, 'evidence_summary_available');
  assert.equal(run({ procedureText: 'cataract surgery', memberId: MEMBER_A, hospital: { name: 'X Hospital', city: 'Y', branch: 'Z' }, scenarioType: 'cashless_information' }, [a]).preview().assessmentState, 'conditional_evidence_summary');
});

test('no scenario output ever contains a payout, approval, total or network assertion', () => {
  const handoff = makeHandoff({ memberId: MEMBER_A, asOf: '2026-11-14', policies: [{ id: 'P1', facts: [enrolled(), sublimit('cataract', 3000000), sumInsured(50000000)] }, { id: 'P2', facts: [enrolled(), sublimit('cataract', 5000000), sumInsured(20000000)] }] });
  for (const scenarioType of ['planned_procedure', 'general_benefit', 'policy_comparison', 'emergency_admission', 'cashless_information']) {
    const p = run({ scenarioType, procedureText: 'cataract surgery', memberId: MEMBER_A, plannedDate: '2026-11-14', hospital: { name: 'Healtworld Hospital', city: 'Durgapur' } }, [handoff]).preview();
    const json = JSON.stringify(p);
    assert.ok(!json.includes('70000000') && !json.includes('8000000') && !json.includes('23000000'), `${scenarioType}: no sum`);
    assert.ok(!/combinedPayable|spendableCash|totalCover|expectedReimbursement|approved|approval/i.test(json.replace(/Evidence summary only[^"]*/g, '')), scenarioType);
    assert.ok(p.nextActions.every(a => a.status !== 'completed' && a.status !== 'done'));
    assert.ok(p.externalChecks.every(c => c.status === 'not_performed'));
  }
});
