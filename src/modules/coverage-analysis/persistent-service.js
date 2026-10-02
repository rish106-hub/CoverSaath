import { createHash, randomUUID } from 'node:crypto';
import { COVERAGE_ANALYSIS_WORKFLOW } from './workflow-definition.js';
import { createCoverageAnalysisFixtureInput } from './fixture-input.js';
import { createCoverageAnalysisSourceInput } from './source-input.js';
import { createFixtureTaskRegistry } from './task-registry.js';
import {
  createTaskOutputEnvelope,
  unwrapDependencyOutputs,
  validateTaskInvocation,
} from './agent-contracts.js';

const terminal = new Set(['completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted']);
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

function portContract(port) {
  const methods = [
    'getCase', 'requireCoverageConsent', 'findIdempotency', 'recordIdempotency',
    'createRunWithTasks', 'getCoverageSourcePages', 'getJob', 'getTask', 'claimNext', 'dependencyOutputs',
    'completeTask', 'failTask', 'recoverExpiredLeases', 'isConsentActive',
    'stopForRevocation', 'persistTaskArtifact',
  ];
  if (!port || methods.some(method => typeof port[method] !== 'function')) {
    throw new TypeError(`Persistent coverage-analysis port must implement: ${methods.join(', ')}.`);
  }
  return port;
}

