import { isIsoDate } from '../../features/decision-catalogue/contracts.js';
import { answerToCandidates, buildDecisionCatalogue } from '../../features/decision-catalogue/index.js';

// Builds the Block 3 decision catalogue from one stored policy answer (ADR 0008). Read only and derived on every call:
// nothing is stored, so revoking consent or erasing a document removes the facts from the next response. The answer
// is model-assisted evidence, so every fact is attested as `model` origin and stays unverified.

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }

export function createDecisionCatalogueService({ services, evidence } = {}) {
  if (!services?.clauses || !services?.documents || typeof evidence?.readForCatalogue !== 'function') {
    throw new TypeError('services and an evidence service are required.');
  }
  return Object.freeze({
    build({ caseRecord, answerId, asOf = null, memberId = null }) {
      if (typeof answerId !== 'string' || !answerId || answerId.length > 256) throw coded('VALIDATION_ERROR', 'answerId is required.', 400);
      if (asOf !== null && !isIsoDate(asOf)) throw coded('VALIDATION_ERROR', 'asOf must be a YYYY-MM-DD date.', 400);
      if (memberId !== null && (typeof memberId !== 'string' || !memberId.trim() || memberId.length > 128)) throw coded('VALIDATION_ERROR', 'memberId is malformed.', 400);
      const householdId = caseRecord.household_id;
      const stored = evidence.readForCatalogue({ caseRecord, answerId });
      const clauseRows = services.clauses.listClauses({ householdId, caseId: caseRecord.id, documentIds: stored.documentIds });
      const documentKinds = new Map(stored.documentIds.map(id => [id, services.documents.getDocument(id)?.documentKind]));
      // Which policy a document belongs to is not established (ADR 0007), so every fact is tied to an unresolved
      // policy whose association is never verified.
      const policyId = `unresolved-${stored.answerId}`;
      const { candidates, skipped } = answerToCandidates(stored.answer, { clauseRows, documentKinds, policyId });
      const catalogue = buildDecisionCatalogue({
        householdId, clauseRows: clauseRows.map(row => ({ id: row.clauseId, documentId: row.documentId, sourceVersion: row.sourceVersion, page: row.page, digest: row.digest })),
        batches: [{ origin: 'model', reviewStatus: 'not_reviewed', verifiedPolicyIds: [], candidates }],
        policies: [{ policyId, kind: 'unresolved', coverBasis: 'unknown' }], asOf, memberId,
      });
      // An answer stored by an earlier pipeline is served as stored; the flag tells the reader it was not re-bucketed.
      return { sourceAnswerId: stored.answerId, pipelineCurrent: stored.pipelineCurrent, catalogue, skipped };
    },
  });
}
