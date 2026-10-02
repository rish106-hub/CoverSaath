function requestError(response, payload) {
  return new Error(payload?.error?.message ?? payload?.message ?? `Request failed (${response.status}).`);
}

export function createV1Client({ fetchImpl = fetch } = {}) {
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
    revokeSession() { return request('/sessions/current/revoke', { method: 'POST', body: {} }); },
  });
}
