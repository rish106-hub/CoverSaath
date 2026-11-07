// Test helper that builds a coverage-task model input the way production does (through the privacy gate), so tests that
// call the gateway directly hand over a sealed input (ADR 0017). Synthetic data only.
import { sanitizeEvidenceForModel } from '../../src/features/ai-analysis/privacy-evidence-gate.js';

const allowAll = () => ({ modelExtraction: true, dataClass: 'INTERNAL' });

/** A coverage-task input (context, sources, upstream) sealed by the real gate. */
export function sealedCoverageInput(task, raw, { knownIdentifiers = [], resolveParameterPolicy = allowAll, regated = false } = {}) {
  return sanitizeEvidenceForModel(raw, { task, knownIdentifiers, resolveParameterPolicy, regated }).input;
}
