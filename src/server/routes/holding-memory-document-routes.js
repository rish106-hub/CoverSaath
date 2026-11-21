// The owner's private memory document (target flow step 12-13). Rendered on demand from sealed rows; nothing is stored (see
// services/memory-document.js). Off unless HOLDINGS_ENABLED and MEMORY_ENABLED are exactly "true" (503 HOLDINGS_DISABLED / MEMORY_DISABLED).
//
//   GET /api/v1/holdings/{id}/memory-document                 200 text/markdown; charset=utf-8, cache-control: no-store
//   GET /api/v1/holdings/{id}/memory-document?format=json    200 { sections: [{ key, title, markdown }] } (JSON)
//     the same renderer; `format` other than json or markdown is 400 INVALID_REQUEST
//
// Owner adult only: a missing holding, another household's holding and a household member who is not the owner all answer the same 404
// HOLDING_NOT_FOUND. A withdrawn document-processing consent answers 403 CONSENT_REQUIRED. No model call unless POLICY_DOC_PROSE_ENABLED is exactly
// "true" (ADR 0039: only fact sentences, guarded line by line, deterministic text on any failure). The text is FOR the owner:
// the chat path must run it through the privacy gate before any model reads it. Reader-facing wording in it is FOR LEGAL REVIEW.
const MEMORY_DOCUMENT = /^\/api\/v1\/holdings\/([^/]+)\/memory-document$/;

/** Returns a response for the memory-document route, or null when the path is not it. */
export async function handleHoldingMemoryDocumentRoute({ req, url, principal, services }) {
  const match = req.method === 'GET' ? MEMORY_DOCUMENT.exec(url.pathname) : null;
  if (!match) return null;
  const format = url.searchParams.get('format');
  if (format !== null && format !== 'json' && format !== 'markdown') throw Object.assign(new Error('format must be json or markdown.'), { code: 'INVALID_REQUEST', statusCode: 400 });
  if (format === 'json') return { status: 200, body: await services.memoryDocument.renderSections({ holdingId: match[1], adultId: principal.adultId }) };
  // ADR 0039: with POLICY_DOC_PROSE_ENABLED the owner may get a reworded version; any failure serves the deterministic render. Never stored.
  const { text } = await services.memoryDocument.renderWithProse({ holdingId: match[1], adultId: principal.adultId });
  return { status: 200, contentType: 'text/markdown; charset=utf-8', cacheControl: 'no-store', text };
}
