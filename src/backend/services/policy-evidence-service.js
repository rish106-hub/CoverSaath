import { createHmac, randomBytes } from 'node:crypto';
import { CLAUSE_KINDS, FINDING_STATES, QUESTION_CONSENT_SCOPE } from '../../contracts/policy-evidence.js';
import { INVESTIGATION_VERSION, buildClauses, investigate, looksLikeSchedule } from '../../features/policy-evidence/index.js';
import { extractFields, flattenBlock, tableRows, FIELD_NAMES, FIELD_SPECS } from '../../features/ai-analysis/eval-extractor.js';

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
// Read-back of values and passages (ADR 0012 D9) is a separate switch: it makes no model call and does not need
// POLICY_EVIDENCE_ENABLED, and enabling it never opens the paid question route.
export const readbackEnabled = (env = process.env) => env.DOCUMENT_READBACK_ENABLED === 'true';

// Fields read back to the owner. Identity fields (policy number, policyholder, insured members, premium) are
// deliberately absent and never returned; the first three are read internally only so they can be hidden.
const READBACK_TOPICS = Object.freeze({
  insurer: null, plan_name: null,
  policy_period_start: 'policy_period', policy_period_end: 'policy_period',
  base_sum_insured: 'sum_insured',
  room_rent_limit: 'room_rent', icu_limit: 'room_rent',
  co_payment: 'co_payment',
  initial_waiting_period: 'waiting_period', specified_disease_waiting_period: 'waiting_period', ped_waiting_period: 'waiting_period',
});
const READBACK_FIELD_NAMES = Object.freeze(Object.keys(READBACK_TOPICS));
const MAX_QUOTE_LENGTH = 160;
const MAX_VALUE_LENGTH = 60;
const HIDDEN = '[hidden]';
const READBACK_NOTICE = 'Read from your documents by a rule, not checked.';
const squash = text => String(text).replace(/\s+/g, ' ').trim();

// Identity strings of this document and household: the identity fields are extracted here only to be hidden, never
// returned, plus the household's known identifiers (names, numbers). A name also hides each of its words.
function identityTerms(pages, knownIdentifiers) {
  const terms = new Set();
  const add = value => {
    if (typeof value !== 'string') return;
    // A greeting such as "Dear Asha, your policy ..." can be captured whole by the extractor: only a short value is a name or number.
    const text = squash(value).replace(/[,;:.]+$/, '');
    if (text.length < 3 || text.length > MAX_VALUE_LENGTH) return;
    terms.add(text);
    if (/\p{L}\s+\p{L}/u.test(text)) for (const word of text.split(' ')) if (word.length >= 3 && /^\p{L}+$/u.test(word)) terms.add(word);
  };
  let identity = {};
  try { identity = extractFields(pages, ['policy_number', 'policyholder_name', 'insured_members']); } catch { identity = {}; }
  for (const hit of Object.values(identity)) for (const value of [hit?.value, hit?.second?.value].flat()) add(value);
  for (const known of knownIdentifiers) add(known?.value);
  return [...terms].sort((x, y) => y.length - x.length);
}

const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A term matches whatever separators sit between its parts: "SYN-PERS-410001" also hides "SYN PERS 410001" and "SYN/PERS/410001".
const termPattern = term => escapeRegExp(term).replace(/(?:\\?[\s\-_/.])+/g, '[\\s\\-_/.]+');
const hideIdentity = (text, terms) => terms.reduce((out, term) => out.replace(new RegExp(termPattern(term), 'giu'), HIDDEN), text);
const showsIdentity = (text, terms) => terms.some(term => text.toLowerCase().includes(term.toLowerCase()));

// Cut `text` to MAX_QUOTE_LENGTH characters around the first occurrence of `value`.
function cutAround(text, value) {
  if (text.length <= MAX_QUOTE_LENGTH) return text;
  const at = Math.max(0, text.indexOf(value));
  const start = Math.max(0, Math.min(at - Math.floor((MAX_QUOTE_LENGTH - value.length) / 2), text.length - MAX_QUOTE_LENGTH));
  return text.slice(start, start + MAX_QUOTE_LENGTH);
}

