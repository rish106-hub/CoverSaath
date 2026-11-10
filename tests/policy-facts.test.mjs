import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { startApp, scenario, fixture, uploadDocument, grantReading, readDocument, bootstrapToken } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { PolicyFactsRepository } from '../src/backend/repositories/policy-facts-repository.js';
import { createPolicyFactsHandler } from '../src/backend/jobs/policy-facts-handler.js';
import { createJobWorker } from '../src/backend/services/job-worker.js';
import { POLICY_FACTS_JOB_KIND, policyFactsDedupeKey } from '../src/backend/services/policy-facts-service.js';
import { buildJobHandlers } from '../src/server/worker.js';
import { NORMALISER_VERSION } from '../src/features/policy-facts/normalisers.js';
import { createColumnCrypto, readDataEncryptionConfig } from '../src/backend/security/column-crypto.js';
import { createLogger } from '../src/shared/logging/index.js';
import { postgresMigrationDirectory } from '../src/backend/database/postgres/index.js';
import { parameterAt as at, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Policy facts slice 2 (migration 044, ADR 0025): facts and evidence, extraction, verification, hook, erasure, encryption, RLS.
// Synthetic values only. The PostgreSQL tests need TEST_DATABASE_URL (REQUIRE_POSTGRES=1 turns a skip into a failure).

const opts = postgresTestOptions();
const ON = { POLICY_FACTS_ENABLED: 'true' };
const SEALED = /^enc2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SCHEDULE_LINES = [
  'Sum Insured: Rs. 5,00,000/-',
  'Policy Period: 01/04/2026 to 31/03/2027',
  'Total Premium Payable: Rs. 12,345',
  'Pre-existing Diseases Waiting Period: 36 months',
  'Maternity Waiting Period: 2 years 6 months',
  'Co-payment: 20%',
  'No Claim Bonus: 10%, 20%, 30%',
  'Mode of Payment: UPI',
  'Agent Name: Meera Example',
  'Sold By: Individual Agent',
  'Self 34 yrs',
];
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const useSchedule = (lines = SCHEDULE_LINES) => { fixture.pages = [page(lines), page(['Schedule of benefits'])]; };

const url = (documentId, tail = '') => `/api/v1/documents/${documentId}/policy-facts${tail}`;
const get = (app, s, { token = s.token, documentId = s.documentId } = {}) => app.call(url(documentId), { token });
const rawFacts = app => app.database.many('SELECT * FROM policy_facts ORDER BY fact_type, scope_key, ordinal, id');
const rawEvidence = app => app.database.many('SELECT * FROM fact_evidence ORDER BY created_at, id');
const count = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);
const factCount = app => count(app, 'SELECT count(*) AS n FROM policy_facts');
const evidenceCount = app => count(app, 'SELECT count(*) AS n FROM fact_evidence');
const byType = rows => new Map(rows.map(row => [`${row.fact_type}|${row.scope_key}`, row]));

async function readyScenario(t, { lines, env = ON } = {}) {
  useSchedule(lines);
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'Facts' });
  const services = createBackendServices(app.database, { env: ON });
  return { app, s, services };
}

const extract = (services, s) => services.policyFacts.extract({ householdId: s.householdId, documentId: s.documentId });

// ---- migration -----------------------------------------------------------------------------------------------------------------

test('migration 044 runs twice without error and leaves the same objects', opts, async t => {
  const { handle } = await freshDatabase(t);
  const tables = "('public.policy_facts'::regclass, 'public.fact_evidence'::regclass, 'public.document_uploads'::regclass)";
  const snapshot = async () => (await handle.pool.query(`SELECT
    (SELECT count(*) FROM pg_trigger WHERE tgrelid IN ${tables} AND NOT tgisinternal) AS triggers,
    (SELECT count(*) FROM pg_constraint WHERE conrelid IN ${tables}) AS constraints,
    (SELECT count(*) FROM pg_indexes WHERE tablename IN ('policy_facts', 'fact_evidence', 'document_uploads')) AS indexes,
    (SELECT count(*) FROM information_schema.columns WHERE table_name IN ('policy_facts', 'fact_evidence', 'document_uploads')) AS columns,
    (SELECT count(*) FROM pg_proc WHERE proname LIKE 'policy_facts_%' OR proname LIKE 'fact_evidence_%') AS functions`)).rows[0];
  const before = await snapshot();
  const sql = readFileSync(new URL('044_policy_facts.sql', `file://${postgresMigrationDirectory}/`), 'utf8');
  await handle.pool.query(sql);
  await handle.pool.query(sql);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before.triggers >= 6, true);
});

test('policy_facts and fact_evidence: RLS on, no policy, and no privilege for anon, authenticated or PUBLIC', opts, async t => {
  const { handle } = await freshDatabase(t);
  for (const table of ['policy_facts', 'fact_evidence']) {
    const { rows: [row] } = await handle.pool.query('SELECT relrowsecurity FROM pg_class WHERE oid = $1::regclass', [`public.${table}`]);
    assert.equal(row.relrowsecurity, true, table);
    assert.equal((await handle.pool.query('SELECT 1 FROM pg_policies WHERE tablename = $1', [table])).rowCount, 0, table);
    const grants = await handle.pool.query(`SELECT grantee FROM information_schema.role_table_grants
      WHERE table_schema = 'public' AND table_name = $1 AND grantee IN ('anon', 'authenticated', 'PUBLIC')`, [table]);
    assert.equal(grants.rowCount, 0, table);
  }
});

// ---- CHECKs and triggers --------------------------------------------------------------------------------------------------------

