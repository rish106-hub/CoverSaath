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