// The sentence of `line` that holds `value`.
function sentenceAround(line, value) {
  const at = line.indexOf(value);
  if (at < 0) return null;
  const before = Math.max(line.lastIndexOf('. ', at), line.lastIndexOf('! ', at), line.lastIndexOf('? ', at));
  const afterAt = line.slice(at + value.length).search(/[.!?](\s|$)/);
  return line.slice(before < 0 ? 0 : before + 2, afterAt < 0 ? line.length : at + value.length + afterAt + 1);
}

// The cited text, as little of it as will do. In a table block that is the matched label cell and value cell only
// (never the rest of the row, which can hold other fields), found by the field's own label pattern. In any other
// block it is the sentence holding the value. Null when it cannot be located with certainty.
function quoteFor(field, pages, hit, terms) {
  const block = pages.find(entry => entry.page === hit.page)?.blocks?.[hit.blockIndex];
  if (!block || typeof block.text !== 'string') return null;
  const value = squash(hit.value);
  let quote = null;
  if (block.tag === 'table') {
    const labels = FIELD_SPECS[field]?.labels;
    const candidates = [];
    for (const row of tableRows(block.text)) {
      row.forEach((cell, index) => {
        const text = squash(cell);
        if (!text || !text.includes(value)) return;
        const labelled = labels instanceof RegExp && row.some(entry => labels.test(entry));
        if (labelled) candidates.push({ row, index, exact: text === value });
      });
    }
    const best = candidates.find(entry => entry.exact) ?? candidates[0];
    if (!best) return null;
    const before = best.row.slice(0, best.index).map(squash).filter(Boolean).at(-1);
    const own = squash(best.row[best.index]);
    quote = before !== undefined && !(labels.test(own)) ? `${before} | ${own}` : own;
  } else {
    const line = flattenBlock(block).split('\n').map(squash).find(text => text.includes(value));
    quote = line ? sentenceAround(line, value) : null;
  }
  if (quote === null) return null;
  const hidden = hideIdentity(quote, terms);
  return hidden.includes(value) ? cutAround(hidden, value) : null;
}

function readbackFields(pages, knownIdentifiers) {
  const terms = identityTerms(pages, knownIdentifiers);
  const extracted = extractFields(pages, READBACK_FIELD_NAMES);
  return READBACK_FIELD_NAMES.map(field => {
    const hit = extracted[field];
    const unknown = { field, topic: READBACK_TOPICS[field], value: null, state: 'unknown', page: null, quote: null };
    if (typeof hit?.value !== 'string' || !hit.value.trim() || hit.state === 'unknown') return unknown;
    const value = squash(hit.value);
    // Fail closed: a value that is long, or that is or holds an identity string, is not shown.
    if (value.length > MAX_VALUE_LENGTH || showsIdentity(value, terms)) return unknown;
    return {
      field, topic: READBACK_TOPICS[field], value, state: hit.state,
      page: Number.isSafeInteger(hit.page) && hit.page >= 1 ? hit.page : null, quote: quoteFor(field, pages, { ...hit, value }, terms),
    };
  });
}

