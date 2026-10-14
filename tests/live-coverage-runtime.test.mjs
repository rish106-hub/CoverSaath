import test from 'node:test';
import assert from 'node:assert/strict';
import { RUNTIME_AI_TASK_KEYS, createGeminiCoverageRegistryFactory } from '../src/modules/ai-analysis/index.js';
import { GEMINI_MODEL_RECIPIENT, resolveCanonicalParameterPolicy } from '../src/modules/ai-analysis/live-coverage-runtime.js';
import { COVERAGE_ANALYSIS_WORKFLOW } from '../src/modules/coverage-analysis/index.js';
import { auditActions, liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';

function liveRegistryFactory({ modelRequests = [], loadedModels = [], ...factoryOptions } = {}) {
  return createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver({ modelRequests, loadedModels }),
    preDispatchValidator: async () => true,
    ...factoryOptions,
  });
}

test('persistent HTTP workflow executes only model-eligible roles with explicit permission and usage metadata', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const { database } = app;
  const scenario = await setupLiveCase(app);

  const denied = await app.call(`/api/v1/cases/${scenario.caseId}/analysis-runs`, { method: 'POST', token: scenario.token, idempotencyKey: 'live-no-permission', body: { consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: false } });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'MODEL_PERMISSION_REQUIRED');

  const analysis = await scenario.startLiveRun('live-with-permission');
  assert.equal(analysis.status, 202);
  assert.equal(analysis.data.executionMode, 'live');
  assert.equal(analysis.data.externalProviderCalls, true);
  assert.equal(analysis.data.tasks.length, 22);
  assert.equal(analysis.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(analysis.data.modelUsage.calls, 5);
  assert.equal(analysis.data.modelUsage.inputTokens, 50);
  assert.equal(analysis.data.modelUsage.outputTokens, 25);
  assert.equal(analysis.data.modelUsage.totalTokens, 75);
  assert.ok(analysis.data.modelUsage.costUsd > 0);
  assert.deepEqual(analysis.data.modelUsage.providers, ['google']);
  assert.deepEqual(analysis.data.modelUsage.models, ['mock-gemini']);

  // Deterministic tasks never reach the model gateway: exactly the five model-eligible
  // roles call the model, once each, and no deterministic task key appears in any request.
  const modelTasks = COVERAGE_ANALYSIS_WORKFLOW.tasks.filter(task => task.owner === 'model_assist');
  const deterministicTasks = COVERAGE_ANALYSIS_WORKFLOW.tasks.filter(task => task.owner !== 'model_assist');
  assert.equal(COVERAGE_ANALYSIS_WORKFLOW.tasks.length, 22);
  assert.equal(modelTasks.length, 5);
  assert.deepEqual(modelTasks.map(task => task.key).sort(), [...RUNTIME_AI_TASK_KEYS].sort());
  assert.equal(modelRequests.length, modelTasks.length);
  assert.equal(modelRequests.length, analysis.data.modelUsage.calls);
  assert.deepEqual(modelRequests.map(request => request.agentId).sort(), [
    'knowvia-evidence_synthesis', 'knowvia-group_cover_extraction', 'knowvia-personal_cover_extraction',
    'knowvia-profile_extraction', 'knowvia-question_drafting',
  ]);
  assert.equal(new Set(modelRequests.map(request => request.agentId)).size, modelRequests.length, 'no model task may execute twice');
  for (const task of deterministicTasks) {
    for (const request of modelRequests) {
      assert.ok(!request.agentId.includes(task.kind), `deterministic task ${task.key} must not be a model agent`);
      assert.ok(!request.agentId.endsWith(`-${task.key}`), `deterministic task ${task.key} must not be a model agent`);
    }
  }
  // No duplicate task executions: one persisted task per workflow key, each attempted exactly once.
  const persistedTasks = database.prepare('SELECT agent_name, attempt_count, status FROM workflow_tasks WHERE workflow_run_id = ?').all(analysis.data.id);
  assert.equal(persistedTasks.length, 22);
  assert.equal(new Set(persistedTasks.map(task => task.agent_name)).size, 22);
  assert.ok(persistedTasks.every(task => task.attempt_count === 1 && task.status === 'completed'));

  // The production pre-dispatch validator ran from the default server path
  // exactly once per provider call, for this run, and allowed every one.
  const authorized = auditActions(database, 'analysis.model_dispatch_authorized').filter(event => event.resourceId === analysis.data.id);
  assert.equal(authorized.length, modelRequests.length);
  assert.equal(auditActions(database, 'analysis.model_dispatch_denied').length, 0);
  assert.deepEqual(authorized.map(event => event.payload.task).sort(), [
    'evidence_synthesis', 'group_cover_extraction', 'personal_cover_extraction', 'profile_extraction', 'question_drafting',
  ]);
  assert.ok(authorized.every(event => event.payload.modelRecipient === GEMINI_MODEL_RECIPIENT && event.payload.sourceCount === 1 && event.payload.reasonCode === null));

  // Raw internal identifiers never reach the provider.
  const providerBody = JSON.stringify(modelRequests);
  for (const raw of [scenario.caseId, scenario.ownerId, scenario.pageId, scenario.documentId, scenario.householdId]) {
    assert.ok(!providerBody.includes(raw), 'raw identifier must not reach the provider');
  }

  const persisted = JSON.parse(database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(analysis.data.id).input_json);
  assert.equal(persisted.modelPermission, true);
  assert.deepEqual(persisted.authorizedSourceIds, [scenario.pageId]);
  assert.deepEqual(persisted.authorizedSources, [{ sourceId: scenario.pageId, documentId: scenario.documentId }]);
  const outputs = database.prepare('SELECT task_kind, output_json FROM workflow_tasks WHERE workflow_run_id = ?').all(analysis.data.id).map(row => ({ taskKind: row.task_kind, output: JSON.parse(row.output_json) }));
  const modelOutputs = outputs.filter(item => item.output.producer.execution);
  assert.equal(modelOutputs.length, 5);
  assert.ok(modelOutputs.every(item => item.output.producer.owner === 'model_assist'));
  assert.ok(outputs.filter(item => !item.output.producer.execution).every(item => item.output.producer.owner === 'deterministic'));
});

