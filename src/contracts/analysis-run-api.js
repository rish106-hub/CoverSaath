import { assertExactKeys, contractError } from './task-contracts.js';
import { IDEMPOTENCY_KEY_LENGTH, PERSISTED_RUN_STATES, PERSISTED_TASK_STATES } from './execution-policy.js';

// Request and response schemas of the EXISTING analysis-run routes in
// src/server/routes/v1-backend-routes.js. No new endpoints. The validators describe what the
// routes accept and return today; they are not wired into the routes (central-owner decision).
//
//   POST /api/v1/cases/:caseId/analysis-runs   -> 202 (created) | 200 (idempotent replay)
//   GET  /api/v1/jobs/:jobId                   -> 200 job
//   GET  /api/v1/tasks/:taskId                 -> 200 task summary
//
// ADR: docs/adr/0001-workflow-v6-contracts.md

export const ANALYSIS_RUN_API_VERSION = 'v1';
export const API_CONTRACT_ERROR_CODE = 'API_CONTRACT_INVALID';

export const ANALYSIS_RUN_ROUTES = Object.freeze({
  createRun: Object.freeze({ method: 'POST', path: '/api/v1/cases/:caseId/analysis-runs', createdStatus: 202, replayStatus: 200 }),
  getJob: Object.freeze({ method: 'GET', path: '/api/v1/jobs/:jobId', status: 200 }),
  getTask: Object.freeze({ method: 'GET', path: '/api/v1/tasks/:taskId', status: 200 }),
});

export const EXECUTION_MODES = Object.freeze(['fixture', 'live']);
export const FIXTURE_VARIANTS = Object.freeze(['standard', 'blocked_source']);
export const DISPATCH_STATUSES = Object.freeze(['fixture_completed', 'live_completed', 'idempotent_existing_run']);

/** Body fields the create route reads. The route ignores other fields today; this contract rejects them. */
export const CREATE_ANALYSIS_RUN_BODY_FIELDS = Object.freeze(['consentGrantId', 'executionMode', 'modelPermission', 'fixtureVariant']);

export const ANALYSIS_JOB_KEYS = Object.freeze([
  'id', 'caseId', 'workflowName', 'workflowVersion', 'executionMode', 'status', 'terminalReason',
  'createdAt', 'startedAt', 'finishedAt', 'tasks', 'dag', 'modelUsage',
]);
export const CREATE_ANALYSIS_RUN_RESPONSE_KEYS = Object.freeze([...ANALYSIS_JOB_KEYS, 'dispatchStatus', 'externalProviderCalls']);
export const ANALYSIS_TASK_SUMMARY_KEYS = Object.freeze([
  'id', 'jobId', 'parentTaskId', 'agentName', 'taskKind', 'status', 'attemptCount', 'terminalReason',
  'resultSummary', 'createdAt', 'startedAt', 'finishedAt',
]);
export const ANALYSIS_DAG_ENTRY_KEYS = Object.freeze([
  'key', 'agentName', 'taskKind', 'owner', 'modelTask', 'inputSchema', 'outputSchema', 'dependsOn',
]);
export const MODEL_USAGE_KEYS = Object.freeze([
  'providers', 'models', 'inputTokens', 'outputTokens', 'totalTokens', 'calls', 'latencyMs', 'costUsd',
]);
export const API_ERROR_KEYS = Object.freeze(['code', 'message']);

const fail = message => { throw contractError(message, API_CONTRACT_ERROR_CODE); };
const isString = value => typeof value === 'string';
const isNullableString = value => value === null || typeof value === 'string';
const isNonNegativeInteger = value => Number.isInteger(value) && value >= 0;

export function validateCreateAnalysisRunRequest({ caseId, headers = {}, body } = {}) {
  if (!isString(caseId) || caseId.length === 0 || caseId.includes('/')) fail('caseId path parameter is invalid.');
  const key = headers['idempotency-key'];
  if (!isString(key) || key.length < IDEMPOTENCY_KEY_LENGTH.min || key.length > IDEMPOTENCY_KEY_LENGTH.max) fail('Idempotency-Key header must be 8 to 200 characters.');
  assertExactKeys(body, CREATE_ANALYSIS_RUN_BODY_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(body ?? {}, field)), 'Create analysis run body', API_CONTRACT_ERROR_CODE);
  if (!isString(body.consentGrantId) || !body.consentGrantId.trim() || body.consentGrantId.length > 200) fail('consentGrantId is required (1 to 200 characters).');
  const executionMode = body.executionMode ?? 'fixture';
  if (!EXECUTION_MODES.includes(executionMode)) fail('executionMode must be fixture or live.');
  if (body.modelPermission !== undefined && typeof body.modelPermission !== 'boolean') fail('modelPermission must be a boolean.');
  if (executionMode === 'live' && body.modelPermission !== true) fail('Live analysis requires modelPermission=true.');
  const fixtureVariant = body.fixtureVariant ?? 'standard';
  if (!FIXTURE_VARIANTS.includes(fixtureVariant)) fail('fixtureVariant is not supported.');
  return Object.freeze({ caseId, idempotencyKey: key, consentGrantId: body.consentGrantId.trim(), executionMode, modelPermission: body.modelPermission === true, fixtureVariant });
}

