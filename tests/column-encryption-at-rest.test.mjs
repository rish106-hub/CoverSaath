import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { postgresMigrationDirectory } from '../src/backend/database/postgres/index.js';
import { startApp, scenario, HOLDER, fixture } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { EvidenceRepository } from '../src/backend/repositories/index.js';
import { createColumnCrypto, readDataEncryptionConfig, sharedColumnCrypto } from '../src/backend/security/column-crypto.js';
import { ENCRYPTED_COLUMNS, encryptExistingRows } from '../src/backend/security/column-backfill.js';
import { createApiServer } from '../src/server/server.js';

const pgOptions = postgresTestOptions();

// E1b (ADR 0013): every listed sensitive column holds an enc1 envelope after the normal write path ran, the backfill seals
// legacy rows idempotently, a key rotation re-seals, and legacy plaintext still reads. Synthetic values only.

const MARKER = 'SyntheticMarkerRoomRentTwoLakh';
fixture.pages = [
  [
    { text: 'Room rent', tag: 'section-title' },
    { text: `The room rent for a private room is limited as stated. ${MARKER} applies to every claim.`, tag: 'paragraph' },
  ],
  [{ text: 'Ambulance', tag: 'section-title' }, { text: 'Ambulance charges are paid up to the stated limit.', tag: 'paragraph' }],
];

const readCount = (db, name, column, where) => db.one(`SELECT count(*) AS n FROM ${name} WHERE ${column} IS NOT NULL ${where}`).then(row => row.n);

// Every encrypted column has at least one non-null row and no row that is not an enc1 envelope.
// Columns this scenario does not reach: they have their own write-path tests (column-encryption-d2.test.mjs and the suites of
// their repositories) and are covered here for plaintext absence and by the backfill.
const NOT_IN_SCENARIO = new Set([
  'coverage_parameter_observations.value_json', 'coverage_parameter_resolutions.resolved_value_json', 'proposed_parameters.label', 'proposed_parameters.value_json',
  'ocr_jobs.error_message', 'integration_outbox.payload_json', 'integration_outbox.last_error', 'catalogue_reviews.fact_json', 'consent_revocations.reason',
  'workflow_events.event_payload_json', 'workflow_tasks.last_error_message', 'idempotency_keys.response_json', 'household_members.relationship_label',
  'household_members.date_of_birth', 'policies.policy_number_masked', 'policies.policy_version', 'policies.starts_on', 'policies.ends_on',
  'household_members.mobile_ciphertext', 'household_members.email_ciphertext', 'person_records.payload_ciphertext',
  'service_cases.stated_estimate_ciphertext', 'workflow_runs.input_json', 'workflow_tasks.input_json', 'workflow_tasks.output_json',
]);

async function assertSealedEverywhere(db, { expectPresent = true } = {}) {
  for (const { table: name, columns, unwritten } of ENCRYPTED_COLUMNS) {
    for (const column of columns) {
      const present = await readCount(db, name, column, '');
      if (expectPresent && !unwritten && !NOT_IN_SCENARIO.has(`${name}.${column}`)) assert.ok(present > 0, `${name}.${column} was never written by the test`);
      const plain = await readCount(db, name, column, `AND ${column} !~ '^enc[12][.]'`);
      assert.equal(plain, 0, `${name}.${column} holds ${plain} readable value(s)`);
    }
  }
}

