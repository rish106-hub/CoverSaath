// Round 4 runtime findings: K1 (known-identifier loading and wiring), K2 (allowlist
// excerpts), N3 (revocation erases derived run data), N4 (no raw-text digest) and
// N8 (transaction nesting without DatabaseSync.isTransaction). Every value is synthetic.
//
// The tests that need the privacy gate itself to honour `knownIdentifiers` live in
// known-identifier-e2e.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createGeminiCoverageRegistryFactory } from '../src/features/ai-analysis/index.js';
import { COVERAGE_ANALYSIS_WORKFLOW, createPersistentCoverageAnalysisService } from '../src/features/coverage-analysis/index.js';
import { createCoverageAnalysisSourceInput as buildSourceInput } from '../src/features/coverage-analysis/source-input.js';
// The gate needs an explicit identifier list; these tests have no household identifiers.
const createCoverageAnalysisSourceInput = (caseRecord, pages, options = {}) => buildSourceInput(caseRecord, pages, { knownIdentifiers: [], ...options });
import { auditActions, liveEnv, setupLiveCase, startLiveServer, stubModelDriver } from './support/live-analysis-scenario.mjs';
import { seedParameterWorld } from './support/parameter-fixtures.mjs';

const caseRecord = { id: 'case-synthetic', opened_by_adult_id: 'adult-opened', trigger_type: 'renewal', stated_estimate_minor: 0, consent_grant_id: 'grant-synthetic' };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const opaqueDocumentId = rawId => sha256(String(rawId)).slice(0, 24);
const page = (text, overrides = {}) => ({
  id: 'page-a', document_upload_id: 'document-a', page_number: 1, source_version: '1', document_kind: 'policy_schedule', extracted_text: text, ...overrides,
});
const sentText = input => input.sourcePages.map(item => item.text).join('\n');
const runInput = (database, runId) => JSON.parse(database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(runId).input_json);
const runRow = (database, runId) => database.prepare('SELECT status, terminal_reason, input_json FROM workflow_runs WHERE id = ?').get(runId);
const taskRows = (database, runId) => database.prepare('SELECT status, output_json, output_digest FROM workflow_tasks WHERE workflow_run_id = ?').all(runId);

function liveService(app, { modelRequests = [], knownIdentifierLoader, portOverrides = {} } = {}) {
  const services = createBackendServices(app.database);
  const basePort = createCoverageAnalysisPort({ database: app.database, services });
  const port = Object.freeze({ ...basePort, ...portOverrides });
  const registry = createGeminiCoverageRegistryFactory({
    env: liveEnv,
    ...stubModelDriver({ modelRequests }),
    preDispatchValidator: request => basePort.authorizeModelDispatch(request),
    knownIdentifierLoader: knownIdentifierLoader ?? (caseId => basePort.loadKnownIdentifiers(caseId)),
  })();
  return { services, port: basePort, service: createPersistentCoverageAnalysisService({ port, liveRegistry: registry }) };
}

// ---------------------------------------------------------------------------
// K2: allowlist excerpts
// ---------------------------------------------------------------------------

test('K2: a page that mentions no requested parameter is never sent and is reported as NO_PARAMETER_MATCH', () => {
  const matched = page('Room rent limit is 5000.', { id: 'page-match', document_upload_id: 'document-match' });
  const cover = page('Dear Priya Sharma, thank you for choosing us. Your policy documents are enclosed.\nSincerely, The Team', { id: 'page-cover', document_upload_id: 'document-cover', page_number: 2 });
  const input = createCoverageAnalysisSourceInput(caseRecord, [cover, matched]);
  assert.deepEqual(input.sourcePages.map(item => item.sourceId), ['page-match']);
  assert.deepEqual(input.authorizedSourceIds, ['page-match']);
  assert.deepEqual(input.sourceSelection.notSent, [{ documentId: opaqueDocumentId('document-cover'), page: 2, reasonCode: 'NO_PARAMETER_MATCH' }]);
  assert.ok(!JSON.stringify(input).includes('Priya'), 'no head-of-page excerpt of the unmatched page is stored');
  assert.ok(!JSON.stringify(input).includes('Sincerely'));
  // Reported, not a release blocker: the page asked for nothing.
  assert.deepEqual(input.sourceBlockers, []);
});

