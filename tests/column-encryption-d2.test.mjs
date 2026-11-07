import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createBackendServices, createCoverageAnalysisPort } from '../src/backend/services/index.js';
import { createColumnCrypto, readDataEncryptionConfig, sharedColumnCrypto } from '../src/backend/security/column-crypto.js';
import { ENCRYPTED_COLUMNS, encryptExistingRows } from '../src/backend/security/column-backfill.js';
import { compositeRowId } from '../src/backend/security/sealed-records.js';
import { startApp, scenario } from './support/read-back-harness.mjs';
import { observationInput, parameterAt, parameterScope, seedParameterWorld } from './support/parameter-fixtures.mjs';

const pgOptions = postgresTestOptions();
const at = '2026-11-06T10:00:00.000Z';
const clock = () => new Date(at);
const SEALED = /^enc2\./;

// D2 (ADR 0013 addendum D2): the repositories seal the remaining user-derived columns and open them at their edge. Synthetic data only.

async function world(t) {
  const { db } = await freshDatabase(t);
  const services = createBackendServices(db, { clock });
  const owner = await services.households.createAdult({ displayName: 'Owner Synthetic' });
  const household = await services.households.createHousehold({ displayName: 'Synthetic family', ownerAdultId: owner.id });
  const member = await services.households.addMember({ householdId: household.id, adultUserId: owner.id, displayName: 'Owner Synthetic', relationshipLabel: 'SelfLabelMarker', dateOfBirth: '1985-03-04' });
  return { db, services, owner, household, member };
}

const raw = async (db, sql, params = []) => db.one(sql, params);

test('D2: member label and date of birth, case estimate and policy fields are sealed at rest and read back plain', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const row = await raw(db, 'SELECT relationship_label, date_of_birth FROM household_members WHERE id = ?', [member.id]);
  assert.match(row.relationship_label, SEALED);
  assert.match(row.date_of_birth, SEALED);
  assert.equal(member.relationship_label, 'SelfLabelMarker');
  assert.equal(member.date_of_birth, '1985-03-04');
  assert.equal((await services.households.listMembers(household.id))[0].date_of_birth, '1985-03-04');

  const updated = await services.householdApp.updateMember({ householdId: household.id, actorAdultId: owner.id, memberId: member.id, changes: { relationshipLabel: 'Renamed', dateOfBirth: null } });
  assert.equal(updated.relationship_label, 'Renamed');
  assert.equal(updated.date_of_birth, null);
  assert.match((await raw(db, 'SELECT relationship_label FROM household_members WHERE id = ?', [member.id])).relationship_label, SEALED);

  const insurer = await services.householdApp.findOrCreateInsurer({ legalName: 'Synthetic Insurer' });
  const policy = await services.householdApp.createPolicy({
    householdId: household.id, actorAdultId: owner.id, insurerId: insurer.id, policyKind: 'personal', policyNumberMasked: 'XXXX-4021',
    startsOn: '2026-04-01', endsOn: '2027-03-31', memberIds: [member.id],
  });
  assert.equal(policy.ends_on, '2027-03-31');
  assert.equal(policy.policy_number_masked, 'XXXX-4021');
  const stored = await raw(db, 'SELECT policy_number_masked, starts_on, ends_on FROM policies WHERE id = ?', [policy.id]);
  for (const value of Object.values(stored)) assert.match(value, SEALED);
  assert.equal((await services.householdApp.listPolicies(household.id))[0].ends_on, '2027-03-31');

  const created = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'planned_care', statedEstimateMinor: 12345600, currency: 'INR' });
  assert.equal(created.stated_estimate_minor, 12345600);
  assert.equal('stated_estimate_ciphertext' in created, false);
  const storedCase = await raw(db, 'SELECT stated_estimate_minor, stated_estimate_ciphertext FROM service_cases WHERE id = ?', [created.id]);
  assert.equal(storedCase.stated_estimate_minor, null, 'the plain bigint is not written');
  assert.match(storedCase.stated_estimate_ciphertext, SEALED);
  // Equal-purpose values store the same length whatever the amount.
  const small = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'planned_care', statedEstimateMinor: 5 });
  assert.equal((await raw(db, 'SELECT stated_estimate_ciphertext AS c FROM service_cases WHERE id = ?', [small.id])).c.length, storedCase.stated_estimate_ciphertext.length);
  assert.equal((await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'planned_care' })).stated_estimate_minor ?? null, null);
  // The access service (the route layer's reader) returns the same amount, opened.
  const viaAccess = await services.access.requireCase({ adultId: owner.id }, created.id);
  assert.equal(viaAccess.stated_estimate_minor, 12345600);
  assert.equal('stated_estimate_ciphertext' in viaAccess, false);
});

