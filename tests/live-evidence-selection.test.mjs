import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { LIVE_REQUEST_BUILDERS, createGeminiCoverageRegistryFactory, resolveCanonicalParameterPolicy } from '../src/modules/ai-analysis/live-coverage-runtime.js';
import { sanitizeEvidenceForModel } from '../src/modules/ai-analysis/privacy-evidence-gate.js';
import { validateTaskInput } from '../src/modules/ai-analysis/schemas.js';
import { createCoverageAnalysisSourceInput } from '../src/modules/coverage-analysis/source-input.js';
import { POLICY_PARAMETER_REGISTRY } from '../src/modules/coverage-analysis/policy-parameter-registry.js';
import { assertAcquisitionTransition } from '../src/modules/coverage-analysis/parameter-records.js';
import { liveEnv, mockOutput, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';

const PINNED = 'policy-parameters/v1';
const opaqueSourceId = rawId => sanitizeEvidenceForModel({
  context: { caseId: 'review-case', subjectId: 'review-subject', purpose: 'Derive opaque id.', requestedFields: [] },
  sources: [{ id: rawId, version: 'v1', page: null, text: 'synthetic', status: 'known' }],
  upstream: [],
}).input.sources[0].id;
const opaqueDocumentId = rawId => createHash('sha256').update(String(rawId)).digest('hex').slice(0, 24);

const caseRecord = { id: 'case-synthetic', opened_by_adult_id: 'adult-opened', trigger_type: 'renewal', stated_estimate_minor: 0, consent_grant_id: 'grant-synthetic' };
const allowedLabels = POLICY_PARAMETER_REGISTRY.parameters
  .filter(parameter => parameter.modelExtraction.allowed && parameter.dataClass !== 'RESTRICTED')
  .map(parameter => parameter.label);

// A realistic dense policy page: many requested-parameter clauses, about 4 KB.
function densePageText(index, { clauseBytes = 4_000 } = {}) {
  const lines = [];
  let used = 0;
  for (let line = 0; used < clauseBytes; line += 1) {
    const label = allowedLabels[(index * 7 + line) % allowedLabels.length];
    const text = `Clause ${index}.${line} ${label}: applies as stated in the "schedule" of benefits, subject to policy terms & conditions (line ${line}).`;
    lines.push(text);
    used += Buffer.byteLength(text) + 1;
  }
  return lines.join('\n');
}
const page = (index, overrides = {}) => ({
  id: `page-${index}`,
  document_upload_id: `document-${index % 3}`,
  page_number: index + 1,
  source_version: '1',
  document_kind: 'policy_schedule',
  extracted_text: densePageText(index),
  ...overrides,
});

const runtimeOf = input => ({ run: { id: 'run-synthetic', workflow_version: '5' }, input, upstream: {} });
const TASKS = { profile: 'profile_extraction', group: 'group_cover_extraction', personal: 'personal_cover_extraction' };

function assertWithinGateAndSchema(input) {
  for (const [builder, task] of Object.entries(TASKS)) {
    const request = LIVE_REQUEST_BUILDERS[builder](runtimeOf(input));
    const safe = sanitizeEvidenceForModel(request, { task, resolveParameterPolicy: key => resolveCanonicalParameterPolicy(key, input.parameterRegistryVersion) });
    assert.ok(safe.input.sources.length <= 30, `${builder} sources`);
    assert.ok(Buffer.byteLength(JSON.stringify(safe.input)) <= 48_000, `${builder} bytes`);
    assert.doesNotThrow(() => validateTaskInput(task, safe.input), `${builder} schema`);
    assert.equal(safe.input.sources.length, input.sourcePages.length, `${builder} sends exactly the planned pages`);
  }
}

test('source pack: realistic 4 KB pages (15, 31 and 120) are planned within the gate limits and unsent pages are reported', () => {
  for (const count of [15, 31, 120]) {
    const input = createCoverageAnalysisSourceInput(caseRecord, Array.from({ length: count }, (_unused, index) => page(index)));
    assertWithinGateAndSchema(input);
    assert.ok(input.sourcePages.length >= 1 && input.sourcePages.length <= 30, `${count} pages`);
    assert.equal(input.sourcePages.length + input.sourceSelection.notSent.length, count, 'every page is either sent or reported, none silently dropped');
    assert.equal(input.sourceSelection.excluded, 0);
    assert.equal(input.authorizedSourceIds.length, input.sourcePages.length);
    if (input.sourceSelection.notSent.length > 0) {
      assert.ok(input.sourceBlockers.some(blocker => blocker.code === 'SOURCE_NOT_SENT' && blocker.reasonCode === 'REQUEST_BUDGET_EXCEEDED'));
    }
    // Page text is stored once; evidence descriptors never repeat it.
    const evidence = input.groupPolicies[0].evidence;
    assert.ok(evidence.every(item => item.value === null && !('text' in item)));
    assert.ok(Buffer.byteLength(JSON.stringify(input)) < 150_000, 'persisted input stays bounded');
  }
});

test('source pack: awkward text (quotes, newlines, unicode) still fits the gate and schema', () => {
  const awkward = index => ({
    ...page(index),
    extracted_text: `${'"quoted" \\ back\\slash\ttab नमस्ते — Room rent limit: ₹5,000 per day. \n'.repeat(120)}${densePageText(index)}`,
  });
  const input = createCoverageAnalysisSourceInput(caseRecord, Array.from({ length: 40 }, (_unused, index) => awkward(index)));
  assertWithinGateAndSchema(input);
});

test('source pack: pages are selected per requested parameter, not by position', () => {
  // Page 0 mentions nothing; pages 1..n each carry distinct parameters.
  const quiet = page(0, { extracted_text: 'This page is a cover letter and mentions no requested clause at all.' });
  const input = createCoverageAnalysisSourceInput(caseRecord, [quiet, ...Array.from({ length: 12 }, (_unused, index) => page(index + 1))]);
  const sentIds = input.sourcePages.map(item => item.sourceId);
  assert.ok(sentIds.includes('page-0'), 'a short page that fits is still sent');
  assert.ok(input.sourcePages.every(item => item.parameterKeys.length > 0));
  assert.deepEqual(input.sourcePages.find(item => item.sourceId === 'page-0').parameterKeys, ['a.document_set']);
});

test('parameter states follow the state machine: received only where a sanitised page was sent', () => {
  const input = createCoverageAnalysisSourceInput(caseRecord, Array.from({ length: 31 }, (_unused, index) => page(index)));
  assert.ok(input.sourceSelection.notSent.length > 0, 'the scenario must force unsent pages');
  const states = new Map(input.parameterStates.map(state => [state.parameterKey, state]));
  assert.equal(states.size, POLICY_PARAMETER_REGISTRY.parameters.length, 'every canonical parameter has an explicit state');
  const sentKeys = new Set(input.sourcePages.flatMap(item => item.parameterKeys));
  const path = { not_requested: [], requested: ['requested'], received: ['requested', 'received'] };
  const seen = new Set();
  for (const { parameterKey, acquisitionState, resolutionState } of states.values()) {
    seen.add(acquisitionState);
    assert.ok(path[acquisitionState], `${parameterKey}: ${acquisitionState} must be a state reachable in the machine`);
    // Walk not_requested -> ... -> state with the production transition validator.
    let current = 'not_requested';
    for (const next of path[acquisitionState]) current = assertAcquisitionTransition(current, next);
    assert.equal(current, acquisitionState === 'not_requested' ? 'not_requested' : acquisitionState);
    assert.equal(resolutionState, 'unknown');
    if (acquisitionState === 'received') assert.ok(sentKeys.has(parameterKey), `${parameterKey} was claimed received without a sent page`);
    if (sentKeys.has(parameterKey) && input.profilePacket.requestedFields.includes(parameterKey)) assert.equal(acquisitionState, 'received');
  }
  assert.ok(seen.has('received') && seen.has('requested') && seen.has('not_requested'), 'all three reachable states appear');
  // A key found only on pages that were not sent is requested, never received.
  const requestedOnly = [...states.values()].filter(state => state.acquisitionState === 'requested');
  assert.ok(requestedOnly.every(state => !input.profilePacket.requestedFields.includes(state.parameterKey)));
});

test('source pack: restricted pages are excluded per document with an opaque reason-only blocker and the rest continue', () => {
  const restricted = page(1, { document_upload_id: 'document-restricted', extracted_text: 'Schedule. Payment card 4111 1111 1111 1111 on file. Room rent limit applies.' });
  const input = createCoverageAnalysisSourceInput(caseRecord, [page(0), restricted, page(2)]);
  assert.deepEqual(input.sourcePages.map(item => item.sourceId).sort(), ['page-0', 'page-2']);
  assert.deepEqual(input.authorizedSourceIds.sort(), ['page-0', 'page-2']);
  assert.ok(input.authorizedSources.every(source => source.documentId !== 'document-restricted'));
  const blockers = input.sourceBlockers.filter(blocker => blocker.code === 'SOURCE_EXCLUDED');
  assert.deepEqual(blockers, [{ code: 'SOURCE_EXCLUDED', reasonCode: 'RESTRICTED_EVIDENCE', documentId: opaqueDocumentId('document-restricted'), pageCount: 1 }]);
  const serialised = JSON.stringify(input);
  for (const forbidden of ['4111 1111 1111 1111', 'page-1"', 'document-restricted', 'Payment card']) assert.ok(!serialised.includes(forbidden), `${forbidden} must not be persisted`);
  assert.equal(input.sourceSelection.excluded, 1);
});

test('source pack: a case whose every page is restricted fails with the source-pack error and no raw text', () => {
  const pages = [page(0, { extracted_text: 'card 4111 1111 1111 1111' }), page(1, { extracted_text: 'password=not-a-real-secret-value' })];
  assert.throws(() => createCoverageAnalysisSourceInput(caseRecord, pages), error => {
    assert.equal(error.code, 'SOURCE_PACK_REQUIRED');
    assert.equal(error.statusCode, 409);
    assert.ok(!JSON.stringify({ message: error.message, blockers: error.sourceBlockers }).includes('4111 1111'));
    assert.equal(error.sourceBlockers.length, 2);
    return true;
  });
  assert.throws(() => createCoverageAnalysisSourceInput(caseRecord, []), { code: 'SOURCE_PACK_REQUIRED' });
});

test('subject id uses analysis_subject_adult_id and falls back to the case opener', () => {
  const withSubject = createCoverageAnalysisSourceInput({ ...caseRecord, analysis_subject_adult_id: 'adult-subject' }, [page(0)]);
  assert.equal(withSubject.profilePacket.subjectId, 'adult-subject');
  assert.equal(withSubject.profilePacket.consent.subjectId, 'adult-subject');
  for (const subject of [undefined, null]) {
    const fallback = createCoverageAnalysisSourceInput({ ...caseRecord, analysis_subject_adult_id: subject }, [page(0)]);
    assert.equal(fallback.profilePacket.subjectId, 'adult-opened');
    assert.equal(fallback.profilePacket.consent.subjectId, 'adult-opened');
  }
});

test('source pack pins a known registry version and refuses unknown ones', () => {
  assert.equal(createCoverageAnalysisSourceInput(caseRecord, [page(0)]).parameterRegistryVersion, PINNED);
  assert.throws(() => createCoverageAnalysisSourceInput(caseRecord, [page(0)], { registryVersion: 'policy-parameters/v999' }), /Unknown policy parameter registry version/);
});

test('live resolver uses the registry version pinned by the run and fails closed on unknown or missing pins', async () => {
  const input = createCoverageAnalysisSourceInput(caseRecord, [page(0)]);
  const resolutions = [];
  const modelRequests = [];
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver({ modelRequests }),
    preDispatchValidator: async () => true,
    resolveParameterPolicy: (key, version) => { resolutions.push(version); return resolveCanonicalParameterPolicy(key, version); },
  })();
  await registry.profile(runtimeOf(input));
  assert.ok(resolutions.length > 0 && resolutions.every(version => version === PINNED));
  assert.equal(modelRequests.length, 1);

  for (const pin of ['policy-parameters/v0', 'policy-parameters/v999', '', null, 7]) {
    await assert.rejects(registry.profile(runtimeOf({ ...input, parameterRegistryVersion: pin })), { code: 'PARAMETER_REGISTRY_VERSION_UNKNOWN' }, String(pin));
  }
  const unpinned = { ...input };
  delete unpinned.parameterRegistryVersion;
  await assert.rejects(registry.group(runtimeOf(unpinned)), { code: 'PARAMETER_REGISTRY_VERSION_UNKNOWN' });
  assert.equal(modelRequests.length, 1, 'no model call for an unpinned or unknown registry');
});

