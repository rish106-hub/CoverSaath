import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
async function assertSealedEverywhere(db, { expectPresent = true } = {}) {
  for (const { table: name, columns } of ENCRYPTED_COLUMNS) {
    for (const column of columns) {
      const present = await readCount(db, name, column, '');
      if (expectPresent) assert.ok(present > 0, `${name}.${column} was never written by the test`);
      const plain = await readCount(db, name, column, `AND left(${column}, 5) <> 'enc1.'`);
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

// Turns every sealed column back into the plaintext an older build wrote, so the legacy-read and backfill paths are real.
async function downgrade(db, crypto) {
  for (const { table: name, columns, triggers } of ENCRYPTED_COLUMNS) {
    for (const trigger of triggers) await db.run(`ALTER TABLE ${name} DISABLE TRIGGER ${trigger}`);
    const rows = await db.many(`SELECT id, ${columns.join(', ')} FROM ${name}`);
    for (const row of rows) {
      for (const column of columns) {
        if (row[column] === null || !crypto.isSealed(row[column])) continue;
        await db.run(`UPDATE ${name} SET ${column} = ? WHERE id = ?`, [crypto.open(name, column, row.id, row[column]), row.id]);
      }
    }
    for (const trigger of triggers) await db.run(`ALTER TABLE ${name} ENABLE TRIGGER ${trigger}`);
  }
}

test('E1b: legacy plaintext rows still read; the backfill dry run changes nothing, seals them once, and a second run changes 0 rows', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: true });
  const services = await populate(app, s);
  const crypto = sharedColumnCrypto();
  const answerBefore = await services.clauses.getAnswer({ householdId: s.householdId, caseId: s.caseId, answerId: (await app.database.one('SELECT id FROM policy_answers')).id });
  const passagesBefore = (await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token })).data;

  await downgrade(app.database, crypto);
  assert.equal(await readCount(app.database, 'adult_users', 'display_name', "AND left(display_name, 5) <> 'enc1.'"), 2, 'legacy plaintext is in place');
  // Reads accept it: same API output, same answers.
  assert.deepEqual((await app.call(`/api/v1/cases/${s.caseId}/passages?q=${encodeURIComponent('room rent')}`, { token: s.token })).data, passagesBefore);
  assert.deepEqual(await services.clauses.getAnswer({ householdId: s.householdId, caseId: s.caseId, answerId: answerBefore.answerId }), answerBefore);
  assert.equal((await services.households.getAdult(s.adultId)).display_name, HOLDER);

  const snapshot = async () => JSON.stringify(await Promise.all(ENCRYPTED_COLUMNS.map(({ table: name, columns }) => app.database.many(`SELECT id, ${columns.join(', ')} FROM ${name} ORDER BY id`))));
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
  assert.equal(triggers.length, 4);
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
  assert.equal(await readCount(app.database, 'adult_users', 'display_name', "AND left(display_name, 8) = 'enc1.k1.'"), 2);

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
      assert.equal(await readCount(app.database, name, column, `AND left(${column}, 8) <> 'enc1.k2.'`), 0, `${name}.${column} is under k2`);
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

test('E1d/E1b: migrations 018, 019 and 020 can be run again on a migrated database without error or loss', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  await app.call(`/api/v1/cases/${s.caseId}/profile-answers`, { method: 'PUT', token: s.token, body: { answers: { city: 'Pune' } } });
  const counts = async () => (await app.database.one('SELECT (SELECT count(*) FROM profile_answers) AS a, (SELECT count(*) FROM document_blobs) AS b, (SELECT count(*) FROM adult_users) AS c')).a;
  const before = await counts();
  for (const name of ['018_profile_answers.sql', '019_column_encryption_prep.sql', '020_document_blobs.sql']) {
    const sql = readFileSync(join(postgresMigrationDirectory, name), 'utf8');
    await app.database.pool.query(sql);
    await app.database.pool.query(sql);
  }
  assert.equal(await counts(), before);
  assert.deepEqual(await app.database.many(`SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND NOT c.relrowsecurity`), []);
  // The sealed-length checks exist exactly once per column after repeated runs.
  const checks = await app.database.many("SELECT conname FROM pg_constraint WHERE conname LIKE '%sealed_len_check' ORDER BY conname");
  assert.deepEqual(checks.map(row => row.conname), [
    'evidence_facts_value_json_sealed_len_check', 'ocr_jobs_result_json_sealed_len_check', 'policy_answers_answer_json_sealed_len_check',
    'policy_clauses_text_sealed_len_check', 'policy_clauses_title_sealed_len_check', 'source_pages_blocks_json_sealed_len_check',
  ]);
  assert.ok(readdirSync(postgresMigrationDirectory).filter(name => /^0(18|19|20)_/.test(name)).length === 3);
});
