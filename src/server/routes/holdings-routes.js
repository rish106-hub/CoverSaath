// Holdings routes (ADR 0032). Off unless HOLDINGS_ENABLED is exactly "true" (the same answer as an unknown route while off). A stub
// slice: read-only lists, enough to prove ownership at the server boundary. Ownership is checked inside the repository: a foreign or
// missing household is the same 404. Bodies carry ids, closed enums and counts, never a sealed value.
//
//   GET /api/v1/households/{id}/holdings
//   GET /api/v1/households/{id}/holdings/{holdingId}

const HOLDINGS = /^\/api\/v1\/households\/([^/]+)\/holdings(?:\/([^/]+))?$/;

/** Resolves a response, or null when the path is not a holdings route (or the flag is off). Errors propagate to the caller's error mapper. */
export async function handleHoldingsRoute({ req, url, principal, services }) {
  const match = req.method === 'GET' ? HOLDINGS.exec(url.pathname) : null;
  if (!match || !services.holdingsEnabled()) return null;
  const [, householdId, holdingId] = match;
  if (holdingId) return { status: 200, body: await services.policyHoldings.get({ householdId, adultId: principal.adultId, holdingId }) };
  return { status: 200, body: { holdings: await services.policyHoldings.list({ householdId, adultId: principal.adultId }) } };
}
