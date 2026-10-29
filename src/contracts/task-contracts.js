// Frozen shapes of the three task contracts shared by every workflow runtime
// (fixture and persistent PostgreSQL). Pure: no I/O,
// no imports. Validators reject unknown and missing fields; deeper semantic rules
// (owners, model tasks, payload schemas) live with the workflow that owns them.
//
// ADR: docs/adr/0001-workflow-v6-contracts.md

export const TASK_CONTRACTS_VERSION = 'knowvia-task-contracts-v1';

export const CONTRACT_ERROR_CODE = 'AGENT_CONTRACT_INVALID';

export const TASK_OWNERS = Object.freeze(['deterministic', 'model_assist']);

/** @typedef {{ maxAttempts: number, leaseDurationMs: number, retryOn: readonly string[], retryDelayMs: number, thrownErrorIsTerminal: boolean }} TaskRetryPolicy */
export const TASK_RETRY_POLICY_KEYS = Object.freeze([
  'maxAttempts', 'leaseDurationMs', 'retryOn', 'retryDelayMs', 'thrownErrorIsTerminal',
]);

/**
 * @typedef {object} TaskDefinition
 * @property {string} key            Stable task key, unique in the workflow.
 * @property {string} kind           Task kind persisted as workflow_tasks.task_kind.
 * @property {'deterministic'|'model_assist'} owner
 * @property {string|null} modelTask Model task name, or null for deterministic tasks.
 * @property {readonly string[]} dependsOn Keys of upstream tasks.
 * @property {string} inputSchema    Input schema id.
 * @property {string} outputSchema   Output schema id.
 * @property {TaskRetryPolicy} retryPolicy
 */
export const TASK_DEFINITION_KEYS = Object.freeze([
  'key', 'kind', 'owner', 'modelTask', 'dependsOn', 'inputSchema', 'outputSchema', 'retryPolicy',
]);

/**
 * @typedef {object} TaskInvocation
 * @property {object} input    Root run input (persisted run input_json).
 * @property {object} upstream Unwrapped payloads keyed by dependency key; exactly the task's dependsOn.
 * @property {object} run      The run the task belongs to; its workflow version must be executable.
 */
export const TASK_INVOCATION_KEYS = Object.freeze(['input', 'upstream', 'run']);

/**
 * @typedef {object} TaskResultEnvelope
 * @property {string} contractVersion
 * @property {string} taskKey
 * @property {string} taskKind
 * @property {{ input: string, output: string }} schemas
 * @property {{ owner: string, modelTask: string|null, execution: object|null }} producer
 * @property {{ runId: string, caseId: string, workflowName: string, workflowVersion: string, inputDigest: string, sourceRefs: object[] }} provenance
 * @property {string} evidenceState
 * @property {unknown} payload
 */
export const TASK_RESULT_ENVELOPE_KEYS = Object.freeze([
  'contractVersion', 'taskKey', 'taskKind', 'schemas', 'producer', 'provenance', 'evidenceState', 'payload',
]);
export const TASK_RESULT_SCHEMAS_KEYS = Object.freeze(['input', 'output']);
export const TASK_RESULT_PRODUCER_KEYS = Object.freeze(['owner', 'modelTask', 'execution']);
export const TASK_RESULT_PROVENANCE_KEYS = Object.freeze([
  'runId', 'caseId', 'workflowName', 'workflowVersion', 'inputDigest', 'sourceRefs',
]);

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function contractError(message, code = CONTRACT_ERROR_CODE) {
  return Object.assign(new TypeError(message), { code });
}

/**
 * Throws unless `value` is a plain object whose own keys are exactly `keys`
 * (no unknown field, no missing field).
 */
export function assertExactKeys(value, keys, label, code = CONTRACT_ERROR_CODE) {
  if (!isPlainObject(value)) throw contractError(`${label} must be an object.`, code);
  const unknown = Object.keys(value).filter(key => !keys.includes(key));
  if (unknown.length > 0) throw contractError(`${label} has unknown field(s): ${unknown.sort().join(', ')}.`, code);
  const missing = keys.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) throw contractError(`${label} is missing field(s): ${missing.join(', ')}.`, code);
  return value;
}

