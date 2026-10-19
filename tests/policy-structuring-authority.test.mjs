import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { POLICY_STRUCTURING_VERSION, documentGrantCheck, structurePolicyDocument } from '../src/modules/policy-structuring/index.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

// W2 close-out: authority ceiling at the repository and database for every structuring observation,
// including a model-selected value, and the Gemini consent path through the whole pipeline.
// Synthetic insurer, values and people only; the fake provider never touches a network.
const run = 'run-parameters';
const document = 'document-parameters';
const household = 'household-parameters';
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const pages = [{ page: 2, blocks: [
  { text: 'Pre-existing diseases are covered after 3 Years of continuous cover.', tag: 'paragraph' },
  { text: 'Customer Information Sheet', tag: 'section-title' },
  { text: 'Pre-existing disease waiting period: 36 months.', tag: 'paragraph' },
  { text: 'Policy type: Individual.', tag: 'paragraph' },
] }];

// Extracts two contradicting PED readings and selects the first in reconciliation.
function selectingGemini(events = []) {
  const call = async ({ payload }) => {
    events.push(payload.chunks ? 'extract' : 'reconcile');
    if (!payload.chunks) {
      return { json: { conflicts: [{ group_id: 'registry:f.ped_waiting_period|policy', quotes: ['after 3 Years', 'waiting period: 36 months'], selected_quote: 'after 3 Years' }] }, usage: {} };
    }
    const items = [];
    for (const chunk of payload.chunks) {
      for (const [key, value, quote] of [['f.ped_waiting_period', '3 Years', 'after 3 Years'], ['f.ped_waiting_period', '36 months', 'waiting period: 36 months'], ['a.policy_type', 'Individual', 'Policy type: Individual']]) {
        if (chunk.text.includes(quote)) items.push({ chunk_id: chunk.chunk_id, registry_key: key, value, subject: 'policy', evidence_quote: quote, page: chunk.page, block_index: chunk.block_indexes.at(-1), confidence: 'high', rationale: 'Synthetic.' });
      }
    }
    return { json: { items }, usage: { inputTokens: 50, outputTokens: 10 } };
  };
  return call;
}

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: 'policy-parameters/v1', ...parameterScope(), updatedBy: 'test' });
  database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-gemini', 'consent-parameters', 'document', ?, 'derive', 'insurance_document', 'google-gemini', ?)`).run(document, at);
  return { database, services };
}

const grantCheck = (services, documentId = document) => documentGrantCheck({ consents: services.consents, grantId: 'consent-parameters', subjectAdultId: 'adult-parameters', documentId });
const commitWith = (services, consentCheck) => async ({ decisions, proposals }) => services.policyStructuring.commitStructuring({
  householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1',
  pipelineVersion: POLICY_STRUCTURING_VERSION, registryVersion: 'policy-parameters/v1', recordedBy: 'policy-structuring',
  decisions, proposals, consentCheck, at,
});
const resolution = (services, key) => services.coverageParameters.listForRun(run).find(record => record.parameterKey === key);
const structuringObservations = database => database.prepare(`SELECT observation.*, record.parameter_key FROM coverage_parameter_observations observation
  JOIN coverage_parameter_records record ON record.id = observation.parameter_record_id WHERE observation.recorded_by = 'policy-structuring'`).all();
const storedCount = database => database.prepare("SELECT count(*) AS count FROM coverage_parameter_observations WHERE recorded_by = 'policy-structuring'").get().count
  + database.prepare('SELECT count(*) AS count FROM proposed_parameters').get().count
  + database.prepare('SELECT count(*) AS count FROM policy_structuring_runs').get().count;

test('a model-selected value is stored extracted_unverified with every reading, and nothing can lift it higher', async t => {
  const { database, services } = open(t);
  const check = grantCheck(services);
  const result = await structurePolicyDocument({ pages, call: selectingGemini(), consentCheck: check, commit: commitWith(services, check), env: enabled });
  const ped = result.decisions.find(decision => decision.parameterKey === 'f.ped_waiting_period');
  assert.deepEqual([ped.state, ped.reasonCode, ped.observations.length], ['extracted_unverified', 'model_selected_from_conflict', 2]);

  const record = resolution(services, 'f.ped_waiting_period');
  assert.deepEqual([record.resolutionState, record.authority, record.resolutionReasonCode], ['extracted_unverified', 'model', 'model_selected_from_conflict']);
  const rows = structuringObservations(database);
  assert.equal(rows.filter(row => row.parameter_key === 'f.ped_waiting_period').length, 2, 'both readings are stored beside the selection');
  assert.ok(rows.every(row => row.extraction_method === 'document_extraction' && row.review_status === 'not_reviewed'));

  // Database: no structuring observation supports proven, calculated or dynamic under any authority,
  // and 'verified' is not a state at all.
  const lift = (recordId, observationId, state, authority) => database.prepare(`UPDATE coverage_parameter_resolutions
    SET resolution_state = ?, transition_authority = ?, resolved_observation_id = ?, resolved_value_json = '{"text":"3 Years"}', reason_code = 'forced'
    WHERE parameter_record_id = ?`).run(state, authority, observationId, recordId);
  for (const row of rows) {
    for (const state of ['proven', 'calculated', 'dynamic', 'verified', 'reported']) {
      for (const authority of ['model', 'deterministic', 'human_reviewer', 'official_source']) {
        assert.throws(() => lift(row.parameter_record_id, row.id, state, authority), /not supported by the observation|CHECK constraint failed/, `${state} by ${authority}`);
      }
    }
    // The observation cannot be marked accepted (the precondition for proven) or re-typed in place.
    assert.throws(() => database.prepare("UPDATE coverage_parameter_observations SET review_status = 'accepted' WHERE id = ?").run(row.id), /append only/);
    assert.throws(() => database.prepare("UPDATE coverage_parameter_observations SET extraction_method = 'human_review' WHERE id = ?").run(row.id), /append only/);
  }
  // Repository: the same through setResolution, citing the model-selected observation.
  const selected = rows.find(row => row.parameter_key === 'f.ped_waiting_period' && row.id === database.prepare(
    'SELECT resolved_observation_id AS id FROM coverage_parameter_resolutions WHERE parameter_record_id = ?').get(row.parameter_record_id).id);
  assert.ok(selected, 'the resolution cites the selected observation');
  for (const state of ['proven', 'calculated', 'dynamic']) {
    for (const authority of [null, 'model', 'deterministic', 'human_reviewer', 'official_source']) {
      assert.throws(() => services.coverageParameters.setResolution({
        parameterRecordId: selected.parameter_record_id, state, observationId: selected.id, resolvedValue: { text: '3 Years' }, authority, updatedBy: 'test', at,
      }), `${state} by ${authority}`);
    }
  }
  assert.equal(resolution(services, 'f.ped_waiting_period').resolutionState, 'extracted_unverified');
});

