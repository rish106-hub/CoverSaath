import { HOLDING_JOB_KINDS } from '../../contracts/holdings.js';

// Job handlers of the holdings pipeline (complete.md 3.2). Each job carries identifiers only: the household and document columns and
// payload { holdingId, inputSha }. The handler holds no text; the service re-reads the holding by household and id and re-checks the
// document and its consent inside every write.
//
// Outcomes:
//   done, or nothing to do (a replay, collate before the own-PDF step) -> returns; the worker marks the job succeeded
//   holding or document gone, step not allowed, switched off, malformed job -> non-retryable coded error (dead letter at once)
//   anything else (database blip) -> rethrown; the worker retries with backoff, at most 3 attempts (HOLDING_JOB_MAX_ATTEMPTS).
//                                    Every write is a no-op on unchanged input, so a retry after a partial attempt is safe.
const PERMANENT = new Set(['HOLDING_NOT_FOUND', 'HOLDING_NOT_READY', 'HOLDING_TRANSITION_INVALID', 'HOLDINGS_DISABLED', 'POLICY_FACTS_DISABLED', 'COLLATE_AUTHORITY_REFUSED']);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

const METHOD = Object.freeze({
  [HOLDING_JOB_KINDS.parseOwnPdf]: 'parseOwnPdf',
  [HOLDING_JOB_KINDS.fetchReference]: 'fetchReference',
  [HOLDING_JOB_KINDS.collate]: 'collate',
  [HOLDING_JOB_KINDS.memorise]: 'memorise',
});

export function createHoldingHandlers({ service }) {
  if (!service || typeof service.collate !== 'function') throw new TypeError('A holdings service is required.');
  const handlers = {};
  for (const [kind, method] of Object.entries(METHOD)) {
    handlers[kind] = async function handleHoldingJob({ job, signal } = {}) {
      const holdingId = job?.payload?.holdingId;
      if (job?.kind !== kind || typeof job.householdId !== 'string' || typeof holdingId !== 'string' || !ID.test(holdingId)) {
        throw Object.assign(new Error('The job is not a holdings job.'), { code: 'JOB_PAYLOAD_INVALID', retryable: false });
      }
      if (signal?.aborted) return;
      try {
        await service[method]({ householdId: job.householdId, holdingId });
      } catch (error) {
        if (PERMANENT.has(error?.code)) throw Object.assign(new Error('The holdings step cannot run.'), { code: error.code, retryable: false });
        throw error;
      }
    };
  }
  return Object.freeze(handlers);
}
