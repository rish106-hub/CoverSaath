// Block 4 handoff adapter (Phase 7). Reads a decision catalogue and returns a flat, versioned view whose vocabulary a
// consumer can use without rereading any document: known, unverified, conflicting, missing, not_permitted, not_selected,
// available_not_selected, dynamic_check. A value is present only when the state is `known`; an unverified candidate is
// carried separately as `candidateValue` and is never a number to calculate with. No recommendation is made here.
import { CATALOGUE_VERSION, deepFreeze } from './contracts.js';

export const HANDOFF_VERSION = 'decision-handoff/v1';
export const HANDOFF_STATES = Object.freeze(['known', 'unverified', 'conflicting', 'missing', 'not_permitted', 'not_selected', 'available_not_selected', 'dynamic_check']);

const STATE_BY_STATUS = Object.freeze({
  known: 'known', unverified: 'unverified', conflict: 'conflicting', unknown: 'missing', not_permitted: 'not_permitted',
  not_selected: 'not_selected', available_not_selected: 'available_not_selected', dynamic: 'dynamic_check',
});

const item = (rule, policyId) => {
  const result = rule.result;
  const state = STATE_BY_STATUS[result.status] ?? 'missing'; // an unrecognised status is never read as known
  return {
    policyId, rule: rule.rule, topic: rule.topic, state,
    value: state === 'known' ? result.value : null,
    candidateValue: state === 'unverified' || state === 'dynamic_check' ? (result.candidateValue ?? null) : null,
    reason: result.reason ?? null,
    citations: result.citations ?? [], conditions: result.conditions ?? [], exceptions: result.exceptions ?? [], overrides: result.overrides ?? [],
    conflicting: state === 'conflicting' ? result.conflicting ?? [] : [],
    discrepancies: result.discrepancies ?? [],
    associationVerified: result.associationVerified ?? false,
    conditional: rule.conditional === true,
    ...(rule.completion ? { completion: rule.completion } : {}),
  };
};

/** @param built the object returned by the catalogue service: { sourceAnswerId, pipelineCurrent, catalogue, skipped } */
export function toHandoff(built) {
  const c = built?.catalogue;
  if (c?.catalogueVersion !== CATALOGUE_VERSION) throw new TypeError(`Unsupported catalogue version; expected ${CATALOGUE_VERSION}.`);
  const policies = c.policies.map(layer => ({
    policyId: layer.policyId, kind: layer.kind, coverBasis: layer.coverBasis, spendableCash: false,
    association: {
      verified: c.facts.some(f => f.policyId === layer.policyId && f.association?.verified === true),
      documents: (c.documentAssociations ?? []).filter(d => d.policyId === layer.policyId).map(d => ({ documentId: d.documentId, status: d.status, basis: d.basis })),
    },
    items: layer.rules.map(rule => item(rule, layer.policyId)),
  }));
  const items = policies.flatMap(policy => policy.items);
  const openEnded = c.openEndedFacts.map(fact => ({
    factId: fact.factId, policyId: fact.policyId, factType: fact.factType, topic: fact.topic, state: fact.state, verified: fact.verified,
    effect: fact.value?.effect ?? null, citations: fact.clauseIds.map((clauseId, i) => ({ clauseId, documentId: fact.documentId, sourceVersion: fact.sourceVersion, page: fact.page, digest: fact.sourceDigests[i] ?? null })),
    conditions: fact.conditions, exceptions: fact.exceptions, overrides: fact.overrides,
  }));
  return deepFreeze({
    handoffVersion: HANDOFF_VERSION, catalogueVersion: c.catalogueVersion,
    processing: { sourceAnswerId: built.sourceAnswerId ?? null, pipelineCurrent: built.pipelineCurrent ?? null },
    asOf: c.asOf, memberId: c.memberId,
    policies, openEndedFindings: openEnded,
    conflicts: c.conflicts, unassociatedFactIds: c.unassociatedFacts,
    reviews: c.reviews ?? [], reviewRequired: c.reviewRequired,
    dynamicChecks: items.filter(i => i.state === 'dynamic_check').map(i => ({ policyId: i.policyId, rule: i.rule, topic: i.topic, requires: 'current confirmation from the insurer, TPA or hospital' })),
    officialSources: c.officialSources,
    coordination: c.coordination, combinedConfirmedCover: null,
    completeness: {
      retrievalComplete: false, // retrieval completeness is never established (catalogue limitations)
      itemCounts: Object.fromEntries(HANDOFF_STATES.map(state => [state, items.filter(i => i.state === state).length])),
      openEndedFindings: openEnded.length, unverifiedFacts: c.facts.filter(f => !f.verified).length,
      rejectedCandidates: c.rejected.length, skippedAnswerEntries: built.skipped?.length ?? 0,
    },
    limitations: c.limitations,
  });
}

/** Contract check for a consumer or a test: the invariants Block 4 relies on. Throws on the first breach. */
export function assertHandoffContract(handoff) {
  const fail = message => { throw new Error(`Handoff contract: ${message}`); };
  if (handoff?.handoffVersion !== HANDOFF_VERSION) fail('version');
  if (handoff.catalogueVersion !== CATALOGUE_VERSION) fail('catalogue version');
  if (handoff.combinedConfirmedCover !== null) fail('combined cover must be null');
  if (!Array.isArray(handoff.policies)) fail('policies');
  for (const policy of handoff.policies) {
    if (policy?.spendableCash !== false) fail('limits are never spendable cash');
    if (!Array.isArray(policy.items)) fail('items');
    for (const entry of policy.items) {
      if (!HANDOFF_STATES.includes(entry.state)) fail(`state ${entry.state}`);
      if ((entry.state === 'known') !== (entry.value !== null)) fail(`value only when known (${entry.rule})`);
      if (entry.state === 'known' && (!Array.isArray(entry.citations) || !entry.citations.length || entry.associationVerified !== true)) fail(`known needs citations and a verified association (${entry.rule})`);
      if (entry.state !== 'unverified' && entry.state !== 'dynamic_check' && entry.candidateValue !== null) fail(`candidate value leaked (${entry.rule})`);
    }
  }
  return true;
}