const PASSAGE_NOTICE = 'These are passages from your documents, not an answer or a claim decision.';
const MAX_SNIPPET_LENGTH = 280;
const MAX_TITLE_LENGTH = 120;
// Clauses of every kind except the schedule facts, which are where names, numbers and premiums sit.
const PASSAGE_KINDS = Object.freeze(CLAUSE_KINDS.filter(kind => kind !== 'schedule_fact'));
// Labels of identity and schedule data. A clause that holds one is not shown at all, whatever its kind: the clause
// classifier files a schedule table with a "waiting period" or rider row as something other than a schedule fact.
// Optional punctuation or spaces may follow a label, or none ("DOB 01-02-1990"), so the label alone decides.
const SEP = String.raw`\s*[:|\-\u2013]`;
const IDENTITY_LABELS = [
  String.raw`policy\s*(?:no|number|num|id|#)\b`, String.raw`policy\s*holder`, String.raw`proposer`, String.raw`nominee`,
  String.raw`(?:insured|member|customer|patient|beneficiary|employee)(?:\s*person'?s?)?\s*(?:name|id|no|number|ref(?:erence)?)\b`,
  String.raw`name\s*of\s*(?:the\s*)?(?:insured|policy\s*holder|proposer|member|nominee)`,
  String.raw`\bname${SEP}`, String.raw`\b(?:dob|date\s*of\s*birth)\b`, String.raw`\bage${SEP}`, String.raw`\bage\s*\d`, String.raw`\b(?:gender|sex)${SEP}`,
  String.raw`\b(?:mobile|phone|telephone)\b`, String.raw`contact\s*(?:no|number|details)`, String.raw`e-?\s?mail`,
  String.raw`\baddress${SEP}`, String.raw`\b(?:residential|postal|permanent|communication|mailing)\s*address`,
  String.raw`\bpremium\b`, String.raw`\b(?:pan|aadhaar|aadhar|abha|uhid)\b`,
];
const IDENTITY_LABEL = new RegExp(IDENTITY_LABELS.join('|'), 'iu');
const holdsIdentityLabel = (...texts) => texts.some(text => typeof text === 'string' && IDENTITY_LABEL.test(text));
// What may remain in a clause that holds no label: e-mail addresses and runs of 6 or more digits (numbers, phones, dates).
const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const DIGIT_RUN = /\d(?:[\s\-/]?\d){5,}/g;
const maskNumbers = text => text.replace(EMAIL, HIDDEN).replace(DIGIT_RUN, HIDDEN);

// Up to MAX_SNIPPET_LENGTH characters of `text` centred on the first query word, cut at word boundaries.
function snippetAround(text, query) {
  const flat = squash(text);
  if (flat.length <= MAX_SNIPPET_LENGTH) return flat;
  const lower = flat.toLowerCase();
  const words = String(query).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const at = Math.max(0, Math.min(...words.map(word => lower.indexOf(word)).filter(index => index >= 0), flat.length));
  let start = Math.max(0, Math.min(at - Math.floor(MAX_SNIPPET_LENGTH / 2), flat.length - MAX_SNIPPET_LENGTH));
  let end = start + MAX_SNIPPET_LENGTH;
  if (start > 0) { const space = flat.indexOf(' ', start); start = space < 0 || space >= end ? start : space + 1; }
  if (end < flat.length) { const space = flat.lastIndexOf(' ', end); end = space > start ? space : end; }
  return flat.slice(start, end).trim();
}

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }

