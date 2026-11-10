import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { sealIdempotencyResponse } from '../security/sealed-records.js';

// Policy profiles (migration 043, ADR 0024): the identity of the policy a document describes and what its owner confirmed.
//
//   * The policy name and the insurer name are sealed (AES-256-GCM, AAD policy_profiles.<column>.<row id>) and exist only after
//     the owner confirmed them. Nothing proposed from a document is stored for them.
//   * The UIN and the insurer code are public product identifiers: plaintext, and storable as 'extracted_unverified' before
//     confirmation.
//   * A confirmation is the household owner's own statement: state 'reported', source 'user_statement' (ADR 0009). Never 'proven'.
//   * Every read and write is scoped to a household. Every write and its counts-only audit event commit together under the
//     household advisory lock; the audit payload names fields, never values.

const TABLE = 'policy_profiles';
const IDEMPOTENCY_HOURS = 24;
const erasureReasons = new Set(['user_request', 'case_erasure', 'household_erasure', 'retention_expired', 'data_subject_request', 'consent_revoked', 'document_erasure']);
const UIN = /^[A-Z0-9]{8,24}$/;
const INSURER_CODE = /^[A-Z0-9]{2,12}$/;
const MAX_NAME_LENGTH = 200;
const CONTROL = /[\p{Cc}\p{Zl}\p{Zp}]/u;

function coded(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode });
}
const invalid = message => coded('POLICY_PROFILE_INVALID', message, 400);

function id(value, name) {
  if (typeof value !== 'string' || !value || value.length > 256) throw invalid(`${name} is invalid.`);
  return value;
}

function name(value, field) {
  if (typeof value !== 'string') throw invalid(`${field} must be text.`);
  const normalised = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (normalised.length < 1 || normalised.length > MAX_NAME_LENGTH || CONTROL.test(normalised)) throw invalid(`${field} must be 1 to ${MAX_NAME_LENGTH} characters of plain text.`);
  return normalised;
}

/** Validates and normalises the owner's statement. Returns only the fields that were given; throws a coded error otherwise. */
export function parseProfileStatement(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalid('A statement is required.');
  const allowed = new Set(['uin', 'insurerCode', 'insurerName', 'policyName', 'expectedVersion']);
  for (const key of Object.keys(body)) if (!allowed.has(key)) throw invalid('The statement holds a field that is not accepted.');
  const statement = {};
  if (body.uin !== undefined) {
    const uin = typeof body.uin === 'string' ? body.uin.trim().toUpperCase() : '';
    if (!UIN.test(uin) || !/\d/.test(uin) || !/[A-Z]/.test(uin)) throw coded('POLICY_PROFILE_INVALID_UIN', 'The UIN must be 8 to 24 letters and digits.', 422);
    statement.uin = uin;
  }
  if (body.insurerCode !== undefined) {
    const code = typeof body.insurerCode === 'string' ? body.insurerCode.trim().toUpperCase() : '';
    if (!INSURER_CODE.test(code)) throw invalid('insurerCode must be 2 to 12 letters and digits.');
    statement.insurerCode = code;
  }
  if (body.insurerName !== undefined) statement.insurerName = name(body.insurerName, 'insurerName');
  if (body.policyName !== undefined) statement.policyName = name(body.policyName, 'policyName');
  if (Object.keys(statement).length === 0) throw invalid('Give at least one of uin, insurerCode, insurerName or policyName.');
  if (!Number.isInteger(body.expectedVersion) || body.expectedVersion < 0 || body.expectedVersion > 1_000_000) throw invalid('expectedVersion must be a whole number.');
  return Object.freeze({ ...statement, expectedVersion: body.expectedVersion });
}

export class PolicyProfileRepository {
  constructor(database, { clock = () => new Date(), audit = null, ...options } = {}) {
    if (!database || typeof database !== 'object') throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.crypto = resolveColumnCrypto(options);
  }

