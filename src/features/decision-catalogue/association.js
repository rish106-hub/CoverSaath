// Phase 3 document-to-policy association. A document is only ever a CANDIDATE member of a logical policy, and only
// when its own clauses print exactly one policy number. The number is used as a grouping key and is never returned:
// the logical policy id is a digest of it. Nothing here verifies an association: that needs an authorised reviewer's
// attestation (ADR 0009). The uploader-selected document kind is not used as evidence of which policy a file belongs to.
//
// The id is KEYED. Policy numbers are short and structured, so a plain hash of one could be reversed by trying every number
// in an insurer's format. Without a key from the caller, a random per-process key is used: ids are then stable only until a
// restart, and reviews recorded against facts on those ids stop matching (they read as stale, never as accepted).
import { createHmac, randomBytes } from 'node:crypto';
import { deepFreeze } from './contracts.js';

const POLICY_NUMBER = /\bpolicy\s*(?:no\.?|number|num\.?|#)\s*[:\-–]?\s*([A-Z0-9][A-Z0-9/\-]{5,39})\b/gi;
const normalise = raw => raw.toUpperCase().replace(/[\s]/g, '');

/** Distinct normalised policy numbers printed in a text. A candidate needs a digit, so "Policy Number Format" is not one. */
export function extractPolicyNumbers(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(POLICY_NUMBER)) {
    const value = normalise(match[1]);
    if (/\d/.test(value)) found.add(value);
  }
  return [...found];
}

const PROCESS_KEY = randomBytes(32);

/** Logical policy id for a normalised policy number. `key` is a secret of at least 32 bytes held by the server. */
export function logicalPolicyId(number, key = PROCESS_KEY) {
  if (!(key instanceof Uint8Array) || key.length < 32) throw new TypeError('A policy id key of at least 32 bytes is required.');
  return `pol-${createHmac('sha256', key).update(`policy-association/v2:${number}`).digest('hex').slice(0, 32)}`;
}

/**
 * @param clauseRows   ClauseRepository rows (documentId, text)
 * @param documentIds  documents that back the answer
 * @param key          server-held secret for the logical policy id (see logicalPolicyId)
 * @returns { policies: [{policyId, documentIds}], documents: [{documentId, status, policyId, basis, verified}] }
 *   status: candidate (exactly one number), ambiguous (several numbers in one document), unestablished (none).
 */
export function associateDocuments(clauseRows, documentIds, { key } = {}) {
  const numbersByDocument = new Map(documentIds.map(id => [id, new Set()]));
  for (const row of clauseRows ?? []) {
    const bucket = numbersByDocument.get(row.documentId);
    if (bucket) for (const number of extractPolicyNumbers(row.text)) bucket.add(number);
  }
  const policies = new Map();
  const documents = documentIds.map(documentId => {
    const numbers = [...numbersByDocument.get(documentId)];
    if (numbers.length === 1) {
      const policyId = logicalPolicyId(numbers[0], key);
      policies.set(policyId, [...(policies.get(policyId) ?? []), documentId]);
      return { documentId, status: 'candidate', policyId, basis: 'printed_policy_number', verified: false };
    }
    return { documentId, status: numbers.length ? 'ambiguous' : 'unestablished', policyId: null, basis: numbers.length ? 'several_policy_numbers' : 'no_policy_number', verified: false };
  });
  return deepFreeze({
    policies: [...policies].map(([policyId, ids]) => ({ policyId, documentIds: ids })),
    documents,
  });
}
