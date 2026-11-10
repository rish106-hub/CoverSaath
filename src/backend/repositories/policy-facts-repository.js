import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { FACT_TYPES, SCOPE_KEY_PATTERN, isFactType } from '../../features/policy-facts/fact-types.js';
import { toStorage } from '../../features/policy-facts/normalisers.js';

// Policy facts (migration 044, ADR 0025): the datapoints read from a document and where each is printed.
//
//   * Exact values (money, dates, free text, the printed waiting-period unit) and every quote are sealed (AES-256-GCM, AAD
//     <table>.<column>.<row id>). Only coarse values (amount band, day count, basis points, enum, year-month) are plaintext.
//   * A reader (deterministic code or a model) writes only extracted_unverified, conflicting or unknown. 'reported' is the owner's own
//     statement and has no write path in this slice. Sealed values are never returned for a fact that is not 'reported'.
//   * Every read and write is scoped to a household. A write and its counts-only audit event commit together under the household
//     advisory lock, with the document, its processing consent and (for model facts) the model grant re-checked in the same
//     transaction. A write is ON CONFLICT DO NOTHING on (extraction run, type, scope, ordinal): a replay writes nothing.
//   * Erasure DELETEs. Evidence rows go with their fact (ON DELETE CASCADE).

const FACTS = 'policy_facts';
const EVIDENCE = 'fact_evidence';
const erasureReasons = new Set(['user_request', 'case_erasure', 'household_erasure', 'retention_expired', 'data_subject_request', 'consent_revoked', 'document_erasure']);
const READER_STATES = new Set(['extracted_unverified', 'conflicting', 'unknown']);
const ORIGINS = new Set(['deterministic', 'model_proposed']);
const ROLES = new Set(['primary', 'corroborating', 'conflicting']);
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_FACTS_PER_RUN = 200;
const MAX_EVIDENCE_PER_FACT = 4;
const MAX_LIST = 500;

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
const invalid = message => coded('POLICY_FACT_INVALID', message, 400);

function id(value, name) {
  if (typeof value !== 'string' || !value || value.length > 256) throw invalid(`${name} is invalid.`);
  return value;
}

export class PolicyFactsRepository {
  constructor(database, { clock = () => new Date(), audit = null, ...options } = {}) {
    if (!database || typeof database !== 'object') throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.crypto = resolveColumnCrypto(options);
  }

