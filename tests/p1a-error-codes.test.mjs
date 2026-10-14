// P1-A: every error code and terminal reason on the analysis-run path is registered,
// and the route status mapping agrees with the registry. Reads source text only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ANALYSIS_ERROR_CODES,
  STABLE_ERROR_CODE_FORMAT,
  assertStableErrorCode,
  isStableErrorCode,
} from '../src/contracts/error-codes.js';

const COVERED_FILES = [
  'src/backend/repositories/workflow-repository.js',
  'src/backend/services/coverage-analysis-port.js',
  'src/backend/services/tenant-access-service.js',
  'src/modules/coverage-analysis/persistent-service.js',
  'src/modules/coverage-analysis/agent-contracts.js',
  'src/modules/coverage-analysis/contracts.js',
  'src/modules/coverage-analysis/workflow-definition.js',
  'src/server/routes/v1-backend-routes.js',
  'src/contracts/task-contracts.js',
  'src/contracts/workflow-graph.js',
  'src/contracts/execution-policy.js',
  'src/contracts/persistence-ports.js',
  'src/contracts/analysis-run-api.js',
];

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

function codesIn(text) {
  const patterns = [
    /\b(?:code|terminal_reason|last_error_code|reasonCode|CODE)\s*(?::|=|===|\?\?)\s*'([A-Z][A-Z0-9_]+)'/g,
    /\bfail\('([A-Z][A-Z0-9_]+)'/g,
    /\bcode\s*=\s*'([A-Z][A-Z0-9_]+)'/g,
    /(?:\?\?|\|\|)\s*'([A-Z][A-Z0-9_]{3,})'/g,
    /\bbadRequest\([^;]*?'([A-Z][A-Z0-9_]+)'\)/g,
    /'(UPSTREAM_[A-Z0-9_]+|LEASE_EXPIRED|ATTEMPT_LIMIT|CONSENT_REVOKED|RELEASE_BLOCKED)'/g,
    /\b[A-Z_]*ERROR_CODE\s*=\s*'([A-Z][A-Z0-9_]+)'/g,
    /\bWORKFLOW_VERSION_MISMATCH\s*=\s*'([A-Z][A-Z0-9_]+)'/g,
  ];
  return new Set(patterns.flatMap(pattern => [...text.matchAll(pattern)].map(match => match[1])));
}

// Privacy-gate and dispatch reason codes are their own family (ADR 0001 scope note).
const OTHER_FAMILIES = new Set(['COMMIT_RECHECK_ERROR', 'DISPATCH_VALIDATION_ERROR', 'DISPATCH_AUDIT_FAILED']);

test('P1-A errors: the scanner recognises each way a code is raised or stored', () => {
  const samples = {
    "throw Object.assign(new Error('x'), { code: 'SAMPLE_ONE' });": 'SAMPLE_ONE',
    "error.code = 'SAMPLE_TWO';": 'SAMPLE_TWO',
    "fail('SAMPLE_THREE', 'message', 404);": 'SAMPLE_THREE',
    "code: outcome.error?.code ?? 'SAMPLE_FOUR',": 'SAMPLE_FOUR',
    "const code = error.code || 'SAMPLE_FIVE';": 'SAMPLE_FIVE',
    "badRequest('A message.', 'SAMPLE_SIX');": 'SAMPLE_SIX',
    "SET terminal_reason = 'SAMPLE_SEVEN'": 'SAMPLE_SEVEN',
  };
  for (const [text, code] of Object.entries(samples)) assert.ok(codesIn(text).has(code), text);
});

test('P1-A errors: every code thrown or stored on the analysis-run path is registered', () => {
  const unregistered = [];
  let found = 0;
  for (const path of COVERED_FILES) {
    for (const code of codesIn(source(path))) {
      found += 1;
      if (OTHER_FAMILIES.has(code)) continue;
      if (!isStableErrorCode(code)) unregistered.push(`${path}: ${code}`);
    }
  }
  assert.ok(found >= 40, `scanner found ${found} codes`);
  assert.deepEqual(unregistered, []);
});

test('P1-A errors: registry entries are well formed and route statuses agree', () => {
  for (const [code, entry] of Object.entries(ANALYSIS_ERROR_CODES)) {
    assert.match(code, STABLE_ERROR_CODE_FORMAT);
    assert.ok(Object.isFrozen(entry), code);
    assert.ok(entry.httpStatus === null || (entry.httpStatus >= 400 && entry.httpStatus < 600), code);
    assert.equal(typeof entry.retryable, 'boolean', code);
  }
  const routes = source('src/server/routes/v1-backend-routes.js');
  const block = routes.slice(routes.indexOf('const statusByCode = {'), routes.indexOf('};', routes.indexOf('const statusByCode = {')));
  const mapped = [...block.matchAll(/([A-Z][A-Z0-9_]+): (\d{3})/g)].map(match => [match[1], Number(match[2])]);
  assert.ok(mapped.length >= 7);
  for (const [code, status] of mapped) assert.equal(ANALYSIS_ERROR_CODES[code]?.httpStatus, status, code);
  // Codes thrown with an explicit statusCode keep that status.
  for (const path of COVERED_FILES) {
    const text = source(path);
    for (const match of text.matchAll(/code: '([A-Z][A-Z0-9_]+)', statusCode: (\d{3})/g)) {
      assert.equal(ANALYSIS_ERROR_CODES[match[1]]?.httpStatus, Number(match[2]), `${path}: ${match[1]}`);
    }
    for (const match of text.matchAll(/fail\('([A-Z][A-Z0-9_]+)', '[^']*', (\d{3})\)/g)) {
      assert.equal(ANALYSIS_ERROR_CODES[match[1]]?.httpStatus, Number(match[2]), `${path}: ${match[1]}`);
    }
  }
});

test('P1-A errors: upstream terminal reasons and unknown codes', () => {
  assert.ok(isStableErrorCode('UPSTREAM_LEASE_EXPIRED'));
  assert.ok(isStableErrorCode('UPSTREAM_WORKFLOW_VERSION_MISMATCH'));
  assert.ok(isStableErrorCode('WORKFLOW_VERSION_MISMATCH'));
  assert.equal(isStableErrorCode('upstream_x'), false);
  assert.equal(isStableErrorCode('MADE_UP_CODE'), false);
  assert.throws(() => assertStableErrorCode('MADE_UP_CODE'), { code: 'AGENT_CONTRACT_INVALID' });
});
