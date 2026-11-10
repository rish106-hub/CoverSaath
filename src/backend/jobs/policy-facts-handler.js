import { POLICY_FACTS_JOB_KIND } from '../services/policy-facts-service.js';

// Job handler for `policy_facts.extract` (ADR 0025). The job carries identifiers only (household and document columns, a payload of
// identifier values); this handler holds no text. It runs PolicyFactsService.extract, which re-checks the document, its processing
// consent and the OCR reading grant, and re-checks them again inside the writing transaction.
//
// Outcomes:
//   stored or nothing to store     -> returns; the worker marks the job succeeded
//   document gone, replaced, consent withdrawn, text no longer readable -> returns without writing (a permanent end, not a retry)
//   feature switched off, malformed job -> throws a non-retryable coded error (dead letter)
//   anything else (database blip)  -> rethrown; the worker retries with backoff. The write is ON CONFLICT DO NOTHING, so a retry
//                                     after a partial attempt never duplicates a fact.
const PERMANENT_END = new Set(['POLICY_FACT_NOT_READY']);

export function createPolicyFactsHandler({ service }) {
  if (!service || typeof service.extract !== 'function') throw new TypeError('A policy facts service is required.');
  return async function handlePolicyFactsExtract({ job, signal } = {}) {
    if (job?.kind !== POLICY_FACTS_JOB_KIND || typeof job.householdId !== 'string' || typeof job.documentId !== 'string') {
      throw Object.assign(new Error('The job is not a policy facts job.'), { code: 'JOB_PAYLOAD_INVALID', retryable: false });
    }
    if (signal?.aborted) return;
    try {
      await service.extract({ householdId: job.householdId, documentId: job.documentId });
    } catch (error) {
      if (PERMANENT_END.has(error?.code)) return;
      if (error?.code === 'POLICY_FACTS_DISABLED') throw Object.assign(new Error('Policy facts are disabled.'), { code: 'POLICY_FACTS_DISABLED', retryable: false });
      throw error;
    }
  };
}
