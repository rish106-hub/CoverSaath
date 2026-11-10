import test from 'node:test';
import assert from 'node:assert/strict';
import { structuringFailureCode } from '../src/backend/services/policy-structuring-service.js';
import { errorResponse } from '../src/server/routes/v1-backend-routes.js';

test('model-path failures map to distinct stable codes, never text', () => {
  const cases = [
    [{ code: 'budget_refused' }, 'STRUCTURING_BUDGET_REFUSED'],
    [{ code: 'reservation_limit' }, 'STRUCTURING_BUDGET_REFUSED'],
    [{ code: 'ungated_model_input' }, 'STRUCTURING_PRIVACY_GATE_REFUSED'],
    [{ code: 'MODEL_INPUT_NOT_ALLOWED' }, 'STRUCTURING_PRIVACY_GATE_REFUSED'],
    [{ statusCode: 429, message: 'You exceeded your current quota' }, 'STRUCTURING_PROVIDER_QUOTA'],
    [{ statusCode: 402 }, 'STRUCTURING_PROVIDER_QUOTA'],
    [{ statusCode: 401 }, 'STRUCTURING_PROVIDER_AUTH'],
    [{ statusCode: 403 }, 'STRUCTURING_PROVIDER_AUTH'],
    [{ statusCode: 503 }, 'STRUCTURING_PROVIDER_UNAVAILABLE'],
    [{ name: 'TimeoutError' }, 'STRUCTURING_PROVIDER_UNAVAILABLE'],
    [{ code: 'aborted' }, 'STRUCTURING_PROVIDER_UNAVAILABLE'],
    [{ code: 'usage_unknown' }, 'STRUCTURING_FAILED'],
    [{ message: 'secret detail' }, 'STRUCTURING_FAILED'],
    [{ code: 'CONSENT_REQUIRED' }, 'CONSENT_REQUIRED'],
    [null, 'STRUCTURING_FAILED'],
  ];
  for (const [error, expected] of cases) assert.equal(structuringFailureCode(error), expected);
});

test('restart-required response carries only a pattern-valid priorErrorCode', () => {
  const raise = priorErrorCode => Object.assign(new Error('The previous attempt is failed.'), { code: 'STRUCTURING_RESTART_REQUIRED', statusCode: 409, priorStatus: 'failed', priorErrorCode });
  const ok = errorResponse(raise('STRUCTURING_PROVIDER_QUOTA'));
  assert.deepEqual([ok.status, ok.body.error.code, ok.body.error.priorErrorCode], [409, 'STRUCTURING_RESTART_REQUIRED', 'STRUCTURING_PROVIDER_QUOTA']);
  for (const bad of [null, undefined, 'quota exceeded for key AIza123', 'lower_case', 'X'.repeat(80)]) {
    assert.equal('priorErrorCode' in errorResponse(raise(bad)).body.error, false);
  }
  assert.equal('priorErrorCode' in errorResponse(Object.assign(new Error('x'), { code: 'OTHER_ERROR', priorErrorCode: 'STRUCTURING_FAILED' })).body.error, false);
});
