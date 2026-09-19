import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COVERAGE_ANALYSIS_WORKFLOW,
  createCoverageAnalysisRuntime,
  createFixtureTaskRegistry,
} from '../src/modules/coverage-analysis/index.js';

const clone = value => structuredClone(value);

class MemoryCoverageAnalysisPort {
  constructor(snapshot = []) { this.records = new Map(snapshot.map(run => [run.id, clone(run)])); }
  async createRun(run) {
    if (this.records.has(run.id)) throw new Error('Run already exists.');
    this.records.set(run.id, clone(run));
    return clone(run);
  }
  async loadRun(id) { return this.records.has(id) ? clone(this.records.get(id)) : null; }
  async replaceRun(run, { expectedRevision }) {
    const current = this.records.get(run.id);
    if (!current || current.revision !== expectedRevision) throw new Error('Stale run revision.');
    this.records.set(run.id, clone(run));
    return clone(run);
  }
  snapshot() { return [...this.records.values()].map(clone); }
  async revoke(id) {
    const run = this.records.get(id);
    run.status = 'revoked';
    run.revision += 1;
  }
}

const input = ({ authorizedSourceIds = ['profile-source', 'group-source', 'personal-source'] } = {}) => ({
  consent: true,
  trigger: 'renewal',
  statedEstimate: 0,
  authorizedSourceIds,
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

async function setup(options = {}) {
  const port = new MemoryCoverageAnalysisPort();
  const runtime = createCoverageAnalysisRuntime({ port, ...options });
  const run = await runtime.createRun({ id: 'run-1', caseId: 'case-1', input: input() });
  return { port, runtime, run };
}

test('canonical workflow names ten executable tasks with explicit dependencies', () => {
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.tasks.length, 10);
  assert.deepEqual(COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === 'coverage').dependsOn, ['profile', 'group', 'personal']);
  assert.deepEqual(COVERAGE_ANALYSIS_WORKFLOW.tasks.find(task => task.key === 'primary').dependsOn, ['decision', 'evidence', 'privacy', 'safety']);
  const registry = createFixtureTaskRegistry();
  assert.ok(COVERAGE_ANALYSIS_WORKFLOW.tasks.every(task => typeof registry[task.key] === 'function'));
});

test('multi-parent tasks wait and receive upstream outputs', async () => {
  const events = [];
  const base = createFixtureTaskRegistry();
  const registry = Object.fromEntries(Object.entries(base).map(([key, execute]) => [key, async context => {
    events.push({ key, upstream: Object.keys(context.upstream) });
    return execute(context);
  }]));
  const { runtime } = await setup({ registry });
  await runtime.runUntilSettled('run-1');
  const coverage = events.find(event => event.key === 'coverage');
  const primary = events.find(event => event.key === 'primary');
  assert.deepEqual(coverage.upstream.sort(), ['group', 'personal', 'profile']);
  assert.deepEqual(primary.upstream.sort(), ['decision', 'evidence', 'privacy', 'safety']);
  assert.ok(events.findIndex(event => event.key === 'coverage') > events.findIndex(event => event.key === 'personal'));
  assert.ok(events.findIndex(event => event.key === 'primary') > events.findIndex(event => event.key === 'safety'));
});

test('deterministic evidence review blocks release for an unauthorised source', async () => {
  const port = new MemoryCoverageAnalysisPort();
  const runtime = createCoverageAnalysisRuntime({ port });
  await runtime.createRun({ id: 'blocked-run', caseId: 'case-1', input: input({ authorizedSourceIds: ['profile-source', 'personal-source'] }) });
  const run = await runtime.runUntilSettled('blocked-run');
  assert.equal(run.status, 'blocked');
  assert.equal(run.tasks.evidence.output.status, 'blocked');
  assert.equal(run.tasks.release.output.status, 'blocked');
  assert.equal(run.result.externalActionsAuthorized, false);
});

test('revocation stops all unclaimed work without executing a task', async () => {
  let executions = 0;
  const base = createFixtureTaskRegistry();
  const registry = Object.fromEntries(Object.entries(base).map(([key, execute]) => [key, context => { executions += 1; return execute(context); }]));
  const { port, runtime } = await setup({ registry });
  await port.revoke('run-1');
  const run = await runtime.tick('run-1');
  assert.equal(run.status, 'revoked');
  assert.equal(executions, 0);
  assert.ok(Object.values(run.tasks).every(task => task.status === 'cancelled'));
});

test('a new runtime reconstructs and completes a partially persisted run', async () => {
  const { port, runtime } = await setup();
  const partial = await runtime.tick('run-1');
  assert.equal(partial.tasks.profile.status, 'completed');
  assert.equal(partial.tasks.coverage.status, 'pending');

  const restartedPort = new MemoryCoverageAnalysisPort(port.snapshot());
  const restartedRuntime = createCoverageAnalysisRuntime({ port: restartedPort });
  const complete = await restartedRuntime.runUntilSettled('run-1');
  assert.equal(complete.status, 'completed');
  assert.equal(complete.tasks.release.output.status, 'released');
  assert.ok(complete.tasks.coverage.output.facts.length > 0);
});

test('a claimed fixture task is recovered once after process interruption', async () => {
  const { port } = await setup();
  const persisted = await port.loadRun('run-1');
  persisted.status = 'running';
  persisted.tasks.profile.status = 'running';
  persisted.tasks.profile.attempts = 1;
  persisted.revision += 1;
  port.records.set(persisted.id, clone(persisted));

  const runtime = createCoverageAnalysisRuntime({ port });
  const settled = await runtime.runUntilSettled('run-1');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.tasks.profile.attempts, 2);
});
