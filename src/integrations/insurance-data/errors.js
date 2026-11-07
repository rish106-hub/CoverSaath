// Coded, client-safe errors for the reference-data connector. Messages never carry upstream text, URLs or keys.
export class ReferenceDataError extends Error {
  constructor(code, message, { retryable = false, statusCode = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ReferenceDataError';
    this.code = code;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

export const referenceError = (code, message, options) => new ReferenceDataError(code, message, options);

export function errorForStatus(status, retryAfterMs = null) {
  if (status === 401 || status === 403) return referenceError('REFERENCE_DATA_AUTH_FAILED', 'Reference data service rejected the server credential.', { statusCode: 503 });
  if (status === 404) return referenceError('REFERENCE_DATA_NOT_FOUND', 'Reference data was not found.', { statusCode: 404 });
  if (status === 429) return referenceError('REFERENCE_DATA_RATE_LIMITED', 'Reference data service rate limit reached.', { retryable: true, statusCode: 503, retryAfterMs });
  if (status === 400) return referenceError('REFERENCE_DATA_REQUEST_REJECTED', 'Reference data service rejected the request.', { statusCode: 502 });
  return referenceError('REFERENCE_DATA_UNAVAILABLE', 'Reference data is unavailable.', { retryable: true, statusCode: 503 });
}
