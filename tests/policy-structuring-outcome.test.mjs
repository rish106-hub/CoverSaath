import test from 'node:test';
import assert from 'node:assert/strict';
import { createPolicyStructuringService } from '../src/backend/services/policy-structuring-service.js';
import { POLICY_STRUCTURING_VERSION, documentGrantCheck, structurePolicyDocument } from '../src/features/policy-structuring/index.js';
import {
  MAX_SKIPPED_SHARE, MIN_ACCEPTED_ITEMS, decideOutcome, storedOutcome, structuringCriticalKeys,
} from '../src/features/policy-structuring/outcome.js';
import { parameterAt as at, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

// Processing status separated from evidence completeness (honest outcomes defect): a run with skipped
// chunks used to commit and report 'completed'. Fake callers only, zero network. Synthetic values only.
const pgOptions = postgresTestOptions();
const run = 'run-parameters';
const document = 'document-parameters';
const household = 'household-parameters';
const registryVersion = 'policy-parameters/v1';
const enabled = { POLICY_STRUCTURING_ENABLED: 'true' };
const criticalKeys = structuringCriticalKeys(registryVersion);

// One synthetic line per model-allowed critical key, each on its own page so every page is one chunk.
const LINES = Object.freeze({
  'a.add_ons_and_riders': 'Add-ons opted: Synthetic Care Rider',
  'a.insurer_tpa_group_administrator': 'Insurer: Synthetic Assurance Ltd',
  'a.policy_type': 'Policy type: Individual',
  'a.product_uin_and_version': 'Product UIN: SYNHLIP00000V010000',
  'b.policy_period': 'Policy period: 01/04/2026 to 31/03/2027',
  'd.co_pay_general': 'Co-payment: 10% of admissible claim',
  'd.icu_charge_limit': 'ICU charges: up to Rs. 10,000 per day',
  'd.room_rent_limit': 'Room rent: 1% of sum insured per day',
  'd.sum_insured': 'Sum insured: Rs. 5,00,000',
  'f.initial_waiting_period': 'Initial waiting period: 30 days',
  'f.ped_waiting_period': 'Pre-existing disease waiting period: 36 months',
  'f.specified_disease_procedure_waits': 'Specified disease waiting period: 24 months',
  'f.standard_exclusions_with_codes': 'Standard exclusions: Excl01 to Excl18',
  'i.premium_now': 'Total premium: Rs. 12,000',
});
const pagesFor = keys => keys.map((key, index) => ({
  page: index + 1,
  blocks: [{ text: `Section ${index + 1}`, tag: 'section-title' }, { text: LINES[key], tag: 'paragraph' }],
}));

// Answers every line it was sent; `fail(callNumber)` returns an error to throw for that extract call.
function fakeGemini({ fail = () => null } = {}) {
  const calls = [];
  const call = async ({ payload }) => {
    calls.push(payload.chunks ? 'extract' : 'reconcile');
    if (!payload.chunks) return { json: { conflicts: [] }, usage: { inputTokens: 10, outputTokens: 2 } };
    const error = fail(calls.filter(kind => kind === 'extract').length);
    if (error) throw error;
    const items = [];
    for (const chunk of payload.chunks) {
      for (const [key, line] of Object.entries(LINES)) {
        if (!chunk.text.includes(line)) continue;
        items.push({ chunk_id: chunk.chunk_id, registry_key: key, value: line.split(': ')[1], subject: 'policy',
          evidence_quote: line, page: chunk.page, block_index: chunk.block_indexes.at(-1) });
      }
    }
    return { json: { items }, usage: { inputTokens: 100, outputTokens: 20 } };
  };
  return { call, calls };
}
const providerError = () => Object.assign(new Error('synthetic provider failure'), { code: 'PROVIDER_FAILED' });
const budgetStop = () => Object.assign(new Error('synthetic budget refusal'), { code: 'budget_refused' });

async function open(t) {
  const { db: database, services } = await freshDatabase(t, { clock: () => new Date(at) });
  await seedParameterWorld(database);
  await services.coverageParameters.initializeRunParameters({ workflowRunId: run, registryVersion, ...parameterScope(), updatedBy: 'test' });
  await database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-gemini', 'consent-parameters', 'document', ?, 'derive', 'insurance_document', 'google-gemini', ?)`).run(document, at);
  // Every cited page exists for the document version.
  for (let page = 1; page <= Object.keys(LINES).length; page += 1) {
    if (page === 2) continue;
    await database.prepare(`INSERT INTO source_pages (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
      extracted_text, extraction_status, created_at, text_sha256)
      VALUES (?, ?, 'ocr-parameters', ?, 'version-1', ?, 'Synthetic clause', 'extracted', ?, ?)`)
      .run(`page-outcome-${page}`, document, page, 'b'.repeat(64), at, 'c'.repeat(64));
  }
  return { database, services };
}

const grantCheck = services => documentGrantCheck({ consents: services.consents, grantId: 'consent-parameters', subjectAdultId: 'adult-parameters', documentId: document, householdId: household });
function commitWith(services, consentCheck, commits) {
  return async ({ decisions, proposals, coverage, outcome }) => {
    commits.push(outcome);
    return services.policyStructuring.commitStructuring({
      householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1',
      pipelineVersion: POLICY_STRUCTURING_VERSION, registryVersion, recordedBy: 'policy-structuring',
      decisions, proposals, coverage, outcome, consentCheck, at,
    });
  };
}
const rows = async (database, table) => (await database.prepare(`SELECT count(*) AS n FROM ${table}`).get()).n;
const liveObservations = async database => (await database.prepare(`SELECT count(*) AS n FROM coverage_parameter_observations
  WHERE extraction_method = 'document_extraction'`).get()).n;

async function structure(t, { keys = criticalKeys, fail } = {}) {
  const { database, services } = await open(t);
  const gemini = fakeGemini({ fail });
  const check = grantCheck(services);
  const commits = [];
  const result = await structurePolicyDocument({
    pages: pagesFor(keys), call: gemini.call, consentCheck: check, commit: commitWith(services, check, commits), knownIdentifiers: [], env: enabled,
    limits: { maxChunksPerCall: 1 },
  });
  return { database, services, gemini, commits, result };
}

test('decideOutcome: thresholds are provisional named constants', () => {
  assert.equal(MIN_ACCEPTED_ITEMS, 1);
  assert.equal(MAX_SKIPPED_SHARE, 0.5);
  assert.ok(criticalKeys.includes('d.sum_insured'));
  assert.equal(criticalKeys.includes('a.contract_and_member_identifiers'), false, 'model-forbidden keys are not critical for structuring');
});

test('decideOutcome is deterministic over counts and never complete with skipped or unaccounted chunks', () => {
  const report = (overrides = {}) => ({ chunks: { total: 4, skipped: 0, unaccounted: 0 }, skippedReasons: {}, items: { accepted: 6 }, ...overrides });
  const all = { criticalKeys: ['d.sum_insured', 'f.ped_waiting_period'], presentKeys: ['d.sum_insured', 'f.ped_waiting_period'] };
  assert.deepEqual(decideOutcome(report(), all), { evidenceOutcome: 'complete', reasons: [], missingCriticalKeys: [] });
  assert.deepEqual(decideOutcome(report({ chunks: { total: 4, skipped: 1, unaccounted: 0 }, skippedReasons: { provider_error: 1 } }), all).evidenceOutcome,
    'partial_review_required');
  assert.equal(decideOutcome(report({ chunks: { total: 4, skipped: 0, unaccounted: 1 } }), all).evidenceOutcome, 'partial_review_required');
  assert.deepEqual(decideOutcome(report(), { ...all, presentKeys: ['d.sum_insured'] }), {
    evidenceOutcome: 'partial_review_required', reasons: ['critical_keys_missing'], missingCriticalKeys: ['f.ped_waiting_period'],
  });
  assert.equal(decideOutcome(report({ items: { accepted: 0 } }), all).evidenceOutcome, 'failed');
  assert.equal(decideOutcome(report({ chunks: { total: 4, skipped: 3, unaccounted: 0 }, skippedReasons: { provider_error: 3 } }), all).evidenceOutcome, 'failed');
  assert.equal(decideOutcome(report({ chunks: { total: 4, skipped: 3, unaccounted: 0 }, skippedReasons: { budget_stop: 3 } }), all).reasons.includes('budget_stop_before_half'), true);
  assert.equal(decideOutcome(report({ chunks: { total: 0, skipped: 0, unaccounted: 0 }, items: { accepted: 0 } }), all).evidenceOutcome, 'failed');
});

test('fake caller: every chunk read and every critical key present is complete', pgOptions, async t => {
  const { result, commits } = await structure(t);
  assert.deepEqual(result.report.skippedReasons, {});
  assert.deepEqual(result.outcome, { evidenceOutcome: 'complete', reasons: [], missingCriticalKeys: [] });
  assert.equal(commits.length, 1);
});

test('fake caller: one provider_error chunk with other evidence is partial_review_required and committed', pgOptions, async t => {
  const { database, result, services } = await structure(t, { fail: number => (number === 2 ? providerError() : null) });
  assert.equal(result.report.skippedReasons.provider_error, 1);
  assert.equal(result.outcome.evidenceOutcome, 'partial_review_required');
  assert.deepEqual(result.outcome.reasons, ['chunks_skipped', 'critical_keys_missing']);
  assert.equal(result.outcome.missingCriticalKeys.length, 1);
  const stored = await services.policyStructuring.getStructuringRun({ householdId: household, workflowRunId: run, documentId: document });
  assert.deepEqual(stored.counts.outcome, { evidenceOutcome: 'partial_review_required', reasons: ['chunks_skipped', 'critical_keys_missing'],
    missingCriticalKeys: result.outcome.missingCriticalKeys });
  assert.ok(await liveObservations(database) > 0);
});

test('fake caller: every chunk failing is a failed outcome that writes nothing', pgOptions, async t => {
  const { database, result, commits } = await structure(t, { fail: () => providerError() });
  assert.equal(result.outcome.evidenceOutcome, 'failed');
  assert.ok(result.outcome.reasons.includes('accepted_items_below_minimum'));
  assert.equal(result.commit, null);
  assert.equal(commits.length, 0, 'a failed outcome is never committed');
  assert.equal(await rows(database, 'policy_structuring_runs'), 0);
  assert.equal(await liveObservations(database), 0);
  assert.equal(await rows(database, 'proposed_parameters'), 0);
});

test('fake caller: budget_stop at the first chunk is failed and writes nothing', pgOptions, async t => {
  const { database, result, gemini } = await structure(t, { fail: number => (number === 1 ? budgetStop() : null) });
  assert.equal(gemini.calls.filter(kind => kind === 'extract').length, 1, 'no paid call after a budget stop');
  assert.equal(result.outcome.evidenceOutcome, 'failed');
  assert.ok(result.outcome.reasons.includes('budget_stop_before_half'));
  assert.equal(await rows(database, 'policy_structuring_runs'), 0);
  assert.equal(await liveObservations(database), 0);
});

test('fake caller: a missing critical key alone is partial_review_required', pgOptions, async t => {
  const { result } = await structure(t, { keys: criticalKeys.filter(key => key !== 'd.sum_insured') });
  assert.deepEqual(result.outcome, { evidenceOutcome: 'partial_review_required', reasons: ['critical_keys_missing'], missingCriticalKeys: ['d.sum_insured'] });
});

test('the stored outcome stays under the counts_json limit at its worst case', pgOptions, async t => {
  const { database, services } = await open(t);
  const coverage = {
    chunks: { total: 60, stored: 0, proposed: 0, skipped: 60, unaccounted: 0 }, calls: 30, usage: { inputTokens: 250000, outputTokens: 150000 },
    rejectedReasons: Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`synthetic_reason_${String(index).padStart(2, '0')}_long_code_name`, 999999])),
    skippedChunks: Array.from({ length: 60 }, (_, index) => ({ page: 9000 + index, reason: 'privacy_gate_refused' })),
    costUsd: 123.456789,
  };
  const outcome = { evidenceOutcome: 'partial_review_required', reasons: ['chunks_skipped', 'critical_keys_missing'], missingCriticalKeys: [...criticalKeys] };
  await services.policyStructuring.commitStructuring({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion: POLICY_STRUCTURING_VERSION,
    registryVersion, recordedBy: 'policy-structuring', decisions: [], proposals: [], coverage, outcome, consentCheck: grantCheck(services), at,
  });
  const { counts_json: json } = await database.prepare('SELECT counts_json FROM policy_structuring_runs').get();
  assert.ok(json.length <= 4096, `counts_json is ${json.length} bytes`);
  assert.deepEqual(JSON.parse(json).outcome.missingCriticalKeys, [...criticalKeys]);
});

