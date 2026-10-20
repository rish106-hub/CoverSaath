// P1-A: the AI authority matrix agrees with the responsibility matrix, the parameter
// observation rules and the envelope guards; model output never becomes proven,
// calculated, dynamic or released. Synthetic data only; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_AUTHORITY_MATRIX, modelMayProduceEvidenceState, modelMayProduceResolutionState } from '../src/contracts/ai-authority.js';
import {
  AI_TASKS,
  DETERMINISTIC_TASKS,
  RUNTIME_AI_TASK_KEYS,
  RUNTIME_RESPONSIBILITIES,
  assertModelTask,
} from '../src/features/ai-analysis/responsibility-matrix.js';
import {
  OBSERVATION_RESOLUTION_RULES,
  PARAMETER_RESOLUTION_STATES,
  assertModelMayReplaceResolution,
  assertResolutionTransition,
  deriveResolutionAuthority,
} from '../src/features/coverage-analysis/parameter-records.js';
import { MODEL_OBSERVATION_TASK_KEYS } from '../src/features/coverage-analysis/model-observations.js';
import { COVERAGE_ANALYSIS_WORKFLOW } from '../src/features/coverage-analysis/workflow-definition.js';
import {
  EVIDENCE_STATES,
  createTaskOutputEnvelope,
  validateTaskOutputEnvelope,
} from '../src/features/coverage-analysis/agent-contracts.js';

const sorted = values => [...values].sort();
const plain = value => JSON.parse(JSON.stringify(value));

test('P1-A authority: task ownership agrees with the responsibility matrix and the workflow', () => {
  assert.deepEqual(plain(AI_AUTHORITY_MATRIX.workflowTasks), plain(RUNTIME_RESPONSIBILITIES));
  assert.deepEqual(sorted(Object.keys(AI_AUTHORITY_MATRIX.modelTasks)), sorted(AI_TASKS));
  assert.deepEqual(sorted(Object.keys(AI_AUTHORITY_MATRIX.protectedDecisions)), sorted(DETERMINISTIC_TASKS));
  for (const definition of COVERAGE_ANALYSIS_WORKFLOW.tasks) {
    assert.deepEqual(AI_AUTHORITY_MATRIX.workflowTasks[definition.key], { owner: definition.owner, modelTask: definition.modelTask }, definition.key);
  }
  // Inverse map: each AI task lists exactly the workflow tasks that use it.
  for (const [modelTask, row] of Object.entries(AI_AUTHORITY_MATRIX.modelTasks)) {
    const users = Object.entries(RUNTIME_RESPONSIBILITIES).filter(([, value]) => value.modelTask === modelTask).map(([key]) => key);
    assert.deepEqual(sorted(row.workflowTaskKeys), sorted(users), modelTask);
    assert.equal(row.authority, 'propose');
    if (row.pipeline === 'policy-structuring') {
      assert.deepEqual(row.workflowTaskKeys, [], modelTask);
      continue;
    }
    assert.equal(row.recordsParameterObservations, row.workflowTaskKeys.some(key => MODEL_OBSERVATION_TASK_KEYS.includes(key)), modelTask);
  }
  assert.deepEqual(sorted(Object.values(AI_AUTHORITY_MATRIX.modelTasks).flatMap(row => row.workflowTaskKeys)), sorted(RUNTIME_AI_TASK_KEYS));
  assert.ok(Object.isFrozen(AI_AUTHORITY_MATRIX.modelOutput.envelopeEvidenceStates));
});

test('P1-A authority: zero AI-controlled authorization, arithmetic, state transition or release tasks', () => {
  const critical = ['authorization', 'arithmetic', 'state_transition', 'release'];
  const protectedNames = Object.entries(AI_AUTHORITY_MATRIX.protectedDecisions);
  assert.ok(critical.every(category => protectedNames.some(([, row]) => row.category === category)), 'every critical category is listed');
  for (const [name, row] of protectedNames) {
    assert.equal(row.authority, 'deterministic', name);
    assert.throws(() => assertModelTask(name), { code: 'deterministic_task_protected' }, name);
  }
  const aiControlled = COVERAGE_ANALYSIS_WORKFLOW.tasks.filter(task => task.owner === 'model_assist'
    && (DETERMINISTIC_TASKS.includes(task.kind) || DETERMINISTIC_TASKS.includes(task.modelTask)));
  assert.equal(aiControlled.length, 0);
  const releaseTask = COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.kind === 'deterministic_release_gate');
  assert.deepEqual([releaseTask.owner, releaseTask.modelTask], ['deterministic', null]);
  assert.deepEqual(AI_AUTHORITY_MATRIX.modelOutput.releaseStatuses, []);
  assert.equal(AI_AUTHORITY_MATRIX.modelOutput.externalActionsAuthorized, false);
});

test('P1-A authority: resolution authorities equal OBSERVATION_RESOLUTION_RULES', () => {
  const fromRules = {};
  for (const rule of OBSERVATION_RESOLUTION_RULES) {
    (fromRules[rule.state] ??= []).push({ extractionMethod: rule.extractionMethod, authority: rule.authority, requiresAccepted: rule.requiresAccepted });
  }
  const byMethod = rows => [...rows].sort((left, right) => `${left.extractionMethod}/${left.authority}`.localeCompare(`${right.extractionMethod}/${right.authority}`));
  assert.deepEqual(sorted(Object.keys(AI_AUTHORITY_MATRIX.resolutionAuthorities)), sorted(Object.keys(fromRules)));
  for (const [state, rows] of Object.entries(fromRules)) {
    assert.deepEqual(byMethod(plain(AI_AUTHORITY_MATRIX.resolutionAuthorities[state])), byMethod(rows), state);
  }
  const modelRules = OBSERVATION_RESOLUTION_RULES.filter(rule => rule.authority === 'model')
    .map(({ extractionMethod, state, requiresAccepted }) => ({ extractionMethod, state, requiresAccepted }));
  assert.deepEqual(plain(AI_AUTHORITY_MATRIX.modelOutput.observationRules), modelRules);
});

