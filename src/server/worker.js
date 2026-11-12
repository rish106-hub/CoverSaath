import { hostname } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createDatabase } from '../backend/database/postgres/db.js';
import { createPostgresPool, postgresPoolOptionsFromEnv } from '../backend/database/postgres/pool.js';
import { JobQueueRepository } from '../backend/repositories/job-queue-repository.js';
import { createJobWorker } from '../backend/services/job-worker.js';
import { createBackendServices } from '../backend/services/index.js';
import { POLICY_FACTS_JOB_KIND } from '../backend/services/policy-facts-service.js';
import { policyFactsEnabled } from '../backend/services/policy-profile-service.js';
import { createPolicyFactsHandler } from '../backend/jobs/policy-facts-handler.js';
import { createHoldingHandlers } from '../backend/jobs/holding-pipeline-handlers.js';
import { holdingsEnabled } from '../backend/services/holdings-flag.js';
import { createDetectInsurerHandler, createReferenceImportHandler } from '../backend/jobs/holding-product-handlers.js';
import { createPosthogClient } from '../integrations/index.js';
import { DETECT_INSURER_JOB_KIND, REFERENCE_IMPORT_JOB_KIND } from '../backend/services/holding-product-service.js';

// Worker process entry (plan B4): `npm run worker`. Same image and database as the API, no HTTP listener. It claims jobs from
// the Postgres queue (job_queue, migration 034) and runs the handler registered for the job's kind.
//
// Handlers are registered one kind at a time. Each receives identifiers only, re-checks household ownership and current consent,
// and sends nothing to a provider without the privacy gate (AI.md invariants 1 and 2). Today: policy_facts.extract (ADR 0025),
// registered only while POLICY_FACTS_ENABLED is exactly "true"; with nothing registered the worker claims nothing.
export const jobHandlers = Object.freeze({});

/** The handlers for this environment, built on the services of one database. */
export function buildJobHandlers(services, env = process.env) {
  const handlers = {};
  if (policyFactsEnabled(env)) handlers[POLICY_FACTS_JOB_KIND] = createPolicyFactsHandler({ service: services.policyFacts });
  // Holdings pipeline (complete.md 3.2): parse_own_pdf, fetch_reference (queues collate only), collate, memorise (embeds through the memory service). Only while HOLDINGS_ENABLED is exactly "true".
  if (holdingsEnabled(env)) Object.assign(handlers, createHoldingHandlers({ service: services.holdings }));
  // Holdings (HOLDINGS_ENABLED=true): detection, and the reference import (also needs REFERENCE_DATA_ENABLED=true to do any work).
  if (holdingsEnabled(env)) {
    handlers[DETECT_INSURER_JOB_KIND] = createDetectInsurerHandler({ service: services.holdingProducts });
    handlers[REFERENCE_IMPORT_JOB_KIND] = createReferenceImportHandler({ service: services.holdingProducts, hospitals: services.networkHospitals });
  }
  return Object.freeze(handlers);
}

function boundedInteger(value, fallback, name, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${name}.`);
  return parsed;
}

export function readWorkerConfig(env = process.env) {
  const workerId = (env.WORKER_ID || `${hostname()}-${process.pid}`).replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 128);
  const leaseMs = boundedInteger(env.WORKER_LEASE_MS, 60_000, 'WORKER_LEASE_MS', 5_000, 3_600_000);
  return Object.freeze({
    workerId,
    leaseMs,
    heartbeatMs: Math.floor(leaseMs / 3),
    pollMs: boundedInteger(env.WORKER_POLL_MS, 2_000, 'WORKER_POLL_MS', 100, 60_000),
    concurrency: boundedInteger(env.WORKER_CONCURRENCY, 1, 'WORKER_CONCURRENCY', 1, 16),
  });
}

/**
 * Analytics outbox drain (ADR 0033): every ANALYTICS_DRAIN_MS (default 15 s) sends one batch of allowlisted events through the PostHog adapter.
 * Off unless ANALYTICS_ENABLED is exactly "true", the salt is set and POSTHOG_API_KEY + POSTHOG_HOST are set; otherwise no timer runs and nothing
 * is read. Returns { stop } or null.
 */
export function startAnalyticsDrain({ services, env = process.env, client = createPosthogClient({ env }), log = () => {} } = {}) {
  if (!services.analytics.enabled() || !client) return null;
  const everyMs = boundedInteger(env.ANALYTICS_DRAIN_MS, 15_000, 'ANALYTICS_DRAIN_MS', 1_000, 3_600_000);
  let busy = false;
  let stopped = false;
  let current = null;
  const run = async () => {
    try { const counts = await services.analytics.drain({ client }); if (counts.sent || counts.failed || counts.dropped) log({ type: 'analytics.drained', ...counts }); }
    catch (error) { log({ type: 'analytics.drain_failed', code: typeof error?.code === 'string' ? error.code : 'ANALYTICS_DRAIN_FAILED' }); }
    finally { busy = false; }
  };
  const tick = () => {
    if (stopped) return Promise.resolve();
    if (busy) return current ?? Promise.resolve();
    busy = true;
    current = run().finally(() => { current = null; });
    return current;
  };
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return {
    tick,
    // No new tick after stop; waits for the in-flight tick (at most stopWaitMs) before closing the client.
    async stop({ stopWaitMs = 10_000 } = {}) {
      stopped = true;
      clearInterval(timer);
      if (current) {
        let waitTimer;
        await Promise.race([current, new Promise(resolve => { waitTimer = setTimeout(resolve, stopWaitMs); })]);
        clearTimeout(waitTimer);
      }
      await client.close();
    },
  };
}

/** Builds and starts a worker on the database from `env`. Returns { worker, stop }. */
export function startWorker({ env = process.env, handlers = null, log = line => console.log(JSON.stringify(line)) } = {}) {
  const config = readWorkerConfig(env);
  const database = createDatabase(createPostgresPool(postgresPoolOptionsFromEnv(env)));
  const services = createBackendServices(database, { env });
  const registered = handlers ?? buildJobHandlers(services, env);
  const worker = createJobWorker({ queue: new JobQueueRepository(database), handlers: registered, onEvent: event => log({ ...event, workerId: config.workerId }), ...config });
  worker.start();
  const analyticsDrain = startAnalyticsDrain({ services, env, log });
  log({ type: 'worker.started', workerId: config.workerId, kinds: worker.kinds });
  return {
    worker,
    async stop() {
      const drained = await worker.stop();
      await analyticsDrain?.stop();
      await database.close();
      log({ type: 'worker.stopped', workerId: config.workerId, drained });
      return drained;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const running = startWorker();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.exitCode = (await running.stop()) ? 0 : 1;
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
