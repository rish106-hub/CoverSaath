// Meta-test helper: does a synthetic corpus input look like restricted evidence to the storage gate? (A corpus row
// that is not meant to be refused must never be refused, or it would not test redaction at all.)
import { sanitizeEvidenceTextForStorage } from '../../src/features/ai-analysis/privacy-evidence-gate.js';

export function RESTRICTED_PATTERNS_PROBE(text) {
  try { sanitizeEvidenceTextForStorage(text, { knownIdentifiers: [], maxBytes: 16_000 }); return false; } catch (error) {
    // Only the restricted-evidence refusal is an answer; any other failure (empty text, over the intake limit) is a bad corpus row and must surface.
    if (error?.code === 'RESTRICTED_EVIDENCE') return true;
    throw error;
  }
}
