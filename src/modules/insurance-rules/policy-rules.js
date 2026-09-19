import { freeze } from './contracts.js';
import { resolveEvidence } from './evidence-state.js';

export const RULE_FIELDS = Object.freeze([
  'room_rent_limit',
  'procedure_sublimit',
  'copay',
  'waiting_period',
  'exclusion',
]);

export function observePolicyRules(policy) {
  const rules = Object.fromEntries(RULE_FIELDS.map(field => [field, resolveEvidence(field, policy.observations)]));
  return freeze({
    policyId: policy.id,
    policyKind: policy.kind,
    rules,
    boundaries: ['These are contract observations, not a payable amount or approval decision.'],
  });
}

export function assessTreatmentRelevance(policy, treatment) {
  if (!treatment) return freeze({ policyId: policy.id, state: 'unknown', relevance: 'not_assessed', reason: 'No planned treatment was supplied.', approval: null });
  const memberFacts = policy.observations.filter(item => item.field === 'covered_member' && item.memberId === treatment.memberId);
  const treatmentFacts = policy.observations.filter(item =>
    item.field === 'treatment_relevance' && item.treatmentTags.includes(treatment.kind),
  );
  const member = resolveEvidence('covered_member', memberFacts);
  const relevance = resolveEvidence('treatment_relevance', treatmentFacts);
  if (member.state === 'conflict' || relevance.state === 'conflict') {
    return freeze({ policyId: policy.id, state: 'conflict', relevance: 'needs_human_review', reason: 'Member or treatment relevance evidence conflicts.', approval: null });
  }
  if (member.state !== 'known' || member.value !== true || relevance.state !== 'known') {
    return freeze({ policyId: policy.id, state: 'unknown', relevance: 'needs_clarification', reason: 'Member and treatment-specific relevance need source-backed confirmation.', approval: null });
  }
  return freeze({
    policyId: policy.id,
    state: 'known',
    relevance: relevance.value === true ? 'potentially_relevant' : 'not_relevant_on_cited_term',
    reason: 'Relevance describes the cited term only. Other rules and case facts can still apply.',
    approval: null,
  });
}