test('D2: workflow runs, tasks, events and idempotency records are sealed at rest; the repository reads them plain', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal' });
  const MARK = 'ExcerptMarkerSynthetic';
  const run = await services.workflows.createRunWithTasks({
    caseId: kase.id, workflowName: 'fixture-flow', executionMode: 'fixture', input: { sourcePages: [{ text: MARK }] },
    tasks: [{ key: 'a', agentName: 'agent-a', taskKind: 'analyse', input: { key: 'a', note: MARK } }],
  });
  assert.equal(run.input_json.includes(MARK), true, 'the repository returns the plain run input');
  assert.equal(run.tasks[0].input_json.includes(MARK), true);
  const stored = await raw(db, 'SELECT input_json FROM workflow_runs WHERE id = ?', [run.id]);
  assert.match(stored.input_json, SEALED);

  const claimed = await services.workflows.claimNext({ workerId: 'w1' });
  assert.equal(claimed.id, run.tasks[0].id);
  await services.workflows.completeTask(claimed.id, { output: { result: MARK }, workerId: 'w1' });
  const done = await services.workflows.getTask(claimed.id);
  assert.deepEqual(JSON.parse(done.output_json), { result: MARK });
  assert.match((await raw(db, 'SELECT output_json FROM workflow_tasks WHERE id = ?', [claimed.id])).output_json, SEALED);
  assert.match((await raw(db, 'SELECT event_payload_json FROM workflow_events ORDER BY id LIMIT 1')).event_payload_json, SEALED);

  // Failure text and a blocked descendant's message are sealed too.
  const second = await services.workflows.createRunWithTasks({
    caseId: kase.id, workflowName: 'fixture-flow-2', executionMode: 'fixture', input: {},
    tasks: [{ key: 'a', agentName: 'agent-a', taskKind: 'analyse', input: { key: 'a' } }, { key: 'b', agentName: 'agent-b', taskKind: 'analyse', dependsOn: ['a'], input: { key: 'b' } }],
  });
  const first = await services.workflows.claimNext({ workerId: 'w2', runId: second.id });
  await services.workflows.failTask(first.id, { workerId: 'w2', code: 'TASK_FAILED', message: `failed ${MARK}` });
  const failed = await services.workflows.getTask(first.id);
  assert.equal(failed.last_error_message, `failed ${MARK}`);
  const messages = await db.many('SELECT last_error_message FROM workflow_tasks WHERE last_error_message IS NOT NULL');
  assert.equal(messages.length, 2);
  for (const message of messages) assert.match(message.last_error_message, SEALED);
  assert.equal((await services.workflows.listTasks(second.id)).find(task => task.status === 'blocked').last_error_message, 'A required upstream task did not complete.');

  // Idempotent enqueue replays the sealed response.
  const enqueued = await services.workflows.enqueueTask({ runId: run.id, agentName: 'agent-c', taskKind: 'analyse', input: { key: 'c' }, idempotencyKey: 'idem-key-d2-0001' });
  const replay = await services.workflows.enqueueTask({ runId: run.id, agentName: 'agent-c', taskKind: 'analyse', input: { key: 'c' }, idempotencyKey: 'idem-key-d2-0001' });
  assert.equal(replay.id, enqueued.id);
  assert.match((await raw(db, "SELECT response_json FROM idempotency_keys WHERE scope = 'workflow_task'")).response_json, SEALED);
});

test('D2: parameter observations and resolved values are sealed at rest and read back plain', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const repository = services.coverageParameters;
  await repository.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });
  const record = await repository.createParameter({ id: 'parameter-d2', registryVersion: 'policy-parameters/v1', parameterKey: 'd.room_rent_limit', ...parameterScope(), updatedBy: 'test' });
  const observation = await repository.appendObservation({ parameterRecordId: record.id, ...observationInput({ value: { amountMinor: 987654 } }) });
  assert.deepEqual(observation.value, { amountMinor: 987654 });
  assert.match((await raw(database, 'SELECT value_json FROM coverage_parameter_observations WHERE id = ?', [observation.id])).value_json, SEALED);
  const resolved = await repository.setResolution({ parameterRecordId: record.id, state: 'extracted_unverified', observationId: observation.id, updatedBy: 'test' });
  assert.deepEqual(resolved.resolvedValue, { amountMinor: 987654 });
  assert.match((await raw(database, 'SELECT resolved_value_json FROM coverage_parameter_resolutions WHERE parameter_record_id = ?', [record.id])).resolved_value_json, SEALED);
  assert.deepEqual((await repository.listObservations(record.id))[0].value, { amountMinor: 987654 });
});

