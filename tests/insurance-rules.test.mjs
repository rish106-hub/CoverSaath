import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeInsuranceRules,
  classifyForDecisionAdapter,
  compareVersions,
} from '../src/modules/insurance-rules/index.js';

const source = (overrides = {}) => ({
  type: 'issued_schedule',
  id: 'schedule-1',
  familyId: 'schedule-family-1',
  version: 'v1',
  page: 1,
  ...overrides,
});

const observation = (field, value, overrides = {}) => ({
  field,
  value,
  state: 'known',
  source: source(),
  ...overrides,
});

const completeRules = (sourceOverrides = {}) => [
  observation('room_rent_limit', 'single private room', { source: source(sourceOverrides) }),
  observation('procedure_sublimit', 'none stated', { source: source(sourceOverrides) }),
  observation('copay', '10%', { source: source(sourceOverrides) }),
  observation('waiting_period', 'served', { source: source(sourceOverrides) }),
  observation('exclusion', 'see wording', { source: source(sourceOverrides) }),
  observation('sum_insured', 500000, { source: source(sourceOverrides) }),
];

const continuity = {
  operator: { status: 'verified', source: source({ id: 'operator-log', familyId: 'operator-log' }) },
  backup: { status: 'authorised', source: source({ id: 'backup-log', familyId: 'backup-log' }) },
  drill: { status: 'passed', source: source({ id: 'drill-log', familyId: 'drill-log' }) },
};

test('conflicting controlling terms are preserved and sent to human review', () => {
  const result = analyzeInsuranceRules({
    trigger: 'renewal',
    continuity,
    policies: [{
      id: 'personal-1',
      kind: 'personal',
      observations: [
        ...completeRules(),
        observation('copay', '20%', { source: source({ id: 'schedule-2', familyId: 'schedule-family-2' }) }),
      ],
    }],
  });
  assert.equal(result.policyRules[0].rules.copay.state, 'conflict');
  assert.equal(result.evidenceState, 'conflict');
  assert.equal(result.route.route, 'human_review');
});

test('no policies, group-only and personal-only inputs remain bounded', () => {
  const absent = analyzeInsuranceRules({ trigger: 'renewal', policies: [] });
  assert.equal(absent.evidenceState, 'unknown');
  assert.equal(absent.route.route, 'clarification');

  for (const kind of ['group', 'personal']) {
    const result = analyzeInsuranceRules({ trigger: 'renewal', policies: [{ id: `${kind}-1`, kind, observations: completeRules() }] });
    assert.equal(result.coverCombination.layers.length, 1);
    assert.equal(result.coverCombination.layers[0].policyKind, kind);
    assert.equal(result.coverCombination.combinedLimit, null);
  }
});

test('newer version wins within one document family and issued schedule outranks marketing', () => {
  assert.equal(compareVersions('v10', 'v2'), 1);
  const result = analyzeInsuranceRules({
    trigger: 'renewal',
    policies: [{
      id: 'personal-1', kind: 'personal', observations: [
        ...completeRules(),
        observation('copay', '30%', { source: source({ version: 'v0', type: 'marketing_material', id: 'brochure', familyId: 'brochure' }) }),
        observation('room_rent_limit', 'shared room', { source: source({ version: 'v2' }) }),
      ],
    }],
  });
  assert.equal(result.policyRules[0].rules.copay.value, '10%');
  assert.equal(result.policyRules[0].rules.room_rent_limit.value, 'shared room');
  assert.equal(result.policyRules[0].rules.room_rent_limit.state, 'known');
});

test('a missing citation becomes unknown and never becomes a contract conclusion', () => {
  const result = analyzeInsuranceRules({
    trigger: 'renewal',
    policies: [{ id: 'group-1', kind: 'group', observations: [observation('copay', 'none', { source: { id: 'booklet' } })] }],
  });
  assert.equal(result.policyRules[0].rules.copay.state, 'unknown');
  assert.equal(result.route.route, 'clarification');
});