async function checkWorld(t) {
  const ctx = await readyScenario(t);
  const document = await ctx.app.database.one('SELECT case_id, source_version FROM document_uploads WHERE id = ?', [ctx.s.documentId]);
  let seq = 0;
  const sealed = 'enc2.k1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA';
  const insertFact = (overrides = {}) => {
    seq += 1;
    const row = {
      id: `pf-check-${seq}`, household_id: ctx.s.householdId, case_id: document.case_id, document_id: ctx.s.documentId, source_version: document.source_version,
      extraction_run_id: 'run-check', fact_type: 'payment_mode_last', scope_key: `s${seq}`, ordinal: 0, origin: 'deterministic', state: 'extracted_unverified',
      value_type: 'enum', value_enum: 'upi', normaliser_version: 'pf-norm.1', created_at: '2026-01-01T00:00:00.000Z', ...overrides,
    };
    const columns = Object.keys(row);
    return ctx.app.database.run(`INSERT INTO policy_facts (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, columns.map(column => row[column])).then(() => row);
  };
  return { ...ctx, document, insertFact, sealed };
}

test('policy_facts CHECKs: text fact_type shape, sealed enc2 only, value shape per type, no value when unknown or conflicting', opts, async t => {
  const { insertFact, sealed } = await checkWorld(t);
  const bad = async overrides => assert.rejects(insertFact(overrides), { code: '23514' }, JSON.stringify(overrides));
  // fact_type is text with a shape CHECK (not a SQL enum): any well-formed name is accepted by the database, a malformed one is not.
  await insertFact({ fact_type: 'brand_new_future_type' });
  await bad({ fact_type: 'Bad Type' });
  await bad({ fact_type: 'ab' });
  await bad({ fact_type: 'x'.repeat(65) });
  await bad({ scope_key: 'Has Space' });
  await bad({ value_type: 'blob' });
  // Sealed columns: enc2 only.
  await bad({ value_type: 'text', value_enum: null, value_enc: 'plaintext value' });
  await bad({ value_type: 'text', value_enum: null, value_enc: 'enc1.k1.AAAA.AAAA.AAAA' });
  await bad({ value_type: 'text', value_enum: null, value_enc: sealed, raw_text_enc: 'raw plaintext' });
  await insertFact({ value_type: 'text', value_enum: null, value_enc: sealed, raw_text_enc: sealed });
  // Shape per value_type.
  await insertFact({ value_type: 'money', value_enum: null, value_enc: sealed, currency: 'INR', amount_band: '5l_10l' });
  await bad({ value_type: 'money', value_enum: null, value_enc: sealed, currency: 'INR' });
  await bad({ value_type: 'money', value_enum: null, value_enc: sealed, amount_band: '5l_10l' });
  await bad({ value_type: 'money', value_enum: null, value_enc: sealed, currency: 'USD', amount_band: '5l_10l' });
  await bad({ value_type: 'money', value_enum: null, value_enc: sealed, currency: 'INR', amount_band: 'huge' });
  await bad({ value_type: 'money', value_enum: null, currency: 'INR', amount_band: '5l_10l' });
  await insertFact({ value_type: 'date', value_enum: null, value_enc: sealed, value_ym: '2026-04' });
  await bad({ value_type: 'date', value_enum: null, value_enc: sealed, value_ym: '2026-13' });
  await bad({ value_type: 'date', value_enum: null, value_enc: sealed });
  await insertFact({ value_type: 'date_range', value_enum: null, value_enc: sealed, value_ym: '2026-04', value_duration_days: 365 });
  await bad({ value_type: 'date_range', value_enum: null, value_enc: sealed, value_ym: '2026-04', value_duration_days: 0 });
  await insertFact({ value_type: 'duration', value_enum: null, value_enc: sealed, value_duration_days: 910 });
  await bad({ value_type: 'duration', value_enum: null, value_enc: sealed, value_duration_days: -1 });
  await bad({ value_type: 'duration', value_enum: null, value_duration_days: 910 });
  await insertFact({ value_type: 'percent', value_enum: null, value_percent_bp: 2000 });
  await bad({ value_type: 'percent', value_enum: null, value_percent_bp: 100001 });
  await bad({ value_type: 'percent', value_enum: null, value_percent_bp: 2000, value_enc: sealed });
  await insertFact({ value_type: 'number', value_enum: null, value_enc: sealed });
  await insertFact({ value_type: 'bool', value_enum: null, value_bool: true });
  await bad({ value_type: 'bool', value_enum: null });
  await bad({ value_type: 'enum', value_enum: 'Has Caps' });
  await bad({ value_type: 'enum', value_enum: 'upi', value_ym: '2026-04' });
  // Unknown and conflicting hold no value at all.
  await insertFact({ state: 'unknown', value_enum: null });
  await insertFact({ state: 'conflicting', value_enum: null });
  await bad({ state: 'unknown' });
  await bad({ state: 'conflicting', value_type: 'text', value_enum: null, raw_text_enc: sealed });
});

test('policy_facts authority: a reader never writes above extracted_unverified; reported is the owner statement with a confirmer', opts, async t => {
  const { insertFact, s } = await checkWorld(t);
  const bad = overrides => assert.rejects(insertFact(overrides), { code: '23514' }, JSON.stringify(overrides));
  for (const origin of ['deterministic', 'model_proposed']) {
    for (const state of ['reported', 'proven', 'calculated', 'dynamic', 'user_confirmed']) await bad({ origin, state });
    await insertFact({ origin });
  }
  await bad({ origin: 'sarvam' });
  await bad({ origin: 'user_statement' });
  const reported = { origin: 'user_statement', state: 'reported', confirmation_source: 'user_statement', confirmed_at: '2026-01-01T00:00:00.000Z', confirmed_by_adult_id: s.adultId };
  await insertFact(reported);
  await bad({ ...reported, confirmation_source: null });
  await bad({ ...reported, confirmed_at: null });
  await bad({ ...reported, confirmed_by_adult_id: null });
  await bad({ ...reported, confirmation_source: 'model' });
  await bad({ ...reported, origin: 'deterministic' });
  await bad({ origin: 'deterministic', confirmed_at: '2026-01-01T00:00:00.000Z' });
  await assert.rejects(insertFact({ ...reported, confirmed_by_adult_id: 'adult-not-in-household' }));
  assert.equal((await insertFact({ ...reported, scope_key: 'again' })).state, 'reported');
});

test('policy_facts scope trigger: the document must be active and match household, case and version; supersedes stays in the document', opts, async t => {
  const { app, s, insertFact, document } = await checkWorld(t);
  await assert.rejects(insertFact({ household_id: 'household-other' }), /policy fact must match an active document/);
  await assert.rejects(insertFact({ source_version: 'other-version' }), /policy fact must match an active document/);
  await assert.rejects(insertFact({ case_id: 'case-other' }));
  const first = await insertFact({ scope_key: 'first' });
  const other = await uploadDocument(app, s);
  const otherDoc = await app.database.one('SELECT source_version FROM document_uploads WHERE id = ?', [other]);
  await assert.rejects(insertFact({ document_id: other, source_version: otherDoc.source_version, supersedes_fact_id: first.id, scope_key: 'cross' }), /same document/);
  await insertFact({ supersedes_fact_id: first.id, scope_key: 'second' });
  await app.database.run('UPDATE document_uploads SET lifecycle_state = ? WHERE id = ?', ['quarantined', s.documentId]);
  await assert.rejects(insertFact({ scope_key: 'late' }), /policy fact must match an active document/);
  assert.ok(document);
});

test('policy_facts is immutable except one guarded supersession; fact_evidence is fully immutable', opts, async t => {
  const { app, s, insertFact, document } = await checkWorld(t);
  const a = await insertFact({ scope_key: 'a' });
  const b = await insertFact({ scope_key: 'b' });
  await assert.rejects(app.database.run("UPDATE policy_facts SET state = 'unknown', value_enum = NULL WHERE id = ?", [a.id]), /immutable/);
  await assert.rejects(app.database.run("UPDATE policy_facts SET value_enum = 'cash' WHERE id = ?", [a.id]), /immutable/);
  await assert.rejects(app.database.run('UPDATE policy_facts SET household_id = ? WHERE id = ?', ['x', a.id]), /immutable/);
  await assert.rejects(app.database.run('UPDATE policy_facts SET superseded_by_fact_id = ?, value_enum = ? WHERE id = ?', [b.id, 'cash', a.id]), /immutable/);
  await assert.rejects(app.database.run('UPDATE policy_facts SET superseded_by_fact_id = ? WHERE id = ?', ['no-such-fact', a.id]), /immutable/);
  await app.database.run('UPDATE policy_facts SET superseded_by_fact_id = ? WHERE id = ?', [b.id, a.id]);
  await assert.rejects(app.database.run('UPDATE policy_facts SET superseded_by_fact_id = ? WHERE id = ?', [a.id, a.id]), /immutable/, 'set once');
  const evidenceBase = [`fev-1`, a.id, s.householdId, document.case_id, s.documentId, document.source_version, 1, 0, 'p1-b0', 'enc2.k1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA.AAAA', null, 'primary', '2026-01-01T00:00:00.000Z'];
  const insertEvidence = (overrides = {}) => {
    const row = [...evidenceBase];
    for (const [index, value] of Object.entries(overrides)) row[Number(index)] = value;
    return app.database.run(`INSERT INTO fact_evidence (id, fact_id, household_id, case_id, document_id, source_version, page, block_index, clause_id, quote_enc, source_digest, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, row);
  };
  await assert.rejects(insertEvidence({ 9: 'a plaintext quote' }), { code: '23514' }, 'quote must be sealed');
  await assert.rejects(insertEvidence({ 11: 'witness' }), { code: '23514' });
  await assert.rejects(insertEvidence({ 6: 0 }), { code: '23514' });
  await assert.rejects(insertEvidence({ 10: 'abc' }), { code: '23514' });
  await assert.rejects(insertEvidence({ 2: 'household-other' }), /fact evidence must match/);
  await assert.rejects(insertEvidence({ 1: 'no-such-fact' }));
  await insertEvidence();
  await assert.rejects(app.database.run("UPDATE fact_evidence SET role = 'corroborating' WHERE id = 'fev-1'"), /immutable/);
  await assert.rejects(app.database.run('UPDATE fact_evidence SET page = 2 WHERE id = \'fev-1\''), /immutable/);
});

