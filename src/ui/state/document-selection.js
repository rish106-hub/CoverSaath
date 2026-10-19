// Pure client-side validation and copy for household document upload. No DOM.
// The server remains the authority; these checks only give early, plain feedback.

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
export const MAX_FILES_PER_BATCH = 10;

export const DOCUMENT_KINDS = Object.freeze([
  ['policy_wording', 'Policy wording'],
  ['policy_schedule', 'Policy schedule'],
  ['endorsement', 'Endorsement'],
]);

export const ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: 'The upload request was not valid. Check the document type and try again.',
  IDEMPOTENCY_KEY_REQUIRED: 'The upload could not be tracked safely. Remove the file and add it again.',
  CONSENT_REQUIRED: 'Document consent is needed before uploading. Check the consent ID.',
  CONSENT_SCOPE_REQUIRED: 'This consent does not cover document upload for this case.',
  FIELD_ACCESS_REQUIRED: 'This consent does not allow showing documents for this case.',
  CASE_NOT_FOUND: 'We could not find this case in your household.',
  DUPLICATE_DOCUMENT: 'This document was already uploaded to this case.',
  IDEMPOTENCY_CONFLICT: 'This upload key was already used for a different file. Remove the file and add it again.',
  REQUEST_TOO_LARGE: 'This file is too large. The limit is 15 MB.',
  UNSUPPORTED_MEDIA_TYPE: 'Only PDF files are supported.',
  MIME_MISMATCH: 'This file does not look like a real PDF. Upload the original PDF.',
  EXTENSION_MISMATCH: 'The file name does not match a PDF. Use a file ending in .pdf.',
  EMPTY_FILE: 'This file is empty.',
  PDF_STRUCTURE_INVALID: 'This PDF appears damaged. Upload a fresh copy.',
  PDF_PASSWORD_REQUIRED: 'This PDF is password-protected. Upload an unlocked copy.',
  PDF_ACTIVE_CONTENT: 'This PDF contains scripts or embedded content we cannot accept. Upload a plain copy.',
  PDF_PAGE_LIMIT: 'This PDF has too many pages. Upload a shorter document.',
  PDF_RESOURCE_LIMIT: 'This PDF is too complex to check. Upload a simpler copy.',
  PDF_UNSUPPORTED_ENCODING: 'This PDF uses an encoding we cannot read. Re-save it as a standard PDF.',
  UPLOAD_CAPACITY_REACHED: 'Uploads are busy right now. Try again in a few minutes.',
  DOCUMENT_STORAGE_NOT_CONFIGURED: 'Document storage is not available yet. Nothing was saved.',
  DOCUMENT_DELETE_FORBIDDEN: 'Only the uploader or a household operator can delete this document.',
  DOCUMENT_DELETE_CONFLICT: 'The document changed while deletion was requested. Refresh and try again.',
  DOCUMENT_NOT_FOUND: 'This document is no longer available.',
  AUTHENTICATION_REQUIRED: 'Your session has ended. Reconnect your workspace and try again.',
});

export const FALLBACK_ERROR = 'The upload failed. Try again.';
export const NETWORK_ERROR = 'The connection was lost. Nothing is confirmed; retry the upload.';
export const ABORTED_MESSAGE = 'Upload cancelled.';

export function messageForErrorCode(code) {
  if (code === 'NETWORK_ERROR') return NETWORK_ERROR;
  if (code === 'ABORTED') return ABORTED_MESSAGE;
  return Object.prototype.hasOwnProperty.call(ERROR_MESSAGES, code) ? ERROR_MESSAGES[code] : FALLBACK_ERROR;
}

// Status labels. A fresh upload must never read as "processed" or "accepted".
export const STATUS_LABELS = Object.freeze({
  received_pending_checks: 'Received, waiting for security checks',
  accepted: 'Passed security checks',
  rejected: 'Rejected',
  deletion_pending: 'Being deleted',
  deleted: 'Deleted',
});

export function statusLabel(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_LABELS, status) ? STATUS_LABELS[status] : 'Status unknown';
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const selectionKey = file => `${file.name}|${file.size}|${file.lastModified ?? 0}`;

/**
 * @param files File-like objects { name, size, type, lastModified }
 * @param existing File-like objects already in the queue (counted toward the batch limit and duplicates)
 * @returns one result per file, in order: { file, key, ok, errors[], warnings[] }
 */
export function validateSelection(files, existing = []) {
  const seen = new Set(existing.map(selectionKey));
  let count = existing.length;
  return Array.from(files, file => {
    const errors = [];
    const warnings = [];
    const key = selectionKey(file);
    const name = typeof file.name === 'string' ? file.name : '';
    const type = typeof file.type === 'string' ? file.type : '';
    const hasPdfExtension = /\.pdf$/i.test(name);
    if (!hasPdfExtension) errors.push({ code: 'NOT_PDF_EXTENSION', message: 'Only files ending in .pdf are supported.' });
    if (type && type.toLowerCase() !== 'application/pdf') errors.push({ code: 'NOT_PDF_TYPE', message: 'Only PDF files are supported.' });
    if (!type && hasPdfExtension) warnings.push({ code: 'TYPE_UNKNOWN', message: 'Type unknown, server will verify.' });
    if (!Number.isFinite(file.size) || file.size <= 0) errors.push({ code: 'EMPTY_FILE', message: ERROR_MESSAGES.EMPTY_FILE });
    else if (file.size > MAX_FILE_BYTES) errors.push({ code: 'FILE_TOO_LARGE', message: ERROR_MESSAGES.REQUEST_TOO_LARGE });
    if (seen.has(key)) {
      errors.push({ code: 'DUPLICATE_SELECTION', message: 'Already selected. It will not be uploaded twice.' });
      warnings.push({ code: 'DUPLICATE_SELECTION', message: 'Already selected. It will not be uploaded twice.' });
    } else if (errors.length === 0) {
      if (count >= MAX_FILES_PER_BATCH) errors.push({ code: 'BATCH_LIMIT', message: `You can upload at most ${MAX_FILES_PER_BATCH} files at a time.` });
      else count += 1;
    }
    if (errors.length === 0) seen.add(key);
    return { file, key, ok: errors.length === 0, errors, warnings };
  });
}
