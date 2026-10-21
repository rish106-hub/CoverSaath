// WP5 deterministic context-gap resolver (rules G01 to G10). Pure: the same scenario and evidence always give the same
// gaps. A gap names what is missing and who can resolve it. It never creates a coverage fact, and a user answer never
// upgrades policy evidence. G10 (consent) is enforced before this code runs: an unauthorised source is never read.
import { isSpecificProcedure } from './relevance.js';

const SOURCE_CLASS = Object.freeze({
  USER: 'user_context', DOCUMENT: 'policy_document', VERIFIED_SOURCE: 'verified_source', DYNAMIC_EXTERNAL: 'external_confirmation', REVIEW: 'independent_review', NOT_PERMITTED: 'authorization',
});
const MEMBER_SCENARIOS = ['planned_procedure', 'general_benefit', 'policy_comparison', 'emergency_admission', 'cashless_information'];

const answerState = (scenario, key) => scenario.answers[key]?.state ?? 'unanswered';
const answeredYes = (scenario, key) => scenario.answers[key]?.state === 'answered' && scenario.answers[key].value === 'YES';

function gap(gapKey, resolver, fields) {
  return { gapKey, sourceClass: SOURCE_CLASS[resolver], expectedResolver: resolver, eligibleQuestionId: null, relatedPolicyIds: [], relatedRuleKeys: [], ...fields };
}
const ruleKey = item => `${item.rule}/${item.topic}`;

export function cashlessRelevant(scenario) {
  const named = Boolean(scenario.effective.hospitalName);
  return scenario.scenarioType === 'cashless_information' || (named && ['planned_procedure', 'emergency_admission'].includes(scenario.scenarioType));
}

