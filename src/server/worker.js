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
import { createHoldingHandlers } from '../backend/jobs/holding-handlers.js';
import { holdingsEnabled } from '../backend/services/holdings-flag.js';

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
  // Holdings pipeline (complete.md 3.2): parse_own_pdf, fetch_reference (stub), collate, memorise (stub). Only while HOLDINGS_ENABLED is exactly "true".
  if (holdingsEnabled(env)) Object.assign(handlers, createHoldingHandlers({ service: services.holdings }));
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

/** Builds and starts a worker on the database from `env`. Returns { worker, stop }. */
export function startWorker({ env = process.env, handlers = null, log = line => console.log(JSON.stringify(line)) } = {}) {
  const config = readWorkerConfig(env);
  const database = createDatabase(createPostgresPool(postgresPoolOptionsFromEnv(env)));
  const registered = handlers ?? buildJobHandlers(createBackendServices(database, { env }), env);
  const worker = createJobWorker({ queue: new JobQueueRepository(database), handlers: registered, onEvent: event => log({ ...event, workerId: config.workerId }), ...config });
  worker.start();
  log({ type: 'worker.started', workerId: config.workerId, kinds: worker.kinds });
  return {
    worker,
    async stop() {
      const drained = await worker.stop();
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
