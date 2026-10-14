// P1-A: workflow v6, graph checksum, DAG rules and the three frozen task contracts.
// Synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_ANALYSIS_WORKFLOW,
  validateCoverageWorkflowDefinition,
} from '../src/modules/coverage-analysis/workflow-definition.js';
import {
  assertExecutableWorkflowVersion,
} from '../src/modules/coverage-analysis/contracts.js';
import {
  createTaskOutputEnvelope,
  unwrapDependencyOutputs,
  validateTaskInvocation,
  validateTaskOutputEnvelope,
} from '../src/modules/coverage-analysis/agent-contracts.js';
import { createCoverageAnalysisRuntime, createPersistentCoverageAnalysisService } from '../src/modules/coverage-analysis/index.js';
import {
  TASK_DEFINITION_KEYS,
  TASK_INVOCATION_KEYS,
  TASK_RESULT_ENVELOPE_KEYS,
  validateTaskDefinitionShape,
} from '../src/contracts/task-contracts.js';
import {
  WORKFLOW_GRAPH_CHECKSUM_FIELDS,
  validateWorkflowGraph,
  workflowGraphChecksum,
} from '../src/contracts/workflow-graph.js';
import { TASK_RETRY_POLICY } from '../src/contracts/execution-policy.js';

// Pinned. Changing any task key, kind, owner, model task, dependency or schema id changes it,
// and must come with a new workflow version and ADR 0001 update.
const PINNED_V6_GRAPH_CHECKSUM = '39384121ec4e1002c1dc9820ffd0ee49143fecf8566307b1e2c421812e0e9fa1';

const copyTasks = () => COVERAGE_ANALYSIS_WORKFLOW.tasks.map(task => ({ ...task, dependsOn: [...task.dependsOn] }));
const workflowWith = tasks => ({ name: COVERAGE_ANALYSIS_WORKFLOW.name, version: COVERAGE_ANALYSIS_WORKFLOW.version, tasks });
const mutate = (key, change) => copyTasks().map(task => (task.key === key ? { ...task, ...change } : task));
const graphCode = { code: 'WORKFLOW_GRAPH_INVALID' };
const contractCode = { code: 'AGENT_CONTRACT_INVALID' };
const versionCode = { code: 'WORKFLOW_VERSION_MISMATCH' };

test('P1-A: the coverage-analysis workflow is version 6 with a pinned graph checksum', () => {
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.name, 'coverage-analysis');
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.version, '6');
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.tasks.length, 22);
  assert.match(COVERAGE_ANALYSIS_WORKFLOW.graphChecksum, /^[0-9a-f]{64}$/);
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.graphChecksum, PINNED_V6_GRAPH_CHECKSUM);
  assert.equal(workflowGraphChecksum(COVERAGE_ANALYSIS_WORKFLOW), PINNED_V6_GRAPH_CHECKSUM);
  assert.ok(Object.isFrozen(COVERAGE_ANALYSIS_WORKFLOW) && Object.isFrozen(COVERAGE_ANALYSIS_WORKFLOW.tasks));
  assert.ok(COVERAGE_ANALYSIS_WORKFLOW.tasks.every(task => Object.isFrozen(task) && Object.isFrozen(task.dependsOn)));
});

