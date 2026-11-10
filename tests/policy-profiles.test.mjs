import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { startApp, scenario, fixture, uploadDocument, eventually, bootstrapToken } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { createPolicyProfileService } from '../src/backend/services/policy-profile-service.js';
import { PolicyProfileRepository, parseProfileStatement } from '../src/backend/repositories/policy-profile-repository.js';
import { setPageCountOnce } from '../src/backend/repositories/page-count.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { createLogger } from '../src/shared/logging/index.js';
import { postgresMigrationDirectory } from '../src/backend/database/postgres/index.js';

// Policy facts slice 1 (migrations 042 and 043, ADR 0024): page count, policy profile, owner confirmation, erasure.
// Synthetic values only. The PostgreSQL tests need TEST_DATABASE_URL (REQUIRE_POSTGRES=1 turns a skip into a failure).

const opts = postgresTestOptions();
const ON = { POLICY_FACTS_ENABLED: 'true' };
const UIN = 'ABCHLIP12345V012021';
const POLICY_NAME = 'Synthetic Family Floater Gold';
const INSURER_NAME = 'Synthetic Mutual Insurance';
const SEALED = /^enc2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

const url = (documentId, tail = '') => `/api/v1/documents/${documentId}/policy-profile${tail}`;
const get = (app, s, { token = s.token, documentId = s.documentId } = {}) => app.call(url(documentId), { token });
let keySeed = 0;
const confirm = (app, s, body, { token = s.token, documentId = s.documentId, key = `confirm-key-${++keySeed}-${randomUUID()}` } = {}) => app.call(url(documentId, '/confirm'), {
  method: 'POST', token, body, headers: key === null ? {} : { 'Idempotency-Key': key },
});
const rawProfiles = app => app.database.many('SELECT * FROM policy_profiles ORDER BY created_at, id');
const withUin = (...uins) => { fixture.pages = [uins.map(uin => ({ text: `Product UIN: ${uin}`, tag: 'paragraph' })), [{ text: 'Schedule of benefits', tag: 'paragraph' }]]; };
const count = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);
const profileCount = app => count(app, 'SELECT count(*) AS n FROM policy_profiles');

async function readyScenario(t, { uins = [UIN], env = ON } = {}) {
  withUin(...uins);
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'Profile' });
  return { app, s };
}

// ---- migrations -------------------------------------------------------------------------------------------------------------

test('migrations 042 and 043 run twice without error and leave the same objects', opts, async t => {
  const { handle } = await freshDatabase(t);
  const snapshot = async () => (await handle.pool.query(`SELECT
    (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ('public.policy_profiles'::regclass, 'public.document_uploads'::regclass) AND NOT tgisinternal) AS triggers,
    (SELECT count(*) FROM pg_constraint WHERE conrelid IN ('public.policy_profiles'::regclass, 'public.document_uploads'::regclass)) AS constraints,
    (SELECT count(*) FROM pg_indexes WHERE tablename IN ('policy_profiles', 'document_uploads')) AS indexes,
    (SELECT count(*) FROM information_schema.columns WHERE table_name IN ('policy_profiles', 'document_uploads')) AS columns`)).rows[0];
  const before = await snapshot();
  for (const file of ['042_document_page_count.sql', '043_policy_profiles.sql']) {
    const sql = readFileSync(new URL(file, `file://${postgresMigrationDirectory}/`), 'utf8');
    await handle.pool.query(sql);
    await handle.pool.query(sql);
  }
  assert.deepEqual(await snapshot(), before);
});

test('policy_profiles: RLS on, no policy, and no privilege for anon, authenticated or PUBLIC', opts, async t => {
  const { handle } = await freshDatabase(t);
  const { rows: [table] } = await handle.pool.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.policy_profiles'::regclass");
  assert.equal(table.relrowsecurity, true);
  assert.equal((await handle.pool.query("SELECT 1 FROM pg_policies WHERE tablename = 'policy_profiles'")).rowCount, 0);
  const grants = await handle.pool.query(`SELECT grantee FROM information_schema.role_table_grants
    WHERE table_schema = 'public' AND table_name = 'policy_profiles' AND grantee IN ('anon', 'authenticated', 'PUBLIC')`);
  assert.equal(grants.rowCount, 0);
});