test('document erasure trigger deletes facts and evidence (quarantine does not)', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  assert.equal((await extract(services, s)).status, 'stored');
  const facts = await factCount(app);
  assert.ok(facts > 5 && await evidenceCount(app) >= facts - 1);
  await app.database.run('UPDATE document_uploads SET lifecycle_state = ? WHERE id = ?', ['quarantined', s.documentId]);
  assert.equal(await factCount(app), facts, 'quarantine is not erasure');
  await app.database.run('UPDATE document_uploads SET lifecycle_state = ? WHERE id = ?', ['deletion_requested', s.documentId]);
  assert.equal(await factCount(app), 0);
  assert.equal(await evidenceCount(app), 0);
});

// ---- extraction -----------------------------------------------------------------------------------------------------------------

test('extract: stores each fact with coarse plaintext and sealed exact values, extracted_unverified only, with verified evidence', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  const result = await extract(services, s);
  assert.equal(result.status, 'stored');
  const rows = byType(await rawFacts(app));
  const sum = rows.get('sum_insured|');
  assert.deepEqual({ type: sum.value_type, band: sum.amount_band, currency: sum.currency, state: sum.state, origin: sum.origin }, { type: 'money', band: '5l_10l', currency: 'INR', state: 'extracted_unverified', origin: 'deterministic' });
  assert.equal(rows.get('policy_period|').value_ym, '2026-04');
  assert.equal(rows.get('policy_period|').value_duration_days, 365);
  assert.equal(rows.get('waiting_ped|').value_duration_days, 1095);
  assert.equal(rows.get('waiting_maternity|').value_duration_days, 910);
  assert.equal(rows.get('copay_percent|').value_percent_bp, 2000);
  assert.equal(rows.get('ncb_tier|year_2').value_percent_bp, 2000);
  assert.equal(rows.get('ncb_max|').value_percent_bp, 3000);
  assert.equal(rows.get('payment_mode_last|').value_enum, 'upi');
  assert.equal(rows.get('seller_type|').value_enum, 'agent');
  assert.equal(rows.get('member_age|member_1').value_type, 'number');
  assert.ok(rows.get('sum_insured|').normaliser_version === NORMALISER_VERSION);
  assert.ok((await rawFacts(app)).every(row => ['extracted_unverified', 'unknown', 'conflicting'].includes(row.state)));
  assert.ok((await rawFacts(app)).every(row => row.confirmed_at === null && row.confirmed_by_adult_id === null));
  // Every sealed column is enc2 at rest; no exact value or free text appears anywhere in the raw rows.
  const sealedValues = (await rawFacts(app)).flatMap(row => [row.value_enc, row.raw_text_enc]).filter(Boolean);
  assert.ok(sealedValues.length >= 8);
  for (const value of sealedValues) assert.match(value, SEALED);
  const evidence = await rawEvidence(app);
  for (const item of evidence) { assert.match(item.quote_enc, SEALED); assert.ok(item.page >= 1); assert.ok(['primary', 'corroborating', 'conflicting'].includes(item.role)); }
  assert.ok(evidence.every(item => /^[0-9a-f]{64}$/.test(item.source_digest ?? '')), 'the page digest is recorded');
  const dump = JSON.stringify(await rawFacts(app)) + JSON.stringify(evidence);
  for (const secret of ['Meera', 'Rs. 5,00,000', '500000', '36 months', 'Sum Insured', '01/04/2026']) assert.ok(!dump.includes(secret), secret);
  // Seller present here; every other fact has one primary evidence.
  const primaries = await count(app, "SELECT count(*) AS n FROM fact_evidence WHERE role = 'primary'");
  assert.equal(primaries, (await rawFacts(app)).filter(row => row.state === 'extracted_unverified').length);
});

