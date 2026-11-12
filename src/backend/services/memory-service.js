import { createHash } from 'node:crypto';
import { getPolicyFactKey } from '../../contracts/policy-facts.js';
import { buildClauses } from '../../features/policy-evidence/index.js';
import { resolveSlot } from '../../features/insurance-rules/collate.js';
import { formatFactValue } from '../../features/insurance-rules/fact-format.js';
import { gateTextForHousehold, sealModelInput } from '../../features/ai-analysis/privacy-evidence-gate.js';

// Memory (complete.md 3.2 step 6, ADR 0031): embeds a holding's confirmed facts and own-PDF passages into memory_chunks, and embeds a
// question for retrieval. Off unless MEMORY_ENABLED is exactly "true".
//
//   * Every passage goes through the household privacy gate BEFORE it is embedded and before it is stored: the stored text is the
//     redacted text. Names come from the gate's own loader, never from this file. A passage the gate refuses is skipped and counted.
//   * The embedding is a gateway call (task embed): sealed input only, per-household daily budget, one provider_calls row. With no
//     provider key, a flag off or a spent budget the gateway answers a typed unknown and nothing is written; retrieval then falls back
//     to facts and a keyword match over clauses (chat works on day 1).
//   * Consent is re-checked inside the write transaction (MemoryChunkRepository.replace). A revoked grant writes nothing.
//   * Model output is only a vector here. Nothing a model returns is stored as a fact.
//   * Idempotent: a passage whose redacted text did not change (same sha256) is neither re-embedded nor re-written; a passage that no
//     longer holds (a fact superseded, a clause gone) is deleted.

const memoryEnabled = (env = process.env) => env.MEMORY_ENABLED === 'true';
export { memoryEnabled };

const BATCH = 16;
const MAX_FACT_PASSAGES = 120;
const MAX_CLAUSE_PASSAGES = 80;
const MAX_PASSAGE_CHARS = 1500;
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
const SERVED_STATUSES = new Set(['user_confirmed', 'reviewed_reference']);
const EMBED_SKIPS = new Set(['unknown']);

/** The resolved facts of a holding that may be shown or embedded as confirmed (with includeUnverified, also own-document readings still unverified): [{ factKey, entry, status, value, sourceIds, sourceTier, checkWithInsurer }]. */
export function resolvedConfirmedFacts(memoryRows, { includeUnverified = false } = {}) {
  const bySlot = new Map();
  for (const row of memoryRows) {
    if (row.scopeKey !== '') continue;
    if (!bySlot.has(row.factKey)) bySlot.set(row.factKey, {});
    bySlot.get(row.factKey)[row.tier] = row;
  }
  const view = row => (row ? { id: row.id, status: row.status, value: row.value, alternatives: row.alternatives, captureMethod: row.captureMethod, resolvesFactIds: row.resolvesFactIds } : null);
  const out = [];
  for (const [factKey, tiers] of bySlot) {
    const entry = getPolicyFactKey(factKey);
    if (!entry) continue;
    const resolved = resolveSlot({ factKey, own: view(tiers.own_pdf), ida: view(tiers.ida_wording), declaration: view(tiers.user_declaration) });
    // Chat may also serve a value read from the household's own document (status extracted_unverified, never promoted to confirmed).
    if (!SERVED_STATUSES.has(resolved.status) && !(includeUnverified && resolved.status === 'extracted_unverified')) continue;
    out.push({ factKey, entry, status: resolved.status, value: resolved.value, sourceIds: [...resolved.sourceIds], sourceTier: resolved.sourceTier, checkWithInsurer: resolved.checkWithInsurer });
  }
  return out;
}