test('policy_profiles CHECKs: sealed columns only, a name only once reported, reported needs a confirmer', opts, async t => {
  const { app, s } = await readyScenario(t);
  const document = await app.database.one('SELECT case_id, source_version FROM document_uploads WHERE id = ?', [s.documentId]);
  const base = {
    id: 'ppro-check', household_id: s.householdId, case_id: document.case_id, document_id: s.documentId, source_version: document.source_version,
  };
  const insert = (overrides, id = 'ppro-check') => app.database.run(`INSERT INTO policy_profiles
    (id, household_id, case_id, document_id, source_version, uin, uin_state, insurer_name_enc, insurer_state, policy_name_enc, policy_name_state, confirmation_source, confirmed_at, confirmed_by_adult_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`, [
    id, base.household_id, base.case_id, base.document_id, base.source_version, overrides.uin ?? null, overrides.uinState ?? 'unknown',
    overrides.insurerName ?? null, overrides.insurerState ?? 'unknown', overrides.policyName ?? null, overrides.policyNameState ?? 'unknown',
    overrides.source ?? null, overrides.confirmedAt ?? null, overrides.confirmedBy ?? null]);
  const sealed = 'enc2.k1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA';
  // The name cannot be stored while unconfirmed, and cannot be stored as plain text.
  await assert.rejects(insert({ policyName: sealed }), { code: '23514' });
  await assert.rejects(insert({ policyName: POLICY_NAME, policyNameState: 'reported', source: 'user_statement', confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: s.adultId }), { code: '23514' });
  await assert.rejects(insert({ insurerName: sealed }), { code: '23514' });
  // 'reported' needs a confirmer; no 'user_confirmed' or 'proven' state exists.
  await assert.rejects(insert({ policyName: sealed, policyNameState: 'reported' }), { code: '23514' });
  await assert.rejects(insert({ uin: UIN, uinState: 'proven' }), { code: '23514' });
  await assert.rejects(insert({ uin: UIN, uinState: 'user_confirmed' }), { code: '23514' });
  await assert.rejects(insert({ uin: 'bad uin', uinState: 'extracted_unverified' }), { code: '23514' });
  await assert.rejects(insert({ uin: UIN, uinState: 'conflicting' }), { code: '23514' });
  // The valid shapes are accepted.
  await insert({ uin: UIN, uinState: 'extracted_unverified' });
  assert.equal(await profileCount(app), 1);
  await app.database.run('DELETE FROM policy_profiles');
  await insert({ policyName: sealed, policyNameState: 'reported', source: 'user_statement', confirmedAt: '2026-01-01T00:00:00.000Z', confirmedBy: s.adultId });
  // The scope trigger refuses a household that does not own the document.
  await assert.rejects(insert({ uin: UIN, uinState: 'extracted_unverified' }, 'ppro-other').then(() => app.database.run('UPDATE policy_profiles SET household_id = ? WHERE id = ?', [s.householdId, 'ppro-other'])));
});

test('policy_profiles update guard: version rises by one, identity is fixed, a reported field cannot be un-reported', opts, async t => {
  const { app, s } = await readyScenario(t);
  assert.equal((await get(app, s)).status, 200);
  const [row] = await rawProfiles(app);
  assert.equal(row.version, 1);
  await assert.rejects(app.database.run('UPDATE policy_profiles SET updated_at = ? WHERE id = ?', ['2027-01-01T00:00:00.000Z', row.id]), /version/);
  await assert.rejects(app.database.run('UPDATE policy_profiles SET document_id = ?, version = 2 WHERE id = ?', ['other', row.id]));
  await assert.rejects(app.database.run('UPDATE policy_profiles SET household_id = ?, version = 2 WHERE id = ?', ['other', row.id]));
  assert.equal((await confirm(app, s, { uin: UIN, expectedVersion: 1 })).status, 200);
  await assert.rejects(app.database.run("UPDATE policy_profiles SET uin_state = 'extracted_unverified', version = version + 1 WHERE id = ?", [row.id]), /reported/);
  await assert.rejects(app.database.run("UPDATE policy_profiles SET policy_name_enc = 'enc2.k1.a.b.c', policy_name_state = 'reported', confirmed_at = NULL, version = version + 1 WHERE id = ?", [row.id]));
});

// ---- page count -------------------------------------------------------------------------------------------------------------

test('page count: OCR completion records the provider count; a worse source never replaces a better one', opts, async t => {
  const { app, s } = await readyScenario(t);
  const read = () => app.database.one('SELECT page_count, page_count_source FROM document_uploads WHERE id = ?', [s.documentId]);
  assert.deepEqual({ ...await read() }, { page_count: 2, page_count_source: 'ocr' });
  assert.equal(await setPageCountOnce(app.database, s.documentId, 9, 'source_pages'), false, 'a lower source does not replace');
  assert.equal(await setPageCountOnce(app.database, s.documentId, 7, 'ocr'), false, 'an equal source does not replace');
  assert.equal((await read()).page_count, 2);
  assert.equal(await setPageCountOnce(app.database, s.documentId, 1, 'image_single'), true, 'a better source replaces');
  assert.deepEqual({ ...await read() }, { page_count: 1, page_count_source: 'image_single' });
  await assert.rejects(setPageCountOnce(app.database, s.documentId, 0, 'ocr'), { code: 'PAGE_COUNT_INVALID' });
  await assert.rejects(setPageCountOnce(app.database, s.documentId, 5001, 'ocr'), { code: 'PAGE_COUNT_INVALID' });
  await assert.rejects(setPageCountOnce(app.database, s.documentId, 3, 'segmenter'), { code: 'PAGE_COUNT_INVALID' });
  await assert.rejects(app.database.run('UPDATE document_uploads SET page_count = 3, page_count_source = NULL WHERE id = ?', [s.documentId]), { code: '23514' });
});

