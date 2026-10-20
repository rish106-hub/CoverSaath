import { createHash } from 'node:crypto';
import { CONTRACTUAL_SOURCES, isIsoDate } from '../../features/decision-catalogue/contracts.js';
import { CURATED_OFFICIAL_SOURCES, answerToCandidates, associateDocuments, buildDecisionCatalogue, typedTwins } from '../../features/decision-catalogue/index.js';

// Builds the Block 3 decision catalogue from one stored policy answer (ADR 0008) and, since ADR 0009 part 2, the
// authenticated reviews recorded against its facts. Read paths are derived on every call: revoking consent or erasing a
// document removes the facts, and the reviews that cite it, from the next response. Model facts stay `extracted_unverified`.
// Authority never comes from a request body: a reviewer's strength is read from catalogue_reviewer_grants.

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }
const factKeyOf = factId => createHash('sha256').update(String(factId)).digest('hex');
const notFound = () => coded('POLICY_EVIDENCE_NOT_FOUND', 'The requested policy evidence was not found.', 404);

// A catalogue fact back into an ingestible candidate (review replays the exact server-held fact, never a client copy).
const candidateFromFact = (fact, extra = {}) => ({
  policyId: fact.policyId, policyAssociation: { basis: fact.association?.basis ?? 'unstated' },
  documentId: fact.documentId, sourceVersion: fact.sourceVersion, familyId: fact.familyId, sourceType: fact.sourceType,
  declaredSourceType: fact.declaredSourceType, clauseIds: [...fact.clauseIds], factType: fact.factType, topic: fact.topic,
  registryKey: fact.registryKey, caseId: fact.caseId, completeness: fact.completeness,
  subject: { memberId: fact.subject.memberId, scope: fact.subject.scope }, selection: fact.selection, value: fact.value, unit: fact.unit,
  conditions: [...fact.conditions], exceptions: [...fact.exceptions], overrides: [...fact.overrides], effective: { ...fact.effective },
  ...extra,
});

