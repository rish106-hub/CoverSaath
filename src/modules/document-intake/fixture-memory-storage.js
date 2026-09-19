import { DocumentIntakeError } from './contracts.js';

export function createFixtureMemoryByteStorage() {
  const records = new Map();
  return Object.freeze({
    mode: 'fixture',
    protection: 'fixture_only',
    async put({ documentId, bytes }) {
      const storageKey = `fixture:${documentId}`;
      records.set(storageKey, Buffer.from(bytes));
      return storageKey;
    },
    async read({ storageKey }) {
      const value = records.get(storageKey);
      if (!value) throw new DocumentIntakeError('DOCUMENT_BYTES_NOT_FOUND', 'Fixture document bytes were not found.');
      return Buffer.from(value);
    },
    async remove({ storageKey }) {
      records.delete(storageKey);
    },
  });
}
