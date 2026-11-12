import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { fail, invalid, requireScopedGrant, str } from './holdings-common.js';
import { CHAT_CONSENT_PURPOSE, EMBED_SCOPE } from '../../contracts/data-purpose-registry.js';

// Memory chunks (migration 053, ADR 0031): redacted passages of one household's memory with their embeddings.
//
//   * Every query is scoped by household_id first. The text is sealed (AAD memory_chunks.chunk_text_enc.<row id>) and is the REDACTED
//     passage that was embedded. The embedding is plaintext (pgvector cannot index ciphertext; ADR 0031 records the leak).
//   * `replace` runs in one transaction under the household lock and re-checks, at the moment of the write, the document grant the chunks
//     were derived from AND the embedding provider's grant (purpose, scope, recipient voyage; rows carry the latter): a revoked, expired or
//     mismatched grant writes nothing (the privacy invariant "re-check consent before commit").
//   * Rows are replaced, never edited; erasure DELETES (memory-erasure.js).
//   * Vectors travel as pgvector text literals "[0.1,0.2,...]" cast to extensions.vector; the operator is schema-qualified because the
//     extension lives in the `extensions` schema.

const CHUNKS = 'memory_chunks';
const DIMENSIONS = 1024;
const MAX_WRITE = 200;
const MAX_TOP_K = 20;
const SCOPES = new Set(['own_pdf', 'confirmed_fact', 'declaration', 'chat_summary']);
const SHA = /^[0-9a-f]{64}$/;
const SOURCE_REF = /^[a-z0-9_.:-]{1,100}$/;

export const vectorLiteral = vector => {
  if (!Array.isArray(vector) || vector.length !== DIMENSIONS || vector.some(value => !Number.isFinite(value))) invalid('The embedding is invalid.');
  return `[${vector.join(',')}]`;
};

export class MemoryChunkRepository {
  constructor(database, { clock = () => new Date(), ...options } = {}) {
    if (!database || typeof database.transaction !== 'function') throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.crypto = resolveColumnCrypto(options);
  }

  /** What is stored for a holding: [{ scope, sourceRef, contentSha256 }]. No text. Used to skip passages that need no new embedding. */
  async stored({ householdId, holdingId }) {
    str(householdId, 'householdId'); str(holdingId, 'holdingId');
    const rows = await this.database.many('SELECT scope, source_ref, content_sha256 FROM memory_chunks WHERE household_id = ? AND holding_id = ? LIMIT 1000', [householdId, holdingId]);
    return rows.map(row => ({ scope: row.scope, sourceRef: row.source_ref, contentSha256: row.content_sha256 }));
  }