test('P1-A: graph checksum is stable for the same graph and changes with any covered field', () => {
  const base = workflowGraphChecksum(workflowWith(copyTasks()));
  assert.equal(base, PINNED_V6_GRAPH_CHECKSUM);
  assert.equal(workflowGraphChecksum(workflowWith(copyTasks())), base, 'same input, same digest');
  // Reordering object keys and dependency lists does not change the canonical graph.
  const reordered = copyTasks().map(task => Object.fromEntries(Object.entries({ ...task, dependsOn: [...task.dependsOn].reverse() }).reverse()));
  assert.equal(workflowGraphChecksum(workflowWith(reordered)), base);
  assert.deepEqual(WORKFLOW_GRAPH_CHECKSUM_FIELDS, ['key', 'kind', 'owner', 'modelTask', 'dependsOn', 'inputSchema', 'outputSchema']);
  const changes = [
    ['kind', mutate('decision', { kind: 'deterministic_classification_v2' })],
    ['owner', mutate('decision', { owner: 'model_assist', modelTask: 'evidence_synthesis' })],
    ['modelTask', mutate('primary', { modelTask: 'question_drafting' })],
    ['dependsOn', mutate('privacy', { dependsOn: ['coverage'] })],
    ['inputSchema', mutate('release', { inputSchema: 'knowvia/coverage-analysis/release/input/v2' })],
    ['outputSchema', mutate('release', { outputSchema: 'knowvia/coverage-analysis/release/output/v2' })],
    ['task removed', copyTasks().filter(task => task.key !== 'safety').map(task => ({ ...task, dependsOn: task.dependsOn.filter(key => key !== 'safety') }))],
  ];
  const seen = new Set([base]);
  for (const [label, tasks] of changes) {
    const checksum = workflowGraphChecksum(workflowWith(tasks));
    assert.notEqual(checksum, base, label);
    assert.ok(!seen.has(checksum), `${label} collides with another change`);
    seen.add(checksum);
  }
  const renamed = { name: 'coverage-analysis-other', tasks: copyTasks() };
  assert.notEqual(workflowGraphChecksum(renamed), base, 'workflow name');
});

test('P1-A: DAG validation rejects cycles', () => {
  assert.throws(() => validateWorkflowGraph([
    { key: 'a', dependsOn: ['c'] }, { key: 'b', dependsOn: ['a'] }, { key: 'c', dependsOn: ['b'] },
  ]), { ...graphCode, message: /cycle through: a, b, c/ });
  const cyclic = mutate('coverage', { dependsOn: ['profile', 'group', 'personal', 'release'] });
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(cyclic)), { ...graphCode, message: /cycle/ });
  assert.throws(() => workflowGraphChecksum(workflowWith(cyclic)), graphCode);
  assert.throws(() => validateWorkflowGraph([{ key: 'a', dependsOn: ['a'] }]), { ...graphCode, message: /cannot depend on itself/ });
});

test('P1-A: DAG validation rejects missing, duplicate and late dependencies', () => {
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('release', { dependsOn: ['primary', 'auditTrail'] }))), { ...graphCode, message: /undefined task: auditTrail/ });
  assert.throws(() => validateWorkflowGraph([{ key: 'a', dependsOn: [] }, { key: 'a', dependsOn: [] }]), { ...graphCode, message: /Duplicate/ });
  assert.throws(() => validateWorkflowGraph([{ key: 'a', dependsOn: [] }, { key: 'b', dependsOn: ['a', 'a'] }]), { ...graphCode, message: /twice/ });
  // Persistence inserts tasks in declaration order, so a dependency must be declared first.
  const tasks = copyTasks();
  const late = [tasks.at(-1), ...tasks.slice(0, -1)];
  assert.throws(() => validateWorkflowGraph(late), { ...graphCode, message: /declared before its dependency/ });
  assert.throws(() => validateWorkflowGraph([]), graphCode);
  assert.deepEqual(validateWorkflowGraph(COVERAGE_ANALYSIS_WORKFLOW.tasks), COVERAGE_ANALYSIS_WORKFLOW.tasks.map(task => task.key));
});

test('P1-A: every workflow task has an owner, schemas, dependencies and a retry policy (100%)', () => {
  const tasks = COVERAGE_ANALYSIS_WORKFLOW.tasks;
  const complete = tasks.filter(task => ['deterministic', 'model_assist'].includes(task.owner)
    && /\/input\/v1$/.test(task.inputSchema) && /\/output\/v1$/.test(task.outputSchema)
    && Array.isArray(task.dependsOn)
    && task.retryPolicy === TASK_RETRY_POLICY);
  assert.equal(complete.length / tasks.length, 1);
  for (const task of tasks) {
    assert.deepEqual(Object.keys(task).sort(), [...TASK_DEFINITION_KEYS].sort(), task.key);
    assert.doesNotThrow(() => validateTaskDefinitionShape(task), task.key);
  }
  assert.doesNotThrow(() => validateCoverageWorkflowDefinition(COVERAGE_ANALYSIS_WORKFLOW));
});

