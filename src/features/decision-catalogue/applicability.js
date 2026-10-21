// B3-2 applicability. Order matters: first decide which facts apply to this policy, member and date, then pick the
// controlling contract layer among those. Precedence is a tie-breaker after applicability, never a substitute for it.
import { CONTRACTUAL_SOURCES, deepFreeze, digestOf, isIsoDate, text } from './contracts.js';
import { compareVersions } from '../insurance-rules/index.js';

const rank = fact => (Object.hasOwn(CONTRACTUAL_SOURCES, fact.sourceType) ? CONTRACTUAL_SOURCES[fact.sourceType] : -1);
const cite = fact => ({ factId: fact.factId, documentId: fact.documentId, sourceVersion: fact.sourceVersion, page: fact.page, clauseIds: fact.clauseIds, sourceType: fact.sourceType });

// The newest version of a document family is judged across every fact of the policy that applies to this member and date,
// not only facts of this type and topic: a term the newer version no longer states must not be answered from the older one.
// A newer version that is not in effect yet (or is about another member) does not displace the one that applies.
const familyKey = fact => `${fact.familyId}|${fact.sourceType}`;
function latestPerFamily(facts, policyFacts) {
  const newest = new Map();
  for (const fact of policyFacts) {
    const held = newest.get(familyKey(fact));
    if (held === undefined || compareVersions(fact.sourceVersion, held) > 0) newest.set(familyKey(fact), fact.sourceVersion);
  }
  return facts.filter(fact => compareVersions(fact.sourceVersion, newest.get(familyKey(fact))) === 0);
}

// Who is enrolled is always a statement about one member. Continuity for a named member must be that member's own: a
// policy-wide record does not show when a member added later joined.
// Continuity is always per member, also when no member is named: a floater's policy-wide record would otherwise complete
// a waiting period for a member who joined later.
const needsMemberScope = factType => factType === 'member_enrolment' || factType === 'continuous_cover';

// Policy, member and date filters shared by the rule's own facts and the family-version check.
function exclusionReason(fact, { policyId, memberKey, asOf }) {
  if (!fact.policyId) return 'unassociated_policy';
  if (fact.policyId !== policyId) return 'other_policy';
  if (fact.subject.memberId && fact.subject.memberId !== memberKey) return 'other_member';
  if (!fact.subject.memberId && needsMemberScope(fact.factType)) return 'member_scope_missing';
  if (!asOf && (fact.effective.from || fact.effective.to)) return 'as_of_required';
  if (asOf && ((fact.effective.from && asOf < fact.effective.from) || (fact.effective.to && asOf > fact.effective.to))) return 'not_in_effect';
  return null;
}

/**
 * @returns a bounded decision record. `value` is non-null only when status is `known`.
 */
export function resolveApplicable(facts, { policyId, memberId = null, asOf = null, factType, topic = '' }) {
  if (asOf != null && !isIsoDate(asOf)) throw new TypeError('asOf must be an ISO date.');
  const memberKey = memberId == null ? null : text(memberId, 128);
  if (memberId != null && !memberKey) throw new TypeError('memberId is malformed.');
  memberId = memberKey;
  const excluded = [];
  const pool = [];
  const undated = [];
  for (const fact of facts) {
    if (fact.factType !== factType || fact.topic !== topic) continue;
    const reason = exclusionReason(fact, { policyId, memberKey, asOf });
    if (reason) excluded.push({ factId: fact.factId, reason });
    if (reason === 'as_of_required') undated.push(fact);
    if (!reason) pool.push(fact);
  }
  // Only a contractual fact may supersede, and never one from a higher layer than itself.
  const superseded = new Set(pool.filter(fact => fact.contractual).flatMap(fact => fact.supersedes.filter(id => {
    const target = pool.find(item => item.factId === id);
    return target && rank(target) <= rank(fact);
  })));
  const live = latestPerFamily(pool.filter(fact => {
    if (superseded.has(fact.factId)) { excluded.push({ factId: fact.factId, reason: 'superseded' }); return false; }
    return true;
  }), facts.filter(fact => !exclusionReason(fact, { policyId, memberKey, asOf })));
  for (const fact of pool) if (!live.includes(fact) && !superseded.has(fact.factId)) excluded.push({ factId: fact.factId, reason: 'older_version' });

  const contractual = live.filter(fact => fact.contractual);
  const advisory = live.filter(fact => !fact.contractual);
  // Member scope was applied as a filter above. Among everything that applies, the highest contract layer controls.
  const top = contractual.length ? Math.max(...contractual.map(rank)) : -1;
  const controlling = contractual.filter(fact => rank(fact) === top).sort((x, y) => (x.factId < y.factId ? -1 : 1));

  const base = { factType, topic, policyId, memberId, asOf, excluded, citations: controlling.map(cite), value: null, candidateValue: null, selection: 'unspecified', conditions: [], exceptions: [], overrides: [], effectiveUnknown: false, discrepancies: [] };
  const done = (status, extra = {}) => deepFreeze({ ...base, status, ...extra });

  // A dated contract fact that could control (same or higher layer) was set aside only because no date was given: whether
  // it applies is unknown, so the undated fact must not be reported as the answer.
  const dateDecides = undated.some(fact => fact.contractual && rank(fact) >= top);
  if (!controlling.length || dateDecides) {
    const dated = excluded.some(item => item.reason === 'as_of_required');
    return done('unknown', { reason: dated ? 'as_of_required' : advisory.length ? 'only_non_contractual_sources' : 'no_applicable_evidence', discrepancies: advisory.map(cite) });
  }
  const distinct = new Set(controlling.map(fact => digestOf({ v: fact.value, s: fact.selection, c: fact.conditions, e: fact.exceptions, o: fact.overrides, f: fact.effective, st: ['unknown', 'not_permitted', 'conflicting'].includes(fact.state) ? fact.state : 'value' })));
  if (distinct.size > 1 || controlling.some(fact => fact.state === 'conflicting')) {
    return done('conflict', { reason: 'controlling_sources_disagree', citations: controlling.map(cite), conflicting: controlling.map(fact => ({ ...cite(fact), value: fact.value, selection: fact.selection })) });
  }
  // Order-independent: if any controlling fact is not verified the whole result is not verified.
  const fact = controlling.find(item => !item.verified || !item.association.verified) ?? controlling[0];
  const common = {
    selection: fact.selection, conditions: fact.conditions, exceptions: fact.exceptions, overrides: fact.overrides,
    effectiveUnknown: !fact.effective.from && !fact.effective.to,
    discrepancies: [...advisory, ...contractual.filter(other => rank(other) < top)].filter(other => digestOf({ v: other.value, s: other.selection }) !== digestOf({ v: fact.value, s: fact.selection })).map(cite),
    associationVerified: fact.association.verified,
  };
  if (fact.state === 'not_permitted') return done('not_permitted', common);
  if (fact.state === 'unknown') return done('unknown', { ...common, reason: 'fact_unknown' });
  if (fact.state === 'dynamic') return done('dynamic', { ...common, candidateValue: fact.value, reason: 'needs_current_confirmation' });
  if (!fact.verified || !fact.association.verified) {
    return done('unverified', { ...common, candidateValue: fact.value, reason: fact.verified ? 'policy_association_unverified' : 'value_not_verified' });
  }
  if (fact.selection === 'not_opted') return done('not_selected', common);
  if (fact.selection === 'available') return done('available_not_selected', common);
  return done('known', { ...common, value: fact.value });
}