test('multi-document attribution: a citation resolves to the page and version of its own document', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, {
    modelRequests,
    output: (agentId, input) => {
      const output = mockOutput(agentId, input);
      const documentB = input.sources.find(source => source.text.includes('Document B marker'));
      if (output.facts && documentB) output.facts[0].citations = [documentB.id];
      return output;
    },
  });
  const scenario = await setupLiveCase(app, { pageText: 'Room rent limit is 5000 (Document A marker).', suffix: 'doca' });
  // Document A's page is 3 of version "va"; document B's is 7 of version "vb".
  app.database.prepare("UPDATE source_pages SET page_number = 3, source_version = 'va' WHERE id = ?").run(scenario.pageId);
  app.database.prepare("UPDATE document_uploads SET source_version = 'va' WHERE id = ?").run(scenario.documentId);
  const documentB = scenario.addDocument({ suffix: 'docb', text: 'Room rent limit is 7000 (Document B marker).', pageNumber: 7, sourceVersion: 'vb' });

  const run = await scenario.startLiveRun('multi-document');
  assert.equal(run.status, 202, run.raw);
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(run.data.modelUsage.calls, 5);

  const input = JSON.parse(app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(run.data.id).input_json);
  assert.deepEqual(input.sourcePages.map(item => [item.sourceId, item.documentId, item.page, item.version]).sort(), [
    [scenario.pageId, scenario.documentId, 3, 'va'],
    [documentB.pageId, documentB.documentId, 7, 'vb'],
  ].sort());

  // The profile, group and personal requests carry one source entry per page.
  const extractionRequests = modelRequests.filter(request => /_extraction$/.test(request.agentId)).map(request => JSON.parse(request.prompt));
  assert.equal(extractionRequests.length, 3);
  for (const request of extractionRequests) {
    assert.equal(request.sources.length, 2);
    const byId = new Map(request.sources.map(source => [source.id, source]));
    assert.deepEqual(byId.get(opaqueSourceId(scenario.pageId)) && [byId.get(opaqueSourceId(scenario.pageId)).page, byId.get(opaqueSourceId(scenario.pageId)).version], [3, 'va']);
    assert.deepEqual([byId.get(opaqueSourceId(documentB.pageId)).page, byId.get(opaqueSourceId(documentB.pageId)).version], [7, 'vb']);
    assert.match(byId.get(opaqueSourceId(scenario.pageId)).text, /Document A marker/);
    assert.match(byId.get(opaqueSourceId(documentB.pageId)).text, /Document B marker/);
    assert.ok(!byId.get(opaqueSourceId(scenario.pageId)).text.includes('Document B'));
    assert.ok(!byId.get(opaqueSourceId(documentB.pageId)).text.includes('Document A'));
  }

  // The model cited document B's page; the fact is attributed to B (page 7, vb), not A.
  const outputs = Object.fromEntries(app.database.prepare('SELECT task_kind, output_json FROM workflow_tasks WHERE workflow_run_id = ?').all(run.data.id)
    .map(row => [row.task_kind, JSON.parse(row.output_json).payload]));
  const expected = { sourceId: opaqueSourceId(documentB.pageId), page: 7, version: 'vb' };
  assert.deepEqual(outputs.group_cover_analysis[0].coverageGraph.nodes[0].citations, [expected]);
  assert.deepEqual(outputs.personal_cover_analysis.dimensions.suitability.assertions[0].sources, [{ id: expected.sourceId, page: 7, version: 'vb' }]);
  const [profileFact] = Object.values(outputs.profile_intake.profile);
  assert.deepEqual(profileFact.sources, [{ id: expected.sourceId, page: 7, version: 'vb' }]);
  const coverageSources = outputs.coverage_graph.facts.flatMap(fact => fact.sources);
  assert.ok(coverageSources.length === 3 && coverageSources.every(source => source.id === expected.sourceId && source.page === 7 && source.version === 'vb'));
  // Review still maps both opaque ids back to authorised pages.
  assert.equal(outputs.privacy_review.status, 'passed');
});