  /**
   * Stores one extraction run: every fact with its evidence, in one transaction under the household lock.
   *
   * `facts` are already verified (evidence-verify.js): { factType, scopeKey, ordinal?, origin, state, value, raw, evidence:
   * [{ role, quote, page, blockIndex, clauseId, sourceDigest }] }. `consentCheck` (async, optional) is awaited inside the transaction
   * for a run that holds model-proposed facts. Resolves { inserted, skipped, evidence, replay }.
   * Throws POLICY_FACT_NOT_READY when the document is not active, is not at `sourceVersion`, or no longer has current processing consent.
   */
  async insertExtraction({ householdId, documentId, sourceVersion, extractionRunId, normaliserVersion, facts, consentCheck = null }) {
    id(householdId, 'householdId'); id(documentId, 'documentId'); id(sourceVersion, 'sourceVersion'); id(extractionRunId, 'extractionRunId');
    if (typeof normaliserVersion !== 'string' || !/^[a-z0-9_.-]{1,40}$/.test(normaliserVersion)) throw invalid('normaliserVersion is invalid.');
    if (!Array.isArray(facts) || facts.length > MAX_FACTS_PER_RUN) throw invalid('facts must be a list of at most 200.');
    const prepared = facts.map(fact => this.#prepare(fact));
    const usesModel = prepared.some(fact => fact.origin === 'model_proposed');
    if (usesModel && typeof consentCheck !== 'function') throw invalid('A model grant check is required for model-proposed facts.');
    return this.database.transaction(async () => {
      const db = this.database;
      const at = this.clock().toISOString();
      const document = await db.one(`SELECT document.id, document.case_id, document.source_version
        FROM document_uploads document
        JOIN consent_grants consent ON consent.id = document.consent_grant_id
        WHERE document.id = ? AND document.household_id = ?
          AND document.lifecycle_state = 'active'
          AND document.source_version = ?
          AND document.malware_status IN ('clean', 'not_scanned_fixture')
          AND consent.purpose = 'document_processing'
          AND consent.revoked_at IS NULL
          AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(CAST(? AS text)))
          AND EXISTS (
            SELECT 1 FROM consent_scopes scope
            WHERE scope.consent_grant_id = consent.id AND scope.resource_type = 'document'
              AND (scope.resource_id IS NULL OR scope.resource_id = document.id)
              AND scope.action = 'collect' AND scope.data_category = 'insurance_document')`, [documentId, householdId, sourceVersion, at]);
      if (!document) throw coded('POLICY_FACT_NOT_READY', 'The document is not available for fact extraction.', 409);
      if (usesModel) await consentCheck();

      let inserted = 0;
      let evidenceRows = 0;
      for (const fact of prepared) {
        const factId = `pfact-${randomUUID()}`;
        const { changes } = await db.run(`INSERT INTO policy_facts
          (id, household_id, case_id, document_id, source_version, extraction_run_id, fact_type, scope_key, ordinal, origin, state, value_type,
           currency, amount_band, value_duration_days, value_percent_bp, value_bool, value_enum, value_ym, value_enc, raw_text_enc,
           normaliser_version, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (extraction_run_id, fact_type, scope_key, ordinal) DO NOTHING`, [
          factId, householdId, document.case_id, documentId, sourceVersion, extractionRunId, fact.factType, fact.scopeKey, fact.ordinal, fact.origin, fact.state,
          fact.valueType, fact.storage?.currency ?? null, fact.storage?.amountBand ?? null, fact.storage?.durationDays ?? null, fact.storage?.percentBp ?? null,
          fact.storage?.bool ?? null, fact.storage?.enumValue ?? null, fact.storage?.ym ?? null,
          fact.storage?.sealed ? this.crypto.seal(FACTS, 'value_enc', factId, fact.storage.sealed) : null,
          fact.raw ? this.crypto.seal(FACTS, 'raw_text_enc', factId, fact.raw) : null,
          normaliserVersion, at]);
        if (changes !== 1) continue;
        inserted += 1;
        for (const evidence of fact.evidence) {
          const evidenceId = `fev-${randomUUID()}`;
          await db.run(`INSERT INTO fact_evidence
            (id, fact_id, household_id, case_id, document_id, source_version, page, block_index, clause_id, quote_enc, source_digest, role, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            evidenceId, factId, householdId, document.case_id, documentId, sourceVersion, evidence.page, evidence.blockIndex ?? null, evidence.clauseId ?? null,
            this.crypto.seal(EVIDENCE, 'quote_enc', evidenceId, evidence.quote), evidence.sourceDigest ?? null, evidence.role, at]);
          evidenceRows += 1;
        }
      }
      if (inserted > 0) {
        await this.audit?.append({
          householdId, caseId: document.case_id, actorType: 'system', actorId: 'policy-facts-repository', action: 'policy_facts.extracted',
          resourceType: 'document', resourceId: documentId,
          payload: { facts: inserted, evidence: evidenceRows, skipped: prepared.length - inserted, model: prepared.filter(fact => fact.origin === 'model_proposed').length },
        });
      }
      return Object.freeze({ inserted, skipped: prepared.length - inserted, evidence: evidenceRows, replay: inserted === 0 && prepared.length > 0 });
    }, { locks: [householdLock(householdId)] });
  }

  #prepare(fact) {
    if (!fact || typeof fact !== 'object') throw invalid('A fact is required.');
    if (!isFactType(fact.factType)) throw invalid('factType is not supported.');
    const scopeKey = fact.scopeKey ?? '';
    if (typeof scopeKey !== 'string' || !SCOPE_KEY_PATTERN.test(scopeKey)) throw invalid('scopeKey is invalid.');
    const ordinal = fact.ordinal ?? 0;
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal > 999) throw invalid('ordinal is invalid.');
    if (!ORIGINS.has(fact.origin)) throw invalid('origin is not supported.');
    // A reader never writes above extracted_unverified (the database CHECK says the same).
    if (!READER_STATES.has(fact.state)) throw invalid('state is not permitted for a reader.');
    const valueType = FACT_TYPES[fact.factType].valueType;
    let storage = null;
    if (fact.state === 'extracted_unverified') {
      storage = toStorage(valueType, fact.value);
      if (!storage) throw invalid('value does not fit the fact type.');
      if (!Array.isArray(fact.evidence) || fact.evidence.length < 1 || fact.evidence.length > MAX_EVIDENCE_PER_FACT) throw invalid('A fact needs 1 to 4 pieces of evidence.');
    } else if (fact.state === 'conflicting') {
      if (!Array.isArray(fact.evidence) || fact.evidence.length < 2 || fact.evidence.length > MAX_EVIDENCE_PER_FACT) throw invalid('A conflicting fact needs 2 to 4 pieces of evidence.');
    } else if (fact.evidence?.length) {
      throw invalid('An unknown fact has no evidence.');
    }
    const evidence = (fact.evidence ?? []).map(item => {
      if (!ROLES.has(item?.role)) throw invalid('evidence role is invalid.');
      if (typeof item.quote !== 'string' || !item.quote || item.quote.length > 500) throw invalid('evidence quote is invalid.');
      if (!Number.isInteger(item.page) || item.page < 1 || item.page > 5000) throw invalid('evidence page is invalid.');
      if (item.blockIndex != null && (!Number.isInteger(item.blockIndex) || item.blockIndex < 0)) throw invalid('evidence blockIndex is invalid.');
      if (item.sourceDigest != null && !HEX64.test(item.sourceDigest)) throw invalid('evidence sourceDigest is invalid.');
      return item;
    });
    if (fact.state === 'conflicting' && evidence.some(item => item.role !== 'conflicting')) throw invalid('A conflicting fact carries conflicting evidence only.');
    if (fact.state === 'extracted_unverified' && evidence.filter(item => item.role === 'primary').length !== 1) throw invalid('A fact has exactly one primary evidence.');
    const raw = typeof fact.raw === 'string' && fact.state === 'extracted_unverified' ? fact.raw.slice(0, 500) : null;
    return { ...fact, scopeKey, ordinal, valueType, storage, evidence, raw };
  }

  // Sealed values are opened only for a fact the owner reported. Anything a reader wrote stays sealed in the response.
  #shape(row, evidence) {
    const reported = row.state === 'reported';
    return Object.freeze({
      id: row.id,
      factType: row.fact_type,
      scopeKey: row.scope_key,
      ordinal: row.ordinal,
      origin: row.origin,
      state: row.state,
      valueType: row.value_type,
      coarse: Object.freeze({
        currency: row.currency, amountBand: row.amount_band, durationDays: row.value_duration_days, percentBp: row.value_percent_bp,
        bool: row.value_bool, enum: row.value_enum, yearMonth: row.value_ym,
      }),
      value: reported && row.value_enc ? JSON.parse(this.crypto.open(FACTS, 'value_enc', row.id, row.value_enc)) : null,
      normaliserVersion: row.normaliser_version,
      confirmedAt: row.confirmed_at,
      supersededByFactId: row.superseded_by_fact_id,
      evidence: Object.freeze((evidence ?? []).map(item => Object.freeze({
        page: item.page,
        blockIndex: item.block_index,
        clauseId: item.clause_id,
        role: item.role,
        quote: reported ? this.crypto.open(EVIDENCE, 'quote_enc', item.id, item.quote_enc) : null,
      }))),
    });
  }

  /** The identity of an active document of the household (case and current source version), or null. */
  async documentIdentity({ householdId, documentId }) {
    id(householdId, 'householdId'); id(documentId, 'documentId');
    const row = await this.database.one(`SELECT id, case_id, source_version FROM document_uploads
      WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
    return row ? Object.freeze({ id: row.id, caseId: row.case_id, sourceVersion: row.source_version }) : null;
  }

  /** page number -> sha256 of the stored page text (source_pages.page_sha256), for the evidence source_digest. */
  async pageDigests({ householdId, documentId, sourceVersion }) {
    id(householdId, 'householdId'); id(documentId, 'documentId'); id(sourceVersion, 'sourceVersion');
    const rows = await this.database.many(`SELECT page.page_number, page.page_sha256 FROM source_pages page
      JOIN document_uploads document ON document.id = page.document_upload_id
      WHERE page.document_upload_id = ? AND page.source_version = ? AND document.household_id = ?`, [documentId, sourceVersion, householdId]);
    return new Map(rows.filter(row => HEX64.test(row.page_sha256 ?? '')).map(row => [Number(row.page_number), row.page_sha256]));
  }

  /** The current facts of one document version, household scoped, bounded. Sealed values stay sealed unless the fact is reported. */
  async listForDocument({ householdId, documentId, sourceVersion }) {
    id(householdId, 'householdId'); id(documentId, 'documentId'); id(sourceVersion, 'sourceVersion');
    const rows = await this.database.many(`SELECT * FROM policy_facts
      WHERE household_id = ? AND document_id = ? AND source_version = ? AND superseded_by_fact_id IS NULL
      ORDER BY fact_type, scope_key, ordinal, id LIMIT ?`, [householdId, documentId, sourceVersion, MAX_LIST]);
    if (rows.length === 0) return Object.freeze([]);
    const evidence = await this.database.many(`SELECT * FROM fact_evidence WHERE household_id = ? AND fact_id = ANY(CAST(? AS text[])) ORDER BY created_at, id`,
      [householdId, rows.map(row => row.id)]);
    const byFact = new Map();
    for (const item of evidence) {
      if (!byFact.has(item.fact_id)) byFact.set(item.fact_id, []);
      byFact.get(item.fact_id).push(item);
    }
    return Object.freeze(rows.map(row => this.#shape(row, byFact.get(row.id))));
  }

  async #erase({ where, params, householdId, caseId = null, resourceType, resourceId, reasonCode, actorType, actorId }) {
    if (!erasureReasons.has(reasonCode)) throw invalid('reasonCode is not supported.');
    return this.database.transaction(async () => {
      const evidence = (await this.database.run(`DELETE FROM fact_evidence WHERE ${where}`, params)).changes;
      const facts = (await this.database.run(`DELETE FROM policy_facts WHERE ${where}`, params)).changes;
      if (facts > 0 || evidence > 0) {
        await this.audit?.append({ householdId, caseId, actorType, actorId, action: 'policy_facts.erased', resourceType, resourceId, payload: { reasonCode, facts, evidence } });
      }
      return Object.freeze({ facts, evidence });
    }, { locks: [householdLock(householdId)] });
  }

  /** Deletes the facts and evidence of the given documents of a household. Counts-only audit. Joins a caller's transaction. */
  async eraseForDocuments({ householdId, documentIds, reasonCode = 'document_erasure', caseId = null, actorType = 'system', actorId = 'policy-facts-repository', resourceType = 'document', resourceId = null }) {
    id(householdId, 'householdId');
    if (!Array.isArray(documentIds) || documentIds.length === 0) return Object.freeze({ facts: 0, evidence: 0 });
    return this.#erase({
      where: 'household_id = ? AND document_id = ANY(CAST(? AS text[]))', params: [householdId, documentIds], householdId, caseId, resourceType, resourceId: resourceId ?? documentIds[0], reasonCode, actorType, actorId,
    });
  }

  /** Deletes every fact of a case. Counts-only audit. */
  async eraseForCase({ householdId, caseId, reasonCode = 'case_erasure', actorType = 'system', actorId = 'policy-facts-repository' }) {
    id(householdId, 'householdId'); id(caseId, 'caseId');
    return this.#erase({ where: 'household_id = ? AND case_id = ?', params: [householdId, caseId], householdId, caseId, resourceType: 'case', resourceId: caseId, reasonCode, actorType, actorId });
  }

  /** Deletes every fact of a household. Counts-only audit. */
  async eraseForHousehold({ householdId, reasonCode = 'household_erasure', actorType = 'system', actorId = 'policy-facts-repository' }) {
    id(householdId, 'householdId');
    return this.#erase({ where: 'household_id = ?', params: [householdId], householdId, resourceType: 'household', resourceId: householdId, reasonCode, actorType, actorId });
  }
}
