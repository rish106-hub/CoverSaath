import { createHash, randomUUID } from 'node:crypto';
import { COVERAGE_ANALYSIS_WORKFLOW } from './workflow-definition.js';
import { createCoverageAnalysisFixtureInput } from './fixture-input.js';
import { createFixtureTaskRegistry } from './task-registry.js';

const terminal = new Set(['completed', 'blocked', 'failed', 'cancelled', 'revoked', 'interrupted']);
const stable = value => JSON.stringify(value, Object.keys(value).sort());
const digest = value => createHash('sha256').update(stable(value)).digest('hex');

function portContract(port) {
  const methods = [
    'getCase', 'requireCoverageConsent', 'findIdempotency', 'recordIdempotency',
    'createRunWithTasks', 'getJob', 'getTask', 'claimNext', 'dependencyOutputs',
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
  workerId = `coverage-analysis-${randomUUID()}`,
  clock = () => new Date(),
} = {}) {
  portContract(port);
  for (const definition of COVERAGE_ANALYSIS_WORKFLOW.tasks) {
    if (typeof registry[definition.key] !== 'function') throw new TypeError(`Missing executable task: ${definition.key}.`);
  }

  async function runUntilSettled(runId, { maxTasks = 30 } = {}) {
    for (let count = 0; count < maxTasks; count += 1) {
      let job = await port.getJob(runId);
      if (!job || terminal.has(job.status)) return job;
      await port.recoverExpiredLeases();
      if (!await port.isConsentActive(job.consent_grant_id, clock().toISOString())) {
        await port.stopForRevocation(runId);
        return port.getJob(runId);
      }
      const task = await port.claimNext({ workerId });
      if (!task) return port.getJob(runId);
      const claimedJob = await port.getJob(task.workflow_run_id);
      if (claimedJob?.workflow_name !== COVERAGE_ANALYSIS_WORKFLOW.name) {
        await port.failTask(task.id, { workerId, code: 'UNSUPPORTED_WORKFLOW', message: 'Local coverage worker claimed an unsupported workflow.' });
        continue;
      }
      const taskInput = JSON.parse(task.input_json);
      try {
        const output = await registry[taskInput.key]({
          input: JSON.parse(claimedJob.input_json),
          upstream: await port.dependencyOutputs(task.id),
          run: claimedJob,
        });
        if (!await port.isConsentActive(claimedJob.consent_grant_id, clock().toISOString())) {
          await port.stopForRevocation(claimedJob.id);
          if (claimedJob.id === runId) return port.getJob(runId);
          continue;
        }
        await port.completeTask(task.id, { output, workerId });
        await port.persistTaskArtifact({ run: claimedJob, task, taskKey: taskInput.key, output });
      } catch (error) {
        await port.failTask(task.id, {
          workerId,
          code: 'FIXTURE_TASK_FAILED',
          message: error instanceof Error ? error.message : 'Fixture task failed.',
        });
      }
    }
    const job = await port.getJob(runId);
    if (job && !terminal.has(job.status)) throw new Error('Persistent coverage analysis exceeded its bounded task limit.');
    return job;
  }

  return Object.freeze({
    async createAnalysisRun({ caseId, consentGrantId, executionMode = 'fixture', idempotencyKey, fixtureVariant = 'standard' }) {
      const caseRecord = await port.getCase(caseId);
      if (!caseRecord) return { created: false, notFound: true, job: null };
      if (caseRecord.status !== 'processing') {
        const error = new Error('Case must move through collecting to processing before analysis is queued.');
        error.code = 'CASE_NOT_READY_FOR_ANALYSIS';
        throw error;
      }
      await port.requireCoverageConsent({ caseRecord, consentGrantId });
      if (executionMode !== 'fixture') {
        const error = new Error('Persistent live analysis is not wired. It will not fall back to fixture execution.');
        error.code = 'LIVE_ANALYSIS_NOT_CONFIGURED';
        error.statusCode = 503;
        throw error;
      }
      const request = {
        caseId,
        caseRevision: caseRecord.revision,
        consentGrantId,
        executionMode,
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

      const input = createCoverageAnalysisFixtureInput(caseRecord, { variant: fixtureVariant });
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
          input: { key: definition.key, caseId, caseRevision: caseRecord.revision, consentGrantId },
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