test('K2: when no page matches a parameter there is nothing to send and the run is refused with the reasons', () => {
  assert.throws(
    () => createCoverageAnalysisSourceInput(caseRecord, [page('Dear Priya Sharma, welcome aboard.')]),
    error => {
      assert.equal(error.code, 'SOURCE_PACK_REQUIRED');
      assert.deepEqual(error.sourceBlockers, [{ code: 'SOURCE_NOT_SENT', reasonCode: 'NO_PARAMETER_MATCH', documentId: opaqueDocumentId('document-a'), pageCount: 1 }]);
      assert.ok(!JSON.stringify({ message: error.message, blockers: error.sourceBlockers }).includes('Priya'));
      return true;
    },
  );
});

test('K2: the line after a matched line is included only when it is a plain term value', () => {
  const text = [
    'Room rent limit',
    '5000 per day',
    'Sum insured',
    'Priya Sharma 500000',
    'Deductible',
    'from 01/04/2025 for 30 days',
    'Policy period',
    'Self 12 months',
    'Room rent limit applies',
    'ASHA SHARMA 5000',
  ].join('\n');
  const sent = sentText(createCoverageAnalysisSourceInput(caseRecord, [page(text)])).split('\n');
  assert.deepEqual(sent, [
    'Room rent limit', '5000 per day',
    'Sum insured',
    'Deductible', 'from 01/04/2025 for 30 days',
    'Policy period',
    'Room rent limit applies',
  ]);
});

test('K2: a following table row with a relationship word or a name next to a date is never included', () => {
  const rows = [
    'Self | 5000 | 10%',
    'Spouse - 3000',
    'Son 25 years',
    'daughter 21 years',
    'Father 65 years',
    'Mother 62 years',
    'child 5 years',
    'Wife 40',
    'husband 41',
    'Asha 12/03/1985',
    'Ravi born 1985-03-12',
    'Meena 3 March 1990',
  ];
  for (const row of rows) {
    const sent = sentText(createCoverageAnalysisSourceInput(caseRecord, [page(`Room rent limit | Co-payment\n${row}`)]));
    assert.equal(sent, 'Room rent limit | Co-payment', `row "${row}" must not be sent`);
  }
  // The same header followed by a plain value row still travels.
  assert.equal(sentText(createCoverageAnalysisSourceInput(caseRecord, [page('Room rent limit | Co-payment\n5000 | 10%')])), 'Room rent limit | Co-payment\n5000 | 10%');
});

test('K2: the line after a matched line is never included when it carries an identifier placeholder', () => {
  const known = [{ kind: 'NAME', value: 'Kavya Placeholder' }];
  const sent = sentText(createCoverageAnalysisSourceInput(caseRecord, [page('Room rent limit\nlimit 5000 for Kavya Placeholder')], { knownIdentifiers: known }));
  assert.equal(sent, 'Room rent limit');
  // Raw page text that already carries placeholder syntax is refused, so it cannot pose as a gate-minted token.
  assert.throws(() => createCoverageAnalysisSourceInput(caseRecord, [page('Room rent limit\nlimit 5000 for <NAME_1>')]), { code: 'SOURCE_PACK_REQUIRED' });
});

// ---------------------------------------------------------------------------
// N4: no digest of raw page text
// ---------------------------------------------------------------------------

test('N4: run input carries no digest of raw page text', () => {
  const raw = 'Room rent limit is 5000 for the named insured.';
  const input = createCoverageAnalysisSourceInput(caseRecord, [page(raw)]);
  assert.ok(input.sourcePages.every(item => !('textDigest' in item)));
  const body = JSON.stringify(input);
  for (const candidate of [raw, input.sourcePages[0].text]) assert.ok(!body.includes(sha256(candidate)), 'no unsalted hash of page text is persisted');
});

// ---------------------------------------------------------------------------
// K1: loading the household's identifiers, and wiring (gate-independent)
// ---------------------------------------------------------------------------