test('extract: the sealed quote and value open with the right row id only (AAD), and a wrong key fails', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  await extract(services, s);
  const rows = byType(await rawFacts(app));
  const sum = rows.get('sum_insured|');
  const period = rows.get('policy_period|');
  const crypto = services.columnCrypto;
  assert.equal(JSON.parse(crypto.open('policy_facts', 'value_enc', sum.id, sum.value_enc)).amountMinor, 50_000_000);
  assert.deepEqual(JSON.parse(crypto.open('policy_facts', 'value_enc', rows.get('waiting_maternity|').id, rows.get('waiting_maternity|').value_enc)).original, [{ amount: 2, unit: 'year' }, { amount: 6, unit: 'month' }]);
  assert.throws(() => crypto.open('policy_facts', 'value_enc', period.id, sum.value_enc), { code: 'COLUMN_DECRYPTION_FAILED' }, 'moved to another row');
  assert.throws(() => crypto.open('policy_facts', 'raw_text_enc', sum.id, sum.value_enc), { code: 'COLUMN_DECRYPTION_FAILED' }, 'moved to another column');
  const [evidence] = await app.database.many('SELECT * FROM fact_evidence WHERE fact_id = ?', [sum.id]);
  assert.equal(crypto.open('fact_evidence', 'quote_enc', evidence.id, evidence.quote_enc), 'Sum Insured: Rs. 5,00,000/-');
  assert.throws(() => crypto.open('fact_evidence', 'quote_enc', 'fev-other', evidence.quote_enc), { code: 'COLUMN_DECRYPTION_FAILED' });
  assert.throws(() => crypto.open('policy_facts', 'value_enc', sum.id, evidence.quote_enc), { code: 'COLUMN_DECRYPTION_FAILED' }, 'a quote is not a value');
  const other = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k9', DATABASE_URL: 'postgres://localhost/x' }));
  assert.throws(() => other.open('policy_facts', 'value_enc', sum.id, sum.value_enc), { code: 'COLUMN_DECRYPTION_FAILED' });
});

test('extract: a replay, a retry and two concurrent runs write one set of facts (ON CONFLICT DO NOTHING)', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  const first = await extract(services, s);
  const total = await factCount(app);
  const evidence = await evidenceCount(app);
  assert.equal(first.inserted, total);
  const again = await extract(services, s);
  assert.equal(again.inserted, 0);
  assert.equal(again.skipped, total);
  assert.equal(await factCount(app), total);
  assert.equal(await evidenceCount(app), evidence, 'no evidence is written for a skipped fact');
  // Concurrent runs on a fresh document.
  const second = await uploadDocument(app, s);
  await readDocument(app, s, second, await grantReading(app, s, second));
  const runs = await Promise.allSettled([1, 2, 3].map(() => services.policyFacts.extract({ householdId: s.householdId, documentId: second })));
  assert.ok(runs.every(run => run.status === 'fulfilled'), JSON.stringify(runs));
  assert.equal(await count(app, 'SELECT count(*) AS n FROM policy_facts WHERE document_id = ?', [second]), total);
  assert.equal(await count(app, 'SELECT count(*) AS n FROM (SELECT extraction_run_id, fact_type, scope_key, ordinal FROM policy_facts GROUP BY 1, 2, 3, 4 HAVING count(*) > 1) d'), 0);
});

test('extract: an unreadable document writes nothing (not read, reading grant withdrawn, processing consent withdrawn, deleted)', opts, async t => {
  useSchedule();
  const app = await startApp(t, { env: ON });
  const unread = await scenario(app, { name: 'Unread', read: false });
  const services = createBackendServices(app.database, { env: ON });
  assert.equal((await extract(services, unread)).status, 'unreadable');
  const read = await scenario(app, { name: 'Read' });
  const withdrawn = await app.call(`/api/v1/consents/${read.readingGrantId}/revoke`, { method: 'POST', token: read.token, body: { reason: 'synthetic test' } });
  assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.data));
  assert.equal((await extract(services, read)).status, 'unreadable', 'the reading grant gate');
  const revoked = await scenario(app, { name: 'Revoked' });
  const revoke = await app.call(`/api/v1/consents/${revoked.processingGrantId}/revoke`, { method: 'POST', token: revoked.token, body: { reason: 'synthetic test' } });
  assert.equal(revoke.status, 200);
  assert.equal((await extract(services, revoked)).status, 'unreadable');
  const gone = await scenario(app, { name: 'Gone' });
  await app.call(`/api/v1/documents/${gone.documentId}`, { method: 'DELETE', token: gone.token });
  assert.equal((await extract(services, gone)).status, 'unreadable');
  assert.equal(await factCount(app), 0);
  await assert.rejects(extract(createBackendServices(app.database, {}), read), { code: 'POLICY_FACTS_DISABLED' });
});

test('repository: the document and its processing consent are re-checked inside the writing transaction (revoke mid-job)', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  const document = await services.policyFactsRepository.documentIdentity({ householdId: s.householdId, documentId: s.documentId });
  const facts = [{ factType: 'payment_mode_last', scopeKey: '', origin: 'deterministic', state: 'extracted_unverified', value: { value: 'upi' }, raw: 'UPI',
    evidence: [{ role: 'primary', quote: 'Mode of Payment: UPI', page: 1, blockIndex: 0, clauseId: 'p1-b0' }] }];
  const write = (overrides = {}) => services.policyFactsRepository.insertExtraction({
    householdId: s.householdId, documentId: s.documentId, sourceVersion: document.sourceVersion, extractionRunId: 'run-mid', normaliserVersion: NORMALISER_VERSION, facts, ...overrides,
  });
  await assert.rejects(write({ sourceVersion: 'a-newer-version' }), { code: 'POLICY_FACT_NOT_READY' });
  await assert.rejects(write({ householdId: 'household-other' }), { code: 'POLICY_FACT_NOT_READY' });
  const revoke = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'synthetic test' } });
  assert.equal(revoke.status, 200);
  await assert.rejects(write(), { code: 'POLICY_FACT_NOT_READY' });
  assert.equal(await factCount(app), 0);
  assert.equal(await evidenceCount(app), 0);
});