test('D2: a consent revocation reason is sealed and never copied into the audit payload', pgOptions, async t => {
  const { db, services, owner, household } = await world(t);
  const grant = await services.consents.grant({
    householdId: household.id, subjectAdultId: owner.id, grantedToActor: 'coversaath-local', purpose: 'document_processing', noticeVersion: 'v1', evidenceMethod: 'fixture',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  await services.consents.revoke({ grantId: grant.id, revokedByAdultId: owner.id, reason: 'ReasonMarkerSynthetic' });
  assert.match((await raw(db, 'SELECT reason FROM consent_revocations')).reason, SEALED);
  const event = await raw(db, "SELECT event_payload_json FROM audit_events WHERE action = 'consent.revoked'");
  assert.equal(event.event_payload_json.includes('ReasonMarkerSynthetic'), false);
  assert.deepEqual(JSON.parse(event.event_payload_json), { reasonProvided: true });
});

// Reads every registry column of every row in plain, whatever its stored form, keyed for comparison.
async function plainSnapshot(db, crypto) {
  const out = {};
  for (const entry of ENCRYPTED_COLUMNS) {
    const key = entry.key ?? ['id'];
    const rows = await db.many(`SELECT * FROM ${entry.table} ORDER BY ${key.join(', ')}`);
    out[entry.table] = rows.map(row => {
      const rowId = entry.rowId ? entry.rowId(row) : String(row[key[0]]);
      const copy = {};
      for (const column of entry.columns) copy[column] = row[column] == null ? null : crypto.open(entry.table, column, rowId, row[column]);
      if (entry.legacy) { copy[entry.legacy.to] = copy[entry.legacy.to] ?? (row[entry.legacy.column] === null ? null : String(row[entry.legacy.column])); }
      return copy;
    });
  }
  return JSON.stringify(out);
}

test('D2: the backfill seals legacy plaintext in the new columns once (second run 0 rows), unseals back, and rotation re-seals', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const crypto = sharedColumnCrypto();
  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal', statedEstimateMinor: 777 });
  const run = await services.workflows.createRunWithTasks({ caseId: kase.id, workflowName: 'fixture-flow', executionMode: 'fixture', input: { n: 1 }, tasks: [{ key: 'a', agentName: 'agent-a', taskKind: 'analyse', input: { key: 'a' } }] });
  await services.workflows.claimNext({ workerId: 'w' });
  await services.workflows.enqueueTask({ runId: run.id, agentName: 'agent-c', taskKind: 'analyse', input: { key: 'c' }, idempotencyKey: 'idem-key-d2-0002' });
  // A document-upload idempotency record, as the upload path writes it (the blind index is derived by the backfill for legacy rows).
  await db.run(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
    VALUES ('document-upload:a:b', 'legacy-key-0001', ?, 201, ?, ?, ?)`, ['d'.repeat(64), JSON.stringify({ document: { id: 'document-legacy', originalFilename: 'FileMarker.pdf' } }), '2099-01-01T00:00:00.000Z', at]);
  const before = await plainSnapshot(db, crypto);

  // Turn the D2 columns back into what an older build wrote.
  const unsealed = await encryptExistingRows({ database: db, crypto, unseal: true });
  assert.ok(unsealed.rows > 0);
  assert.equal(await db.one("SELECT count(*) AS n FROM household_members WHERE date_of_birth ~ '^enc'").then(row => row.n), 0);
  const legacyCase = await raw(db, 'SELECT stated_estimate_minor, stated_estimate_ciphertext FROM service_cases WHERE id = ?', [kase.id]);
  assert.equal(Number(legacyCase.stated_estimate_minor), 777);
  assert.equal(legacyCase.stated_estimate_ciphertext, null);
  assert.equal((await services.cases.get(kase.id)).stated_estimate_minor, 777, 'legacy rows still read');
  assert.equal((await services.workflows.getRun(run.id)).input_json, JSON.stringify({ n: 1 }));
  assert.equal(await plainSnapshot(db, crypto), before);
  assert.equal((await encryptExistingRows({ database: db, crypto, unseal: true })).rows, 0, 'a second unseal changes 0 rows');

  const snapshot = async () => JSON.stringify(await Promise.all(ENCRYPTED_COLUMNS.map(item => db.many(`SELECT * FROM ${item.table} ORDER BY ${(item.key ?? ['id']).join(', ')}`))));
  const rawBefore = await snapshot();
  const dry = await encryptExistingRows({ database: db, crypto, dryRun: true });
  assert.ok(dry.rows > 0);
  assert.equal(await snapshot(), rawBefore, 'a dry run writes nothing');
  const first = await encryptExistingRows({ database: db, crypto, batchSize: 1 });
  assert.equal(first.rows, dry.rows);
  assert.equal(first.columns, dry.columns);
  const second = await encryptExistingRows({ database: db, crypto });
  assert.equal(second.rows, 0, 'a second run changes 0 rows');
  assert.equal(second.columns, 0);
  assert.equal(await plainSnapshot(db, crypto), before, 'sealing keeps every value');
  assert.match((await raw(db, 'SELECT stated_estimate_ciphertext FROM service_cases WHERE id = ?', [kase.id])).stated_estimate_ciphertext, SEALED);
  assert.equal((await raw(db, 'SELECT stated_estimate_minor FROM service_cases WHERE id = ?', [kase.id])).stated_estimate_minor, null);
  const indexed = await raw(db, "SELECT document_index FROM idempotency_keys WHERE idempotency_key = 'legacy-key-0001'");
  assert.equal(indexed.document_index, crypto.blindIndex('idempotency_keys.document', 'document-legacy'));
  // No trigger is left disabled.
  const triggers = await db.many('SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled <> ?', ['O']);
  assert.deepEqual(triggers, []);
  assert.equal(JSON.stringify(first).includes('FileMarker'), false, 'the report carries counts only');

});

// Review P1: one undecryptable run input must not abort a revocation or a document erasure. The run is erased conservatively.
async function grantedRun(db, services, owner, household, member, input) {
  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal' });
  const grant = await services.consents.grant({
    householdId: household.id, subjectAdultId: owner.id, grantedToActor: 'coversaath-local', purpose: 'document_processing', noticeVersion: 'v1', evidenceMethod: 'fixture',
    scopes: [{ resourceType: 'document', action: 'collect', dataCategory: 'insurance_document' }],
  });
  const run = await services.workflows.createRunWithTasks({
    caseId: kase.id, workflowName: 'fixture-flow', executionMode: 'fixture', consentGrantId: grant.id, input,
    tasks: [{ key: 'a', agentName: 'agent-a', taskKind: 'analyse', input: { key: 'a' } }],
  });
  return { kase, grant, run };
}

test('review P1: revocation succeeds and erases when a run input cannot be decrypted', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const good = await grantedRun(db, services, owner, household, member, { sourcePages: [{ sourceId: 's', documentId: 'd', version: '1', page: 1, text: 'GoodExcerptMarker' }] });
  const bad = await grantedRun(db, services, owner, household, member, { sourcePages: [{ sourceId: 's', documentId: 'd', version: '1', page: 1, text: 'BadExcerptMarker' }] });
  // Another run's ciphertext moved onto this row: it cannot be opened (the row id is in the AAD).
  await db.run('UPDATE workflow_runs SET input_json = (SELECT input_json FROM workflow_runs WHERE id = ?) WHERE id = ?', [good.run.id, bad.run.id]);
  await assert.rejects(services.workflows.getRun(bad.run.id), { code: 'COLUMN_DECRYPTION_FAILED' });

  await services.consents.revoke({ grantId: bad.grant.id, revokedByAdultId: owner.id, reason: null });
  const after = await raw(db, 'SELECT status, input_json FROM workflow_runs WHERE id = ?', [bad.run.id]);
  assert.equal(after.status, 'revoked');
  assert.equal(after.input_json, null, 'the unreadable input is erased, not kept');
  // The readable run of another grant is untouched.
  assert.equal(JSON.parse((await services.workflows.getRun(good.run.id)).input_json).sourcePages[0].text, 'GoodExcerptMarker');
  assert.equal((await raw(db, 'SELECT status FROM workflow_runs WHERE id = ?', [good.run.id])).status, 'queued');
});

test('review P1: a document erasure erases an unreadable run of the household instead of aborting', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const bad = await grantedRun(db, services, owner, household, member, { sourcePages: [{ sourceId: 's', documentId: 'doc-x', version: '1', page: 1, text: 'BadExcerptMarker' }] });
  await db.run("UPDATE workflow_runs SET input_json = 'enc2.dev.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = ?", [bad.run.id]);
  await services.consents.eraseDerivedRunData({
    householdId: household.id, documentIds: ['doc-x'], runIds: [], caseId: bad.kase.id, reason: 'document_erasure', resourceType: 'document', resourceId: 'doc-x',
  });
  const after = await raw(db, 'SELECT status, input_json FROM workflow_runs WHERE id = ?', [bad.run.id]);
  assert.equal(after.status, 'revoked');
  assert.equal(after.input_json, null);
});

// ---- review fixes ----

test('review: ciphertext of a D2 column cannot be moved to another row (member date of birth, workflow event payload, task input)', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const second = await services.households.addMember({ householdId: household.id, displayName: 'Second Synthetic', dateOfBirth: '1990-01-01', memberKind: 'dependent' });
  const dobs = await db.many('SELECT id, date_of_birth FROM household_members ORDER BY id');
  const other = dobs.find(row => row.id !== member.id);
  await db.run('UPDATE household_members SET date_of_birth = ? WHERE id = ?', [dobs.find(row => row.id === member.id).date_of_birth, other.id]);
  await assert.rejects(services.households.getMember?.(other.id) ?? services.householdApp.getMember(household.id, other.id), { code: 'COLUMN_DECRYPTION_FAILED' });
  assert.ok(second);

  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal' });
  await services.workflows.createRunWithTasks({
    caseId: kase.id, workflowName: 'fixture-flow', executionMode: 'fixture', input: {},
    tasks: [{ key: 'a', agentName: 'agent-a', taskKind: 'analyse', input: { key: 'a' } }, { key: 'b', agentName: 'agent-b', taskKind: 'analyse', input: { key: 'b' } }],
  });
  await services.workflows.claimNext({ workerId: 'w' });
  await services.workflows.claimNext({ workerId: 'w' });
  const events = await db.many('SELECT id, event_payload_json FROM workflow_events ORDER BY id');
  assert.equal(events.length, 2);
  const crypto = sharedColumnCrypto();
  assert.equal(JSON.parse(crypto.open('workflow_events', 'event_payload_json', String(events[0].id), events[0].event_payload_json)).workerId, 'w');
  assert.throws(() => crypto.open('workflow_events', 'event_payload_json', String(events[1].id), events[0].event_payload_json), { code: 'COLUMN_DECRYPTION_FAILED' }, 'the event payload is bound to its own row');
  const tasks = await db.many('SELECT id, input_json FROM workflow_tasks ORDER BY id');
  assert.throws(() => crypto.open('workflow_tasks', 'input_json', tasks[1].id, tasks[0].input_json), { code: 'COLUMN_DECRYPTION_FAILED' });
});

test('review: composite row ids cannot collide when a key part contains the separator', () => {
  const crypto = sharedColumnCrypto();
  const first = crypto.seal('idempotency_keys', 'response_json', compositeRowId('a:b', 'c'), 'x');
  assert.throws(() => crypto.open('idempotency_keys', 'response_json', compositeRowId('a', 'b:c'), first), { code: 'COLUMN_DECRYPTION_FAILED' });
  assert.notEqual(compositeRowId('a', 'bc'), compositeRowId('ab', 'c'));
});

test('review: a real rotation re-seals every D2 column and the document index under the new key, idempotently', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal', statedEstimateMinor: 4242 });
  const run = await services.workflows.createRunWithTasks({ caseId: kase.id, workflowName: 'fixture-flow', executionMode: 'fixture', input: { n: 1 }, tasks: [{ key: 'a', agentName: 'agent-a', taskKind: 'analyse', input: { key: 'a' } }] });
  await services.workflows.claimNext({ workerId: 'w' });
  const expires = '2099-01-01T00:00:00.000Z';
  const uploadScope = 'document-upload:a:b';
  const dev = sharedColumnCrypto();
  // A document-upload record as the upload path writes it, with its index (under the development key).
  await db.run(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, document_index, expires_at, created_at)
    VALUES (?, 'upload-key-0001', ?, 201, ?, ?, ?, ?)`, [uploadScope, 'd'.repeat(64),
    dev.seal('idempotency_keys', 'response_json', compositeRowId(uploadScope, 'upload-key-0001'), JSON.stringify({ document: { id: 'document-rot' } })),
    dev.blindIndex('idempotency_keys.document', 'document-rot'), expires, at]);
  // Move everything to key k1 (from the development key), then rotate k1 to k2.
  await encryptExistingRows({ database: db, crypto: dev, unseal: true, includeE1: true });
  const k1Key = randomBytes(32).toString('base64');
  const k1 = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: k1Key, DATA_ENCRYPTION_KEY_ID: 'k1' }));
  const sealed = await encryptExistingRows({ database: db, crypto: k1 });
  assert.equal(sealed.unreadable, 0);
  const indexUnder = async crypto => (await raw(db, "SELECT document_index FROM idempotency_keys WHERE idempotency_key = 'upload-key-0001'")).document_index === crypto.blindIndex('idempotency_keys.document', 'document-rot');
  assert.equal(await indexUnder(k1), true, 'the index is derived while sealing');
  const k2 = createColumnCrypto(readDataEncryptionConfig({
    DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k1: k1Key }),
  }));
  assert.equal((await encryptExistingRows({ database: db, crypto: k2 })).rows, 0, 'without --rotate nothing is touched');
  assert.equal(await indexUnder(k1), true);
  const rotated = await encryptExistingRows({ database: db, crypto: k2, rotate: true });
  assert.ok(rotated.rows > 0);
  assert.equal(rotated.unreadable, 0);
  for (const entry of ENCRYPTED_COLUMNS) {
    for (const column of entry.columns) {
      const wrong = await raw(db, `SELECT count(*) AS n FROM ${entry.table} WHERE ${column} IS NOT NULL AND left(${column}, 8) <> 'enc2.k2.'`);
      assert.equal(wrong.n, 0, `${entry.table}.${column} is under k2`);
    }
  }
  assert.equal(await indexUnder(k2), true, 'the document index was recomputed under the new key');
  assert.equal(await indexUnder(k1), false);
  assert.equal((await encryptExistingRows({ database: db, crypto: k2, rotate: true })).rows, 0, 'a second rotation changes 0 rows');
  const reading = createBackendServices(db, { columnCrypto: k2, clock });
  assert.equal((await reading.cases.get(kase.id)).stated_estimate_minor, 4242);
  assert.equal(JSON.parse((await reading.workflows.getRun(run.id)).input_json).n, 1);
});

