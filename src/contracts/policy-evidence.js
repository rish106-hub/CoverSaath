// Evidence-first reasoning contracts (ADR 0008). Policy content stays open-ended; only document metadata,
// evidence structure and answer structure are standardised. Model output never exceeds extracted_unverified.
import { GEMINI_RECIPIENT_ID } from './policy-evidence-consent.js';

export const CLAUSE_KINDS = Object.freeze([
  'benefit', 'limit', 'condition', 'exclusion', 'waiting_period', 'definition', 'endorsement', 'schedule_fact', 'procedure', 'other',
]);
export const DOCUMENT_TYPES = Object.freeze(['wording', 'schedule', 'certificate', 'endorsement', 'brochure']);
export const FINDING_STATES = Object.freeze(['extracted_unverified', 'conflicting', 'unknown']);
export const ANSWER_STATES = Object.freeze(['evidence_found', 'conditional', 'insufficient_evidence']);

export { GEMINI_RECIPIENT_ID };

// Question-time model use is its own consent purpose. The scope table's `action` CHECK has no 'answer' value and
// changing it needs a table rebuild (blocked, U2), so the purpose is carried by data_category. Wording is a draft
// and is marked for legal review (AGENTS.md).
export const QUESTION_CONSENT_SCOPE = Object.freeze({
  resourceType: 'document',
  action: 'derive',
  dataCategory: 'insurance_question',
  recipient: GEMINI_RECIPIENT_ID,
  legalReview: 'required',
});

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = value => typeof value === 'string' && value.trim() !== '';

function problems(list) { return list.length ? list : null; }

export function validateClause(clause) {
  const errors = [];
  if (!isObject(clause)) return ['clause must be an object'];
  for (const key of ['clauseId', 'documentId', 'sourceVersion', 'digest']) if (!nonEmpty(clause[key])) errors.push(`${key} required`);
  if (!Number.isInteger(clause.page) || clause.page < 1) errors.push('page must be a 1-based integer');
  if (!Array.isArray(clause.blockIndexes) || !clause.blockIndexes.length || !clause.blockIndexes.every(Number.isInteger)) errors.push('blockIndexes required');
  if (!Array.isArray(clause.sectionPath)) errors.push('sectionPath must be an array');
  if (!CLAUSE_KINDS.includes(clause.kind)) errors.push('kind invalid');
  if (!nonEmpty(clause.text)) errors.push('text required');
  return problems(errors) ?? [];
}

// A finding needs at least one clause and a quote copied from one of the referenced clauses. `clausesById`
// maps clauseId to clause text so the check is deterministic and needs no model.
export function validateFinding(finding, clausesById) {
  const errors = [];
  if (!isObject(finding)) return ['finding must be an object'];
  if (!nonEmpty(finding.findingId)) errors.push('findingId required');
  if (!Array.isArray(finding.clauseIds) || !finding.clauseIds.length) errors.push('clauseIds required');
  else if (!finding.clauseIds.every(id => clausesById.has(id))) errors.push('unknown clauseId');
  else if (!nonEmpty(finding.quote) || !finding.clauseIds.some(id => clausesById.get(id).includes(finding.quote))) errors.push('quote not in cited clauses');
  if (!nonEmpty(finding.subject)) errors.push('subject required');
  if (!FINDING_STATES.includes(finding.state)) errors.push('state must not exceed extracted_unverified');
  for (const key of ['conditions', 'exceptions']) if (!Array.isArray(finding[key])) errors.push(`${key} must be an array`);
  if (finding.overrides !== undefined && (!Array.isArray(finding.overrides) || !finding.overrides.every(id => clausesById.has(id)))) errors.push('overrides must cite known clauses');
  return errors;
}

// An answer is cited evidence, never a bare yes or no and never a coverage verdict.
export function validateAnswer(answer) {
  const errors = [];
  if (!isObject(answer)) return ['answer must be an object'];
  if (!nonEmpty(answer.question)) errors.push('question required');
  for (const key of ['covered', 'limited_or_excluded', 'conditions', 'overrides_checked', 'unknowns', 'calculations', 'sources']) {
    if (!Array.isArray(answer[key])) errors.push(`${key} must be an array`);
  }
  if (!ANSWER_STATES.includes(answer.state)) errors.push('state invalid');
  if (Array.isArray(answer.sources) && !answer.sources.every(source => nonEmpty(source?.documentId) && Number.isInteger(source?.page) && nonEmpty(source?.quote))) errors.push('every source needs document, page and quote');
  if (answer.legalReview !== 'required') errors.push('legalReview marker required');
  if (answer.state === 'insufficient_evidence' && Array.isArray(answer.unknowns) && !answer.unknowns.length) errors.push('insufficient evidence needs unknowns');
  return errors;
}
