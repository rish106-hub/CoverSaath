import { classifyTerminalParameter } from './terminal-outcomes.js';

const CRITICAL_AREA_BY_SECTION = Object.freeze({
  2: 'eligibility',
  3: 'waiting_periods',
  4: 'eligibility',
  5: 'eligibility',
  6: 'money',
  7: 'hospital_access',
  8: 'claim_process',
});

function decisionArea(definition) {
  if (!definition.critical) return 'other';
  if (definition.section === 11) {
    return definition.key === 'members_attracting_age_copay' ? 'money' : 'eligibility';
  }
  return CRITICAL_AREA_BY_SECTION[definition.section] ?? 'other';
}

function sourceAttempts(parameter) {
  if (Array.isArray(parameter.sourceAttempts)) return parameter.sourceAttempts;
  if (Array.isArray(parameter.officialSourceProvenance?.sourceAttempts)) return parameter.officialSourceProvenance.sourceAttempts;
  return [];
}

/**
 * Add response-only terminal classification without changing the persisted evidence contract.
 * Absence alone is never a deterministic not-applicable or unavailable finding.
 */
export function withTerminalOutcome(parameter, definition) {
  const { terminalRelevance: _untrustedTerminalRelevance, ...safeParameter } = parameter;
  const attempts = sourceAttempts(parameter);
  const relevance = {
    timing: definition.critical ? 'now' : 'later',
    ruleId: definition.critical ? 'policy-parameter.critical-required-now' : 'policy-parameter.noncritical-later',
  };
  const unavailableReason = attempts.length > 0 && typeof parameter.unavailableReason === 'string'
    ? parameter.unavailableReason
    : null;
  const terminal = classifyTerminalParameter({
    parameterKey: definition.key,
    evidenceState: parameter.evidenceState,
    decisionArea: decisionArea(definition),
    relevance,
    sourceAttempts: attempts,
    unavailableReason,
    freshnessStatus: parameter.officialSourceProvenance?.freshness?.status ?? parameter.freshnessStatus ?? 'current',
  });

  return {
    ...safeParameter,
    terminalOutcome: terminal.outcome,
    terminalOutcomeReason: terminal.reason,
    sourceAttempts: terminal.sourceAttempts,
    ...(terminal.ruleId ? { terminalOutcomeRuleId: terminal.ruleId } : {}),
    ...(terminal.requiredNow !== undefined ? { terminalOutcomeRequiredNow: terminal.requiredNow } : {}),
  };
}
