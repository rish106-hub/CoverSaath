// Test wrapper: the production storage gate requires an explicit knownIdentifiers list, so tests that probe the
// pattern rules pass "none" unless they supply their own.
import { sanitizeEvidenceTextForStorage as gate } from '../../src/features/ai-analysis/privacy-evidence-gate.js';

export const sanitizeEvidenceTextForStorage = (text, options = {}) => gate(text, { knownIdentifiers: [], ...options });
