import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildProcedureBody, REPORTED_ANSWER_OPTIONS } from '../src/ui/state/request-builders.js';
import { validateEstimateInput } from '../src/modules/policy-breakdown/consumers/estimate.js';
import { assertScenarioConsistency, scenarioReportingChecks, validateScenarioReporting } from '../src/modules/policy-breakdown/consumers/scenario-reporting.js';

const source = await readFile(new URL('../src/ui/components/tools-views.js', import.meta.url), 'utf8');

test('procedure intake exposes the required factual and uncertainty controls', () => {
  for (const name of [
    'diagnosisText', 'procedureWording', 'admissionType', 'priorDiagnosis', 'priorTreatment', 'priorAdvice', 'priorSymptoms',
    'declaredStatus', 'coverContinuity', 'hospitalBranch', 'hospitalAddress', 'hospitalPin', 'preauthorisationStatus',
    'priorFloaterUse', 'priorFloaterUseAmount', 'otherPolicyContribution', 'otherPolicyContributionAmount',
  ]) assert.match(source, new RegExp(`name: '${name}'`));
  assert.deepEqual(REPORTED_ANSWER_OPTIONS.map(([value]) => value), ['', 'yes', 'no', 'not_sure', 'prefer_not_to_answer']);
  assert.match(source, /These answers are recorded as Reported/);
  assert.match(source, /result\.display\?\.headline/);
  assert.match(source, /Household exposure in the primary scenario/);
});

test('builder separates reported scenario answers from supported deterministic inputs', () => {
  const result = buildProcedureBody({
    memberId: 'member-2', procedure: 'other', diagnosisText: 'renal calculus', procedureWording: 'ureteroscopy',
    admissionType: 'accident', preExisting: 'not_sure', priorDiagnosis: 'no', priorTreatment: 'prefer_not_to_answer',
    priorAdvice: 'no', priorSymptoms: 'yes', declaredStatus: 'not_sure', coverContinuity: 'ported',
    networkStatus: 'network', hospitalBranch: 'City Hospital, Durgapur', hospitalAddress: 'Example Road, Durgapur',
    hospitalPin: '713201', preauthorisationStatus: 'submitted', priorFloaterUse: 'yes', priorFloaterUseAmount: '25000',
    otherPolicyContribution: 'no', otherPolicyContributionAmount: '',
  });

  assert.equal(result.error, undefined);
  assert.deepEqual(result.body.condition, { name: 'renal calculus', accident: true });
  assert.equal(result.body.sumInsuredAlreadyUsedMinor, 2_500_000);
  assert.equal(result.body.otherPolicyPaysMinor, 0);
  assert.deepEqual(result.body.hospital, { networkStatus: 'network' });
  assert.equal(result.body.scenarioReporting.evidenceState, 'Reported');
  assert.equal(result.body.scenarioReporting.answers.preExisting, 'not_sure');
  assert.equal(result.body.scenarioReporting.answers.priorTreatment, 'prefer_not_to_answer');
  assert.equal(result.body.scenarioReporting.hospitalPin, '713201');
  assert.equal(result.body.scenarioReporting.otherPolicyContributionAmountMinor, undefined);
  const currentContract = validateEstimateInput(result.body, { requireBill: false });
  assert.equal(currentContract.condition.name, 'renal calculus');
  assert.equal(currentContract.scenarioReporting, undefined);
  const reporting = validateScenarioReporting(result.body.scenarioReporting);
  assert.equal(reporting.answers.priorSymptoms, 'yes');
  assert.ok(scenarioReportingChecks(reporting).some(check => check.id === 'reported_medical_history'));
});

test('builder maps supported yes-no facts but retains declined answers only as Reported', () => {
  const declined = buildProcedureBody({
    procedure: 'general_inpatient', preExisting: 'prefer_not_to_answer', admissionType: 'prefer_not_to_answer',
    priorFloaterUse: 'prefer_not_to_answer', otherPolicyContribution: 'not_sure', networkStatus: 'prefer_not_to_answer',
  }).body;
  assert.equal(declined.condition, undefined);
  assert.deepEqual(declined.hospital, { networkStatus: 'unknown' });
  assert.equal(declined.sumInsuredAlreadyUsedMinor, undefined);
  assert.equal(declined.otherPolicyPaysMinor, undefined);
  assert.equal(declined.scenarioReporting.answers.preExisting, 'prefer_not_to_answer');

  assert.match(buildProcedureBody({ hospitalPin: '012345' }).error, /6-digit hospital PIN/);
  assert.match(buildProcedureBody({ priorFloaterUse: 'no', priorFloaterUseAmount: '1' }).error, /cannot be No/);
});

test('a reported no to pre-existing disease never becomes an authoritative wait-clearing field', () => {
  const result = buildProcedureBody({ diagnosisText: 'renal calculus', preExisting: 'no' }).body;
  assert.equal(result.condition?.preExisting, undefined);
  assert.equal(result.scenarioReporting.answers.preExisting, 'no');
});

test('reported scenario contract rejects extra fields and never upgrades answers to proven evidence', () => {
  assert.throws(() => validateScenarioReporting({ evidenceState: 'Reported', source: 'person', answers: {}, patientName: 'Private' }), /not allowed/);
  assert.throws(() => validateScenarioReporting({ evidenceState: 'Proven', source: 'person', answers: {} }), /Reported/);
  const reporting = validateScenarioReporting({
    evidenceState: 'Reported', source: 'person',
    answers: { preExisting: 'yes', priorDiagnosis: 'yes', declaredStatus: 'no', preauthorisationStatus: 'denied' },
  });
  const checks = scenarioReportingChecks(reporting);
  assert.ok(checks.length >= 2);
  assert.ok(checks.every(check => check.outcome === 'attention'));
  assert.ok(checks.every(check => check.evidence[0].evidenceState === 'Reported'));
  assert.throws(() => assertScenarioConsistency(reporting, { condition: { preExisting: false } }), /conflicts/);
});
