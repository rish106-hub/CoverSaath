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
    documents: {
      storagePath: '.local/documents',
      encryptionKeyBase64: null,
      scanMode: 'disabled',
      clamd: null,
      maxDocumentsPerCase: 50,
      maxPendingPerHousehold: 20,
      workerSweepMs: 30_000,
    },
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