const isNonEmptyString = value => typeof value === 'string' && value.length > 0;

/** Shape-only validation of a TaskDefinition (exact keys and field types). */
export function validateTaskDefinitionShape(definition) {
  assertExactKeys(definition, TASK_DEFINITION_KEYS, 'Task definition');
  const label = `Task definition ${typeof definition.key === 'string' ? definition.key : '(invalid key)'}`;
  if (!isNonEmptyString(definition.key) || !/^[a-z][A-Za-z0-9]*$/.test(definition.key)) throw contractError(`${label} key is invalid.`);
  if (!isNonEmptyString(definition.kind) || !/^[a-z][a-z0-9_]*$/.test(definition.kind)) throw contractError(`${label} kind is invalid.`);
  if (!TASK_OWNERS.includes(definition.owner)) throw contractError(`${label} owner is invalid.`);
  if (definition.modelTask !== null && !isNonEmptyString(definition.modelTask)) throw contractError(`${label} modelTask must be a string or null.`);
  if (!Array.isArray(definition.dependsOn) || definition.dependsOn.some(item => !isNonEmptyString(item))) throw contractError(`${label} dependsOn must be an array of task keys.`);
  if (!isNonEmptyString(definition.inputSchema) || !isNonEmptyString(definition.outputSchema)) throw contractError(`${label} schema ids are required.`);
  validateRetryPolicyShape(definition.retryPolicy, label);
  return definition;
}

export function validateRetryPolicyShape(policy, label = 'Task') {
  assertExactKeys(policy, TASK_RETRY_POLICY_KEYS, `${label} retry policy`);
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) throw contractError(`${label} retry policy maxAttempts is invalid.`);
  if (!Number.isInteger(policy.leaseDurationMs) || policy.leaseDurationMs < 1) throw contractError(`${label} retry policy leaseDurationMs is invalid.`);
  if (!Array.isArray(policy.retryOn) || policy.retryOn.some(code => !/^[A-Z][A-Z0-9_]*$/.test(code))) throw contractError(`${label} retry policy retryOn is invalid.`);
  if (!Number.isInteger(policy.retryDelayMs) || policy.retryDelayMs < 0) throw contractError(`${label} retry policy retryDelayMs is invalid.`);
  if (typeof policy.thrownErrorIsTerminal !== 'boolean') throw contractError(`${label} retry policy thrownErrorIsTerminal is invalid.`);
  return policy;
}

/** Shape-only validation of a TaskInvocation context (exact keys, object fields). */
export function validateTaskInvocationShape(invocation, label = 'Task invocation') {
  assertExactKeys(invocation, TASK_INVOCATION_KEYS, label);
  for (const key of TASK_INVOCATION_KEYS) {
    if (!isPlainObject(invocation[key])) throw contractError(`${label} ${key} must be an object.`);
  }
  return invocation;
}

/** Shape-only validation of a TaskResultEnvelope (exact keys at every fixed level). */
export function validateTaskResultEnvelopeShape(envelope, label = 'Task result envelope') {
  assertExactKeys(envelope, TASK_RESULT_ENVELOPE_KEYS, label);
  assertExactKeys(envelope.schemas, TASK_RESULT_SCHEMAS_KEYS, `${label} schemas`);
  assertExactKeys(envelope.producer, TASK_RESULT_PRODUCER_KEYS, `${label} producer`);
  assertExactKeys(envelope.provenance, TASK_RESULT_PROVENANCE_KEYS, `${label} provenance`);
  if (envelope.producer.execution !== null && !isPlainObject(envelope.producer.execution)) throw contractError(`${label} producer execution must be an object or null.`);
  if (!Array.isArray(envelope.provenance.sourceRefs)) throw contractError(`${label} source references must be an array.`);
  return envelope;
}
