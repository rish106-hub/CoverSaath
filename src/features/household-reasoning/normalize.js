// WP2 evidence normalizer. Input: handoffs the SERVER built from authorised Block 3 catalogues. Output: a household
// evidence model whose every transformation is authority-non-increasing: a state can narrow (known -> unverified),
// a value can be dropped, a conflict can appear, but nothing becomes known, verified or cited that the source did not
// already hold. candidateValue is never copied. Missing evidence stays missing; it is never turned into a negative.
import { createHash } from 'node:crypto';
import { assertHandoffContract } from '../decision-catalogue/index.js';
import { HouseholdReasoningError, ITEM_STATES, LIMITS, canonical, deepFreeze, hasForbiddenCharacters, isRecord } from './contracts.js';

const REASON = /^[a-z0-9_/-]{1,80}$/;
const FORBIDDEN_VALUE_KEY = /^(spendableCash|combinedPayableAmount|combinedConfirmedCover|payableAmount|expectedReimbursement)$/;
const POLICY_KINDS = ['personal', 'family_floater', 'group', 'top_up', 'super_top_up', 'unresolved'];

export const policyRefOf = policyId => `pol-${createHash('sha256').update(`block4-policy-ref|${policyId}`).digest('hex').slice(0, 16)}`;

const boundedText = (value, max = 500) => (typeof value === 'string' && value.isWellFormed() && value.trim() && value.length <= max && !hasForbiddenCharacters(value) ? value.trim() : null);
const textList = (list, max = 20) => (Array.isArray(list) ? list.slice(0, max).map(item => boundedText(item)).filter(Boolean) : []);

function cleanCitation(raw) {
  if (!isRecord(raw)) return null;
  const clauseIds = Array.isArray(raw.clauseIds) ? raw.clauseIds.map(id => boundedText(id, 128)).filter(Boolean) : [];
  const documentId = boundedText(raw.documentId, 128);
  const sourceVersion = boundedText(String(raw.sourceVersion ?? ''), 128);
  if (!documentId || !sourceVersion || !clauseIds.length || clauseIds.length > 20) return null;
  return {
    factId: boundedText(raw.factId, 128), documentId, sourceVersion, page: Number.isInteger(raw.page) ? raw.page : null,
    clauseIds: [...clauseIds].sort(), sourceType: boundedText(raw.sourceType, 60),
  };
}
const citationKey = c => `${c.documentId}|${c.sourceVersion}|${c.sourceType}|${c.clauseIds.join(',')}`;
function mergeCitations(...lists) {
  const byKey = new Map();
  for (const c of lists.flat()) if (!byKey.has(citationKey(c))) byKey.set(citationKey(c), c);
  return [...byKey.values()].sort((a, b) => (citationKey(a) < citationKey(b) ? -1 : 1));
}

// A known value is copied only if it is plain data: bounded depth and size, tame keys, scalar leaves, and no control
// characters in text. Anything else is not copied and the item is narrowed (a rule validator may allow extra keys).
const KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
function plainData(value, depth = 0) {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= 200 && value.isWellFormed() && !hasForbiddenCharacters(value);
  if (depth >= 3) return false;
  if (Array.isArray(value)) return value.length <= 20 && value.every(inner => plainData(inner, depth + 1));
  return isRecord(value) && Object.keys(value).length <= 20 && Object.entries(value).every(([key, inner]) => KEY.test(key) && key !== 'constructor' && plainData(inner, depth + 1));
}

const hasForbiddenKey = value => (Array.isArray(value) ? value.some(hasForbiddenKey) : isRecord(value) && Object.entries(value).some(([key, inner]) => FORBIDDEN_VALUE_KEY.test(key) || hasForbiddenKey(inner)));

const PROVENANCE_BY_STATE = Object.freeze({
  known: 'reviewed_contractual_evidence', not_selected: 'reviewed_contractual_evidence', available_not_selected: 'reviewed_contractual_evidence',
  not_permitted: 'reviewed_contractual_evidence', unverified: 'unverified_extraction', dynamic_check: 'dynamic_external_confirmation_required',
  missing: 'unavailable', conflicting: 'unavailable',
});