test('a case with more than 30 realistic 4 KB pages completes the live workflow within the gate limits', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app, { pageText: densePageText(0), suffix: 'big' });
  const document = { documentId: scenario.documentId, pageId: scenario.pageId, sourceVersion: '1' };
  for (let index = 1; index <= 40; index += 1) scenario.addPage(document, { pageNumber: index + 1, text: densePageText(index) });
  assert.equal(app.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 41);

  const run = await scenario.startLiveRun('many-pages');
  assert.equal(run.status, 202, run.raw);
  assert.equal(run.data.tasks.length, 22);
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(run.data.modelUsage.calls, 5);
  assert.equal(modelRequests.length, 5);

  const input = JSON.parse(app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(run.data.id).input_json);
  assert.ok(input.sourcePages.length > 0 && input.sourcePages.length <= 30);
  assert.equal(input.sourcePages.length + input.sourceSelection.notSent.length, 41, 'sent plus reported-unsent covers every page');
  assert.ok(input.sourceSelection.notSent.length > 0, 'the scenario must exceed the request budget');
  for (const request of modelRequests) {
    const evidence = JSON.parse(request.prompt);
    assert.ok(evidence.sources.length <= 30);
    assert.ok(Buffer.byteLength(JSON.stringify(evidence)) <= 48_000);
  }
  // Pages that were not sent are visible in the persisted blockers and the evidence review.
  const reviews = Object.fromEntries(app.database.prepare("SELECT task_kind, output_json FROM workflow_tasks WHERE workflow_run_id = ? AND task_kind = 'evidence_review'").all(run.data.id)
    .map(row => [row.task_kind, JSON.parse(row.output_json).payload]));
  assert.ok(reviews.evidence_review.findings.some(finding => finding.code === 'SOURCE_NOT_SENT' && finding.reasonCode === 'REQUEST_BUDGET_EXCEEDED'));
  // Authorisation is limited to the pages that were sent.
  assert.deepEqual(input.authorizedSourceIds.sort(), input.sourcePages.map(item => item.sourceId).sort());
  const authorized = app.database.prepare("SELECT event_payload_json FROM audit_events WHERE action = 'analysis.model_dispatch_authorized'").all();
  assert.equal(authorized.length, 5);
  assert.ok(authorized.every(event => JSON.parse(event.event_payload_json).sourceCount === input.sourcePages.length));
});

