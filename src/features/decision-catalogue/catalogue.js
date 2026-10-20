// B3-7 versioned Block 4 handoff. Derived on read from live evidence: there is no derived store, so revoking a
// source or erasing a document removes its facts from the next build and nothing is left to erase.
import { CATALOGUE_VERSION, deepFreeze, isIsoDate, text } from './contracts.js';
import { ingestFacts } from './facts.js';
import { separatePolicies } from './cross-policy.js';
import { resolveApplicable } from './applicability.js';
import { validateOfficialSource } from './official-sources.js';

/** Clause rows come from ClauseRepository.listClauses (active documents of this household and case only). */
export function buildEvidenceIndex(clauseRows, householdId) {
  const index = new Map();
  for (const row of clauseRows ?? []) {
    const id = row.id ?? row.clauseId;
    const documentId = row.documentId ?? row.document_id;
    const sourceVersion = row.sourceVersion ?? row.source_version;
    if (!id || !documentId || !sourceVersion) continue;
    // Rows come from the household-scoped ClauseRepository. Any lifecycle or household key that is present must
    // say active and match; a null or other value denies.
    if ('householdId' in row && row.householdId !== householdId) continue;
    if ('status' in row && row.status !== 'active') continue;
    if ('lifecycleState' in row && row.lifecycleState !== 'active') continue;
    index.set(id, { householdId, documentId, sourceVersion, page: row.page, live: true });
  }
  return index;
}

export function buildDecisionCatalogue({ householdId, batches, clauseRows, policies, asOf = null, memberId = null, officialSources = [], today = null }) {
  if (asOf !== null && !isIsoDate(asOf)) throw new TypeError('asOf must be an ISO date.');
  const evidenceIndex = buildEvidenceIndex(clauseRows, householdId);
  const facts = [];
  const rejected = [];
  const seen = new Set();
  for (const batch of batches ?? []) {
    const result = ingestFacts(batch.candidates, { householdId, evidenceIndex, origin: batch.origin, reviewStatus: batch.reviewStatus, verifiedPolicyIds: new Set(batch.verifiedPolicyIds ?? []) });
    for (const fact of result.facts) if (!seen.has(fact.factId)) { seen.add(fact.factId); facts.push(fact); }
    rejected.push(...result.rejected);
  }
  const layout = separatePolicies(policies, facts, { asOf, memberId });
  const policyIds = new Set(policies.map(policy => policy.policyId));
  const unresolvedConflicts = layout.layers.flatMap(layer => layer.rules.filter(rule => rule.result.status === 'conflict').map(rule => ({ policyId: layer.policyId, rule: rule.rule, conflicting: rule.result.conflicting })));
  const riders = layout.layers.flatMap(layer => facts
    .filter(fact => fact.policyId === layer.policyId && fact.factType === 'add_on')
    .map(fact => fact.topic)
    .filter((topic, i, all) => all.indexOf(topic) === i)
    .map(topic => ({ policyId: layer.policyId, rider: topic, ...pickRider(resolveApplicable(facts, { policyId: layer.policyId, memberId, asOf, factType: 'add_on', topic })) })));
  return deepFreeze({
    catalogueVersion: CATALOGUE_VERSION,
    asOf, memberId: text(memberId, 128),
    policies: layout.layers,
    coordination: layout.coordination,
    combinedConfirmedCover: layout.combinedConfirmedCover,
    facts,
    openEndedFacts: facts.filter(fact => !['sum_insured', 'room_rent_limit', 'icu_limit', 'copay', 'deductible', 'sublimit', 'waiting_period', 'exclusion', 'add_on', 'restoration', 'bonus', 'policy_period'].includes(fact.factType)),
    riders,
    conflicts: [...unresolvedConflicts, ...riders.filter(rider => rider.status === 'conflict').map(rider => ({ policyId: rider.policyId, rule: `add_on/${rider.rider}`, conflicting: null }))],
    unassociatedFacts: facts.filter(fact => !fact.policyId || !policyIds.has(fact.policyId)).map(fact => fact.factId),
    rejected,
    officialSources: today ? officialSources.map(record => validateOfficialSource(record, { today })) : [],
    reviewRequired: facts.some(fact => !fact.verified) || unresolvedConflicts.length > 0 || riders.some(rider => rider.status === 'conflict'),
    limitations: ['Derived from the evidence supplied; retrieval completeness is not established.', 'Not legal review. No claim approval or payout is predicted.'],
  });
}

const pickRider = d => ({ status: d.status, selection: d.selection, citations: d.citations });
