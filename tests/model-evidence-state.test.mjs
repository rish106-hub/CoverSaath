import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoverageAnalysisFixtureInput,
  createCoverageAnalysisRuntime,
  decomposePolicySection,
} from '../src/features/coverage-analysis/index.js';
import {
  MODEL_EXTRACTED_UNVERIFIED,
  createTaskOutputEnvelope,
  validateTaskOutputEnvelope,
} from '../src/features/coverage-analysis/agent-contracts.js';
import { setupLiveCase, startLiveServer } from './support/live-analysis-scenario.mjs';

const MODEL_TASK_KINDS = ['profile_intake', 'group_cover_analysis', 'personal_cover_analysis', 'question_drafting', 'bounded_synthesis'];

function taskOutputs(database, runId) {
  return database.prepare('SELECT task_kind, output_json FROM workflow_tasks WHERE workflow_run_id = ?').all(runId)
    .map(row => ({ taskKind: row.task_kind, envelope: JSON.parse(row.output_json) }));
}

test('live HTTP run: no model-derived fact or envelope is Proven or document-backed, and the release is not released', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app);
  const run = await scenario.startLiveRun();

  assert.equal(run.status, 202);
  assert.equal(run.data.tasks.length, 22);
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(run.data.modelUsage.calls, 5);
  assert.equal(modelRequests.length, 5);

  const outputs = taskOutputs(app.database, run.data.id);
  const modelEnvelopes = outputs.filter(item => item.envelope.producer.execution);
  assert.deepEqual(modelEnvelopes.map(item => item.taskKind).sort(), [...MODEL_TASK_KINDS].sort());
  for (const { taskKind, envelope } of modelEnvelopes) {
    // Model output can only ever be an unverified candidate or a conflict.
    assert.ok(['Unknown', 'Conflicting'].includes(envelope.evidenceState), `${taskKind} envelope was ${envelope.evidenceState}`);
    assert.doesNotMatch(JSON.stringify(envelope.payload), /document[-_]backed/i, `${taskKind} must not carry a document-backed status`);
  }

  // Extracted facts are explicit, unverified and carried into the coverage graph as such.
  const coverage = outputs.find(item => item.taskKind === 'coverage_graph').envelope.payload;
  const modelFacts = coverage.facts.filter(fact => fact.status === MODEL_EXTRACTED_UNVERIFIED);
  assert.equal(modelFacts.length, 3, 'profile, group and personal each produced one unverified fact');
  assert.ok(coverage.facts.every(fact => fact.status !== 'known' && !/document[-_]backed/i.test(fact.status)));
  assert.ok(coverage.unknowns.some(unknown => /awaits review/.test(unknown)));

  // Nothing downstream promotes them either.
  for (const item of outputs.filter(entry => entry.taskKind.startsWith('policy_decomposition_') || entry.taskKind === 'coverage_graph')) {
    for (const fact of item.envelope.payload.facts ?? []) {
      if (fact.status === MODEL_EXTRACTED_UNVERIFIED) continue;
      assert.notEqual(fact.evidenceState, 'Proven', `${item.taskKind}:${fact.field}`);
    }
  }

  // Release: review-required, expressed with the existing blocked vocabulary.
  const evidence = outputs.find(item => item.taskKind === 'evidence_review').envelope.payload;
  assert.equal(evidence.status, 'blocked');
  assert.deepEqual([...new Set(evidence.findings.map(finding => finding.code))], ['HUMAN_REVIEW_REQUIRED']);
  assert.equal(evidence.findings.length, 3);
  const synthesis = outputs.find(item => item.taskKind === 'bounded_synthesis').envelope.payload;
  const release = outputs.find(item => item.taskKind === 'deterministic_release_gate').envelope.payload;
  assert.equal(synthesis.status, 'blocked');
  assert.notEqual(release.status, 'released');
  assert.equal(release.status, 'blocked');
  assert.equal(release.externalActionsAuthorized, false);
  assert.deepEqual(release.blockers, synthesis.blockers);
  assert.equal(app.database.prepare('SELECT status FROM workflow_runs WHERE id = ?').get(run.data.id).status, 'blocked');
});

const personalPayload = assertionStatus => ({
  agent: 'personal-health-cover-agent',
  dimensions: {
    protection: { assertions: [] },
    constraints: { assertions: assertionStatus ? [{ id: 'a-1', field: 'copay', value: '10%', status: assertionStatus }] : [] },
    economics: { assertions: [] },
    suitability: { assertions: [] },
  },
});
const run = { id: 'run-1', caseId: 'case-1', workflowName: 'w', workflowVersion: '6', input: {} };
const modelMetadata = { mode: 'live', calls: 1, totalTokens: 15, costUsd: 0.001, provider: 'google', model: 'm' };

