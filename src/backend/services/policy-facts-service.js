import { sectionStoredDocument } from '../../features/policy-structuring/sectioner.js';
import { extractFacts } from '../../features/policy-facts/deterministic-extractors.js';
import { verifyEvidence } from '../../features/policy-facts/evidence-verify.js';
import { FACT_TYPES, isFactType, modelMayProposeFact } from '../../features/policy-facts/fact-types.js';
import { NORMALISER_VERSION, comparable, sha256Nfc, valuesIn } from '../../features/policy-facts/normalisers.js';
import { createStoredPagesReader } from './readable-document.js';
import { policyFactsEnabled } from './policy-profile-service.js';

// Policy facts service (ADR 0025, policy facts slice 2). Off unless POLICY_FACTS_ENABLED is exactly "true" (the same switch as the
// policy profile).
//
// extract():  the job handler's work. Reads the stored OCR pages through the shared consent gate, sections them, extracts candidates
//             deterministically, verifies every quote against its chunk and every value against its quote, and stores what survives
//             in one transaction (the repository re-checks the document and its consent inside it). A document that is no longer
//             readable (revoked, deleted, replaced) ends the work and writes nothing.
// recordModelFacts(): verifies and stores facts a model proposed (through the existing structuring pipeline, privacy gate and
//             model grant). Same verification; a fact type the registry does not allow a model to propose is refused.
// get():      the owner's read. Sealed values are never returned for a fact that is not reported.
// No model or provider call happens in this file.

export const POLICY_FACTS_JOB_KIND = 'policy_facts.extract';

function coded(code, message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { code, statusCode, ...extra });
}

/** The queue dedupe key: one job per (document, source version, normaliser version). Short and identifier-safe. */
export function policyFactsDedupeKey({ documentId, sourceVersion, normaliserVersion = NORMALISER_VERSION }) {
  return `pfx-${sha256Nfc(`${documentId}\u0000${sourceVersion}\u0000${normaliserVersion}`).slice(0, 40)}`;
}

const runIdOf = (documentId, sourceVersion, origin) => `${documentId}:${sha256Nfc(sourceVersion).slice(0, 16)}:${NORMALISER_VERSION}:${origin === 'model_proposed' ? 'm' : 'd'}`;

