import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { DocumentIntakeError } from './contracts.js';

// The CSD1 envelope for stored document bytes: "CSD1" + nonce(12) + tag(16) + AES-256-GCM ciphertext, with the document id as
// additional authenticated data. Shared by the filesystem and the database byte storage, so the stored format is identical
// and a document can move between them without being re-encrypted.

const MAGIC = Buffer.from('CSD1');

export function documentEncryptionKey(value) {
  if (!value) throw new DocumentIntakeError('ENCRYPTION_KEY_REQUIRED', 'A server-only document encryption key is required.');
  const key = Buffer.isBuffer(value) ? Buffer.from(value) : Buffer.from(value, 'base64');
  if (key.length !== 32) throw new DocumentIntakeError('INVALID_ENCRYPTION_KEY', 'The document encryption key must decode to 32 bytes.');
  return key;
}

export function sealDocumentBytes(secret, documentId, bytes) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', secret, nonce);
  cipher.setAAD(Buffer.from(documentId));
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([MAGIC, nonce, cipher.getAuthTag(), ciphertext]);
}

/** Opens an envelope. Any malformed envelope or failed authentication is STORAGE_TAMPERED. */
export function openDocumentBytes(secret, documentId, payload) {
  try {
    if (payload.length < 32 || !payload.subarray(0, 4).equals(MAGIC)) throw new Error('invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', secret, payload.subarray(4, 16));
    decipher.setAAD(Buffer.from(documentId));
    decipher.setAuthTag(payload.subarray(16, 32));
    return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
  } catch {
    throw new DocumentIntakeError('STORAGE_TAMPERED', 'Stored document authentication failed.');
  }
}
