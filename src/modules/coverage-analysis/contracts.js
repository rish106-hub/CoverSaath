import { FIXTURE_RUN_STORE_PORT_METHODS } from '../../contracts/persistence-ports.js';
import { COVERAGE_ANALYSIS_WORKFLOW } from './workflow-definition.js';

export const RUN_STATES = Object.freeze(['queued', 'running', 'completed', 'blocked', 'revoked']);
export const TASK_STATES = Object.freeze(['pending', 'running', 'completed', 'blocked', 'cancelled']);
export const TERMINAL_RUN_STATES = Object.freeze(['completed', 'blocked', 'revoked']);

const requiredPortMethods = FIXTURE_RUN_STORE_PORT_METHODS;

export const WORKFLOW_VERSION_MISMATCH = 'WORKFLOW_VERSION_MISMATCH';

/**
 * A run (persisted SQLite row or fixture run record) may be executed only when it is pinned
 * to the current workflow version. A run pinned to another version (for example '5') stays
 * readable but is rejected here with WORKFLOW_VERSION_MISMATCH (ADR 0001).
 *
 * A run object that carries no version at all is treated as unpinned and is not rejected
 * here: persisted rows always carry one (workflow_runs.workflow_version is NOT NULL) and the
 * fixture runtime always sets one. Its output is still stamped with no version, so the
 * strict read-side check in validateTaskOutputEnvelope stops it from being consumed.
 * The workflow name is guarded separately (UNSUPPORTED_WORKFLOW in the persistent service).
 */
export function assertExecutableWorkflowVersion(run) {
  const version = run?.workflowVersion ?? run?.workflow_version;
  if (version !== undefined && version !== COVERAGE_ANALYSIS_WORKFLOW.version) {
    throw Object.assign(
      new TypeError(`Run is pinned to workflow version ${String(version)}; this runtime executes ${COVERAGE_ANALYSIS_WORKFLOW.name} version ${COVERAGE_ANALYSIS_WORKFLOW.version} only.`),
      { code: WORKFLOW_VERSION_MISMATCH },
    );
  }
  return run;
}

export function assertCoverageAnalysisPort(port) {
  if (!port || requiredPortMethods.some(method => typeof port[method] !== 'function')) {
    throw new TypeError(`Coverage analysis port must implement: ${requiredPortMethods.join(', ')}.`);
  }
  return port;
}

export function createTaskRecords() {
  return Object.fromEntries(COVERAGE_ANALYSIS_WORKFLOW.tasks.map(definition => [definition.key, {
    key: definition.key,
    kind: definition.kind,
    owner: definition.owner,
    modelTask: definition.modelTask,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    dependsOn: [...definition.dependsOn],
    status: 'pending',
    attempts: 0,
    output: null,
    error: null,
  }]));
}

export function validateRunRecord(run) {
  if (!run || typeof run !== 'object' || typeof run.id !== 'string' || !run.id) throw new TypeError('A persisted run record is required.');
  if (!RUN_STATES.includes(run.status)) throw new TypeError(`Unsupported run state: ${run.status}.`);
  if (!Number.isInteger(run.revision) || run.revision < 0) throw new TypeError('Run revision must be a non-negative integer.');
  if (run.mode !== 'fixture') throw new TypeError('Coverage analysis runtime accepts fixture mode only.');
  if (!run.tasks || typeof run.tasks !== 'object') throw new TypeError('Persisted task records are required.');
  for (const definition of COVERAGE_ANALYSIS_WORKFLOW.tasks) {
    const task = run.tasks[definition.key];
    if (!task || task.kind !== definition.kind || task.owner !== definition.owner || task.modelTask !== definition.modelTask || task.inputSchema !== definition.inputSchema || task.outputSchema !== definition.outputSchema || !TASK_STATES.includes(task.status)) throw new TypeError(`Invalid persisted task: ${definition.key}.`);
    if (JSON.stringify(task.dependsOn) !== JSON.stringify(definition.dependsOn)) throw new TypeError(`Dependency contract changed for task: ${definition.key}.`);
  }
  return run;
}

export const isTerminalRun = run => TERMINAL_RUN_STATES.includes(run.status);