test('a restricted page in one document is excluded with a blocker while the other document completes the run', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app, { suffix: 'good' });
  const restricted = scenario.addDocument({ suffix: 'restricted', text: 'Schedule. card 4111 1111 1111 1111 on file. Room rent limit is RESTRICTEDMARKER98765.' });

  const run = await scenario.startLiveRun('mixed-restricted');
  assert.equal(run.status, 202, run.raw);
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(run.data.modelUsage.calls, 5);

  const input = JSON.parse(app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(run.data.id).input_json);
  assert.deepEqual(input.authorizedSourceIds, [scenario.pageId]);
  assert.deepEqual(input.sourceBlockers, [{ code: 'SOURCE_EXCLUDED', reasonCode: 'RESTRICTED_EVIDENCE', documentId: opaqueDocumentId(restricted.documentId), pageCount: 1 }]);

  const everything = JSON.stringify({
    provider: modelRequests,
    http: run.raw,
    persisted: [
      app.database.prepare('SELECT input_json FROM workflow_runs').all(),
      app.database.prepare('SELECT input_json, output_json, last_error_message FROM workflow_tasks').all(),
      app.database.prepare('SELECT event_payload_json FROM audit_events').all(),
    ],
  });
  for (const forbidden of ['4111 1111 1111 1111', 'RESTRICTEDMARKER98765', restricted.pageId, restricted.documentId]) assert.ok(!everything.includes(forbidden), `${forbidden} must not appear anywhere`);

  const review = JSON.parse(app.database.prepare("SELECT output_json FROM workflow_tasks WHERE workflow_run_id = ? AND task_kind = 'evidence_review'").get(run.data.id).output_json).payload;
  assert.ok(review.findings.some(finding => finding.code === 'SOURCE_EXCLUDED' && finding.reasonCode === 'RESTRICTED_EVIDENCE' && finding.documentId === opaqueDocumentId(restricted.documentId)));
});

test('a case whose only page is restricted is refused with the source-pack error before any provider call', async t => {
  const modelRequests = [];
  const app = await startLiveServer(t, { modelRequests });
  const scenario = await setupLiveCase(app, { pageText: 'Schedule: card 4111 1111 1111 1111 on file.' });
  const response = await scenario.startLiveRun('only-restricted');
  assert.equal(response.status, 409);
  assert.match(response.raw, /at least one authorised, protected OCR source page/);
  assert.ok(!response.raw.includes('4111 1111'));
  assert.equal(modelRequests.length, 0);
  assert.equal(app.database.prepare("SELECT count(*) AS count FROM workflow_runs WHERE execution_mode = 'live'").get().count, 0);
});
