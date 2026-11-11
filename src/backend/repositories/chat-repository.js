import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { fail, requirePerson, str } from './holdings-common.js';

// Chat v1 storage (migration 054, ADR 0029 and 0031): threads, turns and retrieval traces.
//
//   * Every read and write is scoped to a household the acting adult can see (requirePerson); a thread of another household answers the
//     same 404 as a missing one (CHAT_THREAD_NOT_FOUND). Content is sealed (AAD chat_turns.content_enc.<row id>, transcript_enc likewise).
//   * A turn and its trace are written together in one transaction under the household lock, so a thread never shows an answer without
//     the trace that explains it. Turn indexes are assigned inside that transaction.
//   * The voice fields (transcript, audio document) belong to a user turn of input kind voice. The audio document id is stored only when
//     the caller passes it, and the service passes it only under VOICE_AUDIO_RETAIN exactly "true" (ADR 0029).
//   * Rows are deleted, never redacted, on erasure (memory-erasure.js).

const TURNS = 'chat_turns';
const HISTORY_LIMIT = 8;
const ID_LIST = 200;
const notFound = () => fail('CHAT_THREAD_NOT_FOUND', 'The chat thread was not found.', 404);
const ids = (list, name) => {
  if (!Array.isArray(list) || list.length > ID_LIST || list.some(item => typeof item !== 'string' || item.length === 0 || item.length > 100)) throw fail('INVALID_REQUEST', `${name} is invalid.`, 400);
  return list;
};

export class ChatRepository {
  constructor(database, { clock = () => new Date(), households, ...options } = {}) {
    if (!database || !households) throw new TypeError('A database and households are required.');
    this.database = database;
    this.clock = clock;
    this.households = households;
    this.crypto = resolveColumnCrypto(options);
  }

  #thread(row) { return Object.freeze({ id: row.id, householdId: row.household_id, holdingId: row.holding_id, createdAt: row.created_at, updatedAt: row.updated_at }); }

  async createThread({ householdId, adultId, holdingId = null }) {
    str(householdId, 'householdId'); str(adultId, 'adultId');
    const at = this.clock().toISOString();
    const db = this.database;
    return db.transaction(async () => {
      await requirePerson(this.households, householdId, adultId, { write: true });
      if (holdingId !== null && !(await db.one('SELECT id FROM policy_holdings WHERE id = ? AND household_id = ?', [str(holdingId, 'holdingId'), householdId]))) fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);
      const id = `thread-${randomUUID()}`;
      await db.run('INSERT INTO chat_threads (id, household_id, holding_id, created_by_adult_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, householdId, holdingId, adultId, at, at]);
      return this.#thread({ id, household_id: householdId, holding_id: holdingId, created_at: at, updated_at: at });
    }, { locks: [householdLock(householdId)] });
  }

  /** The thread when the adult may use it (member of its household), else the same 404 as a missing thread. */
  async getThread({ threadId, adultId, write = false }) {
    str(threadId, 'threadId'); str(adultId, 'adultId');
    const row = await this.database.one('SELECT * FROM chat_threads WHERE id = ?', [threadId]);
    if (!row) throw notFound();
    try { await requirePerson(this.households, row.household_id, adultId, { write }); } catch { throw notFound(); }
    return this.#thread(row);
  }

  /** The last few turns, oldest first, opened for the owning household's own prompt history (still gated before any provider). */
  async recentTurns({ householdId, threadId, limit = HISTORY_LIMIT }) {
    const rows = await this.database.many(`SELECT * FROM chat_turns WHERE household_id = ? AND thread_id = ? ORDER BY turn_index DESC LIMIT ?`, [householdId, threadId, Math.min(Math.max(limit, 1), 50)]);
    return rows.reverse().map(row => Object.freeze({ id: row.id, index: row.turn_index, role: row.role, text: this.crypto.open(TURNS, 'content_enc', row.id, row.content_enc), intent: row.intent, answerSource: row.answer_source }));
  }