test('evidence state fails closed: Proven only on explicit positive markers set by deterministic code', () => {
  // Unrecognised content used to default to Proven.
  assert.equal(createTaskOutputEnvelope({ key: 'personal', payload: personalPayload(null), run }).evidenceState, 'Unknown');
  assert.equal(createTaskOutputEnvelope({ key: 'personal', payload: personalPayload('known'), run }).evidenceState, 'Unknown');
  assert.equal(createTaskOutputEnvelope({ key: 'personal', payload: personalPayload('anything_else'), run }).evidenceState, 'Unknown');
  assert.equal(createTaskOutputEnvelope({ key: 'personal', payload: personalPayload('document_backed'), run }).evidenceState, 'Proven');
  assert.equal(createTaskOutputEnvelope({ key: 'personal', payload: personalPayload('conflicting'), run }).evidenceState, 'Conflicting');

  const decomposed = status => decomposePolicySection('financialRules', {
    facts: [{ id: 'f-1', field: 'room_rent_limit', value: '5000', status, source: { id: 'schedule', page: 1, version: 'v1' } }],
  }).facts.find(fact => fact.field === 'room_rent_limit').evidenceState;
  for (const status of ['known', 'weird', '', undefined, null, MODEL_EXTRACTED_UNVERIFIED, 'model_extracted']) {
    assert.equal(decomposed(status), 'Unknown', String(status));
  }
  for (const status of ['document_backed', 'document-backed', 'proven', 'human_reviewed']) assert.equal(decomposed(status), 'Proven', status);
  assert.equal(decomposed('institution_confirmed'), 'Dynamic');
  assert.equal(decomposed('user_stated'), 'Reported');
});

test('a model-produced envelope can never be Proven, Calculated or Dynamic, even if its text claims it', () => {
  const claiming = personalPayload('document_backed');
  claiming.modelMetadata = modelMetadata;
  claiming.note = 'proven, verified, human reviewed, institution confirmed, dynamic, calculated';
  const envelope = createTaskOutputEnvelope({ key: 'personal', payload: claiming, run });
  assert.equal(envelope.evidenceState, 'Unknown');

  const conflicting = personalPayload('conflicting');
  conflicting.modelMetadata = modelMetadata;
  assert.equal(createTaskOutputEnvelope({ key: 'personal', payload: conflicting, run }).evidenceState, 'Conflicting');

  // Deterministic-keyed tasks that were executed by a model are capped as well.
  const synthesis = {
    status: 'ready', unknowns: [], blockers: [], questions: [], householdAction: {}, modelMetadata,
  };
  assert.equal(createTaskOutputEnvelope({ key: 'primary', payload: synthesis, run }).evidenceState, 'Unknown');

  // The contract rejects a hand-built model envelope that asserts higher authority.
  for (const state of ['Proven', 'Calculated', 'Dynamic', 'Reported']) {
    const forged = { ...createTaskOutputEnvelope({ key: 'personal', payload: claiming, run }), evidenceState: state };
    assert.throws(() => validateTaskOutputEnvelope('personal', forged), { code: 'AGENT_CONTRACT_INVALID' }, state);
  }
});

test('fixture mode keeps its intended evidence states explicitly', async () => {
  const records = new Map();
  const port = {
    async createRun(value) { records.set(value.id, structuredClone(value)); return structuredClone(value); },
    async loadRun(id) { return records.has(id) ? structuredClone(records.get(id)) : null; },
    async replaceRun(value, { expectedRevision }) {
      if (records.get(value.id).revision !== expectedRevision) throw new Error('Stale run revision.');
      records.set(value.id, structuredClone(value));
      return structuredClone(value);
    },
  };
  const runtime = createCoverageAnalysisRuntime({ port });
  const input = createCoverageAnalysisFixtureInput({ id: 'case-1', opened_by_adult_id: 'adult-1', trigger_type: 'renewal', stated_estimate_minor: 0 });
  await runtime.createRun({ id: 'run-fixture', caseId: 'case-1', input });
  const settled = await runtime.runUntilSettled('run-fixture');
  assert.equal(settled.status, 'completed');
  assert.equal(settled.tasks.release.output.payload.status, 'released');

  const states = Object.fromEntries(Object.entries(settled.tasks).map(([key, task]) => [key, task.output.evidenceState]));
  assert.deepEqual(states, {
    profile: 'Unknown', group: 'Unknown', personal: 'Unknown', coverage: 'Unknown',
    documentIdentity: 'Calculated', continuity: 'Calculated', enrolment: 'Calculated', financialRules: 'Calculated',
    benefits: 'Calculated', exclusions: 'Calculated', hospitalAccess: 'Calculated', claimsProcess: 'Calculated',
    renewalChange: 'Calculated', serviceResearch: 'Calculated', decision: 'Calculated', householdAction: 'Calculated',
    evidence: 'Calculated', privacy: 'Calculated', safety: 'Calculated', questions: 'Calculated', primary: 'Calculated', release: 'Calculated',
  });
  // Deterministic synthetic fixture evidence is explicitly document-backed, so it stays Proven.
  const financial = settled.tasks.financialRules.output.payload.facts;
  assert.equal(financial.find(fact => fact.field === 'room_rent_limit').evidenceState, 'Proven');
  const constraints = settled.tasks.coverage.output.payload.facts.find(fact => fact.field === 'copay');
  assert.equal(constraints.status, 'document_backed');
});
