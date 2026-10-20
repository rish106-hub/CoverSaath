import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/backend-services.js';
import { POLICY_STRUCTURING_VERSION, documentGrantCheck, structurePolicyDocument } from '../src/features/policy-structuring/index.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Fake-caller journey (plan acceptance 2): block pages in, real sectioner, privacy gate, extractor,
// reconciler and decisions, stored through the repository. Synthetic insurer and values only.
const run = 'run-parameters';
const document = 'document-parameters';
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const pages = [
  { page: 1, blocks: [{ text: 'Synthetic Assurance Ltd', tag: 'header' }, { text: 'Page 1', tag: 'page-number' }, { text: 'A seal with a lion', tag: 'image' }] },
  { page: 2, blocks: [
    { text: 'Synthetic Assurance Ltd', tag: 'header' },
    { text: 'Schedule of Benefits', tag: 'section-title' },
    { text: '<table><tr><td>Benefit</td><td>Limit</td></tr><tr><td>Policy type</td><td>Individual</td></tr><tr><td>Daily cash</td><td>Rs. 500 per day</td></tr></table>', tag: 'table' },
    { text: 'Waiting Periods', tag: 'section-title' },
    { text: 'Pre-existing diseases are covered after 3 Years of continuous cover.', tag: 'paragraph' },
    { text: 'Customer Information Sheet', tag: 'section-title' },
    { text: 'Pre-existing disease waiting period: 36 months.', tag: 'paragraph' },
    { text: 'Page 2', tag: 'page-number' },
  ] },
];

// Answers from the text it was sent, so every quote is a literal substring of the gated chunk.
function fakeGemini() {
  const calls = [];
  const call = async ({ payload }) => {
    calls.push(payload.chunks ? 'extract' : 'reconcile');
    if (!payload.chunks) return { json: { conflicts: [] }, usage: { inputTokens: 10, outputTokens: 2 } };
    const items = [];
    for (const chunk of payload.chunks) {
      const at = (key, value, quote, extra = {}) => chunk.text.includes(quote) && items.push({
        chunk_id: chunk.chunk_id, value, subject: 'policy', evidence_quote: quote, page: chunk.page, block_index: chunk.block_indexes.at(-1), ...key, ...extra,
      });
      at({ registry_key: 'a.policy_type' }, 'Individual', 'Policy type | Individual');
      at({ proposed: { proposed_key: 'synthetic_daily_cash', category: 'e', label: 'Daily cash' } }, 'Rs. 500 per day', 'Daily cash | Rs. 500 per day');
      at({ registry_key: 'f.ped_waiting_period' }, '3 Years', 'after 3 Years');
      at({ registry_key: 'f.ped_waiting_period' }, '36 months', 'waiting period: 36 months', { state: 'proven' });
      at({ registry_key: 'f.ped_waiting_period' }, '36 months', 'waiting period: 36 months');
    }
    return { json: { items }, usage: { inputTokens: 100, outputTokens: 20 } };
  };
  return { call, calls };
}

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(at) });
  services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion: 'policy-parameters/v1', ...parameterScope(), updatedBy: 'test' });
  addScope(database, { id: 'scope-gemini', documentId: document });
  return { database, services };
}

