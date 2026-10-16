import { AI_TASKS, DETERMINISTIC_TASKS, RUNTIME_RESPONSIBILITIES } from '../ai-analysis/responsibility-matrix.js';
import { TASK_RETRY_POLICY } from '../../contracts/execution-policy.js';
import { contractError, validateTaskDefinitionShape } from '../../contracts/task-contracts.js';
import { validateWorkflowGraph, workflowGraphChecksum } from '../../contracts/workflow-graph.js';

import { inputSchemaId, outputSchemaId } from './contract-ids.js';

// Workflow version 6 (ADR 0001). The task graph is unchanged from version 5; v6 freezes the
// task contracts, attaches the retry policy to every task, pins the graph checksum and stops
// output from any other workflow version entering a v6 run (WORKFLOW_VERSION_MISMATCH).
export const COVERAGE_ANALYSIS_WORKFLOW_NAME = 'coverage-analysis';
// Runs pinned to any other version (for example '5') stay readable through GET /api/v1/jobs,
// but this runtime never executes them or consumes their task output.
export const COVERAGE_ANALYSIS_WORKFLOW_VERSION = '6';

const task = (key, kind, dependsOn) => Object.freeze({
  key,
  kind,
  ...RUNTIME_RESPONSIBILITIES[key],
  dependsOn: Object.freeze(dependsOn),
  inputSchema: inputSchemaId(key),
  outputSchema: outputSchemaId(key),
  retryPolicy: TASK_RETRY_POLICY,
});

const SCHEMA_ID = /^knowvia\/coverage-analysis\/[a-z][A-Za-z0-9]*\/(?:input|output)\/v[1-9][0-9]*$/;

/**
 * Validates a coverage-analysis workflow definition: exact TaskDefinition keys, a valid DAG
 * (no cycle, no missing or late dependency), schema ids bound to the task key, a retry
 * policy on every task, and model authority limited to the responsibility matrix:
 * a deterministic task never names a model task, a model-assisted task names only an
 * allowed AI task, and a protected (deterministic) kind is never model-assisted.
 */
export function validateCoverageWorkflowDefinition(workflow) {
  if (!workflow || typeof workflow !== 'object') throw contractError('Workflow definition is required.');
  if (workflow.name !== COVERAGE_ANALYSIS_WORKFLOW_NAME) throw contractError('Workflow name is invalid.');
  if (typeof workflow.version !== 'string' || !/^[1-9][0-9]*$/.test(workflow.version)) throw contractError('Workflow version is invalid.');
  if (!Array.isArray(workflow.tasks)) throw contractError('Workflow tasks are required.');
  workflow.tasks.forEach(validateTaskDefinitionShape);
  validateWorkflowGraph(workflow.tasks);
  for (const definition of workflow.tasks) {
    const label = `Task ${definition.key}`;
    if (definition.inputSchema !== inputSchemaId(definition.key) || definition.outputSchema !== outputSchemaId(definition.key)
      || !SCHEMA_ID.test(definition.inputSchema) || !SCHEMA_ID.test(definition.outputSchema)) {
      throw contractError(`${label} schema ids do not match its key.`);
    }
    if (definition.owner === 'deterministic' && definition.modelTask !== null) {
      throw contractError(`${label} is deterministic and cannot be assigned a model task.`);
    }
    if (definition.owner === 'model_assist' && !AI_TASKS.includes(definition.modelTask)) {
      throw contractError(`${label} names a model task outside the responsibility matrix.`);
    }
    if (DETERMINISTIC_TASKS.includes(definition.kind) && definition.owner !== 'deterministic') {
      throw contractError(`${label} kind ${definition.kind} is protected and must stay deterministic.`);
    }
    if (DETERMINISTIC_TASKS.includes(definition.modelTask)) {
      throw contractError(`${label} cannot assign the protected task ${definition.modelTask} to a model.`);
    }
    const responsibility = RUNTIME_RESPONSIBILITIES[definition.key];
    if (!responsibility || responsibility.owner !== definition.owner || responsibility.modelTask !== definition.modelTask) {
      throw contractError(`${label} ownership does not match the responsibility matrix.`);
    }
  }
  return workflow;
}

const tasks = Object.freeze([
  task('profile', 'profile_intake', []),
  task('group', 'group_cover_analysis', []),
  task('personal', 'personal_cover_analysis', []),
  task('coverage', 'coverage_graph', ['profile', 'group', 'personal']),
  task('documentIdentity', 'policy_decomposition_a', ['coverage']),
  task('continuity', 'policy_decomposition_b', ['coverage']),
  task('enrolment', 'policy_decomposition_c', ['coverage']),
  task('financialRules', 'policy_decomposition_d', ['coverage']),
  task('benefits', 'policy_decomposition_e', ['coverage']),
  task('exclusions', 'policy_decomposition_f', ['coverage']),
  task('hospitalAccess', 'policy_decomposition_g', ['coverage']),
  task('claimsProcess', 'policy_decomposition_h', ['coverage']),
  task('renewalChange', 'policy_decomposition_i', ['coverage']),
  task('serviceResearch', 'policy_decomposition_j', ['coverage']),
  task('decision', 'deterministic_classification', ['coverage']),
  task('householdAction', 'policy_decomposition_k', ['decision', 'documentIdentity', 'continuity', 'enrolment', 'financialRules', 'benefits', 'exclusions', 'hospitalAccess', 'claimsProcess', 'renewalChange', 'serviceResearch']),
  task('evidence', 'evidence_review', ['coverage', 'decision', 'documentIdentity', 'continuity', 'enrolment', 'financialRules', 'benefits', 'exclusions', 'hospitalAccess', 'claimsProcess', 'renewalChange', 'serviceResearch']),
  task('privacy', 'privacy_review', ['coverage', 'decision']),
  task('safety', 'safety_review', ['coverage', 'decision']),
  task('questions', 'question_drafting', ['coverage', 'decision']),
  task('primary', 'bounded_synthesis', ['decision', 'householdAction', 'evidence', 'privacy', 'safety', 'questions']),
  task('release', 'deterministic_release_gate', ['primary']),
]);

validateCoverageWorkflowDefinition({ name: COVERAGE_ANALYSIS_WORKFLOW_NAME, version: COVERAGE_ANALYSIS_WORKFLOW_VERSION, tasks });

export const COVERAGE_ANALYSIS_WORKFLOW = Object.freeze({
  name: COVERAGE_ANALYSIS_WORKFLOW_NAME,
  version: COVERAGE_ANALYSIS_WORKFLOW_VERSION,
  graphChecksum: workflowGraphChecksum({ name: COVERAGE_ANALYSIS_WORKFLOW_NAME, tasks }),
  tasks,
});

export const taskDefinition = key => COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === key) ?? null;