test('P1-A: a deterministic task cannot be assigned a model, and protected kinds stay deterministic', () => {
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('release', { modelTask: 'evidence_synthesis' }))), { ...contractCode, message: /deterministic and cannot be assigned a model task/ });
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('decision', { modelTask: 'policy_arithmetic' }))), contractCode);
  // Re-owning a protected kind as model-assisted is refused even with a valid AI task.
  for (const key of ['coverage', 'decision', 'evidence', 'privacy', 'safety', 'release']) {
    assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate(key, { owner: 'model_assist', modelTask: 'evidence_synthesis' }))), contractCode, key);
  }
  // A model-assisted task may only name an AI task from the responsibility matrix.
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('primary', { modelTask: 'deterministic_release_gate' }))), contractCode);
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('primary', { modelTask: 'free_form_agent' }))), contractCode);
  // A non-protected deterministic kind cannot quietly become model-assisted either: the
  // responsibility matrix pins every task's owner.
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('benefits', { owner: 'model_assist', modelTask: 'evidence_synthesis' }))), { ...contractCode, message: /responsibility matrix/ });
});

test('P1-A: TaskDefinition rejects unknown and missing fields', () => {
  const [first] = copyTasks();
  assert.throws(() => validateTaskDefinitionShape({ ...first, prompt: 'free text' }), { ...contractCode, message: /unknown field\(s\): prompt/ });
  const { retryPolicy, ...withoutRetry } = first;
  assert.ok(retryPolicy);
  assert.throws(() => validateTaskDefinitionShape(withoutRetry), { ...contractCode, message: /missing field\(s\): retryPolicy/ });
  assert.throws(() => validateTaskDefinitionShape({ ...first, retryPolicy: { ...TASK_RETRY_POLICY, backoff: 'exponential' } }), { ...contractCode, message: /unknown field/ });
  assert.throws(() => validateCoverageWorkflowDefinition(workflowWith(mutate('profile', { timeoutMs: 1 }))), contractCode);
});

const runV6 = { id: 'run-p1a', caseId: 'case-p1a', workflowName: COVERAGE_ANALYSIS_WORKFLOW.name, workflowVersion: '6', input: {} };
const profilePayload = () => ({ profile: {}, provenance: {}, consent: {} });
const releasePayload = () => ({ status: 'blocked', externalActionsAuthorized: false, blockers: [] });

test('P1-A: TaskInvocation rejects unknown and missing fields', () => {
  assert.deepEqual(TASK_INVOCATION_KEYS, ['input', 'upstream', 'run']);
  assert.deepEqual(validateTaskInvocation('profile', { input: {}, upstream: {}, run: runV6 }), {
    inputSchema: 'knowvia/coverage-analysis/profile/input/v1', outputSchema: 'knowvia/coverage-analysis/profile/output/v1',
  });
  assert.throws(() => validateTaskInvocation('profile', { input: {}, upstream: {}, run: runV6, model: 'override' }), { ...contractCode, message: /unknown field\(s\): model/ });
  assert.throws(() => validateTaskInvocation('profile', { input: {}, upstream: {} }), { ...contractCode, message: /missing field\(s\): run/ });
  assert.throws(() => validateTaskInvocation('profile', { input: {}, upstream: [], run: runV6 }), contractCode);
  assert.throws(() => validateTaskInvocation('coverage', { input: {}, upstream: { profile: {} }, run: runV6 }), { ...contractCode, message: /incompatible upstream/ });
  assert.throws(() => validateTaskInvocation('notATask', { input: {}, upstream: {}, run: runV6 }), contractCode);
});

