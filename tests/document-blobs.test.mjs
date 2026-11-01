import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { postgresTestOptions, freshDatabase } from './support/pg.mjs';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { startApp, scenario } from './support/read-back-harness.mjs';
import {
  createEncryptedDatabaseByteStorage, createEncryptedLocalByteStorage, createFallbackByteStorage,
} from '../src/features/input/index.js';
import { readServerConfig } from '../src/server/config.js';

const pgOptions = postgresTestOptions();

// E1c (ADR 0013): document bytes in the database. The adapter writes the same CSD1 envelope as the filesystem adapter, the
// database holds only ciphertext, and erasure removes the row. Synthetic bytes only.

const PLAIN = Buffer.from('%PDF-1.7 synthetic document body SYN-PERS-410001');
const HOUSEHOLD = 'household-blob';

async function world(t) {
  const { db } = await freshDatabase(t);
  await db.run("INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, 'Synthetic', 't', 't')", [HOUSEHOLD]);
  return db;
}

test('E1c: put, read and remove round trip; the row holds only the CSD1 envelope', pgOptions, async t => {
  const db = await world(t);
  const storage = createEncryptedDatabaseByteStorage({ database: db, key: randomBytes(32) });
  const storageKey = await storage.put({ documentId: 'doc-1', householdId: HOUSEHOLD, bytes: PLAIN });
  assert.match(storageKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(await storage.read({ documentId: 'doc-1', storageKey }), PLAIN);
  const row = await db.one('SELECT * FROM document_blobs WHERE document_id = ?', ['doc-1']);
  assert.equal(row.storage_key, storageKey);
  assert.equal(row.household_id, HOUSEHOLD);
  assert.equal(Buffer.from(row.envelope).subarray(0, 4).toString(), 'CSD1');
  assert.ok(!Buffer.from(row.envelope).includes(Buffer.from('synthetic document body')), 'no plaintext at rest');
  assert.ok(!Buffer.from(row.envelope).includes(Buffer.from('%PDF')));
  // A second put for the same document replaces it (a retry), it does not duplicate.
  await storage.put({ documentId: 'doc-1', householdId: HOUSEHOLD, bytes: Buffer.from('replacement') });
  assert.equal((await db.one('SELECT count(*) AS n FROM document_blobs')).n, 1);
  assert.deepEqual(await storage.read({ documentId: 'doc-1', storageKey }), Buffer.from('replacement'));
  assert.deepEqual((await storage.list()).map(entry => [entry.storageKey, entry.temporary]), [[storageKey, false]]);
  await storage.remove({ storageKey });
  await storage.remove({ storageKey });
  await assert.rejects(storage.read({ documentId: 'doc-1', storageKey }), { code: 'STORAGE_OBJECT_MISSING' });
  assert.equal((await db.one('SELECT count(*) AS n FROM document_blobs')).n, 0);
});

test('E1c: a wrong document id, a wrong key or a flipped byte is STORAGE_TAMPERED; bad references and inputs are refused', pgOptions, async t => {
  const db = await world(t);
  const key = randomBytes(32);
  const storage = createEncryptedDatabaseByteStorage({ database: db, key });
  const storageKey = await storage.put({ documentId: 'doc-2', householdId: HOUSEHOLD, bytes: PLAIN });
  await assert.rejects(storage.read({ documentId: 'doc-other', storageKey }), { code: 'STORAGE_TAMPERED' });
  await assert.rejects(createEncryptedDatabaseByteStorage({ database: db, key: randomBytes(32) }).read({ documentId: 'doc-2', storageKey }), { code: 'STORAGE_TAMPERED' });
  const envelope = Buffer.from((await db.one('SELECT envelope FROM document_blobs')).envelope);
  envelope[envelope.length - 1] ^= 1;
  await db.run('UPDATE document_blobs SET envelope = ?', [envelope]);
  await assert.rejects(storage.read({ documentId: 'doc-2', storageKey }), { code: 'STORAGE_TAMPERED' });
  await assert.rejects(storage.read({ documentId: 'doc-2', storageKey: '../../etc/passwd' }), { code: 'INVALID_STORAGE_KEY' });
  await assert.rejects(storage.remove({ storageKey: 'short' }), { code: 'INVALID_STORAGE_KEY' });
  await assert.rejects(storage.put({ documentId: 'doc-3', bytes: PLAIN }), { code: 'INVALID_STORAGE_INPUT' });
  await assert.rejects(storage.put({ documentId: 'doc-3', householdId: 'household-missing', bytes: PLAIN }), /./);
  assert.throws(() => createEncryptedDatabaseByteStorage({ database: db, key: 'c2hvcnQ=' }), { code: 'INVALID_ENCRYPTION_KEY' });
  assert.throws(() => createEncryptedDatabaseByteStorage({ database: db }), { code: 'ENCRYPTION_KEY_REQUIRED' });
  assert.throws(() => createEncryptedDatabaseByteStorage({ key }), TypeError);
  // A database outage is retryable, never "missing".
  const broken = createEncryptedDatabaseByteStorage({ database: { async one() { throw new Error('connection lost'); } }, key });
  await assert.rejects(broken.read({ documentId: 'doc-2', storageKey }), error => error.code === 'STORAGE_UNAVAILABLE' && error.retryable === true);
});

test('E1c: the envelope is identical to the filesystem one, so a document moves between backends without re-encryption', pgOptions, async t => {
  const db = await world(t);
  const key = randomBytes(32);
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-blobs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = createEncryptedLocalByteStorage({ baseDirectory: directory, key });
  const inDatabase = createEncryptedDatabaseByteStorage({ database: db, key });
  const storageKey = await files.put({ documentId: 'doc-move', bytes: PLAIN });
  // Copy the file's bytes into a blob row untouched: the database adapter opens it.
  await db.run('INSERT INTO document_blobs (document_id, storage_key, household_id, envelope, created_at) VALUES (?, ?, ?, ?, ?)',
    ['doc-move', storageKey, HOUSEHOLD, readFileSync(join(directory, `${storageKey}.csd`)), 't']);
  assert.deepEqual(await inDatabase.read({ documentId: 'doc-move', storageKey }), PLAIN);
  // And the other way round.
  const dbKey = await inDatabase.put({ documentId: 'doc-back', householdId: HOUSEHOLD, bytes: PLAIN });
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(directory, `${dbKey}.csd`), Buffer.from((await db.one('SELECT envelope FROM document_blobs WHERE document_id = ?', ['doc-back'])).envelope));
  assert.deepEqual(await files.read({ documentId: 'doc-back', storageKey: dbKey }), PLAIN);
});