test('repository: a model fact needs the model grant check inside the transaction; a failing check or audit rolls everything back', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  const document = await services.policyFactsRepository.documentIdentity({ householdId: s.householdId, documentId: s.documentId });
  const fact = (overrides = {}) => ({ factType: 'payment_mode_last', scopeKey: '', origin: 'model_proposed', state: 'extracted_unverified', value: { value: 'upi' }, raw: 'UPI',
    evidence: [{ role: 'primary', quote: 'Mode of Payment: UPI', page: 1, blockIndex: 0, clauseId: 'p1-b0' }], ...overrides });
  const write = (repository, facts, consentCheck) => repository.insertExtraction({
    householdId: s.householdId, documentId: s.documentId, sourceVersion: document.sourceVersion, extractionRunId: 'run-model', normaliserVersion: NORMALISER_VERSION, facts, consentCheck,
  });
  await assert.rejects(write(services.policyFactsRepository, [fact()]), { code: 'POLICY_FACT_INVALID' }, 'no grant check supplied');
  await assert.rejects(write(services.policyFactsRepository, [fact()], async () => { throw Object.assign(new Error('grant revoked'), { code: 'CONSENT_REQUIRED' }); }), { code: 'CONSENT_REQUIRED' });
  assert.equal(await factCount(app), 0);
  const failing = new PolicyFactsRepository(app.database, { audit: { append: async () => { throw new Error('audit unavailable'); } }, columnCrypto: services.columnCrypto });
  await assert.rejects(write(failing, [fact()], async () => {}), /audit unavailable/);
  assert.equal(await factCount(app), 0, 'rolled back');
  assert.equal(await evidenceCount(app), 0, 'rolled back');
  const ok = await write(services.policyFactsRepository, [fact()], async () => {});
  assert.equal(ok.inserted, 1);
  // A reader can never write above extracted_unverified, whatever the caller says.
  for (const state of ['reported', 'proven']) await assert.rejects(write(services.policyFactsRepository, [fact({ state, scopeKey: state })], async () => {}), { code: 'POLICY_FACT_INVALID' });
  await assert.rejects(write(services.policyFactsRepository, [fact({ origin: 'user_statement', scopeKey: 'u' })], async () => {}), { code: 'POLICY_FACT_INVALID' });
  await assert.rejects(write(services.policyFactsRepository, [fact({ factType: 'not_a_type', scopeKey: 'n' })], async () => {}), { code: 'POLICY_FACT_INVALID' });
  await assert.rejects(write(services.policyFactsRepository, Array.from({ length: 201 }, (_, index) => fact({ scopeKey: `k${index}` })), async () => {}), { code: 'POLICY_FACT_INVALID' }, 'per-run cap');
  await assert.rejects(write(services.policyFactsRepository, [fact({ evidence: Array.from({ length: 5 }, () => ({ role: 'corroborating', quote: 'q', page: 1 })) })], async () => {}), { code: 'POLICY_FACT_INVALID' }, 'per-fact evidence cap');
  await assert.rejects(write(services.policyFactsRepository, [fact({ evidence: [{ role: 'primary', quote: 'x'.repeat(501), page: 1 }] })], async () => {}), { code: 'POLICY_FACT_INVALID' }, 'quote length cap');
});

test('model facts: a quote not in its chunk, a value not in its quote and a forbidden fact type are dropped; the rest is extracted_unverified', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  let grantChecks = 0;
  const candidate = overrides => ({ factType: 'sum_insured', valueText: 'Rs. 5,00,000', quote: 'Sum Insured: Rs. 5,00,000/-', page: 1, blockIndex: 0, ...overrides });
  const result = await services.policyFacts.recordModelFacts({
    householdId: s.householdId, documentId: s.documentId, consentCheck: async () => { grantChecks += 1; },
    candidates: [
      candidate(),
      candidate({ factType: 'premium_total', valueText: 'Rs. 99,999', quote: 'Total Premium Payable: Rs. 12,345' }),
      candidate({ factType: 'deductible', valueText: 'Rs. 25,000', quote: 'Deductible: Rs. 25,000' }),
      candidate({ factType: 'seller_name', valueText: 'Meera Example', quote: 'Agent Name: Meera Example' }),
      candidate({ factType: 'waiting_ped', valueText: '36 months', quote: 'Pre-existing Diseases Waiting Period: 36 months', page: 2 }),
      candidate({ factType: 'constructor', valueText: 'x', quote: 'Sum Insured: Rs. 5,00,000/-' }),
    ],
  });
  assert.equal(result.status, 'stored');
  assert.equal(result.inserted, 1);
  assert.deepEqual(result.droppedByReason, { value_not_in_quote: 1, quote_not_in_chunk: 2, model_not_permitted: 1, unknown_fact_type: 1 });
  assert.equal(grantChecks, 1);
  const [row] = await rawFacts(app);
  assert.deepEqual({ type: row.fact_type, origin: row.origin, state: row.state }, { type: 'sum_insured', origin: 'model_proposed', state: 'extracted_unverified' });
  // Two different values for one fact from a model are one conflicting fact with no value.
  const conflict = await services.policyFacts.recordModelFacts({
    householdId: s.householdId, documentId: s.documentId, consentCheck: async () => {},
    candidates: [candidate({ factType: 'premium_total', valueText: 'Rs. 12,345', quote: 'Total Premium Payable: Rs. 12,345' }), candidate({ factType: 'premium_total', valueText: 'Rs. 5,00,000', quote: 'Sum Insured: Rs. 5,00,000/-' })],
  });
  assert.equal(conflict.inserted, 1);
  const premium = byType(await rawFacts(app)).get('premium_total|');
  assert.deepEqual({ state: premium.state, value_enc: premium.value_enc, amount_band: premium.amount_band }, { state: 'conflicting', value_enc: null, amount_band: null });
});

// ---- hook and handler -----------------------------------------------------------------------------------------------------------

async function hookWorld(t, env) {
  const { db: database } = await freshDatabase(t, { clock: () => new Date(at) });
  await seedParameterWorld(database);
  const services = createBackendServices(database, { env, clock: () => new Date(at) });
  await services.coverageParameters.initializeRunParameters({ workflowRunId: 'run-parameters', registryVersion: 'policy-parameters/v1', ...(await import('./support/parameter-fixtures.mjs')).parameterScope(), updatedBy: 'test' });
  return { database, services };
}
const commit = (services, overrides = {}) => services.policyStructuring.commitStructuring({
  householdId: 'household-parameters', workflowRunId: 'run-parameters', documentId: 'document-parameters', sourceVersion: 'version-1',
  pipelineVersion: 'policy-structuring-extractor/v1', registryVersion: 'policy-parameters/v1', recordedBy: 'policy-structuring', at,
  consentCheck: async () => {}, decisions: [], proposals: [], consentGrantId: 'consent-parameters', ...overrides,
});

test('hook: a structuring commit queues one ids-only policy_facts.extract job in its transaction; off by default; a queue failure never undoes the commit', opts, async t => {
  const on = await hookWorld(t, ON);
  const committed = await commit(on.services);
  assert.equal(committed.replayed, false);
  const jobs = await on.database.many('SELECT * FROM job_queue');
  assert.equal(jobs.length, 1);
  const [job] = jobs;
  assert.deepEqual({ kind: job.kind, household: job.household_id, document: job.document_id, grant: job.consent_grant_id, status: job.status }, {
    kind: POLICY_FACTS_JOB_KIND, household: 'household-parameters', document: 'document-parameters', grant: 'consent-parameters', status: 'queued' });
  assert.equal(job.dedupe_key, policyFactsDedupeKey({ documentId: 'document-parameters', sourceVersion: 'version-1' }));
  assert.ok(job.dedupe_key.length <= 128 && job.payload_json.length <= 1024);
  assert.deepEqual(JSON.parse(job.payload_json), { normaliserVersion: NORMALISER_VERSION });
  assert.ok(!/Synthetic|Rs\.|document text/i.test(JSON.stringify(job)), 'identifiers only');
  // A replay of the same commit queues nothing more.
  assert.equal((await commit(on.services)).replayed, true);
  assert.equal((await on.database.many('SELECT id FROM job_queue')).length, 1);
  // A different pipeline version (a new run) dedupes on the still-queued job.
  await commit(on.services, { pipelineVersion: 'policy-structuring-extractor/v2' });
  assert.equal((await on.database.many('SELECT id FROM job_queue')).length, 1);
});

