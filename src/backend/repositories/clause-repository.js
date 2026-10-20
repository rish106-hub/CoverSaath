import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import { CLAUSE_KINDS, ANSWER_STATES } from '../../contracts/policy-evidence.js';

// Storage for evidence-first reasoning (ADR 0008, SQLite migrations 015 and 016, PostgreSQL 012).
// Clauses are deterministic and immutable; answers are immutable. Both are derived stores: erasure deletes
// them (and their FTS rows by trigger) and audits counts only. Every read and write is household-scoped.

const erasureReasons = new Set(['consent_revoked', 'document_erasure', 'source_consent_not_current', 'retention_expired', 'data_subject_request']);
const MAX_CLAUSES_PER_DOCUMENT = 2000;
const MAX_SEARCH_RESULTS = 100;

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => coded('CLAUSE_INPUT_INVALID', message, 400);
// One error for unknown and foreign documents or answers, so identifiers cannot be probed across households.
const notFound = () => coded('POLICY_EVIDENCE_NOT_FOUND', 'The requested policy evidence was not found.', 404);

const text = (value, name, max = 256) => {
  if (typeof value !== 'string' || !value || value.length > max) throw invalid(`${name} is invalid.`);
  return value;
};

// FTS5 query from free text: whole words only, each quoted, OR-joined. Never passes operators through.
export function ftsQuery(query) {
  const words = String(query ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  return [...new Set(words)].slice(0, 24).map(word => `"${word}"`).join(' OR ');
}

export class ClauseRepository {
  constructor(database, { clock = () => new Date(), audit = null } = {}) {
    if (!database?.prepare || !database?.exec) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
  }

  #atomic(work) {
    const savepoint = `policy_evidence_${randomUUID().replaceAll('-', '')}`;
    let nested;
    if (typeof this.database.isTransaction === 'boolean') {
      nested = this.database.isTransaction;
      if (!nested) this.database.exec('BEGIN IMMEDIATE');
    } else {
      try { this.database.exec('BEGIN IMMEDIATE'); nested = false; } catch (error) {
        if (!/within a transaction/i.test(String(error?.message))) throw error;
        nested = true;
      }
    }
    if (nested) this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.database.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) this.database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  #document(householdId, caseId, documentId) {
    const row = this.database.prepare(`SELECT id FROM document_uploads
      WHERE id = ? AND household_id = ? AND case_id = ? AND lifecycle_state = 'active'`).get(documentId, householdId, caseId);
    if (!row) throw notFound();
  }

  /** Stores clauses built by buildClauses(). Replays are no-ops; a changed digest for a stored id fails closed. */
  saveClauses({ householdId, caseId, documentId, clauses }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(documentId, 'documentId');
    if (!Array.isArray(clauses) || clauses.length === 0 || clauses.length > MAX_CLAUSES_PER_DOCUMENT) throw invalid('clauses must be a bounded non-empty array.');
    return this.#atomic(() => {
      this.#document(householdId, caseId, documentId);
      const find = this.database.prepare('SELECT digest, document_id, household_id FROM policy_clauses WHERE id = ?');
      const insert = this.database.prepare(`INSERT INTO policy_clauses
        (id, household_id, case_id, document_id, source_version, page, block_indexes_json, title, kind, text, digest, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const at = this.clock().toISOString();
      let inserted = 0;
      for (const clause of clauses) {
        if (clause.documentId !== documentId) throw invalid('Every clause must belong to the document.');
        if (!CLAUSE_KINDS.includes(clause.kind)) throw invalid('Clause kind is invalid.');
        const existing = find.get(clause.clauseId);
        if (existing) {
          if (existing.household_id !== householdId || existing.document_id !== documentId || existing.digest !== clause.digest) {
            throw coded('CLAUSE_DIGEST_CONFLICT', 'A stored clause differs from the rebuilt clause.', 409);
          }
          continue;
        }
        insert.run(clause.clauseId, householdId, caseId, documentId, clause.sourceVersion, clause.page,
          JSON.stringify(clause.blockIndexes), clause.sectionPath?.[0] ?? null, clause.kind, clause.text, clause.digest, at);
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

  listClauses({ householdId, caseId, documentIds }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > 20) throw invalid('documentIds must be 1 to 20 ids.');
    const select = this.database.prepare(`SELECT * FROM policy_clauses
      WHERE household_id = ? AND case_id = ? AND document_id = ? ORDER BY page, rowid`);
    return documentIds.flatMap(documentId => select.all(householdId, caseId, text(documentId, 'documentId')).map(row => this.#shape(row)));
  }

  /** FTS5 retrieval, household and case scoped; optional kind filter. Ranked by bm25. */
  searchClauses({ householdId, caseId, documentIds, query, kinds = null, limit = 20 }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    if (!Array.isArray(documentIds) || !documentIds.length) throw invalid('documentIds are required.');
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw invalid('limit is out of range.');
    if (kinds !== null && (!Array.isArray(kinds) || kinds.some(kind => !CLAUSE_KINDS.includes(kind)))) throw invalid('kinds are invalid.');
    const match = ftsQuery(query);
    if (!match) return [];
    const documentMarks = documentIds.map(() => '?').join(',');
    const kindMarks = kinds ? kinds.map(() => '?').join(',') : '';
    const rows = this.database.prepare(`SELECT clause.* FROM policy_clauses_fts
      JOIN policy_clauses clause ON clause.rowid = policy_clauses_fts.rowid
      WHERE policy_clauses_fts MATCH ? AND clause.household_id = ? AND clause.case_id = ?
        AND clause.document_id IN (${documentMarks})${kinds ? ` AND clause.kind IN (${kindMarks})` : ''}
      ORDER BY bm25(policy_clauses_fts), clause.rowid LIMIT ?`).all(match, householdId, caseId, ...documentIds, ...(kinds ?? []), limit);
    return rows.map(row => this.#shape(row));
  }

  /** Stores an immutable answer. A replayed idempotency key with the same request digest returns the stored one. */
  saveAnswer({ id = `answer-${randomUUID()}`, householdId, caseId, requestedByAdultId, idempotencyKey, requestDigest, question, answer, consentCheck = null }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(requestedByAdultId, 'requestedByAdultId');
    text(idempotencyKey, 'idempotencyKey', 128); text(requestDigest, 'requestDigest', 64); text(question, 'question', 2000);
    if (!ANSWER_STATES.includes(answer?.state)) throw invalid('Answer state is invalid.');
    const documentIds = [...new Set(answer.sources.map(source => source.documentId).concat(answer.documentIds ?? []))];
    return this.#atomic(() => {
      const existing = this.database.prepare(`SELECT * FROM policy_answers WHERE household_id = ? AND case_id = ? AND idempotency_key = ?`)
        .get(householdId, caseId, idempotencyKey);
      if (existing) {
        if (existing.request_digest !== requestDigest) throw coded('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.', 409);
        return { replayed: true, ...this.#answer(existing) };
      }
      // Consent is re-checked inside the transaction, immediately before the answer is written.
      if (consentCheck) {
        const pending = consentCheck();
        if (pending && typeof pending.then === 'function') {
          Promise.resolve(pending).catch(() => {});
          throw invalid('consentCheck must be synchronous.');
        }
      }
      this.database.prepare(`INSERT INTO policy_answers
        (id, household_id, case_id, requested_by_adult_id, idempotency_key, request_digest, question, state, document_ids_json, answer_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, householdId, caseId, requestedByAdultId, idempotencyKey, requestDigest, question, answer.state,
          JSON.stringify(documentIds), JSON.stringify(answer), this.clock().toISOString());
      return { replayed: false, ...this.#answer(this.database.prepare('SELECT * FROM policy_answers WHERE id = ?').get(id)) };
    });
  }

  #answer(row) {
    return { answerId: row.id, caseId: row.case_id, createdAt: row.created_at, answer: JSON.parse(row.answer_json) };
  }

  /** Stored answer for an idempotency key, so a replay is served before any paid work. Null when none. */
  findAnswerByKey({ householdId, caseId, idempotencyKey, requestDigest }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(idempotencyKey, 'idempotencyKey', 128);
    const row = this.database.prepare('SELECT * FROM policy_answers WHERE household_id = ? AND case_id = ? AND idempotency_key = ?')
      .get(householdId, caseId, idempotencyKey);
    if (!row) return null;
    if (row.request_digest !== requestDigest) throw coded('IDEMPOTENCY_KEY_REUSED', 'The idempotency key was used for a different request.', 409);
    return { replayed: true, ...this.#answer(row) };
  }

  /** Document ids that already have clauses stored for the case. */
  clauseDocumentIds({ householdId, caseId }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    return this.database.prepare('SELECT DISTINCT document_id AS id FROM policy_clauses WHERE household_id = ? AND case_id = ? ORDER BY document_id')
      .all(householdId, caseId).map(row => row.id);
  }

  getAnswer({ householdId, caseId, answerId }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(answerId, 'answerId');
    const row = this.database.prepare('SELECT * FROM policy_answers WHERE id = ? AND household_id = ? AND case_id = ?').get(answerId, householdId, caseId);
    if (!row) throw notFound();
    return this.#answer(row);
  }

  /** Deletes clauses (FTS rows go by trigger) and answers citing the documents. Counts-only audit. Joins the caller's transaction. */
  eraseDerived({
    householdId = null, documentIds = [], reasonCode, caseId = null, resourceType = 'document', resourceId = null,
    actorType = 'system', actorId = 'clause-repository',
  } = {}) {
    if (!erasureReasons.has(reasonCode)) throw invalid('reasonCode is not supported.');
    if (!Array.isArray(documentIds)) throw invalid('documentIds must be an array.');
    return this.#atomic(() => {
      let answers = 0;
      let clauses = 0;
      const deleteAnswers = this.database.prepare(`DELETE FROM policy_answers
        WHERE (? IS NULL OR household_id = ?)
          AND EXISTS (SELECT 1 FROM json_each(policy_answers.document_ids_json) WHERE value = ?)`);
      const deleteClauses = this.database.prepare('DELETE FROM policy_clauses WHERE document_id = ? AND (? IS NULL OR household_id = ?)');
      for (const documentId of new Set(documentIds)) {
        answers += Number(deleteAnswers.run(householdId, householdId, documentId).changes);
        clauses += Number(deleteClauses.run(documentId, householdId, householdId).changes);
      }
      const counts = Object.freeze({ clauses, answers });
      if (clauses > 0 || answers > 0) {
        this.audit.append({
          householdId, caseId, actorType, actorId, action: 'policy_evidence.erased', resourceType,
          resourceId: resourceId ?? documentIds[0] ?? 'policy_evidence',
          payload: { reasonCode, ...counts, documents: new Set(documentIds).size },
        });
      }
      return counts;
    });
  }
}