test('page count: concurrent writers of different trust always end on the better source', opts, async t => {
  const { app, s } = await readyScenario(t);
  for (let round = 0; round < 8; round += 1) {
    const documentId = await uploadDocument(app, s);
    const writers = [
      setPageCountOnce(app.database, documentId, 9, 'source_pages'),
      setPageCountOnce(app.database, documentId, 4, 'ocr'),
      setPageCountOnce(app.database, documentId, 8, 'source_pages'),
      setPageCountOnce(app.database, documentId, 4, 'ocr'),
    ];
    if (round % 2) writers.reverse();
    await Promise.all(writers);
    const row = await app.database.one('SELECT page_count, page_count_source FROM document_uploads WHERE id = ?', [documentId]);
    assert.deepEqual({ ...row }, { page_count: 4, page_count_source: 'ocr' }, `round ${round}`);
  }
});

test('page count: a scanned image is one page; a scanned PDF has none until OCR completes', opts, async t => {
  const { app, s } = await readyScenario(t);
  const pdf = await uploadDocument(app, s);
  assert.equal((await app.database.one('SELECT page_count FROM document_uploads WHERE id = ?', [pdf])).page_count, null);
  // The HTTP upload route takes PDF only, so an image document is created through the repository, then scanned clean.
  const services = createBackendServices(app.database);
  const id = `document-${randomUUID()}`;
  await services.documents.createDocument({
    id, householdId: s.householdId, caseId: s.caseId, uploadedByAdultId: s.adultId, consentGrantId: s.processingGrantId, documentKind: 'policy_schedule',
    originalFilename: 'synthetic-policy.png', storageKey: 'a'.repeat(64), contentSha256: 'b'.repeat(64), mimeType: 'image/png', byteSize: 100,
    malwareStatus: 'pending', encryptionStatus: 'encrypted_local', logicalDocumentId: `logical-${id}`, version: 1, createdAt: new Date().toISOString(),
  });
  assert.equal((await app.database.one('SELECT page_count FROM document_uploads WHERE id = ?', [id])).page_count, null, 'nothing is counted before the scan');
  assert.equal(await services.documents.markScanClean(id, { engine: 'test' }), true);
  const row = await app.database.one('SELECT page_count, page_count_source, lifecycle_state FROM document_uploads WHERE id = ?', [id]);
  assert.deepEqual({ ...row }, { page_count: 1, page_count_source: 'image_single', lifecycle_state: 'active' });
  // A PDF scanned clean gets no count from the scan.
  const pdfRow = await app.database.one('SELECT page_count_source FROM document_uploads WHERE id = ?', [pdf]);
  assert.equal(pdfRow.page_count_source, null);
});

// ---- access -----------------------------------------------------------------------------------------------------------------

test('policy facts off: both routes answer POLICY_FACTS_DISABLED and touch nothing', opts, async t => {
  const { app, s } = await readyScenario(t, { env: {} });
  const read = await get(app, s);
  assert.equal(read.status, 503);
  assert.equal(read.data.error.code, 'POLICY_FACTS_DISABLED');
  const write = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 });
  assert.equal(write.status, 503);
  assert.equal(write.data.error.code, 'POLICY_FACTS_DISABLED');
  assert.equal(await profileCount(app), 0);
  for (const off of ['false', 'TRUE', '1', '']) {
    const other = await startApp(t, { env: { POLICY_FACTS_ENABLED: off } });
    const s2 = await scenario(other, { name: 'Off', read: false });
    assert.equal((await get(other, s2)).status, 503, `"${off}" is not "true"`);
  }
});

test('policy profile routes: 401 without a session; foreign household, missing document and non-owner answer the same 404', opts, async t => {
  const { app, s } = await readyScenario(t);
  assert.equal((await app.call(url(s.documentId))).status, 401);
  assert.equal((await app.call(url(s.documentId, '/confirm'), { method: 'POST', body: { policyName: POLICY_NAME, expectedVersion: 0 }, headers: { 'Idempotency-Key': 'key-12345678' } })).status, 401);

  const foreign = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Foreign household', owner: { displayName: 'Other Synthetic' } } });
  const foreignToken = foreign.data.session.token;
  const services = createBackendServices(app.database);
  const member = await services.households.createAdult({ displayName: 'Member Synthetic' });
  await services.households.addRole({ householdId: s.householdId, adultUserId: member.id, role: 'member' });
  const memberToken = (await services.auth.issueSession({ adultUserId: member.id })).token;

  const outcomes = [];
  for (const token of [foreignToken, memberToken]) {
    const read = await get(app, s, { token });
    const write = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 }, { token });
    outcomes.push(read, write);
  }
  outcomes.push(await get(app, s, { documentId: 'document-does-not-exist' }));
  outcomes.push(await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 }, { documentId: 'document-does-not-exist' }));
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 404, JSON.stringify(outcome.data));
    assert.equal(outcome.data.error.code, 'POLICY_PROFILE_NOT_FOUND');
  }
  assert.equal(new Set(outcomes.map(outcome => JSON.stringify(outcome.data))).size, 1, 'the bodies are identical');
  assert.equal(await profileCount(app), 0, 'a refused caller wrote nothing');
});

