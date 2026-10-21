// WP4 cross-policy comparison. Reports documented restrictions, evidence gaps, possible overlaps and unresolved
// coordination. It never adds limits, never infers how policies pay together, and never reads one policy's restriction as
// a household-wide fact while another policy's applicability is unresolved.
import { OVERLAP_RULES, isRelevant } from './relevance.js';

const holds = (position, rule, topic) => position.documentedTerms.concat(position.documentedRestrictions).find(t => t.rule === rule && t.topic === topic && t.state === 'known');

function periodExcludes(position, plannedDate) {
  const period = position.documentedTerms.find(t => t.rule === 'policy_period' && t.state === 'known');
  return Boolean(period && plannedDate && (plannedDate < period.value.start || plannedDate > period.value.end));
}

export function buildComparisons(positions, normalized, scenario) {
  const plannedDate = scenario.effective.plannedDate;
  const memberId = scenario.effective.memberId;
  const reasons = [];
  if (positions.length < 2) reasons.push('single_policy_only');
  if (!memberId) reasons.push('member_not_identified');
  if (!plannedDate) reasons.push('exact_date_required_for_overlap');
  if (normalized.conflicts.length) reasons.push('source_conflict_present');
  const established = positions.filter(p => p.memberApplicability.state === 'established');
  if (memberId && positions.length >= 2 && established.length < 2) reasons.push('member_applicability_unresolved_for_some_policies');

  const possibleOverlap = [];
  if (memberId && plannedDate && established.length >= 2) {
    const keys = new Map();
    for (const position of established) {
      if (periodExcludes(position, plannedDate)) continue;
      for (const term of [...position.documentedTerms, ...position.documentedRestrictions]) {
        if (term.state !== 'known' || !OVERLAP_RULES.includes(term.rule) || (['sublimit', 'add_on'].includes(term.rule) && term.topic === '')) continue;
        const key = `${term.rule}\u0000${term.topic}`;
        keys.set(key, [...(keys.get(key) ?? []), { position, term }]);
      }
    }
    for (const [key, holders] of [...keys].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const distinct = new Map(holders.map(h => [h.position.policyId, h]));
      if (distinct.size < 2) continue;
      const [rule, topic] = key.split('\u0000');
      const entries = [...distinct.values()].sort((a, b) => (a.position.policyId < b.position.policyId ? -1 : 1));
      possibleOverlap.push({
        state: 'possible_overlap', rule, topic, memberScoped: true,
        conditional: entries.some(e => e.term.conditional),
        // Each policy keeps its own cited value; nothing is combined.
        policies: entries.map(e => ({ policyId: e.position.policyId, value: e.term.value, conditions: e.term.conditions, exceptions: e.term.exceptions, overrides: e.term.overrides, citations: e.term.citations })),
        note: 'Both policies document this term for the same member. This is not confirmed coordination or simultaneous payment.',
      });
    }
  }

  const usable = positions.filter(p => p.associationState !== 'unresolved' || p.documentedTerms.length > 0);
  const unresolvedCoordination = [];
  if (positions.length >= 2) {
    unresolvedCoordination.push({
      code: 'coordination_not_established', policyIds: positions.map(p => p.policyId),
      text: 'Stacking, which insurer responds first, excess layers, settlement order and payment depend on contractual and operational rules that are not established here. Limits are not added.',
    });
    for (const position of positions.filter(p => ['top_up', 'super_top_up'].includes(p.policyType.kind))) {
      unresolvedCoordination.push({ code: 'top_up_threshold_not_established', policyIds: [position.policyId], text: 'A top-up or super-top-up responds above a threshold that is a separate fact. Its stated limit is not added to another policy.' });
    }
  }

  const documentedRestrictions = positions.flatMap(position => position.documentedRestrictions.map(r => ({
    policyId: position.policyId, rule: r.rule, topic: r.topic, restrictionKind: r.restrictionKind, value: r.value, appliesToMember: r.appliesToMember,
    scope: 'this_policy_only', conditions: r.conditions, exceptions: r.exceptions, overrides: r.overrides, citations: r.citations,
  })));

  const evidenceGaps = [];
  for (const position of positions) {
    for (const u of position.uncertainties) {
      if (u.gapType === 'unresolved_member_applicability' || u.state === 'conflicting' || u.reasonCode === 'topic_evidence_absent') evidenceGaps.push({ policyId: position.policyId, gapType: u.gapType, rule: u.rule, topic: u.topic, reasonCode: u.reasonCode });
    }
    // A topic another policy documents but this one does not state is a gap in this policy's evidence, not an exclusion.
    for (const other of positions) {
      if (other.policyId === position.policyId) continue;
      for (const term of other.documentedTerms.concat(other.documentedRestrictions)) {
        if (term.state === 'known' && term.topic !== '' && isRelevant({ rule: term.rule, topic: term.topic }, scenario) && !holds(position, term.rule, term.topic)) {
          evidenceGaps.push({ policyId: position.policyId, gapType: 'evidence_gap', rule: term.rule, topic: term.topic, reasonCode: 'not_stated_in_this_policys_evidence' });
        }
      }
    }
  }
  const seen = new Set();
  const gaps = evidenceGaps.filter(g => { const k = `${g.policyId}|${g.rule}|${g.topic}|${g.reasonCode}`; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (`${a.policyId}|${a.rule}|${a.reasonCode}` < `${b.policyId}|${b.rule}|${b.reasonCode}` ? -1 : 1));

  return {
    status: possibleOverlap.length || (positions.length >= 2 && !reasons.length) ? 'comparable' : 'not_comparable',
    reasons: [...new Set(reasons)].sort(), possibleOverlap, documentedRestrictions, unresolvedCoordination, evidenceGaps: gaps, policiesCompared: usable.length,
  };
}
