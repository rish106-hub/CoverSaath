import { HOLDING_JOB_KINDS, HOLDING_JOB_MAX_ATTEMPTS, HOLDING_JOB_STEPS } from '../../contracts/holdings.js';
import { holdingsEnabled } from './holdings-flag.js';
import { POLICY_FACT_KEY_NAMES, getPolicyFactKey } from '../../contracts/policy-facts.js';
import { collateSlot, resolveSlot } from '../../features/insurance-rules/collate.js';
import { nextHoldingStatus } from '../../features/insurance-rules/holding-status.js';
import { holdingInputSha, holdingJobDedupeKey } from './holding-pipeline.js';

// Holdings pipeline service (complete.md 3.2 steps 3-6 as amended by section 9). Off unless HOLDINGS_ENABLED is exactly "true".
//
//   startPipeline   after the owner reported the insurer and plan (status product_reported): fan out parse_own_pdf and fetch_reference
//   parseOwnPdf     own-PDF tier = the existing policy_facts (ADR 0025): runs its deterministic extract, then status parsed, then collate
//   fetchReference  STUB: the IDA reference import body belongs to the reference agent; here it only queues collate
//   collate         ADR 0023 D3 resolver (collate.js) over own-PDF facts and the reference port's values; writes rows and conflicts
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

  // Candidates of one holding and the identifiers they rest on (the input sha).
  async function gather(holding, document) {
    const own = await repository.ownCandidates({ householdId: holding.householdId, documentId: holding.documentId, sourceVersion: document.sourceVersion });
    const reference = (await referenceFacts.forHolding({ householdId: holding.householdId, holding })) ?? [];
    const ids = [document.sourceVersion.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 128), ...own.map(item => item.factId), ...reference.map(item => item.refId)];
    return { own, reference, inputSha: holdingInputSha(ids.filter(Boolean)) };
  }

  async function documentOf(holding) {
    const document = await repository.holdingDocument({ householdId: holding.householdId, documentId: holding.documentId });
    if (!document) throw permanent('HOLDING_NOT_READY', 'The holding document is not available.');
    return document;
  }

  function memoryView(row) {
    return row ? { id: row.id, status: row.status, value: row.value, alternatives: row.alternatives, captureMethod: row.captureMethod, resolvesFactIds: row.resolvesFactIds } : null;
  }

  return Object.freeze({
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
      const status = await step(holding, 'parse');
      const { inputSha } = await gather({ ...holding, status }, document);
      await enqueue(HOLDING_JOB_KINDS.collate, holding, document, inputSha);
      return Object.freeze({ status });
    },

    // STUB (reference agent owns the body): the IDA import fills reference_cache; the reference port reads it during collate.
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
      const { own, reference, inputSha } = await gather(holding, document);
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
        ownByFactId: new Map(own.map(item => [item.factId, item])),
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
      const bySlot = new Map();
      for (const row of memory) {
        if (row.scopeKey !== '') continue;
        if (!bySlot.has(row.factKey)) bySlot.set(row.factKey, {});
        bySlot.get(row.factKey)[row.tier] = row;
      }
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
          sources: Object.values(tiers).map(row => sourceView(row, quotes)),
        });
      }
      return { holdingId: holding.id, status: holding.status, facts, unknownKeys: POLICY_FACT_KEY_NAMES.filter(key => !bySlot.has(key)) };
    },

    async conflicts({ holding }) {
      requireEnabled();
      const rows = await repository.currentMemory({ householdId: holding.householdId, holdingId: holding.id });
      const quotes = await repository.ownQuotes({ householdId: holding.householdId, policyFactIds: rows.filter(row => row.tier === 'own_pdf').map(row => row.policyFactId) });
      const memory = new Map(rows.map(row => [row.id, row]));
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
            candidates: [...new Set(conflict.candidateFactIds)].map(id => (memory.has(id) ? sourceView(memory.get(id), quotes) : { id, current: false })),
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
}

// One source row for the owner's response: its tier, status, value, page locator and printed quote (own PDF: its evidence; IDA: the
// public wording quote only, never the cache key, version or UIN).
function sourceView(row, quotes = new Map()) {
  return {
    id: row.id, tier: row.tier, status: row.status, value: row.value, alternatives: row.alternatives,
    page: row.sourcePageId ? { pageId: row.sourcePageId, blockIndex: row.blockIndex } : null,
    quote: row.tier === 'ida_wording' ? (typeof row.reference?.quote === 'string' ? row.reference.quote : null)
      : row.tier === 'own_pdf' ? quotes.get(row.policyFactId) ?? null : null,
    captureMethod: row.captureMethod ?? null, current: true,
  };
}