test('K1: loadKnownIdentifiers returns only this household\'s names, dates of birth, phones and emails', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const { database } = app;
  const at = new Date().toISOString();
  const stamp = (table, columns, values) => database.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(...values);
  database.prepare('UPDATE adult_users SET contact_email = ?, contact_phone = ? WHERE id = ?').run('owner.synthetic@example.test', '+910000000001', scenario.ownerId);
  stamp('household_members', ['id', 'household_id', 'display_name', 'member_kind', 'date_of_birth', 'created_at', 'updated_at'],
    ['member-child', scenario.householdId, "Wendeline O'Brien", 'dependent', '2015-06-07', at, at]);
  // A duplicate (case-insensitive) value is listed once.
  stamp('household_members', ['id', 'household_id', 'display_name', 'member_kind', 'created_at', 'updated_at'],
    ['member-child-dup', scenario.householdId, "WENDELINE O'BRIEN", 'dependent', at, at]);
  // Control characters are neutralised so the gate never rejects the whole list over one value.
  stamp('household_members', ['id', 'household_id', 'display_name', 'member_kind', 'created_at', 'updated_at'],
    ['member-control', scenario.householdId, 'Ctl\u0001Name​', 'dependent', at, at]);
  // Another household's people must never appear.
  stamp('households', ['id', 'display_name', 'created_at', 'updated_at'], ['household-elsewhere', 'Elsewhere', at, at]);
  stamp('adult_users', ['id', 'display_name', 'contact_email', 'contact_phone', 'account_status', 'created_at', 'updated_at'],
    ['adult-elsewhere', 'Elsewhere Person', 'elsewhere@example.test', '+919999999999', 'active', at, at]);
  stamp('household_members', ['id', 'household_id', 'adult_user_id', 'display_name', 'member_kind', 'date_of_birth', 'created_at', 'updated_at'],
    ['member-elsewhere', 'household-elsewhere', 'adult-elsewhere', 'Elsewhere Person', 'adult', '1970-01-01', at, at]);
  // An adult with a role but no member row is still one of the household's adults.
  stamp('adult_users', ['id', 'display_name', 'contact_email', 'account_status', 'created_at', 'updated_at'],
    ['adult-viewer', 'Viewer Synthetic', 'viewer.synthetic@example.test', 'active', at, at]);
  stamp('household_roles', ['id', 'household_id', 'adult_user_id', 'role', 'status', 'created_at'], ['role-viewer', scenario.householdId, 'adult-viewer', 'viewer', 'active', at]);

  const { port } = liveService(app);
  const identifiers = port.loadKnownIdentifiers(scenario.caseId);
  const byKind = kind => identifiers.filter(item => item.kind === kind).map(item => item.value).sort();
  assert.deepEqual(byKind('NAME'), ['Ctl Name', 'Synthetic owner', 'Viewer Synthetic', "Wendeline O'Brien"].sort());
  assert.deepEqual(byKind('DOB'), ['2015-06-07']);
  assert.deepEqual(byKind('EMAIL'), ['owner.synthetic@example.test', 'viewer.synthetic@example.test']);
  assert.deepEqual(byKind('PHONE'), ['+910000000001']);
  assert.ok(identifiers.length <= 200 && identifiers.every(item => item.value.length >= 1 && item.value.length <= 200));
  assert.ok(!JSON.stringify(identifiers).includes('Elsewhere'));
});