export function createPersistentCoverageAnalysisService({
  port,
  registry = createFixtureTaskRegistry(),
  liveRegistry,
  workerId = `coverage-analysis-${randomUUID()}`,
  clock = () => new Date(),
  maxConcurrency = 4,
} = {}) {
  portContract(port);
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 8) throw new TypeError('Persistent worker concurrency must be between 1 and 8.');
  if (liveRegistry && liveRegistry.executionMode !== 'live') throw new TypeError('Live registry must be created through the AI runtime adapter.');
  const registries = { fixture: registry, ...(liveRegistry ? { live: liveRegistry } : {}) };
  for (const [mode, configuredRegistry] of Object.entries(registries)) {
    for (const definition of COVERAGE_ANALYSIS_WORKFLOW.tasks) {
      if (typeof configuredRegistry?.[definition.key] !== 'function') throw new TypeError(`Missing ${mode} executable task: ${definition.key}.`);
    }
  }

  async function runUntilSettled(runId, { maxTasks = 30 } = {}) {
    if (!Number.isInteger(maxTasks) || maxTasks < 1 || maxTasks > 100) throw new TypeError('Persistent task limit must be between 1 and 100.');
    let processed = 0;
    while (processed < maxTasks) {
      let job = await port.getJob(runId);
      if (!job || terminal.has(job.status)) return job;
      await port.recoverExpiredLeases();
      if (!await port.isConsentActive(job.consent_grant_id, clock().toISOString())) {
        await port.stopForRevocation(runId);
        return port.getJob(runId);
      }
      const claimed = [];
      const batchLimit = Math.min(maxConcurrency, maxTasks - processed);
      for (let index = 0; index < batchLimit; index += 1) {
        const task = await port.claimNext({
          workerId,
          runId,
          workflowName: COVERAGE_ANALYSIS_WORKFLOW.name,
        });
        if (!task) break;
        claimed.push(task);
      }
      if (claimed.length === 0) return port.getJob(runId);

      const outcomes = await Promise.all(claimed.map(async task => {
        const claimedJob = await port.getJob(task.workflow_run_id);
        if (claimedJob?.workflow_name !== COVERAGE_ANALYSIS_WORKFLOW.name) {
          return { task, error: Object.assign(new Error('Local coverage worker claimed an unsupported workflow.'), { code: 'UNSUPPORTED_WORKFLOW' }) };
        }
        try {
          const taskInput = JSON.parse(task.input_json);
        const executionMode = claimedJob.execution_mode ?? claimedJob.executionMode;
        const selectedRegistry = registries[executionMode];
        if (!selectedRegistry) {
          const error = new Error(`No ${executionMode || 'unknown'} registry is configured.`);
          error.code = 'EXECUTION_MODE_NOT_CONFIGURED';
          throw error;
        }
        const definition = COVERAGE_ANALYSIS_WORKFLOW.tasks.find(item => item.key === taskInput.key);
        if (!definition || taskInput.inputSchema !== definition.inputSchema || taskInput.outputSchema !== definition.outputSchema) {
          const error = new Error('Persisted task schema does not match the workflow contract.');
          error.code = 'TASK_SCHEMA_MISMATCH';
          throw error;
        }
        const context = {
          input: JSON.parse(claimedJob.input_json),
          upstream: unwrapDependencyOutputs(definition, await port.dependencyOutputs(task.id)),
          run: claimedJob,
        };
        validateTaskInvocation(taskInput.key, context);
        const payload = await selectedRegistry[taskInput.key](context);
        const output = createTaskOutputEnvelope({ key: taskInput.key, payload, run: claimedJob });
          return { task, claimedJob, taskInput, output };
        } catch (error) {
          return { task, error };
        }
      }));

      job = await port.getJob(runId);
      if (!await port.isConsentActive(job.consent_grant_id, clock().toISOString())) {
        await port.stopForRevocation(runId);
        return port.getJob(runId);
      }
      for (const outcome of outcomes) {
        if (outcome.error) {
          await port.failTask(outcome.task.id, {
            workerId,
            code: outcome.error?.code ?? 'ANALYSIS_TASK_FAILED',
            message: outcome.error instanceof Error ? outcome.error.message : 'Analysis task failed.',
          });
        } else {
          await port.completeTask(outcome.task.id, { output: outcome.output, workerId });
          await port.persistTaskArtifact({ run: outcome.claimedJob, task: outcome.task, taskKey: outcome.taskInput.key, output: outcome.output });
        }
      }
      processed += claimed.length;
    }
    const job = await port.getJob(runId);
    if (job && !terminal.has(job.status)) throw new Error('Persistent coverage analysis exceeded its bounded task limit.');
    return job;
  }

  return Object.freeze({
    async createAnalysisRun({ caseId, consentGrantId, executionMode = 'fixture', modelPermission = false, idempotencyKey, fixtureVariant = 'standard' }) {
      const caseRecord = await port.getCase(caseId);
      if (!caseRecord) return { created: false, notFound: true, job: null };
      if (caseRecord.status !== 'processing') {
        const error = new Error('Case must move through collecting to processing before analysis is queued.');
        error.code = 'CASE_NOT_READY_FOR_ANALYSIS';
        throw error;
      }
      await port.requireCoverageConsent({ caseRecord, consentGrantId });
      if (!['fixture', 'live'].includes(executionMode)) {
        const error = new Error('Execution mode must be fixture or live.');
        error.code = 'INVALID_EXECUTION_MODE';
        throw error;
      }
      if (executionMode === 'live' && !registries.live) {
        const error = new Error('Persistent live analysis is not wired. It will not fall back to fixture execution.');
        error.code = 'LIVE_ANALYSIS_NOT_CONFIGURED';
        error.statusCode = 503;
        throw error;
      }
      if (executionMode === 'live' && modelPermission !== true) {
        const error = new Error('This run needs explicit permission to share its bounded source packet with Gemini.');
        error.code = 'MODEL_PERMISSION_REQUIRED';
        error.statusCode = 403;
        throw error;
      }
      const request = {
        caseId,
        caseRevision: caseRecord.revision,
        consentGrantId,
        executionMode,
        modelPermission: executionMode === 'live',
        workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version,
        fixtureVariant,
      };
      const requestDigest = digest(request);
      const existing = await port.findIdempotency({ scope: 'analysis_run', key: idempotencyKey, at: clock().toISOString() });
      if (existing) {
        if (existing.request_digest !== requestDigest) {
          const error = new Error('Idempotency key was reused with a different request.');
          error.code = 'IDEMPOTENCY_CONFLICT';
          throw error;
        }
        const { runId } = JSON.parse(existing.response_json);
        return { created: false, job: await port.getJob(runId) };
      }

      const sourceInput = executionMode === 'live'
        ? createCoverageAnalysisSourceInput(
          { ...caseRecord, consent_grant_id: consentGrantId },
          await port.getCoverageSourcePages(caseId),
        )
        : createCoverageAnalysisFixtureInput(caseRecord, { variant: fixtureVariant });
      const input = {
        ...sourceInput,
        modelPermission: executionMode === 'live',
      };
      const runId = `coverage-run-${randomUUID()}`;
      await port.createRunWithTasks({
        id: runId,
        caseId,
        workflowName: COVERAGE_ANALYSIS_WORKFLOW.name,
        workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version,
        executionMode,
        caseRevision: caseRecord.revision,
        consentGrantId,
        input,
        tasks: COVERAGE_ANALYSIS_WORKFLOW.tasks.map(definition => ({
          key: definition.key,
          agentName: `coverage-analysis/${definition.key}`,
          taskKind: definition.kind,
          dependsOn: [...definition.dependsOn],
          input: {
            key: definition.key,
            inputSchema: definition.inputSchema,
            outputSchema: definition.outputSchema,
            caseId,
            caseRevision: caseRecord.revision,
            consentGrantId,
          },
        })),
      });
      await port.recordIdempotency({
        scope: 'analysis_run',
        key: idempotencyKey,
        requestDigest,
        responseStatus: 202,
        response: { runId },
        expiresAt: new Date(clock().getTime() + 24 * 60 * 60 * 1000).toISOString(),
      });
      return { created: true, job: await port.getJob(runId) };
    },
    getJob: runId => port.getJob(runId),
    getTask: taskId => port.getTask(taskId),
    runUntilSettled,
  });
}
