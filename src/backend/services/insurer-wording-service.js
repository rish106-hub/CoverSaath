import { clearsRelevanceFloor } from '../../features/insurance-rules/clause-answer.js';
import { containsContactValue, containsIdentifier } from '../../features/chat-answer-guard/index.js';
import { insurerPackLines, readInsurerPack } from './policy-evidence-service.js';

// Insurer wording for chat v1 (ADR 0039 D9): lines of the cached FSS pack pages of the version a holding is linked to (holding_fss_links), for a
// question the person's own documents did not answer. Read only, deterministic, no model, nothing stored, never embedded and never put into
// memory_chunks (migration 053 keeps own_pdf only). Every line is the RAW cached pack text (a quote cut from it is exact against the pack), kept
// only when it clears the question's relevance floor and holds no contact value, identifier or identity label (the passages route's filters).
// The caller labels it by tier ("From the insurer's wording, not checked", FOR LEGAL REVIEW) and never calls it the household's own document.
//
// Scope: household and holding. The link must be of this household, the holding must exist in it, and its document must still be readable
// (current document_processing grant); a revoked household has no holding, no link and no cached facts left to read through.

const MAX_HOLDINGS = 5;
const LINE_MAX = 600;

export function createInsurerWording({ fssHandoffs, referenceCache, holdingRepository }) {
  for (const [name, dependency] of Object.entries({ fssHandoffs, referenceCache, holdingRepository })) if (!dependency) throw new TypeError(`${name} is required.`);

  return Object.freeze({
    /** [{ chunkId, versionId, holdingId, page, line }] for the question, at most `limit`, best effort. Never throws for a missing link, pack or line. */
    async linesFor({ householdId, holdingIds, question, limit = 2 }) {
      const found = [];
      if (typeof householdId !== 'string' || !Array.isArray(holdingIds) || typeof question !== 'string' || !(limit > 0)) return found;
      for (const holdingId of holdingIds.slice(0, MAX_HOLDINGS)) {
        const link = await fssHandoffs.linkFor(holdingId);
        if (!link || link.householdId !== householdId || !link.versionId) continue;
        const holding = await holdingRepository.getHolding({ householdId, holdingId });
        if (!holding?.documentId) continue;
        const readable = await holdingRepository.readableDocuments({ householdId, documentIds: [holding.documentId] });
        if (!readable.has(holding.documentId)) continue;
        const body = await readInsurerPack({ referenceCache, versionId: link.versionId });
        if (!body) continue;
        const match = line => line.length >= 20 && line.length <= LINE_MAX && clearsRelevanceFloor(question, line) && !containsContactValue(line) && !containsIdentifier(line);
        for (const hit of insurerPackLines({ body, match, limit: limit - found.length })) {
          if (!found.some(item => item.chunkId === hit.chunkId && item.line === hit.line)) found.push({ chunkId: hit.chunkId, versionId: link.versionId, holdingId, page: hit.page, line: hit.line });
        }
        if (found.length >= limit) break;
      }
      return found;
    },
  });
}
