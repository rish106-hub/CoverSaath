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
const MAX_CASE_DOCUMENTS = 20;
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

// Numbers as comparable tokens: thousands separators dropped, leading zeros and trailing decimal zeros normalised.
const numbersIn = text => (String(text ?? '').replace(/\{\{[A-Z_]+\d*\}\}/g, ' ').match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(token => String(Number(token.replace(/,/g, ''))));
export function numbersSupported(answer, sources) {
  const allowed = new Set(sources.flatMap(numbersIn));
  return numbersIn(answer).every(number => allowed.has(number));
}

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
  async function gatherContext({ householdId, thread, mayReadFacts }) {
    const holdingRows = thread.holdingId ? [{ id: thread.holdingId }]
      : await database.many(`SELECT id FROM policy_holdings WHERE household_id = ? AND status IN ('parsed', 'conflicts', 'ready') ORDER BY created_at, id LIMIT ?`, [householdId, MAX_HOLDINGS]);
    const facts = [];
    const conflicts = [];
    const documents = [];
    const places = new Map();
    for (const { id: holdingId } of holdingRows) {
      // Audit F7: holding facts and conflicts are owner-only (holding-facts-routes.js); a non-owner member gets neither here.
      if (!mayReadFacts) {
        const holding = await holdingRepository.getHolding({ householdId, holdingId });
        if (holding?.documentId) documents.push({ holdingId, documentId: holding.documentId });
        continue;
      }
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

  // Wording of the case: the holding's own document (the schedule) and every other active document of the same household case (the T&C
  // wording uploaded beside it). Household and case scoped; ranked in code (clause-repository.js), no provider involved. Hits carry their own document id.
  async function keywordClauses({ householdId, documents, message }) {
    if (!clauses) return [];
    const found = [];
    const searched = new Set();
    for (const { documentId } of documents) {
      const row = await database.one(`SELECT case_id FROM document_uploads WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
      if (!row?.case_id || searched.has(row.case_id)) continue;
      searched.add(row.case_id);
      const siblings = await database.many(`SELECT id FROM document_uploads WHERE household_id = ? AND case_id = ? AND lifecycle_state = 'active' ORDER BY id LIMIT ?`, [householdId, row.case_id, MAX_CASE_DOCUMENTS]);
      const documentIds = [...new Set([documentId, ...siblings.map(item => item.id)])];
      const hits = await clauses.searchClauses({ householdId, caseId: row.case_id, documentIds, query: message, limit: KEYWORD_K });
      for (const hit of hits) found.push({ id: hit.clauseId, documentId: hit.documentId, page: hit.page ?? null, text: hit.text });
    }
    return found.slice(0, KEYWORD_K);
  }

  // Audit F5 + owner scope: a wording answer names the policy document and page it rests on. Pages come from policy_clauses; a stored passage
  // knows its clause only by hash (memory-service.js), so the hash is matched here. Ids shown are document ids, never text.
  async function wordingSources({ householdId, passageList, clauseList }) {
    const out = [];
    const seen = new Set();
    const push = (documentId, page, ref) => { const key = `${documentId}|${page}|${ref}`; if (documentId && !seen.has(key)) { seen.add(key); out.push({ kind: 'wording', document_id: documentId, page, ref }); } };
    for (const clause of clauseList) push(clause.documentId, clause.page, `clause:${createHash('sha256').update(clause.id).digest('hex').slice(0, 32)}`);
    const byDocument = new Map();
    for (const passage of passageList.filter(item => item.scope === 'own_pdf' && item.sourceDocumentId)) {
      if (!byDocument.has(passage.sourceDocumentId)) {
        const rows = await database.many(`SELECT id, page FROM policy_clauses WHERE household_id = ? AND document_id = ?`, [householdId, passage.sourceDocumentId]);
        byDocument.set(passage.sourceDocumentId, new Map(rows.map(row => [`clause:${createHash('sha256').update(row.id).digest('hex').slice(0, 32)}`, row.page ?? null])));
      }
      push(passage.sourceDocumentId, byDocument.get(passage.sourceDocumentId).get(passage.sourceRef) ?? null, passage.sourceRef);
    }
    return out;
  }

  // Words a short answer over redacted facts. Resolves { text, factsUsed, meta } or null (use the deterministic answer).
  async function modelAnswer({ householdId, adultId, message, history, context, relevant, plan, passages, startedAt }) {
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
      aliasToFact.set(key, { fact, checkFactIds, text: value });
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
      aliasToFact.set(key, { chunkId: passage.id, text: passage.text });
      slots.push({ fact_id: key, label: gateText('Policy passage', { knownIdentifiers: [] }), value: gateText(text, { regate: true, knownIdentifiers: [] }) });
    }
    const historyGated = [];
    for (const turn of history) {
      try { historyGated.push({ role: turn.role, text: (await gateTextForHousehold(turn.text, { householdId, loadKnownIdentifiers: loader })).gated }); } catch { /* a turn the gate refuses is left out */ }
    }
    const input = sealModelInput('chat_answer', { payload: { question: question.gated, history: historyGated, facts: slots } });
    const redactedPromptHash = sha256(JSON.stringify({ q: question.gated.text, h: historyGated.map(turn => turn.text.text), f: slots.map(slot => [slot.fact_id, slot.label.text, slot.value.text]) }));
    let result;
    // Each provider in the failover chain needs its own current exact grant (resolved here, re-checked right before that dispatch: audit F1);
    // a provider without one is skipped, never sent to. The commit re-checks the winning provider's grant again inside the transaction.
    const authorize = async provider => {
      const grantId = await providerConsent.resolve({ householdId, adultId, kind: 'chat', provider });
      if (!grantId) return null;
      await providerConsent.require({ householdId, adultId, grantId, kind: 'chat', provider });
      return { grantId };
    };
    try {
      if (gateway.callRouted) result = await gateway.callRouted({ task: 'chat_answer', input, householdId, authorize });
      else {
        // A gateway without a failover chain (a test fixture): one call, still under the anthropic grant.
        const authorization = await authorize('anthropic');
        if (!authorization) return { failed: 'consent_required' };
        result = { ...(await gateway.call({ task: 'chat_answer', input, householdId })), authorization };
      }
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
    // Audit F5: code, not the model, decides that the cited evidence supports the numbers. Every number in the answer must appear in
    // the formatted value of a cited fact or passage, or in a computed check; otherwise the deterministic answer stands.
    const allowed = [...result.output.factsUsed.map(key => aliasToFact.get(key)?.text ?? ''), ...(plan?.checks ?? []).map(check => check.detail)];
    const answerText = question.rehydrate(result.output.answer);
    if (!numbersSupported(answerText, allowed)) return { failed: 'numbers_unverified' };
    return {
      text: answerText, usedFacts, usedChunks, redactedPromptHash, grantId: result.authorization?.grantId ?? null,
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
            const mayReadFacts = await chatRepository.mayReadHoldingFacts({ householdId, adultId: principal.adultId });
            const context = await gatherContext({ householdId, thread, mayReadFacts });
            const conflictKeys = new Set(context.conflicts.map(item => item.factKey));
            const byKey = new Set(factKeys);
            const relevant = intent === 'procedure_planning' ? context.facts.filter(fact => fact.status !== 'extracted_unverified') : [...context.facts.filter(fact => byKey.has(fact.factKey)), ...context.facts.filter(fact => !byKey.has(fact.factKey))];
            const plan = intent === 'procedure_planning'
              ? planProcedure({ facts: Object.fromEntries(context.facts.filter(fact => fact.status !== 'extracted_unverified').map(fact => [fact.factKey, { id: fact.sourceIds[0], status: fact.status, value: fact.value }])), procedure: procedure ?? {} }) : null;

            // Retrieval beyond facts: vector top-k, else a keyword match over clauses (only when no confirmed fact answers the topic).
            let mode = 'facts_only';
            let passages = [];
            const answersTopic = factKeys.some(key => context.facts.some(fact => fact.factKey === key));
            if (mayReadFacts && !answersTopic && intent !== 'procedure_planning') { // passages embed confirmed facts: owner only (audit F7)
              // An embedding failure is not a turn failure: it leaves the vector undefined and the keyword path below answers.
              let vector = null;
              try { vector = await memory.embedQuery({ householdId, adultId: principal.adultId, text: message }); } catch { vector = null; }
              if (vector) {
                passages = await chunks.search({ householdId, holdingIds: context.holdingIds.length ? context.holdingIds : null, embedding: vector, limit: VECTOR_K });
                // Zero vector hits fall through to the keyword path (same household scope); only a vector that found passages stays 'vector'.
                if (passages.length > 0) mode = 'vector';
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
            // No current chat grant for any ready provider (purpose + recipient + scope) means no model call: the deterministic answer stands (audit F1).
            const model = (context.facts.length > 0 || passages.length > 0)
              ? await modelAnswer({ householdId, adultId: principal.adultId, message, history, context, relevant, plan, passages, startedAt }) : null;

            let text = deterministic.text;
            let answerSource = 'deterministic';
            let usedFacts = deterministic.usedFacts;
            let usedChunks = [];
            let assistantMeta = {};
            if (model && !model.failed) {
              text = model.text; answerSource = 'model'; usedFacts = model.usedFacts; usedChunks = model.usedChunks;
              assistantMeta = { ...model.meta, redactedPromptHash: model.redactedPromptHash };
            } else if (model?.failed) assistantMeta = { modelStatus: model.failed };

            const citedPassages = passages.filter(item => usedChunks.includes(item.id));
            const sources = await wordingSources({ householdId, passageList: answerSource === 'model' ? citedPassages : [], clauseList: answerSource === 'model' ? [] : clauseHits });
            // Code owns the status: an answer that rests on no fact, chunk or computed check is "unknown".
            const status = usedFacts.length > 0 || usedChunks.length > 0 || sources.length > 0 || (plan?.checks.length ?? 0) > 0 ? 'evidence_found' : 'unknown';
            const factIds = [...new Set(usedFacts.map(fact => fact.sourceIds[0]))];
            // Own-document readings the answer rests on, with their verbatim quote, document and page (status stays extracted_unverified).
            for (const fact of usedFacts) {
              const place = context.places.get(fact.sourceIds[0]);
              if (place?.documentId) sources.push({ kind: 'fact', fact_id: fact.sourceIds[0], fact_key: fact.factKey, status: fact.status, document_id: place.documentId, page: place.page, quote: place.quote });
            }
            const stored = await chatRepository.appendExchange({
              householdId, threadId,
              user: { text: message, inputKind, audioDocumentId },
              assistant: {
                text, intent, answerSource, provider: assistantMeta.provider ?? null, model: assistantMeta.model ?? null, redactedPromptHash: assistantMeta.redactedPromptHash ?? null,
                tokensIn: assistantMeta.tokensIn ?? 0, tokensOut: assistantMeta.tokensOut ?? 0,
                costPaise: assistantMeta.costUsd ? Math.ceil(assistantMeta.costUsd * (Number(env.COST_PAISE_PER_USD) > 0 ? Number(env.COST_PAISE_PER_USD) : 9000)) : 0,
                latencyMs: Date.now() - startedAt,
              },
              consent: answerSource === 'model' ? { grantId: model.grantId, adultId: principal.adultId, provider: assistantMeta.provider } : null,
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