// A waiting-period completion keeps everything Block 3 states about how it was reached, including the continuity
// citations and its own caveat about the unverified month-counting rule.
function cleanCompletion(raw) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const citations = Array.isArray(raw.continuityCitations) ? mergeCitations(raw.continuityCitations.slice(0, LIMITS.citationsPerItem).map(cleanCitation).filter(Boolean)) : [];
  // A computed completion whose continuity basis cannot be cited is not reported as computed.
  if (['completed', 'not_completed'].includes(raw.state) && !citations.length) return { state: 'unknown', reason: 'continuity_citations_missing' };
  return {
    state: boundedText(raw.state, 40), reason: boundedText(raw.reason, 80),
    ...(Number.isInteger(raw.elapsedMonths) ? { elapsedMonths: raw.elapsedMonths } : {}), ...(Number.isInteger(raw.requiredMonths) ? { requiredMonths: raw.requiredMonths } : {}),
    ...(typeof raw.since === 'string' && iso.test(raw.since) ? { since: raw.since } : {}), ...(typeof raw.creditedPriorCover === 'boolean' ? { creditedPriorCover: raw.creditedPriorCover } : {}),
    ...(boundedText(raw.assumes, 400) ? { assumes: boundedText(raw.assumes, 400) } : {}),
    ...(Array.isArray(raw.continuityCitations) ? { continuityCitations: mergeCitations((raw.continuityCitations.slice(0, LIMITS.citationsPerItem)).map(cleanCitation).filter(Boolean)) } : {}),
  };
}

// One handoff item -> a normalised item. `policyVerified` is the policy-level association; a known item without it is narrowed.
function normalizeItem(raw, policyVerified) {
  const citations = (Array.isArray(raw.citations) ? raw.citations : []).slice(0, LIMITS.citationsPerItem).map(cleanCitation);
  const cleanCitations = mergeCitations(citations.filter(Boolean));
  const base = {
    rule: boundedText(raw.rule, 80) ?? 'unknown_rule', topic: typeof raw.topic === 'string' ? (boundedText(raw.topic, 120) ?? '') : '',
    conditions: textList(raw.conditions), exceptions: textList(raw.exceptions), overrides: textList(raw.overrides),
    conditional: raw.conditional === true, associationVerified: raw.associationVerified === true,
    candidateAvailable: raw.candidateValue !== null && raw.candidateValue !== undefined,
    reasonCode: typeof raw.reason === 'string' && REASON.test(raw.reason) ? raw.reason : null,
    ...(isRecord(raw.completion) ? { completion: cleanCompletion(raw.completion) } : {}),
  };
  let state = ITEM_STATES.includes(raw.state) ? raw.state : 'missing';
  let value = null;
  let reasonCode = base.reasonCode;
  if (state === 'known') {
    const malformed = citations.some(c => c === null) || !cleanCitations.length || !base.associationVerified || !policyVerified
      || !isRecord(raw.value) || hasForbiddenKey(raw.value) || !plainData(raw.value) || canonical(raw.value).length > 2000;
    if (malformed) { state = 'unverified'; reasonCode = !base.associationVerified || !policyVerified ? 'association_not_verified' : 'known_evidence_incomplete'; } else value = structuredClone(raw.value);
  }
  // A decisive non-known state without a citation or a verified association is not a documented restriction.
  if ((state === 'not_permitted' || state === 'not_selected' || state === 'available_not_selected') && (!cleanCitations.length || !base.associationVerified)) {
    state = 'unverified'; reasonCode = 'decisive_evidence_incomplete';
  }
  return {
    ...base, state, value, reasonCode, citations: state === 'missing' ? [] : cleanCitations, provenance: PROVENANCE_BY_STATE[state],
    conflicting: state === 'conflicting' ? mergeCitations((Array.isArray(raw.conflicting) ? raw.conflicting : []).map(cleanCitation).filter(Boolean)) : [],
  };
}

function normalizeOpenEnded(list, policyIds) {
  return (Array.isArray(list) ? list : []).slice(0, 200).map(raw => {
    const cites = mergeCitations((Array.isArray(raw.citations) ? raw.citations : []).map(c => cleanCitation({ ...c, clauseIds: [c?.clauseId] })).filter(Boolean));
    const verified = raw.verified === true && ['proven', 'calculated'].includes(raw.state) && cites.length > 0;
    return {
      policyId: policyIds.has(raw.policyId) ? raw.policyId : null, factType: boundedText(raw.factType, 80) ?? 'finding', topic: boundedText(raw.topic, 120) ?? '',
      effect: boundedText(raw.effect, 80), verified, citations: cites, conditions: textList(raw.conditions), exceptions: textList(raw.exceptions), overrides: textList(raw.overrides),
    };
  });
}

/**
 * @param sources [{ sourceIndex, status: 'ok', handoff } | { sourceIndex, status: 'revalidation_required', reason }]
 * @param scope   { memberId, asOf } the server used to build every handoff
 */
