import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import { isDatabaseInterface } from '../database/postgres/db.js';
import { householdLock } from '../database/postgres/locks.js';
import { CLAUSE_KINDS, ANSWER_STATES } from '../../contracts/policy-evidence.js';

// Storage for evidence-first reasoning (ADR 0008, PostgreSQL migration 012) on the async PostgreSQL
// interface (S3.2). Clauses are deterministic and immutable; answers are immutable. Both are derived
// stores: erasure deletes them and audits counts only. Every read and write is household-scoped.
//
// Retrieval: PostgreSQL has no clause index yet (migration 012), so search builds an English tsvector
// over the clause text and title at query time, bounded by household, case and the given documents.
// English stemming stands in for the SQLite FTS5 porter tokenizer; ranking is ts_rank_cd, not bm25.

const erasureReasons = new Set(['consent_revoked', 'document_erasure', 'source_consent_not_current', 'retention_expired', 'data_subject_request']);
const MAX_CLAUSES_PER_DOCUMENT = 2000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DOCUMENTS = 1000;
const MAX_QUERY_WORDS = 24;
// Insertion order of the SQLite runtime (rowid): page, then the clause's first block.
const CLAUSE_ORDER = "clause.page, CAST(CAST(clause.block_indexes_json AS jsonb) ->> 0 AS bigint), clause.id";
const SEARCH_DOCUMENT = "to_tsvector('english', clause.text || ' ' || coalesce(clause.title, ''))";

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => coded('CLAUSE_INPUT_INVALID', message, 400);
// One error for unknown and foreign documents or answers, so identifiers cannot be probed across households.
const notFound = () => coded('POLICY_EVIDENCE_NOT_FOUND', 'The requested policy evidence was not found.', 404);

const text = (value, name, max = 256) => {
  if (typeof value !== 'string' || !value || value.length > max) throw invalid(`${name} is invalid.`);
  return value;
};

function queryWords(query) {
  const words = String(query ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, MAX_QUERY_WORDS);
}

// Free-text query as quoted, OR-joined whole words. Never passes operators through.
export function ftsQuery(query) {
  return queryWords(query).map(word => `"${word}"`).join(' OR ');
}

// The same words as a PostgreSQL tsquery: letters and digits only, each quoted, OR-joined.
function tsQuery(query) {
  return queryWords(query).map(word => `'${word}'`).join(' | ');
}

export class ClauseRepository {
  constructor(database, { clock = () => new Date(), audit = null } = {}) {
    if (!isDatabaseInterface(database)) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
  }

