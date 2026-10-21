// WP3 household coverage map: one position per policy, never merged across policies. A fact is shown on the policy and
// member scope its Block 3 evidence carries; policy-wide terms do not prove the named member is insured.
import { RESTRICTIVE_RULES, isRelevant, topicMatches, scenarioTexts } from './relevance.js';

const REPORTED_TO_KIND = Object.freeze({ individual: 'personal', family: 'family_floater', group: 'group', top_up: 'top_up', super_top_up: 'super_top_up' });

const termOf = (item, applicability, scenario) => ({
  rule: item.rule, topic: item.topic, state: item.state, value: item.value,
  selection: item.state === 'not_selected' ? 'not_selected' : item.state === 'available_not_selected' ? 'available_not_selected' : 'selected_or_unspecified',
  conditions: item.conditions, exceptions: item.exceptions, overrides: item.overrides, conditional: item.conditional || item.conditions.length + item.exceptions.length + item.overrides.length > 0,
  citations: item.citations, provenance: item.provenance, appliesToMember: applicability.state, relevantToScenario: isRelevant(item, scenario),
  ...(item.completion ? { completion: item.completion } : {}),
});

export function memberApplicabilityOf(policy, scenario) {
  const memberId = scenario.effective.memberId;
  if (!memberId) return { state: 'member_not_specified', reasonCode: 'member_not_identified', citations: [] };
  const enrolment = policy.items.find(item => item.rule === 'member_enrolment' && item.topic === '');
  if (enrolment?.state === 'known' && policy.associationState === 'verified') {
    if (enrolment.value.status === 'enrolled') return { state: 'established', reasonCode: 'enrolment_documented', citations: enrolment.citations };
    if (enrolment.value.status === 'not_enrolled') return { state: 'not_enrolled', reasonCode: 'non_enrolment_documented', citations: enrolment.citations };
  }
  if (enrolment?.state === 'conflicting') return { state: 'unresolved', reasonCode: 'enrolment_evidence_conflicting', citations: [] };
  if (policy.associationState !== 'verified') return { state: 'unresolved', reasonCode: 'policy_association_unverified', citations: [] };
  return { state: 'unresolved', reasonCode: enrolment?.state === 'unverified' ? 'enrolment_unverified' : 'enrolment_not_evidenced', citations: [] };
}

function reportedTypeUncertainty(policy, scenario) {
  const reported = scenario.reportedPolicyType;
  if (!reported || reported === 'not_sure') return [];
  if (policy.kind === 'unresolved') return [{ gapType: 'evidence_gap', rule: 'policy_type', topic: '', state: 'unverified', reasonCode: 'reported_policy_type_unverified', provenance: 'user_reported' }];
  if (REPORTED_TO_KIND[reported] !== policy.kind) return [{ gapType: 'evidence_gap', rule: 'policy_type', topic: '', state: 'conflicting', reasonCode: 'reported_policy_type_differs_from_evidence', provenance: 'user_reported' }];
  return [];
}