export function buildContextGaps({ scenario, normalized, positions }) {
  const gaps = [];
  const type = scenario.scenarioType;
  const effective = scenario.effective;
  const usableSources = normalized.sources.filter(s => s.status === 'usable');
  const unusableSources = normalized.sources.filter(s => s.status !== 'usable');
  const allItems = normalized.policies.flatMap(policy => policy.items);
  const known = allItems.filter(item => item.state === 'known');
  const unresolvedIds = positions.filter(p => p.memberApplicability.state !== 'established' && p.memberApplicability.state !== 'not_enrolled').map(p => p.policyId);
  const establishedIds = positions.filter(p => p.memberApplicability.state === 'established').map(p => p.policyId);
  const notEnrolledAll = positions.length > 0 && positions.every(p => p.memberApplicability.state === 'not_enrolled');

  // G01: no eligible, current source answer.
  if (!usableSources.length || !positions.length) {
    gaps.push(gap('no_current_source', 'DOCUMENT', {
      reason: 'no_eligible_current_source', impact: 'applicability', priority: 'P0', currentState: unusableSources.length ? 'sources_unusable' : 'absent', blocking: true,
      eligibleQuestionId: unusableSources.length ? null : 'Q_POLICY_SCHEDULE',
    }));
  }
  // G09: stale or unusable sources and conflicts are never put to the user to arbitrate.
  if (unusableSources.length) {
    gaps.push(gap('source_revalidation_required', 'DOCUMENT', { reason: 'source_stale_or_invalid', impact: 'applicability', priority: 'P0', currentState: 'revalidation_required', blocking: true }));
  }
  if (normalized.conflicts.length) {
    gaps.push(gap('source_conflict', 'REVIEW', {
      reason: 'conflicting_contract_evidence', impact: 'major_restriction', priority: 'P0', currentState: 'conflicting', blocking: true,
      relatedPolicyIds: [...new Set(normalized.conflicts.map(c => c.policyRef).filter(Boolean))].sort(), relatedRuleKeys: [...new Set(normalized.conflicts.map(c => `${c.rule}/${c.topic}`))].sort(),
    }));
  }

  // G02: the member is never inferred from a relationship label.
  if (MEMBER_SCENARIOS.includes(type) && !effective.memberId) {
    const state = answerState(scenario, 'member_id');
    gaps.push(gap('member_unidentified', 'USER', {
      reason: scenario.reportedMemberRelation ? 'relation_reported_member_not_selected' : 'member_not_identified', impact: 'applicability', priority: 'P0',
      currentState: state === 'unanswered' ? 'unanswered' : `user_${state}`, blocking: true, eligibleQuestionId: 'Q_MEMBER',
    }));
  }

  // G03: membership or association not established. Prefer an existing authorised schedule over asking from memory.
  if (usableSources.length && positions.length && !establishedIds.length && !notEnrolledAll) {
    const state = answerState(scenario, 'policy_schedule_available');
    gaps.push(gap('membership_unestablished', 'DOCUMENT', {
      reason: effective.memberId ? 'member_enrolment_not_evidenced' : 'insured_members_not_evidenced', impact: 'applicability', priority: 'P0', blocking: true,
      currentState: answeredYes(scenario, 'policy_schedule_available') ? 'user_has_document_not_yet_processed' : state === 'unanswered' ? 'unanswered' : `user_${state}`,
      eligibleQuestionId: 'Q_POLICY_SCHEDULE', relatedPolicyIds: unresolvedIds, relatedRuleKeys: ['member_enrolment/'],
    }));
  }
  const unassociated = positions.filter(p => p.associationState !== 'verified').map(p => p.policyId);
  if (unassociated.length) {
    gaps.push(gap('policy_association_unverified', 'REVIEW', { reason: 'document_to_policy_association_not_verified', impact: 'applicability', priority: 'P1', currentState: 'candidate_or_unresolved', blocking: true, relatedPolicyIds: unassociated }));
  }
  if (usableSources.length && positions.length && !known.length) {
    gaps.push(gap('no_reviewed_evidence', 'REVIEW', { reason: 'no_reviewed_contractual_evidence', impact: 'major_restriction', priority: 'P1', currentState: 'unreviewed_or_absent', blocking: true, relatedPolicyIds: positions.map(p => p.policyId) }));
  }
  const topicAbsent = positions.filter(p => p.uncertainties.some(u => u.reasonCode === 'topic_evidence_absent')).map(p => p.policyId);
  if (topicAbsent.length) {
    gaps.push(gap('topic_evidence_absent', 'DOCUMENT', { reason: 'topic_terms_not_in_available_evidence', impact: 'major_restriction', priority: 'P1', currentState: 'absent', blocking: true, relatedPolicyIds: topicAbsent, relatedRuleKeys: ['topic_specific_terms/'] }));
  }

  // G04: an exact date, only when it could change applicability. A month is never converted to a day.
  if (['planned_procedure', 'general_benefit', 'policy_comparison'].includes(type) && !effective.plannedDate) {
    const asOfItems = allItems.filter(item => item.reasonCode === 'as_of_required' || item.completion?.reason === 'as_of_date_missing');
    const comparisonNeedsDate = type === 'policy_comparison' && establishedIds.length >= 2;
    const material = asOfItems.length > 0 || comparisonNeedsDate;
    const state = answerState(scenario, 'exact_date');
    gaps.push(gap(material ? 'exact_date_required' : 'exact_date_materiality_undetermined', 'USER', {
      reason: material ? 'date_could_change_applicability' : 'no_dated_evidence_to_judge_yet', impact: material ? 'applicability' : 'clarification', priority: material ? 'P1' : 'P2',
      currentState: state === 'unanswered' ? (scenario.plannedMonth ? 'month_only' : 'unanswered') : `user_${state}`, blocking: material,
      eligibleQuestionId: material ? 'Q_EXACT_DATE' : null, relatedRuleKeys: asOfItems.map(ruleKey).filter((v, i, a) => a.indexOf(v) === i).sort(),
    }));
  }

  // A documented policy period that excludes the exact date (or, with only a month, the whole month): the policy may not be
  // the one in force then, so another term or renewal document is needed.
  if (effective.plannedDate || scenario.plannedMonth) {
    const [from, to] = effective.plannedDate ? [effective.plannedDate, effective.plannedDate] : [`${scenario.plannedMonth}-01`, `${scenario.plannedMonth}-31`];
    const outside = positions.filter(p => p.documentedTerms.some(t => t.rule === 'policy_period' && t.state === 'known' && (to < t.value.start || from > t.value.end))).map(p => p.policyId);
    if (outside.length) {
      gaps.push(gap('planned_date_outside_policy_period', 'DOCUMENT', {
        reason: 'planned_date_outside_documented_policy_period', impact: 'applicability', priority: 'P1', blocking: true,
        currentState: effective.plannedDate ? 'documented_period_excludes_date' : 'documented_period_excludes_month', relatedPolicyIds: outside.sort(), relatedRuleKeys: ['policy_period/'],
      }));
    }
  }

  // G05: a procedure name specific enough to match terms. The name is user-reported until evidence supports it.
  if (type === 'planned_procedure') {
    const specific = [scenario.procedureText, effective.procedureDetail].some(text => text && isSpecificProcedure(text));
    if (!specific) {
      const state = answerState(scenario, 'procedure_detail');
      gaps.push(gap('procedure_unspecific', 'USER', { reason: 'procedure_name_not_specific', impact: 'major_restriction', priority: 'P1', currentState: state === 'unanswered' ? 'unanswered' : `user_${state}`, blocking: true, eligibleQuestionId: 'Q_PROCEDURE_DETAIL' }));
    }
  }
  if (type === 'general_benefit' && !scenario.topic && !scenario.procedureText && !effective.topicDetail) {
    const state = answerState(scenario, 'topic_detail');
    gaps.push(gap('topic_unspecified', 'USER', { reason: 'no_benefit_topic_named', impact: 'major_restriction', priority: 'P1', currentState: state === 'unanswered' ? 'unanswered' : `user_${state}`, blocking: true, eligibleQuestionId: 'Q_BENEFIT_TOPIC' }));
  }

  // G06: facility identity and current network status. Asking for an address never makes a hospital a network facility.
  if (cashlessRelevant(scenario)) {
    if (type !== 'emergency_admission') {
      if (!effective.hospitalName) {
        const state = answerState(scenario, 'hospital_name');
        gaps.push(gap('hospital_name_missing', 'USER', { reason: 'facility_not_named', impact: 'dynamic_check_readiness', priority: 'P1', currentState: state === 'unanswered' ? 'unanswered' : `user_${state}`, blocking: true, eligibleQuestionId: 'Q_HOSPITAL_NAME' }));
      } else {
        if (!effective.hospitalCity) {
          const state = answerState(scenario, 'hospital_city');
          gaps.push(gap('hospital_city_missing', 'USER', { reason: 'facility_city_not_known', impact: 'dynamic_check_readiness', priority: 'P1', currentState: state === 'unanswered' ? 'unanswered' : `user_${state}`, blocking: true, eligibleQuestionId: 'Q_HOSPITAL_CITY' }));
        }
        if (!effective.hospitalBranch) {
          const state = answerState(scenario, 'hospital_branch');
          gaps.push(gap('hospital_branch_missing', 'USER', { reason: 'facility_branch_not_known', impact: 'dynamic_check_readiness', priority: 'P1', currentState: state === 'unanswered' ? 'unanswered' : `user_${state}`, blocking: true, eligibleQuestionId: 'Q_HOSPITAL_BRANCH' }));
        }
      }
    }
    gaps.push(gap('hospital_network_unverified', 'DYNAMIC_EXTERNAL', {
      reason: 'network_status_needs_current_confirmation', impact: 'dynamic_check_readiness', priority: type === 'cashless_information' ? 'P1' : 'P2', currentState: 'not_performed', blocking: type === 'cashless_information',
    }));
  }
  if (type === 'emergency_admission') {
    gaps.push(gap('emergency_intimation_unverified', 'DYNAMIC_EXTERNAL', { reason: 'insurer_or_tpa_intimation_process_unverified', impact: 'dynamic_check_readiness', priority: 'P1', currentState: 'not_performed', blocking: false }));
  }
  const dynamicPolicies = positions.filter(p => p.dynamicChecks.length).map(p => p.policyId);
  if (dynamicPolicies.length) {
    gaps.push(gap('policy_dynamic_checks_pending', 'DYNAMIC_EXTERNAL', { reason: 'policy_items_need_current_confirmation', impact: 'dynamic_check_readiness', priority: 'P2', currentState: 'not_performed', blocking: false, relatedPolicyIds: dynamicPolicies }));
  }

  // G07: waiting-period completion needs verified continuity. A reported "no break in cover" stays user_reported.
  const waiting = positions.flatMap(p => p.documentedRestrictions.filter(r => r.rule === 'waiting_period' && r.relevantToScenario !== false).map(r => ({ p, r })));
  const continuityMissing = waiting.filter(({ r }) => r.completion && r.completion.state === 'unknown' && r.completion.reason === 'continuity_not_evidenced');
  const disagree = positions.filter(p => p.documentedRestrictions.some(r => r.rule === 'waiting_period' && r.completion?.reason === 'completion_differs_across_sources')).map(p => p.policyId);
  if (disagree.length) {
    gaps.push(gap('waiting_period_completion_unresolved', 'REVIEW', { reason: 'sources_disagree_on_waiting_period_completion', impact: 'major_restriction', priority: 'P1', currentState: 'conflicting', blocking: true, relatedPolicyIds: disagree.sort(), relatedRuleKeys: ['waiting_period/'] }));
  }
  if (continuityMissing.length) {
    const state = answerState(scenario, 'continuity_document_available');
    gaps.push(gap('continuity_unverified', 'DOCUMENT', {
      reason: answeredYes(scenario, 'uninterrupted_cover_reported') ? 'uninterrupted_cover_reported_not_verified' : 'continuity_not_evidenced', impact: 'major_restriction', priority: 'P1', blocking: true,
      currentState: answeredYes(scenario, 'continuity_document_available') ? 'user_has_document_not_yet_processed' : state === 'unanswered' ? 'unanswered' : `user_${state}`,
      eligibleQuestionId: 'Q_CONTINUITY_DOCUMENT', relatedPolicyIds: [...new Set(continuityMissing.map(({ p }) => p.policyId))].sort(), relatedRuleKeys: ['continuous_cover/'],
    }));
  } else if (type === 'planned_procedure' && positions.some(p => p.uncertainties.some(u => u.rule === 'waiting_period'))) {
    gaps.push(gap('waiting_period_not_established', 'DOCUMENT', { reason: 'waiting_period_terms_not_evidenced', impact: 'major_restriction', priority: 'P2', currentState: 'absent', blocking: false, relatedRuleKeys: ['waiting_period/'] }));
  }

  // G08: every layer is judged on its own evidence; another policy is requested only when the question needs it.
  if (establishedIds.length && unresolvedIds.length) {
    gaps.push(gap('layer_applicability_unresolved', 'DOCUMENT', { reason: 'some_policies_lack_member_evidence', impact: 'applicability', priority: 'P2', currentState: 'unresolved', blocking: false, relatedPolicyIds: unresolvedIds }));
  }
  const needsSecond = (type === 'policy_comparison' || ['top_up', 'super_top_up'].includes(scenario.reportedPolicyType)) && positions.length < 2;
  if (needsSecond) {
    const state = answerState(scenario, 'other_policy_available');
    const hasOther = answeredYes(scenario, 'other_policy_available');
    gaps.push(gap('second_policy_not_provided', hasOther ? 'DOCUMENT' : 'USER', {
      reason: type === 'policy_comparison' ? 'comparison_needs_a_second_policy' : 'reported_top_up_without_base_policy_evidence', impact: 'applicability', priority: 'P1', blocking: true,
      currentState: hasOther ? 'user_has_document_not_yet_processed' : state === 'unanswered' ? 'unanswered' : `user_${state}`, eligibleQuestionId: hasOther ? null : 'Q_OTHER_POLICY',
    }));
  }
  return gaps.sort((a, b) => (a.gapKey < b.gapKey ? -1 : 1));
}
