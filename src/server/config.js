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
  return Object.freeze({
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

export function readServerConfig(env = process.env) {
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
    documents: readDocumentConfig(env),
    network: readNetworkConfig(env),
  });
}
