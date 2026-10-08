import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase, sql } from './helpers/test-database.js';
import { createApiServer } from '../src/server/server.js';
import { createGeminiCoverageRegistryFactory } from '../src/modules/ai-analysis/index.js';

const bootstrapToken = 'knowvia-live-test-bootstrap-token-001';
const liveEnv = {
  KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken,
  LLM_PROVIDER: 'google',
  GEMINI_API_KEY: 'test-only-not-a-real-key',
  LLM_MODEL: 'mock-gemini',
  LLM_MODEL_VERSION: 'mock-gemini-v1',
  LLM_INPUT_USD_PER_MILLION: '0.75',
  LLM_OUTPUT_USD_PER_MILLION: '4.50',
  ORCHESTRATION_RUN_BUDGET_USD: '0.25',
  ORCHESTRATION_PROJECT_BUDGET_USD: '5',
  LLM_MAX_CONCURRENT_CALLS: '2',
  LLM_TIMEOUT_MS: '30000',
};

function mockOutput(agentId, input) {
  const citation = input.sources[0].id;
  if (agentId.endsWith('question_drafting')) {
    const unresolvedSourceIds = input.sources.filter(source => source.status !== 'known').map(source => source.id);
    return {
      questions: unresolvedSourceIds.map((id, index) => ({ id: `q-${index}`, text: 'What does the authorised institution confirm?', authorityOwner: 'insurer', citations: [id] })),
      unresolvedSourceIds,
    };
  }
  if (agentId.endsWith('evidence_synthesis')) {
    return { statements: [{ id: 's-1', text: 'Reviewed evidence remains subject to institutional confirmation.', kind: 'observation', citations: [citation] }], unknowns: [], summary: 'Reviewed evidence is structured; deterministic gates retain authority.' };
  }
  return {
    facts: [{ id: 'f-1', field: input.context.requestedFields[0], value: 'model extracted value', status: 'known', citations: [citation] }],
    summary: 'One requested source-linked field was extracted.',
  };
}

function liveRegistryFactory() {
  return createGeminiCoverageRegistryFactory({
    env: liveEnv,
    loadModel: async () => ({ mocked: true }),
    createAgent: settings => ({
      generate: async ({ prompt }) => ({
        output: mockOutput(settings.id, JSON.parse(prompt)),
        totalUsage: { inputTokens: 10, outputTokens: 5 },
      }),
    }),
  });
}

async function start(database) {
  const server = createApiServer({ database, env: liveEnv, analysisLiveRegistryFactory: liveRegistryFactory() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server,
    async call(path, { method = 'GET', body, token, idempotencyKey } = {}) {
      const response = await fetch(base + path, {
        method,
        headers: {
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, data: await response.json() };
    },
  };
}

test('persistent HTTP workflow executes only model-eligible roles with explicit permission and usage metadata', async t => {
  const database = await createTestDatabase();
  const app = await start(database);
  t.after(async () => {
    await new Promise(resolve => app.server.close(resolve));
    await database.close();
  });

  const identity = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Synthetic live household', owner: { displayName: 'Synthetic owner' } } });
  const token = identity.data.session.token;
  const created = await app.call('/api/v1/cases', { method: 'POST', token, body: { householdId: identity.data.household.id, subjectMemberId: identity.data.ownerMember.id, openedByAdultId: identity.data.owner.id, triggerType: 'renewal' } });
  const collecting = await app.call(`/api/v1/cases/${created.data.id}/transitions`, { method: 'POST', token, body: { toStatus: 'collecting', expectedRevision: created.data.revision, actorId: identity.data.owner.id } });
  await app.call(`/api/v1/cases/${created.data.id}/transitions`, { method: 'POST', token, body: { toStatus: 'processing', expectedRevision: collecting.data.revision, actorId: identity.data.owner.id } });
  const consent = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId: identity.data.household.id, subjectAdultId: identity.data.owner.id, purpose: 'coverage_reconstruction', scopes: [{ resourceType: 'case', resourceId: created.data.id, action: 'derive', dataCategory: 'insurance_document' }, { resourceType: 'case', resourceId: created.data.id, action: 'read', dataCategory: 'analysis_summary', recipient: identity.data.owner.id }] },
  });
  const documentConsent = await app.call('/api/v1/consents', {
    method: 'POST', token,
    body: { householdId: identity.data.household.id, subjectAdultId: identity.data.owner.id, purpose: 'document_processing', scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }] },
  });
  const at = new Date().toISOString();
  await sql.run(database, `INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, logical_document_id, source_version)
    VALUES ('document-live', ?, ?, ?, ?, 'policy_schedule', 'synthetic.pdf',
      'protected/document-live', ?, 'application/pdf', 128, 'clean', 'encrypted_local',
      'active', ?, 'logical-live', '1')`, identity.data.household.id, created.data.id, identity.data.owner.id, documentConsent.data.id, 'a'.repeat(64), at);
  await sql.run(database, `INSERT INTO ocr_jobs
    (id, document_upload_id, provider, provider_job_ref, status, attempt_count, requested_at,
     completed_at, contract_version, authorization_json, result_json, result_digest, updated_at)
    VALUES ('ocr-live', 'document-live', 'fixture', 'fixture-live', 'succeeded', 1, ?, ?,
      'knowvia.ocr.v1', '{}', '{}', ?, ?)`, at, at, 'b'.repeat(64), at);
  await sql.run(database, `INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, confidence_basis_points, created_at,
     output_contract_version, text_sha256, provider_page_ref, provenance_json)
    VALUES ('page-live', 'document-live', 'ocr-live', 1, '1', ?,
      'Synthetic schedule: room rent limit is 5000.', 'extracted', 9000, ?,
      'knowvia.ocr.v1', ?, 'fixture-page-1', '{}')`, 'c'.repeat(64), at, 'd'.repeat(64));

  const denied = await app.call(`/api/v1/cases/${created.data.id}/analysis-runs`, { method: 'POST', token, idempotencyKey: 'live-no-permission', body: { consentGrantId: consent.data.id, executionMode: 'live', modelPermission: false } });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'MODEL_PERMISSION_REQUIRED');

  const analysis = await app.call(`/api/v1/cases/${created.data.id}/analysis-runs`, { method: 'POST', token, idempotencyKey: 'live-with-permission', body: { consentGrantId: consent.data.id, executionMode: 'live', modelPermission: true } });
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

  const persisted = JSON.parse((await sql.get(database, 'SELECT input_json FROM workflow_runs WHERE id = ?', analysis.data.id)).input_json);
  assert.equal(persisted.modelPermission, true);
  const outputs = (await sql.all(database, 'SELECT task_kind, output_json FROM workflow_tasks WHERE workflow_run_id = ?', analysis.data.id)).map(row => ({ taskKind: row.task_kind, output: JSON.parse(row.output_json) }));
  const modelOutputs = outputs.filter(item => item.output.producer.execution);
  assert.equal(modelOutputs.length, 5);
  assert.ok(modelOutputs.every(item => item.output.producer.owner === 'model_assist'));
  assert.ok(outputs.filter(item => !item.output.producer.execution).every(item => item.output.producer.owner === 'deterministic'));
});

test('Gemini live registry fails closed when provider configuration is incomplete', () => {
  const factory = createGeminiCoverageRegistryFactory({ env: { LLM_PROVIDER: 'google' } });
  assert.throws(() => factory(), { code: 'LIVE_AI_CONFIG_INVALID' });
});
