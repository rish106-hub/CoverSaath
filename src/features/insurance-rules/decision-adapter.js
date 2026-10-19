import { analyzeInsuranceRules } from './analyze-insurance-rules.js';

const LEGACY_ROUTES = Object.freeze({
  emergency: 'admit_first_human_handoff',
  clarification: 'collect_evidence_and_human_review',
  human_review: 'collect_evidence_and_human_review',
  purchase_review: 'rules_review_then_household_decision',
  no_action: 'no_purchase_action',
});

/** Compatibility seam. Existing decision-agent callers can migrate without importing internals. */
export function classifyForDecisionAdapter(input) {
  const result = analyzeInsuranceRules(input);
  return {
    kind: result.kind,
    route: LEGACY_ROUTES[result.route.route],
    rulesRoute: result.route.route,
    score: null,
    probabilityOfApproval: null,
    dimensions: {
      evidence: { class: result.evidenceState },
      financialExposure: { class: result.cashExposure.upfrontCash.status, confirmedPayable: null },
      continuityRisk: { class: result.continuity.state },
    },
    rulesResult: result,
    boundary: result.boundaries.join(' '),
  };
}