test('E1c: the fallback store reads what the other backend holds, writes to the primary and removes from both', pgOptions, async t => {
  const db = await world(t);
  const key = randomBytes(32);
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-fallback-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = createEncryptedLocalByteStorage({ baseDirectory: directory, key });
  const inDatabase = createEncryptedDatabaseByteStorage({ database: db, key });
  const databaseFirst = createFallbackByteStorage({ primary: inDatabase, fallback: files });
  const filesystemFirst = createFallbackByteStorage({ primary: files, fallback: inDatabase });

  const oldKey = await files.put({ documentId: 'doc-old', bytes: PLAIN });
  assert.deepEqual(await databaseFirst.read({ documentId: 'doc-old', storageKey: oldKey }), PLAIN, 'stored before the switch, still readable');
  const newKey = await databaseFirst.put({ documentId: 'doc-new', householdId: HOUSEHOLD, bytes: PLAIN });
  assert.equal((await db.one('SELECT count(*) AS n FROM document_blobs WHERE storage_key = ?', [newKey])).n, 1, 'new bytes go to the database');
  assert.equal(existsSync(join(directory, `${newKey}.csd`)), false);
  assert.deepEqual(await filesystemFirst.read({ documentId: 'doc-new', storageKey: newKey }), PLAIN, 'rollback: filesystem primary still reads the database copy');
  assert.equal(databaseFirst.backend, 'database+filesystem');
  assert.equal(databaseFirst.mode, 'live');
  assert.equal(databaseFirst.protection, 'authenticated_encryption');

  // Missing everywhere stays "missing" (the primary's answer), not a confusing fallback error; tampering is final.
  await assert.rejects(databaseFirst.read({ documentId: 'doc-nope', storageKey: 'a'.repeat(64) }), { code: 'STORAGE_OBJECT_MISSING' });
  const missingRoot = createFallbackByteStorage({ primary: inDatabase, fallback: createEncryptedLocalByteStorage({ baseDirectory: join(directory, 'never-created'), key }) });
  await assert.rejects(missingRoot.read({ documentId: 'doc-nope', storageKey: 'a'.repeat(64) }), { code: 'STORAGE_OBJECT_MISSING' });
  await assert.rejects(databaseFirst.read({ documentId: 'doc-wrong-id', storageKey: oldKey }), { code: 'STORAGE_TAMPERED' });

  assert.equal((await databaseFirst.list()).length, 2, 'the sweep sees both backends');
  await databaseFirst.remove({ storageKey: oldKey });
  await databaseFirst.remove({ storageKey: newKey });
  assert.equal(readdirSync(directory).filter(name => name.endsWith('.csd')).length, 0);
  assert.equal((await db.one('SELECT count(*) AS n FROM document_blobs')).n, 0);
});