test('hook: off unless POLICY_FACTS_ENABLED is exactly true, and a failing enqueue leaves the structuring result in place', opts, async t => {
  const off = await hookWorld(t, {});
  await commit(off.services);
  assert.equal((await off.database.many('SELECT id FROM job_queue')).length, 0);
  const on = await hookWorld(t, ON);
  const result = await commit(on.services, { consentGrantId: 'bad grant id!' });
  assert.equal(result.replayed, false);
  assert.equal((await on.database.many('SELECT id FROM job_queue')).length, 0, 'the invalid identifier was refused');
  assert.equal(Number((await on.database.one('SELECT count(*) AS n FROM policy_structuring_runs')).n), 1, 'the structuring result stands');
  const none = await hookWorld(t, ON);
  await commit(none.services, { consentGrantId: undefined });
  assert.equal((await none.database.many('SELECT id FROM job_queue')).length, 0, 'no grant, no job');
});

test('handler: the worker runs the queued job and stores the facts; a withdrawn consent ends it without writing; off or malformed is dead-lettered', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  const handlers = buildJobHandlers(services, ON);
  assert.deepEqual(Object.keys(handlers), [POLICY_FACTS_JOB_KIND]);
  assert.deepEqual(Object.keys(buildJobHandlers(services, {})), [], 'nothing registered while the flag is off');
  const enqueue = documentId => services.jobQueue.enqueue({ kind: POLICY_FACTS_JOB_KIND, householdId: s.householdId, documentId, consentGrantId: s.processingGrantId, payload: { normaliserVersion: NORMALISER_VERSION }, dedupeKey: policyFactsDedupeKey({ documentId, sourceVersion: documentId }) });
  const events = [];
  const worker = createJobWorker({ queue: services.jobQueue, handlers, workerId: 'test-worker', leaseMs: 30_000, onEvent: event => events.push(event) });
  await enqueue(s.documentId);
  assert.equal((await worker.runOnce()).outcome, 'succeeded');
  const stored = await factCount(app);
  assert.ok(stored > 5);
  // Another document whose processing consent is withdrawn before the job runs: the job ends, nothing is written.
  const other = await uploadDocument(app, s);
  await readDocument(app, s, other, await grantReading(app, s, other));
  await enqueue(other);
  const revoked = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'synthetic test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal(await worker.runOnce(), null, 'the revocation erased the pending job with the consent grant');
  assert.equal(await count(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'policy_facts.extract' AND status = 'queued'"), 0);
  // A job that was already running when the consent was withdrawn ends without writing.
  const handler = createPolicyFactsHandler({ service: services.policyFacts });
  assert.equal(await factCount(app), 0, 'the revocation also erased the facts already stored under that grant');
  await handler({ job: { kind: POLICY_FACTS_JOB_KIND, householdId: s.householdId, documentId: other } });
  assert.equal(await factCount(app), 0, 'a late job writes nothing');
  assert.equal(await count(app, 'SELECT count(*) AS n FROM policy_facts WHERE document_id = ?', [other]), 0);
  // Malformed and disabled jobs fail without retry.
  await assert.rejects(handler({ job: { kind: 'other.kind', householdId: 'h', documentId: 'd' } }), { code: 'JOB_PAYLOAD_INVALID', retryable: false });
  await assert.rejects(handler({ job: { kind: POLICY_FACTS_JOB_KIND, householdId: 'h' } }), { code: 'JOB_PAYLOAD_INVALID', retryable: false });
  const disabled = createPolicyFactsHandler({ service: createBackendServices(app.database, {}).policyFacts });
  await assert.rejects(disabled({ job: { kind: POLICY_FACTS_JOB_KIND, householdId: s.householdId, documentId: s.documentId } }), { code: 'POLICY_FACTS_DISABLED', retryable: false });
  // An aborted lease writes nothing.
  const controller = new AbortController();
  controller.abort();
  await handler({ job: { kind: POLICY_FACTS_JOB_KIND, householdId: s.householdId, documentId: other }, signal: controller.signal });
  assert.equal(await count(app, 'SELECT count(*) AS n FROM policy_facts WHERE document_id = ?', [other]), 0);
});

// ---- route ------------------------------------------------------------------------------------------------------------------------

test('policy facts off: the route answers POLICY_FACTS_DISABLED', opts, async t => {
  useSchedule();
  const app = await startApp(t, { env: {} });
  const s = await scenario(app, { name: 'Off', read: false });
  const res = await get(app, s);
  assert.equal(res.status, 503);
  assert.equal(res.data.error.code, 'POLICY_FACTS_DISABLED');
  for (const off of ['false', 'TRUE', '1']) {
    const other = await startApp(t, { env: { POLICY_FACTS_ENABLED: off } });
    const s2 = await scenario(other, { name: 'Off', read: false });
    assert.equal((await get(other, s2)).status, 503, `"${off}" is not "true"`);
  }
});

test('GET policy-facts: owner only; 401 without a session; foreign household, missing document and non-owner answer the same 404', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  await extract(services, s);
  assert.equal((await app.call(url(s.documentId))).status, 401);
  const foreign = await app.call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: 'Foreign household', owner: { displayName: 'Other Synthetic' } } });
  const member = await services.households.createAdult({ displayName: 'Member Synthetic' });
  await services.households.addRole({ householdId: s.householdId, adultUserId: member.id, role: 'member' });
  const memberToken = (await services.auth.issueSession({ adultUserId: member.id })).token;
  const outcomes = [];
  for (const token of [foreign.data.session.token, memberToken]) outcomes.push(await get(app, s, { token }));
  outcomes.push(await get(app, s, { documentId: 'document-does-not-exist' }));
  for (const outcome of outcomes) {
    assert.equal(outcome.status, 404, JSON.stringify(outcome.data));
    assert.equal(outcome.data.error.code, 'POLICY_FACTS_NOT_FOUND');
  }
  assert.equal(new Set(outcomes.map(outcome => JSON.stringify(outcome.data))).size, 1, 'the bodies are identical');
  const own = await get(app, s);
  assert.equal(own.status, 200, JSON.stringify(own.data));
  assert.equal(own.data.documentId, s.documentId);
});