  // Confirmed values only are opened and returned; an extracted (unverified) value is a plaintext public identifier.
  #shape(row) {
    const reported = state => state === 'reported';
    return Object.freeze({
      id: row.id,
      documentId: row.document_id,
      sourceVersion: row.source_version,
      version: row.version,
      states: Object.freeze({ uin: row.uin_state, insurer: row.insurer_state, policyName: row.policy_name_state }),
      confirmed: Object.freeze({
        uin: reported(row.uin_state) ? row.uin : null,
        insurerCode: reported(row.insurer_state) ? row.insurer_code : null,
        insurerName: reported(row.insurer_state) ? this.crypto.open(TABLE, 'insurer_name_enc', row.id, row.insurer_name_enc) : null,
        policyName: reported(row.policy_name_state) ? this.crypto.open(TABLE, 'policy_name_enc', row.id, row.policy_name_enc) : null,
      }),
      extracted: Object.freeze({
        uin: row.uin_state === 'extracted_unverified' ? row.uin : null,
        insurerCode: row.insurer_state === 'extracted_unverified' ? row.insurer_code : null,
      }),
      confirmedAt: row.confirmed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  /** The profile of one document version, household scoped. Null when none exists. */
  async get({ householdId, documentId, sourceVersion }) {
    id(householdId, 'householdId'); id(documentId, 'documentId'); id(sourceVersion, 'sourceVersion');
    const row = await this.database.one('SELECT * FROM policy_profiles WHERE household_id = ? AND document_id = ? AND source_version = ?', [householdId, documentId, sourceVersion]);
    return row ? this.#shape(row) : null;
  }

  /** The page count recorded for a document of the household (migration 042), or null. */
  async pageCount({ householdId, documentId }) {
    id(householdId, 'householdId'); id(documentId, 'documentId');
    const row = await this.database.one('SELECT page_count FROM document_uploads WHERE id = ? AND household_id = ?', [documentId, householdId]);
    return row?.page_count ?? null;
  }

  /**
   * Stores the public identifiers read from the document as 'extracted_unverified' (or 'conflicting' with no value) the first
   * time a version is read. Insert only: a row that exists, confirmed or not, is never changed here. No name is stored.
   */
  async seedExtracted({ householdId, caseId, documentId, sourceVersion, uin = null, uinState = 'unknown', insurerCode = null, insurerState = 'unknown' }) {
    id(householdId, 'householdId'); id(caseId, 'caseId'); id(documentId, 'documentId'); id(sourceVersion, 'sourceVersion');
    if (!['unknown', 'extracted_unverified', 'conflicting'].includes(uinState) || !['unknown', 'extracted_unverified'].includes(insurerState)) throw invalid('state is invalid.');
    if (uinState === 'unknown' && insurerState === 'unknown') return false;
    return this.database.transaction(async () => {
      const at = this.clock().toISOString();
      const { changes } = await this.database.run(`INSERT INTO policy_profiles
        (id, household_id, case_id, document_id, source_version, uin, insurer_code, uin_state, insurer_state, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (document_id, source_version) DO NOTHING`, [
        `ppro-${randomUUID()}`, householdId, caseId, documentId, sourceVersion, uinState === 'extracted_unverified' ? uin : null,
        insurerState === 'extracted_unverified' ? insurerCode : null, uinState, insurerState, at, at]);
      if (changes === 1) {
        await this.audit?.append({
          householdId, caseId, actorType: 'system', actorId: 'policy-profile-repository', action: 'policy_profile.identifiers_extracted',
          resourceType: 'document', resourceId: documentId, payload: { fields: [uinState !== 'unknown' ? 'uin' : null, insurerState !== 'unknown' ? 'insurerCode' : null].filter(Boolean) },
        });
      }
      return changes === 1;
    }, { locks: [householdLock(householdId)] });
  }

  /**
   * The owner's confirmation, in one transaction under the household lock: the document is still active and its processing
   * consent is still current, the key has not been used for another statement, the version matches, no unresolved conflict is
   * left unaddressed, then the row is written (names sealed) with its audit event. `statement` comes from parseProfileStatement.
   * Resolves { version, replay }. A repeat of the same key and statement resolves with the stored version and replay: true.
   */
  async confirm({ householdId, documentId, adultUserId, statement, idempotencyKey }) {
    id(householdId, 'householdId'); id(documentId, 'documentId'); id(adultUserId, 'adultUserId');
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 200) throw coded('IDEMPOTENCY_KEY_REQUIRED', 'A stable Idempotency-Key header between 8 and 200 characters is required.', 400);
    const scope = `policy-profile-confirm:${adultUserId}:${documentId}`;
    // A keyed digest: a bare hash of a short policy name could be guessed.
    const requestDigest = this.crypto.blindIndex('policy_profile.confirm', JSON.stringify([
      statement.expectedVersion, statement.uin ?? null, statement.insurerCode ?? null, statement.insurerName ?? null, statement.policyName ?? null]));
    return this.database.transaction(async () => {
      const db = this.database;
      const now = this.clock();
      const at = now.toISOString();
      const document = await db.one(`SELECT document.id, document.case_id, document.source_version
        FROM document_uploads document
        JOIN consent_grants consent ON consent.id = document.consent_grant_id
        WHERE document.id = ? AND document.household_id = ?
          AND document.lifecycle_state = 'active'
          AND document.malware_status IN ('clean', 'not_scanned_fixture')
          AND consent.purpose = 'document_processing'
          AND consent.revoked_at IS NULL
          AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(CAST(? AS text)))
          AND EXISTS (
            SELECT 1 FROM consent_scopes scope
            WHERE scope.consent_grant_id = consent.id AND scope.resource_type = 'document'
              AND (scope.resource_id IS NULL OR scope.resource_id = document.id)
              AND scope.action = 'collect' AND scope.data_category = 'insurance_document')`, [documentId, householdId, at]);
      if (!document) throw coded('POLICY_PROFILE_NOT_READY', 'The document is not available for confirmation.', 409);

      await db.run(`DELETE FROM idempotency_keys WHERE scope = ? AND idempotency_key = ? AND julianday(expires_at) <= julianday(CAST(? AS text))`, [scope, idempotencyKey, at]);
      const prior = await db.one('SELECT request_digest, response_status FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?', [scope, idempotencyKey]);
      if (prior) {
        if (prior.request_digest !== requestDigest) throw coded('IDEMPOTENCY_CONFLICT', 'That Idempotency-Key was already used for a different statement.', 409);
        return Object.freeze({ replay: true, version: Number(prior.response_status) });
      }

      const existing = await db.one('SELECT * FROM policy_profiles WHERE document_id = ? AND source_version = ? FOR UPDATE', [documentId, document.source_version]);
      const current = existing?.version ?? 0;
      if (statement.expectedVersion !== current) throw coded('POLICY_PROFILE_VERSION_CONFLICT', 'The profile changed. Read it again and confirm again.', 409);
      if (existing) {
        const unresolved = (existing.uin_state === 'conflicting' && statement.uin === undefined)
          || (existing.insurer_state === 'conflicting' && statement.insurerCode === undefined && statement.insurerName === undefined)
          || (existing.policy_name_state === 'conflicting' && statement.policyName === undefined);
        if (unresolved) throw coded('POLICY_PROFILE_CONFLICTING_FACTS', 'Some values conflict. Choose a value for each of them.', 409);
      }

      const rowId = existing?.id ?? `ppro-${randomUUID()}`;
      const keepInsurerCode = statement.insurerCode === undefined && statement.insurerName !== undefined && existing?.insurer_state !== 'reported' ? null : existing?.insurer_code ?? null;
      const next = {
        uin: statement.uin ?? existing?.uin ?? null,
        uinState: statement.uin !== undefined ? 'reported' : existing?.uin_state ?? 'unknown',
        insurerCode: statement.insurerCode ?? keepInsurerCode,
        insurerName: statement.insurerName !== undefined ? this.crypto.seal(TABLE, 'insurer_name_enc', rowId, statement.insurerName) : existing?.insurer_name_enc ?? null,
        insurerState: statement.insurerCode !== undefined || statement.insurerName !== undefined ? 'reported' : existing?.insurer_state ?? 'unknown',
        policyName: statement.policyName !== undefined ? this.crypto.seal(TABLE, 'policy_name_enc', rowId, statement.policyName) : existing?.policy_name_enc ?? null,
        policyNameState: statement.policyName !== undefined ? 'reported' : existing?.policy_name_state ?? 'unknown',
      };
      // A conflicting UIN left as it was would keep a state with no value; the unresolved check above already refused that.
      const version = current + 1;
      if (existing) {
        await db.run(`UPDATE policy_profiles SET uin = ?, uin_state = ?, insurer_code = ?, insurer_name_enc = ?, insurer_state = ?,
            policy_name_enc = ?, policy_name_state = ?, confirmation_source = 'user_statement', confirmed_at = ?, confirmed_by_adult_id = ?,
            version = ?, updated_at = ? WHERE id = ?`, [
          next.uin, next.uinState, next.insurerCode, next.insurerName, next.insurerState, next.policyName, next.policyNameState,
          at, adultUserId, version, at, rowId]);
      } else {
        await db.run(`INSERT INTO policy_profiles
          (id, household_id, case_id, document_id, source_version, uin, uin_state, insurer_code, insurer_name_enc, insurer_state,
           policy_name_enc, policy_name_state, confirmation_source, confirmed_at, confirmed_by_adult_id, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'user_statement', ?, ?, ?, ?, ?)`, [
          rowId, householdId, document.case_id, documentId, document.source_version, next.uin, next.uinState, next.insurerCode, next.insurerName,
          next.insurerState, next.policyName, next.policyNameState, at, adultUserId, version, at, at]);
      }
      const fields = ['uin', 'insurerCode', 'insurerName', 'policyName'].filter(field => statement[field] !== undefined);
      await this.audit?.append({
        householdId, caseId: document.case_id, actorType: 'adult_user', actorId: adultUserId, action: 'policy_profile.confirmed',
        resourceType: 'document', resourceId: documentId, payload: { fields, version },
      });
      // The stored response is only the new version: no value of the statement is kept in the idempotency record.
      await db.run(`INSERT INTO idempotency_keys
        (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at, household_id, case_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        scope, idempotencyKey, requestDigest, version, sealIdempotencyResponse(this.crypto, scope, idempotencyKey, JSON.stringify({ version })),
        new Date(now.getTime() + IDEMPOTENCY_HOURS * 3_600_000).toISOString(), at, householdId, document.case_id]);
      return Object.freeze({ replay: false, version });
    }, { locks: [householdLock(householdId)] });
  }

  async #erase({ where, params, householdId, caseId = null, resourceType, resourceId, reasonCode, actorType, actorId }) {
    if (!erasureReasons.has(reasonCode)) throw invalid('reasonCode is not supported.');
    return this.database.transaction(async () => {
      const { changes } = await this.database.run(`DELETE FROM policy_profiles WHERE ${where}`, params);
      if (changes > 0) {
        await this.audit?.append({ householdId, caseId, actorType, actorId, action: 'policy_profile.erased', resourceType, resourceId, payload: { reasonCode, profiles: changes } });
      }
      return Object.freeze({ profiles: changes });
    }, { locks: [householdLock(householdId)] });
  }

  /** Deletes the profiles of the given documents of a household. Counts-only audit. Joins a caller's transaction. */
  async eraseForDocuments({ householdId, documentIds, reasonCode = 'document_erasure', caseId = null, actorType = 'system', actorId = 'policy-profile-repository', resourceType = 'document', resourceId = null }) {
    id(householdId, 'householdId');
    if (!Array.isArray(documentIds) || documentIds.length === 0) return Object.freeze({ profiles: 0 });
    return this.#erase({
      where: 'household_id = ? AND document_id = ANY(CAST(? AS text[]))', params: [householdId, documentIds], householdId, caseId, resourceType, resourceId: resourceId ?? documentIds[0], reasonCode, actorType, actorId,
    });
  }

  /** Deletes every profile of a case. Counts-only audit. */
  async eraseForCase({ householdId, caseId, reasonCode = 'case_erasure', actorType = 'system', actorId = 'policy-profile-repository' }) {
    id(householdId, 'householdId'); id(caseId, 'caseId');
    return this.#erase({ where: 'household_id = ? AND case_id = ?', params: [householdId, caseId], householdId, caseId, resourceType: 'case', resourceId: caseId, reasonCode, actorType, actorId });
  }

  /** Deletes every profile of a household. Counts-only audit. */
  async eraseForHousehold({ householdId, reasonCode = 'household_erasure', actorType = 'system', actorId = 'policy-profile-repository' }) {
    id(householdId, 'householdId');
    return this.#erase({ where: 'household_id = ?', params: [householdId], householdId, resourceType: 'household', resourceId: householdId, reasonCode, actorType, actorId });
  }
}
