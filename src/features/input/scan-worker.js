const SWEEP_LIMIT = 50;
const QUEUE_CAP = 500;

const unref = timer => {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
};

// The database row (malware_status 'pending') is the durable queue. This worker keeps only in-memory
// attempt counters, so a restart re-scans pending documents. Persistence-layer guards make double scans harmless.
export function createDocumentScanWorker({
  listPendingDocumentIds,
  scanDocument,
  clock = () => Date.now(),
  random = Math.random,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  concurrency = 2,
  maxAttempts = 6,
  baseDelayMs = 2_000,
  maxDelayMs = 300_000,
  sweepIntervalMs = 30_000,
  onEvent = () => {},
} = {}) {
  if (typeof listPendingDocumentIds !== 'function' || typeof scanDocument !== 'function') {
    throw new TypeError('Scan worker requires listPendingDocumentIds and scanDocument functions.');
  }
  void clock;

  const queue = [];
  const queued = new Set();
  const inFlight = new Map();
  const attempts = new Map();
  const exhausted = new Set();
  const retryTimers = new Map();
  let sweepTimer = null;
  let started = false;
  let stopped = false;

  const emit = event => {
    try { onEvent(event); } catch { /* observers must never break the worker */ }
  };

  function enqueue(documentId) {
    if (stopped || exhausted.has(documentId) || queued.has(documentId) || inFlight.has(documentId)) return;
    if (queue.length >= QUEUE_CAP) return;
    queue.push(documentId);
    queued.add(documentId);
    pump();
  }

  function schedule(documentId) {
    if (typeof documentId !== 'string' || documentId === '' || retryTimers.has(documentId)) return;
    enqueue(documentId);
  }

  function pump() {
    while (!stopped && inFlight.size < concurrency && queue.length > 0) {
      const documentId = queue.shift();
      queued.delete(documentId);
      inFlight.set(documentId, run(documentId));
    }
  }

  async function run(documentId) {
    const attempt = (attempts.get(documentId) ?? 0) + 1;
    attempts.set(documentId, attempt);
    try {
      const outcome = await scanDocument(documentId);
      attempts.delete(documentId);
      emit({ type: 'scan_completed', documentId, outcome });
    } catch (error) {
      const retryable = error?.retryable === true;
      if (retryable && attempt < maxAttempts && !stopped) {
        const delayMs = random() * Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
        const timer = setTimer(() => {
          retryTimers.delete(documentId);
          enqueue(documentId);
        }, delayMs);
        retryTimers.set(documentId, unref(timer));
        emit({ type: 'scan_retry_scheduled', documentId, attempt, delayMs });
      } else if (!retryable || attempt >= maxAttempts) {
        attempts.delete(documentId);
        exhausted.add(documentId);
        emit({ type: 'scan_exhausted', documentId, attempts: attempt, code: typeof error?.code === 'string' ? error.code : 'UNKNOWN' });
      }
    } finally {
      inFlight.delete(documentId);
      pump();
    }
  }

  async function sweep() {
    if (stopped) return;
    let ids;
    try {
      ids = await listPendingDocumentIds(SWEEP_LIMIT);
    } catch {
      emit({ type: 'sweep_failed' });
      return;
    }
    if (stopped || !Array.isArray(ids)) return;
    for (const id of ids) schedule(id);
  }

  function armSweep() {
    if (stopped) return;
    sweepTimer = unref(setTimer(() => {
      sweepTimer = null;
      sweep().catch(() => emit({ type: 'sweep_failed' }));
      armSweep();
    }, sweepIntervalMs));
  }

  function start() {
    if (started || stopped) return;
    started = true;
    sweep().catch(() => emit({ type: 'sweep_failed' }));
    armSweep();
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    if (sweepTimer !== null) clearTimer(sweepTimer);
    sweepTimer = null;
    for (const timer of retryTimers.values()) clearTimer(timer);
    retryTimers.clear();
    queue.length = 0;
    queued.clear();
    await Promise.allSettled([...inFlight.values()]);
  }

  const stats = () => ({ inFlight: inFlight.size, queued: queue.length + retryTimers.size, exhausted: exhausted.size });

  return Object.freeze({ schedule, sweep, start, stop, stats });
}
