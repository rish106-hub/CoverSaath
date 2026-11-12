import { readBody } from '../http/request.js';

// Holding document links (two-document holdings, migration 065). Off unless HOLDINGS_ENABLED is exactly "true" (503 HOLDINGS_DISABLED).
// Owner adult only: a missing holding, another household's holding and a household member who is not the owner all answer the same 404
// HOLDING_NOT_FOUND. A document that is missing, withdrawn or of another household answers DOCUMENT_NOT_FOUND (404). No model call.
//
//   GET    /api/v1/holdings/{id}/documents                 -> 200 { holdingId, documents: [{ documentId, kind }] }
//   POST   /api/v1/holdings/{id}/documents                 body { documentId, kind: wording | endorsement | other }
//                                                          -> 200 { holdingId, documentId, kind, linked } (linked false on a repeat)
//   DELETE /api/v1/holdings/{id}/documents/{documentId}    -> 200 { holdingId, documentId, unlinked }; the chunks it fed are deleted
// One policy, one holding: linking absorbs the linked document's own standalone holding (never acted on: deleted with its derived data, one
// transaction) or answers 409 HOLDING_DOCUMENT_HAS_HOLDING when the owner already acted on it. Unlinking does not recreate it.
// Linking queues memorise: the linked document's clauses are derived and embedded for this holding, so chat can cite its wording with
// the page. Unlinking deletes those chunks. Both ends must belong to the holding's household.

const LIST_OR_LINK = /^\/api\/v1\/holdings\/([^/]+)\/documents$/;
const UNLINK = /^\/api\/v1\/holdings\/([^/]+)\/documents\/([^/]+)$/;
const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const KINDS = ['wording', 'endorsement', 'other'];

const notFound = () => Object.assign(new Error('The holding was not found.'), { code: 'HOLDING_NOT_FOUND', statusCode: 404 });
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_REQUEST', statusCode: 400 });

/** Returns a response for a holding-documents route, or null when the path is not one. */
export async function handleHoldingDocumentsRoute({ req, url, principal, services }) {
  const listOrLink = LIST_OR_LINK.exec(url.pathname);
  const unlink = UNLINK.exec(url.pathname);
  const isList = listOrLink && req.method === 'GET';
  const isLink = listOrLink && req.method === 'POST';
  const isUnlink = unlink && req.method === 'DELETE';
  if (!isList && !isLink && !isUnlink) return null;
  if (!services.holdings.enabled()) throw Object.assign(new Error('Holdings are disabled.'), { code: 'HOLDINGS_DISABLED', statusCode: 503 });
  const holdingId = (listOrLink ?? unlink)[1];
  if (!ID.test(holdingId)) throw notFound();
  const householdId = await services.holdingPipelineRepository.householdOfHolding(holdingId);
  if (!householdId) throw notFound();
  const roles = await services.households.listActiveRoles(householdId, principal.adultId);
  if (!roles.some(item => item.role === 'owner')) throw notFound();
  const holding = await services.holdingPipelineRepository.getHolding({ householdId, holdingId });
  if (!holding) throw notFound();
  if (isList) return { status: 200, body: await services.holdings.linkedDocuments({ holding }) };
  if (isUnlink) {
    if (!ID.test(unlink[2])) throw Object.assign(new Error('The document was not found.'), { code: 'DOCUMENT_NOT_FOUND', statusCode: 404 });
    return { status: 200, body: await services.holdings.unlinkDocument({ holding, documentId: unlink[2] }) };
  }
  const body = await readBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('The request must be an object.');
  for (const key of Object.keys(body)) if (!['documentId', 'kind'].includes(key)) throw invalid('The request has an unknown field.');
  if (typeof body.documentId !== 'string' || !ID.test(body.documentId)) throw invalid('documentId is required.');
  if (!KINDS.includes(body.kind ?? 'wording')) throw invalid('kind is invalid.');
  return { status: 200, body: await services.holdings.linkDocument({ holding, documentId: body.documentId, kind: body.kind ?? 'wording' }) };
}