test('P1-A authority: model parameter authority matches parameter-records guards', () => {
  const { parameterResolutionStates, forbiddenParameterResolutionStates, protectedResolutionStates } = AI_AUTHORITY_MATRIX.modelOutput;
  assert.deepEqual(sorted([...parameterResolutionStates, ...forbiddenParameterResolutionStates]), sorted(PARAMETER_RESOLUTION_STATES));
  for (const state of PARAMETER_RESOLUTION_STATES) {
    const from = state === 'unknown' ? 'reported' : 'unknown';
    if (modelMayProduceResolutionState(state)) {
      assert.doesNotThrow(() => assertResolutionTransition(from, state, { authority: 'model' }), state);
    } else {
      assert.throws(() => assertResolutionTransition(from, state, { authority: 'model' }), /Model authority cannot create/, state);
    }
  }
  for (const state of PARAMETER_RESOLUTION_STATES) {
    if (protectedResolutionStates.includes(state)) {
      assert.throws(() => assertModelMayReplaceResolution(state, 'model'), /cannot replace an established resolution/, state);
    } else {
      assert.doesNotThrow(() => assertModelMayReplaceResolution(state, 'model'), state);
    }
  }
});

test('P1-A authority: model output cannot directly become proven, calculated, dynamic or released', () => {
  // Parameter records: a model-extracted observation supports only extracted_unverified.
  const modelObservation = { extractionMethod: 'document_extraction', reviewStatus: 'not_reviewed', redactedAt: null };
  assert.equal(deriveResolutionAuthority({ state: 'extracted_unverified', observation: modelObservation }), 'model');
  for (const state of ['proven', 'calculated', 'dynamic']) {
    assert.throws(() => deriveResolutionAuthority({ state, observation: modelObservation }), /cannot establish/, state);
    assert.throws(() => deriveResolutionAuthority({ state, observation: { ...modelObservation, reviewStatus: 'accepted' } }), /cannot establish/, state);
    assert.throws(() => assertResolutionTransition('extracted_unverified', state, { authority: 'model' }), /Model authority cannot create/, state);
  }
  // Task result envelopes: a model-produced envelope carries only Unknown or Conflicting.
  const run = { id: 'run-authority', caseId: 'case-authority', workflowName: COVERAGE_ANALYSIS_WORKFLOW.name, workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version, input: {} };
  const modelMetadata = { mode: 'live', calls: 1, totalTokens: 12, costUsd: 0.001, provider: 'synthetic', model: 'synthetic' };
  const claimingProven = {
    agent: 'personal-health-cover-agent',
    dimensions: {
      protection: { assertions: [{ id: 'p1', field: 'copay', status: 'document_backed', verified: true }] },
      constraints: { assertions: [] }, economics: { assertions: [] }, suitability: { assertions: [] },
    },
    modelMetadata,
  };
  const envelope = createTaskOutputEnvelope({ key: 'personal', payload: claimingProven, run });
  assert.equal(envelope.evidenceState, 'Unknown');
  assert.deepEqual(sorted([...AI_AUTHORITY_MATRIX.modelOutput.envelopeEvidenceStates, ...AI_AUTHORITY_MATRIX.modelOutput.forbiddenEnvelopeEvidenceStates]), sorted(EVIDENCE_STATES));
  for (const state of EVIDENCE_STATES) {
    const forged = { ...envelope, evidenceState: state };
    if (modelMayProduceEvidenceState(state)) assert.doesNotThrow(() => validateTaskOutputEnvelope('personal', forged), state);
    else assert.throws(() => validateTaskOutputEnvelope('personal', forged), { code: 'AGENT_CONTRACT_INVALID' }, state);
  }
  // Release: a release result carrying model metadata is refused on write and on read.
  const released = { status: 'released', externalActionsAuthorized: false, blockers: [], modelMetadata };
  assert.throws(() => createTaskOutputEnvelope({ key: 'release', payload: released, run }), { code: 'AGENT_CONTRACT_INVALID' });
  const deterministicRelease = createTaskOutputEnvelope({ key: 'release', payload: { status: 'released', externalActionsAuthorized: false, blockers: [] }, run });
  const forgedRelease = { ...deterministicRelease, producer: { ...deterministicRelease.producer, execution: modelMetadata } };
  assert.throws(() => validateTaskOutputEnvelope('release', forgedRelease), { code: 'AGENT_CONTRACT_INVALID' });
  const forgedOwner = { ...deterministicRelease, producer: { owner: 'model_assist', modelTask: 'evidence_synthesis', execution: modelMetadata } };
  assert.throws(() => validateTaskOutputEnvelope('release', forgedOwner), { code: 'AGENT_CONTRACT_INVALID' });
  // A release gate cannot authorise external actions whoever produced it.
  assert.throws(() => createTaskOutputEnvelope({ key: 'release', payload: { status: 'released', externalActionsAuthorized: true, blockers: [] }, run }), { code: 'AGENT_CONTRACT_INVALID' });
});
