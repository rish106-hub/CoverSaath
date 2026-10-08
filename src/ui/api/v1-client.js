// Knowvia v1 API client. Every call goes to /api/v1. The session token lives in this closure only.

export class ApiError extends Error {
  constructor({ status = 0, code = 'REQUEST_FAILED', message, kind }) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.kind = kind ?? classifyError(status, code);
  }
}

export function classifyError(status, code) {
  if (status === 0) return 'network';
  if (status === 401) return 'auth';
  if (status === 402 || code === 'BREAKDOWN_BUDGET_EXHAUSTED') return 'budget';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'server';
  if (status === 403 || status === 404 || status === 409) return 'rejected';
  return 'validation';
}

export function createV1Client({ fetchImpl = (...args) => fetch(...args) } = {}) {
  let sessionToken = null;

  async function request(path, { method = 'GET', body, token = sessionToken, idempotencyKey } = {}) {
    let response;
    try {
      response = await fetchImpl(`/api/v1${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError({ status: 0, code: 'NETWORK_ERROR', message: 'Knowvia could not be reached. Check your connection and try again.' });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError({
        status: response.status,
        code: payload?.error?.code ?? 'REQUEST_FAILED',
        message: payload?.error?.message ?? payload?.message ?? `Request failed (${response.status}).`,
      });
    }
    return payload;
  }

  const id = value => encodeURIComponent(value);

  return Object.freeze({
    setSessionToken(value) {
      sessionToken = typeof value === 'string' && value.trim() ? value.trim() : null;
    },
    hasSession: () => sessionToken !== null,
    bootstrapHousehold({ bootstrapToken, displayName, ownerName }) {
      return request('/households', { method: 'POST', token: bootstrapToken, body: { displayName, owner: { displayName: ownerName } } });
    },
    householdMatrix: householdId => request(`/households/${id(householdId)}`),
    addMember: (householdId, body) => request(`/households/${id(householdId)}/members`, { method: 'POST', body }),
    setCity: (householdId, city) => request(`/households/${id(householdId)}/city`, { method: 'PATCH', body: { city } }),
    grantConsent: body => request('/consents', { method: 'POST', body }),
    revokeConsent: (grantId, reason) => request(`/consents/${id(grantId)}/revoke`, { method: 'POST', body: { reason } }),
    uploadDocument: (householdId, body) => request(`/households/${id(householdId)}/documents`, { method: 'POST', body }),
    listDocuments: householdId => request(`/households/${id(householdId)}/documents`),
    createPolicyRecord: (householdId, body, idempotencyKey) =>
      request(`/households/${id(householdId)}/policy-records`, { method: 'POST', body, idempotencyKey }),
    listPolicyRecords: householdId => request(`/households/${id(householdId)}/policy-records`),
    breakdownJob: jobId => request(`/breakdown-jobs/${id(jobId)}`),
    resumeBreakdownJob: jobId => request(`/breakdown-jobs/${id(jobId)}/resume`, { method: 'POST', body: {} }),
    policyRecord: recordId => request(`/policy-records/${id(recordId)}`),
    sections: recordId => request(`/policy-records/${id(recordId)}/sections`),
    reviewParameter: (recordId, key, body) => request(`/policy-records/${id(recordId)}/parameters/${id(key)}/review`, { method: 'POST', body }),
    checkReadiness: recordId => request(`/policy-records/${id(recordId)}/readiness`, { method: 'POST', body: {} }),
    emergencyCard: recordId => request(`/policy-records/${id(recordId)}/emergency-card`),
    procedureCheck: (recordId, body) => request(`/policy-records/${id(recordId)}/procedure-checks`, { method: 'POST', body }),
    estimate: (recordId, body) => request(`/policy-records/${id(recordId)}/estimates`, { method: 'POST', body }),
    policyStatus: recordId => request(`/policy-records/${id(recordId)}/policy-status`),
    revokeSession: () => request('/sessions/current/revoke', { method: 'POST', body: {} }),
  });
}
