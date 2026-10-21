// WP7 scenario engine and output assembly: household-coverage-preview/v1. One pipeline serves all five scenario types;
// the scenario changes which rules matter and which context is requested, not the evidence or the question logic.
import { ASSESSMENT_STATES, PREVIEW_VERSION, deepFreeze } from './contracts.js';
import { normalizeSources } from './normalize.js';
import { buildCoverageMap } from './coverage-map.js';
import { buildComparisons } from './comparison.js';
import { buildContextGaps } from './context-gaps.js';
import { selectFollowUpQuestions } from './question-planner.js';
import { buildExternalChecks, buildNextActions } from './next-actions.js';
import { assertHouseholdPreviewContract } from './output-contract.js';

const SCENARIO_CODE = Object.freeze({ planned_procedure: 'S1', general_benefit: 'S2', policy_comparison: 'S3', emergency_admission: 'S4', cashless_information: 'S5' });

const LIMITATIONS = Object.freeze([
  'Evidence summary only. It is not a claim decision, an approval, a reimbursement estimate or advice on whether to buy a policy.',
  'Policy limits are never added together and no usable aggregate cover is calculated.',
  'Answers given in this journey are user-reported context. They do not make any policy fact verified.',
  'Retrieval completeness is not established. A term that is not found is an evidence gap, not an exclusion.',
  'Hospital network and cashless availability change over time and have not been checked. No insurer, TPA or hospital source was consulted.',
  'Consent and privacy wording is pending legal review.',
]);

export function assessmentStateOf({ normalized, positions, gaps, scenario }) {
  if (normalized.sources.some(s => s.status !== 'usable')) return 'source_revalidation_required';
  if (normalized.conflicts.length || positions.some(p => p.uncertainties.some(u => u.state === 'conflicting' && u.rule !== 'policy_type'))) return 'conflicting_evidence';
  const anyKnown = positions.some(p => p.documentedTerms.length + p.documentedRestrictions.length > 0);
  if (!positions.length || !anyKnown) return 'insufficient_evidence';
  const memberNeeded = !['cashless_information'].includes(scenario.scenarioType);
  const memberOk = !memberNeeded || positions.some(p => p.memberApplicability.state === 'established');
  const relevantKnown = positions.some(p => [...p.documentedTerms, ...p.documentedRestrictions].some(t => t.relevantToScenario));
  return gaps.some(g => g.blocking) || !memberOk || !relevantKnown ? 'conditional_evidence_summary' : 'evidence_summary_available';
}

/**
 * @param request  the validated household-scenario/v1 request (validateScenarioInput)
 * @param sources  server-held evidence: [{ sourceIndex, status: 'ok', handoff } | { sourceIndex, status: 'revalidation_required', reason }]
 */
export function buildHouseholdCoveragePreview({ request, sources }) {
  const scenario = request.scenario;
  const normalized = normalizeSources(sources, { memberId: scenario.effective.memberId, asOf: scenario.effective.plannedDate });
  const positions = buildCoverageMap(normalized, scenario);
  const comparisons = buildComparisons(positions, normalized, scenario);
  const gaps = buildContextGaps({ scenario, normalized, positions, comparisons });
  const planned = selectFollowUpQuestions(gaps, scenario);
  const nextActions = buildNextActions({ gaps, questions: planned.questions });
  const externalChecks = buildExternalChecks({ gaps, scenario, positions });
  const assessmentState = assessmentStateOf({ normalized, positions, gaps, scenario });
  if (!ASSESSMENT_STATES.includes(assessmentState)) throw new Error('Unknown assessment state.');

  const preview = deepFreeze({
    contractVersion: PREVIEW_VERSION,
    scenario: {
      scenarioType: scenario.scenarioType, scenarioCode: SCENARIO_CODE[scenario.scenarioType], provenance: 'user_reported',
      reportedMemberRelation: scenario.reportedMemberRelation, memberId: scenario.effective.memberId, memberScope: scenario.effective.memberId ? 'specified' : 'not_specified',
      procedureText: scenario.procedureText, topic: scenario.topic ?? scenario.effective.topicDetail, plannedMonth: scenario.plannedMonth, plannedDate: scenario.effective.plannedDate,
      dateSemantics: scenario.effective.plannedDate ? 'exact_date' : scenario.plannedMonth ? 'month_only_not_an_exact_day' : 'unknown',
      reportedPolicyType: scenario.reportedPolicyType,
      hospital: { name: scenario.effective.hospitalName, city: scenario.effective.hospitalCity, branch: scenario.effective.hospitalBranch, identity: 'unresolved', provenance: 'user_reported' },
      answers: Object.fromEntries(Object.entries(scenario.answers).map(([key, value]) => [key, { state: value.state, value: value.value, provenance: 'user_reported' }])),
    },
    sourceSummary: {
      requested: normalized.sources.length, usable: normalized.sources.filter(s => s.status === 'usable').length,
      revalidationRequired: normalized.sources.filter(s => s.status === 'revalidation_required').length, invalid: normalized.sources.filter(s => s.status === 'invalid').length,
      policiesFound: positions.length, retrievalComplete: false, sources: normalized.sources,
    },
    policies: positions,
    comparisons,
    contextGaps: gaps,
    nextQuestions: planned.questions,
    externalChecks,
    nextActions,
    assessmentState,
    completeness: {
      retrievalComplete: false, evidenceScope: 'authorized_sources_only', questionBudget: planned.budget,
      openBlockingGaps: gaps.filter(g => g.blocking).length, pendingExternalChecks: externalChecks.length,
      unassociatedFacts: normalized.unassociatedFacts, reviewRequired: normalized.reviewRequired,
    },
    limitations: [...LIMITATIONS, ...(scenario.scenarioType === 'emergency_admission' ? ['Seek emergency care first. Nothing here delays or conditions care.'] : [])],
  });
  assertHouseholdPreviewContract(preview);
  return preview;
}
