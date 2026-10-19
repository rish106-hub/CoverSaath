export const DOCUMENT_KINDS = Object.freeze([
  'policy_wording',
  'policy_schedule',
  'endorsement',
  'member_card',
  'employer_benefit_booklet',
  'hospital_estimate',
  'medical_record',
  'identity_record',
  'other',
]);

export const MALWARE_STATUSES = Object.freeze(['pending', 'clean', 'blocked', 'not_scanned_fixture']);
export const LIFECYCLE_STATES = Object.freeze(['quarantined', 'active', 'deletion_requested', 'deleted']);
export const ALLOWED_MIME_TYPES = Object.freeze(['application/pdf', 'image/jpeg', 'image/png']);
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export class DocumentIntakeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DocumentIntakeError';
    this.code = code;
  }
}

export function assertDocumentRepository(repository) {
  const methods = ['getConsent', 'findByHash', 'findVersion', 'createDocument', 'getDocument', 'updateDocument'];
  if (!repository || methods.some(method => typeof repository[method] !== 'function')) {
    throw new TypeError(`Document repository must implement: ${methods.join(', ')}.`);
  }
  return repository;
}

export function assertByteStorage(storage, mode) {
  const methods = ['put', 'read', 'remove'];
  if (!storage || methods.some(method => typeof storage[method] !== 'function')) {
    throw new TypeError(`Document byte storage must implement: ${methods.join(', ')}.`);
  }
  if (mode === 'live' && (storage.mode !== 'live' || storage.protection !== 'authenticated_encryption')) {
    throw new DocumentIntakeError('ENCRYPTED_STORAGE_REQUIRED', 'Live intake requires authenticated encrypted byte storage.');
  }
  if (mode === 'fixture' && storage.mode !== 'fixture') {
    throw new DocumentIntakeError('FIXTURE_STORAGE_REQUIRED', 'Fixture intake requires explicitly fixture-only byte storage.');
  }
  return storage;
}

export function clone(value) {
  return structuredClone(value);
}
