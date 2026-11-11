import { DETECT_INSURER_JOB_KIND, REFERENCE_IMPORT_JOB_KIND } from '../services/holding-product-service.js';

// Job handlers for the holdings slice. Jobs carry identifiers only. Outcomes:
//   done or nothing to do   -> return (the worker marks the job succeeded)
//   document unreadable now, registry not built yet, reference service down -> rethrow a retryable coded error (backoff)
//   flag off or malformed job -> non-retryable coded error (dead letter)
const malformed = () => Object.assign(new Error('The job is not a valid holdings job.'), { code: 'JOB_PAYLOAD_INVALID', retryable: false });
const PERMANENT_END = new Set(['HOLDING_DOCUMENT_NOT_READABLE']);

export function createReferenceImportHandler({ service, hospitals = null }) {
  if (!service || typeof service.importReference !== 'function') throw new TypeError('A holding product service is required.');
  return async function handleReferenceImport({ job, signal } = {}) {
    if (job?.kind !== REFERENCE_IMPORT_JOB_KIND || typeof job.householdId !== 'string') throw malformed();
    if (signal?.aborted) return;
    if (job.payload?.scope === 'registry') { await service.importRegistry(); return; }
    if (job.payload?.scope === 'hospitals' && hospitals) { await hospitals.importHospitals(); return; }
    if (job.payload?.scope === 'product' && typeof job.payload.policyProfileId === 'string') {
      await service.importReference({ householdId: job.householdId, policyProfileId: job.payload.policyProfileId });
      return;
    }
    throw malformed();
  };
}

export function createDetectInsurerHandler({ service }) {
  if (!service || typeof service.runDetection !== 'function') throw new TypeError('A holding product service is required.');
  return async function handleDetectInsurer({ job, signal } = {}) {
    if (job?.kind !== DETECT_INSURER_JOB_KIND || typeof job.householdId !== 'string' || typeof job.documentId !== 'string' || typeof job.payload?.holdingId !== 'string') throw malformed();
    if (signal?.aborted) return;
    try {
      await service.runDetection({ householdId: job.householdId, documentId: job.documentId, holdingId: job.payload.holdingId });
    } catch (error) {
      if (PERMANENT_END.has(error?.code)) return;
      throw error;
    }
  };
}
