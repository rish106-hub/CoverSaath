import { readDataEncryptionConfig } from '../backend/security/column-crypto.js';

function boundedInteger(value, fallback, name, max) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`Invalid ${name}.`);
  return parsed;
}

function positiveAmount(value, name, max = Infinity) {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > max) throw new Error(`Invalid ${name}.`);
  return parsed;
}

const SCAN_MODES = Object.freeze(['disabled', 'clamd']);
const STORAGE_BACKENDS = Object.freeze(['database', 'filesystem']);

// Document intake settings. Storage stays unconfigured (uploads return 503) until a key is set; a
// key that is set but invalid fails at startup. Scanning is disabled by default, which keeps every
// upload quarantined. An unknown scan mode is a startup error rather than a silent downgrade.
function readDocumentConfig(env) {
  const scanMode = env.DOCUMENT_SCAN_MODE ?? 'disabled';
  if (!SCAN_MODES.includes(scanMode)) throw new Error('Invalid DOCUMENT_SCAN_MODE.');
  const clamd = scanMode === 'clamd'
    ? Object.freeze({
      host: (() => {
        const host = String(env.CLAMD_HOST ?? '').trim();
        if (!host || host.includes('/') || host.length > 253) throw new Error('Invalid CLAMD_HOST.');
        return host;
      })(),
      port: boundedInteger(env.CLAMD_PORT, 3310, 'CLAMD_PORT', 65_535),
      timeoutMs: boundedInteger(env.CLAMD_TIMEOUT_MS, 30_000, 'CLAMD_TIMEOUT_MS', 300_000),
    })
    : null;
  // Where encrypted document bytes live (ADR 0013): the database (default) or the server filesystem. Documents stored under
  // the other backend stay readable: reads fall back to the filesystem, and a removal clears both.
  const storageBackend = env.DOCUMENT_STORAGE_BACKEND ?? 'database';
  if (!STORAGE_BACKENDS.includes(storageBackend)) throw new Error('Invalid DOCUMENT_STORAGE_BACKEND.');
  return Object.freeze({
    storageBackend,
    storagePath: env.DOCUMENT_STORAGE_PATH || '.local/documents',
    encryptionKeyBase64: env.DOCUMENT_ENCRYPTION_KEY_BASE64 || null,
    scanMode,
    clamd,
    maxDocumentsPerCase: boundedInteger(env.MAX_DOCUMENTS_PER_CASE, 50, 'MAX_DOCUMENTS_PER_CASE', 1_000),
    maxPendingPerHousehold: boundedInteger(env.MAX_PENDING_DOCUMENTS_PER_HOUSEHOLD, 20, 'MAX_PENDING_DOCUMENTS_PER_HOUSEHOLD', 1_000),
    workerSweepMs: boundedInteger(env.DOCUMENT_WORKER_SWEEP_MS, 30_000, 'DOCUMENT_WORKER_SWEEP_MS', 3_600_000),
  });
}

const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;