// ---- read and propose ---------------------------------------------------------------------------------------------------------

test('GET proposes the UIN and insurer code, stores only those, and never a name before confirmation', opts, async t => {
  const { app, s } = await readyScenario(t);
  const res = await get(app, s);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.documentId, s.documentId);
  assert.equal(res.data.version, 1, 'the extracted identifiers are the first version of the row');
  assert.equal(res.data.totalPages, 2);
  assert.equal(res.data.textRead, true);
  assert.deepEqual(res.data.proposals, { uin: UIN, insurerCode: 'ABC', insurerName: null, policyName: null, conflicts: [] });
  assert.deepEqual(res.data.profile.confirmed, { uin: null, insurerCode: null, insurerName: null, policyName: null });
  assert.deepEqual(res.data.profile.states, { uin: 'extracted_unverified', insurer: 'extracted_unverified', policyName: 'unknown' });
  const [row] = await rawProfiles(app);
  assert.equal(row.uin, UIN);
  assert.equal(row.uin_state, 'extracted_unverified');
  assert.equal(row.policy_name_enc, null);
  assert.equal(row.insurer_name_enc, null);
  assert.equal(row.policy_name_state, 'unknown');
  assert.equal(row.confirmed_at, null);
  // A second read changes nothing.
  const again = await get(app, s);
  assert.deepEqual(again.data, res.data);
  assert.equal(await profileCount(app), 1);
  assert.equal((await rawProfiles(app))[0].version, 1);
  // The response never carries a sealed column or an envelope.
  assert.ok(!JSON.stringify(res.data).includes('enc2.') && !JSON.stringify(res.data).includes('_enc'));
});

test('a proposed name from the curated catalogue is returned but not stored, whatever happens next', opts, async t => {
  const { app, s } = await readyScenario(t);
  const services = createBackendServices(app.database, { env: ON });
  const service = createPolicyProfileService({
    repository: services.policyProfiles, ocr: services.ocr, env: ON,
    curatedLookup: uin => (uin === UIN ? { insurerName: INSURER_NAME, policyName: POLICY_NAME } : null),
  });
  const document = await services.documents.getDocument(s.documentId);
  const first = await service.get({ document });
  assert.equal(first.proposals.policyName, POLICY_NAME);
  assert.equal(first.proposals.insurerName, INSURER_NAME);
  await service.get({ document });
  const [row] = await rawProfiles(app);
  assert.equal(row.policy_name_enc, null);
  assert.equal(row.insurer_name_enc, null);
  assert.ok(!JSON.stringify(row).includes('Synthetic Family'), 'no column holds the proposed name');
  assert.equal(row.policy_name_state, 'unknown');
  // Nothing in the audit chain or the idempotency store holds it either.
  const everything = JSON.stringify(await app.database.many('SELECT event_payload_json FROM audit_events'));
  assert.ok(!everything.includes('Synthetic Family') && !everything.includes(INSURER_NAME));
});

test('two UINs in one document conflict: no value is proposed and confirming needs an explicit choice', opts, async t => {
  const other = 'XYZHLIP99999V019999';
  const { app, s } = await readyScenario(t, { uins: [UIN, other] });
  const res = await get(app, s);
  assert.equal(res.status, 200);
  assert.equal(res.data.proposals.uin, null);
  assert.deepEqual(res.data.proposals.conflicts, ['uin']);
  assert.equal(res.data.profile.states.uin, 'conflicting');
  const [row] = await rawProfiles(app);
  assert.equal(row.uin, null);
  const blocked = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: res.data.version });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, 'POLICY_PROFILE_CONFLICTING_FACTS');
  assert.equal((await rawProfiles(app))[0].policy_name_enc, null, 'the refused confirmation wrote nothing');
  const chosen = await confirm(app, s, { uin: other, policyName: POLICY_NAME, expectedVersion: res.data.version });
  assert.equal(chosen.status, 200, JSON.stringify(chosen.data));
  assert.equal(chosen.data.profile.confirmed.uin, other);
  assert.equal(chosen.data.profile.states.uin, 'reported');
});

test('a document that was never read yields no proposal and stores nothing', opts, async t => {
  const { app, s } = await readyScenario(t);
  const unread = await uploadDocument(app, s);
  const res = await get(app, s, { documentId: unread });
  assert.equal(res.status, 200);
  assert.equal(res.data.textRead, false);
  assert.deepEqual(res.data.proposals, { uin: null, insurerCode: null, insurerName: null, policyName: null, conflicts: [] });
  assert.equal(res.data.version, 0);
  assert.equal(res.data.profile, null);
  assert.equal(res.data.totalPages, null);
  assert.equal(await profileCount(app), 0);
});