test('review: an undecryptable value is left alone and counted, and the rest of the table is still processed', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const crypto = sharedColumnCrypto();
  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal' });
  await services.workflows.createRunWithTasks({ caseId: kase.id, workflowName: 'f1', executionMode: 'fixture', input: { n: 1 }, tasks: [] });
  await services.workflows.createRunWithTasks({ caseId: kase.id, workflowName: 'f2', executionMode: 'fixture', input: { n: 2 }, tasks: [] });
  const rows = await db.many('SELECT id, input_json FROM workflow_runs ORDER BY id');
  // Run 1 holds ciphertext of an unknown key id; run 2 is legacy plaintext.
  await db.run("UPDATE workflow_runs SET input_json = 'enc2.zz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = ?", [rows[0].id]);
  await db.run('UPDATE workflow_runs SET input_json = ? WHERE id = ?', [JSON.stringify({ n: 2 }), rows[1].id]);
  // Only --rotate opens values that are already sealed, so that is where a value of an unknown key shows up.
  const report = await encryptExistingRows({ database: db, crypto, rotate: true });
  assert.equal(report.tables.find(item => item.table === 'workflow_runs').unreadable, 1);
  assert.equal(report.unreadable >= 1, true);
  assert.match((await raw(db, 'SELECT input_json FROM workflow_runs WHERE id = ?', [rows[1].id])).input_json, SEALED, 'the readable row was sealed');
  assert.equal((await raw(db, 'SELECT input_json FROM workflow_runs WHERE id = ?', [rows[0].id])).input_json.startsWith('enc2.zz.'), true, 'the unreadable row is untouched');
  assert.equal((await encryptExistingRows({ database: db, crypto, rotate: true })).unreadable >= 1, true, 'it keeps being reported');
});

