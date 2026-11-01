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
    budgetUsd: undefined,
    projectBudgetUsd: undefined,
    rateLimitBackend: 'memory',
    budgetBackend: 'memory',
    events: { enabled: true, retentionDays: 30 },
    documents: {
      storagePath: '.local/documents',
      encryptionKeyBase64: null,
      scanMode: 'disabled',
      clamd: null,
      maxDocumentsPerCase: 50,
      maxPendingPerHousehold: 20,
      workerSweepMs: 30_000,
    },
    network: { publicHosts: [], trustFlyClientIp: false },
  });
});

test('server capacity and rate settings are bounded before listening', () => {
  for (const [name, value] of [
    ['API_RATE_LIMIT_PER_MINUTE', '0'],
    ['SESSION_TTL_SECONDS', '86401'],
    ['MAX_ACTIVE_SESSIONS', 'no'],
    ['MAX_ACTIVE_CASES', '-1'],
    ['MAX_RUNS_PER_CASE', '101'],
    ['ORCHESTRATION_RUN_BUDGET_USD', 'NaN'],
    ['ORCHESTRATION_PROJECT_BUDGET_USD', '0'],
    ['DOCUMENT_SCAN_MODE', 'structural_only'],
    ['MAX_DOCUMENTS_PER_CASE', '0'],
    ['MAX_PENDING_DOCUMENTS_PER_HOUSEHOLD', '1001'],
    ['DOCUMENT_WORKER_SWEEP_MS', '0'],
  ]) {
    assert.throws(() => createApiServer({ env: { [name]: value } }), new RegExp(`Invalid ${name}`));
  }
});

test('network settings are off by default and validated when set', () => {
  assert.deepEqual(readServerConfig({}).network, { publicHosts: [], trustFlyClientIp: false });
  const hosted = readServerConfig({ PUBLIC_HOSTS: 'Knowvia-API.fly.dev, api.example.com:443', TRUST_FLY_CLIENT_IP: 'true' }).network;
  assert.deepEqual(hosted.publicHosts, ['knowvia-api.fly.dev', 'api.example.com:443']);
  assert.equal(hosted.trustFlyClientIp, true);
  for (const bad of ['*.fly.dev', 'host/path', 'http://x.dev', 'a b']) assert.throws(() => readServerConfig({ PUBLIC_HOSTS: bad }), /PUBLIC_HOSTS/);
  assert.throws(() => readServerConfig({ TRUST_FLY_CLIENT_IP: 'yes' }), /TRUST_FLY_CLIENT_IP/);
});

test('activity-event, rate-limit and budget backends are validated', () => {
  assert.deepEqual(readServerConfig({ APP_EVENTS_ENABLED: 'false', APP_EVENTS_RETENTION_DAYS: '7', RATE_LIMIT_BACKEND: 'database', MODEL_BUDGET_BACKEND: 'database' })
    .events, { enabled: false, retentionDays: 7 });
  for (const [name, value] of [['APP_EVENTS_ENABLED', 'yes'], ['APP_EVENTS_RETENTION_DAYS', '0'], ['APP_EVENTS_RETENTION_DAYS', '99999'], ['RATE_LIMIT_BACKEND', 'redis'], ['MODEL_BUDGET_BACKEND', 'file']]) {
    assert.throws(() => readServerConfig({ [name]: value }), new RegExp(`Invalid ${name}`));
  }
});
