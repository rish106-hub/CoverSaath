import { createHmac } from 'node:crypto';
import { hashClient, normalizeEvent } from '../repositories/app-event-repository.js';

const DAY_MS = 86_400_000;

/** Key for hashing client addresses, derived from the current data key so it needs no separate secret. */
export function deriveEventHmacKey(dataEncryptionConfig) {
  const key = dataEncryptionConfig.keys.get(dataEncryptionConfig.currentId);
  return createHmac('sha256', key).update('cover-saath app-events client hash v1').digest();
}

/**
 * Buffers application events and writes them in batches off the request path. record() never throws, never awaits and
 * never touches the database; a full buffer drops the oldest event and counts it. A failed batch is retried once, then
 * dropped and counted, so a database outage cannot grow memory or slow a request. The flush loop starts where the recorder
 * is built (outside any transaction), so it can never join a request's transaction.
 */
export function createAppEventRecorder({
  repository, hmacKey, enabled = true, retentionDays = 30, bufferLimit = 2000, batchSize = 100, flushIntervalMs = 2000,
  clock = () => new Date(), onError = () => {},
} = {}) {
  if (!repository || !Buffer.isBuffer(hmacKey)) throw new TypeError('A repository and an HMAC key are required.');
  if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new TypeError('Invalid retention.');
  const retentionMs = retentionDays * DAY_MS;
  const buffer = [];
  const stats = { recorded: 0, written: 0, dropped: 0, failedBatches: 0, rejected: 0 };
  let closed = false;
  let wake = null;
  let flushing = Promise.resolve();

  function record(event) {
    if (!enabled || closed) return;
    try {
      const { clientKey, ...rest } = event ?? {};
      const normalized = normalizeEvent({ ...rest, clientHash: clientKey === undefined ? undefined : hashClient(hmacKey, clientKey) });
      if (!normalized) { stats.rejected += 1; return; }
      normalized.at = clock();
      if (buffer.length >= bufferLimit) { buffer.shift(); stats.dropped += 1; }
      buffer.push(normalized);
      stats.recorded += 1;
      if (buffer.length >= batchSize) wake?.();
    } catch {
      stats.rejected += 1;
    }
  }

  async function writeBatch(batch) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        stats.written += await repository.insertBatch(batch, { retentionMs });
        return;
      } catch (error) {
        if (attempt === 1) {
          stats.failedBatches += 1;
          stats.dropped += batch.length;
          onError(error);
        }
      }
    }
  }

  // Serialised: one batch in flight at a time.
  function flush() {
    flushing = flushing.then(async () => {
      while (buffer.length > 0) await writeBatch(buffer.splice(0, batchSize));
    });
    return flushing;
  }

  let timer = null;
  if (enabled) {
    const loop = async () => {
      while (!closed) {
        await new Promise(resolve => {
          wake = resolve;
          timer = setTimeout(resolve, flushIntervalMs);
          timer.unref?.();
        });
        clearTimeout(timer);
        wake = null;
        await flush();
      }
    };
    loop().catch(() => {});
  }

  return Object.freeze({
    enabled,
    record,
    flush,
    stats: () => ({ ...stats, buffered: buffer.length }),
    async close() {
      closed = true;
      wake?.();
      clearTimeout(timer);
      await flush();
    },
  });
}