test('GET policy-facts never returns a sealed column or a quote before the owner reports the fact', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  const empty = await get(app, s);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.facts, []);
  await extract(services, s);
  const res = await get(app, s);
  assert.equal(res.status, 200);
  const sum = res.data.facts.find(fact => fact.factType === 'sum_insured');
  assert.equal(sum.state, 'extracted_unverified');
  assert.equal(sum.coarse.amountBand, '5l_10l');
  assert.equal(sum.value, null, 'the exact amount is sealed until reported');
  assert.equal(sum.evidence[0].page, 1);
  assert.equal(sum.evidence[0].quote, null, 'no quote before the owner reports it');
  const body = JSON.stringify(res.data);
  for (const leak of ['enc2.', '_enc', 'Meera', '5,00,000', '500000', 'Sum Insured:', 'value_hash', 'subject_ref', 'household']) assert.ok(!body.includes(leak), leak);
  assert.ok(res.data.facts.every(fact => fact.value === null));
  assert.ok(res.data.facts.every(fact => fact.evidence.every(item => item.quote === null)));
  // Unknown seller is reported as such, with no value and no evidence.
  const quiet = await readyScenario(t, { lines: ['Sum Insured: Rs. 5,00,000/-'] });
  await extract(quiet.services, quiet.s);
  const seller = (await get(quiet.app, quiet.s)).data.facts.find(fact => fact.factType === 'seller_type');
  assert.deepEqual({ state: seller.state, enum: seller.coarse.enum, evidence: seller.evidence.length }, { state: 'unknown', enum: null, evidence: 0 });
});

test('a reported fact (the owner statement) opens its sealed value and quote for the owner; nothing else does', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  await extract(services, s);
  const document = await app.database.one('SELECT case_id, source_version FROM document_uploads WHERE id = ?', [s.documentId]);
  const factId = `pf-reported-${randomUUID()}`;
  const crypto = services.columnCrypto;
  await app.database.run(`INSERT INTO policy_facts (id, household_id, case_id, document_id, source_version, extraction_run_id, fact_type, scope_key, ordinal, origin, state, value_type,
    currency, amount_band, value_enc, normaliser_version, confirmation_source, confirmed_at, confirmed_by_adult_id, created_at)
    VALUES (?, ?, ?, ?, ?, 'run-reported', 'deductible', '', 0, 'user_statement', 'reported', 'money', 'INR', '10k_50k', ?, 'pf-norm.1', 'user_statement', '2026-01-01T00:00:00.000Z', ?, '2026-01-01T00:00:00.000Z')`,
  [factId, s.householdId, document.case_id, s.documentId, document.source_version, crypto.seal('policy_facts', 'value_enc', factId, '{"amountMinor":2500000,"currency":"INR"}'), s.adultId]);
  const evidenceId = 'fev-reported-1';
  await app.database.run(`INSERT INTO fact_evidence (id, fact_id, household_id, case_id, document_id, source_version, page, block_index, clause_id, quote_enc, source_digest, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, 0, 'p1-b0', ?, NULL, 'primary', '2026-01-01T00:00:00.000Z')`,
  [evidenceId, factId, s.householdId, document.case_id, s.documentId, document.source_version, crypto.seal('fact_evidence', 'quote_enc', evidenceId, 'Deductible: Rs. 25,000')]);
  const res = await get(app, s);
  const fact = res.data.facts.find(item => item.factType === 'deductible');
  assert.equal(fact.state, 'reported');
  assert.deepEqual(fact.value, { amountMinor: 2_500_000, currency: 'INR' });
  assert.equal(fact.evidence[0].quote, 'Deductible: Rs. 25,000');
  assert.equal(res.data.facts.filter(item => item.value !== null).length, 1, 'only the reported fact is opened');
  // A superseded fact is not listed.
  const other = res.data.facts.find(item => item.factType === 'sum_insured');
  await app.database.run('UPDATE policy_facts SET superseded_by_fact_id = ? WHERE id = ?', [factId, other.id]);
  assert.ok(!(await get(app, s)).data.facts.some(item => item.id === other.id));
});

test('no plaintext fact value, quote or name reaches a log line, an error body or the audit chain', opts, async t => {
  const lines = [];
  const logger = createLogger({ destination: { write: chunk => { lines.push(String(chunk)); } }, level: 'trace' });
  useSchedule();
  const app = await startApp(t, { env: ON, logger });
  const s = await scenario(app, { name: 'Leak' });
  const services = createBackendServices(app.database, { env: ON });
  await extract(services, s);
  const responses = [await get(app, s), await get(app, s, { documentId: 'document-none' })];
  const everything = lines.join('\n') + JSON.stringify(responses) + JSON.stringify(await app.database.many('SELECT * FROM audit_events'));
  for (const secret of ['Meera Example', 'Rs. 5,00,000', '5,00,000', '36 months', 'Sum Insured: ']) assert.ok(!everything.includes(secret), secret);
  const audit = await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'policy_facts.extracted'");
  assert.equal(audit.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(audit[0].event_payload_json)).sort(), ['evidence', 'facts', 'model', 'skipped']);
});

// ---- cross household --------------------------------------------------------------------------------------------------------------

test('repository reads and erasure are household scoped', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  await extract(services, s);
  const total = await factCount(app);
  const document = await services.policyFactsRepository.documentIdentity({ householdId: s.householdId, documentId: s.documentId });
  assert.deepEqual([...await services.policyFactsRepository.listForDocument({ householdId: 'household-other', documentId: s.documentId, sourceVersion: document.sourceVersion })], []);
  assert.equal(await services.policyFactsRepository.documentIdentity({ householdId: 'household-other', documentId: s.documentId }), null);
  assert.deepEqual({ ...await services.policyFactsRepository.eraseForDocuments({ householdId: 'household-other', documentIds: [s.documentId] }) }, { facts: 0, evidence: 0 });
  assert.deepEqual({ ...await services.policyFactsRepository.eraseForCase({ householdId: 'household-other', caseId: s.caseId }) }, { facts: 0, evidence: 0 });
  assert.equal(await factCount(app), total, 'another household cannot erase or read them');
});

// ---- erasure ----------------------------------------------------------------------------------------------------------------------

async function extractedWorld(t) {
  const ctx = await readyScenario(t);
  await extract(ctx.services, ctx.s);
  assert.ok(await factCount(ctx.app) > 5);
  return ctx;
}

test('erasure: deleting the document removes its facts and evidence', opts, async t => {
  const { app, s } = await extractedWorld(t);
  const gone = await app.call(`/api/v1/documents/${s.documentId}`, { method: 'DELETE', token: s.token });
  assert.ok([200, 202].includes(gone.status), JSON.stringify(gone.data));
  assert.equal(await factCount(app), 0);
  assert.equal(await evidenceCount(app), 0);
  assert.equal((await get(app, s)).status, 409, 'the document is no longer available');
});

test('erasure: withdrawing the processing consent removes the facts and evidence of its documents, with a counts-only audit event', opts, async t => {
  const { app, s } = await extractedWorld(t);
  const revoke = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'synthetic test' } });
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
  assert.equal(await factCount(app), 0);
  assert.equal(await evidenceCount(app), 0);
  const events = await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'policy_facts.erased'");
  assert.ok(events.length >= 1);
  for (const event of events) assert.deepEqual(Object.keys(JSON.parse(event.event_payload_json)).sort(), ['documents', 'facts', 'reasonCode']);
});

