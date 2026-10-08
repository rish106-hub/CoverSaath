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

function booleanFlag(value, fallback, name) {
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Invalid ${name}.`);
}

export function readServerConfig(env = process.env) {
  return Object.freeze({
    sessionTtlMs: boundedInteger(env.SESSION_TTL_SECONDS, 3600, 'SESSION_TTL_SECONDS', 86_400) * 1000,
    maxSessions: boundedInteger(env.MAX_ACTIVE_SESSIONS, 100, 'MAX_ACTIVE_SESSIONS', 100_000),
    maxCases: boundedInteger(env.MAX_ACTIVE_CASES, 100, 'MAX_ACTIVE_CASES', 100_000),
    maxRunsPerCase: boundedInteger(env.MAX_RUNS_PER_CASE, 10, 'MAX_RUNS_PER_CASE', 100),
    rateLimitPerMinute: boundedInteger(env.API_RATE_LIMIT_PER_MINUTE, 600, 'API_RATE_LIMIT_PER_MINUTE', 100_000),
    enableLegacyDemoApi: booleanFlag(env.ENABLE_LEGACY_DEMO_API, false, 'ENABLE_LEGACY_DEMO_API'),
    budgetUsd: positiveAmount(env.ORCHESTRATION_RUN_BUDGET_USD, 'ORCHESTRATION_RUN_BUDGET_USD', 1),
    projectBudgetUsd: positiveAmount(env.ORCHESTRATION_PROJECT_BUDGET_USD, 'ORCHESTRATION_PROJECT_BUDGET_USD'),
  });
}

function csv(value) {
  return String(value ?? '').split(',').map(part => part.trim()).filter(Boolean);
}

// PostHog ingestion hosts are fixed per region; the proxy never derives an upstream from the request.
export const POSTHOG_UPSTREAMS = Object.freeze({
  eu: Object.freeze({ api: 'https://eu.i.posthog.com', assets: 'https://eu-assets.i.posthog.com' }),
  us: Object.freeze({ api: 'https://us.i.posthog.com', assets: 'https://us-assets.i.posthog.com' }),
});

/** Listen address, deployed hosts/origins, proxy trust, static build and the analytics proxy. */
export function readHttpConfig(env = process.env) {
  const allowedHosts = csv(env.ALLOWED_HOSTS).map(host => host.toLowerCase());
  for (const host of allowedHosts) if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) throw new Error('Invalid ALLOWED_HOSTS.');
  const allowedOrigins = csv(env.ALLOWED_ORIGINS);
  for (const origin of allowedOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error('Invalid ALLOWED_ORIGINS.'); }
    if (parsed.origin !== origin || !['https:', 'http:'].includes(parsed.protocol)) throw new Error('Invalid ALLOWED_ORIGINS.');
  }
  const trustProxyHops = env.TRUST_PROXY_HOPS === undefined || env.TRUST_PROXY_HOPS === '0' ? 0 : boundedInteger(env.TRUST_PROXY_HOPS, 0, 'TRUST_PROXY_HOPS', 5);
  const posthogRegion = env.POSTHOG_REGION || null;
  if (posthogRegion && !POSTHOG_UPSTREAMS[posthogRegion]) throw new Error('Invalid POSTHOG_REGION.');
  // Test-only override so E2E never reaches PostHog: loopback upstreams only, and never in production.
  let posthogUpstream = posthogRegion ? POSTHOG_UPSTREAMS[posthogRegion] : null;
  if (env.POSTHOG_TEST_UPSTREAM) {
    const parsed = new URL(env.POSTHOG_TEST_UPSTREAM);
    if (env.NODE_ENV === 'production' || parsed.hostname !== '127.0.0.1') throw new Error('Invalid POSTHOG_TEST_UPSTREAM.');
    posthogUpstream = Object.freeze({ api: parsed.origin, assets: parsed.origin });
  }
  const host = env.HOST || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && !allowedHosts.length) throw new Error('ALLOWED_HOSTS is required when HOST is not loopback.');
  return Object.freeze({
    host,
    port: env.PORT === undefined ? 8787 : boundedInteger(env.PORT, 8787, 'PORT', 65_535),
    allowedHosts: Object.freeze(allowedHosts),
    allowedOrigins: Object.freeze(allowedOrigins),
    trustProxyHops,
    staticDir: env.STATIC_DIR || null,
    posthogUpstream,
    shutdownGraceMs: boundedInteger(env.SHUTDOWN_GRACE_MS, 8_000, 'SHUTDOWN_GRACE_MS', 60_000),
  });
}