test('K1: loadKnownIdentifiers fails closed for an unknown case, a malformed id and an over-limit household', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const { port } = liveService(app);
  for (const bad of ['case-does-not-exist', '', null, undefined, 'x'.repeat(201)]) {
    assert.throws(() => port.loadKnownIdentifiers(bad), { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE' }, String(bad));
  }
  const at = new Date().toISOString();
  const insert = app.database.prepare(`INSERT INTO household_members (id, household_id, display_name, member_kind, created_at, updated_at)
    VALUES (?, ?, ?, 'dependent', ?, ?)`);
  for (let index = 0; index < 205; index += 1) insert.run(`member-bulk-${index}`, scenario.householdId, `Bulk Member ${index}`, at, at);
  assert.throws(() => port.loadKnownIdentifiers(scenario.caseId), { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE' }, 'a household over the gate limit is refused, never truncated');
});

test('K1: run creation fails closed, creating nothing, when the household identifiers cannot be loaded', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const { service } = liveService(app, { portOverrides: { loadKnownIdentifiers: () => { throw Object.assign(new Error('unavailable'), { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE' }); } } });
  await assert.rejects(
    service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'k1-no-loader' }),
    { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE' },
  );
  assert.equal(app.database.prepare('SELECT count(*) AS count FROM workflow_runs').get().count, 0);
  assert.equal(app.database.prepare('SELECT count(*) AS count FROM idempotency_keys').get().count, 0);
});

test('K1: every model request reloads the identifiers for the run\'s case server-side; nothing is stored in run input', async t => {
  const modelRequests = [];
  const calls = [];
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app);
  const { port, service } = liveService(app, {
    modelRequests,
    knownIdentifierLoader: caseId => { calls.push(caseId); return port.loadKnownIdentifiers(caseId); },
  });
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'k1-reload' });
  const settled = await service.runUntilSettled(job.id);
  assert.equal(settled.tasks.filter(task => task.status === 'completed').length, 22);
  assert.equal(modelRequests.length, 5);
  assert.deepEqual(calls, Array(5).fill(scenario.caseId));
  const stored = app.database.prepare('SELECT input_json FROM workflow_runs WHERE id = ?').get(job.id).input_json;
  assert.ok(!/knownIdentifiers|Synthetic owner/.test(stored), 'the household identifiers are never part of run input');
});

test('K1: a live registry cannot be created without a household identifier loader', () => {
  const modelRequests = [];
  for (const knownIdentifierLoader of [undefined, null, true, 'load', {}]) {
    const factory = createGeminiCoverageRegistryFactory({
      env: liveEnv, ...stubModelDriver({ modelRequests }), preDispatchValidator: async () => true, knownIdentifierLoader,
    });
    assert.throws(() => factory(), { code: 'LIVE_AI_CONFIG_INVALID' });
  }
  assert.equal(modelRequests.length, 0);
});

for (const [label, loader] of [
  ['throws', () => { throw new Error('loader exploded'); }],
  ['rejects', async () => { throw new Error('loader exploded'); }],
  ['returns nothing', () => undefined],
  ['returns a non-array', () => ({ kind: 'NAME', value: 'x' })],
]) {
  test(`K1: a loader that ${label} stops every model request: zero provider calls, tasks fail closed`, async t => {
    const modelRequests = [];
    const app = await startLiveServer(t);
    const scenario = await setupLiveCase(app);
    const { service } = liveService(app, { modelRequests, knownIdentifierLoader: loader });
    const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: `k1-loader-${label}` });
    const settled = await service.runUntilSettled(job.id);
    assert.equal(modelRequests.length, 0, 'no provider call without the redaction list');
    assert.equal(auditActions(app.database, 'analysis.model_dispatch_authorized').length, 0);
    assert.notEqual(settled.status, 'completed');
    const failed = app.database.prepare("SELECT last_error_code, last_error_message FROM workflow_tasks WHERE workflow_run_id = ? AND status = 'failed'").all(job.id);
    assert.ok(failed.length >= 1);
    assert.ok(failed.every(task => task.last_error_code === 'KNOWN_IDENTIFIERS_UNAVAILABLE'));
    assert.ok(failed.every(task => !String(task.last_error_message).includes('loader exploded')), 'the loader error text is not echoed');
  });
}

// ---------------------------------------------------------------------------
// N3: revoking document consent erases derived run data
// ---------------------------------------------------------------------------

const MARKER_ONE = 'zebrafinch quokka alpha';
const MARKER_TWO = 'pangolin axolotl beta';
const markerPage = marker => `Synthetic schedule: room rent limit is 5000 and ${marker} applies.`;

function assertErased(database, runId, marker, { runStatus = 'revoked' } = {}) {
  const row = runRow(database, runId);
  assert.equal(row.status, runStatus);
  assert.ok(!row.input_json.includes(marker), 'no page text remains in run input');
  const input = JSON.parse(row.input_json);
  assert.ok(input.sourcePages.length >= 1);
  for (const entry of input.sourcePages) {
    assert.equal(entry.redacted, 'consent_revoked');
    assert.ok(!('text' in entry) && !('textDigest' in entry));
    assert.ok(entry.sourceId && entry.documentId, 'ids stay so the erasure remains auditable');
  }
  const tasks = taskRows(database, runId);
  assert.ok(tasks.length > 0);
  assert.ok(tasks.every(task => task.output_json === null && task.output_digest === null), 'no task output survives');
  assert.ok(!JSON.stringify(tasks).includes(marker));
}

test('N3: revoking the document grant erases a completed run\'s derived data and leaves another household untouched', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-a' });
  const other = await setupLiveCase(app, { pageText: markerPage(MARKER_TWO), suffix: 'n3-b' });
  const services = createBackendServices(app.database);
  const run = await scenario.startLiveRun('n3-run-a');
  const otherRun = await other.startLiveRun('n3-run-b');
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  assert.ok(runRow(app.database, run.data.id).input_json.includes(MARKER_ONE), 'the scenario really stored the marker text');
  const otherBefore = runRow(app.database, otherRun.data.id);

  services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'synthetic' });

  assertErased(app.database, run.data.id, MARKER_ONE);
  assert.equal(runRow(app.database, run.data.id).terminal_reason, 'CONSENT_REVOKED');
  assert.ok(taskRows(app.database, run.data.id).every(task => task.status === 'revoked'));
  const erasure = auditActions(app.database, 'analysis.derived_data_erased');
  assert.equal(erasure.length, 1);
  assert.deepEqual(erasure[0].payload, { reason: 'consent_revoked', runs: 1, tasks: 22, pages: 1, documents: 1 });
  assert.ok(!JSON.stringify(auditActions(app.database, 'consent.revoked')).includes(MARKER_ONE));
  assert.ok(!app.database.prepare('SELECT event_payload_json FROM audit_events').all().some(event => event.event_payload_json.includes(MARKER_ONE)));

  // The other household's run is byte-for-byte untouched.
  const otherAfter = runRow(app.database, otherRun.data.id);
  assert.deepEqual({ ...otherAfter }, { ...otherBefore });
  assert.ok(otherAfter.input_json.includes(MARKER_TWO));
  const otherTasks = taskRows(app.database, otherRun.data.id);
  assert.ok(otherTasks.every(task => task.status === 'completed' && task.output_json !== null));

  // Idempotent: revoking again changes and audits nothing more.
  services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId, reason: 'again' });
  assert.equal(auditActions(app.database, 'analysis.derived_data_erased').length, 1);
});

