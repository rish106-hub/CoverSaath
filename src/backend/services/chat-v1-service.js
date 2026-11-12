import { createHash } from 'node:crypto';
import { CHAT_INPUT_KINDS, CHAT_PROCEDURE_KEYS, CHAT_THREAD_REQUEST_KEYS, CHAT_TURN_REQUEST_KEYS, CHAT_V1_MESSAGE_MAX } from '../../contracts/chat.js';
import { ANALYTICS_EVENTS } from '../../contracts/analytics-events.js';
import { CHAT_INTENTS } from '../../features/ai-analysis/gateway-contract.js';
import { gateText, gateTextForHousehold, sealModelInput } from '../../features/ai-analysis/privacy-evidence-gate.js';
import { buildDeterministicAnswer } from '../../features/insurance-rules/chat-answer.js';
import { classifyChatMessage } from '../../features/insurance-rules/chat-intent.js';
import { formatFactValue } from '../../features/insurance-rules/fact-format.js';
import { planProcedure } from '../../features/insurance-rules/procedure-planning.js';
import { memoryEnabled, resolvedConfirmedFacts } from './memory-service.js';

// Chat v1 (complete.md 3.3, ADR 0031): threads, and turns streamed as SSE. Off unless MEMORY_ENABLED is exactly "true".
//
// A turn:
//   1. classify intent deterministically (keyword rules; a model label would only ever be a hint);
//   2. retrieve, all scoped to the household: confirmed facts (user_confirmed / reviewed_reference, including declarations) and open
//      conflicts of its holdings; then the vector top-k of memory_chunks, or, when embeddings are unavailable, a keyword match over
//      policy_clauses;
//   3. the rules engine answers waiting-period, sub-limit, room-rent and co-payment arithmetic in code (procedure-planning.js);
//   4. the model, only when CHAT_MODEL_ENABLED is "true" and the budget allows, words a short answer over REDACTED facts through the
//      model gateway (privacy gate, per-household budget, provider_calls row). Names are tokenised by the gate from its own loader and
//      restored in the reply only; no UIN, policy number or decrypted name is ever in a prompt or a response;
//   5. any refusal, unavailability or check failure falls back to the deterministic answer (chat v0 behaviour);
//   6. the exchange and its retrieval trace are stored together (sealed), then the answer is streamed.
// Every answer carries facts_used (ids of the memory rows it rests on). Model output is only extracted_unverified, conflicting or
// unknown; the answer status shown is evidence_found or unknown, decided by code.
// Wording is DRAFT and FOR LEGAL REVIEW.

const ID = /^[A-Za-z0-9_.:-]{1,100}$/;
const MAX_FACTS_TO_MODEL = 25;
const VECTOR_K = 5;
const KEYWORD_K = 3;
const MAX_HOLDINGS = 20;
const DELTA_CHARS = 48;