// ---- confirm ----------------------------------------------------------------------------------------------------------------

test('confirm: the owner reports the names; they are sealed at rest, reported (never proven), audited by field name only', opts, async t => {
  const { app, s } = await readyScenario(t);
  const before = await get(app, s);
  const res = await confirm(app, s, { uin: UIN, insurerCode: 'ABC', insurerName: INSURER_NAME, policyName: POLICY_NAME, expectedVersion: before.data.version });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.version, 2);
  assert.deepEqual(res.data.profile.states, { uin: 'reported', insurer: 'reported', policyName: 'reported' });
  assert.deepEqual(res.data.profile.confirmed, { uin: UIN, insurerCode: 'ABC', insurerName: INSURER_NAME, policyName: POLICY_NAME });
  assert.ok(res.data.profile.confirmedAt);
  assert.ok(!JSON.stringify(res.data).match(/proven|user_confirmed|enc2\./));
  const [row] = await rawProfiles(app);
  assert.match(row.policy_name_enc, SEALED);
  assert.match(row.insurer_name_enc, SEALED);
  assert.ok(!row.policy_name_enc.includes('Synthetic') && !row.insurer_name_enc.includes('Synthetic'));
  assert.equal(row.confirmation_source, 'user_statement');
  assert.equal(row.confirmed_by_adult_id, s.adultId);
  // GET shows the confirmed values; the sealed columns are never in the body.
  const read = await get(app, s);
  assert.equal(read.data.profile.confirmed.policyName, POLICY_NAME);
  assert.ok(!JSON.stringify(read.data).includes('_enc'));
  // The audit event names fields and a version, never a value.
  const events = await app.database.many("SELECT event_payload_json, action FROM audit_events WHERE action LIKE 'policy_profile.%' ORDER BY id");
  const confirmed = events.find(event => event.action === 'policy_profile.confirmed');
  assert.deepEqual(JSON.parse(confirmed.event_payload_json), { fields: ['uin', 'insurerCode', 'insurerName', 'policyName'], version: 2 });
  assert.ok(!JSON.stringify(events).includes('Synthetic'));
});

test('confirm: a partial statement keeps what was not mentioned; a lone insurer name drops an unconfirmed extracted code', opts, async t => {
  const { app, s } = await readyScenario(t);
  const first = await get(app, s);
  const named = await confirm(app, s, { insurerName: INSURER_NAME, expectedVersion: first.data.version });
  assert.equal(named.status, 200, JSON.stringify(named.data));
  assert.equal(named.data.profile.confirmed.insurerCode, null, 'the unverified extracted code is not silently reported');
  assert.equal(named.data.profile.confirmed.insurerName, INSURER_NAME);
  assert.equal(named.data.profile.states.uin, 'extracted_unverified', 'the UIN was not mentioned and stays unverified');
  const policy = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: named.data.version });
  assert.equal(policy.status, 200);
  assert.equal(policy.data.profile.confirmed.insurerName, INSURER_NAME, 'earlier confirmation is kept');
  assert.equal(policy.data.profile.confirmed.policyName, POLICY_NAME);
  assert.equal(policy.data.version, named.data.version + 1);
});

test('confirm without a prior read creates the row at version 1 with expectedVersion 0', opts, async t => {
  const { app, s } = await readyScenario(t);
  const res = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.version, 1);
  assert.equal(await profileCount(app), 1);
});

test('confirm: bad input is a coded error and writes nothing', opts, async t => {
  const { app, s } = await readyScenario(t);
  const bad = [
    [{ uin: 'short', expectedVersion: 0 }, 422, 'POLICY_PROFILE_INVALID_UIN'],
    [{ uin: '123456789012', expectedVersion: 0 }, 422, 'POLICY_PROFILE_INVALID_UIN'],
    [{ uin: 'ABC DEF 12345 678', expectedVersion: 0 }, 422, 'POLICY_PROFILE_INVALID_UIN'],
    [{ uin: 12345678, expectedVersion: 0 }, 422, 'POLICY_PROFILE_INVALID_UIN'],
    [{ expectedVersion: 0 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: POLICY_NAME }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: POLICY_NAME, expectedVersion: -1 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: POLICY_NAME, expectedVersion: '0' }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: '', expectedVersion: 0 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: 'x'.repeat(201), expectedVersion: 0 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: 'bad\u0000name', expectedVersion: 0 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: { toString: 'x' }, expectedVersion: 0 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ insurerCode: 'a', expectedVersion: 0 }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: POLICY_NAME, expectedVersion: 0, state: 'proven' }, 400, 'POLICY_PROFILE_INVALID'],
    [{ policyName: POLICY_NAME, expectedVersion: 0, householdId: 'x' }, 400, 'POLICY_PROFILE_INVALID'],
  ];
  for (const [body, status, code] of bad) {
    const res = await confirm(app, s, body);
    assert.equal(res.status, status, JSON.stringify(body));
    assert.equal(res.data.error.code, code);
    assert.ok(!JSON.stringify(res.data).includes(POLICY_NAME));
  }
  const noKey = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 }, { key: null });
  assert.equal(noKey.status, 400);
  assert.equal(noKey.data.error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(await profileCount(app), 0);
  assert.equal(await count(app, 'SELECT count(*) AS n FROM idempotency_keys WHERE scope LIKE ?', ['policy-profile-confirm:%']), 0);
  // The parser alone: a normalised name.
  assert.equal(parseProfileStatement({ policyName: '  Synthetic   Plan  ', expectedVersion: 0 }).policyName, 'Synthetic Plan');
});

