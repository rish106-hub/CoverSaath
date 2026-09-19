const SUPPORTED_TRIGGERS = new Set(['emergency', 'planned_care', 'renewal']);

function boundedArray(value, limit = 100) {
  return Array.isArray(value) ? value.slice(0, limit) : [];
}

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

/**
 * Deterministic case classification. This is a routing result, not a claim,
 * underwriting or product-suitability prediction.
 */
export function classifyCase({ trigger, statedEstimate = 0, coverageGraph = {} } = {}) {
  if (!SUPPORTED_TRIGGERS.has(trigger)) throw new Error('Choose a supported trigger.');
  if (!Number.isFinite(statedEstimate) || statedEstimate < 0) throw new Error('Stated estimate must be non-negative.');

  const graphUnknowns = uniqueStrings([
    ...boundedArray(coverageGraph.unknowns),
    ...boundedArray(coverageGraph.unresolved),
  ]);
  const citedFacts = boundedArray(coverageGraph.facts).filter(fact =>
    Array.isArray(fact?.sources) && fact.sources.length > 0,
  );
  const operatorVerified = coverageGraph.operator?.status === 'verified';
  const drillPassed = coverageGraph.readinessDrill?.status === 'passed';
  const institutionalConfirmation = coverageGraph.institutionalStatus === 'confirmed_for_case';

  const dimensions = {
    immediacy: trigger === 'emergency'
      ? { class: 'immediate_care', reason: 'Emergency routing takes priority over insurance optimisation.' }
      : trigger === 'planned_care'
        ? { class: 'time_sensitive_unknown_date', reason: 'A procedure date is required before a tighter timing class.' }
        : { class: 'renewal_deadline_unknown', reason: 'A renewal date is required before a tighter timing class.' },
    financialExposure: statedEstimate > 0
      ? { class: 'stated_estimate_only', amount: statedEstimate, confirmedPayable: null }
      : { class: 'unknown', amount: null, confirmedPayable: null },
    coverageDeficiency: institutionalConfirmation
      ? { class: 'needs_rules_evaluation', reason: 'Confirmation alone does not calculate the household shortfall.' }
      : { class: 'unknown', reason: 'Policy applicability and institutional status are not confirmed for this case.' },
    continuityRisk: operatorVerified && drillPassed
      ? { class: 'operator_and_backup_tested', reason: 'The recorded operator and readiness drill passed.' }
      : { class: 'unresolved', reason: 'The operator or five-minute readiness drill is not verified.' },
    evidenceConfidence: citedFacts.length > 0 && graphUnknowns.length === 0
      ? { class: 'source_linked_but_not_authoritative', citedFactCount: citedFacts.length }
      : { class: 'limited', citedFactCount: citedFacts.length, unresolvedCount: graphUnknowns.length },
  };

  const route = trigger === 'emergency'
    ? 'admit_first_human_handoff'
    : graphUnknowns.length || !operatorVerified || !drillPassed || !institutionalConfirmation
      ? 'collect_evidence_and_human_review'
      : 'rules_review_then_household_decision';

  return {
    kind: 'deterministic_routing_classification',
    score: null,
    probabilityOfApproval: null,
    route,
    dimensions,
    unknowns: uniqueStrings([
      ...graphUnknowns,
      ...(!institutionalConfirmation ? ['Case-specific institutional confirmation is unresolved.'] : []),
      ...(!operatorVerified ? ['The real household operator is not verified.'] : []),
      ...(!drillPassed ? ['The five-minute readiness drill has not passed.'] : []),
    ]),
    boundary: 'This result routes work. It does not predict approval, payable amount, underwriting, treatment or product suitability.',
  };
}
