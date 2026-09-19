import { CASE_TRIGGERS, POLICY_KINDS, freeze, requireEnum, requireRecord, requireString } from './contracts.js';
import { normaliseObservation, propagateEvidenceState } from './evidence-state.js';
import { observePolicyRules, assessTreatmentRelevance } from './policy-rules.js';
import { combinePolicyCover } from './cover-combination.js';
import { separateCashExposure } from './cash-exposure.js';
import { classifyContinuity } from './continuity-rules.js';
import { determineRoute } from './route-rules.js';

function normaliseTreatment(value) {
  if (value == null) return null;
  const input = requireRecord(value, 'input.treatment');
  return freeze({
    kind: requireString(input.kind, 'input.treatment.kind'),
    memberId: requireString(input.memberId, 'input.treatment.memberId'),
  });
}

function normalisePolicies(value) {
  if (!Array.isArray(value)) throw new TypeError('input.policies must be an array.');
  if (value.length > 20) throw new RangeError('input.policies is limited to 20 policies.');
  const ids = new Set();
  return value.map((item, policyIndex) => {
    const policy = requireRecord(item, `input.policies[${policyIndex}]`);
    const id = requireString(policy.id, `input.policies[${policyIndex}].id`);
    if (ids.has(id)) throw new TypeError(`Duplicate policy id: ${id}.`);
    ids.add(id);
    const observations = policy.observations ?? [];
    if (!Array.isArray(observations) || observations.length > 200) throw new TypeError(`input.policies[${policyIndex}].observations must be a bounded array.`);
    return freeze({
      id,
      kind: requireEnum(policy.kind, POLICY_KINDS, `input.policies[${policyIndex}].kind`),
      observations: observations.map((observation, index) => normaliseObservation(observation, `input.policies[${policyIndex}].observations[${index}]`)),
    });
  });
}

/** Deterministic classification. It never scores claim approval, payout, underwriting or diagnosis. */
export function analyzeInsuranceRules(value = {}) {
  const input = requireRecord(value, 'input');
  const trigger = requireEnum(input.trigger, CASE_TRIGGERS, 'input.trigger');
  const policies = normalisePolicies(input.policies ?? []);
  const treatment = normaliseTreatment(input.treatment);
  const policyRules = policies.map(observePolicyRules);
  const treatmentRelevance = policies.map(policy => assessTreatmentRelevance(policy, treatment));
  const states = policyRules.flatMap(item => Object.values(item.rules).map(rule => rule.state));
  if (treatment) states.push(...treatmentRelevance.map(item => item.state));
  if (policies.length === 0) states.push('unknown');
  const evidenceState = propagateEvidenceState(states);
  const continuity = classifyContinuity(input.continuity ?? {});
  const coverCombination = combinePolicyCover(policies);
  const cashExposure = separateCashExposure(input);
  const route = determineRoute({ trigger, evidenceState, treatmentRelevance, continuity, needAssessment: input.needAssessment });

  return freeze({
    kind: 'deterministic_insurance_rules_classification',
    version: 'insurance-rules-v1',
    trigger,
    evidenceState,
    policyRules,
    treatmentRelevance,
    coverCombination,
    cashExposure,
    continuity,
    route,
    score: null,
    probabilityOfApproval: null,
    confirmedPayable: null,
    boundaries: [
      'This is classification, not a numeric risk score or regression model.',
      'Unknown is not false. Conflict is not silently resolved.',
      'No result predicts approval, underwriting, settlement, payout or diagnosis.',
      'A policy limit is not cash.',
    ],
  });
}
