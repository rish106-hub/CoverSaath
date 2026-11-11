// Network hospital lookup (S-C2). Off unless HOLDINGS_ENABLED is exactly "true" (503 HOLDINGS_DISABLED while off).
//   GET /api/v1/holdings/{id}/hospitals?pincode=560001 -> 200 { hospitals: [{ id, name, address, city, pincode, cashless }] }
// Ownership: a missing holding and another household's holding answer the same 404. A pincode that is not exactly 6 digits is a coded 400.
// The insurer comes from the holding's confirmed policy profile, never the request. With none confirmed: 200 { hospitals: [], reason: 'insurer_unknown' }.
// Public directory data only; no UIN, insurer id or household field is in the body.
const HOSPITALS = /^\/api\/v1\/holdings\/([^/]+)\/hospitals$/;

/** Resolves a response, or null when the path is not this route. Errors propagate to the caller's error mapper. */
export async function handleHoldingHospitalsRoute({ req, url, principal, services }) {
  const match = req.method === 'GET' ? HOSPITALS.exec(url.pathname) : null;
  if (!match) return null;
  const pincode = url.searchParams.get('pincode') ?? '';
  return { status: 200, body: await services.networkHospitals.list({ holdingId: match[1], adultId: principal.adultId, pincode }) };
}