test('confirm: a stale version is 409 and changes nothing', opts, async t => {
  const { app, s } = await readyScenario(t);
  const first = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 });
  assert.equal(first.status, 200);
  const stale = await confirm(app, s, { policyName: 'Another Synthetic Plan', expectedVersion: 0 });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'POLICY_PROFILE_VERSION_CONFLICT');
  const future = await confirm(app, s, { policyName: 'Another Synthetic Plan', expectedVersion: 9 });
  assert.equal(future.status, 409);
  assert.equal((await get(app, s)).data.profile.confirmed.policyName, POLICY_NAME);
  assert.equal((await rawProfiles(app))[0].version, 1);
});

test('confirm: two concurrent confirmations of one version give one 200 and one 409', opts, async t => {
  const { app, s } = await readyScenario(t);
  const first = await get(app, s);
  for (let round = 0; round < 5; round += 1) {
    const version = (await get(app, s)).data.version;
    const results = await Promise.all([
      confirm(app, s, { policyName: `Synthetic Plan A${round}`, expectedVersion: version }),
      confirm(app, s, { policyName: `Synthetic Plan B${round}`, expectedVersion: version }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 409], `round ${round}: ${JSON.stringify(results.map(result => result.data))}`);
    assert.equal(results.find(result => result.status === 409).data.error.code, 'POLICY_PROFILE_VERSION_CONFLICT');
    assert.equal((await get(app, s)).data.version, version + 1);
  }
  assert.ok(first.data.version >= 0);
  assert.equal(await profileCount(app), 1);
});

test('confirm: the same Idempotency-Key replays the same response; another statement on it conflicts; no value is cached', opts, async t => {
  const { app, s } = await readyScenario(t);
  const key = 'stable-confirm-key-0001';
  const body = { policyName: POLICY_NAME, insurerName: INSURER_NAME, expectedVersion: 0 };
  const first = await confirm(app, s, body, { key });
  assert.equal(first.status, 200);
  const replay = await confirm(app, s, body, { key });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, first.data);
  assert.equal((await rawProfiles(app))[0].version, 1, 'the replay did not write again');
  assert.equal(await count(app, "SELECT count(*) AS n FROM audit_events WHERE action = 'policy_profile.confirmed'"), 1);
  const different = await confirm(app, s, { ...body, policyName: 'A Different Synthetic Plan' }, { key });
  assert.equal(different.status, 409);
  assert.equal(different.data.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal((await get(app, s)).data.profile.confirmed.policyName, POLICY_NAME);
  // Another adult's or another document's key space is separate: the same key on another document is a new request.
  const rows = await app.database.many("SELECT * FROM idempotency_keys WHERE scope LIKE 'policy-profile-confirm:%'");
  assert.equal(rows.length, 1);
  const text = JSON.stringify(rows);
  assert.ok(!text.includes('Synthetic') && !text.includes(POLICY_NAME) && !text.includes(INSURER_NAME));
  assert.equal(rows[0].household_id, s.householdId);
  assert.ok(rows[0].case_id);
  // The cached response is sealed.
  assert.match(rows[0].response_json, /^enc2\./);
});

test('confirm refuses a document whose consent was withdrawn or that is no longer active (POLICY_PROFILE_NOT_READY)', opts, async t => {
  const { app, s } = await readyScenario(t);
  const revoke = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'synthetic test' } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
  const res = await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 });
  assert.equal(res.status, 409, JSON.stringify(res.data));
  assert.equal(res.data.error.code, 'POLICY_PROFILE_NOT_READY');
  assert.equal(await profileCount(app), 0);
});