test('the repository refuses a failed or malformed outcome and accepts codes only', pgOptions, async t => {
  const { services } = await open(t);
  const commit = outcome => services.policyStructuring.commitStructuring({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion: POLICY_STRUCTURING_VERSION,
    registryVersion, recordedBy: 'policy-structuring', decisions: [], proposals: [], outcome, consentCheck: grantCheck(services), at,
  });
  const invalid = { code: 'STRUCTURING_INPUT_INVALID' };
  await assert.rejects(() => commit({ evidenceOutcome: 'failed', reasons: [], missingCriticalKeys: [] }), invalid, 'a failed outcome is never stored');
  await assert.rejects(() => commit({ evidenceOutcome: 'complete', reasons: ['Room rent 1%'], missingCriticalKeys: [] }), invalid);
  await assert.rejects(() => commit({ evidenceOutcome: 'complete', reasons: [], missingCriticalKeys: ['not a key'] }), invalid);
});

test('old stored runs without an outcome map to partial_review_required, never complete', () => {
  assert.deepEqual(storedOutcome({ observations: 1 }), { evidenceOutcome: 'partial_review_required', reasons: ['outcome_not_recorded'], missingCriticalKeys: [] });
  assert.deepEqual(storedOutcome({ outcome: { evidenceOutcome: 'failed' } }).evidenceOutcome, 'partial_review_required');
  assert.equal(storedOutcome({ outcome: { evidenceOutcome: 'complete', reasons: [], missingCriticalKeys: [] } }).evidenceOutcome, 'complete');
});

