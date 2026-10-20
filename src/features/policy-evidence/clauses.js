// Deterministic clause builder (ADR 0008). Stored OCR blocks -> page-bounded clauses. No model, no provider call:
// the same blocks always give the same clause ids and digests. `kind` is a keyword classification used to build the
// question checklist; it is a retrieval aid and never a coverage decision.
import { createHash } from 'node:crypto';
import { sectionStoredDocument } from '../policy-structuring/sectioner.js';
import { CLAUSE_KINDS, validateClause } from '../../contracts/policy-evidence.js';

const KIND_RULES = Object.freeze([
  ['endorsement', /\b(?:endorsement|rider|add[- ]?on|addendum|optional cover)\b/i],
  ['waiting_period', /\bwaiting period\b|\bwaiting\b.{0,40}\b(?:days?|months?|years?)\b|\bmoratorium\b|\bcooling[- ]off\b/i],
  ['exclusion', /\bexclusion|\bnot (?:covered|payable|admissible)\b|\bshall not (?:be )?(?:liable|payable)\b|\bwe will not (?:pay|cover)\b/i],
  ['schedule_fact', /\b(?:policy schedule|schedule of benefits|policy period|sum insured|premium|insured member|policy number|date of (?:commencement|issue))\b/i],
  ['limit', /\b(?:sub-?limit|capped|maximum|up to|per (?:day|claim|eye|year)|co-?pay|deductible|room rent|% of (?:the )?sum insured)\b/i],
  ['definition', /\b(?:means|shall mean|is defined as|definitions?)\b/i],
  ['procedure', /\b(?:claim (?:procedure|process)|cashless|intimat|notify|grievance|reimbursement|documents? required)\b/i],
  ['benefit', /\b(?:we will (?:pay|cover|reimburse)|covered|coverage|benefit|hospitali[sz]ation|treatment)\b/i],
]);

export function classifyClause(title, text) {
  const haystack = `${title ?? ''}\n${text}`;
  for (const [kind, pattern] of KIND_RULES) if (pattern.test(haystack)) return kind;
  return 'other';
}

const digestOf = text => createHash('sha256').update(text.normalize('NFC')).digest('hex');

/**
 * @param {{pages: Array}} stored OcrRepository.getDocumentBlockPages result
 * @param {{documentId: string, sourceVersion: string}} identity
 */
export function buildClauses(stored, { documentId, sourceVersion, maxChunkChars = 4000 } = {}) {
  if (typeof documentId !== 'string' || !documentId) throw Object.assign(new Error('documentId is required.'), { code: 'CLAUSE_INPUT_INVALID' });
  if (typeof sourceVersion !== 'string' || !sourceVersion) throw Object.assign(new Error('sourceVersion is required.'), { code: 'CLAUSE_INPUT_INVALID' });
  const { chunks, dropped } = sectionStoredDocument(stored, { maxChunkChars });
  const clauses = chunks.map(chunk => {
    const clause = {
      clauseId: `${documentId}:${chunk.id}`,
      documentId,
      sourceVersion,
      page: chunk.page,
      blockIndexes: [...chunk.blockIndexes],
      sectionPath: chunk.title ? [chunk.title] : [],
      kind: classifyClause(chunk.title, chunk.text),
      text: chunk.text,
      digest: digestOf(chunk.text),
    };
    const errors = validateClause(clause);
    if (errors.length) throw Object.assign(new Error(`Built clause is invalid: ${errors.join('; ')}`), { code: 'CLAUSE_BUILD_INVALID' });
    return Object.freeze(clause);
  });
  return Object.freeze({ clauses: Object.freeze(clauses), dropped, kinds: CLAUSE_KINDS });
}
