import { createHash } from 'node:crypto';
import { DocumentIntakeError } from './contracts.js';
import { documentEncryptionKey, openDocumentBytes, sealDocumentBytes } from './document-envelope.js';

// Document byte storage in PostgreSQL (migration 020, ADR 0013). Implements the same interface as
// createEncryptedLocalByteStorage and writes the same CSD1 envelope, so the bytes are encrypted here, in the application,
// before they reach the database: PostgreSQL only ever holds ciphertext and never holds the key. The storage key is
// sha256(document id), exactly as for the filesystem adapter.
//
// `database` is the async database interface, or a function returning it (or a promise of it) so a server can build the
// storage before its pool exists. Reads never list or return bytes except to the caller that holds the document row.

const STORAGE_KEY = /^[0-9a-f]{64}$/;
const LIST_PAGE = 1_000;

const invalidKey = () => new DocumentIntakeError('INVALID_STORAGE_KEY', 'The storage reference is invalid.');
const unavailable = () => Object.assign(new DocumentIntakeError('STORAGE_UNAVAILABLE', 'Document storage is temporarily unavailable.'), { retryable: true });

export function createEncryptedDatabaseByteStorage({ database, key }) {
  if (!database) throw new TypeError('A database is required for database document storage.');
  const secret = documentEncryptionKey(key);
  const resolveDatabase = async () => (typeof database === 'function' ? await database() : database);
  const checked = storageKey => {
    if (typeof storageKey !== 'string' || !STORAGE_KEY.test(storageKey)) throw invalidKey();
    return storageKey;
  };

  return Object.freeze({
    mode: 'live',
    protection: 'authenticated_encryption',
    backend: 'database',
    async put({ documentId, householdId, bytes }) {
      if (typeof documentId !== 'string' || !documentId) throw new DocumentIntakeError('INVALID_STORAGE_INPUT', 'A document id is required.');
      if (typeof householdId !== 'string' || !householdId) throw new DocumentIntakeError('INVALID_STORAGE_INPUT', 'A household id is required for database storage.');
      const storageKey = createHash('sha256').update(documentId).digest('hex');
      const envelope = sealDocumentBytes(secret, documentId, bytes);
      const db = await resolveDatabase();
      await db.run(`INSERT INTO document_blobs (document_id, storage_key, household_id, envelope, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (document_id) DO UPDATE SET envelope = EXCLUDED.envelope, created_at = EXCLUDED.created_at`,
      [documentId, storageKey, householdId, envelope, new Date().toISOString()]);
      return storageKey;
    },
    // A missing row is STORAGE_OBJECT_MISSING; a database error is a retryable outage, so a hiccup never deletes a document.
    // Only a malformed envelope or a failed authentication tag is tampering.
    async read({ documentId, storageKey }) {
      checked(storageKey);
      let row;
      try {
        row = await (await resolveDatabase()).one('SELECT envelope FROM document_blobs WHERE storage_key = ?', [storageKey]);
      } catch {
        throw unavailable();
      }
      if (!row) throw new DocumentIntakeError('STORAGE_OBJECT_MISSING', 'The stored document is missing.');
      return openDocumentBytes(secret, documentId, Buffer.from(row.envelope));
    },
    // Stored objects for the orphan sweep (names and times only, never bytes). The sweep removes a blob with no live row.
    async list() {
      // Keyset-paged over the whole table (names and times only, never bytes), so the orphan sweep sees every blob and
      // not just the first page of them.
      const db = await resolveDatabase();
      const entries = [];
      let after = '';
      for (;;) {
        const rows = await db.many('SELECT storage_key, created_at FROM document_blobs WHERE storage_key > ? ORDER BY storage_key LIMIT ?', [after, LIST_PAGE]);
        for (const row of rows) entries.push({ name: `${row.storage_key}.csd`, storageKey: row.storage_key, temporary: false, modifiedAt: Date.parse(row.created_at) || 0 });
        if (rows.length < LIST_PAGE) return entries;
        after = rows.at(-1).storage_key;
      }
    },
    async removeTemporary() {},
    async remove({ storageKey }) {
      await (await resolveDatabase()).run('DELETE FROM document_blobs WHERE storage_key = ?', [checked(storageKey)]);
    },
  });
}

/**
 * Two byte stores behind one interface for a move between backends. Writes go to `primary`. A read that `primary` answers
 * with "missing" or "unavailable" is tried on `fallback` (documents stored before the switch); a failed authentication on
 * either is final. A removal clears both. The orphan sweep sees both.
 */
export function createFallbackByteStorage({ primary, fallback }) {
  if (!primary || !fallback) throw new TypeError('A primary and a fallback byte storage are required.');
  const fell = new Set(['STORAGE_OBJECT_MISSING', 'STORAGE_UNAVAILABLE']);
  return Object.freeze({
    mode: primary.mode,
    protection: primary.protection,
    backend: `${primary.backend ?? 'filesystem'}+${fallback.backend ?? 'filesystem'}`,
    put: input => primary.put(input),
    async read(input) {
      try {
        return await primary.read(input);
      } catch (error) {
        if (!fell.has(error?.code)) throw error;
        try {
          return await fallback.read(input);
        } catch (second) {
          if (second?.code === 'STORAGE_TAMPERED') throw second;
          throw error;
        }
      }
    },
    async list() {
      const [first, second] = await Promise.all([primary.list?.() ?? [], fallback.list?.() ?? []]);
      return [...first, ...second];
    },
    async removeTemporary(name) {
      await Promise.all([primary.removeTemporary?.(name), fallback.removeTemporary?.(name)]);
    },
    async remove(input) {
      await Promise.all([primary.remove(input), fallback.remove(input)]);
    },
  });
}
