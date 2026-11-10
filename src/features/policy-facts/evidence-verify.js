// Evidence verification for policy facts (ADR 0025). A fact is kept only when BOTH hold:
//   1. its quote is a literal substring of the cited chunk's text (NFC, so a composed and a decomposed letter match), on the cited
//      page and block; and
//   2. its value parses from that quote with the fact type's normaliser (normalisers.js), to the same value.
// Otherwise it is dropped with a reason code. A model paraphrase, a value that is not printed in its own quote and a quote lifted from
// another place are all refused. Applies to deterministic and model-proposed facts alike; a model-proposed fact also needs a fact
// type the registry allows a model to propose (fact-types.js).

import { FACT_TYPES, isFactType, modelMayProposeFact } from './fact-types.js';
import { comparable, sha256Nfc, valuesIn } from './normalisers.js';

export const EVIDENCE_LIMITS = Object.freeze({ maxQuoteChars: 500, maxTextValueChars: 300 });

const nfc = text => text.normalize('NFC');

/**
 * @param {{ factType: string, value: object, quote: string, page: number, blockIndex: number|null, origin?: string }} candidate
 * @param {{ id: string, page: number, blockIndexes: readonly number[], text: string }} chunk the chunk the quote is cited from
 * @returns {{ ok: true, quote: string, clauseId: string } | { ok: false, reason: string }}
 */
export function verifyEvidence(candidate, chunk) {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'not_object' };
  if (!isFactType(candidate.factType)) return { ok: false, reason: 'unknown_fact_type' };
  if (candidate.origin === 'model_proposed' && !modelMayProposeFact(candidate.factType)) return { ok: false, reason: 'model_not_permitted' };
  if (!chunk || typeof chunk.text !== 'string' || !Number.isInteger(chunk.page) || !Array.isArray(chunk.blockIndexes)) return { ok: false, reason: 'chunk_invalid' };
  if (typeof candidate.quote !== 'string') return { ok: false, reason: 'quote_missing' };
  const quote = nfc(candidate.quote).trim();
  if (!quote) return { ok: false, reason: 'quote_missing' };
  if (quote.length > EVIDENCE_LIMITS.maxQuoteChars) return { ok: false, reason: 'quote_too_long' };
  if (!nfc(chunk.text).includes(quote)) return { ok: false, reason: 'quote_not_in_chunk' };
  if (candidate.page !== chunk.page) return { ok: false, reason: 'page_mismatch' };
  if (candidate.blockIndex !== null && candidate.blockIndex !== undefined
    && !(Number.isInteger(candidate.blockIndex) && chunk.blockIndexes.includes(candidate.blockIndex))) return { ok: false, reason: 'block_not_in_chunk' };

  const kind = FACT_TYPES[candidate.factType].parse;
  if (kind === 'text') {
    // Free text is a literal piece of the quote.
    const text = typeof candidate.value?.text === 'string' ? nfc(candidate.value.text).replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length > EVIDENCE_LIMITS.maxTextValueChars) return { ok: false, reason: 'value_invalid' };
    return nfc(quote).replace(/\s+/g, ' ').includes(text) ? { ok: true, quote, clauseId: chunk.id ?? null } : { ok: false, reason: 'value_not_in_quote' };
  }
  const wanted = comparable(kind, candidate.value);
  if (wanted === null || wanted === undefined) return { ok: false, reason: 'value_invalid' };
  const printed = valuesIn(kind, quote).map(value => comparable(kind, value));
  return printed.includes(wanted) ? { ok: true, quote, clauseId: chunk.id ?? null } : { ok: false, reason: 'value_not_in_quote' };
}

/** sha256 of a page's text for source_digest when the stored page digest is not available. */
export const pageDigest = sha256Nfc;