// Writes every encrypted column through the real write paths.
async function populate(app, s) {
  const services = createBackendServices(app.database);
  await services.households.createAdult({ displayName: 'Contact Synthetic', contactEmail: 'contact@example.test', contactPhone: '+910000000000' });
  const passages = await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token });
  assert.equal(passages.status, 200, JSON.stringify(passages.data));
  assert.ok(passages.data.passages.length > 0);
  await services.clauses.saveAnswer({
    householdId: s.householdId, caseId: s.caseId, requestedByAdultId: s.adultId, idempotencyKey: 'idem-key-at-rest', requestDigest: 'a'.repeat(64),
    question: 'What is the room rent limit?',
    answer: { question: 'q', covered: [], limited_or_excluded: [], conditions: [], overrides_checked: [], unknowns: ['x'], calculations: [], sources: [{ documentId: s.documentId, page: 1, quote: MARKER }], state: 'conditional', legalReview: 'required' },
    access: { consentGrantId: s.processingGrantId, subjectAdultId: s.adultId, documentIds: [s.documentId] },
  });
  await new EvidenceRepository(app.database).append({
    id: 'fact-at-rest', householdId: s.householdId, caseId: s.caseId, factKey: 'preferred_hospital', value: { name: MARKER },
    epistemicState: 'known', provenanceKind: 'adult_statement', statementAdultId: s.adultId, assertedBy: s.adultId,
  });
  // Policy profile (migration 043): both sealed names, written through the real confirm path.
  await services.policyProfiles.confirm({
    householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, idempotencyKey: 'idem-key-profile',
    statement: { insurerName: 'Synthetic Insurer Name', policyName: 'Synthetic Policy Name', expectedVersion: 0 },
  });
  // Policy facts (migration 044): value, raw text and quote, written through the real repository path.
  const document = await services.policyFactsRepository.documentIdentity({ householdId: s.householdId, documentId: s.documentId });
  await services.policyFactsRepository.insertExtraction({
    householdId: s.householdId, documentId: s.documentId, sourceVersion: document.sourceVersion, extractionRunId: 'run-at-rest', normaliserVersion: 'pf-norm.1',
    facts: [{
      factType: 'sum_insured', scopeKey: '', origin: 'deterministic', state: 'extracted_unverified', value: { amountMinor: 50_000_000, currency: 'INR' }, raw: 'Rs. 5,00,000',
      evidence: [{ role: 'primary', quote: 'Sum Insured: Rs. 5,00,000/-', page: 1, blockIndex: 0, clauseId: 'p1-b0' }],
    }],
  });
  return services;
}

test('E1b: after the write paths ran, every listed column holds ciphertext and the marker text is nowhere in the raw tables', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  await populate(app, s);
  await assertSealedEverywhere(app.database);
  for (const { table: name, columns } of ENCRYPTED_COLUMNS) {
    for (const column of columns) {
      for (const needle of [MARKER, HOLDER, 'Contact Synthetic', 'contact@example.test', '+910000000000', 'ReadFacts household']) {
        const hit = await app.database.one(`SELECT count(*) AS n FROM ${name} WHERE position(? in ${column}) > 0`, [needle]);
        assert.equal(hit.n, 0, `${name}.${column} must not contain readable text`);
      }
    }
  }
  // The API still returns the real values: sealing is invisible to callers.
  const passages = await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token });
  assert.ok(JSON.stringify(passages.data).includes('room rent'));
  const adult = await createBackendServices(app.database).households.getAdult(s.adultId);
  assert.equal(adult.display_name, HOLDER);
  const fact = await new EvidenceRepository(app.database).get('fact-at-rest');
  assert.deepEqual(fact.value, { name: MARKER });
});

test('E1b: ciphertext cannot be swapped between rows (the row id is in the AAD)', pgOptions, async t => {
  const app = await startApp(t);
  const a = await scenario(app, { name: 'RowA', read: false });
  const b = await scenario(app, { name: 'RowB', read: false });
  const rows = await app.database.many('SELECT id, display_name FROM adult_users ORDER BY id');
  assert.equal(rows.length, 2);
  await app.database.run('UPDATE adult_users SET display_name = ? WHERE id = ?', [rows[0].display_name, rows[1].id]);
  const services = createBackendServices(app.database);
  await assert.rejects(services.households.getAdult(rows[1].id), { code: 'COLUMN_DECRYPTION_FAILED' });
  assert.ok(a && b);
});

// Turns every sealed column back into the plaintext an older build wrote (the backfill's reverse direction), so the legacy-read
// and backfill paths are real.
const downgrade = (db, crypto) => encryptExistingRows({ database: db, crypto, unseal: true, includeE1: true });