export function createMemoryService({ holdingRepository, chunks, clauses, ocr = null, database, gateway = null, loadKnownIdentifiers, providerConsent, env = process.env }) {
  if (!holdingRepository || !chunks) throw new TypeError('A holding repository and a chunk repository are required.');
  if (!providerConsent) throw new TypeError('A provider consent resolver is required.');

  async function gatePassage(text, householdId) {
    try {
      const { gated } = await gateTextForHousehold(text.slice(0, MAX_PASSAGE_CHARS), { householdId, loadKnownIdentifiers });
      return gated;
    } catch (error) {
      if (['RESTRICTED_EVIDENCE', 'EVIDENCE_SOURCE_LIMIT', 'PRIVACY_GATE_MALFORMED'].includes(error?.code)) return null;
      throw error;
    }
  }

  // Clauses are derived deterministically from the stored OCR blocks (the same derivation the read-back routes use); an unread document is skipped.
  async function ensureClauses({ householdId, caseId, documentId }) {
    if (!ocr || typeof clauses.saveClauses !== 'function') return;
    let stored;
    try { stored = await ocr.getDocumentBlockPages({ documentId, householdId }); } catch (error) {
      if (error?.code) return; // no stored pages yet (OCR not complete): nothing to derive, retrieval falls back to what exists
      throw error;
    }
    if (!stored?.complete) return;
    if ((await clauses.clauseDocumentIds({ householdId, caseId })).includes(documentId)) return;
    const { clauses: built } = buildClauses(stored, { documentId, sourceVersion: stored.sourceVersion });
    if (built.length) await clauses.saveClauses({ householdId, caseId, documentId, clauses: built });
  }

  async function embedGated(householdId, gatedTexts) {
    const input = sealModelInput('embed', { payload: { texts: gatedTexts.map(gated => ({ text: gated })) } });
    const result = await gateway.call({ task: 'embed', input, householdId });
    if (EMBED_SKIPS.has(result.output.status) || result.output.vectors.length !== gatedTexts.length) return null;
    return { vectors: result.output.vectors, tokens: result.metadata.inputTokens, model: result.metadata.model };
  }

  return Object.freeze({
    enabled: () => memoryEnabled(env),

    /**
     * Embeds one query text. Resolves a vector, or null when embeddings are unavailable (flag, key, budget, gate refusal) or the acting
     * adult holds no current embedding-provider grant (audit F1: nothing is sent without one, and the grant is re-checked at dispatch).
     */
    async embedQuery({ householdId, adultId, text }) {
      if (!memoryEnabled(env) || !gateway?.enabled) return null;
      const grantId = await providerConsent.resolve({ householdId, adultId, kind: 'embed' });
      if (!grantId) return null;
      const gated = await gatePassage(text, householdId);
      if (!gated) return null;
      try {
        await providerConsent.require({ householdId, adultId, grantId, kind: 'embed' });
        const embedded = await embedGated(householdId, [gated]);
        return embedded ? embedded.vectors[0] : null;
      } catch (error) {
        if (error?.code) return null; // includes CONSENT_REQUIRED: revoked since the grant was resolved
        throw error;
      }
    },

    /** Brings the memory chunks of one holding in line with its confirmed facts and own-PDF clauses. Resolves counts. */
    async embedHolding({ householdId, holdingId }) {
      const result = (extra = {}) => Object.freeze({ embedded: 0, removed: 0, refused: 0, ...extra });
      if (!memoryEnabled(env)) return result({ skipped: 'memory_disabled' });
      if (!gateway?.enabled) return result({ skipped: 'embeddings_unavailable' });
      const holding = await holdingRepository.getHolding({ householdId, holdingId });
      if (!holding) return result({ skipped: 'holding_not_found' });
      const document = await holdingRepository.holdingDocument({ householdId, documentId: holding.documentId });
      if (!document?.consentGrantId) return result({ skipped: 'document_not_available' });
      // The embedding provider needs its own current, exact grant (audit F1). Worker path: no acting adult, any adult's grant of the household.
      const embedGrantId = await providerConsent.resolve({ householdId, kind: 'embed' });
      if (!embedGrantId) return result({ skipped: 'consent_required' });

      // 1. Candidate passages (plain text, then gated).
      const candidates = [];
      const memory = await holdingRepository.currentMemory({ householdId, holdingId });
      for (const fact of resolvedConfirmedFacts(memory).slice(0, MAX_FACT_PASSAGES)) {
        const formatted = formatFactValue(fact.entry.type, fact.value);
        if (formatted === null) continue;
        const tier = fact.sourceTier === 'user_declaration' ? 'confirmed by you' : 'from the insurer wording';
        candidates.push({ scope: 'confirmed_fact', sourceRef: `fact:${fact.factKey}`, text: `${fact.entry.label} ${formatted} (${tier}).`, sourceDocumentId: null });
      }
      if (clauses) {
        // The holding's own document and every document linked to it (its wording, endorsements): clauses are derived now, not lazily, and each
        // passage carries its document and printed page so an answer can cite them.
        const linked = await holdingRepository.linkedDocuments({ householdId, holdingId });
        const documentIds = [holding.documentId, ...linked.map(item => item.documentId)];
        const perDocument = Math.max(1, Math.floor(MAX_CLAUSE_PASSAGES / documentIds.length));
        for (const documentId of documentIds) {
          const caseRow = await database.one(`SELECT case_id FROM document_uploads WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
          if (!caseRow?.case_id) continue;
          await ensureClauses({ householdId, caseId: caseRow.case_id, documentId });
          const listed = await clauses.listClauses({ householdId, caseId: caseRow.case_id, documentIds: [documentId] });
          for (const clause of listed.slice(0, perDocument)) {
            if (typeof clause.text !== 'string' || clause.text.trim() === '') continue;
            candidates.push({ scope: 'own_pdf', sourceRef: `clause:${sha256(clause.clauseId).slice(0, 32)}`, text: clause.text, sourceDocumentId: documentId, sourcePage: Number.isInteger(clause.page) ? clause.page : null });
          }
        }
      }
      let refused = 0;
      const passages = [];
      for (const candidate of candidates) {
        const gated = await gatePassage(candidate.text, householdId);
        if (!gated) { refused += 1; continue; }
        passages.push({ ...candidate, gated, text: gated.text, contentSha256: sha256(gated.text) });
      }

      // 2. Embed only what is new or changed.
      const stored = new Map((await chunks.stored({ householdId, holdingId })).map(row => [`${row.scope}|${row.sourceRef}`, row.contentSha256]));
      const fresh = passages.filter(passage => stored.get(`${passage.scope}|${passage.sourceRef}`) !== passage.contentSha256);
      const toWrite = [];
      let model = null;
      let skipped = null;
      try {
        for (let start = 0; start < fresh.length; start += BATCH) {
          await providerConsent.require({ householdId, grantId: embedGrantId, kind: 'embed' });
          const batch = fresh.slice(start, start + BATCH);
          const embedded = await embedGated(householdId, batch.map(passage => passage.gated));
          if (!embedded) { skipped = 'embeddings_unavailable'; break; }
          model = embedded.model;
          const per = Math.ceil(embedded.tokens / batch.length);
          batch.forEach((passage, index) => toWrite.push({ scope: passage.scope, sourceRef: passage.sourceRef, text: passage.text, contentSha256: passage.contentSha256, embedding: embedded.vectors[index], tokenCount: per, sourceDocumentId: passage.sourceDocumentId, sourcePage: passage.sourcePage ?? null }));
        }
      } catch (error) {
        // A provider, budget or timeout failure never blocks the pipeline: retrieval falls back to facts and keywords.
        if (!error?.code) throw error;
        skipped = `embed_${error.code}`;
      }

      // 3. Write: stale or changed rows go, new ones come in (consent re-checked in the transaction).
      const desired = passages.filter(passage => stored.get(`${passage.scope}|${passage.sourceRef}`) === passage.contentSha256 || toWrite.some(item => item.sourceRef === passage.sourceRef && item.scope === passage.scope))
        .map(passage => ({ scope: passage.scope, sourceRef: passage.sourceRef, contentSha256: passage.contentSha256 }));
      try {
        const written = await chunks.replace({ householdId, holdingId, consentGrantId: document.consentGrantId, embedGrantId, scopes: ['confirmed_fact', 'own_pdf'], desired, chunks: toWrite, embeddingModel: model ?? 'none' });
        return result({ embedded: written.written, removed: written.removed, refused, ...(skipped ? { skipped } : {}) });
      } catch (error) {
        if (error?.code === 'CONSENT_REQUIRED') return result({ refused, skipped: 'consent_not_current' });
        throw error;
      }
    },
  });
}
