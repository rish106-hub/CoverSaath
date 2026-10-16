import { createHash } from 'node:crypto';

// Generic workflow DAG rules and the graph checksum. Pure apart from hashing.
// ADR: docs/adr/0001-workflow-v6-contracts.md

export const WORKFLOW_GRAPH_ERROR_CODE = 'WORKFLOW_GRAPH_INVALID';
export const WORKFLOW_GRAPH_CHECKSUM_ALGORITHM = 'sha256:knowvia-workflow-graph-v1';

// Exactly the fields the checksum covers. Retry policy is versioned separately
// (execution-policy.js); changing these fields requires a new workflow version.
export const WORKFLOW_GRAPH_CHECKSUM_FIELDS = Object.freeze([
  'key', 'kind', 'owner', 'modelTask', 'dependsOn', 'inputSchema', 'outputSchema',
]);

function graphError(message) {
  return Object.assign(new TypeError(message), { code: WORKFLOW_GRAPH_ERROR_CODE });
}

/**
 * Validates the workflow task graph: unique keys, every dependency defined,
 * no self or duplicate dependency, no cycle, and declaration order is a
 * topological order (the persistence layer inserts tasks in declaration order
 * and requires each dependency to exist before use).
 * Returns the keys in declaration order.
 */
export function validateWorkflowGraph(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) throw graphError('A workflow needs at least one task.');
  const keys = new Set();
  for (const task of tasks) {
    if (!task || typeof task.key !== 'string' || !task.key) throw graphError('Every workflow task needs a key.');
    if (keys.has(task.key)) throw graphError(`Duplicate workflow task key: ${task.key}.`);
    keys.add(task.key);
  }
  for (const task of tasks) {
    if (!Array.isArray(task.dependsOn)) throw graphError(`Task ${task.key} dependencies must be an array.`);
    const seen = new Set();
    for (const dependency of task.dependsOn) {
      if (dependency === task.key) throw graphError(`Task ${task.key} cannot depend on itself.`);
      if (!keys.has(dependency)) throw graphError(`Task ${task.key} depends on an undefined task: ${dependency}.`);
      if (seen.has(dependency)) throw graphError(`Task ${task.key} lists dependency ${dependency} twice.`);
      seen.add(dependency);
    }
  }
  // Kahn's algorithm: any task left unvisited sits on a cycle.
  const incoming = new Map(tasks.map(task => [task.key, task.dependsOn.length]));
  const dependents = new Map(tasks.map(task => [task.key, []]));
  for (const task of tasks) for (const dependency of task.dependsOn) dependents.get(dependency).push(task.key);
  const ready = tasks.filter(task => task.dependsOn.length === 0).map(task => task.key);
  let visited = 0;
  while (ready.length > 0) {
    const key = ready.shift();
    visited += 1;
    for (const dependent of dependents.get(key)) {
      incoming.set(dependent, incoming.get(dependent) - 1);
      if (incoming.get(dependent) === 0) ready.push(dependent);
    }
  }
  if (visited !== tasks.length) {
    const cyclic = [...incoming].filter(([, count]) => count > 0).map(([key]) => key).sort();
    throw graphError(`Workflow graph has a cycle through: ${cyclic.join(', ')}.`);
  }
  const declared = new Set();
  for (const task of tasks) {
    const late = task.dependsOn.find(dependency => !declared.has(dependency));
    if (late) throw graphError(`Task ${task.key} is declared before its dependency ${late}.`);
    declared.add(task.key);
  }
  return [...keys];
}

/**
 * Canonical form of the graph: tasks sorted by key, dependencies sorted, and only
 * WORKFLOW_GRAPH_CHECKSUM_FIELDS kept. Independent of declaration order and of
 * object key order.
 */
export function canonicalWorkflowGraph({ name, tasks }) {
  validateWorkflowGraph(tasks);
  return {
    algorithm: WORKFLOW_GRAPH_CHECKSUM_ALGORITHM,
    name,
    tasks: [...tasks]
      .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map(task => [
        task.key,
        task.kind,
        task.owner,
        task.modelTask ?? null,
        [...task.dependsOn].sort(),
        task.inputSchema,
        task.outputSchema,
      ]),
  };
}

/** Deterministic sha256 hex digest of the canonical graph. */
export function workflowGraphChecksum(workflow) {
  return createHash('sha256').update(JSON.stringify(canonicalWorkflowGraph(workflow))).digest('hex');
}