test('E1b: legacy plaintext rows still read; the backfill dry run changes nothing, seals them once, and a second run changes 0 rows', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  const services = await populate(app, s);
  const crypto = sharedColumnCrypto();
  const answerBefore = await services.clauses.getAnswer({ householdId: s.householdId, caseId: s.caseId, answerId: (await app.database.one('SELECT id FROM policy_answers')).id });
  const passagesBefore = (await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token })).data;

  await downgrade(app.database, crypto);
  assert.equal(await readCount(app.database, 'adult_users', 'display_name', "AND display_name !~ '^enc[12][.]'"), 2, 'legacy plaintext is in place');
  // Reads accept it: same API output, same answers.
  assert.deepEqual((await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token })).data, passagesBefore);
  assert.deepEqual(await services.clauses.getAnswer({ householdId: s.householdId, caseId: s.caseId, answerId: answerBefore.answerId }), answerBefore);
  assert.equal((await services.households.getAdult(s.adultId)).display_name, HOLDER);

  const snapshot = async () => JSON.stringify(await Promise.all(ENCRYPTED_COLUMNS.map(({ table: name, key = ['id'] }) => app.database.many(`SELECT * FROM ${name} ORDER BY ${key.join(', ')}`))));
  const before = await snapshot();
  const dry = await encryptExistingRows({ database: app.database, crypto, dryRun: true });
  assert.equal(dry.dryRun, true);
  assert.ok(dry.rows > 0 && dry.columns >= dry.rows);
  assert.equal(await snapshot(), before, 'a dry run writes nothing');

  const first = await encryptExistingRows({ database: app.database, crypto, batchSize: 1 });
  assert.equal(first.rows, dry.rows);
  assert.equal(first.columns, dry.columns);
  assert.deepEqual(first.tables.map(item => item.table), ENCRYPTED_COLUMNS.map(item => item.table));
  await assertSealedEverywhere(app.database);
  const second = await encryptExistingRows({ database: app.database, crypto });
  assert.equal(second.rows, 0, 'a second run changes 0 rows');
  assert.equal(second.columns, 0);
  assert.ok(!JSON.stringify(first).includes(MARKER), 'the report carries counts only');

  // Same values after sealing; immutability triggers are enabled again.
  assert.deepEqual((await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token })).data, passagesBefore);
  assert.deepEqual(await services.clauses.getAnswer({ householdId: s.householdId, caseId: s.caseId, answerId: answerBefore.answerId }), answerBefore);
  const triggers = await app.database.many(`SELECT tgname, tgenabled FROM pg_trigger WHERE tgname = ANY(?)`, [ENCRYPTED_COLUMNS.flatMap(item => item.triggers)]);
  assert.equal(triggers.length, new Set(ENCRYPTED_COLUMNS.flatMap(item => item.triggers)).size);
  assert.ok(triggers.every(trigger => trigger.tgenabled === 'O'), 'no trigger is left disabled');
  await assert.rejects(app.database.run("UPDATE policy_clauses SET text = 'x'"), /immutable/);
  await assert.rejects(app.database.run("UPDATE evidence_facts SET value_json = 'x'"), /append only/);
});

test('E1b: a key rotation re-seals under the new key id, idempotently, and old rows keep reading meanwhile', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  await populate(app, s);
  const oldKey = randomBytes(32).toString('base64');
  const first = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: oldKey, DATA_ENCRYPTION_KEY_ID: 'k1' }));
  // Move everything from the development key to k1 first, then rotate k1 to k2.
  await downgrade(app.database, sharedColumnCrypto());
  await encryptExistingRows({ database: app.database, crypto: first });
  // A table that is sealed from its first write (policy_profiles) is never unsealed by the downgrade above, so it still sits under the
  // development key; a rotation from that key moves it to k1 like the others.
  const developmentKey = createHash('sha256').update('cover-saath development column key, not a secret').digest('base64');
  const fromDevelopment = createColumnCrypto(readDataEncryptionConfig({ DATA_ENCRYPTION_KEY_BASE64: oldKey, DATA_ENCRYPTION_KEY_ID: 'k1', DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ dev: developmentKey }) }));
  await encryptExistingRows({ database: app.database, crypto: fromDevelopment, rotate: true });
  assert.equal(await readCount(app.database, 'adult_users', 'display_name', "AND left(display_name, 8) = 'enc2.k1.'"), 2);

  const second = createColumnCrypto(readDataEncryptionConfig({
    DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DATA_ENCRYPTION_KEY_ID: 'k2', DATA_ENCRYPTION_PREVIOUS_KEYS_JSON: JSON.stringify({ k1: oldKey }),
  }));
  const services = createBackendServices(app.database, { columnCrypto: second });
  assert.equal((await services.households.getAdult(s.adultId)).display_name, HOLDER, 'an old key id still reads');
  assert.equal((await encryptExistingRows({ database: app.database, crypto: second })).rows, 0, 'without --rotate nothing is touched');
  const rotated = await encryptExistingRows({ database: app.database, crypto: second, rotate: true });
  assert.ok(rotated.rows > 0);
  for (const { table: name, columns } of ENCRYPTED_COLUMNS) {
    for (const column of columns) {
      assert.equal(await readCount(app.database, name, column, `AND left(${column}, 8) <> 'enc2.k2.'`), 0, `${name}.${column} is under k2`);
    }
  }
  assert.equal((await encryptExistingRows({ database: app.database, crypto: second, rotate: true })).rows, 0, 'a second rotation changes 0 rows');
  assert.equal((await services.households.getAdult(s.adultId)).display_name, HOLDER);
  await assert.rejects(encryptExistingRows({ database: app.database, crypto: second, batchSize: 0 }), RangeError);
});