test('the repository refuses a model-selected decision above extracted_unverified', t => {
  const { database, services } = open(t);
  const observations = [
    { value: { text: '3 Years', normalized: null, subject: 'policy' }, page: 2, blockIndex: 0, evidenceQuote: 'after 3 Years' },
    { value: { text: '36 months', normalized: null, subject: 'policy' }, page: 2, blockIndex: 2, evidenceQuote: 'waiting period: 36 months' },
  ];
  const attempt = state => services.policyStructuring.commitStructuring({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion: `authority-test/${state}`,
    registryVersion: 'policy-parameters/v1', recordedBy: 'policy-structuring', at, consentCheck: grantCheck(services), proposals: [],
    decisions: [{ parameterKey: 'f.ped_waiting_period', state, reasonCode: 'model_selected_from_conflict', selectedQuote: 'after 3 Years', observations }],
  });
  for (const state of ['proven', 'calculated', 'dynamic', 'verified', 'reported', 'conflicting', 'unknown']) {
    assert.throws(() => attempt(state), { code: 'STRUCTURING_DECISION_INVALID' }, state);
  }
  assert.equal(storedCount(database), 0);
  assert.equal(attempt('extracted_unverified').replayed, false, 'the ceiling state itself is accepted');
});

test('consent is checked before every provider call, before commit and again inside the commit transaction', async t => {
  const { database, services } = open(t);
  const events = [];
  const grant = grantCheck(services);
  const check = () => { events.push(database.isTransaction ? 'consent-in-transaction' : 'consent'); return grant(); };
  await structurePolicyDocument({ pages, call: selectingGemini(events), consentCheck: check, commit: commitWith(services, check), env: enabled, limits: { maxChunksPerCall: 1 } });
  const calls = events.filter(event => event === 'extract' || event === 'reconcile').length;
  assert.ok(calls >= 3, 'several extraction calls and one reconcile call');
  events.forEach((event, index) => {
    if (event === 'extract' || event === 'reconcile') assert.equal(events[index - 1], 'consent', `call ${index} was not preceded by a consent check`);
  });
  assert.deepEqual(events.slice(-2), ['consent', 'consent-in-transaction']);
});

test('the grant must be document-specific for google-gemini; another document or recipient does not count', t => {
  const { database, services } = open(t);
  assert.doesNotThrow(grantCheck(services));
  database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-other-model', 'consent-parameters', 'document', 'document-other', 'derive', 'insurance_document', 'openai-gpt', ?)`).run(at);
  assert.throws(grantCheck(services, 'document-other'), { code: 'CONSENT_SCOPE_REQUIRED' }, 'another recipient for that document');
  assert.throws(grantCheck(services, 'document-unknown'), error => ['CONSENT_SCOPE_REQUIRED', 'CONSENT_REQUIRED'].includes(error.code));
});

test('consent withdrawn mid-run stops further calls and stores nothing', async t => {
  const { database, services } = open(t);
  const events = [];
  const base = selectingGemini(events);
  const call = async request => {
    const answer = await base(request);
    if (events.length === 1) services.consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters' });
    return answer;
  };
  const check = grantCheck(services);
  await assert.rejects(structurePolicyDocument({ pages, call, consentCheck: check, commit: commitWith(services, check), env: enabled, limits: { maxChunksPerCall: 1 } }),
    error => ['CONSENT_REQUIRED', 'CONSENT_SCOPE_REQUIRED'].includes(error.code));
  assert.deepEqual(events, ['extract'], 'no provider call after the withdrawal');
  assert.equal(storedCount(database), 0);
});

test('consent lost only inside the commit transaction stores nothing', async t => {
  const { database, services } = open(t);
  const grant = grantCheck(services);
  const check = () => {
    if (database.isTransaction) throw Object.assign(new Error('Active subject-scoped consent is required.'), { code: 'CONSENT_REQUIRED' });
    return grant();
  };
  await assert.rejects(structurePolicyDocument({ pages, call: selectingGemini(), consentCheck: check, commit: commitWith(services, check), env: enabled }), { code: 'CONSENT_REQUIRED' });
  assert.equal(storedCount(database), 0);
  assert.equal(resolution(services, 'f.ped_waiting_period').resolutionState, 'unknown');
});