const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
const invalid = message => coded('CHAT_REQUEST_INVALID', message, 400);
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');
// Provider ids the analytics allowlist knows; anything else is reported as 'none' (ADR 0033).
const ANALYTICS_PROVIDERS = ANALYTICS_EVENTS.chat_turn.provider.values;
const alias = (householdId, id) => `fact_${sha256(`${householdId}|${id}`).slice(0, 24)}`;
const only = (value, keys, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object.`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw invalid(`${name} has an unknown field.`);
  return value;
};

function validateProcedure(raw) {
  if (raw === undefined) return null;
  const body = only(raw, CHAT_PROCEDURE_KEYS, 'procedure');
  const procedure = {};
  if (body.planned_date !== undefined) {
    if (typeof body.planned_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body.planned_date)) throw invalid('planned_date must be YYYY-MM-DD.');
    procedure.plannedDate = body.planned_date;
  }
  for (const [key, field, max] of [['estimated_cost_inr', 'estimatedCostMinor', 1_000_000_000], ['room_rent_per_day_inr', 'roomRentPerDayMinor', 10_000_000]]) {
    if (body[key] === undefined) continue;
    if (!Number.isInteger(body[key]) || body[key] < 0 || body[key] > max) throw invalid(`${key} must be a whole number of rupees.`);
    procedure[field] = body[key] * 100;
  }
  if (body.stay_days !== undefined) {
    if (!Number.isInteger(body.stay_days) || body.stay_days < 0 || body.stay_days > 365) throw invalid('stay_days must be 0 to 365.');
    procedure.stayDays = body.stay_days;
  }
  return procedure;
}

export function createChatV1Service({ chatRepository, holdingRepository, chunks, clauses, database, memory, providerConsent, gateway = null, loadKnownIdentifiers, env = process.env, clock = () => new Date() }) {
  if (!providerConsent) throw new TypeError('A provider consent resolver is required.');
  const requireEnabled = () => { if (!memoryEnabled(env)) throw coded('MEMORY_DISABLED', 'Memory is disabled.', 503); };
  const voiceAudioRetained = () => env.VOICE_AUDIO_RETAIN === 'true';

  // The facts, conflicts and holdings in scope of a thread.
  async function gatherContext({ householdId, thread }) {
    const holdingRows = thread.holdingId ? [{ id: thread.holdingId }]
      : await database.many(`SELECT id FROM policy_holdings WHERE household_id = ? AND status IN ('parsed', 'conflicts', 'ready') ORDER BY created_at, id LIMIT ?`, [householdId, MAX_HOLDINGS]);
    const facts = [];
    const conflicts = [];
    const documents = [];
    const places = new Map();
    for (const { id: holdingId } of holdingRows) {
      const rows = await holdingRepository.currentMemory({ householdId, holdingId });
      // Own-document readings still unverified are served too, with their status kept (never presented as confirmed).
      for (const fact of resolvedConfirmedFacts(rows, { includeUnverified: true })) facts.push({ ...fact, holdingId });
      for (const [id, place] of await holdingRepository.ownFactSources({ householdId, rows })) places.set(id, place);
      for (const conflict of await holdingRepository.listConflicts({ householdId, holdingId, pendingOnly: true })) conflicts.push({ id: conflict.id, factKey: conflict.factKey, holdingId });
      const holding = await holdingRepository.getHolding({ householdId, holdingId });
      if (holding?.documentId) documents.push({ holdingId, documentId: holding.documentId });
      // Documents linked to the holding (its wording, endorsements) are searched too.
      for (const linked of await holdingRepository.linkedDocuments({ householdId, holdingId })) documents.push({ holdingId, documentId: linked.documentId });
    }
    return { holdingIds: holdingRows.map(row => row.id), facts, conflicts, documents, places };
  }

  async function keywordClauses({ householdId, documents, message }) {
    if (!clauses) return [];
    const found = [];
    for (const { documentId } of documents) {
      const row = await database.one(`SELECT case_id FROM document_uploads WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
      if (!row?.case_id) continue;
      const hits = await clauses.searchClauses({ householdId, caseId: row.case_id, documentIds: [documentId], query: message, limit: KEYWORD_K });
      for (const hit of hits) found.push({ id: hit.clauseId, page: hit.page ?? null, text: hit.text, documentId });
    }
    return found.slice(0, KEYWORD_K);
  }

  // Words a short answer over redacted facts. Resolves { text, factsUsed, meta } or null (use the deterministic answer).
  async function modelAnswer({ householdId, adultId, chatGrantId, message, history, context, relevant, plan, passages, startedAt }) {
    if (!gateway?.enabled) return null;
    let memoLoad;
    const loader = () => (memoLoad ??= loadKnownIdentifiers(householdId));
    let question;
    try { question = await gateTextForHousehold(message, { householdId, loadKnownIdentifiers: loader }); } catch (error) {
      if (['RESTRICTED_EVIDENCE', 'EVIDENCE_SOURCE_LIMIT', 'PRIVACY_GATE_MALFORMED'].includes(error?.code)) return null;
      throw error;
    }
    const aliasToFact = new Map();
    const slots = [];
    const addSlot = async ({ id, label, value, fact = null, checkFactIds = null }) => {
      const key = alias(householdId, id);
      aliasToFact.set(key, { fact, checkFactIds });
      slots.push({ fact_id: key, label: gateText(label, { knownIdentifiers: [] }), value: (await gateTextForHousehold(value, { householdId, loadKnownIdentifiers: loader })).gated });
    };
    for (const fact of relevant.slice(0, MAX_FACTS_TO_MODEL)) {
      const value = formatFactValue(fact.entry.type, fact.value);
      // The model is told, in the label, that a reading from the household's own document is not confirmed.
      if (value !== null) await addSlot({ id: fact.sourceIds[0], label: fact.status === 'extracted_unverified' ? `${fact.entry.label} (read from the policy document, not confirmed)` : fact.entry.label, value, fact });
    }
    for (const check of plan?.checks ?? []) await addSlot({ id: `check:${check.id}`, label: 'Planning check (computed)', value: check.detail, checkFactIds: check.factIds });
    for (const passage of passages) {
      // Stored passages were redacted at write time; their tokens are renamed so they never rehydrate as this question's people.
      const text = passage.text.replace(/\{\{([A-Z][A-Z_]*_\d+)\}\}/g, '{{PASSAGE_$1}}');
      const key = alias(householdId, passage.id);
      aliasToFact.set(key, { chunkId: passage.id });
      slots.push({ fact_id: key, label: gateText('Policy passage', { knownIdentifiers: [] }), value: gateText(text, { regate: true, knownIdentifiers: [] }) });
    }
    const historyGated = [];
    for (const turn of history) {
      try { historyGated.push({ role: turn.role, text: (await gateTextForHousehold(turn.text, { householdId, loadKnownIdentifiers: loader })).gated }); } catch { /* a turn the gate refuses is left out */ }
    }
    const input = sealModelInput('chat_answer', { payload: { question: question.gated, history: historyGated, facts: slots } });
    const redactedPromptHash = sha256(JSON.stringify({ q: question.gated.text, h: historyGated.map(turn => turn.text.text), f: slots.map(slot => [slot.fact_id, slot.label.text, slot.value.text]) }));
    let result;
    try {
      // Re-check the grant right before dispatch (audit F1); the commit re-checks it again inside the transaction.
      await providerConsent.require({ householdId, adultId, grantId: chatGrantId, kind: 'chat' });
      result = await gateway.call({ task: 'chat_answer', input, householdId });
    } catch (error) {
      if (error?.code) return { failed: error.code };
      throw error;
    }
    if (result.metadata.calls === 0 || result.output.status !== 'extracted_unverified') return { failed: result.metadata.unavailableReason ?? 'model_unknown' };
    const usedFacts = [];
    const usedChunks = [];
    for (const key of result.output.factsUsed) {
      const entry = aliasToFact.get(key);
      if (entry?.fact) usedFacts.push(entry.fact);
      else if (entry?.chunkId) usedChunks.push(entry.chunkId);
      else if (entry?.checkFactIds) for (const id of entry.checkFactIds) { const f = context.facts.find(item => item.sourceIds.includes(id)); if (f && !usedFacts.includes(f)) usedFacts.push(f); }
    }
    return {
      text: question.rehydrate(result.output.answer), usedFacts, usedChunks, redactedPromptHash,
      meta: { provider: result.metadata.provider, model: result.metadata.model, tokensIn: result.metadata.inputTokens, tokensOut: result.metadata.outputTokens, costUsd: result.metadata.costUsd, latencyMs: Date.now() - startedAt },
    };
  }

  const factView = fact => ({
    fact_id: fact.sourceIds[0], fact_key: fact.factKey, label: fact.entry.label, status: fact.status, source_tier: fact.sourceTier,
    value_text: formatFactValue(fact.entry.type, fact.value), holding_id: fact.holdingId, check_with_insurer: fact.checkWithInsurer,
  });

  return Object.freeze({
    enabled: () => memoryEnabled(env),

    async createThread({ principal, body }) {
      requireEnabled();
      const input = only(body, CHAT_THREAD_REQUEST_KEYS, 'The request');
      if (typeof input.household_id !== 'string' || !ID.test(input.household_id)) throw invalid('household_id is required.');
      if (input.holding_id !== undefined && (typeof input.holding_id !== 'string' || !ID.test(input.holding_id))) throw invalid('holding_id is invalid.');
      const thread = await chatRepository.createThread({ householdId: input.household_id, adultId: principal.adultId, holdingId: input.holding_id ?? null });
      return { thread: { id: thread.id, household_id: thread.householdId, holding_id: thread.holdingId, created_at: thread.createdAt } };
    },

    /**
     * Validates and authorises a turn, then returns { run(emit) }. Throws (a JSON error) before the stream opens. run() never throws:
     * a failure after this point is one `error` event.
     */
    async startTurn({ principal, threadId, body }) {
      requireEnabled();
      if (typeof threadId !== 'string' || !ID.test(threadId)) throw coded('CHAT_THREAD_NOT_FOUND', 'The chat thread was not found.', 404);
      const input = only(body, CHAT_TURN_REQUEST_KEYS, 'The request');
      const message = typeof input.message === 'string' ? input.message.normalize('NFKC').trim() : '';
      if (message === '' || message.length > CHAT_V1_MESSAGE_MAX) throw invalid(`message must be 1 to ${CHAT_V1_MESSAGE_MAX} characters.`);
      const inputKind = input.input_kind ?? 'text';
      if (!CHAT_INPUT_KINDS.includes(inputKind)) throw invalid('input_kind is invalid.');
      if (input.audio_document_id !== undefined && (inputKind !== 'voice' || typeof input.audio_document_id !== 'string' || !ID.test(input.audio_document_id))) throw invalid('audio_document_id belongs to a voice turn.');
      const procedure = validateProcedure(input.procedure);
      const thread = await chatRepository.getThread({ threadId, adultId: principal.adultId, write: true });
      const householdId = thread.householdId;
      // The audio is kept only under VOICE_AUDIO_RETAIN exactly "true", and only if it is an active document of this household (ADR 0029).
      let audioDocumentId = null;
      if (inputKind === 'voice' && input.audio_document_id && voiceAudioRetained()) {
        const doc = await database.one(`SELECT id FROM document_uploads WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [input.audio_document_id, householdId]);
        if (!doc) throw coded('DOCUMENT_NOT_FOUND', 'The document was not found.', 404);
        audioDocumentId = doc.id;
      }

      return {
        async run(emit) {
          const startedAt = Date.now();
          try {
            const { intent, factKeys } = classifyChatMessage(message, { hasProcedure: procedure !== null });
            const context = await gatherContext({ householdId, thread });
            const conflictKeys = new Set(context.conflicts.map(item => item.factKey));
            const byKey = new Set(factKeys);
            const relevant = intent === 'procedure_planning' ? context.facts.filter(fact => fact.status !== 'extracted_unverified') : [...context.facts.filter(fact => byKey.has(fact.factKey)), ...context.facts.filter(fact => !byKey.has(fact.factKey))];
            const plan = intent === 'procedure_planning'
              ? planProcedure({ facts: Object.fromEntries(context.facts.filter(fact => fact.status !== 'extracted_unverified').map(fact => [fact.factKey, { id: fact.sourceIds[0], status: fact.status, value: fact.value }])), procedure: procedure ?? {} }) : null;

            // Retrieval beyond facts: vector top-k, else a keyword match over clauses (only when no confirmed fact answers the topic).
            let mode = 'facts_only';
            let passages = [];
            const answersTopic = factKeys.some(key => context.facts.some(fact => fact.factKey === key));
            if (!answersTopic && intent !== 'procedure_planning') {
              const vector = await memory.embedQuery({ householdId, adultId: principal.adultId, text: message });
              if (vector) {
                passages = await chunks.search({ householdId, holdingIds: context.holdingIds.length ? context.holdingIds : null, embedding: vector, limit: VECTOR_K });
                mode = 'vector';
              }
            }
            let clauseHits = [];
            if (mode !== 'vector' && !answersTopic && context.documents.length > 0 && intent !== 'procedure_planning') {
              clauseHits = await keywordClauses({ householdId, documents: context.documents, message });
              mode = 'keyword';
            }

            emit('meta', { thread_id: thread.id, intent: CHAT_INTENTS.includes(intent) ? intent : 'unknown', retrieval_mode: mode, facts_available: context.facts.length, open_conflicts: context.conflicts.length });

            const deterministic = buildDeterministicAnswer({ intent, factKeys, facts: relevant, conflictKeys, plan, clauses: clauseHits });
            const history = await chatRepository.recentTurns({ householdId, threadId });
            // No current chat grant (purpose + recipient + scope) means no model call: the deterministic answer stands (audit F1).
            const chatGrantId = gateway?.enabled ? await providerConsent.resolve({ householdId, adultId: principal.adultId, kind: 'chat' }) : null;
            const model = (context.facts.length > 0 || passages.length > 0)
              ? (gateway?.enabled && !chatGrantId ? { failed: 'consent_required' } : await modelAnswer({ householdId, adultId: principal.adultId, chatGrantId, message, history, context, relevant, plan, passages, startedAt })) : null;

            let text = deterministic.text;
            let answerSource = 'deterministic';
            let usedFacts = deterministic.usedFacts;
            let usedChunks = [];
            let assistantMeta = {};
            if (model && !model.failed) {
              text = model.text; answerSource = 'model'; usedFacts = model.usedFacts; usedChunks = model.usedChunks;
              assistantMeta = { ...model.meta, redactedPromptHash: model.redactedPromptHash };
            } else if (model?.failed) assistantMeta = { modelStatus: model.failed };

            // Code owns the status: an answer that rests on no fact, chunk or computed check is "unknown".
            const status = usedFacts.length > 0 || usedChunks.length > 0 || (plan?.checks.length ?? 0) > 0 ? 'evidence_found' : 'unknown';
            const factIds = [...new Set(usedFacts.map(fact => fact.sourceIds[0]))];
            // Where the answer rests, for the client to cite: own-document readings with their verbatim quote, document and page; wording
            // passages with their document and printed page. Status is the fact's own (an own-document reading stays extracted_unverified).
            const sources = [
              ...usedFacts.map(fact => ({ kind: 'fact', fact_id: fact.sourceIds[0], fact_key: fact.factKey, status: fact.status, document_id: context.places.get(fact.sourceIds[0])?.documentId ?? null, page: context.places.get(fact.sourceIds[0])?.page ?? null, quote: context.places.get(fact.sourceIds[0])?.quote ?? null })),
              ...passages.filter(item => usedChunks.includes(item.id)).map(item => ({ kind: 'passage', chunk_id: item.id, document_id: item.sourceDocumentId ?? null, page: item.page ?? null, quote: item.text.replace(/\s+/g, ' ').slice(0, 300) })),
            ];
            const stored = await chatRepository.appendExchange({
              householdId, threadId,
              user: { text: message, inputKind, audioDocumentId },
              assistant: {
                text, intent, answerSource, provider: assistantMeta.provider ?? null, model: assistantMeta.model ?? null, redactedPromptHash: assistantMeta.redactedPromptHash ?? null,
                tokensIn: assistantMeta.tokensIn ?? 0, tokensOut: assistantMeta.tokensOut ?? 0,
                costPaise: assistantMeta.costUsd ? Math.ceil(assistantMeta.costUsd * (Number(env.COST_PAISE_PER_USD) > 0 ? Number(env.COST_PAISE_PER_USD) : 9000)) : 0,
                latencyMs: Date.now() - startedAt,
              },
              consent: answerSource === 'model' ? { grantId: chatGrantId, adultId: principal.adultId } : null,
              trace: { mode, holdingIds: context.holdingIds, factIds, chunkIds: [...new Set([...passages.map(item => item.id)])], conflictIds: context.conflicts.map(item => item.id) },
            });

            for (let at = 0; at < text.length; at += DELTA_CHARS) emit('delta', { text: text.slice(at, at + DELTA_CHARS) });
            emit('answer', {
              turn_id: stored.assistantTurnId, status, intent, answer: text, answer_source: answerSource,
              ...(assistantMeta.modelStatus ? { model_status: assistantMeta.modelStatus } : {}),
              facts_used: usedFacts.map(factView),
              sources,
              computed: plan ? { version: plan.version, checks: plan.checks.map(check => ({ id: check.id, status: check.status, detail: check.detail, fact_ids: check.factIds })), summary: plan.summary, missing_inputs: plan.missingInputs } : null,
              open_conflicts: context.conflicts.filter(item => byKey.has(item.factKey)).map(item => ({ conflict_id: item.id, fact_key: item.factKey, holding_id: item.holdingId })),
              audio_retained: audioDocumentId !== null, created_at: clock().toISOString(),
            });
            emit('done', {});
            // Counts for product analytics (ADR 0033). The route reads this; it is never sent to the client.
            return Object.freeze({
              householdId, intent: CHAT_INTENTS.includes(intent) ? intent : 'unknown', provider: ANALYTICS_PROVIDERS.includes(assistantMeta.provider) ? assistantMeta.provider : 'none',
              tokens: (assistantMeta.tokensIn ?? 0) + (assistantMeta.tokensOut ?? 0), ms: Date.now() - startedAt, factsUsed: usedFacts.length,
            });
          } catch (error) {
            emit('error', { code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(error.code) ? error.code : 'CHAT_TURN_FAILED' });
            return null;
          }
        },
      };
    },
  });
}