// Same shape as policy structuring's document grant: an active grant of the adult whose scope names this exact
// document for question-time Gemini use. A structuring grant (`insurance_document`) does not authorise questions.
export function questionGrantCheck({ consents, grantId, subjectAdultId, documentId, householdId }) {
  const scope = { resourceType: QUESTION_CONSENT_SCOPE.resourceType, action: QUESTION_CONSENT_SCOPE.action, dataCategory: QUESTION_CONSENT_SCOPE.dataCategory, recipient: QUESTION_CONSENT_SCOPE.recipient };
  return async () => {
    await consents.requireActive(grantId, { subjectAdultId, resourceId: documentId, ...scope });
    const grant = await consents.get(grantId);
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
  // The request digest covers the raw question, so it is keyed: an unsalted hash would let anyone holding the database
  // confirm a guessed question. The key is derived from the server's document key; without one (development) it is
  // random per process, so a replay after a restart is a new request rather than a match.
  const configuredKey = env.DOCUMENT_ENCRYPTION_KEY_BASE64 ? Buffer.from(env.DOCUMENT_ENCRYPTION_KEY_BASE64, 'base64') : null;
  if (configuredKey && configuredKey.length < 32) throw coded('POLICY_EVIDENCE_CONFIG_INVALID', 'The document encryption key must decode to at least 32 bytes.', 500);
  const digestKey = createHmac('sha256', configuredKey ?? randomBytes(32)).update('policy-answer-request-digest-v1').digest();
  if (!services?.clauses || typeof loadKnownIdentifiers !== 'function' || typeof createModelCall !== 'function') {
    throw new TypeError('services, loadKnownIdentifiers and createModelCall are required.');
  }
  let inFlight = 0;
  const claims = new Set();

  // Clauses are derived deterministically on first use; a document without complete stored blocks is skipped.
  async function ensureClauses({ householdId, caseId, documentId }) {
    const stored = await services.ocr.getDocumentBlockPages({ documentId, householdId });
    if (!stored.complete) return null;
    if (!(await services.clauses.clauseDocumentIds({ householdId, caseId })).includes(documentId)) {
      const { clauses } = buildClauses(stored, { documentId, sourceVersion: stored.sourceVersion });
      if (clauses.length) await services.clauses.saveClauses({ householdId, caseId, documentId, clauses });
    }
    return stored;
  }

  const validVersion = version => Number.isSafeInteger(version) && version > 0;
  const versionInvalid = () => coded('POLICY_EVIDENCE_VERSION_INVALID', 'A document version could not be determined.', 409);

  // An older version is never read as the current policy. Versions are household-wide: a newer version uploaded to
  // another case still supersedes. An unreadable version fails closed rather than letting comparison order decide.
  async function currentVersionCheck(householdId, documents) {
    const logical = documents.filter(document => document.logicalDocumentId != null);
    if (logical.some(document => !validVersion(document.version))) throw versionInvalid();
    const latest = logical.length ? await services.documents.latestActiveVersions(householdId, logical.map(document => document.logicalDocumentId)) : new Map();
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
  async function requireAnswerAccess({ householdId, stored }) {
    const access = stored.access;
    if (!access?.consentGrantId || !access.subjectAdultId || !Array.isArray(access.documentIds) || !access.documentIds.length) {
      throw coded('CONSENT_REQUIRED', 'Active consent for this answer could not be confirmed.', 403);
    }
    for (const documentId of access.documentIds) {
      await questionGrantCheck({ consents: services.consents, grantId: access.consentGrantId, subjectAdultId: access.subjectAdultId, documentId, householdId })();
    }
    return access;
  }

  // Current while every document it read is still active, in the case and household, and the latest version.
  async function answerIsCurrent({ householdId, caseId, access }) {
    const documents = [];
    for (const id of access.documentIds) documents.push(await services.documents.getDocument(id));
    if (documents.some(document => !document || document.householdId !== householdId || document.caseId !== caseId || document.lifecycleState !== 'active')) return false;
    const isCurrent = await currentVersionCheck(householdId, documents);
    return documents.every(isCurrent);
  }

  // `pipelineCurrent` is false for an answer stored by an earlier pipeline: it is served as stored, never re-bucketed.
  const publicAnswer = ({ access: _access, ...stored }) => ({ ...stored, pipelineCurrent: stored.answer?.pipelineVersion === INVESTIGATION_VERSION });

  async function askOnce({ caseRecord, subjectAdultId, question, consentGrantId, idempotencyKey, documentIds: requestedDocumentIds }) {
    if (!evidenceEnabled(env)) throw coded('EVIDENCE_DISABLED', 'Policy questions are disabled.', 503);
    const { id: caseId, household_id: householdId } = caseRecord;
    if (typeof question !== 'string' || !question.trim() || question.length > 2000) throw coded('VALIDATION_ERROR', 'question is required.', 400);
    if (typeof consentGrantId !== 'string' || !consentGrantId) throw coded('VALIDATION_ERROR', 'consentGrantId is required.', 400);
    const named = namedDocuments(requestedDocumentIds);
    const requestDigest = createHmac('sha256', digestKey).update(JSON.stringify([caseId, question.trim(), consentGrantId, named])).digest('hex');
    // A replay does no paid work, but it is served only while consent is active and the evidence is still current.
    const replay = await services.clauses.findAnswerByKey({ householdId, caseId, idempotencyKey, requestDigest });
    if (replay) {
      const access = await requireAnswerAccess({ householdId, stored: replay });
      if (!(await answerIsCurrent({ householdId, caseId, access }))) {
        throw coded('POLICY_EVIDENCE_ANSWER_STALE', 'The documents behind this answer have changed. Ask again with a new idempotency key.', 409);
      }
      return publicAnswer(replay);
    }
    if (inFlight >= MAX_IN_FLIGHT) throw coded('EVIDENCE_BUSY', 'Too many questions are in progress.', 503);

    // A truncated list could hide a document, so an over-long case fails closed.
    const listed = await services.documents.listForCase(caseId, householdId, MAX_CASE_DOCUMENTS + 1);
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
      const othersCurrent = await currentVersionCheck(householdId, others);
      for (const document of others) {
        try { await questionGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId })(); } catch (error) {
          if (!/^CONSENT_/.test(String(error?.code))) throw error;
          continue;
        }
        if (othersCurrent(document)) exclude('not_named');
      }
    }
    const isCurrent = await currentVersionCheck(householdId, pool);
    const checks = new Map();
    for (const document of pool) {
      const check = questionGrantCheck({ consents: services.consents, grantId: consentGrantId, subjectAdultId, documentId: document.id, householdId });
      try { await check(); } catch (error) {
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
      try { stored = await ensureClauses({ householdId, caseId, documentId }); } catch (error) {
        if (Object.hasOwn(SKIP_REASONS, String(error?.code))) { exclude(SKIP_REASONS[error.code]); continue; }
        throw error;
      }
      if (!stored) { exclude('ocr_incomplete'); continue; }
      documentIds.push(documentId);
      names.push(...documentNames(stored.pages.map(({ page, blocks }) => ({ page, blocks }))));
    }
    if (!documentIds.length) throw coded('POLICY_EVIDENCE_UNAVAILABLE', 'No stored policy text is available for this case. Process the document first.', 409);

    const consentCheck = async () => { for (const documentId of documentIds) await checks.get(documentId)(); };
    const clauses = await services.clauses.listClauses({ householdId, caseId, documentIds });
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
        // investigate() awaits each search (household, case and document scoped) before ranking its hits.
        search: ({ query, kinds, limit }) => services.clauses.searchClauses({ householdId, caseId, documentIds, query, kinds, limit }),
      });
    } finally { inFlight -= 1; }
    const access = { consentGrantId, subjectAdultId, documentIds };
    const answer = named && named.length > 1 ? { ...result.answer, documentAssociation: { basis: 'requester_named', verified: false } } : result.answer;
    return publicAnswer(await services.clauses.saveAnswer({
      householdId, caseId, requestedByAdultId: subjectAdultId, idempotencyKey, requestDigest, question: result.answer.question,
      answer, access,
      // Consent and currency are both re-checked immediately before the answer is written: a newer version that
      // arrived during the model call means this answer is not stored or returned as current.
      consentCheck: async () => {
        await consentCheck();
        if (!(await answerIsCurrent({ householdId, caseId, access }))) {
          throw coded('POLICY_EVIDENCE_ANSWER_STALE', 'The documents changed while the question was answered. Ask again with a new idempotency key.', 409);
        }
      },
    }));
  }

  /**
   * The documents of a case whose stored text may be shown to its owner right now, with the reason for every one that
   * may not. Shared by readFacts and searchPassages so the consent gate exists once. A document is readable only if it
   * is active, current, and every succeeded sarvam job whose stored pages would be returned still holds a current exact
   * reading grant, re-checked here on every call (never trusted from the job row). No model call, nothing stored.
   */
  async function readableDocuments({ caseRecord }) {
    const { id: caseId, household_id: householdId } = caseRecord;
    const listed = await services.documents.listForCase(caseId, householdId, MAX_CASE_DOCUMENTS + 1);
    if (listed.length > MAX_CASE_DOCUMENTS) throw coded('POLICY_EVIDENCE_CASE_TOO_LARGE', 'The case has too many documents to read.', 409);
    const active = listed.filter(document => document.lifecycleState === 'active');
    const isCurrent = await currentVersionCheck(householdId, active);
    const knownIdentifiers = active.length ? await loadKnownIdentifiers(caseId) : [];
    const readable = [];
    const excluded = [];
    const now = Date.now();
    for (const document of active) {
      const exclude = reason => excluded.push({ documentId: document.id, reason });
      if (!isCurrent(document)) { exclude('superseded'); continue; }
      // Why a reading grant no longer passes: past its expiry (and not revoked) or withdrawn (revoked, erased or not matching).
      const withdrawnReason = async grantId => {
        const grant = grantId ? await services.consents.get(grantId) : null;
        const expired = grant && !grant.revoked_at && grant.expires_at != null && !(Date.parse(grant.expires_at) > now);
        return expired ? 'reading_permission_expired' : 'reading_permission_withdrawn';
      };
      const latest = await services.ocr.getLatestJobForDocument(document.id);
      if (latest?.status === 'cancelled' && latest.errorCode === 'CONSENT_REVOKED') { exclude('reading_permission_withdrawn'); continue; }
      if (latest?.status !== 'succeeded') { exclude('not_read'); continue; }
      // Every succeeded job whose stored pages could be returned must still hold a current exact grant to sarvam.
      const holders = await services.ocr.getJobsHoldingPages(document.id);
      if (!holders.length) { exclude(latest.authorization?.consentGrantId ? 'not_read' : 'reading_permission_withdrawn'); continue; }
      if (holders.some(job => job.provider !== 'sarvam')) { exclude('not_read'); continue; }
      let blocked = null;
      for (const job of holders) {
        const authorization = job.authorization;
        const ready = authorization?.consentGrantId && authorization.requestedByAdultId
          ? await services.ocr.getReadyDocument(document.id, new Date(now).toISOString(), {
            consentGrantId: authorization.consentGrantId, requestedByAdultId: authorization.requestedByAdultId, recipient: 'sarvam',
          })
          : null;
        if (!ready) { blocked = await withdrawnReason(authorization?.consentGrantId); break; }
      }
      if (blocked) { exclude(blocked); continue; }
      let stored;
      try { stored = await services.ocr.getDocumentBlockPages({ documentId: document.id, householdId }); } catch (error) {
        if (['OCR_PAGES_UNAVAILABLE', 'OCR_PAGES_INCOMPLETE'].includes(String(error?.code))) { exclude('not_read'); continue; }
        throw error;
      }
      if (!stored.complete) { exclude('not_read'); continue; }
      readable.push({ document, stored });
    }
    return { readable, excluded, knownIdentifiers };
  }

  return Object.freeze({
    // One question per idempotency key runs at a time. A stored answer is written only after the paid model call, so a
    // duplicate that arrives meanwhile would miss the replay and bill the model twice. The claim is per process, so a
    // multi-instance deployment needs a database-level claim instead.
    async ask(input) {
      const { caseRecord, idempotencyKey } = input;
      if (typeof idempotencyKey !== 'string' || !idempotencyKey || !caseRecord) return askOnce(input);
      const claim = JSON.stringify([caseRecord.household_id, caseRecord.id, idempotencyKey]);
      if (claims.has(claim)) throw coded('IDEMPOTENCY_IN_PROGRESS', 'This question is already being answered. Retry with the same idempotency key shortly.', 409);
      claims.add(claim);
      try { return await askOnce(input); } finally { claims.delete(claim); }
    },

    /**
     * A stored answer for the decision catalogue: same consent re-check as `get`, and only while every document it read
     * is still active and current. No model call, no write.
     */
    async readForCatalogue({ caseRecord, answerId }) {
      if (!evidenceEnabled(env)) throw coded('EVIDENCE_DISABLED', 'Policy questions are disabled.', 503);
      const householdId = caseRecord.household_id;
      const stored = await services.clauses.getAnswer({ householdId, caseId: caseRecord.id, answerId });
      const access = await requireAnswerAccess({ householdId, stored });
      if (!(await answerIsCurrent({ householdId, caseId: caseRecord.id, access }))) {
        throw coded('POLICY_EVIDENCE_ANSWER_STALE', 'The documents behind this answer have changed. Ask again.', 409);
      }
      return { answerId: stored.answerId, answer: stored.answer, documentIds: access.documentIds, pipelineCurrent: stored.answer?.pipelineVersion === INVESTIGATION_VERSION };
    },

    /**
     * Values the deterministic extractor reads from the case's own stored OCR pages, each with its page and a short
     * quote. No model call, nothing stored, no logging. Never returns the identity fields (policy number,
     * policyholder, insured members, premium).
     */
    async readFacts({ caseRecord }) {
      if (!readbackEnabled(env)) throw coded('READBACK_DISABLED', 'Reading values back is disabled.', 503);
      const { readable, excluded, knownIdentifiers } = await readableDocuments({ caseRecord });
      const documents = [];
      for (const { document, stored } of readable) {
        try {
          documents.push({
            documentId: document.id, documentKind: document.documentKind,
            fields: readbackFields(stored.pages.map(({ page, blocks }) => ({ page, blocks })), knownIdentifiers),
          });
        } catch { excluded.push({ documentId: document.id, reason: 'not_read' }); }
      }
      return { label: 'read_not_checked', notice: READBACK_NOTICE, documents, excluded };
    },

    /**
     * Passages (stored clauses) of the case's readable documents that match `query`, as short snippets with their page.
     * Same gate and flag as readFacts. No model call; the only write is the existing deterministic clause derivation
     * (an erasable derived store, as for questions). The query is never logged. Fail closed on identity: a clause is
     * dropped, whatever kind the classifier gave it, if it reads as schedule content or holds an identity label
     * (policy number, name, nominee, mobile, e-mail, date of birth, premium and the like); in what remains, e-mail
     * addresses and digit runs are masked and the document's own identity strings are hidden. Best effort: it cannot
     * know a name it was never told, so the route stays owner only (follow-up F3 for stronger masking).
     */
    async searchPassages({ caseRecord, query: rawQuery, limit: rawLimit }) {
      if (!readbackEnabled(env)) throw coded('READBACK_DISABLED', 'Reading values back is disabled.', 503);
      const invalid = message => coded('INVALID_REQUEST', message, 400);
      const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
      if (query.length < 2 || query.length > 120) throw invalid('q must be 2 to 120 characters.');
      if (rawLimit !== null && rawLimit !== undefined && !/^[0-9]{1,2}$/.test(String(rawLimit))) throw invalid('limit must be a whole number from 1 to 10.');
      const limit = rawLimit === null || rawLimit === undefined ? 5 : Number(rawLimit);
      if (limit < 1 || limit > 10) throw invalid('limit must be a whole number from 1 to 10.');
      const { id: caseId, household_id: householdId } = caseRecord;
      const { readable, excluded, knownIdentifiers } = await readableDocuments({ caseRecord });
      const termsByDocument = new Map();
      const documentIds = [];
      for (const { document, stored } of readable) {
        let ensured;
        try { ensured = await ensureClauses({ householdId, caseId, documentId: document.id }); } catch (error) {
          if (Object.hasOwn(SKIP_REASONS, String(error?.code))) { excluded.push({ documentId: document.id, reason: 'not_read' }); continue; }
          throw error;
        }
        if (!ensured) { excluded.push({ documentId: document.id, reason: 'not_read' }); continue; }
        termsByDocument.set(document.id, identityTerms(stored.pages.map(({ page, blocks }) => ({ page, blocks })), knownIdentifiers));
        documentIds.push(document.id);
      }
      // Over-fetch: clauses dropped below must not leave the caller short of its limit.
      const found = documentIds.length
        ? await services.clauses.searchClauses({ householdId, caseId, documentIds, query, kinds: PASSAGE_KINDS, limit: 100 })
        : [];
      const passages = [];
      for (const clause of found) {
        if (!termsByDocument.has(clause.documentId) || !PASSAGE_KINDS.includes(clause.kind)) continue;
        const title = clause.sectionPath?.[0] ?? '';
        if (looksLikeSchedule(title, clause.text) || holdsIdentityLabel(title, clause.text)) continue;
        const terms = termsByDocument.get(clause.documentId);
        const hide = text => maskNumbers(hideIdentity(text, terms));
        passages.push({
          clauseId: clause.clauseId, documentId: clause.documentId, page: clause.page, kind: clause.kind,
          title: title ? squash(hide(title)).slice(0, MAX_TITLE_LENGTH) : null, snippet: snippetAround(hide(clause.text), query),
        });
        if (passages.length === limit) break;
      }
      return { label: 'passage_not_answer', notice: PASSAGE_NOTICE, query, passages, excluded };
    },

    async get({ caseRecord, answerId }) {
      const householdId = caseRecord.household_id;
      const stored = await services.clauses.getAnswer({ householdId, caseId: caseRecord.id, answerId });
      const access = await requireAnswerAccess({ householdId, stored });
      return { ...publicAnswer(stored), current: await answerIsCurrent({ householdId, caseId: caseRecord.id, access }) };
    },
  });
}
