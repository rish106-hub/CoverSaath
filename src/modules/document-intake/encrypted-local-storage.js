import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DocumentIntakeError } from './contracts.js';

const MAGIC = Buffer.from('CSD1');

function encryptionKey(value) {
  if (!value) throw new DocumentIntakeError('ENCRYPTION_KEY_REQUIRED', 'A server-only document encryption key is required.');
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new DocumentIntakeError('INVALID_ENCRYPTION_KEY', 'The document encryption key must decode to 32 bytes.');
  return key;
}

export function createEncryptedLocalByteStorage({ baseDirectory, key }) {
  if (typeof baseDirectory !== 'string' || !baseDirectory.trim()) throw new TypeError('A document storage directory is required.');
  const root = resolve(baseDirectory);
  const secret = encryptionKey(key);
  const pathFor = storageKey => resolve(root, `${storageKey}.csd`);

  return Object.freeze({
    mode: 'live',
    protection: 'authenticated_encryption',
    async put({ documentId, bytes }) {
      const storageKey = createHash('sha256').update(documentId).digest('hex');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', secret, nonce);
      cipher.setAAD(Buffer.from(documentId));
      const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
      const payload = Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
      await mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = resolve(root, `.${storageKey}.${randomUUID()}.tmp`);
      await writeFile(temporary, payload, { mode: 0o600, flag: 'wx' });
      await rename(temporary, pathFor(storageKey));
      return storageKey;
    },
    async read({ documentId, storageKey }) {
      try {
        const payload = await readFile(pathFor(storageKey));
        if (payload.length < 32 || !payload.subarray(0, 4).equals(MAGIC)) throw new Error('invalid envelope');
        const nonce = payload.subarray(4, 16);
        const tag = payload.subarray(16, 32);
        const decipher = createDecipheriv('aes-256-gcm', secret, nonce);
        decipher.setAAD(Buffer.from(documentId));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
      } catch {
        throw new DocumentIntakeError('STORAGE_TAMPERED', 'Stored document authentication failed.');
      }
    },
    async remove({ storageKey }) {
      await rm(pathFor(storageKey), { force: true });
    },
  });
}