test('Gemini live registry fails closed when provider configuration is incomplete', () => {
  const factory = createGeminiCoverageRegistryFactory({ env: { LLM_PROVIDER: 'google' } });
  assert.throws(() => factory(), { code: 'LIVE_AI_CONFIG_INVALID' });
});

test('a live registry cannot be created without a pre-dispatch consent validator', () => {
  const modelRequests = [];
  for (const preDispatchValidator of [undefined, null, true, 'allow', {}]) {
    const factory = createGeminiCoverageRegistryFactory({ env: liveEnv, ...stubModelDriver({ modelRequests }), preDispatchValidator });
    assert.throws(() => factory(), { code: 'LIVE_AI_CONFIG_INVALID' });
  }
  assert.equal(modelRequests.length, 0);
});

test('default parameter resolver is the canonical registry and fails closed for unknown, legacy and denied keys', () => {
  const allowed = resolveCanonicalParameterPolicy('d.room_rent_limit');
  assert.equal(allowed.registryVersion, 'policy-parameters/v1');
  assert.equal(allowed.modelExtraction.allowed, true);
  assert.notEqual(allowed.dataClass, 'RESTRICTED');
  const restricted = resolveCanonicalParameterPolicy('a.contract_and_member_identifiers');
  assert.equal(restricted.dataClass, 'RESTRICTED');
  assert.equal(restricted.modelExtraction.allowed, false);
  for (const key of ['room_rent_limit', 'subject_identity', 'displayName', 'copay', 'unclassified_policy_text', 'd.not_a_parameter', '', undefined, null, {}]) {
    assert.equal(resolveCanonicalParameterPolicy(key), null, `${String(key)} must not resolve`);
  }
});

function profileRuntime(requestedFields) {
  return {
    run: { id: 'run-synthetic', workflow_version: '5' },
    input: {
      authorizedSourceIds: ['page-synthetic'],
      profilePacket: {
        subjectId: 'subject-synthetic',
        source: { id: 'page-synthetic', version: '1', page: 1 },
        requestedFields,
        data: Object.fromEntries(requestedFields.map(field => [field, 'Synthetic schedule: room rent limit is 5000.'])),
      },
    },
    upstream: {},
  };
}

test('live registry rejects legacy aliases, unknown keys and restricted parameters before any model call', async () => {
  const modelRequests = [];
  const loadedModels = [];
  const registry = liveRegistryFactory({ modelRequests, loadedModels })();
  for (const [field, code] of [
    ['room_rent_limit', 'PARAMETER_NOT_CLASSIFIED'],
    ['subject_identity', 'PARAMETER_NOT_CLASSIFIED'],
    ['d.not_a_parameter', 'PARAMETER_NOT_CLASSIFIED'],
    ['a.contract_and_member_identifiers', 'PARAMETER_MODEL_DISALLOWED'],
  ]) {
    await assert.rejects(() => registry.profile(profileRuntime([field])), { code });
  }
  assert.equal(modelRequests.length, 0);
  assert.equal(loadedModels.length, 0, 'the model must not even be loaded when the privacy gate refuses');
  const result = await registry.profile(profileRuntime(['d.room_rent_limit']));
  assert.equal(result.modelMetadata.provider, 'google');
  assert.equal(modelRequests.length, 1);
});

test('an injected resolver that classifies nothing keeps the live registry closed', async () => {
  const modelRequests = [];
  const registry = liveRegistryFactory({ modelRequests, resolveParameterPolicy: () => null })();
  await assert.rejects(() => registry.profile(profileRuntime(['d.room_rent_limit'])), { code: 'PARAMETER_NOT_CLASSIFIED' });
  assert.equal(modelRequests.length, 0);
});

test('a throwing or non-affirmative validator denies dispatch with a stable code and no provider call', async () => {
  for (const preDispatchValidator of [
    async () => { throw new Error('database unavailable: page-synthetic subject-synthetic'); },
    () => { throw new TypeError('sync failure'); },
    async () => ({ allowed: 'true' }),
    async () => ({ allowed: false, reasonCode: 'SOURCE_CONSENT_NOT_CURRENT' }),
    async () => undefined,
    async () => 1,
  ]) {
    const modelRequests = [];
    const loadedModels = [];
    const registry = liveRegistryFactory({ modelRequests, loadedModels, preDispatchValidator })();
    await assert.rejects(() => registry.profile(profileRuntime(['d.room_rent_limit'])), error => {
      assert.equal(error.code, 'MODEL_DISPATCH_AUTHORIZATION_FAILED');
      assert.doesNotMatch(error.message, /page-synthetic|subject-synthetic|database unavailable|room rent/);
      return true;
    });
    assert.equal(modelRequests.length, 0);
    assert.equal(loadedModels.length, 0);
  }
});