test('confirm rolls back completely when its audit write fails: no row, no idempotency record', opts, async t => {
  const { app, s } = await readyScenario(t);
  const services = createBackendServices(app.database);
  const failing = new PolicyProfileRepository(app.database, { audit: { append: async () => { throw new Error('audit unavailable'); } }, columnCrypto: services.columnCrypto });
  const statement = parseProfileStatement({ policyName: POLICY_NAME, expectedVersion: 0 });
  await assert.rejects(failing.confirm({ householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, statement, idempotencyKey: 'rollback-key-0001' }), /audit unavailable/);
  assert.equal(await profileCount(app), 0);
  assert.equal(await count(app, "SELECT count(*) AS n FROM idempotency_keys WHERE scope LIKE 'policy-profile-confirm:%'"), 0);
  // The same key then works with a healthy repository.
  const ok = await services.policyProfiles.confirm({ householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, statement, idempotencyKey: 'rollback-key-0001' });
  assert.deepEqual({ ...ok }, { replay: false, version: 1 });
});

// ---- encryption ---------------------------------------------------------------------------------------------------------------

test('sealed columns: a ciphertext moved to another row or column cannot be opened, and a wrong key fails', opts, async t => {
  const { app, s } = await readyScenario(t);
  const second = await uploadDocument(app, s);
  await confirm(app, s, { policyName: POLICY_NAME, insurerName: INSURER_NAME, expectedVersion: 0 });
  await confirm(app, s, { policyName: 'Second Synthetic Plan', expectedVersion: 0 }, { documentId: second });
  const rows = await rawProfiles(app);
  assert.equal(rows.length, 2);
  const [a, b] = rows;
  // Row move: a's name sealed into b.
  await app.database.run('UPDATE policy_profiles SET policy_name_enc = ?, version = version + 1 WHERE id = ?', [a.policy_name_enc, b.id]);
  const moved = await get(app, s, { documentId: second });
  assert.equal(moved.status, 500);
  assert.equal(moved.data.error.code, 'COLUMN_DECRYPTION_FAILED');
  assert.ok(!JSON.stringify(moved.data).includes('Synthetic'));
  await app.database.run('UPDATE policy_profiles SET policy_name_enc = ?, version = version + 1 WHERE id = ?', [b.policy_name_enc, b.id]);
  assert.equal((await get(app, s, { documentId: second })).data.profile.confirmed.policyName, 'Second Synthetic Plan');
  // Column move inside one row: the name sealed into the insurer column.
  await app.database.run('UPDATE policy_profiles SET insurer_name_enc = ?, version = version + 1 WHERE id = ?', [a.policy_name_enc, a.id]);
  assert.equal((await get(app, s)).data.error.code, 'COLUMN_DECRYPTION_FAILED');
  // A different key cannot open the value.
  const other = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k9', DATABASE_URL: 'postgres://localhost/x' }));
  assert.throws(() => other.open('policy_profiles', 'policy_name_enc', a.id, a.policy_name_enc), { code: 'COLUMN_DECRYPTION_FAILED' });
});

test('key rotation: --rotate re-seals the names under the new key and they still open', opts, async t => {
  const { app, s } = await readyScenario(t);
  await confirm(app, s, { policyName: POLICY_NAME, insurerName: INSURER_NAME, expectedVersion: 0 });
  const { encryptExistingRows } = await import('../src/backend/security/column-backfill.js');
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const oldCrypto = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: oldKey.toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k1', DATABASE_URL: 'postgres://localhost/x' }));
  const [row] = await rawProfiles(app);
  // Re-seal the row under k1 first (the harness used the development key), the way a deployment with k1 would have written it.
  await app.database.run(`UPDATE policy_profiles SET policy_name_enc = ?, insurer_name_enc = ?, version = version + 1 WHERE id = ?`, [
    oldCrypto.seal('policy_profiles', 'policy_name_enc', row.id, POLICY_NAME), oldCrypto.seal('policy_profiles', 'insurer_name_enc', row.id, INSURER_NAME), row.id]);
  const rotated = createColumnCrypto(readDataEncryptionConfig({
    DATA_ENCRYPTION_KEY_BASE64: newKey.toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k2',
    DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k1: oldKey.toString('base64') }), DATABASE_URL: 'postgres://localhost/x',
  }));
  const result = await encryptExistingRows({ database: app.database, crypto: rotated, rotate: true });
  assert.ok(result.tables.find(item => item.table === 'policy_profiles').rows >= 1, 'the backfill covers policy_profiles');
  const after = (await rawProfiles(app))[0];
  assert.match(after.policy_name_enc, /^enc2\.k2\./);
  assert.match(after.insurer_name_enc, /^enc2\.k2\./);
  assert.equal(rotated.open('policy_profiles', 'policy_name_enc', row.id, after.policy_name_enc), POLICY_NAME);
  assert.equal(rotated.open('policy_profiles', 'insurer_name_enc', row.id, after.insurer_name_enc), INSURER_NAME);
  // --unseal never touches this table (its CHECK refuses plaintext).
  const unsealed = await encryptExistingRows({ database: app.database, crypto: rotated, unseal: true, includeE1: true });
  assert.equal(unsealed.tables.some(item => item.table === 'policy_profiles'), false);
});

// ---- erasure ----------------------------------------------------------------------------------------------------------------