test('planned treatment checks member and treatment relevance without predicting approval', () => {
  const treatmentFacts = [
    observation('covered_member', true, { memberId: 'adult-1' }),
    observation('treatment_relevance', true, { treatmentTags: ['cataract'] }),
  ];
  const result = analyzeInsuranceRules({
    trigger: 'planned_care',
    treatment: { kind: 'cataract', memberId: 'adult-1' },
    continuity,
    policies: [{ id: 'personal-1', kind: 'personal', observations: [...completeRules(), ...treatmentFacts] }],
  });
  assert.equal(result.treatmentRelevance[0].relevance, 'potentially_relevant');
  assert.equal(result.treatmentRelevance[0].approval, null);
  assert.equal(result.probabilityOfApproval, null);
  assert.equal(JSON.stringify(result).includes('approvalProbability'), false);
});

test('emergency always returns admit-first route even with missing evidence', () => {
  const result = analyzeInsuranceRules({ trigger: 'emergency', policies: [] });
  assert.equal(result.route.route, 'emergency');
  assert.equal(result.route.instruction, 'Admit first. Optimise later.');
  assert.equal(result.confirmedPayable, null);
});

test('a current cited no-need record can produce no action without authorising a purchase', () => {
  const result = analyzeInsuranceRules({
    trigger: 'renewal',
    continuity,
    policies: [{ id: 'personal-1', kind: 'personal', observations: completeRules() }],
    needAssessment: { status: 'none_identified', source: source({ type: 'authorised_institution_reply', id: 'review-1', familyId: 'review-1' }) },
  });
  assert.equal(result.route.route, 'no_action');
  assert.match(result.route.reason, /no additional purchase action/i);
});

test('without a cited no-need record complete evidence routes to purchase review', () => {
  const result = analyzeInsuranceRules({
    trigger: 'renewal', continuity,
    policies: [{ id: 'personal-1', kind: 'personal', observations: completeRules() }],
  });
  assert.equal(result.route.route, 'purchase_review');
  assert.match(result.route.reason, /No purchase is authorised/i);
});

test('group and personal limits remain separate and are never treated as cash', () => {
  const result = analyzeInsuranceRules({
    trigger: 'renewal',
    policies: [
      { id: 'group-1', kind: 'group', observations: completeRules() },
      { id: 'personal-1', kind: 'personal', observations: completeRules({ id: 'personal-schedule', familyId: 'personal-schedule' }) },
    ],
    statedEstimate: 300000,
    availableCash: 100000,
  });
  assert.equal(result.coverCombination.layers.length, 2);
  assert.equal(result.coverCombination.combinedLimit, null);
  assert.equal(result.coverCombination.doubleCountingPrevented, true);
  assert.equal(result.cashExposure.upfrontCash.planningGap, 200000);
  assert.equal(result.cashExposure.possibleFinalExposure.amount, null);
  assert.equal(result.cashExposure.insuranceLimitsAreCash, false);
});

test('continuity needs cited operator, backup and drill evidence', () => {
  const result = analyzeInsuranceRules({
    trigger: 'renewal',
    policies: [{ id: 'personal-1', kind: 'personal', observations: completeRules() }],
    continuity: { operator: { status: 'verified' }, backup: { status: 'authorised' }, drill: { status: 'passed' } },
  });
  assert.equal(result.continuity.state, 'unresolved');
  assert.deepEqual(result.continuity.missing, ['verified operator', 'authorised backup', 'passed five-minute drill']);
  assert.equal(result.route.route, 'clarification');
});

test('compatibility adapter exposes legacy route shape without a risk score', () => {
  const result = classifyForDecisionAdapter({ trigger: 'emergency', policies: [] });
  assert.equal(result.route, 'admit_first_human_handoff');
  assert.equal(result.rulesRoute, 'emergency');
  assert.equal(result.score, null);
  assert.equal(result.probabilityOfApproval, null);
});
