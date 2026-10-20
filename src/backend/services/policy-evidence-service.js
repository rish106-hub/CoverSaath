import { createHash } from 'node:crypto';
import { QUESTION_CONSENT_SCOPE } from '../../contracts/policy-evidence.js';
import { buildClauses, investigate } from '../../features/policy-evidence/index.js';
import { extractFields, FIELD_NAMES } from '../../features/ai-analysis/eval-extractor.js';

// Answers one question about a case's policy documents (ADR 0008): stored OCR blocks become clauses, the
// privacy-gated clauses go to Gemini through the injected model call, code validates and assembles a cited
// conditional answer, and one immutable answer row is committed after consent is re-checked. The answer is
// evidence with unknowns, never a coverage decision. Off unless POLICY_EVIDENCE_ENABLED=true.

const MAX_KNOWN_IDENTIFIERS = 200;
const MAX_IN_FLIGHT = 4;
const MAX_DOCUMENTS = 10;

export const evidenceEnabled = (env = process.env) => env.POLICY_EVIDENCE_ENABLED === 'true';

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }

// Same shape as policy structuring's document grant: an active grant of the adult whose scope names this exact
// document for question-time Gemini use. A structuring grant (`insurance_document`) does not authorise questions.
export function questionGrantCheck({ consents, grantId, subjectAdultId, documentId, householdId }) {
  const scope = { resourceType: QUESTION_CONSENT_SCOPE.resourceType, action: QUESTION_CONSENT_SCOPE.action, dataCategory: QUESTION_CONSENT_SCOPE.dataCategory, recipient: QUESTION_CONSENT_SCOPE.recipient };
  return () => {
    consents.requireActive(grantId, { subjectAdultId, resourceId: documentId, ...scope });
    const grant = consents.get(grantId);
    const named = grant?.household_id === householdId && grant.scopes.some(entry => entry.resource_type === scope.resourceType
      && entry.resource_id === documentId && entry.action === scope.action && entry.data_category === scope.dataCategory && entry.recipient === scope.recipient);
    if (!named) throw coded('CONSENT_SCOPE_REQUIRED', 'A document-specific question grant is required.', 403);
  };
}

const documentNames = pages => {
  try {
    const fields = extractFields(pages, FIELD_NAMES);
    return [fields.policyholder_name?.value, ...[fields.insured_members?.value].flat()]
      .filter(value => typeof value === 'string' && /\p{L}/u.test(value) && value.length <= 200)
      .map(value => ({ kind: 'NAME', value }));
  } catch { return []; }
};

export function createPolicyEvidenceService({ services, loadKnownIdentifiers, createModelCall, env = process.env } = {}) {
  if (!services?.clauses || typeof loadKnownIdentifiers !== 'function' || typeof createModelCall !== 'function') {
    throw new TypeError('services, loadKnownIdentifiers and createModelCall are required.');
  }
  let inFlight = 0;

  // Clauses are derived deterministically on first use; a document without complete stored blocks is skipped.
  function ensureClauses({ householdId, caseId, documentId }) {
    const stored = services.ocr.getDocumentBlockPages({ documentId, householdId });
    if (!stored.complete) return null;
    if (!services.clauses.clauseDocumentIds({ householdId, caseId }).includes(documentId)) {
      const { clauses } = buildClauses(stored, { documentId, sourceVersion: stored.sourceVersion });
      if (clauses.length) services.clauses.saveClauses({ householdId, caseId, documentId, clauses });
    }
    return stored;
  }

  return Object.freeze({
    async ask({ caseRecord, subjectAdultId, question, consentGrantId, idempotencyKey }) {
      if (!evidenceEnabled(env)) throw coded('EVIDENCE_DISABLED', 'Policy questions are disabled.', 503);
      const { id: caseId, household_id: householdId } = caseRecord;
      if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw coded('VALIDATION_ERROR', 'question is required.', 400);
      if (typeof consentGrantId !== 'string' || !consentGrantId) throw coded('VALIDATION_ERROR', 'consentGrantId is required.', 400);
      const requestDigest = createHash('sha256').update(JSON.stringify([caseId, question.trim(), consentGrantId])).digest('hex');
      // A replay is served from the stored answer before any consent check or paid work.
      const replay = services.clauses.findAnswerByKey({ householdId, caseId, idempotencyKey, requestDigest });
      if (replay) return replay;
      if (inFlight >= MAX_IN_FLIGHT) throw coded('EVIDENCE_BUSY', 'Too many questions are in progress.', 503);

      // Only documents the grant names for question-time use are read.
      const candidates = services.documents.listForCase(caseId, householdId).filter(document => document.lifecycleState === 'active').slice(0, MAX_DOCUMENTS);
      const checks = new Map();
      for (const document of candidates) {
        const check = questionGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId });
        try { check(); checks.set(document.id, check); } catch (error) {
          if (!['CONSENT_SCOPE_REQUIRED', 'CONSENT_REQUIRED', 'CONSENT_REVOKED', 'CONSENT_EXPIRED'].includes(error?.code) && !/^CONSENT_/.test(String(error?.code))) throw error;
        }
      }
      if (!checks.size) throw coded('CONSENT_SCOPE_REQUIRED', 'A document-specific question grant is required.', 403);

      const documentIds = [];
      const names = [];
      for (const documentId of checks.keys()) {
        let stored;
        try { stored = ensureClauses({ householdId, caseId, documentId }); } catch (error) {
          if (['OCR_PAGES_UNAVAILABLE', 'OCR_PAGES_INCOMPLETE', 'DOCUMENT_NOT_FOUND'].includes(error?.code)) continue;
          throw error;
        }
        if (!stored) continue;
        documentIds.push(documentId);
        names.push(...documentNames(stored.pages.map(({ page, blocks }) => ({ page, blocks }))));
      }
      if (!documentIds.length) throw coded('POLICY_EVIDENCE_UNAVAILABLE', 'No stored policy text is available for this case. Process the document first.', 409);

      const consentCheck = () => { for (const documentId of documentIds) checks.get(documentId)(); };
      const clauses = services.clauses.listClauses({ householdId, caseId, documentIds });
      const knownIdentifiers = [...(await loadKnownIdentifiers(caseId)), ...names].slice(0, MAX_KNOWN_IDENTIFIERS);
      const call = createModelCall({ consentCheck, onCall: () => {} });
      inFlight += 1;
      let result;
      try {
        result = await investigate({
          question, clauses, knownIdentifiers, call, consentCheck,
          search: ({ query, kinds, limit }) => services.clauses.searchClauses({ householdId, caseId, documentIds, query, kinds, limit }),
        });
      } finally { inFlight -= 1; }
      return services.clauses.saveAnswer({
        householdId, caseId, requestedByAdultId: subjectAdultId, idempotencyKey, requestDigest, question: question.trim(),
        answer: result.answer, consentCheck,
      });
    },

    get({ caseRecord, answerId }) {
      return services.clauses.getAnswer({ householdId: caseRecord.household_id, caseId: caseRecord.id, answerId });
    },
  });
}