test('review: a failing batch rolls back sealing and index together and leaves the blocking trigger enabled', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  await services.coverageParameters.pinRegistry({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1' });
  const record = await services.coverageParameters.createParameter({ id: 'parameter-fail', registryVersion: 'policy-parameters/v1', parameterKey: 'd.room_rent_limit', ...parameterScope(), updatedBy: 'test' });
  await services.coverageParameters.appendObservation({ parameterRecordId: record.id, ...observationInput() });
  const crypto = sharedColumnCrypto();
  await encryptExistingRows({ database, crypto, unseal: true });
  const uploadScope = 'document-upload:a:b';
  await database.run(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
    VALUES (?, 'legacy-key-0002', ?, 201, ?, '2099-01-01T00:00:00.000Z', ?)`, [uploadScope, 'd'.repeat(64), JSON.stringify({ document: { id: 'document-fail' } }), parameterAt]);
  const fail = table => {
    const failure = (sql, params) => (new RegExp(`^\\s*UPDATE public\\."${table}"`).test(sql)
      ? Promise.reject(Object.assign(new Error('synthetic storage failure'), { code: 'XX001' })) : database.run(sql, params));
    return new Proxy(database, { get: (target, name) => (name === 'run' ? failure : typeof target[name] === 'function' ? target[name].bind(target) : target[name]) });
  };
  await assert.rejects(encryptExistingRows({ database: fail('coverage_parameter_observations'), crypto }), { code: 'XX001' });
  const trigger = await raw(database, "SELECT tgenabled FROM pg_trigger WHERE tgname = 'coverage_parameter_observations_no_update'");
  assert.equal(trigger.tgenabled, 'O', 'the failed batch did not leave the trigger disabled');
  assert.equal((await raw(database, 'SELECT count(*) AS n FROM coverage_parameter_observations WHERE value_json IS NOT NULL AND value_json !~ \'^enc\'')).n, 1, 'the failed table is unchanged');
  // The index is written with the sealing in one statement: when that statement fails neither the seal nor the index is stored.
  await assert.rejects(encryptExistingRows({ database: fail('idempotency_keys'), crypto }), { code: 'XX001' });
  const key = await raw(database, "SELECT response_json, document_index FROM idempotency_keys WHERE idempotency_key = 'legacy-key-0002'");
  assert.equal(key.document_index, null);
  assert.equal(key.response_json.startsWith('{'), true);
  await encryptExistingRows({ database, crypto });
  const done = await raw(database, "SELECT response_json, document_index FROM idempotency_keys WHERE idempotency_key = 'legacy-key-0002'");
  assert.match(done.response_json, SEALED);
  assert.equal(done.document_index, crypto.blindIndex('idempotency_keys.document', 'document-fail'));
});

test('review: unseal covers the D2 columns only by default; E1 columns stay sealed unless includeE1', pgOptions, async t => {
  const { db, services, household, member } = await world(t);
  const crypto = sharedColumnCrypto();
  const report = await encryptExistingRows({ database: db, crypto, unseal: true });
  assert.ok(report.rows > 0);
  assert.equal(report.tables.some(item => item.table === 'adult_users' || item.table === 'households'), false);
  assert.equal((await raw(db, 'SELECT date_of_birth FROM household_members WHERE id = ?', [member.id])).date_of_birth, '1985-03-04');
  assert.match((await raw(db, 'SELECT display_name FROM households WHERE id = ?', [household.id])).display_name, SEALED, 'an E1 column stays sealed');
  assert.equal((await services.households.getHousehold(household.id)).display_name, 'Synthetic family');
  await assert.rejects(encryptExistingRows({ database: db, crypto, includeE1: true }), RangeError);
  await encryptExistingRows({ database: db, crypto, unseal: true, includeE1: true });
  assert.equal((await raw(db, 'SELECT display_name FROM households WHERE id = ?', [household.id])).display_name, 'Synthetic family');
});

test('review: the backfill validates the checks migration 030 added NOT VALID', pgOptions, async t => {
  const { db } = await world(t);
  const pending = async () => (await db.many("SELECT conname FROM pg_constraint WHERE NOT convalidated AND conname ~ 'sealed'")).length;
  assert.ok(await pending() > 0, 'migration 030 leaves them to the backfill');
  const dry = await encryptExistingRows({ database: db, crypto: sharedColumnCrypto(), dryRun: true });
  assert.equal(dry.validated, 0);
  const report = await encryptExistingRows({ database: db, crypto: sharedColumnCrypto() });
  assert.ok(report.validated > 0);
  assert.equal(await pending(), 0);
  assert.equal((await encryptExistingRows({ database: db, crypto: sharedColumnCrypto() })).validated, 0);
});

test('review: erasing a run empties its graph snapshot with a sealed marker and counts it once', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const crypto = sharedColumnCrypto();
  const { kase, run } = await grantedRun(db, services, owner, household, member, { n: 1 });
  await db.run(`INSERT INTO coverage_graph_snapshots (id, household_id, case_id, version, status, graph_json, generated_by_run_id, created_at)
    VALUES ('graph-1', ?, ?, 1, 'draft', ?, ?, ?)`, [household.id, kase.id, crypto.seal('coverage_graph_snapshots', 'graph_json', 'graph-1', JSON.stringify({ nodes: ['GraphMarker'] })), run.id, at]);
  const erase = () => services.consents.eraseDerivedRunData({ householdId: household.id, documentIds: [], runIds: [run.id], caseId: kase.id, reason: 'consent_revoked', resourceType: 'case', resourceId: kase.id });
  await erase();
  const stored = await raw(db, "SELECT status, graph_json FROM coverage_graph_snapshots WHERE id = 'graph-1'");
  assert.equal(stored.status, 'superseded');
  assert.match(stored.graph_json, SEALED);
  assert.equal(crypto.open('coverage_graph_snapshots', 'graph_json', 'graph-1', stored.graph_json), '{}');
  await erase();
  const events = await db.many("SELECT event_payload_json FROM audit_events WHERE action = 'analysis.derived_data_erased' ORDER BY id");
  assert.equal(JSON.parse(events[0].event_payload_json).graphs, 1);
  assert.equal(JSON.parse(events.at(-1).event_payload_json).graphs ?? 0, 0, 'an already erased snapshot is not counted again');
});

test('review: an OCR job error message from the provider is sealed at rest and read back plain', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const job = await services.ocr.createJob({
    id: 'ocr-d2', documentUploadId: 'document-parameters', provider: 'fixture', status: 'queued', contractVersion: 'knowvia.ocr.v1',
    authorization: { requestedByAdultId: 'adult-parameters' }, requestedAt: parameterAt, updatedAt: parameterAt,
  });
  const failed = await services.ocr.updateJob(job.id, { status: 'failed', errorCode: 'OCR_PROVIDER_FAILED', errorMessage: 'ProviderTextMarker could not read the page', completedAt: parameterAt, updatedAt: parameterAt });
  assert.equal(failed.errorMessage, 'ProviderTextMarker could not read the page');
  assert.match((await raw(database, 'SELECT error_message FROM ocr_jobs WHERE id = ?', [job.id])).error_message, SEALED);
});

test('review P1: stopping a run whose input cannot be decrypted revokes and erases it', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const bad = await grantedRun(db, services, owner, household, member, { sourcePages: [{ sourceId: 's', documentId: 'd', version: '1', page: 1, text: 'BadExcerptMarker' }] });
  await db.run("UPDATE workflow_runs SET input_json = 'enc2.dev.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = ?", [bad.run.id]);
  const port = createCoverageAnalysisPort({ database: db, services, clock });
  await port.stopForRevocation(bad.run.id, { reason: 'source_consent_not_current' });
  const after = await raw(db, 'SELECT status, input_json FROM workflow_runs WHERE id = ?', [bad.run.id]);
  assert.equal(after.status, 'revoked');
  assert.equal(after.input_json, null);
});

// ---- second review ----

test('review P2: erasure routes tolerate an unreadable stated estimate; money reads still fail closed', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  await app.call(`/api/v1/cases/${s.caseId}/profile-answers`, { method: 'PUT', token: s.token, body: { answers: { city: 'Pune' } } });
  await app.database.run("UPDATE service_cases SET stated_estimate_ciphertext = 'enc2.zz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = ?", [s.caseId]);
  // Reading the amount fails closed: nothing may treat an unreadable estimate as zero.
  const read = await app.call(`/api/v1/cases/${s.caseId}`, { token: s.token });
  assert.equal(read.status, 500, JSON.stringify(read.data));
  assert.equal(read.data.error.code, 'COLUMN_DECRYPTION_FAILED');
  // Erasure and erasure discovery do not read the amount.
  const inventory = await app.call(`/api/v1/cases/${s.caseId}/documents/deletion-inventory`, { token: s.token });
  assert.equal(inventory.status, 200, JSON.stringify(inventory.data));
  const erased = await app.call(`/api/v1/cases/${s.caseId}/profile-answers`, { method: 'DELETE', token: s.token });
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  assert.equal((await app.database.one('SELECT count(*) AS n FROM profile_answers WHERE case_id = ?', [s.caseId])).n, 0);
});

test('review P2: document erasure finds the idempotency record whose index was made under a previous key', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const oldKey = randomBytes(32).toString('base64');
  const k1 = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: oldKey, DATA_ENCRYPTION_KEY_ID: 'k1' }));
  const k2 = createColumnCrypto(readDataEncryptionConfig({
    DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k1: oldKey }),
  }));
  const scope = 'document-upload:adult-parameters:case-parameters';
  await database.run(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, document_index, expires_at, created_at)
    VALUES (?, 'old-key-0001', ?, 201, ?, ?, '2099-01-01T00:00:00.000Z', ?)`, [scope, 'd'.repeat(64),
    k1.seal('idempotency_keys', 'response_json', compositeRowId(scope, 'old-key-0001'), JSON.stringify({ document: { id: 'document-parameters' } })),
    k1.blindIndex('idempotency_keys.document', 'document-parameters'), parameterAt]);
  // The data key changed (k2 now current) but --rotate has not run: the record still carries the k1 index.
  const services = createBackendServices(database, { columnCrypto: k2, clock: () => new Date(parameterAt) });
  await database.run("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-parameters'");
  assert.equal(await services.documents.completeDeletion('document-parameters'), true);
  assert.equal((await raw(database, "SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key = 'old-key-0001'")).n, 0, 'the record under the previous key was erased');
});

test('review P2: the backfill refuses to run with DATA_ENCRYPTION_LEGACY_PLAINTEXT=false and says why', pgOptions, async t => {
  const { db } = await world(t);
  const strict = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_LEGACY_PLAINTEXT: 'false' }));
  for (const options of [{}, { rotate: true }, { dryRun: true }]) {
    await assert.rejects(encryptExistingRows({ database: db, crypto: strict, ...options }), error => error.code === 'BACKFILL_LEGACY_PLAINTEXT_REFUSED' && /DATA_ENCRYPTION_LEGACY_PLAINTEXT/.test(error.message));
  }
});

