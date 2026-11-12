import { HOLDING_SUMMARY_HEADLINES as HEADLINE_KEYS, HOLDING_JOB_KINDS, HOLDING_JOB_MAX_ATTEMPTS, HOLDING_JOB_STEPS } from '../../contracts/holdings.js';
import { LINKED_DOCUMENT_FACTS_STATES } from '../../contracts/holdings.js';
import { holdingsEnabled } from './holdings-flag.js';
import { POLICY_FACT_KEY_NAMES, getPolicyFactKey } from '../../contracts/policy-facts.js';
import { collateSlot, resolveSlot } from '../../features/insurance-rules/collate.js';
import { nextHoldingStatus } from '../../features/insurance-rules/holding-status.js';
import { holdingInputSha, holdingJobDedupeKey } from './holding-pipeline.js';

// Holdings pipeline service (complete.md 3.2 steps 3-6 as amended by section 9). Off unless HOLDINGS_ENABLED is exactly "true".
//
//   startPipeline   after the owner reported the insurer and plan (status product_reported): fan out parse_own_pdf and fetch_reference
//   parseOwnPdf     own-PDF tier = the existing policy_facts (ADR 0025): runs its deterministic extract, then status parsed, then collate
//   fetchReference  only queues collate (it never waits for reference data). The import itself is the reference.import job (holding-product-service.js)
//   collate         ADR 0023 D3 resolver (collate.js) over own-PDF facts and the reference port's values; writes rows and conflicts.
//                   Own-PDF facts are those of the holding's document AND of every readable document linked to it (wording, endorsement):
//                   same tier, no precedence between documents. Equal values collapse; different values make the slot `conflicting` with
//                   both alternatives (collate.js ownIntent); nothing is overwritten and a user_confirmed fact or resolved conflict stays.
//   memorise        settles the status (conflicts or ready), then embeds confirmed facts and own-PDF passages into memory_chunks through the
//                   memory service (privacy gate, model gateway, provider_calls; ADR 0031). Off unless MEMORY_ENABLED; never blocks the status
//   facts / conflicts / resolveConflict   the owner's reads and choice (routes in holdings-routes.js)
//
// Jobs are identifiers only (household, document, the document's processing grant, payload { holdingId, inputSha }). Every handler
// re-reads the holding by household and id, and every write re-checks the document and its consent inside its transaction. A
// re-run is a no-op: unchanged readings write nothing and status steps already taken do not move.
// No model or provider call happens in this file: embedding is delegated to the memory service.

const coded = (code, message, statusCode, extra = {}) => Object.assign(new Error(message), { code, statusCode, ...extra });
const permanent = (code, message) => coded(code, message, 409, { retryable: false });

/** The reference port: values deterministic code read from the IDA reference for a holding. Default: none (reference agent wires it). */
export const emptyReferenceFacts = Object.freeze({ async forHolding() { return []; } });