test('P1-A: TaskResultEnvelope rejects unknown and missing fields at every level', () => {
  const envelope = createTaskOutputEnvelope({ key: 'profile', payload: profilePayload(), run: runV6 });
  assert.deepEqual(Object.keys(envelope).sort(), [...TASK_RESULT_ENVELOPE_KEYS].sort());
  assert.doesNotThrow(() => validateTaskOutputEnvelope('profile', envelope));
  const cases = [
    [{ ...envelope, approved: true }, /unknown field\(s\): approved/],
    [{ ...envelope, schemas: { ...envelope.schemas, extra: 'x' } }, /schemas has unknown field/],
    [{ ...envelope, producer: { ...envelope.producer, authority: 'model' } }, /producer has unknown field/],
    [{ ...envelope, provenance: { ...envelope.provenance, graphChecksum: 'x' } }, /provenance has unknown field/],
    [Object.fromEntries(Object.entries(envelope).filter(([key]) => key !== 'evidenceState')), /missing field\(s\): evidenceState/],
    [{ ...envelope, provenance: Object.fromEntries(Object.entries(envelope.provenance).filter(([key]) => key !== 'inputDigest')) }, /missing field\(s\): inputDigest/],
  ];
  for (const [candidate, message] of cases) {
    assert.throws(() => validateTaskOutputEnvelope('profile', candidate), { ...contractCode, message });
  }
});

test('P1-A: a wrong workflow version is rejected on invocation, on write and on read', () => {
  const runV5 = { ...runV6, workflowVersion: '5' };
  assert.throws(() => validateTaskInvocation('profile', { input: {}, upstream: {}, run: runV5 }), versionCode);
  assert.throws(() => validateTaskInvocation('profile', { input: {}, upstream: {}, run: { workflow_version: '5' } }), versionCode);
  assert.throws(() => createTaskOutputEnvelope({ key: 'profile', payload: profilePayload(), run: runV5 }), versionCode);
  assert.throws(() => assertExecutableWorkflowVersion({ workflow_version: 'v1' }), versionCode);
  assert.equal(assertExecutableWorkflowVersion(runV6), runV6);
  // Output already persisted by a v5 run never enters a v6 task.
  const current = createTaskOutputEnvelope({ key: 'profile', payload: profilePayload(), run: runV6 });
  const v5Output = { ...current, provenance: { ...current.provenance, workflowVersion: '5' } };
  assert.throws(() => validateTaskOutputEnvelope('profile', v5Output), versionCode);
  const unversioned = { ...current, provenance: { ...current.provenance, workflowVersion: undefined } };
  assert.throws(() => validateTaskOutputEnvelope('profile', unversioned), versionCode);
  const coverage = COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === 'coverage');
  const upstream = { profile: v5Output, group: current, personal: current };
  assert.throws(() => unwrapDependencyOutputs(coverage, upstream), versionCode);
});

test('P1-A: model metadata on a deterministic task (the release gate) is refused when the result is written', () => {
  const modelMetadata = { mode: 'live', calls: 1, totalTokens: 10, costUsd: 0.001, provider: 'synthetic', model: 'synthetic' };
  assert.doesNotThrow(() => createTaskOutputEnvelope({ key: 'release', payload: releasePayload(), run: runV6 }));
  assert.throws(() => createTaskOutputEnvelope({ key: 'release', payload: { ...releasePayload(), status: 'released', modelMetadata }, run: runV6 }), { ...contractCode, message: /model execution metadata is invalid/ });
});

// Synthetic fixture input (same shape as tests/coverage-analysis-runtime.test.mjs).
const fixtureInput = () => ({
  consent: true,
  trigger: 'renewal',
  statedEstimate: 0,
  authorizedSourceIds: ['profile-source', 'group-source', 'personal-source'],
  profilePacket: {
    subjectId: 'adult-1',
    source: { type: 'manual', id: 'profile-source', reporterId: 'adult-1', version: 'fixture-v1', location: 'intake' },
    requestedFields: ['displayName'],
    consent: { id: 'consent-1', subjectId: 'adult-1', status: 'granted', purpose: 'profile_intake', sources: ['manual'], fields: ['displayName'] },
    data: { displayName: 'Fixture Adult' },
  },
  groupPolicies: [{ policyId: 'FIXTURE-GROUP', evidence: [{ fact: 'room_rent_limit', value: 5000, sourceId: 'group-source', page: 3, version: 'fixture-v1', evidenceStatus: 'document-backed' }] }],
  personalPacket: { synthetic: true, consent: true, evidence: [{ id: 'personal-copay', policyId: 'FIXTURE-PERSONAL', dimension: 'constraints', field: 'copay', value: '10% of eligible expenses', status: 'document_backed', source: { id: 'personal-source', page: 5, version: 'fixture-v1' } }] },
});