test('N3: a queued, not yet dispatched run is revoked with its excerpts erased', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-queued' });
  const { services, service } = liveService(app);
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'n3-queued' });
  assert.equal(runRow(app.database, job.id).status, 'queued');
  services.consents.revoke({ grantId: scenario.documentConsentId, revokedByAdultId: scenario.ownerId });
  assertErased(app.database, job.id, MARKER_ONE);
  assert.equal((await service.runUntilSettled(job.id)).status, 'revoked');
});

test('N3: with two documents only the revoked document\'s page entry is erased; the run is still revoked', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-mixed' });
  const second = await app.call('/api/v1/consents', {
    method: 'POST', token: scenario.token,
    body: { householdId: scenario.householdId, subjectAdultId: scenario.ownerId, purpose: 'document_processing', scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }] },
  });
  const other = scenario.addDocument({ suffix: 'n3-mixed-2', text: markerPage(MARKER_TWO), grantId: second.data.id });
  const services = createBackendServices(app.database);
  const run = await scenario.startLiveRun('n3-mixed');
  assert.equal(run.status, 202, run.raw);
  assert.equal(runInput(app.database, run.data.id).sourcePages.length, 2);

  services.consents.revoke({ grantId: second.data.id, revokedByAdultId: scenario.ownerId });

  const input = runInput(app.database, run.data.id);
  const byDocument = new Map(input.sourcePages.map(entry => [entry.documentId, entry]));
  assert.equal(byDocument.get(other.documentId).redacted, 'consent_revoked');
  assert.ok(!('text' in byDocument.get(other.documentId)));
  assert.ok(typeof byDocument.get(scenario.documentId).text === 'string', 'the still-consented document keeps its excerpt');
  assert.ok(!runRow(app.database, run.data.id).input_json.includes(MARKER_TWO));
  assert.equal(runRow(app.database, run.data.id).status, 'revoked');
  assert.ok(taskRows(app.database, run.data.id).every(task => task.output_json === null), 'outputs derived from the revoked document are gone');
  assert.deepEqual(auditActions(app.database, 'analysis.derived_data_erased').at(-1).payload, { reason: 'consent_revoked', runs: 1, tasks: 22, pages: 1, documents: 1 });
});

