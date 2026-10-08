import { OfficialSourceContractError, officialSourceRulePattern, validateSourceAttempt } from './contracts.js';

export const TERMINAL_PARAMETER_OUTCOMES = Object.freeze([
  'Proven',
  'Calculated',
  'Reported',
  'Dynamic',
  'Conflicting',
  'NotPermitted',
  'RequiredNow',
  'RequiredForLaterJourney',
  'NotApplicable',
  'Unavailable',
]);

export const CRITICAL_DECISION_AREAS = Object.freeze([
  'eligibility', 'waiting_periods', 'money', 'hospital_access', 'claim_process',
]);

const ESTABLISHED_OUTCOMES = Object.freeze(['Proven', 'Calculated', 'Reported', 'Dynamic']);
const MISSING_STATES = Object.freeze(['Unknown', 'RequiredNow', 'RequiredForLaterJourney', 'Unavailable', null, undefined]);
const RELEVANCE_TIMINGS = Object.freeze(['now', 'later', 'not_applicable']);
const PARAMETER_PATTERN = /^[a-z][a-z0-9_]{2,63}$/;

const fail = message => { throw new OfficialSourceContractError('TERMINAL_OUTCOME_INVALID', message); };
const frozenAttempts = attempts => {
  if (!Array.isArray(attempts) || attempts.length > 50) fail('sourceAttempts must be a list of at most 50 attempts.');
  return Object.freeze(attempts.map((attempt, index) => validateSourceAttempt(attempt, `sourceAttempts[${index}]`)));
};
const result = (outcome, reason, sourceAttempts, extra = {}) => Object.freeze({
  outcome,
  reason,
  sourceAttempts,
  ...extra,
});

/**
 * Deterministically classify one parameter once extraction and source acquisition stop.
 * Critical decision areas can never be deferred by a model proposal: absent evidence is RequiredNow unless
 * a deterministic not-applicable rule applies or exhausted attempts establish Unavailable.
 */
export function classifyTerminalParameter({
  parameterKey,
  evidenceState = 'Unknown',
  decisionArea = 'other',
  relevance,
  sourceAttempts = [],
  unavailableReason = null,
  freshnessStatus = 'current',
} = {}) {
  if (typeof parameterKey !== 'string' || !PARAMETER_PATTERN.test(parameterKey)) fail('parameterKey must be a snake_case parameter key.');
  if (![...TERMINAL_PARAMETER_OUTCOMES, 'Unknown'].includes(evidenceState)) fail(`unsupported evidenceState ${evidenceState}.`);
  if (![...CRITICAL_DECISION_AREAS, 'other'].includes(decisionArea)) fail(`unsupported decisionArea ${decisionArea}.`);
  const attempts = frozenAttempts(sourceAttempts);

  if (evidenceState === 'Conflicting') return result('Conflicting', 'sources_or_verified_passes_conflict', attempts);
  if (evidenceState === 'NotPermitted') return result('NotPermitted', 'withheld_by_permission', attempts);
  if (ESTABLISHED_OUTCOMES.includes(evidenceState) && !(evidenceState === 'Dynamic' && freshnessStatus !== 'current')) {
    return result(evidenceState, 'established_evidence', attempts);
  }

  if (!MISSING_STATES.includes(evidenceState) && evidenceState !== 'Dynamic') fail(`evidenceState ${evidenceState} is inconsistent with unresolved classification.`);
  if (!relevance || typeof relevance !== 'object' || Array.isArray(relevance)) fail('unresolved parameters require deterministic relevance.');
  if (!RELEVANCE_TIMINGS.includes(relevance.timing)) fail(`relevance.timing must be one of ${RELEVANCE_TIMINGS.join(', ')}.`);
  if (typeof relevance.ruleId !== 'string' || !officialSourceRulePattern.test(relevance.ruleId)) fail('relevance.ruleId must identify a deterministic rule.');

  if (relevance.timing === 'not_applicable') {
    return result('NotApplicable', 'deterministic_not_applicable_rule', attempts, { ruleId: relevance.ruleId });
  }
  if (unavailableReason != null) {
    if (typeof unavailableReason !== 'string' || !unavailableReason.trim() || attempts.length === 0) fail('Unavailable requires a reason and at least one source attempt.');
    return result('Unavailable', unavailableReason.trim(), attempts, { requiredNow: CRITICAL_DECISION_AREAS.includes(decisionArea) || relevance.timing === 'now', ruleId: relevance.ruleId });
  }
  if (evidenceState === 'Dynamic' && freshnessStatus !== 'current') {
    return result('RequiredNow', 'dynamic_evidence_is_stale_or_unverified', attempts, { ruleId: relevance.ruleId });
  }
  if (CRITICAL_DECISION_AREAS.includes(decisionArea) || relevance.timing === 'now') {
    return result('RequiredNow', 'decision_relevant_evidence_missing', attempts, { ruleId: relevance.ruleId });
  }
  return result('RequiredForLaterJourney', 'not_required_for_current_decision', attempts, { ruleId: relevance.ruleId });
}

