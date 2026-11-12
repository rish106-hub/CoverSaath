import { AI_CONTRACT_VERSION, assertModelTask } from './responsibility-matrix.js';
import { TASK_OUTPUT_SCHEMAS, validateTaskInput } from './schemas.js';
import { isGatewayTask } from './gateway-contract.js';
import { isStructuringTask } from './structuring-contract.js';
import { purposePromptVersion, renderReference, renderSystemPrompt } from './prompt-pack.js';

// v3: grounded XML prompt pack (prompt-pack.js). The system message holds instructions only; the evidence message holds
// the supplied excerpts inside <reference> as <document id page> elements, then the task data in <request>.
export const PROMPT_VERSION = 'knowvia-ai-analysis-v3';

export function buildPromptContract(task, input) {
  assertModelTask(task);
  const validated = validateTaskInput(task, input).input;
  return Object.freeze({
    contractVersion: AI_CONTRACT_VERSION,
    promptVersion: PROMPT_VERSION,
    // Per-purpose version (pack version plus purpose version), recorded on the provider_calls audit row.
    purposeVersion: purposePromptVersion(task),
    system: renderSystemPrompt(task, { schema: TASK_OUTPUT_SCHEMAS[task] }),
    // Structuring and gateway tasks send their payload; coverage tasks send the whole validated input.
    evidence: renderReference(task, isStructuringTask(task) || isGatewayTask(task) ? validated.payload : validated),
  });
}
