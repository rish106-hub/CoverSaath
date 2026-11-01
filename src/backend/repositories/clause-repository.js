import { randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';
import { isDatabaseInterface } from '../database/postgres/db.js';
import { householdLock } from '../database/postgres/locks.js';
import { CLAUSE_KINDS, ANSWER_STATES, MAX_CLAUSE_TEXT_CHARS, MAX_CLAUSE_TITLE_CHARS } from '../../contracts/policy-evidence.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { queryTerms, scoreClause } from './clause-text-search.js';

// Storage for evidence-first reasoning (ADR 0008, PostgreSQL migration 012) on the async PostgreSQL
// interface (S3.2). Clauses are deterministic and immutable; answers are immutable. Both are derived
// stores: erasure deletes them and audits counts only. Every read and write is household-scoped.
//
// Retrieval: clause text and title are sealed columns (ADR 0013), so PostgreSQL cannot search them. Search pages through
// the clauses of the given documents (household and case scoped, bounded), opens them here and ranks them in
// clause-text-search.js (English stemming, any-term match). Nothing sealed is ever compared in SQL.

const erasureReasons = new Set(['consent_revoked', 'document_erasure', 'source_consent_not_current', 'retention_expired', 'data_subject_request']);
const MAX_CLAUSES_PER_DOCUMENT = 2000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_DOCUMENTS = 1000;
const MAX_QUERY_WORDS = 24;
// Insertion order of the SQLite runtime (rowid): page, then the clause's first block.
const CLAUSE_ORDER = "clause.page, CAST(CAST(clause.block_indexes_json AS jsonb) ->> 0 AS bigint), clause.id";
// Search decrypts clauses in the application (ADR 0013): at most this many clauses are scanned per search, in pages.
// Each page is scored synchronously, so pages are small and the event loop is released between them. A search that reaches
// the row cap or the time budget stops and reports `truncated` instead of holding the process.
const SEARCH_PAGE_ROWS = 100;
const MAX_SEARCH_SCAN_ROWS = 2_000;
const SEARCH_TIME_BUDGET_MS = 3_000;
const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

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

export class ClauseRepository {
  constructor(database, { clock = () => new Date(), audit = null, ...options } = {}) {
    if (!isDatabaseInterface(database)) throw new TypeError('A database is required.');
    this.database = database;
    this.crypto = resolveColumnCrypto(options);
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
      // Clauses are built from stored pages read outside this lock. If the text was erased meanwhile (consent revoked
      // between the read and this write) nothing is written, so no clause outlives the text it was built from.
      const stillStored = await this.database.one(`SELECT 1 AS present FROM source_pages page
        JOIN document_uploads document ON document.id = page.document_upload_id AND document.source_version = page.source_version
        WHERE document.id = ? AND page.extracted_text IS NOT NULL AND page.extraction_status IN ('extracted', 'manual_verified') LIMIT 1`, [documentId]);
      if (!stillStored) throw coded('OCR_PAGES_UNAVAILABLE', 'No stored OCR pages are available for this document.', 409);
      const at = this.clock().toISOString();
      let inserted = 0;
      for (const clause of clauses) {
        if (clause.documentId !== documentId) throw invalid('Every clause must belong to the document.');
        if (!CLAUSE_KINDS.includes(clause.kind)) throw invalid('Clause kind is invalid.');
        // The 1-100000 text and 200-character title caps were database checks on plaintext; a sealed value can only be capped by length.
        if (typeof clause.text !== 'string' || clause.text.length < 1 || clause.text.length > MAX_CLAUSE_TEXT_CHARS) throw invalid('Clause text length is invalid.');
        if ((clause.sectionPath?.[0] ?? '').length > MAX_CLAUSE_TITLE_CHARS) throw invalid('Clause title is too long.');
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
          JSON.stringify(clause.blockIndexes), this.crypto.seal('policy_clauses', 'title', clause.clauseId, clause.sectionPath?.[0] ?? null), clause.kind,
          this.crypto.seal('policy_clauses', 'text', clause.clauseId, clause.text), clause.digest, at,
        ]);
        inserted += 1;
      }
      return Object.freeze({ inserted, total: clauses.length });
    });
  }

  #shape(row) {
    const title = this.crypto.open('policy_clauses', 'title', row.id, row.title);
    return Object.freeze({
      clauseId: row.id, documentId: row.document_id, sourceVersion: row.source_version, page: row.page,
      blockIndexes: JSON.parse(row.block_indexes_json), sectionPath: title ? [title] : [], kind: row.kind,
      text: this.crypto.open('policy_clauses', 'text', row.id, row.text), digest: row.digest,
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

  /** Word retrieval, household and case scoped; optional kind filter. Ranked in the application (clause-text-search.js). The result carries a non-enumerable `truncated` flag when the scan cap or time budget cut the search short. */
  async searchClauses({ householdId, caseId, documentIds, query, kinds = null, limit = 20 }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    if (!Array.isArray(documentIds) || !documentIds.length || documentIds.length > MAX_SEARCH_DOCUMENTS) throw invalid('documentIds are required.');
    documentIds.forEach(documentId => text(documentId, 'documentIds'));
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) throw invalid('limit is out of range.');
    if (kinds !== null && (!Array.isArray(kinds) || kinds.some(kind => !CLAUSE_KINDS.includes(kind)))) throw invalid('kinds are invalid.');
    const terms = queryTerms(query, MAX_QUERY_WORDS);
    if (terms.length === 0) return [];
    const kindFilter = kinds ? 'AND clause.kind = ANY(CAST(? AS text[]))' : '';
    const hits = [];
    let scanned = 0;
    let truncated = false;
    const started = Date.now();
    for (let offset = 0; ; offset += SEARCH_PAGE_ROWS) {
      const rows = await this.database.many(`SELECT clause.* FROM policy_clauses clause
        WHERE clause.household_id = ? AND clause.case_id = ? AND clause.document_id = ANY(CAST(? AS text[])) ${kindFilter}
        ORDER BY ${CLAUSE_ORDER} LIMIT ? OFFSET ?`,
      [householdId, caseId, documentIds, ...(kinds ? [kinds] : []), SEARCH_PAGE_ROWS, offset]);
      for (const row of rows) {
        const shaped = this.#shape(row);
        const score = scoreClause(terms, shaped.text, shaped.sectionPath[0]);
        if (score > 0) hits.push({ score, order: hits.length, shaped });
      }
      scanned += rows.length;
      if (rows.length < SEARCH_PAGE_ROWS) break;
      if (scanned >= MAX_SEARCH_SCAN_ROWS || Date.now() - started > SEARCH_TIME_BUDGET_MS) { truncated = true; break; }
      await yieldToEventLoop();
    }
    // Best score first; equal scores keep the document order (page, first block, id).
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    const found = hits.slice(0, limit).map(hit => hit.shaped);
    // Non-enumerable, so a result that was not cut short compares equal to a plain array and callers that ignore it are unchanged.
    if (truncated) Object.defineProperty(found, 'truncated', { value: true });
    return found;

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
        JSON.stringify(documentIds),
        this.crypto.seal('policy_answers', 'answer_json', id, JSON.stringify({ ...answer, access: { consentGrantId: access.consentGrantId, subjectAdultId: access.subjectAdultId, documentIds: [...access.documentIds] } })),
        this.clock().toISOString(),
      ]);
      return { replayed: false, ...this.#answer(await this.database.one('SELECT * FROM policy_answers WHERE id = ?', [id])) };
    });
  }

  #answer(row) {
    const { access = null, ...answer } = JSON.parse(this.crypto.open('policy_answers', 'answer_json', row.id, row.answer_json));
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