export function normalizeSources(sources, { memberId = null, asOf = null } = {}) {
  if (!Array.isArray(sources) || sources.length < 1 || sources.length > LIMITS.sources) throw new HouseholdReasoningError('HOUSEHOLD_PREVIEW_BOUND_EXCEEDED', 'A bounded set of sources is required.', 422);
  const summaries = [];
  const perPolicy = new Map(); // policyId -> { kind, coverBasis, association, sourceIndexes, itemSets: [items], dynamic, openEnded }
  const conflicts = [];
  let reviewRequired = false;
  let unassociatedFacts = 0;
  let totalItems = 0;

  for (const source of [...sources].sort((a, b) => a.sourceIndex - b.sourceIndex)) {
    const summary = { sourceIndex: source.sourceIndex, status: 'usable', reasonCode: null, policyCount: 0, retrievalComplete: false, itemCounts: {} };
    summaries.push(summary);
    if (source.status !== 'ok') { summary.status = 'revalidation_required'; summary.reasonCode = typeof source.reason === 'string' && REASON.test(source.reason) ? source.reason : 'source_unavailable'; continue; }
    const handoff = source.handoff;
    try { assertHandoffContract(handoff); } catch { summary.status = 'invalid'; summary.reasonCode = 'handoff_contract_failed'; continue; }
    if (handoff.processing?.pipelineCurrent !== true) { summary.status = 'revalidation_required'; summary.reasonCode = 'processing_version_not_current'; continue; }
    if ((handoff.memberId ?? null) !== (memberId ?? null) || (handoff.asOf ?? null) !== (asOf ?? null)) { summary.status = 'invalid'; summary.reasonCode = 'scope_mismatch'; continue; }
    if (handoff.policies.length > LIMITS.policies) throw new HouseholdReasoningError('HOUSEHOLD_PREVIEW_BOUND_EXCEEDED', 'A source holds more policies than the preview supports.', 422);
    const ids = new Set(handoff.policies.map(policy => policy.policyId));
    if (ids.size !== handoff.policies.length || [...ids].some(id => typeof id !== 'string' || !id || id.length > 128)) { summary.status = 'invalid'; summary.reasonCode = 'policy_ids_invalid'; continue; }

    summary.retrievalComplete = false; // Block 3 never establishes retrieval completeness; neither does this feature.
    summary.policyCount = handoff.policies.length;
    reviewRequired ||= handoff.reviewRequired === true;
    unassociatedFacts += Array.isArray(handoff.unassociatedFactIds) ? handoff.unassociatedFactIds.length : 0;
    const counts = Object.fromEntries(ITEM_STATES.map(state => [state, 0]));
    const openEnded = normalizeOpenEnded(handoff.openEndedFindings, ids);

    for (const policy of handoff.policies) {
      if (policy.items.length > LIMITS.itemsPerPolicy) throw new HouseholdReasoningError('HOUSEHOLD_PREVIEW_BOUND_EXCEEDED', 'A policy holds more items than the preview supports.', 422);
      totalItems += policy.items.length;
      if (totalItems > LIMITS.itemsTotal) throw new HouseholdReasoningError('HOUSEHOLD_PREVIEW_BOUND_EXCEEDED', 'The sources hold more items than the preview supports.', 422);
      const documents = Array.isArray(policy.association?.documents) ? policy.association.documents : [];
      const verified = policy.association?.verified === true;
      const held = perPolicy.get(policy.policyId) ?? { policyId: policy.policyId, kind: 'unresolved', coverBasis: 'unknown', verified: false, candidate: false, sourceIndexes: [], itemSets: [], openEnded: [] };
      perPolicy.set(policy.policyId, held);
      held.sourceIndexes.push(source.sourceIndex);
      // A policy type is kept only when every source that names the policy agrees; otherwise it is unresolved.
      const kind = POLICY_KINDS.includes(policy.kind) ? policy.kind : 'unresolved';
      held.kind = held.sourceIndexes.length === 1 ? kind : (held.kind === kind ? kind : 'unresolved');
      held.coverBasis = held.sourceIndexes.length === 1 ? (['individual', 'shared'].includes(policy.coverBasis) ? policy.coverBasis : 'unknown') : (held.coverBasis === policy.coverBasis ? held.coverBasis : 'unknown');
      held.verified ||= verified;
      held.candidate ||= documents.some(d => d?.status === 'candidate');
      const items = policy.items.map(raw => normalizeItem(raw, verified));
      for (const item of items) counts[item.state] += 1;
      held.itemSets.push(items);
      held.openEnded.push(...openEnded.filter(f => f.policyId === policy.policyId));
    }
    summary.itemCounts = counts;
    for (const entry of Array.isArray(handoff.conflicts) ? handoff.conflicts : []) {
      conflicts.push({ policyId: ids.has(entry?.policyId) ? entry.policyId : null, rule: boundedText(entry?.rule, 120) ?? 'conflict', topic: '', origin: 'source', citations: [] });
    }
  }

  if (perPolicy.size > LIMITS.policies) throw new HouseholdReasoningError('HOUSEHOLD_PREVIEW_BOUND_EXCEEDED', 'The sources hold more policies than the preview supports.', 422);
  const policies = [...perPolicy.values()].map(held => mergePolicy(held, conflicts)).sort((a, b) => (a.policyRef < b.policyRef ? -1 : 1));
  const seen = new Set();
  const uniqueConflicts = conflicts.map(c => ({ ...c, policyRef: c.policyId ? policyRefOf(c.policyId) : null })).filter(c => {
    const key = `${c.policyRef}|${c.rule}|${c.topic}|${c.origin}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ policyId: _p, ...rest }) => rest).sort((a, b) => (`${a.policyRef}|${a.rule}` < `${b.policyRef}|${b.rule}` ? -1 : 1));
  return deepFreeze({ sources: summaries, policies, conflicts: uniqueConflicts, reviewRequired, unassociatedFacts, retrievalComplete: false });
}

const signature = item => canonical({ s: item.state === 'known' ? 'value' : item.state, v: item.value, c: [...item.conditions].sort(), e: [...item.exceptions].sort(), o: [...item.overrides].sort() });
const DECISIVE = ['known', 'not_permitted', 'not_selected', 'available_not_selected'];

// Same logical policy seen through several authorised answers: identical evidence is deduplicated, contradictory
// evidence becomes a conflict with no controlling value, and nothing is chosen by arrival order or recency.
function mergePolicy(held, conflicts) {
  const byKey = new Map();
  for (const items of held.itemSets) for (const item of items) {
    const key = `${item.rule}\u0000${item.topic}`;
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  const merged = [...byKey.values()].map(group => {
    // Every choice below is made on a canonically ordered copy, so arrival order of the sources never changes the result.
    const ordered = [...group].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1));
    if (ordered.length === 1) return ordered[0];
    const decisive = ordered.filter(item => DECISIVE.includes(item.state));
    const distinct = new Set(decisive.map(signature));
    const citations = mergeCitations(...ordered.map(item => item.citations));
    const first = ordered[0];
    if (ordered.some(item => item.state === 'conflicting') || distinct.size > 1) {
      const origin = ordered.some(item => item.state === 'conflicting') && distinct.size <= 1 ? 'source' : 'cross_input';
      conflicts.push({ policyId: held.policyId, rule: first.rule, topic: first.topic, origin, citations });
      return { ...first, state: 'conflicting', value: null, citations, conflicting: citations, provenance: 'unavailable', reasonCode: origin === 'cross_input' ? 'cross_input_conflict' : 'controlling_sources_disagree', conditions: [], exceptions: [], overrides: [], conditional: false, candidateAvailable: false, completion: undefined };
    }
    const pick = decisive[0] ?? ordered.find(item => item.state === 'dynamic_check') ?? ordered.find(item => item.state === 'unverified')
      ?? ordered.find(item => item.reasonCode === 'as_of_required') ?? first;
    // Waiting-period completion is derived per source from that source's continuity evidence. If sources disagree on it,
    // no completion is reported rather than the first one winning.
    const completions = new Set(decisive.map(item => canonical(item.completion ?? null)));
    const completion = completions.size > 1 ? { state: 'unknown', reason: 'completion_differs_across_sources' } : pick.completion;
    const out = {
      ...pick, citations, conditions: [...new Set(ordered.flatMap(item => (item.state === pick.state ? item.conditions : [])))].sort(),
      candidateAvailable: ordered.some(item => item.candidateAvailable),
    };
    if (completion) out.completion = completion; else delete out.completion;
    return out;
  }).sort((a, b) => (`${a.rule}|${a.topic}` < `${b.rule}|${b.topic}` ? -1 : 1));
  for (const item of merged) if (item.state === 'conflicting' && !conflicts.some(c => c.policyId === held.policyId && c.rule === item.rule && c.topic === item.topic)) {
    conflicts.push({ policyId: held.policyId, rule: item.rule, topic: item.topic, origin: 'source', citations: item.citations });
  }
  const seenOpen = new Set();
  const openEnded = [...held.openEnded].sort((a, b) => (canonical(a) < canonical(b) ? -1 : 1)).filter(f => { const key = canonical([f.factType, f.topic, f.effect, f.verified, f.citations.map(citationKey)]); if (seenOpen.has(key)) return false; seenOpen.add(key); return true; });
  return {
    policyId: held.policyId, policyRef: policyRefOf(held.policyId), kind: held.kind, coverBasis: held.coverBasis,
    associationState: held.verified ? 'verified' : held.candidate ? 'candidate_unverified' : 'unresolved',
    sourceIndexes: [...new Set(held.sourceIndexes)].sort((a, b) => a - b), items: merged, openEnded,
  };
}
