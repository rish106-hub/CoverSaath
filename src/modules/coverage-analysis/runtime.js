import { randomUUID } from 'node:crypto';
import {
  assertCoverageAnalysisPort,
  createTaskRecords,
  isTerminalRun,
  validateRunRecord,
} from './contracts.js';
import { COVERAGE_ANALYSIS_WORKFLOW } from './workflow-definition.js';
import { createFixtureTaskRegistry } from './task-registry.js';

const clone = value => structuredClone(value);
const timestamp = () => new Date().toISOString();

function upstreamOutputs(run, task) {
  return Object.fromEntries(task.dependsOn.map(key => [key, clone(run.tasks[key].output)]));
}

function readyTasks(run) {
  return COVERAGE_ANALYSIS_WORKFLOW.tasks.filter(definition => {
    const task = run.tasks[definition.key];
    return task.status === 'pending' && definition.dependsOn.every(key => run.tasks[key].status === 'completed');
  });
}

export function createCoverageAnalysisRuntime({ port, registry = createFixtureTaskRegistry(), clock = timestamp } = {}) {
  assertCoverageAnalysisPort(port);
  for (const task of COVERAGE_ANALYSIS_WORKFLOW.tasks) {
    if (typeof registry[task.key] !== 'function') throw new TypeError(`Missing executable task: ${task.key}.`);
  }

  const persist = async run => {
    const expectedRevision = run.revision;
    const candidate = { ...clone(run), revision: expectedRevision + 1, updatedAt: clock() };
    return validateRunRecord(await port.replaceRun(candidate, { expectedRevision }));
  };

  const settleStatus = run => {
    const release = run.tasks.release;
    if (release.status === 'completed') {
      run.status = release.output.status === 'released' ? 'completed' : 'blocked';
      run.result = clone(release.output);
      run.finishedAt = clock();
    } else if (Object.values(run.tasks).some(task => task.status === 'blocked')) {
      run.status = 'blocked';
      run.result = { status: 'blocked', blockers: Object.values(run.tasks).filter(task => task.status === 'blocked').map(task => ({ task: task.key, code: 'TASK_FAILED' })) };
      run.finishedAt = clock();
    } else {
      run.status = 'running';
    }
  };

  return Object.freeze({
    async createRun({ id = `coverage-run-${randomUUID()}`, caseId, input, mode = 'fixture' } = {}) {
      if (mode !== 'fixture') throw new Error('Only fixture execution is available in this runtime.');
      if (!caseId || !input || input.consent !== true) throw new Error('A case and explicit fixture consent are required.');
      if (!Array.isArray(input.groupPolicies) || input.groupPolicies.length === 0 || !input.profilePacket || !input.personalPacket) {
        throw new Error('Profile, group and personal fixture packets are required.');
      }
      if (!Array.isArray(input.authorizedSourceIds)) throw new Error('authorizedSourceIds are required.');
      const at = clock();
      return validateRunRecord(await port.createRun({
        id,
        caseId,
        workflowName: COVERAGE_ANALYSIS_WORKFLOW.name,
        workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version,
        mode,
        status: 'queued',
        revision: 0,
        input: clone(input),
        tasks: createTaskRecords(),
        result: null,
        createdAt: at,
        updatedAt: at,
        finishedAt: null,
      }));
    },

    async getRun(runId) {
      const run = await port.loadRun(runId);
      return run ? validateRunRecord(run) : null;
    },

    async tick(runId) {
      let run = validateRunRecord(await port.loadRun(runId));
      if (run.status === 'revoked') {
        for (const task of Object.values(run.tasks)) if (['pending', 'running'].includes(task.status)) task.status = 'cancelled';
        return persist(run);
      }
      if (isTerminalRun(run)) return run;

      // A persisted running task means the previous process stopped after claim.
      // Fixture work is deterministic, so it can be retried with a bounded attempt count.
      let recovered = false;
      for (const task of Object.values(run.tasks)) {
        if (task.status === 'running') {
          task.status = task.attempts < 2 ? 'pending' : 'blocked';
          task.error = task.attempts < 2 ? 'Recovered after interrupted fixture execution.' : 'Fixture retry limit reached.';
          recovered = true;
        }
      }
      if (recovered) run = await persist(run);

      const ready = readyTasks(run);
      if (ready.length === 0) {
        settleStatus(run);
        if (!isTerminalRun(run)) {
          run.status = 'blocked';
          run.result = { status: 'blocked', blockers: [{ code: 'WORKFLOW_STALLED' }] };
          run.finishedAt = clock();
        }
        return persist(run);
      }

      for (const definition of ready) {
        const task = run.tasks[definition.key];
        task.status = 'running';
        task.attempts += 1;
        task.startedAt = clock();
        task.error = null;
      }
      run.status = 'running';
      run = await persist(run);

      const outcomes = await Promise.all(ready.map(async definition => {
        const task = run.tasks[definition.key];
        try {
          const output = await registry[definition.key]({ input: clone(run.input), upstream: upstreamOutputs(run, task), run: clone(run) });
          return { key: definition.key, output: clone(output) };
        } catch (error) {
          return { key: definition.key, error: error instanceof Error ? error.message : 'Task failed.' };
        }
      }));

      for (const outcome of outcomes) {
        const task = run.tasks[outcome.key];
        task.finishedAt = clock();
        if (outcome.error) {
          task.status = 'blocked';
          task.error = outcome.error;
        } else {
          task.status = 'completed';
          task.output = outcome.output;
        }
      }
      settleStatus(run);
      return persist(run);
    },

    async runUntilSettled(runId, { maxTicks = 20 } = {}) {
      if (!Number.isInteger(maxTicks) || maxTicks < 1 || maxTicks > 100) throw new Error('maxTicks must be between 1 and 100.');
      let run = await this.getRun(runId);
      for (let count = 0; count < maxTicks && run && !isTerminalRun(run); count += 1) run = await this.tick(runId);
      if (run && !isTerminalRun(run)) throw new Error('Coverage analysis did not settle within the tick limit.');
      return run;
    },
  });
}