export function buildPolicyPosition(policy, scenario) {
  const memberApplicability = memberApplicabilityOf(policy, scenario);
  const terms = [];
  const restrictions = [];
  const uncertainties = [];
  const dynamicChecks = [];
  const texts = scenarioTexts(scenario);

  for (const item of policy.items) {
    const relevant = isRelevant(item, scenario);
    if (item.state === 'known' || item.state === 'not_selected' || item.state === 'available_not_selected') {
      const term = termOf(item, memberApplicability, scenario);
      if (item.state === 'known' && RESTRICTIVE_RULES.includes(item.rule)) restrictions.push({ ...term, restrictionKind: item.rule === 'exclusion' ? 'exclusion' : 'limit_or_condition' });
      else if (!(item.rule === 'member_enrolment' && item.state === 'known' && item.value?.status === 'not_enrolled')) terms.push(term);
      if (item.rule === 'member_enrolment' && item.state === 'known' && item.value?.status === 'not_enrolled') restrictions.push({ ...term, restrictionKind: 'non_enrolment' });
      if (item.rule === 'waiting_period' && item.completion && item.completion.state !== 'completed' && item.completion.state !== 'not_completed') {
        uncertainties.push({ gapType: 'evidence_gap', rule: 'waiting_period_completion', topic: item.topic, state: 'missing', reasonCode: item.completion.reason ?? 'completion_not_established', provenance: 'unavailable' });
      }
    } else if (item.state === 'not_permitted') {
      restrictions.push({ ...termOf(item, memberApplicability, scenario), restrictionKind: 'not_permitted' });
    } else if (relevant) {
      const gapType = item.state === 'dynamic_check' ? 'dynamic_verification_needed' : 'evidence_gap';
      uncertainties.push({ gapType, rule: item.rule, topic: item.topic, state: item.state, reasonCode: item.reasonCode ?? 'no_applicable_evidence', provenance: item.provenance, ...(item.state === 'unverified' ? { candidateAvailable: item.candidateAvailable } : {}) });
    }
    if (item.state === 'dynamic_check') dynamicChecks.push({ rule: item.rule, topic: item.topic, requires: 'current confirmation from the insurer, TPA or hospital', status: 'not_performed', provenance: 'dynamic_external_confirmation_required' });
  }

  // A named topic with no topic-specific item at all is an evidence gap, never a statement that the benefit is excluded.
  const topicText = scenarioTexts(scenario)[0];
  const topicItems = policy.items.filter(item => item.topic !== '' && topicMatches(item.topic, texts));
  if (topicText && ['planned_procedure', 'general_benefit'].includes(scenario.scenarioType) && topicItems.every(item => item.state === 'missing')) {
    uncertainties.push({ gapType: 'evidence_gap', rule: 'topic_specific_terms', topic: '', state: 'missing', reasonCode: 'topic_evidence_absent', provenance: 'unavailable' });
  }
  if (memberApplicability.state === 'unresolved' || memberApplicability.state === 'member_not_specified') {
    uncertainties.push({ gapType: 'unresolved_member_applicability', rule: 'member_enrolment', topic: '', state: 'missing', reasonCode: memberApplicability.reasonCode, provenance: 'unavailable' });
  }
  uncertainties.push(...reportedTypeUncertainty(policy, scenario));
  // An open-ended finding carries no member scope or effective dates in the handoff, so Block 4 cannot say it applies to
  // this member on this date. Reviewed or not, it is listed as a finding to resolve, never as a documented term or restriction.
  for (const finding of policy.openEnded) {
    uncertainties.push({
      gapType: 'evidence_gap', rule: finding.factType, topic: finding.topic, state: 'unverified',
      reasonCode: finding.verified ? 'open_ended_finding_member_and_date_scope_not_established' : 'open_ended_finding_unreviewed',
      provenance: finding.verified ? 'unavailable' : 'unverified_extraction', // reviewed, but no usable (member- and date-scoped) evidence
    });
  }

  const cited = new Map();
  for (const entry of [...terms, ...restrictions, ...memberApplicability.citations.map(c => ({ citations: [c] })), ...[...terms, ...restrictions].filter(t => t.completion?.continuityCitations).map(t => ({ citations: t.completion.continuityCitations }))]) for (const c of entry.citations) cited.set(`${c.documentId}|${c.sourceVersion}|${c.clauseIds.join(',')}`, c);
  const limitations = [
    'Retrieval completeness is not established; absence of a term is not evidence that it does not exist.',
    'Nominal limits belong to this policy only and are not added to any other policy or treated as payable cash.',
  ];
  if (policy.kind === 'unresolved') limitations.push('The policy type is not established by evidence.');
  if (!scenario.effective.plannedDate && scenario.plannedMonth) limitations.push('Only a planned month is known; the month is not treated as an exact date.');
  return {
    policyId: policy.policyRef, policyType: { kind: policy.kind, coverBasis: policy.coverBasis, resolved: policy.kind !== 'unresolved' },
    associationState: policy.associationState, memberApplicability: { state: memberApplicability.state, reasonCode: memberApplicability.reasonCode, citations: memberApplicability.citations },
    documentedTerms: terms, documentedRestrictions: restrictions, uncertainties, dynamicChecks,
    citations: [...cited.values()].sort((a, b) => (`${a.documentId}${a.clauseIds}` < `${b.documentId}${b.clauseIds}` ? -1 : 1)), limitations,
    sourceIndexes: policy.sourceIndexes,
  };
}

export const buildCoverageMap = (normalized, scenario) => normalized.policies.map(policy => buildPolicyPosition(policy, scenario));