  /**
   * Makes the stored passages of a holding match `desired` for the given scopes: rows whose (scope, sourceRef) is no longer desired,
   * or whose sha changed, are deleted; `chunks` (the new or changed ones, with embeddings) are inserted. Resolves counts only.
   * desired: [{ scope, sourceRef, contentSha256 }]. chunks: [{ scope, sourceRef, text, contentSha256, embedding, tokenCount, sourceDocumentId }].
   */
  async replace({ householdId, holdingId, consentGrantId, embedGrantId, scopes, desired, chunks, embeddingModel }) {
    str(householdId, 'householdId'); str(holdingId, 'holdingId'); str(consentGrantId, 'consentGrantId'); str(embedGrantId, 'embedGrantId'); str(embeddingModel, 'embeddingModel', 120);
    if (!Array.isArray(scopes) || scopes.some(scope => !SCOPES.has(scope))) invalid('scopes are invalid.');
    if (!Array.isArray(desired) || desired.length > MAX_WRITE || !Array.isArray(chunks) || chunks.length > MAX_WRITE) invalid('Too many passages.');
    for (const item of [...desired, ...chunks]) {
      if (!SCOPES.has(item.scope) || !scopes.includes(item.scope) || !SOURCE_REF.test(item.sourceRef) || !SHA.test(item.contentSha256)) invalid('A passage is invalid.');
    }
    const wanted = new Map(desired.map(item => [`${item.scope}|${item.sourceRef}`, item.contentSha256]));
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      const grant = await db.one(`SELECT id FROM consent_grants WHERE id = ? AND household_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR julianday(expires_at) > julianday(?)) FOR SHARE`, [consentGrantId, householdId, at]);
      if (!grant) fail('CONSENT_REQUIRED', 'Active consent is required before this information can be stored.', 403);
      // The embedding provider's own grant (audit F1): purpose, scope and recipient (voyage) must be exact and current at the write.
      await requireScopedGrant(db, { householdId, grantId: embedGrantId, purpose: CHAT_CONSENT_PURPOSE, scope: EMBED_SCOPE, now: at, lock: true });
      const holding = await db.one('SELECT id FROM policy_holdings WHERE id = ? AND household_id = ?', [holdingId, householdId]);
      if (!holding) fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);
      const existing = await db.many('SELECT id, scope, source_ref, content_sha256 FROM memory_chunks WHERE household_id = ? AND holding_id = ? AND scope = ANY(CAST(? AS text[]))', [householdId, holdingId, scopes]);
      const drop = existing.filter(row => wanted.get(`${row.scope}|${row.source_ref}`) !== row.content_sha256).map(row => row.id);
      if (drop.length > 0) await db.run('DELETE FROM memory_chunks WHERE household_id = ? AND id = ANY(CAST(? AS text[]))', [householdId, drop]);
      let written = 0;
      for (const chunk of chunks) {
        const id = `mchunk-${randomUUID()}`;
        const inserted = await db.run(`INSERT INTO memory_chunks (id, household_id, holding_id, scope, source_ref, chunk_text_enc, content_sha256, embedding, embedding_model,
            token_count, source_document_id, consent_grant_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS extensions.vector), ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING`, [id, householdId, holdingId, chunk.scope, chunk.sourceRef, this.crypto.seal(CHUNKS, 'chunk_text_enc', id, chunk.text), chunk.contentSha256,
          vectorLiteral(chunk.embedding), embeddingModel, Math.max(0, Math.trunc(chunk.tokenCount ?? 0)), chunk.sourceDocumentId ?? null, embedGrantId, at]);
        written += inserted.changes;
      }
      return Object.freeze({ written, removed: drop.length });
    }, { locks: [householdLock(householdId)] });
  }

  /**
   * The k passages of this household nearest to `embedding` (cosine), optionally only for some holdings. The text is opened for the
   * owning household's own answer: it is redacted already. Resolves [{ id, scope, sourceRef, holdingId, text, score }].
   */
  async search({ householdId, holdingIds = null, embedding, limit = 5 }) {
    str(householdId, 'householdId');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TOP_K) invalid('limit is out of range.');
    if (holdingIds !== null && (!Array.isArray(holdingIds) || holdingIds.length === 0 || holdingIds.length > 50)) invalid('holdingIds are invalid.');
    const literal = vectorLiteral(embedding);
    const scoped = holdingIds ? 'AND holding_id = ANY(CAST(? AS text[]))' : '';
    const rows = await this.database.many(`SELECT id, scope, source_ref, holding_id, source_document_id, chunk_text_enc,
        1 - (embedding OPERATOR(extensions.<=>) CAST(? AS extensions.vector)) AS score
      FROM memory_chunks WHERE household_id = ? ${scoped} AND scope IN ('own_pdf', 'confirmed_fact', 'declaration')
      ORDER BY embedding OPERATOR(extensions.<=>) CAST(? AS extensions.vector) LIMIT ?`,
    [literal, householdId, ...(holdingIds ? [holdingIds] : []), literal, limit]);
    return rows.map(row => Object.freeze({
      id: row.id, scope: row.scope, sourceRef: row.source_ref, holdingId: row.holding_id, sourceDocumentId: row.source_document_id ?? null,
      text: this.crypto.open(CHUNKS, 'chunk_text_enc', row.id, row.chunk_text_enc), score: Number(row.score),
    }));
  }

  async count({ householdId, holdingId = null }) {
    str(householdId, 'householdId');
    const row = holdingId
      ? await this.database.one('SELECT count(*)::int AS n FROM memory_chunks WHERE household_id = ? AND holding_id = ?', [householdId, holdingId])
      : await this.database.one('SELECT count(*)::int AS n FROM memory_chunks WHERE household_id = ?', [householdId]);
    return row.n;
  }
}