async function confirmedProfile(t) {
  const ctx = await readyScenario(t);
  const res = await confirm(ctx.app, ctx.s, { uin: UIN, policyName: POLICY_NAME, insurerName: INSURER_NAME, expectedVersion: 0 });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(await profileCount(ctx.app), 1);
  return ctx;
}

test('erasure: deleting the document removes its profile', opts, async t => {
  const { app, s } = await confirmedProfile(t);
  const gone = await app.call(`/api/v1/documents/${s.documentId}`, { method: 'DELETE', token: s.token });
  assert.ok([200, 202].includes(gone.status), JSON.stringify(gone.data));
  assert.equal(await profileCount(app), 0);
  assert.equal((await get(app, s)).status, 409, 'the document is no longer available');
});

test('erasure: withdrawing the processing consent removes the profile of its documents', opts, async t => {
  const { app, s } = await confirmedProfile(t);
  const revoke = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'synthetic test' } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
  assert.equal(await profileCount(app), 0);
  const events = await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'policy_profile.erased'");
  for (const event of events) assert.ok(!event.event_payload_json.includes('Synthetic'), 'counts only');
});

test('erasure: erasing the case removes the profiles of the case', opts, async t => {
  const { app, s } = await confirmedProfile(t);
  const erased = await app.call(`/api/v1/cases/${s.caseId}/erasure`, { method: 'POST', token: s.token, body: { confirm: s.caseId } });
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  assert.equal(await profileCount(app), 0);
});

test('erasure: erasing the household removes the profiles of the household and no other', opts, async t => {
  const { app, s } = await confirmedProfile(t);
  const stranger = await scenario(app, { name: 'Stranger' });
  assert.equal((await confirm(app, stranger, { policyName: 'Stranger Synthetic Plan', expectedVersion: 0 })).status, 200);
  assert.equal(await profileCount(app), 2);
  const erased = await app.call(`/api/v1/households/${s.householdId}/erasure`, { method: 'POST', token: s.token, body: { confirm: s.householdId } });
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  const rows = await rawProfiles(app);
  assert.deepEqual(rows.map(row => row.household_id), [stranger.householdId]);
  // The idempotency cache of the erased household is gone with it; the other household's stays.
  assert.equal(await count(app, "SELECT count(*) AS n FROM idempotency_keys WHERE scope LIKE 'policy-profile-confirm:%' AND household_id = ?", [s.householdId]), 0);
  assert.equal(await count(app, "SELECT count(*) AS n FROM idempotency_keys WHERE scope LIKE 'policy-profile-confirm:%' AND household_id = ?", [stranger.householdId]), 1);
});

test('erasure: the repository erase methods delete by document, case and household and audit counts only', opts, async t => {
  const { app, s } = await confirmedProfile(t);
  const services = createBackendServices(app.database);
  assert.deepEqual({ ...await services.policyProfiles.eraseForDocuments({ householdId: 'other-household', documentIds: [s.documentId] }) }, { profiles: 0 });
  assert.equal(await profileCount(app), 1, 'another household cannot erase it');
  assert.deepEqual({ ...await services.policyProfiles.eraseForCase({ householdId: s.householdId, caseId: s.caseId }) }, { profiles: 1 });
  assert.equal(await profileCount(app), 0);
  assert.deepEqual({ ...await services.policyProfiles.eraseForHousehold({ householdId: s.householdId }) }, { profiles: 0 });
  await assert.rejects(services.policyProfiles.eraseForHousehold({ householdId: s.householdId, reasonCode: 'because' }), { code: 'POLICY_PROFILE_INVALID' });
});

// ---- leaks ------------------------------------------------------------------------------------------------------------------

test('no plaintext name reaches a log line, an error body or the audit chain', opts, async t => {
  const lines = [];
  const logger = createLogger({ destination: { write: chunk => { lines.push(String(chunk)); } }, level: 'trace' });
  withUin(UIN);
  const app = await startApp(t, { env: ON, logger });
  const s = await scenario(app, { name: 'Leak' });
  const bodies = [];
  bodies.push(await get(app, s));
  bodies.push(await confirm(app, s, { policyName: POLICY_NAME, insurerName: INSURER_NAME, expectedVersion: 0 }));
  bodies.push(await confirm(app, s, { policyName: POLICY_NAME, expectedVersion: 0 }));
  bodies.push(await confirm(app, s, { policyName: `${POLICY_NAME}\u0000`, expectedVersion: 1 }));
  const mismatch = bodies[2];
  assert.equal(mismatch.status, 409);
  assert.ok(!JSON.stringify(mismatch.data).includes('Synthetic'));
  assert.ok(!JSON.stringify(bodies[3].data).includes('Synthetic'));
  const everything = lines.join('\n') + JSON.stringify(await app.database.many('SELECT * FROM audit_events'));
  assert.ok(!everything.includes(POLICY_NAME) && !everything.includes(INSURER_NAME) && !everything.includes('Synthetic Family'));
});
