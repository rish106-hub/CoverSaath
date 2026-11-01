import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DocumentIntakeError } from './contracts.js';
import { documentEncryptionKey as encryptionKey, openDocumentBytes, sealDocumentBytes } from './document-envelope.js';

export function createEncryptedLocalByteStorage({ baseDirectory, key }) {
  if (typeof baseDirectory !== 'string' || !baseDirectory.trim()) throw new TypeError('A document storage directory is required.');
  const root = resolve(baseDirectory);
  const secret = encryptionKey(key);
  // Storage keys are SHA-256 hex of a random document id. Anything else never reaches the filesystem.
  const pathFor = storageKey => {
    if (typeof storageKey !== 'string' || !/^[0-9a-f]{64}$/.test(storageKey)) {
      throw new DocumentIntakeError('INVALID_STORAGE_KEY', 'The storage reference is invalid.');
    }
    return resolve(root, `${storageKey}.csd`);
  };

  return Object.freeze({
    mode: 'live',
    protection: 'authenticated_encryption',
    backend: 'filesystem',
    async put({ documentId, bytes }) {
      const storageKey = createHash('sha256').update(documentId).digest('hex');
      const payload = sealDocumentBytes(secret, documentId, bytes);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = resolve(root, `.${storageKey}.${randomUUID()}.tmp`);
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await rename(temporary, pathFor(storageKey));
      return storageKey;
    },
    // Only a malformed envelope or a failed authentication tag is tampering. A missing file and a
    // transient filesystem error are reported separately so a disk hiccup never deletes a document.
    async read({ documentId, storageKey }) {
      const path = pathFor(storageKey);
      let payload;
      try {
        payload = await readFile(path);
      } catch (error) {
        // A missing file only counts as missing when the storage root itself is present; an
        // unmounted or empty volume is an outage, not a deleted document.
        const rootPresent = error?.code === 'ENOENT' && await stat(root).then(info => info.isDirectory(), () => false);
        if (rootPresent) throw new DocumentIntakeError('STORAGE_OBJECT_MISSING', 'The stored document is missing.');
        throw Object.assign(new DocumentIntakeError('STORAGE_UNAVAILABLE', 'Document storage is temporarily unavailable.'), { retryable: true });
      }
      return openDocumentBytes(secret, documentId, payload);
    },
    // Stored objects and abandoned temporary files, for the orphan sweep. Names only, no content.
    async list() {
      let names;
      try {
        names = await readdir(root);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const entries = [];
      for (const name of names) {
        const object = /^([0-9a-f]{64})\.csd$/.exec(name);
        const temporary = /^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(name);
        if (!object && !temporary) continue;
        const info = await stat(resolve(root, name)).catch(() => null);
        if (info?.isFile()) entries.push({ name, storageKey: object ? object[1] : null, temporary, modifiedAt: info.mtimeMs });
      }
      return entries;
    },
    async removeTemporary(name) {
      if (!/^\.[0-9a-f]{64}\.[0-9a-f-]{36}\.tmp$/.test(name)) throw new DocumentIntakeError('INVALID_STORAGE_KEY', 'The storage reference is invalid.');
      await rm(resolve(root, name), { force: true });
    },
    async remove({ storageKey }) {
      await rm(pathFor(storageKey), { force: true });
    },
  });
}
