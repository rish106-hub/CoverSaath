import { COVERAGE_ANALYSIS_WORKFLOW } from './workflow-definition.js';

export const RUN_STATES = Object.freeze(['queued', 'running', 'completed', 'blocked', 'revoked']);
export const TASK_STATES = Object.freeze(['pending', 'running', 'completed', 'blocked', 'cancelled']);
export const TERMINAL_RUN_STATES = Object.freeze(['completed', 'blocked', 'revoked']);

const requiredPortMethods = Object.freeze(['createRun', 'loadRun', 'replaceRun']);

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
    if (!task || task.kind !== definition.kind || !TASK_STATES.includes(task.status)) throw new TypeError(`Invalid persisted task: ${definition.key}.`);
    if (JSON.stringify(task.dependsOn) !== JSON.stringify(definition.dependsOn)) throw new TypeError(`Dependency contract changed for task: ${definition.key}.`);
  }
  return run;
}

export const isTerminalRun = run => TERMINAL_RUN_STATES.includes(run.status);