// ---- third review ----

test('review P1: stopping a run does not need the stated estimate (an unreadable amount cannot block the stop or the erasure)', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const bad = await grantedRun(db, services, owner, household, member, { sourcePages: [{ sourceId: 's', documentId: 'd', version: '1', page: 1, text: 'EstimateExcerptMarker' }] });
  await db.run("UPDATE service_cases SET stated_estimate_ciphertext = 'enc2.zz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = ?", [bad.kase.id]);
  await assert.rejects(services.cases.get(bad.kase.id), { code: 'COLUMN_DECRYPTION_FAILED' }, 'reading the amount still fails closed');
  const port = createCoverageAnalysisPort({ database: db, services, clock });
  await port.stopForRevocation(bad.run.id, { reason: 'source_consent_not_current' });
  const after = await raw(db, 'SELECT status, input_json FROM workflow_runs WHERE id = ?', [bad.run.id]);
  assert.equal(after.status, 'revoked');
  assert.ok(!String(after.input_json).includes('EstimateExcerptMarker'));
  assert.ok(after.input_json === null || /^enc2\./.test(after.input_json));
  assert.equal(JSON.parse((await services.workflows.getRun(bad.run.id)).input_json).sourcePages[0].redacted !== undefined, true, 'the excerpt is redacted, not kept');
});