test('E1b: production fails closed without a data encryption key, at server start and at service construction', pgOptions, async t => {
  const { db } = await freshDatabase(t);
  const env = { NODE_ENV: 'production', KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-production-closed-token-0001' };
  assert.throws(() => createApiServer({ database: db, env }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  assert.throws(() => createBackendServices(db, { env }), { code: 'DATA_ENCRYPTION_KEY_REQUIRED' });
  const withKey = { ...env, DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') };
  const server = createApiServer({ database: db, env: withKey });
  assert.ok(server);
  assert.ok(createBackendServices(db, { env: withKey }));
});

test('E1d/E1b + D2: migrations 018, 019, 020 and 030 can be run again on a migrated database without error or loss', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  await app.call(`/api/v1/cases/${s.caseId}/profile-answers`, { method: 'PUT', token: s.token, body: { answers: { city: 'Pune' } } });
  const counts = async () => (await app.database.one('SELECT (SELECT count(*) FROM profile_answers) AS a, (SELECT count(*) FROM document_blobs) AS b, (SELECT count(*) FROM adult_users) AS c')).a;
  const before = await counts();
  for (const name of ['018_profile_answers.sql', '019_column_encryption_prep.sql', '020_document_blobs.sql', '030_seal_remaining_columns.sql']) {
    const sql = readFileSync(join(postgresMigrationDirectory, name), 'utf8');
    await app.database.pool.query(sql);
    await app.database.pool.query(sql);
  }
  assert.equal(await counts(), before);
  assert.deepEqual(await app.database.many(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity`), []);
  // The sealed-length checks exist exactly once per column after repeated runs.
  const checks = await app.database.many("SELECT conname FROM pg_constraint WHERE conname LIKE '%sealed_len_check' ORDER BY conname");
  // Migration 030 (D2) adds its own looser caps; the list is the 019 set plus those.
  assert.deepEqual(checks.map(row => row.conname), [
    'evidence_facts_value_json_sealed_len_check', 'ocr_jobs_result_json_sealed_len_check', 'policy_answers_answer_json_sealed_len_check',
    'policy_answers_question_sealed_len_check', 'policy_clauses_text_sealed_len_check', 'policy_clauses_title_sealed_len_check',
    'proposed_parameters_label_sealed_len_check', 'source_pages_blocks_json_sealed_len_check',
  ]);
  assert.ok(readdirSync(postgresMigrationDirectory).filter(name => /^0(18|19|20|30)_/.test(name)).length === 4);
});

// ---- review fixes ----

test('review: migration 021 makes the JSON columns take a sealed envelope or JSON only, and profile answers a sealed envelope only', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  await populate(app, s);
  const db = app.database;
  await assert.rejects(db.run("UPDATE ocr_jobs SET result_json = 'readable text, not JSON'"), /violates check constraint/);
  await assert.rejects(db.run("UPDATE policy_answers SET answer_json = 'x'"), /immutable|violates check constraint/);
  await assert.rejects(db.run(`INSERT INTO profile_answers (id, household_id, case_id, adult_user_id, field_key, value_ciphertext, created_at, updated_at)
    VALUES ('plain-answer', ?, ?, ?, 'city', 'Pune', 't', 't')`, [s.householdId, s.caseId, s.adultId]), /violates check constraint/);
  // Valid JSON (legacy rows) and envelopes of either version remain acceptable.
  await db.run(`INSERT INTO profile_answers (id, household_id, case_id, adult_user_id, field_key, value_ciphertext, created_at, updated_at)
    VALUES ('sealed-answer', ?, ?, ?, 'state', 'enc1.k1.AAAA.BBBB.CCCC', 't', 't')`, [s.householdId, s.caseId, s.adultId]);
  const names = (await db.many("SELECT conname FROM pg_constraint WHERE conname LIKE '%sealed_or_js%' OR conname = 'profile_answers_value_sealed_check' ORDER BY conname")).map(row => row.conname);
  // 021's four JSON columns, profile answers, and the columns migration 030 (D2) added the same check to.
  assert.deepEqual([...names].sort(), [
    'catalogue_reviews_fact_json_sealed_or_json_check', 'coverage_graph_snapshots_graph_json_sealed_or_json_check',
    'coverage_parameter_observations_value_json_sealed_or_json_check', 'coverage_parameter_resolutions_resolved_value_json_sealed_or_js' /* cut to the 63-character identifier limit */,
    'evidence_facts_value_json_sealed_or_json_check', 'idempotency_keys_response_json_sealed_or_json_check', 'integration_outbox_payload_json_sealed_or_json_check',
    'integration_webhook_events_payload_json_sealed_or_json_check', 'ocr_jobs_result_json_sealed_or_json_check', 'policy_answers_answer_json_sealed_or_json_check',
    'profile_answers_value_sealed_check', 'proposed_parameters_value_json_sealed_or_json_check', 'source_pages_blocks_json_sealed_or_json_check',
    'source_pages_provenance_json_sealed_or_json_check', 'workflow_events_event_payload_json_sealed_or_json_check', 'workflow_runs_input_json_sealed_or_json_check',
    'workflow_tasks_input_json_sealed_or_json_check', 'workflow_tasks_output_json_sealed_or_json_check',
  ].sort());
});

test('review: a backfill batch that fails in SQL rethrows the original error, rolls back, and leaves the trigger enabled', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  await populate(app, s);
  const crypto = sharedColumnCrypto();
  await downgrade(app.database, crypto);
  // A legacy title just under the plaintext cap seals to more than the sealed-length cap, so its UPDATE fails inside the batch
  // while policy_clauses_immutable is disabled.
  await app.database.run('ALTER TABLE policy_clauses DISABLE TRIGGER policy_clauses_immutable');
  await app.database.run("UPDATE policy_clauses SET title = ? WHERE id = (SELECT id FROM policy_clauses ORDER BY id LIMIT 1)", ['t'.repeat(1990)]);
  await app.database.run('ALTER TABLE policy_clauses ENABLE TRIGGER policy_clauses_immutable');
  const before = await app.database.one("SELECT count(*) AS n FROM adult_users WHERE display_name !~ '^enc[12][.]'");
  await assert.rejects(encryptExistingRows({ database: app.database, crypto }), error => error.code === '23514' && /sealed_len_check/.test(error.constraint ?? error.message));
  const trigger = await app.database.one("SELECT tgenabled FROM pg_trigger WHERE tgname = 'policy_clauses_immutable'");
  assert.equal(trigger.tgenabled, 'O', 'the failed batch did not leave the trigger disabled');
  await assert.rejects(app.database.run("UPDATE policy_clauses SET text = 'x'"), /immutable/);
  // Tables sealed before the failing one stay sealed (their batches committed); the failing table is unchanged.
  assert.equal((await app.database.one("SELECT count(*) AS n FROM adult_users WHERE display_name !~ '^enc[12][.]'")).n, 0);
  assert.ok(before.n > 0);
  assert.equal((await app.database.one("SELECT count(*) AS n FROM policy_clauses WHERE text !~ '^enc[12][.]'")).n > 0, true);
});

test('review: the backfill script needs a real key unless --allow-development-key, and never seals into a remote database with the public key', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../scripts/encrypt-existing-rows.mjs', import.meta.url));
  const run = (args, env) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  const unreachable = 'postgres://user@127.0.0.1:1/none';
  const noKey = run([], { DATABASE_URL: unreachable });
  assert.equal(noKey.status, 1);
  assert.match(noKey.stderr, /DATA_ENCRYPTION_KEY_REQUIRED/, 'stopped on the missing key, before any connection');
  const dev = run(['--allow-development-key'], { DATABASE_URL: unreachable });
  assert.match(dev.stderr, /public development key/);
  assert.doesNotMatch(dev.stderr, /DATA_ENCRYPTION_KEY_REQUIRED/, 'passed the key gate and failed later, on the connection');
  const remote = run(['--allow-development-key'], { DATABASE_URL: 'postgres://user@db.example.com/none' });
  assert.match(remote.stderr, /DATA_ENCRYPTION_KEY_REQUIRED/, 'the flag never allows the public key against a remote database');
  const withKey = run(['--dry-run'], { DATABASE_URL: unreachable, DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') });
  assert.doesNotMatch(withKey.stderr, /DATA_ENCRYPTION_KEY|public development key/);
  assert.equal(run(['--bogus'], {}).status, 2);
  for (const result of [noKey, dev, remote, withKey]) assert.ok(!result.stdout.includes('"rows"') || result.status === 0);
});