test('E1c: DOCUMENT_STORAGE_BACKEND defaults to database, accepts filesystem, refuses anything else', () => {
  assert.equal(readServerConfig({}).documents.storageBackend, 'database');
  assert.equal(readServerConfig({ DOCUMENT_STORAGE_BACKEND: 'filesystem' }).documents.storageBackend, 'filesystem');
  for (const bad of ['', 'DATABASE', 's3', 'database,filesystem']) {
    assert.throws(() => readServerConfig({ DOCUMENT_STORAGE_BACKEND: bad }), /Invalid DOCUMENT_STORAGE_BACKEND/, JSON.stringify(bad));
  }
});

test('E1c: an upload through the API lands in document_blobs as ciphertext, with no file on disk and nothing leaked by a list route', pgOptions, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-blobs-api-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await startApp(t, { env: { DOCUMENT_STORAGE_PATH: join(directory, 'documents') } });
  const s = await scenario(app, { read: true });
  const blobs = await app.database.many('SELECT * FROM document_blobs');
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].household_id, s.householdId);
  assert.equal(blobs[0].document_id, s.documentId);
  assert.equal(Buffer.from(blobs[0].envelope).subarray(0, 4).toString(), 'CSD1');
  assert.ok(!Buffer.from(blobs[0].envelope).includes(Buffer.from('%PDF')), 'the PDF is not readable in the table');
  assert.equal(existsSync(join(directory, 'documents')), false, 'nothing was written to the filesystem');
  // Reading the document for OCR worked from the database copy (scenario ran the stubbed OCR to success).
  assert.equal((await app.database.one("SELECT count(*) AS n FROM ocr_jobs WHERE status = 'succeeded'")).n, 1);

  for (const path of [`/api/v1/cases/${s.caseId}/documents`, `/api/v1/cases/${s.caseId}/source-pack`, `/api/v1/households/${s.householdId}/cases`]) {
    const res = await app.call(path, { token: s.token });
    const body = JSON.stringify(res.data);
    assert.ok(!body.includes('CSD1') && !body.includes('envelope') && !body.includes(blobs[0].storage_key), `${path} must not expose bytes or the storage key`);
  }
});

test('E1c: revoking the document consent removes the blob row in the same transaction (erasure path)', pgOptions, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-blobs-revoke-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await startApp(t, { env: { DOCUMENT_STORAGE_PATH: join(directory, 'documents') } });
  const s = await scenario(app, { read: false });
  assert.equal((await app.database.one('SELECT count(*) AS n FROM document_blobs')).n, 1);
  const revoked = await app.call(`/api/v1/consents/${s.processingGrantId}/revoke`, { method: 'POST', token: s.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal((await app.database.one('SELECT count(*) AS n FROM document_blobs')).n, 0, 'the ciphertext is gone');
  const document = await app.database.one('SELECT lifecycle_state FROM document_uploads WHERE id = ?', [s.documentId]);
  assert.ok(['deletion_requested', 'deleted'].includes(document.lifecycle_state), document.lifecycle_state);
});

test('E1c: the orphan sweep removes a blob that has no live document row, and keeps a live one', pgOptions, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-blobs-sweep-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await startApp(t, { env: { DOCUMENT_STORAGE_PATH: join(directory, 'documents') } });
  const s = await scenario(app, { read: false });
  // A crash between storing bytes and committing the document row leaves a blob with no document.
  await app.database.run("INSERT INTO document_blobs (document_id, storage_key, household_id, envelope, created_at) VALUES ('doc-orphan', ?, ?, ?, '2020-01-01T00:00:00.000Z')",
    ['f'.repeat(64), s.householdId, Buffer.from('CSD1-orphan')]);
  const { createDocumentUploadService } = await import('../src/backend/services/index.js');
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const services = createBackendServices(app.database);
  const storage = createEncryptedDatabaseByteStorage({ database: app.database, key: randomBytes(32) });
  const uploads = createDocumentUploadService({ services, repository: services.documents, storage });
  const result = await uploads.sweepOrphans();
  assert.equal(result.removed, 1);
  assert.deepEqual((await app.database.many('SELECT document_id FROM document_blobs')).map(row => row.document_id), [s.documentId]);
});
