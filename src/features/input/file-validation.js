import { extname } from 'node:path';
import { ALLOWED_MIME_TYPES, DocumentIntakeError, MAX_DOCUMENT_BYTES } from './contracts.js';

const EXTENSIONS = Object.freeze({
  'application/pdf': new Set(['.pdf']),
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
});

export function sanitizeFilename(value) {
  if (typeof value !== 'string' || !value.trim()) throw new DocumentIntakeError('INVALID_FILENAME', 'A filename is required.');
  const leaf = value.replaceAll('\\', '/').split('/').pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  const safe = leaf.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 160);
  if (!safe || safe === '.' || safe === '..') throw new DocumentIntakeError('INVALID_FILENAME', 'The filename is not usable.');
  return safe;
}

export function sniffMimeType(bytes) {
  if (bytes.length >= 5 && bytes.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export function validateDocumentFile({ filename, declaredMimeType, bytes, maxBytes = MAX_DOCUMENT_BYTES }) {
  const safeFilename = sanitizeFilename(filename);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw new DocumentIntakeError('INVALID_BYTES', 'Document bytes are required.');
  const buffer = Buffer.from(bytes);
  if (buffer.length === 0) throw new DocumentIntakeError('EMPTY_FILE', 'The document is empty.');
  if (buffer.length > maxBytes) throw new DocumentIntakeError('FILE_TOO_LARGE', `The document exceeds the ${maxBytes} byte limit.`);
  const detectedMimeType = sniffMimeType(buffer);
  if (!detectedMimeType || detectedMimeType !== declaredMimeType) {
    throw new DocumentIntakeError('MIME_MISMATCH', 'The declared file type does not match the file signature.');
  }
  if (!EXTENSIONS[detectedMimeType]?.has(extname(safeFilename).toLowerCase())) {
    throw new DocumentIntakeError('EXTENSION_MISMATCH', 'The filename extension does not match the file type.');
  }
  return { safeFilename, detectedMimeType, bytes: buffer };
}