export function createPolicyFactsService({ repository, ocr, env = process.env, clock = () => new Date(), onStored = null }) {
  const readStoredPages = createStoredPagesReader({ ocr, clock });
  const requireEnabled = () => {
    if (!policyFactsEnabled(env)) throw coded('POLICY_FACTS_DISABLED', 'Policy facts are disabled.', 503);
  };

  // Chunks of the document now, or null when the text may not be read (no OCR, grant withdrawn, blocks missing).
  async function chunksOf(document) {
    const stored = await readStoredPages(document);
    if (!stored) return null;
    try {
      return { chunks: sectionStoredDocument(stored).chunks, sourceVersion: stored.sourceVersion };
    } catch (error) {
      if (error?.code === 'STRUCTURING_BLOCKS_UNAVAILABLE') return null;
      throw error;
    }
  }

  // Keeps the evidence that verifies. A fact that loses its primary evidence (or, if conflicting, drops below two quotes) is dropped.
  function verifyFact(fact, chunks, digests, origin) {
    const byClause = new Map(chunks.map(chunk => [chunk.id, chunk]));
    const kept = [];
    const dropped = [];
    for (const evidence of fact.evidence) {
      const chunk = byClause.get(evidence.clauseId);
      const result = verifyEvidence({ factType: fact.factType, value: fact.value, quote: evidence.quote, page: evidence.page, blockIndex: evidence.blockIndex, origin }, chunk);
      if (!result.ok) { dropped.push(result.reason); continue; }
      kept.push({ ...evidence, quote: result.quote, sourceDigest: digests.get(evidence.page) ?? null });
    }
    if (fact.state === 'unknown') return { fact: { ...fact, origin, evidence: [] }, dropped };
    if (!kept.some(item => item.role === 'primary')) return { fact: null, dropped };
    return { fact: { ...fact, origin, evidence: kept.slice(0, 4) }, dropped };
  }

  // A conflicting fact: every quote must be a real substring of its chunk (the values differ by definition and are not stored).
  function verifyConflict(fact, chunks, digests, origin) {
    const byClause = new Map(chunks.map(chunk => [chunk.id, chunk]));
    const kept = [];
    const dropped = [];
    for (const evidence of fact.evidence) {
      const chunk = byClause.get(evidence.clauseId);
      const quote = typeof evidence.quote === 'string' ? evidence.quote.normalize('NFC').trim() : '';
      if (!chunk || !quote || quote.length > 500 || !chunk.text.normalize('NFC').includes(quote) || evidence.page !== chunk.page) { dropped.push('quote_not_in_chunk'); continue; }
      kept.push({ ...evidence, quote, sourceDigest: digests.get(evidence.page) ?? null });
    }
    return { fact: kept.length >= 2 ? { ...fact, origin, evidence: kept } : null, dropped };
  }

  return Object.freeze({
    enabled: () => policyFactsEnabled(env),

    /**
     * The deterministic pass for one document of a household. Resolves a counts-only result:
     * { status: 'stored' | 'unreadable', inserted, skipped, droppedByReason }.
     */
    async extract({ householdId, documentId, notify = true }) {
      requireEnabled();
      const document = await repository.documentIdentity({ householdId, documentId });
      if (!document) return Object.freeze({ status: 'unreadable', inserted: 0, skipped: 0, droppedByReason: {} });
      const read = await chunksOf({ id: documentId, householdId });
      if (!read || read.sourceVersion !== document.sourceVersion) return Object.freeze({ status: 'unreadable', inserted: 0, skipped: 0, droppedByReason: {} });
      const digests = await repository.pageDigests({ householdId, documentId, sourceVersion: document.sourceVersion });
      const { facts: candidates } = extractFacts(read.chunks);
      const droppedByReason = {};
      const countDrops = reasons => { for (const reason of reasons) droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1; };
      const verified = [];
      for (const candidate of candidates) {
        if (!isFactType(candidate.factType)) continue;
        const outcome = candidate.state === 'conflicting'
          ? verifyConflict(candidate, read.chunks, digests, 'deterministic')
          : verifyFact(candidate, read.chunks, digests, 'deterministic');
        countDrops(outcome.dropped);
        if (outcome.fact) verified.push({ ...outcome.fact, ordinal: 0 });
        else countDrops(['fact_dropped']);
      }
      const result = await repository.insertExtraction({
        householdId, documentId, sourceVersion: document.sourceVersion, extractionRunId: runIdOf(documentId, document.sourceVersion, 'deterministic'),
        normaliserVersion: NORMALISER_VERSION, facts: verified,
      });
      // After the facts are stored (also on a replay, so a retry repeats a hook that failed): `onStored` lets the holdings pipeline pick up a
      // document linked to a holding. Identifiers only. A failure is thrown so the job retries; the write above is idempotent.
      if (notify && typeof onStored === 'function') await onStored({ householdId, documentId });
      return Object.freeze({ status: 'stored', inserted: result.inserted, skipped: result.skipped, droppedByReason });
    },

    /**
     * Verifies and stores model-proposed facts: [{ factType, scopeKey?, valueText, quote, page, blockIndex }]. `consentCheck` is the model
     * grant check awaited inside the transaction. A fact type the registry does not permit a model to propose, a quote that is not in
     * its chunk, or a value that does not parse from its quote is dropped. Never above extracted_unverified; two different values for
     * one fact become one conflicting fact.
     */
    async recordModelFacts({ householdId, documentId, candidates, consentCheck }) {
      requireEnabled();
      if (!Array.isArray(candidates) || candidates.length > 400) throw coded('POLICY_FACT_INVALID', 'candidates must be a list of at most 400.', 400);
      const document = await repository.documentIdentity({ householdId, documentId });
      if (!document) return Object.freeze({ status: 'unreadable', inserted: 0, skipped: 0, droppedByReason: {} });
      const read = await chunksOf({ id: documentId, householdId });
      if (!read || read.sourceVersion !== document.sourceVersion) return Object.freeze({ status: 'unreadable', inserted: 0, skipped: 0, droppedByReason: {} });
      const digests = await repository.pageDigests({ householdId, documentId, sourceVersion: document.sourceVersion });
      const droppedByReason = {};
      const drop = reason => { droppedByReason[reason] = (droppedByReason[reason] ?? 0) + 1; };
      const groups = new Map();
      for (const item of candidates) {
        if (!item || !isFactType(item.factType)) { drop('unknown_fact_type'); continue; }
        if (!modelMayProposeFact(item.factType)) { drop('model_not_permitted'); continue; }
        const kind = FACT_TYPES[item.factType].parse;
        const chunk = read.chunks.find(entry => entry.page === item.page && (item.blockIndex == null || entry.blockIndexes.includes(item.blockIndex)) && entry.text.normalize('NFC').includes(String(item.quote ?? '').normalize('NFC').trim()));
        if (!chunk) { drop('quote_not_in_chunk'); continue; }
        const value = kind === 'text'
          ? { text: String(item.valueText ?? '').replace(/\s+/g, ' ').trim() }
          : valuesIn(kind, String(item.valueText ?? ''))[0] ?? null;
        if (!value) { drop('value_invalid'); continue; }
        const candidate = { factType: item.factType, scopeKey: item.scopeKey ?? '', value, quote: item.quote, page: chunk.page, blockIndex: item.blockIndex ?? chunk.blockIndexes[0], origin: 'model_proposed' };
        const result = verifyEvidence(candidate, chunk);
        if (!result.ok) { drop(result.reason); continue; }
        const key = `${item.factType}\u0000${candidate.scopeKey}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ ...candidate, quote: result.quote, clauseId: chunk.id, sourceDigest: digests.get(chunk.page) ?? null });
      }
      const facts = [];
      for (const list of groups.values()) {
        const { factType, scopeKey } = list[0];
        const kind = FACT_TYPES[factType].parse;
        const distinct = new Map(list.map(entry => [comparable(kind, entry.value), entry]));
        const evidenceOf = (entry, role) => ({ role, quote: entry.quote, page: entry.page, blockIndex: entry.blockIndex, clauseId: entry.clauseId, sourceDigest: entry.sourceDigest });
        if (distinct.size === 1) {
          const seen = new Set();
          const evidence = [];
          for (const entry of list) {
            const id = `${entry.page}:${entry.quote}`;
            if (seen.has(id)) continue;
            seen.add(id);
            evidence.push(evidenceOf(entry, evidence.length === 0 ? 'primary' : 'corroborating'));
            if (evidence.length >= 4) break;
          }
          facts.push({ factType, scopeKey, ordinal: 0, origin: 'model_proposed', state: 'extracted_unverified', value: list[0].value, raw: list[0].quote, evidence });
        } else {
          facts.push({ factType, scopeKey, ordinal: 0, origin: 'model_proposed', state: 'conflicting', value: null, raw: null, evidence: [...distinct.values()].slice(0, 4).map(entry => evidenceOf(entry, 'conflicting')) });
        }
      }
      const result = await repository.insertExtraction({
        householdId, documentId, sourceVersion: document.sourceVersion, extractionRunId: runIdOf(documentId, document.sourceVersion, 'model_proposed'),
        normaliserVersion: NORMALISER_VERSION, facts, consentCheck,
      });
      return Object.freeze({ status: 'stored', inserted: result.inserted, skipped: result.skipped, droppedByReason });
    },

    /** The owner's read of the facts of an active document. The route has already proved ownership. */
    async get({ document }) {
      requireEnabled();
      if (document?.lifecycleState !== 'active') throw coded('POLICY_FACTS_NOT_READY', 'The document is not available yet.', 409);
      const facts = await repository.listForDocument({ householdId: document.householdId, documentId: document.id, sourceVersion: document.sourceVersion });
      return { documentId: document.id, sourceVersion: document.sourceVersion, facts };
    },
  });
}
