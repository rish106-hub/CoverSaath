import { createHash } from 'node:crypto';
import { QUESTION_CONSENT_SCOPE } from '../../contracts/policy-evidence.js';
import { INVESTIGATION_VERSION, buildClauses, investigate } from '../../features/policy-evidence/index.js';
import { extractFields, FIELD_NAMES } from '../../features/ai-analysis/eval-extractor.js';

// Answers one question about a case's policy documents (ADR 0008): stored OCR blocks become clauses, the
// privacy-gated clauses go to Gemini through the injected model call, code validates and assembles a cited
// conditional answer, and one immutable answer row is committed after consent is re-checked. The answer is
// evidence with unknowns, never a coverage decision. Off unless POLICY_EVIDENCE_ENABLED=true.

const MAX_KNOWN_IDENTIFIERS = 200;
const MAX_IN_FLIGHT = 4;
const MAX_DOCUMENTS = 10;
// Upper bound of MAX_DOCUMENTS_PER_CASE (config.js); the case listing is read whole or not at all.
const MAX_CASE_DOCUMENTS = 1_000;
const SKIP_REASONS = Object.freeze({ OCR_PAGES_UNAVAILABLE: 'ocr_unavailable', OCR_PAGES_INCOMPLETE: 'ocr_incomplete', DOCUMENT_NOT_FOUND: 'not_found' });

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

  const validVersion = version => Number.isSafeInteger(version) && version > 0;
  const versionInvalid = () => coded('POLICY_EVIDENCE_VERSION_INVALID', 'A document version could not be determined.', 409);

  // An older version is never read as the current policy. Versions are household-wide: a newer version uploaded to
  // another case still supersedes. An unreadable version fails closed rather than letting comparison order decide.
  function currentVersionCheck(householdId, documents) {
    const logical = documents.filter(document => document.logicalDocumentId != null);
    if (logical.some(document => !validVersion(document.version))) throw versionInvalid();
    const latest = logical.length ? services.documents.latestActiveVersions(householdId, logical.map(document => document.logicalDocumentId)) : new Map();
    if ([...latest.values()].some(version => !validVersion(version))) throw versionInvalid();
    return document => {
      if (document.logicalDocumentId == null) return true;
      if (!latest.has(document.logicalDocumentId)) throw versionInvalid();
      return document.version >= latest.get(document.logicalDocumentId);
    };
  }

  function namedDocuments(documentIds) {
    if (documentIds === undefined || documentIds === null) return null;
    if (!Array.isArray(documentIds) || documentIds.length < 1 || documentIds.length > MAX_DOCUMENTS
      || !documentIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) || new Set(documentIds).size !== documentIds.length) {
      throw coded('VALIDATION_ERROR', `documentIds must be 1 to ${MAX_DOCUMENTS} unique document ids.`, 400);
    }
    return [...documentIds].sort();
  }

  // A stored answer is served only while the question grant still covers every document it read (consent expiry
  // blocks it; revocation has already erased it). An answer without recorded access is never served.
  function requireAnswerAccess({ householdId, stored }) {
    const access = stored.access;
    if (!access?.consentGrantId || !access.subjectAdultId || !Array.isArray(access.documentIds) || !access.documentIds.length) {
      throw coded('CONSENT_REQUIRED', 'Active consent for this answer could not be confirmed.', 403);
    }
    for (const documentId of access.documentIds) {
      questionGrantCheck({ consents: services.consents, grantId: access.consentGrantId, subjectAdultId: access.subjectAdultId, documentId, householdId })();
    }
    return access;
  }

  // Current while every document it read is still active, in the case and household, and the latest version.
  function answerIsCurrent({ householdId, caseId, access }) {
    const documents = access.documentIds.map(id => services.documents.getDocument(id));
    if (documents.some(document => !document || document.householdId !== householdId || document.caseId !== caseId || document.lifecycleState !== 'active')) return false;
    const isCurrent = currentVersionCheck(householdId, documents);
    return documents.every(isCurrent);
  }

  // `pipelineCurrent` is false for an answer stored by an earlier pipeline: it is served as stored, never re-bucketed.
  const publicAnswer = ({ access: _access, ...stored }) => ({ ...stored, pipelineCurrent: stored.answer?.pipelineVersion === INVESTIGATION_VERSION });

  return Object.freeze({
    async ask({ caseRecord, subjectAdultId, question, consentGrantId, idempotencyKey, documentIds: requestedDocumentIds }) {
      if (!evidenceEnabled(env)) throw coded('EVIDENCE_DISABLED', 'Policy questions are disabled.', 503);
      const { id: caseId, household_id: householdId } = caseRecord;
      if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw coded('VALIDATION_ERROR', 'question is required.', 400);
      if (typeof consentGrantId !== 'string' || !consentGrantId) throw coded('VALIDATION_ERROR', 'consentGrantId is required.', 400);
      const named = namedDocuments(requestedDocumentIds);
      const requestDigest = createHash('sha256').update(JSON.stringify([caseId, question.trim(), consentGrantId, named])).digest('hex');
      // A replay does no paid work, but it is served only while consent is active and the evidence is still current.
      const replay = services.clauses.findAnswerByKey({ householdId, caseId, idempotencyKey, requestDigest });
      if (replay) {
        const access = requireAnswerAccess({ householdId, stored: replay });
        if (!answerIsCurrent({ householdId, caseId, access })) {
          throw coded('POLICY_EVIDENCE_ANSWER_STALE', 'The documents behind this answer have changed. Ask again with a new idempotency key.', 409);
        }
        return publicAnswer(replay);
      }
      if (inFlight >= MAX_IN_FLIGHT) throw coded('EVIDENCE_BUSY', 'Too many questions are in progress.', 503);

      // A truncated list could hide a document, so an over-long case fails closed.
      const listed = services.documents.listForCase(caseId, householdId, MAX_CASE_DOCUMENTS + 1);
      if (listed.length > MAX_CASE_DOCUMENTS) throw coded('POLICY_EVIDENCE_CASE_TOO_LARGE', 'The case has too many documents to question.', 409);
      const active = listed.filter(document => document.lifecycleState === 'active');
      const excluded = new Map();
      const exclude = (reason, count = 1) => excluded.set(reason, (excluded.get(reason) ?? 0) + count);
      let pool = active;
      if (named) {
        // Named documents are the requester's assertion that they belong to one policy. Each one must be an active
        // document of this case, granted and current; otherwise the whole request fails.
        const byId = new Map(active.map(document => [document.id, document]));
        if (named.some(id => !byId.has(id))) throw coded('POLICY_EVIDENCE_NOT_FOUND', 'The requested policy evidence was not found.', 404);
        pool = named.map(id => byId.get(id));
        // Granted, current documents the request left out are counted, so the answer says they were not read.
        const others = active.filter(document => !named.includes(document.id));
        const othersCurrent = currentVersionCheck(householdId, others);
        for (const document of others) {
          try { questionGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId })(); } catch (error) {
            if (!/^CONSENT_/.test(String(error?.code))) throw error;
            continue;
          }
          if (othersCurrent(document)) exclude('not_named');
        }
      }
      const isCurrent = currentVersionCheck(householdId, pool);
      const checks = new Map();
      for (const document of pool) {
        const check = questionGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId });
        try { check(); } catch (error) {
          if (!/^CONSENT_/.test(String(error?.code))) throw error;
          if (named) throw coded('CONSENT_SCOPE_REQUIRED', 'A document-specific question grant is required for every named document.', 403);
          continue;
        }
        if (isCurrent(document)) { checks.set(document.id, check); continue; }
        if (named) throw coded('POLICY_EVIDENCE_SUPERSEDED', 'A newer version of a named document exists.', 409);
        exclude('superseded_version');
      }
      if (!checks.size && excluded.has('superseded_version')) {
        throw coded('POLICY_EVIDENCE_SUPERSEDED', 'A newer version of this document exists. A question grant for the current version is required.', 409);
      }
      if (!checks.size) throw coded('CONSENT_SCOPE_REQUIRED', 'A document-specific question grant is required.', 403);
      // Which policy a document belongs to is not established (ADR 0007 is blocked), so several documents are read
      // together only when the request names them; the association is then recorded as asserted, not verified.
      if (!named && checks.size > 1) {
        throw coded('POLICY_EVIDENCE_DOCUMENTS_REQUIRED', 'Several current documents are authorised. Name the documents of one policy in documentIds.', 409);
      }
      // Every authorised document that is not read is counted and reported, never silently omitted.
      const authorised = checks.size + (excluded.get('superseded_version') ?? 0) + (excluded.get('not_named') ?? 0);

      const documentIds = [];
      const names = [];
      for (const documentId of checks.keys()) {
        let stored;
        try { stored = ensureClauses({ householdId, caseId, documentId }); } catch (error) {
          if (Object.hasOwn(SKIP_REASONS, String(error?.code))) { exclude(SKIP_REASONS[error.code]); continue; }
          throw error;
        }
        if (!stored) { exclude('ocr_incomplete'); continue; }
        documentIds.push(documentId);
        names.push(...documentNames(stored.pages.map(({ page, blocks }) => ({ page, blocks }))));
      }
      if (!documentIds.length) throw coded('POLICY_EVIDENCE_UNAVAILABLE', 'No stored policy text is available for this case. Process the document first.', 409);

      const consentCheck = () => { for (const documentId of documentIds) checks.get(documentId)(); };
      const clauses = services.clauses.listClauses({ householdId, caseId, documentIds });
      const withClauses = new Set(clauses.map(clause => clause.documentId));
      const empty = documentIds.filter(documentId => !withClauses.has(documentId)).length;
      if (empty) exclude('no_clauses', empty);
      const knownIdentifiers = [...(await loadKnownIdentifiers(caseId)), ...names].slice(0, MAX_KNOWN_IDENTIFIERS);
      const call = createModelCall({ consentCheck, onCall: () => {} });
      inFlight += 1;
      let result;
      try {
        result = await investigate({
          question, clauses, knownIdentifiers, call, consentCheck,
          documentScope: { authorised, excluded: [...excluded].map(([reason, count]) => ({ reason, count })) },
          search: ({ query, kinds, limit }) => services.clauses.searchClauses({ householdId, caseId, documentIds, query, kinds, limit }),
        });
      } finally { inFlight -= 1; }
      const access = { consentGrantId, subjectAdultId, documentIds };
      const answer = named && named.length > 1 ? { ...result.answer, documentAssociation: { basis: 'requester_named', verified: false } } : result.answer;
      return publicAnswer(services.clauses.saveAnswer({
        householdId, caseId, requestedByAdultId: subjectAdultId, idempotencyKey, requestDigest, question: question.trim(),
        answer, access,
        // Consent and currency are both re-checked immediately before the answer is written: a newer version that
        // arrived during the model call means this answer is not stored or returned as current.
        consentCheck: () => {
          consentCheck();
          if (!answerIsCurrent({ householdId, caseId, access })) {
            throw coded('POLICY_EVIDENCE_ANSWER_STALE', 'The documents changed while the question was answered. Ask again with a new idempotency key.', 409);
          }
        },
      }));
    },

    get({ caseRecord, answerId }) {
      const householdId = caseRecord.household_id;
      const stored = services.clauses.getAnswer({ householdId, caseId: caseRecord.id, answerId });
      const access = requireAnswerAccess({ householdId, stored });
      return { ...publicAnswer(stored), current: answerIsCurrent({ householdId, caseId: caseRecord.id, access }) };
    },
  });
}