test('erasure: erasing the case removes its facts and evidence', opts, async t => {
  const { app, s } = await extractedWorld(t);
  const erased = await app.call(`/api/v1/cases/${s.caseId}/erasure`, { method: 'POST', token: s.token, body: { confirm: s.caseId } });
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  assert.equal(await factCount(app), 0);
  assert.equal(await evidenceCount(app), 0);
});

test('erasure: erasing the household removes its facts and evidence and no other household', opts, async t => {
  const { app, s, services } = await extractedWorld(t);
  const stranger = await scenario(app, { name: 'Stranger' });
  await extract(services, stranger);
  const strangerFacts = await count(app, 'SELECT count(*) AS n FROM policy_facts WHERE household_id = ?', [stranger.householdId]);
  assert.ok(strangerFacts > 5);
  const erased = await app.call(`/api/v1/households/${s.householdId}/erasure`, { method: 'POST', token: s.token, body: { confirm: s.householdId } });
  assert.equal(erased.status, 200, JSON.stringify(erased.data));
  assert.equal(await count(app, 'SELECT count(*) AS n FROM policy_facts WHERE household_id = ?', [s.householdId]), 0);
  assert.equal(await count(app, 'SELECT count(*) AS n FROM fact_evidence WHERE household_id = ?', [s.householdId]), 0);
  assert.equal(await count(app, 'SELECT count(*) AS n FROM policy_facts WHERE household_id = ?', [stranger.householdId]), strangerFacts);
});

test('erasure: a pending extraction job is erased with the consent grant and the document', opts, async t => {
  const { app, s, services } = await readyScenario(t);
  await services.jobQueue.enqueue({ kind: POLICY_FACTS_JOB_KIND, householdId: s.householdId, documentId: s.documentId, consentGrantId: s.processingGrantId, payload: {}, dedupeKey: 'pfx-erasure-test' });
  assert.equal(await count(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'policy_facts.extract'"), 1);
  const revoke = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'synthetic test' } });
  assert.equal(revoke.status, 200);
  assert.equal(await count(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'policy_facts.extract'"), 0);
});

test('erasure: the repository erase methods delete by document, case and household and audit counts only', opts, async t => {
  const { app, s, services } = await extractedWorld(t);
  const total = await factCount(app);
  const byDocument = await services.policyFactsRepository.eraseForDocuments({ householdId: s.householdId, documentIds: [s.documentId] });
  assert.equal(byDocument.facts, total);
  assert.ok(byDocument.evidence > 0);
  assert.equal(await factCount(app), 0);
  assert.deepEqual({ ...await services.policyFactsRepository.eraseForCase({ householdId: s.householdId, caseId: s.caseId }) }, { facts: 0, evidence: 0 });
  assert.deepEqual({ ...await services.policyFactsRepository.eraseForHousehold({ householdId: s.householdId }) }, { facts: 0, evidence: 0 });
  await assert.rejects(services.policyFactsRepository.eraseForHousehold({ householdId: s.householdId, reasonCode: 'because' }), { code: 'POLICY_FACT_INVALID' });
});

// ---- rotation ---------------------------------------------------------------------------------------------------------------------

test('key rotation: --rotate re-seals value, raw text and quote under the new key and they still open; --unseal skips these tables', opts, async t => {
  const { app, services } = await extractedWorld(t);
  const { encryptExistingRows } = await import('../src/backend/security/column-backfill.js');
  const oldKey = randomBytes(32);
  const newKey = randomBytes(32);
  const oldCrypto = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: oldKey.toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k1', DATABASE_URL: 'postgres://localhost/x' }));
  const [fact] = await app.database.many("SELECT * FROM policy_facts WHERE fact_type = 'sum_insured'");
  const [evidence] = await app.database.many('SELECT * FROM fact_evidence WHERE fact_id = ?', [fact.id]);
  const plaintext = services.columnCrypto.open('policy_facts', 'value_enc', fact.id, fact.value_enc);
  const quote = services.columnCrypto.open('fact_evidence', 'quote_enc', evidence.id, evidence.quote_enc);
  // The immutable triggers block this update, as they block any other: step past them the way a deployment's own k1 write would be at insert time.
  await app.database.run('ALTER TABLE policy_facts DISABLE TRIGGER policy_facts_immutable');
  await app.database.run('ALTER TABLE fact_evidence DISABLE TRIGGER fact_evidence_immutable');
  await app.database.run('UPDATE policy_facts SET value_enc = ? WHERE id = ?', [oldCrypto.seal('policy_facts', 'value_enc', fact.id, plaintext), fact.id]);
  await app.database.run('UPDATE fact_evidence SET quote_enc = ? WHERE id = ?', [oldCrypto.seal('fact_evidence', 'quote_enc', evidence.id, quote), evidence.id]);
  await app.database.run('ALTER TABLE policy_facts ENABLE TRIGGER policy_facts_immutable');
  await app.database.run('ALTER TABLE fact_evidence ENABLE TRIGGER fact_evidence_immutable');
  // Every other sealed row of the harness is still under the development key, so the rotation needs it as a previous key too.
  const developmentKey = createHash('sha256').update('cover-saath development column key, not a secret').digest('base64');
  const rotated = createColumnCrypto(readDataEncryptionConfig({
    DATA_ENCRYPTION_KEY_BASE64: newKey.toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k2',
    DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k1: oldKey.toString('base64'), dev: developmentKey }), DATABASE_URL: 'postgres://localhost/x',
  }));
  const result = await encryptExistingRows({ database: app.database, crypto: rotated, rotate: true });
  for (const table of ['policy_facts', 'fact_evidence']) assert.ok(result.tables.find(item => item.table === table).rows >= 1, `${table} is covered`);
  const [after] = await app.database.many('SELECT * FROM policy_facts WHERE id = ?', [fact.id]);
  const [afterEvidence] = await app.database.many('SELECT * FROM fact_evidence WHERE id = ?', [evidence.id]);
  assert.match(after.value_enc, /^enc2\.k2\./);
  assert.match(afterEvidence.quote_enc, /^enc2\.k2\./);
  assert.equal(rotated.open('policy_facts', 'value_enc', fact.id, after.value_enc), plaintext);
  assert.equal(rotated.open('fact_evidence', 'quote_enc', evidence.id, afterEvidence.quote_enc), quote);
  const triggers = await app.database.many("SELECT tgname, tgenabled FROM pg_trigger WHERE tgname IN ('policy_facts_immutable', 'fact_evidence_immutable')");
  assert.ok(triggers.every(trigger => trigger.tgenabled === 'O'), 'the immutable triggers are enabled again after a rotation');
  const unsealed = await encryptExistingRows({ database: app.database, crypto: rotated, unseal: true, includeE1: true });
  assert.equal(unsealed.tables.some(item => ['policy_facts', 'fact_evidence'].includes(item.table)), false);
});