function addScope(database, { id, documentId = null, recipient = 'google-gemini' }) {
  database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES (?, 'consent-parameters', 'document', ?, 'derive', 'insurance_document', ?, ?)`).run(id, documentId, recipient, at);
}

const grantCheck = services => documentGrantCheck({ consents: services.consents, grantId: 'consent-parameters', subjectAdultId: 'adult-parameters', documentId: document, householdId: 'household-parameters' });
const commitWith = (services, consentCheck) => async ({ decisions, proposals }) => services.policyStructuring.commitStructuring({
  householdId: 'household-parameters', workflowRunId: run, documentId: document, sourceVersion: 'version-1',
  pipelineVersion: POLICY_STRUCTURING_VERSION, registryVersion: 'policy-parameters/v1', recordedBy: 'policy-structuring',
  decisions, proposals, consentCheck, at,
});
const resolution = (services, key) => services.coverageParameters.listForRun(run).find(record => record.parameterKey === key);

test('fake-caller journey stores observations and proposals and accounts for every chunk', async t => {
  const { database, services } = open(t);
  const gemini = fakeGemini();
  const check = grantCheck(services);
  const result = await structurePolicyDocument({ pages, call: gemini.call, consentCheck: check, commit: commitWith(services, check), env: enabled });

  assert.equal(result.report.chunks.unaccounted, 0);
  assert.deepEqual(result.report.skippedReasons, { none_returned: 1 }, "the title-only chunk is accounted, not dropped");
  assert.deepEqual(result.report.dropped, { boilerplate: 4, model_description: 1 });
  assert.equal(result.report.items.rejectedReasons.authority_state, 1, 'a model-claimed proven state is rejected');
  assert.deepEqual(gemini.calls, ['extract', 'extract', 'reconcile'], 'four chunks in batches of three');
  assert.deepEqual({ ...result.commit, structuringRunId: undefined }, {
    replayed: false, structuringRunId: undefined, observations: 3, parameters: 2, conflicting: 1, skippedKeys: 0, proposals: 1,
  });
  assert.equal(resolution(services, 'a.policy_type').resolutionState, 'extracted_unverified');
  assert.equal(resolution(services, 'f.ped_waiting_period').resolutionState, 'conflicting', '3 Years vs 36 months is surfaced, no winner');
  assert.deepEqual(services.policyStructuring.listProposals({ householdId: 'household-parameters', documentId: document, structuringRunId: result.commit.structuringRunId })
    .map(item => [item.proposedKey, item.status]), [['synthetic_daily_cash', 'pending_review']]);
  assert.equal(JSON.stringify(result.report).includes('Individual'), false, 'the coverage report carries counts, not text');

  const stored = JSON.parse(database.prepare(`SELECT value_json FROM coverage_parameter_observations
    WHERE recorded_by = 'policy-structuring' AND value_json LIKE '%Individual%'`).get().value_json);
  assert.deepEqual([stored.evidenceQuote, Number.isInteger(stored.blockIndex)], ['Policy type | Individual', true], 'quote and block kept for review');

  const again = await structurePolicyDocument({ pages, call: fakeGemini().call, consentCheck: check, commit: commitWith(services, check), env: enabled });
  assert.equal(again.commit.replayed, true);
  assert.equal(database.prepare('SELECT count(*) AS count FROM proposed_parameters').get().count, 1);

  const unpaid = fakeGemini();
  const skipped = await structurePolicyDocument({ pages, call: unpaid.call, consentCheck: check, env: enabled,
    alreadyStored: () => services.policyStructuring.getStructuringRun({ householdId: 'household-parameters', workflowRunId: run, documentId: document }) !== null });
  assert.equal(skipped.replayed, true);
  assert.equal(unpaid.calls.length, 0, 'an already structured document makes no provider call');
});

test('section titles are privacy-gated like chunk text before any call', async () => {
  const leaky = [{ page: 1, blocks: [
    { text: 'Insured: Synthetic Person, phone 9876543210, email synth.person@example.com', tag: 'section-title' },
    { text: '<table><tr><td>Policy type</td><td>Individual</td></tr></table>', tag: 'table' },
    { text: 'Daily cash is Rs. 500 per day.', tag: 'paragraph' },
  ] }];
  const sent = [];
  const call = async ({ payload }) => { sent.push(JSON.stringify(payload)); return { json: payload.chunks ? { items: [] } : { conflicts: [] }, usage: {} }; };
  await structurePolicyDocument({ pages: leaky, call, consentCheck: () => {}, env: enabled });
  assert.ok(sent.length > 0);
  for (const payload of sent) {
    for (const raw of ['9876543210', 'synth.person@example.com']) assert.equal(payload.includes(raw), false, `${raw} reached the provider`);
  }
});

test('the Gemini grant must name this document and the google-gemini recipient', t => {
  const { database, services } = open(t);
  const check = documentId => documentGrantCheck({ consents: services.consents, grantId: 'consent-parameters', subjectAdultId: 'adult-parameters', documentId, householdId: 'household-parameters' });
  assert.doesNotThrow(check(document));
  addScope(database, { id: 'scope-any-document' });
  assert.throws(check('document-unnamed'), { code: 'CONSENT_SCOPE_REQUIRED' }, 'a scope without a document id is not document-specific');
  database.prepare("UPDATE consent_scopes SET recipient = 'openai-gpt' WHERE id = 'scope-gemini'").run();
  assert.throws(check(document), { code: 'CONSENT_SCOPE_REQUIRED' });
});

test('consent withdrawn between extraction and commit stores nothing', async t => {
  const { database, services } = open(t);
  let allowed = true;
  const check = () => { if (!allowed) throw Object.assign(new Error('revoked'), { code: 'CONSENT_REQUIRED' }); return grantCheck(services)(); };
  const call = async args => { const answer = await fakeGemini().call(args); if (!args.payload.chunks) allowed = false; return answer; };
  await assert.rejects(structurePolicyDocument({ pages, call, consentCheck: check, commit: commitWith(services, check), env: enabled }), { code: 'CONSENT_REQUIRED' });
  assert.equal(database.prepare("SELECT count(*) AS count FROM coverage_parameter_observations WHERE recorded_by = 'policy-structuring'").get().count, 0);
  assert.equal(database.prepare('SELECT count(*) AS count FROM proposed_parameters').get().count, 0);
});

test('the pipeline is off unless POLICY_STRUCTURING_ENABLED is true, before any call', async () => {
  const gemini = fakeGemini();
  await assert.rejects(structurePolicyDocument({ pages, call: gemini.call, consentCheck: () => {}, env: {} }), { code: 'STRUCTURING_DISABLED' });
  assert.equal(gemini.calls.length, 0);
});