test('review P2: requireCase checks the household before it decrypts, so a stranger sees not-found, never a decryption error', pgOptions, async t => {
  const { db, services, owner, household, member } = await world(t);
  const kase = await services.cases.create({ householdId: household.id, subjectMemberId: member.id, openedByAdultId: owner.id, triggerType: 'renewal', statedEstimateMinor: 10 });
  await db.run("UPDATE service_cases SET stated_estimate_ciphertext = 'enc2.zz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = ?", [kase.id]);
  const stranger = await services.households.createAdult({ displayName: 'Stranger Synthetic' });
  await services.households.createHousehold({ displayName: 'Other family', ownerAdultId: stranger.id });
  await assert.rejects(services.access.requireCase({ adultId: stranger.id }, kase.id), { code: 'HOUSEHOLD_NOT_FOUND' });
  await assert.rejects(services.access.requireCase({ adultId: stranger.id }, 'case-missing'), { code: 'CASE_NOT_FOUND' });
  // The owner, who may see the case, still gets the decryption error for the amount.
  await assert.rejects(services.access.requireCase({ adultId: owner.id }, kase.id), { code: 'COLUMN_DECRYPTION_FAILED' });
});

test('review P2: document erasure reports the sealed upload records it could not attribute (a count only)', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const services = createBackendServices(database, { clock: () => new Date(parameterAt) });
  const scope = 'document-upload:adult-parameters:case-parameters';
  await database.run(`INSERT INTO idempotency_keys (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
    VALUES (?, 'sealed-unknown-1', ?, 201, 'enc2.zz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', '2099-01-01T00:00:00.000Z', ?)`, [scope, 'd'.repeat(64), parameterAt]);
  await database.run("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-parameters'");
  assert.equal(await services.documents.completeDeletion('document-parameters'), true);
  const event = await raw(database, "SELECT event_payload_json FROM audit_events WHERE action = 'document.bytes_deleted'");
  assert.deepEqual(JSON.parse(event.event_payload_json), { unattributedUploadRecords: 1 });
  // The record stays (its document is unknown); nothing readable was added to the audit.
  assert.equal((await raw(database, "SELECT count(*) AS n FROM idempotency_keys WHERE idempotency_key = 'sealed-unknown-1'")).n, 1);
});

test('review P2: an unreadable filename is reported through onUnreadable (no filename, no ciphertext) and flagged on the record', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedParameterWorld(database);
  const events = [];
  const services = createBackendServices(database, { clock: () => new Date(parameterAt), onUnreadable: event => events.push(event) });
  await database.run("UPDATE document_uploads SET original_filename = 'enc2.zz.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA' WHERE id = 'document-parameters'");
  const record = await services.documents.getDocument('document-parameters');
  assert.equal(record.originalFilename, null);
  assert.equal(record.originalFilenameUnreadable, true);
  assert.deepEqual(events, [{ table: 'document_uploads', column: 'original_filename' }]);
  assert.equal(JSON.stringify(events).includes('enc2'), false);
});
