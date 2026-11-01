import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { PROFILE_ANSWER_KEYS, PROFILE_ANSWER_SOURCE } from '../../contracts/profile-answers.js';

// Stored user-stated profile answers (migration 018, ADR 0013). The value is sealed with AES-256-GCM before it is written
// (AAD profile_answers.value_ciphertext.<row id>) and opened only here. Every read and write is scoped to a household and a
// case; the caller has already proved case ownership. Writes and their counts-only audit event commit together under the
// household lock. Values never reach the audit chain, a log or an error.

const TABLE = 'profile_answers';
const COLUMN = 'value_ciphertext';
const erasureReasons = new Set(['user_request', 'case_erasure', 'household_erasure', 'retention_expired', 'data_subject_request']);
const text = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 256) throw Object.assign(new Error(`${name} is invalid.`), { code: 'PROFILE_ANSWER_INVALID', statusCode: 400 });
  return value;
};

export class ProfileAnswerRepository {
  constructor(database, { clock = () => new Date(), audit = null, ...options } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.crypto = resolveColumnCrypto(options);
  }

  #shape(row) {
    // The stored value is { v: <value> } so a boolean false or a number is distinguishable from "no value".
    const { v } = JSON.parse(this.crypto.open(TABLE, COLUMN, row.id, row.value_ciphertext));
    return Object.freeze({ fieldKey: row.field_key, value: v, source: PROFILE_ANSWER_SOURCE, updatedAt: row.updated_at });
  }

  async list({ householdId, caseId }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    const rows = await this.database.many('SELECT * FROM profile_answers WHERE household_id = ? AND case_id = ?', [householdId, caseId]);
    const order = new Map(PROFILE_ANSWER_KEYS.map((key, index) => [key, index]));
    return rows.map(row => this.#shape(row)).sort((a, b) => order.get(a.fieldKey) - order.get(b.fieldKey));
  }

  /**
   * `answers` is Map(fieldKey -> value | null) from parseProfileAnswers. A value sets or replaces the answer (a repeat with
   * the same value changes nothing), null removes it. Resolves { set, removed, unchanged } counts.
   */
  async upsert({ householdId, caseId, adultUserId, answers }) {
    text(householdId, 'householdId'); text(caseId, 'caseId'); text(adultUserId, 'adultUserId');
    const db = this.database;
    return db.transaction(async () => {
      const at = this.clock().toISOString();
      const counts = { set: 0, removed: 0, unchanged: 0 };
      for (const [fieldKey, value] of answers) {
        const existing = await db.one('SELECT * FROM profile_answers WHERE case_id = ? AND field_key = ? FOR UPDATE', [caseId, fieldKey]);
        if (value === null) {
          if (existing) {
            await db.run('DELETE FROM profile_answers WHERE id = ?', [existing.id]);
            counts.removed += 1;
          } else counts.unchanged += 1;
          continue;
        }
        if (existing) {
          if (existing.household_id !== householdId) throw Object.assign(new Error('Case not found.'), { code: 'CASE_NOT_FOUND', statusCode: 404 });
          if (this.#shape(existing).value === value) { counts.unchanged += 1; continue; }
          await db.run('UPDATE profile_answers SET value_ciphertext = ?, adult_user_id = ?, updated_at = ? WHERE id = ?',
            [this.crypto.seal(TABLE, COLUMN, existing.id, JSON.stringify({ v: value })), adultUserId, at, existing.id]);
        } else {
          const id = `profile-${randomUUID()}`;
          await db.run(`INSERT INTO profile_answers
            (id, household_id, case_id, adult_user_id, field_key, value_ciphertext, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
            id, householdId, caseId, adultUserId, fieldKey, this.crypto.seal(TABLE, COLUMN, id, JSON.stringify({ v: value })),
            PROFILE_ANSWER_SOURCE, at, at]);
        }
        counts.set += 1;
      }
      if (counts.set > 0 || counts.removed > 0) {
        await this.audit?.append({
          householdId, caseId, actorType: 'adult_user', actorId: adultUserId, action: 'profile_answers.updated',
          resourceType: 'case', resourceId: caseId, payload: { ...counts },
        });
      }
      return Object.freeze(counts);
    }, { locks: [householdLock(householdId)] });
  }

  /** Deletes every stored answer of a case. Counts-only audit. Joins a caller's transaction (savepoint). */
  async eraseForCase({ householdId, caseId, reasonCode = 'user_request', actorId = 'profile-answer-repository', actorType = 'system' }) {
    text(householdId, 'householdId'); text(caseId, 'caseId');
    if (!erasureReasons.has(reasonCode)) throw Object.assign(new Error('reasonCode is not supported.'), { code: 'PROFILE_ANSWER_INVALID', statusCode: 400 });
    return this.database.transaction(async () => {
      const { changes } = await this.database.run('DELETE FROM profile_answers WHERE household_id = ? AND case_id = ?', [householdId, caseId]);
      if (changes > 0) {
        await this.audit?.append({ householdId, caseId, actorType, actorId, action: 'profile_answers.erased', resourceType: 'case', resourceId: caseId, payload: { reasonCode, answers: changes } });
      }
      return Object.freeze({ answers: changes });
    }, { locks: [householdLock(householdId)] });
  }

  /** Deletes every stored answer of a household (for a future household erasure path). */
  async eraseForHousehold({ householdId, reasonCode = 'household_erasure', actorId = 'profile-answer-repository', actorType = 'system' }) {
    text(householdId, 'householdId');
    if (!erasureReasons.has(reasonCode)) throw Object.assign(new Error('reasonCode is not supported.'), { code: 'PROFILE_ANSWER_INVALID', statusCode: 400 });
    return this.database.transaction(async () => {
      const { changes } = await this.database.run('DELETE FROM profile_answers WHERE household_id = ?', [householdId]);
      if (changes > 0) {
        await this.audit?.append({ householdId, actorType, actorId, action: 'profile_answers.erased', resourceType: 'household', resourceId: householdId, payload: { reasonCode, answers: changes } });
      }
      return Object.freeze({ answers: changes });
    }, { locks: [householdLock(householdId)] });
  }
}