export function createDecisionCatalogueService({ services, evidence } = {}) {
  if (!services?.clauses || !services?.documents || typeof evidence?.readForCatalogue !== 'function') {
    throw new TypeError('services and an evidence service are required.');
  }
  const reviews = services.catalogueReviews ?? null;

  function load({ caseRecord, answerId }) {
    if (typeof answerId !== 'string' || !answerId || answerId.length > 256) throw coded('VALIDATION_ERROR', 'answerId is required.', 400);
    const householdId = caseRecord.household_id;
    const stored = evidence.readForCatalogue({ caseRecord, answerId });
    const clauseRows = services.clauses.listClauses({ householdId, caseId: caseRecord.id, documentIds: stored.documentIds });
    const documentKinds = new Map(stored.documentIds.map(id => [id, services.documents.getDocument(id)?.documentKind]));
    // Which policy a document belongs to is a CANDIDATE finding only (printed policy number, see association.js) and is
    // never verified by this path. A document with no single printed number stays on one unresolved policy per answer.
    const unresolvedId = `unresolved-${stored.answerId}`;
    const association = associateDocuments(clauseRows, stored.documentIds);
    const policyByDocument = new Map(association.documents.filter(d => d.policyId).map(d => [d.documentId, d]));
    const { candidates: base, skipped } = answerToCandidates(stored.answer, { clauseRows, documentKinds, policyId: unresolvedId });
    const placed = base.map(candidate => {
      const found = policyByDocument.get(candidate.documentId);
      return found ? { ...candidate, policyId: found.policyId, policyAssociation: { basis: found.basis } } : candidate;
    });
    const all = [...placed, ...typedTwins(placed, clauseRows)];
    const policyIds = [...new Set([...association.policies.map(policy => policy.policyId), ...(all.some(c => c.policyId === unresolvedId) || !association.policies.length ? [unresolvedId] : [])])];
    return { householdId, stored, clauseRows, policyIds, association, candidates: all, skipped };
  }

  const evidenceRows = rows => rows.map(row => ({ id: row.clauseId, documentId: row.documentId, sourceVersion: row.sourceVersion, page: row.page, digest: row.digest }));
  const compose = (ctx, batches, { asOf, memberId }) => buildDecisionCatalogue({
    householdId: ctx.householdId, clauseRows: evidenceRows(ctx.clauseRows), batches,
    policies: ctx.policyIds.map(policyId => ({ policyId, kind: 'unresolved', coverBasis: 'unknown' })), asOf, memberId,
    officialSources: CURATED_OFFICIAL_SOURCES, today: new Date().toISOString().slice(0, 10),
  });
  const modelBatch = candidates => ({ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates });

  function checkQuery({ asOf, memberId }) {
    if (asOf !== null && !isIsoDate(asOf)) throw coded('VALIDATION_ERROR', 'asOf must be a YYYY-MM-DD date.', 400);
    if (memberId !== null && (typeof memberId !== 'string' || !memberId.trim() || memberId.length > 128)) throw coded('VALIDATION_ERROR', 'memberId is malformed.', 400);
  }

  // A review counts only while the clauses it cited are still live with the same digests and version.
  const reviewIsCurrent = (review, ctx, modelFactIds) => {
    const byId = new Map(ctx.clauseRows.map(row => [row.clauseId, row]));
    return review.clauseIds.length > 0 && review.clauseIds.every((id, i) => {
      const row = byId.get(id);
      return row && row.documentId === review.documentId && row.sourceVersion === review.sourceVersion && row.digest === review.sourceDigests[i];
    }) && modelFactIds.has(review.factKey);
  };

  function build({ caseRecord, answerId, asOf = null, memberId = null }) {
    checkQuery({ asOf, memberId });
    const ctx = load({ caseRecord, answerId });
    const first = compose(ctx, [modelBatch(ctx.candidates)], { asOf, memberId });
    const factByKey = new Map(first.facts.map(fact => [factKeyOf(fact.factId), fact]));
    const all = reviews ? reviews.list({ householdId: ctx.householdId, caseId: caseRecord.id }) : [];
    const reviewSummary = [];
    const rejectedKeys = new Set();
    const reviewedBatches = [];
    for (const review of all) {
      const current = reviewIsCurrent(review, ctx, new Set(factByKey.keys()));
      const state = review.superseded ? 'superseded' : !current ? 'stale' : review.decision;
      reviewSummary.push({ reviewId: review.reviewId, factId: factByKey.get(review.factKey)?.factId ?? null, decision: review.decision, state, authority: review.authority, reasonCode: review.reasonCode, reviewedAt: review.createdAt });
      if (state === 'rejected') rejectedKeys.add(review.factKey);
      if (state !== 'accepted') continue;
      const fact = factByKey.get(review.factKey);
      const attestedType = review.authority === 'independent' && Object.hasOwn(CONTRACTUAL_SOURCES, review.fact?.attestedSourceType) ? review.fact.attestedSourceType : null;
      const independent = review.authority === 'independent';
      reviewedBatches.push({
        origin: 'human_review',
        // A household confirmation is a statement by the data subject: it is `reported` at most, never `proven`.
        reviewStatus: independent ? 'accepted' : 'self_confirmed',
        verifiedPolicyIds: independent && review.fact?.attestsPolicyAssociation === true ? [fact.policyId] : [],
        candidates: [candidateFromFact(fact, { sourceType: attestedType ?? 'user_statement', supersedes: [] })],
      });
    }
    const keptModel = ctx.candidates.filter((candidate) => {
      if (!rejectedKeys.size) return true;
      const probe = compose(ctx, [modelBatch([candidate])], { asOf, memberId }).facts[0];
      return !(probe && rejectedKeys.has(factKeyOf(probe.factId)));
    });
    const catalogue = reviewedBatches.length || rejectedKeys.size ? compose(ctx, [modelBatch(keptModel), ...reviewedBatches], { asOf, memberId }) : first;
    const disputed = reviewSummary.filter(item => item.state === 'disputed');
    const withAssociation = { ...catalogue, documentAssociations: ctx.association.documents };
    const out = reviewSummary.length ? Object.freeze({
      ...withAssociation, reviews: Object.freeze(reviewSummary),
      reviewRequired: catalogue.reviewRequired || disputed.length > 0,
      conflicts: Object.freeze([...catalogue.conflicts, ...disputed.map(item => ({ policyId: factByKey.get(factKeyOf(item.factId))?.policyId ?? null, rule: `review_disputed/${item.factId}`, conflicting: null }))]),
    }) : Object.freeze({ ...withAssociation, reviews: Object.freeze([]) });
    // An answer stored by an earlier pipeline is served as stored; the flag tells the reader it was not re-bucketed.
    return { sourceAnswerId: ctx.stored.answerId, pipelineCurrent: ctx.stored.pipelineCurrent, catalogue: out, skipped: ctx.skipped };
  }

  /** Who may review: a household confirmer who still holds a household role, or an independent reviewer with an active grant. */
  function reviewerCase(principal, caseId) {
    const caseRecord = services.access.database.prepare('SELECT * FROM service_cases WHERE id = ?').get(caseId);
    const grant = caseRecord && reviews?.activeGrant(caseRecord.household_id, principal.adultId);
    if (!grant) throw notFound();
    if (grant.kind === 'household_confirmer') {
      try { services.access.requireHousehold(principal, caseRecord.household_id, { write: false }); } catch { throw notFound(); }
    }
    return caseRecord;
  }

  function record({ principal, caseId, answerId, factId, decision, reasonCode, attestedSourceType = null, attestsPolicyAssociation = false, idempotencyKey, asOf = null, memberId = null }) {
    if (!reviews) throw coded('REVIEWS_UNAVAILABLE', 'Reviews are unavailable.', 503);
    const caseRecord = reviewerCase(principal, caseId);
    if (typeof factId !== 'string' || !factId || factId.length > 128) throw coded('VALIDATION_ERROR', 'factId is required.', 400);
    if (attestedSourceType !== null && !Object.hasOwn(CONTRACTUAL_SOURCES, attestedSourceType)) throw coded('VALIDATION_ERROR', 'attestedSourceType is not a contractual source type.', 400);
    if (typeof attestsPolicyAssociation !== 'boolean') throw coded('VALIDATION_ERROR', 'attestsPolicyAssociation must be a boolean.', 400);
    // The reviewed fact is rebuilt on the server from live clauses after the consent and currency re-check. The caller
    // names a factId and never supplies a value, a clause or a digest.
    const ctx = load({ caseRecord, answerId });
    const fact = compose(ctx, [modelBatch(ctx.candidates)], { asOf, memberId }).facts.find(item => item.factId === factId);
    if (!fact) throw notFound();
    const stored = reviews.record({
      householdId: ctx.householdId, caseId: caseRecord.id, reviewerAdultId: principal.adultId, idempotencyKey, decision, reasonCode,
      documentId: fact.documentId, sourceVersion: fact.sourceVersion, clauseIds: fact.clauseIds, sourceDigests: fact.sourceDigests,
      factKey: factKeyOf(fact.factId), fact: { ...candidateFromFact(fact), attestedSourceType, attestsPolicyAssociation },
    });
    return { reviewId: stored.reviewId, replayed: stored.replayed, decision: stored.decision, authority: stored.authority, factId };
  }

  // Only an active independent grant opens a case without a household role. Everyone else gets the normal household rules.
  function independentReviewerCase(principal, caseId) {
    if (!reviews || typeof caseId !== 'string') return null;
    const caseRecord = services.access.database.prepare('SELECT * FROM service_cases WHERE id = ?').get(caseId);
    const grant = caseRecord && reviews.activeGrant(caseRecord.household_id, principal.adultId);
    return grant?.kind === 'independent_reviewer' ? caseRecord : null;
  }

  return Object.freeze({ build, record, independentReviewerCase });
}