test('the review result separates processing status from evidence outcome and never says completed', pgOptions, async t => {
  const { services } = await open(t);
  // A run stored before outcomes existed.
  await services.policyStructuring.commitStructuring({
    householdId: household, workflowRunId: run, documentId: document, sourceVersion: 'version-1', pipelineVersion: POLICY_STRUCTURING_VERSION,
    registryVersion, recordedBy: 'policy-structuring', decisions: [], proposals: [], consentCheck: grantCheck(services), at,
  });
  const service = createPolicyStructuringService({ services, loadKnownIdentifiers: async () => [], createModelCall: () => () => {}, env: enabled });
  const owned = { id: document, householdId: household, caseId: 'case-parameters' };
  const review = await service.result({ document: owned, workflowRunId: run });
  assert.notEqual(review.status, 'completed');
  assert.equal(review.processingStatus, 'finished');
  assert.equal(review.evidenceOutcome, 'partial_review_required');
  assert.deepEqual(review.outcomeReasons, ['outcome_not_recorded']);
  assert.deepEqual(review.missingCriticalKeys, []);
  assert.equal(review.requiresReview, true);
  assert.equal((await service.start({ document: owned, workflowRunId: run, consentGrantId: 'consent-parameters', subjectAdultId: 'adult-parameters' })).status, 'finished');
});
