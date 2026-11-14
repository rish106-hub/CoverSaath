import { readBody } from '../http/request.js';

// Holding product routes (S-A3; the read-only holdings lists live in holdings-routes.js). Off unless HOLDINGS_ENABLED is exactly "true". Owner adult only: a missing holding, another
// household's holding and a household member who is not the owner all answer the same 404 (HOLDING_NOT_FOUND).
//
//   GET  /api/v1/holdings/{id}/product-candidates   -> 200 { holdingId, profileVersion, candidates: [{ candidateId, insurerName, productName, rank }] }
//   POST /api/v1/holdings/{id}/confirm-product      body { candidateId, expectedVersion } (expectedVersion = profileVersion from the candidates read), header Idempotency-Key
//                                                   -> 200 { holdingId, status, profileVersion, replay }
//   GET  /api/v1/holdings/{id}/product-search?q=    -> 200 { holdingId, candidates: [same shape] } from the cached registry; the fragment
//                                                   (2 to 80 characters, at most 8 words) is never logged or sent anywhere
// The UIN is service-only: it is resolved from the registry on the server, written to policy_profiles, and is in no response.
// The owner's pick is their own statement (state 'reported'), never 'proven'.

const CANDIDATES = /^\/api\/v1\/holdings\/([^/]+)\/product-candidates$/;
const CONFIRM = /^\/api\/v1\/holdings\/([^/]+)\/confirm-product$/;
const SEARCH = /^\/api\/v1\/holdings\/([^/]+)\/product-search$/;
const NOT_FOUND_CODES = ['DOCUMENT_NOT_FOUND', 'HOUSEHOLD_WRITE_FORBIDDEN', 'HOUSEHOLD_NOT_FOUND', 'CASE_NOT_FOUND', 'HOLDING_INVALID'];

/** Resolves a response, or null when the path is not a holdings route. Errors propagate to the caller's error mapper. */
export async function handleHoldingProductRoute({ req, url, principal, services, requireOwnedDocument, documentUploads, idempotencyKey }) {
  const candidatesMatch = req.method === 'GET' ? CANDIDATES.exec(url.pathname) : null;
  const confirmMatch = req.method === 'POST' ? CONFIRM.exec(url.pathname) : null;
  const searchMatch = req.method === 'GET' ? SEARCH.exec(url.pathname) : null;
  const match = candidatesMatch ?? confirmMatch ?? searchMatch;
  if (!match) return null;
  const holdingsService = services.holdingProducts;
  if (!holdingsService.enabled()) throw Object.assign(new Error('Holdings are disabled.'), { code: 'HOLDINGS_DISABLED', statusCode: 503 });
  const notFound = () => Object.assign(new Error('Holding was not found.'), { code: 'HOLDING_NOT_FOUND', statusCode: 404 });
  let holding;
  let document;
  try {
    holding = await services.holdingProductRepository.get(match[1]);
    if (!holding) throw notFound();
    document = await requireOwnedDocument({ services, documentUploads, principal, documentId: holding.documentId, write: Boolean(confirmMatch) });
    if (document.householdId !== holding.householdId) throw notFound();
    const roles = await services.households.listActiveRoles(holding.householdId, principal.adultId);
    if (!roles.some(item => item.role === 'owner')) throw notFound();
  } catch (error) {
    if (NOT_FOUND_CODES.includes(error?.code)) throw notFound();
    throw error;
  }
  if (searchMatch) return { status: 200, body: await holdingsService.searchProducts({ holding, q: url.searchParams.get('q') }) };
  if (candidatesMatch) return { status: 200, body: await holdingsService.candidates({ holding, document, adultUserId: principal.adultId }) };
  const confirmed = await holdingsService.confirmProduct({ holding, document, adultUserId: principal.adultId, body: await readBody(req), idempotencyKey: idempotencyKey(req) });
  // Product analytics (ADR 0033): a first confirmation only (a replay adds nothing). The pick is always from the candidate list on this route.
  if (!confirmed.replay) void services.analytics?.track({ householdId: holding.householdId, event: 'insurer_confirmed', properties: { manual: false } });
  return { status: 200, body: confirmed };
}
