import { readBody } from '../http/request.js';

// Holdings routes (complete.md 3.2 steps 4-5). Off unless HOLDINGS_ENABLED is exactly "true" (503 HOLDINGS_DISABLED). Owner adult only:
// a missing holding, another household's holding and a household member who is not the owner all answer the same 404
// HOLDING_NOT_FOUND. Values are opened only for the owning household's own response. No UIN, cache key or reference locator is ever
// in a body. No model call.
//
//   GET  /api/v1/holdings/{id}/facts                        resolved facts with their sources and alternatives
//   GET  /api/v1/holdings/{id}/conflicts                    every conflict of the holding (pending and closed)
//   POST /api/v1/holdings/{id}/conflicts/{cid}/resolve      body { chosenFactId, alternativeIndex? }: the owner's choice
//
// A resolution is stored as a new user_declaration row (capture_method conflict_resolution, status user_confirmed); the machine
// readings stay. Wording shown to the owner around a choice on a product term (check with the insurer) is FOR LEGAL REVIEW.

const FACTS = /^\/api\/v1\/holdings\/([^/]+)\/facts$/;
const CONFLICTS = /^\/api\/v1\/holdings\/([^/]+)\/conflicts$/;
const RESOLVE = /^\/api\/v1\/holdings\/([^/]+)\/conflicts\/([^/]+)\/resolve$/;
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;

const notFound = () => Object.assign(new Error('The holding was not found.'), { code: 'HOLDING_NOT_FOUND', statusCode: 404 });

// The holding is looked up by id, then the caller must hold the owner role in ITS household (ownership on every read and write).
async function requireOwnedHolding({ services, principal, holdingId }) {
  if (!ID.test(holdingId)) throw notFound();
  const householdId = await services.holdingPipelineRepository.householdOfHolding(holdingId);
  if (!householdId) throw notFound();
  const roles = await services.households.listActiveRoles(householdId, principal.adultId);
  if (!roles.some(item => item.role === 'owner')) throw notFound();
  const holding = await services.holdingPipelineRepository.getHolding({ householdId, holdingId });
  if (!holding) throw notFound();
  return holding;
}

/** Returns a response for a holdings route, or null when the path is not one. */
export async function handleHoldingsRoute({ req, url, principal, services }) {
  const facts = url.pathname.match(FACTS);
  const conflicts = url.pathname.match(CONFLICTS);
  const resolve = url.pathname.match(RESOLVE);
  if (!((facts || conflicts) && req.method === 'GET') && !(resolve && req.method === 'POST')) return null;
  if (!services.holdings.enabled()) throw Object.assign(new Error('Holdings are disabled.'), { code: 'HOLDINGS_DISABLED', statusCode: 503 });
  const holdingId = (facts ?? conflicts ?? resolve)[1];
  const holding = await requireOwnedHolding({ services, principal, holdingId });
  if (facts) return { status: 200, body: await services.holdings.facts({ holding }) };
  if (conflicts) return { status: 200, body: await services.holdings.conflicts({ holding }) };
  if (!ID.test(resolve[2])) throw Object.assign(new Error('The conflict was not found.'), { code: 'MEMORY_CONFLICT_NOT_FOUND', statusCode: 404 });
  return { status: 200, body: await services.holdings.resolveConflict({ holding, conflictId: resolve[2], adultId: principal.adultId, body: await readBody(req) }) };
}
