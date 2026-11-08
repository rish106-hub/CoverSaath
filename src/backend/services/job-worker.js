import { DEFAULT_LEASE_MS } from '../repositories/job-queue-repository.js';

// The loop that runs queued jobs (plan B4). It claims one due job at a time per slot, renews the lease by heartbeat while the
// handler runs, and reports the outcome to the queue. It knows nothing about OCR, models or documents: a handler is
// `async ({ job, signal }) => void`, receives identifiers only, and must itself re-check household ownership and current
// consent before it calls a provider or commits (AI.md invariants 1 and 2).
//
// A handler that throws fails the attempt (retried with backoff until max_attempts, then dead-lettered). Throw an error with
// `retryable: false` to dead-letter at once. Only `error.code` (A-Z, 0-9, _) is stored, never the message. When a heartbeat is
// refused the lease is lost (another worker holds the job, or the job was erased by a revocation): `signal` aborts, and the
// outcome of this attempt is dropped.

const DEFAULT_POLL_MS = 2_000;
const DEFAULT_SHUTDOWN_MS = 25_000;

export function createJobWorker({
  queue, handlers, workerId, leaseMs = DEFAULT_LEASE_MS, heartbeatMs = Math.floor(leaseMs / 3), pollMs = DEFAULT_POLL_MS,
  concurrency = 1, onEvent = () => {},
}) {
  const kinds = Object.keys(handlers ?? {});
  if (!queue) throw new TypeError('createJobWorker needs a queue.');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new TypeError('concurrency must be 1 to 16.');
  if (!(heartbeatMs > 0) || heartbeatMs >= leaseMs) throw new TypeError('heartbeatMs must be positive and shorter than leaseMs.');
  // Events carry the job id, kind and a code only. A throwing listener never breaks the loop.
  const emit = event => { try { onEvent(Object.freeze(event)); } catch { /* observability must not stop work */ } };

  /** Claims and runs at most one job. Returns the outcome, or null when nothing was due. */
  async function runOnce() {
    if (kinds.length === 0) return null;
    const job = await queue.claim({ workerId, kinds, leaseMs });
    if (!job) return null;
    const fence = { id: job.id, workerId, attempt: job.attempt };
    const controller = new AbortController();
    let lost = false;
    const lose = () => { lost = true; controller.abort(); };
    let beating = false;
    const timer = setInterval(() => {
      if (beating || lost) return;
      beating = true;
      queue.heartbeat({ ...fence, leaseMs }).then(
        held => { if (!held) lose(); },
        () => { /* a database blip: the lease runs out on its own if it persists */ },
      ).finally(() => { beating = false; });
    }, heartbeatMs);
    timer.unref?.();
    emit({ type: 'job.started', jobId: job.id, kind: job.kind, attempt: job.attempt });
    let failure = null;
    try {
      await handlers[job.kind]({ job, signal: controller.signal });
    } catch (error) {
      failure = error;
    } finally {
      clearInterval(timer);
    }
    if (lost) {
      emit({ type: 'job.lease_lost', jobId: job.id, kind: job.kind, attempt: job.attempt });
      return { jobId: job.id, outcome: 'lease_lost' };
    }
    if (!failure) {
      const done = await queue.complete(fence);
      emit({ type: done ? 'job.succeeded' : 'job.lease_lost', jobId: job.id, kind: job.kind, attempt: job.attempt });
      return { jobId: job.id, outcome: done ? 'succeeded' : 'lease_lost' };
    }
    const result = await queue.fail({ ...fence, errorCode: failure?.code, retryable: failure?.retryable !== false });
    if (!result) {
      emit({ type: 'job.lease_lost', jobId: job.id, kind: job.kind, attempt: job.attempt });
      return { jobId: job.id, outcome: 'lease_lost' };
    }
    emit({ type: result.state === 'dead' ? 'job.dead' : 'job.retry', jobId: job.id, kind: job.kind, attempt: job.attempt, code: typeof failure?.code === 'string' ? failure.code : 'JOB_FAILED' });
    return { jobId: job.id, outcome: result.state === 'dead' ? 'dead' : 'retry' };
  }

  let stopping = false;
  const wakers = new Set();
  const running = new Set();
  const idle = () => new Promise(resolve => {
    const done = () => { clearTimeout(timer); wakers.delete(done); resolve(); };
    const timer = setTimeout(done, pollMs);
    timer.unref?.();
    wakers.add(done);
  });

  async function slot() {
    while (!stopping) {
      let outcome = null;
      try {
        outcome = await runOnce();
      } catch {
        emit({ type: 'worker.error', code: 'JOB_WORKER_CYCLE_FAILED' });
      }
      if (!outcome && !stopping) await idle();
    }
  }

  return Object.freeze({
    workerId,
    kinds: Object.freeze(kinds),
    runOnce,
    /** Starts `concurrency` loops. Call stop() to end them. */
    start() {
      if (running.size > 0 || stopping) return;
      for (let n = 0; n < concurrency; n += 1) {
        const loop = slot().finally(() => running.delete(loop));
        running.add(loop);
      }
    },
    /** Stops claiming and waits (bounded) for jobs in flight. Returns true when every slot finished. */
    async stop({ timeoutMs = DEFAULT_SHUTDOWN_MS } = {}) {
      stopping = true;
      for (const wake of [...wakers]) wake();
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); timer.unref?.(); });
      const finished = await Promise.race([Promise.all([...running]).then(() => true), deadline]);
      clearTimeout(timer);
      return finished;
    },
  });
}
