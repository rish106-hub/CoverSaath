import { clone, DocumentIntakeError } from './contracts.js';

export function createMemoryDocumentRepository({ consents = [] } = {}) {
  const consentRecords = new Map(consents.map(value => [value.id, clone(value)]));
  const documents = new Map();
  return Object.freeze({
    async getConsent(id) {
      return consentRecords.has(id) ? clone(consentRecords.get(id)) : null;
    },
    async findByHash(householdId, contentSha256) {
      const match = [...documents.values()].find(item => item.householdId === householdId && item.contentSha256 === contentSha256 && item.lifecycleState !== 'deleted');
      return match ? clone(match) : null;
    },
    async findVersion(householdId, logicalDocumentId, version) {
      const match = [...documents.values()].find(item => item.householdId === householdId && item.logicalDocumentId === logicalDocumentId && item.version === version);
      return match ? clone(match) : null;
    },
    async createDocument(document) {
      if (documents.has(document.id)) throw new DocumentIntakeError('DOCUMENT_EXISTS', 'The document already exists.');
      documents.set(document.id, clone(document));
      return clone(document);
    },
    async getDocument(id) {
      return documents.has(id) ? clone(documents.get(id)) : null;
    },
    async updateDocument(id, updater) {
      const current = documents.get(id);
      if (!current) return null;
      const next = typeof updater === 'function' ? updater(clone(current)) : { ...current, ...clone(updater) };
      for (const immutable of ['id', 'householdId', 'caseId', 'uploadedByAdultId', 'consentGrantId', 'logicalDocumentId', 'version', 'contentSha256']) {
        if (JSON.stringify(next[immutable]) !== JSON.stringify(current[immutable])) {
          throw new DocumentIntakeError('IMMUTABLE_DOCUMENT_VERSION', `Document field ${immutable} is immutable.`);
        }
      }
      documents.set(id, clone(next));
      return clone(next);
    },
  });
}