test('N3: revoking the coverage grant also erases the excerpts stored in the runs it authorised', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-coverage' });
  const services = createBackendServices(app.database);
  const run = await scenario.startLiveRun('n3-coverage');
  assert.ok(runRow(app.database, run.data.id).input_json.includes(MARKER_ONE));
  services.consents.revoke({ grantId: scenario.coverageConsentId, revokedByAdultId: scenario.ownerId });
  assertErased(app.database, run.data.id, MARKER_ONE);
});

test('N3: stopForRevocation(source_consent_not_current) applies the same erasure, scoped to the stale document', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-stop' });
  const other = await setupLiveCase(app, { pageText: markerPage(MARKER_TWO), suffix: 'n3-stop-b' });
  const run = await scenario.startLiveRun('n3-stop-run-a');
  const otherRun = await other.startLiveRun('n3-stop-run-b');
  assert.equal(run.data.tasks.filter(task => task.status === 'completed').length, 22);
  const otherBefore = runRow(app.database, otherRun.data.id);
  const { port } = liveService(app);

  // The document grant ends without any cascade (the bare change the commit-time check exists for).
  app.database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(new Date().toISOString(), scenario.documentConsentId);
  assert.equal(port.verifyRunSourcesCurrent(run.data.id).allowed, false);
  const stopped = port.stopForRevocation(run.data.id, { reason: 'source_consent_not_current', reasonCode: 'SOURCE_CONSENT_NOT_CURRENT' });
  assert.equal(stopped.status, 'revoked');

  assertErased(app.database, run.data.id, MARKER_ONE);
  const [erasure] = auditActions(app.database, 'analysis.derived_data_erased');
  assert.deepEqual(erasure.payload, { reason: 'source_consent_not_current', runs: 1, tasks: 22, pages: 1, documents: 1 });
  assert.equal(erasure.resourceId, run.data.id);
  assert.deepEqual({ ...runRow(app.database, otherRun.data.id) }, { ...otherBefore }, 'another household is untouched');
});

test('N3: the default stop reason (coverage consent not active) does not erase source excerpts', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-plain' });
  const { port, service } = liveService(app);
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'n3-plain' });
  port.stopForRevocation(job.id);
  assert.ok(runRow(app.database, job.id).input_json.includes(MARKER_ONE));
  assert.equal(auditActions(app.database, 'analysis.derived_data_erased').length, 0);
});

test('N3: a stop whose cause cannot be attributed to a document erases the whole run', async t => {
  const app = await startLiveServer(t);
  const scenario = await setupLiveCase(app, { pageText: markerPage(MARKER_ONE), suffix: 'n3-whole' });
  const { port, service } = liveService(app);
  const { job } = await service.createAnalysisRun({ caseId: scenario.caseId, consentGrantId: scenario.coverageConsentId, executionMode: 'live', modelPermission: true, idempotencyKey: 'n3-whole' });
  // Every document is still eligible, yet the run is stopped for source reasons.
  port.stopForRevocation(job.id, { reason: 'source_consent_not_current', reasonCode: 'COMMIT_RECHECK_ERROR' });
  assertErased(app.database, job.id, MARKER_ONE);
});

// ---------------------------------------------------------------------------
// N8: transaction nesting without DatabaseSync.isTransaction
// ---------------------------------------------------------------------------

// A runtime without DatabaseSync.isTransaction is simulated with a proxy: the property
// reads as undefined and every exec() is recorded. `real` is the unwrapped database
// (used here to hold a caller-owned transaction); `faults.begin` makes BEGIN fail.
function withoutIsTransaction(t) {
  const real = openDatabase({ path: ':memory:' });
  t.after(() => real.close());
  seedParameterWorld(real);
  const statements = [];
  const faults = { begin: null };
  const exec = sql => { statements.push(sql.trim()); if (faults.begin && /^BEGIN/.test(sql)) throw faults.begin; return real.exec(sql); };
  const database = new Proxy(real, {
    get(target, property) {
      if (property === 'isTransaction') return undefined;
      if (property === 'exec') return exec;
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  assert.equal(database.isTransaction, undefined);
  const idle = () => { real.exec('BEGIN'); real.exec('ROLLBACK'); };
  return { database, real, faults, statements, idle, services: createBackendServices(database) };
}

test('N8: without isTransaction a repository call outside any transaction opens and commits its own', t => {
  const { services, statements, idle } = withoutIsTransaction(t);
  const result = services.coverageParameters.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'consent_revoked' });
  assert.equal(result.redactedObservations, 0);
  assert.deepEqual(statements.filter(sql => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql)), ['BEGIN IMMEDIATE', 'COMMIT']);
  idle();
});

