// Synthetic Block 4 fixtures. Handoffs are built through the real Block 3 catalogue builder (buildDecisionCatalogue +
// toHandoff), so authority comes from the same code the product uses, never from a hand-written "known" object.
// Synthetic data only: no real policy, person, hospital or insurer.
import { buildDecisionCatalogue, toHandoff } from '../../src/features/decision-catalogue/index.js';

export const AMT = amountMinor => ({ kind: 'amount', amountMinor, currency: 'INR' });
export const MEMBER_A = 'member-a';
export const MEMBER_B = 'member-b';

/**
 * @param spec { memberId, asOf, answerId, pipelineCurrent, policies: [{ id, kind, coverBasis, verified, facts: [fact] }] }
 *   fact: { type, topic, value, member, selection, conditions, exceptions, overrides, effective, version, review }
 *   review: 'accepted' (reviewed, proven), 'self_confirmed' (reported only), 'model' (unreviewed extraction).
 */
export function makeBuilt({ memberId = null, asOf = null, answerId = 'answer-1', pipelineCurrent = true, policies }) {
  const clauseRows = [];
  const accepted = [];
  const reported = [];
  const model = [];
  const verifiedPolicyIds = [];
  for (const policy of policies) {
    if (policy.verified !== false) verifiedPolicyIds.push(policy.id);
    for (const [index, fact] of policy.facts.entries()) {
      const version = String(fact.version ?? '1');
      const documentId = fact.documentId ?? `doc-${policy.id}`;
      const clauseId = `c-${policy.id}-${version}-${index}`;
      clauseRows.push({ id: clauseId, documentId, sourceVersion: version, page: fact.page ?? 1, digest: `sha-${clauseId}` });
      const review = fact.review ?? 'accepted';
      const candidate = {
        policyId: policy.id, policyAssociation: { basis: 'schedule' }, documentId, sourceVersion: version,
        sourceType: review === 'model' ? 'user_statement' : (fact.sourceType ?? 'issued_schedule'), clauseIds: [clauseId],
        factType: fact.type, topic: fact.topic ?? '', value: fact.value, selection: fact.selection, conditions: fact.conditions, exceptions: fact.exceptions, overrides: fact.overrides,
        effective: fact.effective, familyId: fact.familyId, supersedes: fact.supersedes,
        explicitState: fact.explicitState,
        subject: fact.member ? { memberId: fact.member, scope: 'member' } : undefined,
      };
      (review === 'accepted' ? accepted : review === 'self_confirmed' ? reported : model).push(candidate);
    }
  }
  const batches = [];
  if (model.length) batches.push({ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates: model });
  if (reported.length) batches.push({ origin: 'human_review', reviewStatus: 'self_confirmed', verifiedPolicyIds: [], candidates: reported });
  if (accepted.length) batches.push({ origin: 'human_review', reviewStatus: 'accepted', verifiedPolicyIds, candidates: accepted });
  const catalogue = buildDecisionCatalogue({
    householdId: 'household-synthetic', clauseRows, batches, asOf, memberId,
    policies: policies.map(policy => ({ policyId: policy.id, kind: policy.kind ?? 'unresolved', coverBasis: policy.coverBasis ?? 'unknown' })),
  });
  const documentAssociations = policies.map(policy => ({ policyId: policy.id, documentId: `doc-${policy.id}`, status: policy.verified === false ? 'candidate' : 'candidate', basis: 'printed_policy_number' }));
  return { sourceAnswerId: answerId, pipelineCurrent, catalogue: { ...catalogue, documentAssociations }, skipped: [] };
}

export const makeHandoff = options => toHandoff(makeBuilt(options));

export const enrolled = (member = MEMBER_A, extra = {}) => ({ type: 'member_enrolment', value: { status: 'enrolled' }, member, ...extra });
export const notEnrolled = (member = MEMBER_A, extra = {}) => ({ type: 'member_enrolment', value: { status: 'not_enrolled' }, member, ...extra });
export const sublimit = (topic, amountMinor, extra = {}) => ({ type: 'sublimit', topic, value: AMT(amountMinor), ...extra });
export const sumInsured = (amountMinor, extra = {}) => ({ type: 'sum_insured', value: { amountMinor, currency: 'INR' }, ...extra });
export const waitingPeriod = (months, extra = {}) => ({ type: 'waiting_period', value: { months }, ...extra });
export const exclusion = (topic, extra = {}) => ({ type: 'exclusion', topic, value: { kind: 'permanent' }, ...extra });
export const policyPeriod = (start, end, extra = {}) => ({ type: 'policy_period', value: { start, end }, ...extra });
export const continuity = (since, member = MEMBER_A, extra = {}) => ({ type: 'continuous_cover', value: { since, uninterrupted: true }, member, ...extra });

/** A request body for household-scenario/v1 with sensible defaults. */
export const requestOf = (scenario = {}, sources = [{ caseId: 'case-1', answerId: 'answer-1' }]) => ({
  contractVersion: 'household-scenario/v1', sources,
  scenario: { scenarioType: 'planned_procedure', ...scenario },
});

export const okSource = (handoff, sourceIndex = 0) => ({ sourceIndex, status: 'ok', handoff });

import { validateScenarioInput, buildHouseholdCoveragePreview, buildCoverageMap, normalizeSources, buildComparisons } from '../../src/features/household-reasoning/index.js';

/** Validate a scenario, normalise handoffs and return every intermediate: { request, scenario, normalized, positions, comparisons, preview }. */
export function run(scenarioFields, handoffs, { sourcesOverride } = {}) {
  const request = validateScenarioInput(requestOf(scenarioFields));
  const sources = sourcesOverride ?? handoffs.map((handoff, index) => okSource(handoff, index));
  const scenario = request.scenario;
  const normalized = normalizeSources(sources, { memberId: scenario.effective.memberId, asOf: scenario.effective.plannedDate });
  const positions = buildCoverageMap(normalized, scenario);
  const comparisons = buildComparisons(positions, normalized, scenario);
  return { request, scenario, normalized, positions, comparisons, preview: () => buildHouseholdCoveragePreview({ request, sources }) };
}