  // A transaction holding the household lock; inside a caller's transaction it is a savepoint.
  #atomic(householdId, work) {
    return this.database.transaction(work, { locks: [householdLock(householdId)] });
  }

  async #document(householdId, caseId, documentId) {
    const row = await this.database.one(`SELECT id FROM document_uploads
      WHERE id = ? AND household_id = ? AND case_id = ? AND lifecycle_state = 'active'`, [documentId, householdId, caseId]);
    if (!row) throw notFound();
  }

  /** Stores clauses built by buildClauses(). Replays are no-ops; a changed digest for a stored id fails closed. */
  async saveClauses({ householdId, caseId, documentId, clauses }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(documentId, 'documentId');
    if (!Array.isArray(clauses) || clauses.length === 0 || clauses.length > MAX_CLAUSES_PER_DOCUMENT) throw invalid('clauses must be a bounded non-empty array.');
    return this.#atomic(householdId, async () => {
      await this.#document(householdId, caseId, documentId);
      const at = this.clock().toISOString();
      let inserted = 0;
      for (const clause of clauses) {
        if (clause.documentId !== documentId) throw invalid('Every clause must belong to the document.');
        if (!CLAUSE_KINDS.includes(clause.kind)) throw invalid('Clause kind is invalid.');
        const existing = await this.database.one('SELECT digest, document_id, household_id FROM policy_clauses WHERE id = ?', [clause.clauseId]);
        if (existing) {
          if (existing.household_id !== householdId || existing.document_id !== documentId || existing.digest !== clause.digest) {
            throw coded('CLAUSE_DIGEST_CONFLICT', 'A stored clause differs from the rebuilt clause.', 409);
          }
          continue;
        }
        await this.database.run(`INSERT INTO policy_clauses
          (id, household_id, case_id, document_id, source_version, page, block_indexes_json, title, kind, text, digest, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          clause.clauseId, householdId, caseId, documentId, clause.sourceVersion, clause.page,
          JSON.stringify(clause.blockIndexes), clause.sectionPath?.[0] ?? null, clause.kind, clause.text, clause.digest, at,
        ]);
        inserted += 1;
      }
      return Object.freeze({ inserted, total: clauses.length });
    });
  }

  #shape(row) {
    return Object.freeze({
      clauseId: row.id, documentId: row.document_id, sourceVersion: row.source_version, page: row.page,
      blockIndexes: JSON.parse(row.block_indexes_json), sectionPath: row.title ? [row.title] : [], kind: row.kind,
      text: row.text, digest: row.digest,
    });
  }

  async listClauses({ householdId, caseId, documentIds }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > 20) throw invalid('documentIds must be 1 to 20 ids.');
    const listed = [];
    for (const documentId of documentIds) {
      const rows = await this.database.many(`SELECT clause.* FROM policy_clauses clause
        WHERE clause.household_id = ? AND clause.case_id = ? AND clause.document_id = ? ORDER BY ${CLAUSE_ORDER}`,
      [householdId, caseId, text(documentId, 'documentId')]);
      for (const row of rows) listed.push(this.#shape(row));
    }
    return listed;
  }

  /** Word retrieval, household and case scoped; optional kind filter. Ranked by ts_rank_cd. */
  async searchClauses({ householdId, caseId, documentIds, query, kinds = null, limit = 20 }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > MAX_SEARCH_DOCUMENTS) throw invalid('documentIds are required.');
    documentIds.forEach(documentId => text(documentId, 'documentIds'));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw invalid('limit is out of range.');
    if (kinds !== null && (!Array.isArray(kinds) || kinds.some(kind => !CLAUSE_KINDS.includes(kind)))) throw invalid('kinds are invalid.');
    const match = tsQuery(query);
    if (!match) return [];
    const rows = await this.database.many(`SELECT clause.* FROM policy_clauses clause,
        to_tsquery('english', ?) AS search
      WHERE clause.household_id = ? AND clause.case_id = ? AND clause.document_id = ANY(CAST(? AS text[]))
        ${kinds ? 'AND clause.kind = ANY(CAST(? AS text[]))' : ''}
        AND ${SEARCH_DOCUMENT} @@ search
      ORDER BY ts_rank_cd(${SEARCH_DOCUMENT}, search) DESC, ${CLAUSE_ORDER} LIMIT ?`,
    [match, householdId, caseId, documentIds, ...(kinds ? [kinds] : []), limit]);
    return rows.map(row => this.#shape(row));
  }

  /**
   * Stores an immutable answer. A replayed idempotency key with the same request digest returns the stored one.
   * consentCheck (sync or async) is awaited inside the transaction, immediately before the write; a throw or a
   * rejection writes nothing.
   */
  async saveAnswer({ id = `answer-${randomUUID()}`, householdId, caseId, requestedByAdultId, idempotencyKey, requestDigest, question, answer, consentCheck = null, access }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(requestedByAdultId, 'requestedByAdultId');
    text(idempotencyKey, 'idempotencyKey', 128); text(requestDigest, 'requestDigest', 64); text(question, 'question', 2000);
    if (!ANSWER_STATES.includes(answer?.state)) throw invalid('Answer state is invalid.');
    if (Object.hasOwn(answer, 'access')) throw invalid('Answer must not carry access metadata.');
    if (consentCheck !== null && typeof consentCheck !== 'function') throw invalid('consentCheck must be a function.');
    // Access metadata lets reads re-check the question grant later (consent expiry). It is stored with the answer and
    // never returned inside it.
    text(access?.consentGrantId, 'access.consentGrantId'); text(access?.subjectAdultId, 'access.subjectAdultId');
    if (!Array.isArray(access.documentIds) || !access.documentIds.length || access.documentIds.length > 20) throw invalid('access.documentIds is invalid.');
    access.documentIds.forEach(documentId => text(documentId, 'access.documentIds'));
    const documentIds = [...new Set(answer.sources.map(source => source.documentId).concat(answer.documentIds ?? [], access.documentIds))];
    return this.#atomic(householdId, async () => {
      const existing = await this.database.one('SELECT * FROM policy_answers WHERE household_id = ? AND case_id = ? AND idempotency_key = ?',
        [householdId, caseId, idempotencyKey]);
      if (existing) {
        if (existing.request_digest !== requestDigest) throw coded('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.', 409);
        return { replayed: true, ...this.#answer(existing) };
      }
      // Consent is re-checked inside the transaction, immediately before the answer is written.
      if (consentCheck) await consentCheck();
      await this.database.run(`INSERT INTO policy_answers
        (id, household_id, case_id, requested_by_adult_id, idempotency_key, request_digest, question, state, document_ids_json, answer_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        id, householdId, caseId, requestedByAdultId, idempotencyKey, requestDigest, question, answer.state,
        JSON.stringify(documentIds), JSON.stringify({ ...answer, access: { consentGrantId: access.consentGrantId, subjectAdultId: access.subjectAdultId, documentIds: [...access.documentIds] } }),
        this.clock().toISOString(),
      ]);
      return { replayed: false, ...this.#answer(await this.database.one('SELECT * FROM policy_answers WHERE id = ?', [id])) };
    });
  }

  #answer(row) {
    const { access = null, ...answer } = JSON.parse(row.answer_json);
    return { answerId: row.id, caseId: row.case_id, createdAt: row.created_at, answer, access };
  }

  /** Stored answer for an idempotency key, so a replay is served before any paid work. Null when none. */
  async findAnswerByKey({ householdId, caseId, idempotencyKey, requestDigest }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(idempotencyKey, 'idempotencyKey', 128);
    const row = await this.database.one('SELECT * FROM policy_answers WHERE household_id = ? AND case_id = ? AND idempotency_key = ?',
      [householdId, caseId, idempotencyKey]);
    if (!row) return null;
    if (row.request_digest !== requestDigest) throw coded('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.', 409);
    return { replayed: true, ...this.#answer(row) };
  }

  /** Document ids that already have clauses stored for the case. */
  async clauseDocumentIds({ householdId, caseId }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    return (await this.database.many('SELECT DISTINCT document_id AS id FROM policy_clauses WHERE household_id = ? AND case_id = ? ORDER BY document_id',
      [householdId, caseId])).map(row => row.id);
  }

  async getAnswer({ householdId, caseId, answerId }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(answerId, 'answerId');
    const row = await this.database.one('SELECT * FROM policy_answers WHERE id = ? AND household_id = ? AND case_id = ?', [answerId, householdId, caseId]);
    if (!row) throw notFound();
    return this.#answer(row);
  }

  /**
   * Deletes clauses and answers citing the documents, and catalogue reviews of the documents. Counts-only audit.
   * Joins the caller's transaction (savepoint) and takes the household lock first.
   */
  async eraseDerived({
    householdId = null, documentIds = [], reasonCode, caseId = null, resourceType = 'document', resourceId = null,
    actorType = 'system', actorId = 'clause-repository',
  } = {}) {
    if (!erasureReasons.has(reasonCode)) throw invalid('reasonCode is not supported.');
    if (!Array.isArray(documentIds)) throw invalid('documentIds must be an array.');
    // A NULL household erases by document id across households, as before; it is never a filter value.
    const scoped = householdId !== null;
    const householdFilter = scoped ? ' AND household_id = ?' : '';
    const householdParams = scoped ? [householdId] : [];
    return this.#atomic(householdId, async () => {
      let answers = 0;
      let clauses = 0;
      let reviews = 0;
      for (const documentId of new Set(documentIds)) {
        // Reviewed facts cite clauses of the document, so they are derived data too (ADR 0009).
        reviews += (await this.database.run(`DELETE FROM catalogue_reviews WHERE document_id = ?${householdFilter}`,
          [documentId, ...householdParams])).changes;
        answers += (await this.database.run(`DELETE FROM policy_answers
          WHERE EXISTS (SELECT 1 FROM json_array_elements_text(CAST(policy_answers.document_ids_json AS json)) AS cited(value)
            WHERE cited.value = ?)${householdFilter}`, [documentId, ...householdParams])).changes;
        clauses += (await this.database.run(`DELETE FROM policy_clauses WHERE document_id = ?${householdFilter}`,
          [documentId, ...householdParams])).changes;
      }
      const counts = Object.freeze({ clauses, answers, reviews });
      if (clauses > 0 || answers > 0 || reviews > 0) {
        await this.audit.append({
          householdId, caseId, actorType, actorId, action: 'policy_evidence.erased', resourceType,
          resourceId: resourceId ?? documentIds[0] ?? 'policy_evidence',
          payload: { reasonCode, ...counts, documents: new Set(documentIds).size },
        });
      }
      return counts;
    });
  }
}