// A hosted deployment opts in to its public hostnames (exact match, no wildcards) and to reading the
// client address from Fly's edge header. Both are off by default, so the server stays local-only.
function readNetworkConfig(env) {
  const publicHosts = String(env.PUBLIC_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  if (publicHosts.length > 10 || publicHosts.some(host => !HOSTNAME.test(host))) throw new Error('Invalid PUBLIC_HOSTS.');
  if (env.TRUST_FLY_CLIENT_IP !== undefined && !['true', 'false'].includes(env.TRUST_FLY_CLIENT_IP)) throw new Error('Invalid TRUST_FLY_CLIENT_IP.');
  return Object.freeze({ publicHosts: Object.freeze(publicHosts), trustFlyClientIp: env.TRUST_FLY_CLIENT_IP === 'true' });
}

const BACKENDS = Object.freeze(['memory', 'database']);

// Shared state defaults to the database (ADR 0014 addendum, run B1): the request limit, the model spend cap and the
// evidence-question claim then hold across machines and restarts. 'memory' is an explicit off switch for tests and a
// single local process; it is never the default.
function backend(value, name) {
  const chosen = value ?? 'database';
  if (!BACKENDS.includes(chosen)) throw new Error(`Invalid ${name}.`);
  return chosen;
}

// Activity events (ADR 0014): on by default, metadata plus sealed payloads, kept APP_EVENTS_RETENTION_DAYS (default 30).
function readEventsConfig(env) {
  if (env.APP_EVENTS_ENABLED !== undefined && !['true', 'false'].includes(env.APP_EVENTS_ENABLED)) throw new Error('Invalid APP_EVENTS_ENABLED.');
  return Object.freeze({
    enabled: env.APP_EVENTS_ENABLED !== 'false',
    retentionDays: boundedInteger(env.APP_EVENTS_RETENTION_DAYS, 30, 'APP_EVENTS_RETENTION_DAYS', 3_650),
  });
}

const TOKEN_CHARSET = /^[A-Za-z0-9_-]+$/;
const MAX_IDENTITY_ISSUERS = 10;

// Sign-in identity settings (POST /api/v1/identity-sessions). Both are off until set: no credential means the
// route answers 503 AUTH_NOT_CONFIGURED, and no issuers means every request is refused. Issuers are exact
// strings (no wildcards, no whitespace); the credential must differ from the bootstrap token.
export function readIdentityConfig(env) {
  const credential = env.KNOWVIA_IDENTITY_TOKEN || null;
  if (credential !== null && (credential.length < 32 || credential.length > 256 || !TOKEN_CHARSET.test(credential))) {
    throw new Error('Invalid KNOWVIA_IDENTITY_TOKEN.');
  }
  if (credential !== null && credential === (env.KNOWVIA_BOOTSTRAP_TOKEN || null)) {
    throw new Error('KNOWVIA_IDENTITY_TOKEN must differ from KNOWVIA_BOOTSTRAP_TOKEN.');
  }
  const issuers = String(env.IDENTITY_ISSUERS ?? '').split(',').map(issuer => issuer.trim()).filter(Boolean);
  if (issuers.length > MAX_IDENTITY_ISSUERS
    || issuers.some(issuer => issuer.length > 200 || !/^[\x21-\x7e]+$/.test(issuer))
    || new Set(issuers).size !== issuers.length) {
    throw new Error('Invalid IDENTITY_ISSUERS.');
  }
  return Object.freeze({ issuers: Object.freeze(issuers) });
}

export function readServerConfig(env = process.env) {
  // Validated here so a bad identity setting stops startup; the route reads it through readIdentityConfig.
  readIdentityConfig(env);
  // Fails startup with a coded error when column encryption is required (production) and the key is missing or invalid.
  readDataEncryptionConfig(env);
  return Object.freeze({
    sessionTtlMs: boundedInteger(env.SESSION_TTL_SECONDS, 3600, 'SESSION_TTL_SECONDS', 86_400) * 1000,
    maxSessions: boundedInteger(env.MAX_ACTIVE_SESSIONS, 100, 'MAX_ACTIVE_SESSIONS', 100_000),
    maxCases: boundedInteger(env.MAX_ACTIVE_CASES, 100, 'MAX_ACTIVE_CASES', 100_000),
    maxRunsPerCase: boundedInteger(env.MAX_RUNS_PER_CASE, 10, 'MAX_RUNS_PER_CASE', 100),
    rateLimitPerMinute: boundedInteger(env.API_RATE_LIMIT_PER_MINUTE, 600, 'API_RATE_LIMIT_PER_MINUTE', 100_000),
    // Not read by the server: kept so a bad budget fails at startup rather than on the first live
    // run. live-coverage-runtime.js reads the same variables with its own bounds.
    budgetUsd: positiveAmount(env.ORCHESTRATION_RUN_BUDGET_USD, 'ORCHESTRATION_RUN_BUDGET_USD', 1),
    projectBudgetUsd: positiveAmount(env.ORCHESTRATION_PROJECT_BUDGET_USD, 'ORCHESTRATION_PROJECT_BUDGET_USD'),
    // 'database' (default) shares the request limit, the model spend cap and the evidence claim between machines and
    // across restarts (ADR 0014). 'memory' keeps each per process; use it only in tests or a throwaway local run.
    rateLimitBackend: backend(env.RATE_LIMIT_BACKEND, 'RATE_LIMIT_BACKEND'),
    budgetBackend: backend(env.MODEL_BUDGET_BACKEND, 'MODEL_BUDGET_BACKEND'),
    // Read by the policy-evidence service; validated here so a typo fails startup rather than silently weakening the claim.
    evidenceClaimBackend: backend(env.EVIDENCE_CLAIM_BACKEND, 'EVIDENCE_CLAIM_BACKEND'),
    events: readEventsConfig(env),
    documents: readDocumentConfig(env),
    network: readNetworkConfig(env),
  });
}
