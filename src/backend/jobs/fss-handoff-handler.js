import { FSS_HANDOFF_JOB_KIND, FSS_PULL_JOB_KIND } from '../services/fss-handoff-service.js';

// holding.fss_handoff: identifiers only (household, holding id, opaque request id). Retryable FSS failures are rethrown by the service (backoff).
const malformed = () => Object.assign(new Error('The job is not a valid FSS handoff job.'), { code: 'JOB_PAYLOAD_INVALID', retryable: false });

export function createFssHandoffHandler({ service }) {
  if (!service || typeof service.send !== 'function') throw new TypeError('An FSS handoff service is required.');
  return async function handleFssHandoff({ job, signal } = {}) {
    if (job?.kind !== FSS_HANDOFF_JOB_KIND || typeof job.householdId !== 'string' || typeof job.payload?.holdingId !== 'string' || typeof job.payload?.requestId !== 'string') throw malformed();
    if (signal?.aborted) return;
    await service.send({ householdId: job.householdId, holdingId: job.payload.holdingId, requestId: job.payload.requestId });
  };
}

// holding.fss_pull: identifiers only (household, holding id, opaque request id). The pull needs a retryable error to reach the queue for backoff.
export function createFssPullHandler({ service }) {
  if (!service || typeof service.pull !== 'function') throw new TypeError('An FSS handoff service is required.');
  return async function handleFssPull({ job, signal } = {}) {
    if (job?.kind !== FSS_PULL_JOB_KIND || typeof job.householdId !== 'string' || typeof job.payload?.holdingId !== 'string' || typeof job.payload?.requestId !== 'string') throw malformed();
    if (signal?.aborted) return;
    await service.pull({ householdId: job.householdId, holdingId: job.payload.holdingId, requestId: job.payload.requestId });
  };
}