function validateModelUsage(usage) {
  assertExactKeys(usage, MODEL_USAGE_KEYS, 'Model usage', API_CONTRACT_ERROR_CODE);
  if (!Array.isArray(usage.providers) || !Array.isArray(usage.models)) fail('Model usage providers and models must be arrays.');
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'calls', 'latencyMs']) if (!isNonNegativeInteger(usage[key])) fail(`Model usage ${key} must be a non-negative integer.`);
  if (!Number.isFinite(usage.costUsd) || usage.costUsd < 0) fail('Model usage costUsd must be a non-negative number.');
}

function validateDagEntry(entry) {
  assertExactKeys(entry, ANALYSIS_DAG_ENTRY_KEYS, 'Analysis DAG entry', API_CONTRACT_ERROR_CODE);
  for (const key of ['key', 'agentName', 'taskKind', 'owner', 'inputSchema', 'outputSchema']) if (!isString(entry[key])) fail(`Analysis DAG entry ${key} must be a string.`);
  if (!isNullableString(entry.modelTask)) fail('Analysis DAG entry modelTask must be a string or null.');
  if (!Array.isArray(entry.dependsOn) || !entry.dependsOn.every(isString)) fail('Analysis DAG entry dependsOn must be an array of keys.');
}

export function validateAnalysisTaskSummary(task) {
  assertExactKeys(task, ANALYSIS_TASK_SUMMARY_KEYS, 'Analysis task summary', API_CONTRACT_ERROR_CODE);
  for (const key of ['id', 'jobId', 'agentName', 'taskKind', 'createdAt']) if (!isString(task[key])) fail(`Analysis task ${key} must be a string.`);
  if (!PERSISTED_TASK_STATES.includes(task.status)) fail('Analysis task status is invalid.');
  if (!isNonNegativeInteger(task.attemptCount)) fail('Analysis task attemptCount must be a non-negative integer.');
  for (const key of ['parentTaskId', 'terminalReason', 'startedAt', 'finishedAt']) if (!isNullableString(task[key])) fail(`Analysis task ${key} must be a string or null.`);
  if (task.resultSummary !== null && (typeof task.resultSummary !== 'object' || Array.isArray(task.resultSummary))) fail('Analysis task resultSummary must be an object or null.');
  return task;
}

export function validateAnalysisJob(job, { keys = ANALYSIS_JOB_KEYS } = {}) {
  assertExactKeys(job, keys, 'Analysis job', API_CONTRACT_ERROR_CODE);
  for (const key of ['id', 'caseId', 'workflowName', 'workflowVersion', 'executionMode', 'createdAt']) if (!isString(job[key])) fail(`Analysis job ${key} must be a string.`);
  if (!PERSISTED_RUN_STATES.includes(job.status)) fail('Analysis job status is invalid.');
  for (const key of ['terminalReason', 'startedAt', 'finishedAt']) if (!isNullableString(job[key])) fail(`Analysis job ${key} must be a string or null.`);
  if (!Array.isArray(job.tasks)) fail('Analysis job tasks must be an array.');
  job.tasks.forEach(validateAnalysisTaskSummary);
  if (!Array.isArray(job.dag)) fail('Analysis job dag must be an array.');
  job.dag.forEach(validateDagEntry);
  validateModelUsage(job.modelUsage);
  return job;
}

export function validateCreateAnalysisRunResponse(response) {
  validateAnalysisJob(response, { keys: CREATE_ANALYSIS_RUN_RESPONSE_KEYS });
  if (!DISPATCH_STATUSES.includes(response.dispatchStatus)) fail('dispatchStatus is invalid.');
  if (typeof response.externalProviderCalls !== 'boolean') fail('externalProviderCalls must be a boolean.');
  return response;
}

/**
 * Error bodies. The /api/v1 route mapper returns { error: { code, message } }, including for
 * errors raised asynchronously by the analysis service (ADR 0001, finding F-API-1, fixed).
 * The { error: <string> } shape is still produced by the server's top-level publicError
 * handler for failures outside the route mapper, so both shapes are accepted here.
 */
export function validateApiErrorBody(body) {
  if (body && typeof body === 'object' && !Array.isArray(body) && Object.keys(body).length === 1 && isString(body.error)) {
    return { shape: 'legacy_message', code: null, message: body.error };
  }
  assertExactKeys(body, ['error'], 'API error body', API_CONTRACT_ERROR_CODE);
  assertExactKeys(body.error, API_ERROR_KEYS, 'API error', API_CONTRACT_ERROR_CODE);
  if (!isString(body.error.code) || !/^[A-Z][A-Z0-9_]*$/.test(body.error.code) || !isString(body.error.message)) fail('API error code and message are required.');
  return { shape: 'coded', code: body.error.code, message: body.error.message };
}