class SyntheticRunStore {
  constructor() { this.runs = new Map(); }
  async createRun(run) { this.runs.set(run.id, structuredClone(run)); return structuredClone(run); }
  async loadRun(id) { return this.runs.has(id) ? structuredClone(this.runs.get(id)) : null; }
  async replaceRun(run, { expectedRevision }) {
    if (this.runs.get(run.id).revision !== expectedRevision) throw new Error('stale');
    this.runs.set(run.id, structuredClone(run));
    return structuredClone(run);
  }
}

test('P1-A: a fixture run pinned to version 5 stays readable but is never executed', async () => {
  const store = new SyntheticRunStore();
  const runtime = createCoverageAnalysisRuntime({ port: store });
  const created = await runtime.createRun({ id: 'run-v5', caseId: 'case-p1a', input: fixtureInput() });
  assert.equal(created.workflowVersion, '6');
  store.runs.get('run-v5').workflowVersion = '5';
  const readable = await runtime.getRun('run-v5');
  assert.equal(readable.workflowVersion, '5');
  const settled = await runtime.runUntilSettled('run-v5');
  assert.equal(settled.status, 'blocked');
  assert.equal(Object.values(settled.tasks).filter(task => task.status === 'completed').length, 0);
  assert.ok(['profile', 'group', 'personal'].every(key => /workflow version 5/.test(settled.tasks[key].error)));
  // Control: an unchanged v6 run completes every task.
  await runtime.createRun({ id: 'run-v6', caseId: 'case-p1a', input: fixtureInput() });
  const v6 = await runtime.runUntilSettled('run-v6');
  assert.equal(Object.values(v6.tasks).filter(task => task.status === 'completed').length, 22);
});

test('P1-A: the persistent worker fails a version 5 task with WORKFLOW_VERSION_MISMATCH and commits nothing', async () => {
  const failures = [];
  let completed = 0;
  let observations = 0;
  let claimed = false;
  const run = { id: 'run-v5-persisted', status: 'running', workflow_name: COVERAGE_ANALYSIS_WORKFLOW.name, workflow_version: '5', consent_grant_id: 'consent-synthetic', execution_mode: 'fixture', input_json: '{}' };
  const definition = COVERAGE_ANALYSIS_WORKFLOW.tasks.find(item => item.key === 'profile');
  const port = {
    getCase: async () => null, requireCoverageConsent: async () => null, findIdempotency: async () => null, recordIdempotency: async () => null,
    createRunWithParameters: async () => null, verifyRunSourcesCurrent: async () => ({ allowed: true }), getCoverageSourcePages: async () => [],
    loadKnownIdentifiers: async () => [], getTask: async () => null, dependencyOutputs: async () => ({}), recoverExpiredLeases: async () => 0,
    isConsentActive: async () => true, stopForRevocation: async () => null, persistTaskArtifact: async () => null,
    getJob: async () => ({ ...run, status: claimed ? 'failed' : 'running' }),
    claimNext: async () => {
      if (claimed) return null;
      claimed = true;
      return { id: 'task-v5', workflow_run_id: run.id, input_json: JSON.stringify({ key: 'profile', inputSchema: definition.inputSchema, outputSchema: definition.outputSchema }) };
    },
    completeTask: async () => { completed += 1; },
    failTask: async (taskId, input) => { failures.push({ taskId, code: input.code }); },
    recordModelObservations: async () => { observations += 1; },
  };
  const service = createPersistentCoverageAnalysisService({ port });
  await service.runUntilSettled(run.id);
  assert.deepEqual(failures, [{ taskId: 'task-v5', code: 'WORKFLOW_VERSION_MISMATCH' }]);
  assert.equal(completed, 0);
  assert.equal(observations, 0);
});
