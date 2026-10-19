function requestError(response, payload) {
  const error = new Error(payload?.error?.message ?? payload?.message ?? `Request failed (${response.status}).`);
  const code = payload?.error?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) error.code = code;
  error.status = response.status;
  return error;
}

export function createV1Client({ fetchImpl = fetch, xhrFactory = () => new XMLHttpRequest() } = {}) {
  let sessionToken = null;

  async function request(path, { method = 'GET', body, token = sessionToken, idempotencyKey } = {}) {
    const response = await fetchImpl(`/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw requestError(response, payload);
    return payload;
  }

  return Object.freeze({
    setSessionToken(value) {
      sessionToken = typeof value === 'string' && value.trim() ? value.trim() : null;
    },
    bootstrapHousehold({ bootstrapToken, displayName, ownerName }) {
      return request('/households', {
        method: 'POST',
        token: bootstrapToken,
        body: { displayName, owner: { displayName: ownerName } },
      });
    },
    householdMatrix(householdId) { return request(`/households/${encodeURIComponent(householdId)}`); },
    createCase(body) { return request('/cases', { method: 'POST', body }); },
    transitionCase(caseId, body) { return request(`/cases/${encodeURIComponent(caseId)}/transitions`, { method: 'POST', body }); },
    grantConsent(body) { return request('/consents', { method: 'POST', body }); },
    revokeConsent(grantId, reason) { return request(`/consents/${encodeURIComponent(grantId)}/revoke`, { method: 'POST', body: { reason } }); },
    startAnalysis(caseId, consentGrantId, key) {
      return request(`/cases/${encodeURIComponent(caseId)}/analysis-runs`, {
        method: 'POST',
        idempotencyKey: key,
        body: { consentGrantId, executionMode: 'fixture' },
      });
    },
    job(runId) { return request(`/jobs/${encodeURIComponent(runId)}`); },
    sourcePack(caseId) { return request(`/cases/${encodeURIComponent(caseId)}/source-pack`); },
    listCaseDocuments(caseId) { return request(`/cases/${encodeURIComponent(caseId)}/documents`); },
    listDocumentsForDeletion(caseId) { return request(`/cases/${encodeURIComponent(caseId)}/documents/deletion-inventory`); },
    getDocument(id) { return request(`/documents/${encodeURIComponent(id)}`); },
    deleteDocument(id) { return request(`/documents/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    // Raw binary body (never Base64 or multipart). XHR is used for upload progress.
    // Reuse the same idempotencyKey when retrying the same file.
    uploadDocument({ caseId, file, documentKind, consentGrantId, idempotencyKey, onProgress, signal }) {
      return new Promise((resolve, reject) => {
        const fail = (code, message, status = 0) => reject(Object.assign(new Error(message), { code, status }));
        if (signal?.aborted) return fail('ABORTED', 'Upload cancelled.');
        const xhr = xhrFactory();
        xhr.open('POST', `/api/v1/cases/${encodeURIComponent(caseId)}/documents`);
        const headers = {
          ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
          'Content-Type': 'application/pdf',
          'Idempotency-Key': idempotencyKey,
          'X-Document-Kind': documentKind,
          'X-Consent-Grant-Id': consentGrantId,
          'X-Filename': encodeURIComponent(file.name),
        };
        for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
        if (xhr.upload) xhr.upload.onprogress = event => {
          if (event.lengthComputable && typeof onProgress === 'function') onProgress(event.loaded, event.total);
        };
        xhr.onload = () => {
          let payload = {};
          try { payload = JSON.parse(xhr.responseText || '{}'); } catch { /* non-JSON error body */ }
          if (xhr.status === 200 || xhr.status === 201) resolve(payload);
          else fail(payload?.error?.code ?? 'UPLOAD_FAILED', payload?.error?.message ?? `Upload failed (${xhr.status}).`, xhr.status);
        };
        xhr.onerror = () => fail('NETWORK_ERROR', 'Network error during upload.');
        xhr.onabort = () => fail('ABORTED', 'Upload cancelled.');
        signal?.addEventListener('abort', () => xhr.abort(), { once: true });
        xhr.send(file);
      });
    },
    revokeSession() { return request('/sessions/current/revoke', { method: 'POST', body: {} }); },
  });
}
