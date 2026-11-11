import { createHash } from 'node:crypto';
import { HOLDING_JOB_STEPS } from '../../contracts/holdings.js';

// Idempotency helpers of the holdings pipeline (complete.md 3.2 and 9.4). The job key is (holding_id, step, input_sha); the queue
// stores the sha256 hex of that triple in job_queue.dedupe_key (64 characters, under the 128 limit). input_sha is a sha256 over
// identifiers and versions only (fact ids, reference ids, source versions): never a value, a quote or any text, so the key reveals
// nothing even though dedupe_key is plaintext.

const STEPS = new Set(Object.values(HOLDING_JOB_STEPS));
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

/** sha256 hex of a set of identifiers (order-free). */
export function holdingInputSha(identifiers) {
  if (!Array.isArray(identifiers) || identifiers.some(item => typeof item !== 'string' || !ID.test(item))) {
    throw Object.assign(new Error('Pipeline inputs must be identifiers.'), { code: 'HOLDING_JOB_INPUT_INVALID' });
  }
  return sha256(JSON.stringify([...new Set(identifiers)].sort()));
}

/** job_queue.dedupe_key for one pipeline step of one holding over one input. */
export function holdingJobDedupeKey({ holdingId, step, inputSha }) {
  if (typeof holdingId !== 'string' || !ID.test(holdingId) || !STEPS.has(step) || typeof inputSha !== 'string' || !HEX64.test(inputSha)) {
    throw Object.assign(new Error('The pipeline job key is invalid.'), { code: 'HOLDING_JOB_INPUT_INVALID' });
  }
  return sha256(`${holdingId}\u0000${step}\u0000${inputSha}`);
}