  /**
   * Writes the user turn, the assistant turn and the trace of one exchange atomically. `user`: { text, inputKind, audioDocumentId }.
   * `assistant`: { text, intent, answerSource, provider, model, redactedPromptHash, tokensIn, tokensOut, costPaise, latencyMs }.
   * `trace`: { mode, holdingIds, factIds, chunkIds, conflictIds }. Resolves { userTurnId, assistantTurnId, traceId }.
   */
  async appendExchange({ householdId, threadId, user, assistant, trace }) {
    str(householdId, 'householdId'); str(threadId, 'threadId');
    const db = this.database;
    const at = this.clock().toISOString();
    const inputKind = user.inputKind === 'voice' ? 'voice' : 'text';
    return db.transaction(async () => {
      const thread = await db.one('SELECT id FROM chat_threads WHERE id = ? AND household_id = ? FOR UPDATE', [threadId, householdId]);
      if (!thread) throw notFound();
      const next = (await db.one('SELECT COALESCE(MAX(turn_index) + 1, 0)::int AS n FROM chat_turns WHERE household_id = ? AND thread_id = ?', [householdId, threadId])).n;
      const userId = `turn-${randomUUID()}`;
      const assistantId = `turn-${randomUUID()}`;
      const traceId = `trace-${randomUUID()}`;
      await db.run(`INSERT INTO chat_turns (id, household_id, thread_id, turn_index, role, input_kind, content_enc, transcript_enc, audio_document_id, created_at)
        VALUES (?, ?, ?, ?, 'user', ?, ?, ?, ?, ?)`, [userId, householdId, threadId, next, inputKind, this.crypto.seal(TURNS, 'content_enc', userId, user.text),
        inputKind === 'voice' ? this.crypto.seal(TURNS, 'transcript_enc', userId, user.text) : null, inputKind === 'voice' ? user.audioDocumentId ?? null : null, at]);
      await db.run(`INSERT INTO chat_turns (id, household_id, thread_id, turn_index, role, input_kind, content_enc, intent, answer_source, provider, model, redacted_prompt_hash,
          tokens_in, tokens_out, cost_paise, latency_ms, created_at)
        VALUES (?, ?, ?, ?, 'assistant', 'text', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [assistantId, householdId, threadId, next + 1, this.crypto.seal(TURNS, 'content_enc', assistantId, assistant.text),
        assistant.intent ?? null, assistant.answerSource ?? null, assistant.provider ?? null, assistant.model ?? null, assistant.redactedPromptHash ?? null,
        assistant.tokensIn ?? 0, assistant.tokensOut ?? 0, assistant.costPaise ?? 0, assistant.latencyMs ?? 0, at]);
      await db.run(`INSERT INTO retrieval_traces (id, household_id, thread_id, turn_id, mode, holding_ids, fact_ids, chunk_ids, conflict_ids, created_at)
        VALUES (?, ?, ?, ?, ?, CAST(? AS text[]), CAST(? AS text[]), CAST(? AS text[]), CAST(? AS text[]), ?)`, [traceId, householdId, threadId, assistantId, trace.mode, ids(trace.holdingIds ?? [], 'holdingIds'),
        ids(trace.factIds ?? [], 'factIds'), ids(trace.chunkIds ?? [], 'chunkIds'), ids(trace.conflictIds ?? [], 'conflictIds'), at]);
      await db.run('UPDATE chat_threads SET updated_at = ? WHERE id = ?', [at, threadId]);
      return Object.freeze({ userTurnId: userId, assistantTurnId: assistantId, traceId });
    }, { locks: [householdLock(householdId)] });
  }

  /** Counts for a household (a test or operator read). */
  async counts({ householdId }) {
    const one = async table => (await this.database.one(`SELECT count(*)::int AS n FROM ${table} WHERE household_id = ?`, [householdId])).n;
    return { threads: await one('chat_threads'), turns: await one('chat_turns'), traces: await one('retrieval_traces') };
  }

  async trace({ householdId, turnId }) {
    const row = await this.database.one('SELECT * FROM retrieval_traces WHERE household_id = ? AND turn_id = ?', [householdId, turnId]);
    return row ? Object.freeze({ id: row.id, threadId: row.thread_id, turnId: row.turn_id, mode: row.mode, holdingIds: row.holding_ids, factIds: row.fact_ids, chunkIds: row.chunk_ids, conflictIds: row.conflict_ids }) : null;
  }
}