test('N8: without isTransaction a call inside a caller\'s transaction joins it through a savepoint and rolls back only itself', t => {
  const { database, real, services, statements, idle } = withoutIsTransaction(t);
  real.exec('BEGIN IMMEDIATE');
  database.prepare(`INSERT INTO policies (id, household_id, policy_kind, verification_state, created_at, updated_at)
    VALUES ('policy-outer', 'household-parameters', 'unknown', 'unverified', 'x', 'x')`).run();
  statements.length = 0;

  // Success inside the outer transaction: a savepoint, no second BEGIN.
  services.coverageParameters.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'consent_revoked' });
  const control = statements.filter(sql => /^(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)/.test(sql));
  assert.equal(control.length, 3);
  assert.equal(control[0], 'BEGIN IMMEDIATE', 'the probe is the refused outer BEGIN');
  assert.match(control[1], /^SAVEPOINT coverage_parameter_/);
  assert.match(control[2], /^RELEASE coverage_parameter_/);
  assert.ok(!control.includes('COMMIT'), 'the nested call never commits the caller\'s transaction');

  // Failure inside the savepoint: only the nested work is undone; the caller's insert survives and its transaction stays open.
  statements.length = 0;
  assert.throws(() => services.coverageParameters.redactObservationsForDocument({ documentId: 'document-missing', reasonCode: 'consent_revoked' }), /Document was not found/);
  assert.ok(statements.some(sql => /^ROLLBACK TO coverage_parameter_/.test(sql)));
  assert.ok(!statements.includes('ROLLBACK'));
  assert.equal(database.prepare("SELECT count(*) AS count FROM policies WHERE id = 'policy-outer'").get().count, 1, 'the outer transaction is intact');
  real.exec('COMMIT');
  assert.equal(database.prepare("SELECT count(*) AS count FROM policies WHERE id = 'policy-outer'").get().count, 1);
  idle();
});

test('N8: without isTransaction createRunWithParameters (its own BEGIN, nested repository calls) works and rolls back as one', t => {
  const { database, services, idle } = withoutIsTransaction(t);
  const port = createCoverageAnalysisPort({ database, services });
  const create = parameters => port.createRunWithParameters({
    id: 'run-n8', caseId: 'case-parameters', workflowName: COVERAGE_ANALYSIS_WORKFLOW.name, workflowVersion: COVERAGE_ANALYSIS_WORKFLOW.version,
    executionMode: 'fixture', input: {}, tasks: [], parameters,
  });
  const good = {
    registryVersion: 'policy-parameters/v1', householdId: 'household-parameters', caseId: 'case-parameters',
    subjectId: 'member-parameters', policyId: 'policy-parameters', requestedKeys: ['d.room_rent_limit'], receivedKeys: ['d.room_rent_limit'],
  };
  assert.throws(() => create({ ...good, subjectId: 'member-from-nowhere' }));
  assert.equal(database.prepare("SELECT count(*) AS count FROM workflow_runs WHERE id = 'run-n8'").get().count, 0);
  idle();
  const run = create(good);
  assert.equal(run.id, 'run-n8');
  assert.ok(database.prepare("SELECT count(*) AS count FROM coverage_parameter_records WHERE workflow_run_id = 'run-n8'").get().count > 0);
  idle();
});

test('N8: a BEGIN failure that is not "within a transaction" is rethrown and never mistaken for nesting', t => {
  const { services, faults, statements } = withoutIsTransaction(t);
  faults.begin = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR' });
  assert.throws(() => services.coverageParameters.redactObservationsForDocument({ documentId: 'document-parameters', reasonCode: 'consent_revoked' }), /database is locked/);
  assert.ok(!statements.some(sql => /^SAVEPOINT/.test(sql)));
});
