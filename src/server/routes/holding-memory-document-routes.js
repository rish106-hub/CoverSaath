// The owner's private memory document (target flow step 12-13). Rendered on demand from sealed rows; nothing is stored (see
// services/memory-document.js). Off unless HOLDINGS_ENABLED and MEMORY_ENABLED are exactly "true" (503 HOLDINGS_DISABLED / MEMORY_DISABLED).
//
//   GET /api/v1/holdings/{id}/memory-document   200 text/markdown; charset=utf-8, cache-control: no-store
//
// Owner adult only: a missing holding, another household's holding and a household member who is not the owner all answer the same 404
// HOLDING_NOT_FOUND. A withdrawn document-processing consent answers 403 CONSENT_REQUIRED. No model call. The text is FOR the owner:
// the chat path must run it through the privacy gate before any model reads it. Reader-facing wording in it is FOR LEGAL REVIEW.
const MEMORY_DOCUMENT = /^\/api\/v1\/holdings\/([^/]+)\/memory-document$/;

/** Returns a response for the memory-document route, or null when the path is not it. */
export async function handleHoldingMemoryDocumentRoute({ req, url, principal, services }) {
  const match = req.method === 'GET' ? MEMORY_DOCUMENT.exec(url.pathname) : null;
  if (!match) return null;
  const text = await services.memoryDocument.render({ holdingId: match[1], adultId: principal.adultId });
  return { status: 200, contentType: 'text/markdown; charset=utf-8', cacheControl: 'no-store', text };
}
