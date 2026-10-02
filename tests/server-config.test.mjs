import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server/server.js';
import { readServerConfig } from '../src/server/config.js';

test('server configuration has explicit bounded defaults', () => {
  assert.deepEqual(readServerConfig({}), {
    sessionTtlMs: 3_600_000,
    maxSessions: 100,
    maxCases: 100,
    maxRunsPerCase: 10,
    rateLimitPerMinute: 600,
    enableLegacyDemoApi: false,
    budgetUsd: undefined,
    projectBudgetUsd: undefined,
  });
});

test('server capacity and rate settings are bounded before listening', () => {
  for (const [name, value] of [
    ['API_RATE_LIMIT_PER_MINUTE', '0'],
    ['SESSION_TTL_SECONDS', '86401'],
    ['MAX_ACTIVE_SESSIONS', 'no'],
    ['MAX_ACTIVE_CASES', '-1'],
    ['MAX_RUNS_PER_CASE', '101'],
    ['ENABLE_LEGACY_DEMO_API', 'yes'],
  ]) {
    assert.throws(() => createApiServer({ env: { [name]: value } }), new RegExp(`Invalid ${name}`));
  }
});