export function createHoldingsService({ repository, jobQueue, policyFacts = null, referenceFacts = emptyReferenceFacts, memory = null, analytics = null, env = process.env }) {
  const enabled = () => holdingsEnabled(env);
  const requireEnabled = () => { if (!enabled()) throw coded('HOLDINGS_DISABLED', 'Holdings are disabled.', 503); };

  async function loadHolding(householdId, holdingId) {
    const holding = await repository.getHolding({ householdId, holdingId });
    if (!holding) throw permanent('HOLDING_NOT_FOUND', 'The holding was not found.');
    return holding;
  }

  async function step(holding, event, openConflicts = 0) {
    const next = nextHoldingStatus(holding.status, event, { openConflicts });
    if (next.changed) await repository.setStatus({ householdId: holding.householdId, holdingId: holding.id, from: holding.status, to: next.status });
    return next.status;
  }

  async function enqueue(kind, holding, document, inputSha) {
    const step = HOLDING_JOB_STEPS[kind];
    return jobQueue.enqueue({
      kind, householdId: holding.householdId, documentId: holding.documentId, consentGrantId: document?.consentGrantId ?? null,
      payload: { holdingId: holding.id, inputSha }, dedupeKey: holdingJobDedupeKey({ holdingId: holding.id, step, inputSha }),
      maxAttempts: HOLDING_JOB_MAX_ATTEMPTS,
    });
  }

  const versionId = value => value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128);

  // The documents linked to a holding that may be read now (active, current version, clean, current processing grant).
  async function readableLinked(holding) {
    const linked = await repository.linkedDocuments({ householdId: holding.householdId, holdingId: holding.id });
    if (linked.length === 0) return [];
    const readable = await repository.readableDocuments({ householdId: holding.householdId, documentIds: linked.map(item => item.documentId) });
    return linked.filter(item => readable.has(item.documentId));
  }

  // The deterministic extract (ADR 0025) of each readable linked document, so a wording linked before its own job ran still contributes.
  // Idempotent (ON CONFLICT DO NOTHING); the extract re-checks consent itself and answers 'unreadable' (not an error) when it cannot read.
  // Off with the policy-facts switch: then a linked document contributes only what is already stored, and no error is raised.
  async function extractLinked(holding) {
    if (!policyFacts?.enabled?.()) return;
    for (const item of await readableLinked(holding)) await policyFacts.extract({ householdId: holding.householdId, documentId: item.documentId, notify: false });
  }

  // Candidates of one holding and the identifiers they rest on (the input sha): the holding's document first (it is the cited one), then
  // each readable linked document in link order.
  async function gather(holding, document) {
    const own = await repository.ownCandidates({ householdId: holding.householdId, documentId: holding.documentId, sourceVersion: document.sourceVersion });
    const linkedDocuments = [];
    const ids = [versionId(document.sourceVersion)];
    for (const item of await readableLinked(holding)) {
      const candidates = await repository.ownCandidates({ householdId: holding.householdId, documentId: item.documentId, sourceVersion: item.sourceVersion });
      ids.push(item.documentId, versionId(item.sourceVersion));
      if (candidates.length === 0) continue;
      own.push(...candidates);
      linkedDocuments.push(item);
    }
    const reference = (await referenceFacts.forHolding({ householdId: holding.householdId, holding })) ?? [];
    ids.push(...own.map(item => item.factId), ...reference.map(item => item.refId));
    return { own, reference, linkedDocuments, inputSha: holdingInputSha(ids.filter(Boolean)) };
  }

  // Queues a collate for a holding whose linked documents changed (a link, a stored extraction). Skipped quietly until the holding has parsed
  // (parse queues it later and reads the linked documents then).
  async function queueCollate(holding) {
    if (!['parsed', 'conflicts', 'ready'].includes(holding.status)) return null;
    const document = await repository.holdingDocument({ householdId: holding.householdId, documentId: holding.documentId });
    if (!document) return null;
    const { inputSha } = await gather(holding, document);
    return enqueue(HOLDING_JOB_KINDS.collate, holding, document, inputSha);
  }

  async function documentOf(holding) {
    const document = await repository.holdingDocument({ householdId: holding.householdId, documentId: holding.documentId });
    if (!document) throw permanent('HOLDING_NOT_READY', 'The holding document is not available.');
    return document;
  }

  // For own-PDF slots that conflict across documents: every reading that fed the disagreement as its own source (document kind and page), so
  // the schedule's value and the wording's value are both shown. Read time only; stored rows are unchanged. Map fact key -> source views.
  async function conflictingContributors(holding, factKeys) {
    const out = new Map();
    if (factKeys.length === 0) return out;
    const document = await repository.holdingDocument({ householdId: holding.householdId, documentId: holding.documentId });
    if (!document) return out;
    const candidates = await repository.ownCandidates({ householdId: holding.householdId, documentId: holding.documentId, sourceVersion: document.sourceVersion });
    for (const item of await readableLinked(holding)) candidates.push(...await repository.ownCandidates({ householdId: holding.householdId, documentId: item.documentId, sourceVersion: item.sourceVersion }));
    const wanted = candidates.filter(item => factKeys.includes(item.factKey) && item.state === 'extracted_unverified');
    if (new Set(wanted.map(item => item.documentId)).size < 2) return out;
    const quotes = await repository.ownQuotes({ householdId: holding.householdId, policyFactIds: wanted.map(item => item.factId) });
    const kinds = await repository.pageDocumentKinds({ householdId: holding.householdId, pageIds: wanted.map(item => item.pageId) });
    for (const item of wanted) {
      if (!out.has(item.factKey)) out.set(item.factKey, []);
      out.get(item.factKey).push({
        id: item.factId, tier: 'own_pdf', status: 'extracted_unverified', value: item.value, alternatives: [],
        page: { pageId: item.pageId, blockIndex: item.blockIndex, documentKind: kinds.get(item.pageId) ?? null },
        quote: quotes.get(item.factId) ?? null, captureMethod: null, current: true,
      });
    }
    return out;
  }

  function memoryView(row) {
    return row ? { id: row.id, status: row.status, value: row.value, alternatives: row.alternatives, captureMethod: row.captureMethod, resolvesFactIds: row.resolvesFactIds } : null;
  }

  const api = Object.freeze({
    enabled,

    async startPipeline({ householdId, holdingId }) {
      requireEnabled();
      const holding = await loadHolding(householdId, holdingId);
      if (holding.status === 'uploaded' || holding.status === 'insurer_pending') throw coded('HOLDING_TRANSITION_INVALID', 'The insurer and plan are not reported yet.', 409);
      const document = await documentOf(holding);
      const inputSha = holdingInputSha([document.sourceVersion.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128)]);
      const parse = await enqueue(HOLDING_JOB_KINDS.parseOwnPdf, holding, document, inputSha);
      const reference = await enqueue(HOLDING_JOB_KINDS.fetchReference, holding, document, inputSha);
      return Object.freeze({ jobs: [parse.job.id, reference.job.id] });
    },

    async parseOwnPdf({ householdId, holdingId }) {
      requireEnabled();
      const holding = await loadHolding(householdId, holdingId);
      const document = await documentOf(holding);
      // The existing deterministic extract (ADR 0025). ON CONFLICT DO NOTHING there, so repeating it writes nothing new.
      if (policyFacts?.enabled?.()) {
        const result = await policyFacts.extract({ householdId, documentId: holding.documentId });
        if (result.status === 'unreadable') throw permanent('HOLDING_NOT_READY', 'The holding document is not readable.');
      }
      await extractLinked(holding);
      const status = await step(holding, 'parse');
      const { inputSha } = await gather({ ...holding, status }, document);
      await enqueue(HOLDING_JOB_KINDS.collate, holding, document, inputSha);
      return Object.freeze({ status });
    },

    // Does not wait on the reference import: collate runs with whatever the reference port returns (none by default, see emptyReferenceFacts).
    async fetchReference({ householdId, holdingId }) {
      requireEnabled();
      const holding = await loadHolding(householdId, holdingId);
      const document = await documentOf(holding);
      const { inputSha } = await gather(holding, document);
      await enqueue(HOLDING_JOB_KINDS.collate, holding, document, inputSha);
      return Object.freeze({ status: holding.status });
    },

    async collate({ householdId, holdingId }) {
      requireEnabled();
      const holding = await loadHolding(householdId, holdingId);
      // The join waits for the own-PDF step: before it, collate is a no-op (parse queues it again).
      if (!['parsed', 'conflicts', 'ready'].includes(holding.status)) return Object.freeze({ status: holding.status, skipped: true });
      const document = await documentOf(holding);
      await extractLinked(holding);
      const { own, reference, linkedDocuments, inputSha } = await gather(holding, document);
      const memory = await repository.currentMemory({ householdId, holdingId });
      const declarations = new Map(memory.filter(row => row.tier === 'user_declaration' && row.scopeKey === '').map(row => [row.factKey, row]));
      const keys = new Set([...own.map(item => item.factKey), ...reference.map(item => item.factKey), ...memory.filter(row => row.scopeKey === '' && row.tier !== 'user_declaration').map(row => row.factKey)]);
      const slots = [];
      for (const factKey of keys) {
        if (!getPolicyFactKey(factKey)) continue;
        slots.push(collateSlot({
          factKey,
          own: own.filter(item => item.factKey === factKey),
          ida: reference.filter(item => item.factKey === factKey),
          declaration: declarations.get(factKey) ?? null,
        }));
      }
      const written = await repository.writeCollation({
        holding, sourceVersion: document.sourceVersion, consentGrantId: document.consentGrantId, slots,
        ownByFactId: new Map(own.map(item => [item.factId, item])), linkedDocuments,
      });
      const status = await step(holding, 'collate', written.openConflicts);
      await enqueue(HOLDING_JOB_KINDS.memorise, holding, document, inputSha);
      return Object.freeze({ status, ...written });
    },

    // The status is settled first (unresolved conflicts never block); the embedding step follows and is non-fatal by design.
    async memorise({ householdId, holdingId }) {
      requireEnabled();
      const holding = await loadHolding(householdId, holdingId);
      if (!['parsed', 'conflicts', 'ready'].includes(holding.status)) return Object.freeze({ status: holding.status, skipped: true });
      const open = await repository.openConflictCount({ householdId, holdingId });
      const status = await step(holding, 'memorise', open);
      const embedded = memory ? await memory.embedHolding({ householdId, holdingId }) : null;
      // Product analytics (ADR 0033): counts and a duration only, once per holding, when it first settles.
      if (analytics && holding.status === 'parsed') {
        void (async () => {
          try {
            const facts = (await repository.currentMemory({ householdId, holdingId })).length;
            await analytics.track({ householdId, event: 'parse_completed', properties: { facts, conflicts: open, ms: Math.max(0, Date.now() - Date.parse(holding.createdAt)) || 0 } });
          } catch { /* analytics never breaks the pipeline */ }
        })();
      }
      return Object.freeze({ status, embedded: embedded?.embedded ?? 0, ...(embedded?.skipped ? { embedSkipped: embedded.skipped } : {}) });
    },

    /**
     * The owner's view of the resolved facts of a holding (the route has proved ownership). Values are opened for this household's
     * own response only. No UIN, cache key or reference locator is returned: only the IDA quote text (public wording).
     */
    async facts({ holding }) {
      requireEnabled();
      const memory = await repository.currentMemory({ householdId: holding.householdId, holdingId: holding.id });
      const quotes = await repository.ownQuotes({ householdId: holding.householdId, policyFactIds: memory.filter(row => row.tier === 'own_pdf').map(row => row.policyFactId) });
      const conflicts = await repository.listConflicts({ householdId: holding.householdId, holdingId: holding.id, pendingOnly: true });
      const kinds = await repository.pageDocumentKinds({ householdId: holding.householdId, pageIds: memory.map(row => row.sourcePageId) });
      const bySlot = new Map();
      for (const row of memory) {
        if (row.scopeKey !== '') continue;
        if (!bySlot.has(row.factKey)) bySlot.set(row.factKey, {});
        bySlot.get(row.factKey)[row.tier] = row;
      }
      const contributing = await conflictingContributors(holding, [...bySlot].filter(([, tiers]) => tiers.own_pdf?.status === 'conflicting').map(([key]) => key));
      const facts = [];
      for (const factKey of POLICY_FACT_KEY_NAMES) {
        const tiers = bySlot.get(factKey);
        if (!tiers) continue;
        const entry = getPolicyFactKey(factKey);
        const resolved = resolveSlot({ factKey, own: memoryView(tiers.own_pdf), ida: memoryView(tiers.ida_wording), declaration: memoryView(tiers.user_declaration) });
        facts.push({
          factKey, factClass: entry.factClass, valueType: entry.type, unit: entry.unit, group: entry.group,
          status: resolved.status, value: resolved.value, sourceTier: resolved.sourceTier, sourceIds: resolved.sourceIds,
          alternatives: resolved.alternatives, checkWithInsurer: resolved.checkWithInsurer,
          openConflictId: conflicts.find(conflict => conflict.factKey === factKey)?.id ?? null,
          sources: [...Object.values(tiers).map(row => sourceView(row, quotes, kinds)), ...(contributing.get(factKey) ?? [])],
        });
      }
      return { holdingId: holding.id, status: holding.status, facts, unknownKeys: POLICY_FACT_KEY_NAMES.filter(key => !bySlot.has(key)) };
    },

    /**
     * The `summary` of each holding for the dashboard (the route has proved ownership): Map holding id -> summary. Deterministic code over
     * stored data only: the insurer and product name the owner confirmed (null until then, never a candidate, never the UIN) and the
     * headline facts, each { factKey, value, status } resolved like facts() (null when no fact exists for that key).
     */
    async summaries({ householdId, holdings }) {
      requireEnabled();
      const names = await repository.confirmedNames({ householdId, holdings });
      const out = new Map();
      for (const holding of holdings) {
        const rows = await repository.currentMemory({ householdId, holdingId: holding.id, factKeys: Object.values(HEADLINE_KEYS) });
        const headline = {};
        for (const [field, factKey] of Object.entries(HEADLINE_KEYS)) {
          const tiers = {};
          for (const row of rows) if (row.factKey === factKey && row.scopeKey === '') tiers[row.tier] = row;
          if (Object.keys(tiers).length === 0) { headline[field] = null; continue; }
          const resolved = resolveSlot({ factKey, own: memoryView(tiers.own_pdf), ida: memoryView(tiers.ida_wording), declaration: memoryView(tiers.user_declaration) });
          headline[field] = { factKey, value: resolved.value, status: resolved.status };
        }
        const confirmed = names.get(holding.id);
        out.set(holding.id, { insurerName: confirmed?.insurerName ?? null, productName: confirmed?.productName ?? null, ...headline });
      }
      return out;
    },

    /**
     * Links another document of the household (its wording, an endorsement) to a holding, queues collate so the linked document's facts join
     * the holding's, and queues memorise so the linked clauses are embedded for this holding's chat. Idempotent. Household ownership is re-checked in the repository.
     */
    async linkDocument({ holding, documentId, kind }) {
      requireEnabled();
      const { linked } = await repository.linkDocument({ householdId: holding.householdId, holdingId: holding.id, documentId, kind });
      // The linked document's facts join the holding's through collate (same job, deduplicated on the identifiers it rests on).
      await queueCollate(await loadHolding(holding.householdId, holding.id));
      if (memory?.enabled?.()) {
        const document = await documentOf(holding);
        const all = await repository.linkedDocuments({ householdId: holding.householdId, holdingId: holding.id });
        await enqueue(HOLDING_JOB_KINDS.memorise, holding, document, holdingInputSha(all.map(item => item.documentId)));
      }
      return { holdingId: holding.id, documentId, kind, linked };
    },

    /**
     * Called after the facts of a document were stored (the policy facts service). Queues a collate for each holding the document is linked
     * to, so a wording that finishes after its link still reaches the holding. Identifiers only; a replay or a duplicate delivery is
     * deduplicated by the queue on the identifiers the collation rests on. Off with HOLDINGS_ENABLED.
     */
    async documentFactsStored({ householdId, documentId }) {
      if (!enabled()) return Object.freeze({ queued: 0 });
      let queued = 0;
      for (const holdingId of await repository.holdingsLinkingDocument({ householdId, documentId })) {
        const holding = await repository.getHolding({ householdId, holdingId });
        if (holding && await queueCollate(holding)) queued += 1;
      }
      return Object.freeze({ queued });
    },

    async unlinkDocument({ holding, documentId }) {
      requireEnabled();
      const { unlinked } = await repository.unlinkDocument({ householdId: holding.householdId, holdingId: holding.id, documentId });
      if (unlinked) {
        // The facts read only from that document were retired with the link. Re-collate now (no provider call) so the slots the other
        // documents still support are rebuilt and any open conflict that rested on it closes; a failure falls back to the queue.
        try { await api.collate({ householdId: holding.householdId, holdingId: holding.id }); }
        catch { await queueCollate(await loadHolding(holding.householdId, holding.id)).catch(() => null); }
      }
      return { holdingId: holding.id, documentId, unlinked };
    },

    async linkedDocuments({ holding }) {
      requireEnabled();
      const items = await repository.linkedDocuments({ householdId: holding.householdId, holdingId: holding.id });
      // factsState: 'included' (its facts are part of this holding's facts), 'none' (nothing read from it yet or nothing found), 'off'
      // (fact reading is switched off, so a linked document adds no facts).
      const on = Boolean(policyFacts?.enabled?.());
      const documents = [];
      for (const item of items) {
        let factsState = LINKED_DOCUMENT_FACTS_STATES[2];
        if (on) factsState = (await repository.ownCandidates({ householdId: holding.householdId, documentId: item.documentId, sourceVersion: item.sourceVersion })).length > 0 ? LINKED_DOCUMENT_FACTS_STATES[0] : LINKED_DOCUMENT_FACTS_STATES[1];
        documents.push({ documentId: item.documentId, kind: item.kind, factsState });
      }
      return { holdingId: holding.id, documents };
    },

    async conflicts({ holding }) {
      requireEnabled();
      const rows = await repository.currentMemory({ householdId: holding.householdId, holdingId: holding.id });
      const quotes = await repository.ownQuotes({ householdId: holding.householdId, policyFactIds: rows.filter(row => row.tier === 'own_pdf').map(row => row.policyFactId) });
      const memory = new Map(rows.map(row => [row.id, row]));
      const kinds = await repository.pageDocumentKinds({ householdId: holding.householdId, pageIds: rows.map(row => row.sourcePageId) });
      const conflicts = await repository.listConflicts({ householdId: holding.householdId, holdingId: holding.id });
      return {
        holdingId: holding.id,
        status: holding.status,
        conflicts: conflicts.map(conflict => {
          const entry = getPolicyFactKey(conflict.factKey);
          return {
            id: conflict.id, factKey: conflict.factKey, factClass: entry?.factClass ?? null, valueType: entry?.type ?? null, reason: conflict.reason,
            resolution: conflict.resolution, resolvedAt: conflict.resolvedAt, resolvingFactId: conflict.resolvingFactId,
            // FOR LEGAL REVIEW: a product-term choice is the owner's statement; the insurer's wording still governs.
            checkWithInsurer: entry?.factClass === 'product_term',
            candidates: conflict.candidateFactIds.map(id => (memory.has(id) ? sourceView(memory.get(id), quotes, kinds) : { id, current: false })),
          };
        }),
      };
    },

    async resolveConflict({ holding, conflictId, adultId, body }) {
      requireEnabled();
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw coded('MEMORY_CONFLICT_CHOICE_INVALID', 'A choice is required.', 400);
      const chosenFactId = body.chosenFactId;
      if (typeof chosenFactId !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(chosenFactId)) throw coded('MEMORY_CONFLICT_CHOICE_INVALID', 'chosenFactId is required.', 400);
      const alternativeIndex = body.alternativeIndex ?? null;
      if (alternativeIndex !== null && (!Number.isInteger(alternativeIndex) || alternativeIndex < 0 || alternativeIndex > 9)) {
        throw coded('MEMORY_CONFLICT_CHOICE_INVALID', 'alternativeIndex is invalid.', 400);
      }
      const result = await repository.resolveConflict({ holding, conflictId, chosenFactId, alternativeIndex, adultId });
      const fresh = await loadHolding(holding.householdId, holding.id);
      const open = await repository.openConflictCount({ householdId: holding.householdId, holdingId: holding.id });
      const status = await step(fresh, 'resolve', open);
      // The owner's choice is a new user_confirmed fact: bring the memory chunks in line (a no-op while MEMORY_ENABLED is off).
      if (memory?.enabled?.()) {
        const document = await documentOf(fresh);
        await enqueue(HOLDING_JOB_KINDS.memorise, fresh, document, holdingInputSha([result.resolvingFactId]));
      }
      return { conflictId: result.conflictId, resolvingFactId: result.resolvingFactId, status: 'user_confirmed', holdingStatus: status, replay: result.replay };
    },
  });
  return api;
}

// One source row for the owner's response: its tier, status, value, page locator and printed quote (own PDF: its evidence; IDA: the
// public wording quote only, never the cache key, version or UIN).
function sourceView(row, quotes = new Map(), kinds = new Map()) {
  return {
    id: row.id, tier: row.tier, status: row.status, value: row.value, alternatives: row.alternatives,
    page: row.sourcePageId ? { pageId: row.sourcePageId, blockIndex: row.blockIndex, documentKind: kinds.get(row.sourcePageId) ?? null } : null,
    quote: row.tier === 'ida_wording' ? (typeof row.reference?.quote === 'string' ? row.reference.quote : null)
      : row.tier === 'own_pdf' ? quotes.get(row.policyFactId) ?? null : null,
    captureMethod: row.captureMethod ?? null, current: true,
  };
}
