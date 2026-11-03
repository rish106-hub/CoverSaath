import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { RECORD_TYPES, RECORD_TYPE_NAMES } from '../../contracts/capture-registry.js';

// Person records (ADR 0018): the sealed store for health context, nominees, emergency contacts, advisors, member notes, self profile
// and out-of-pocket spend. The typed payload is sealed (ADR 0013) with AAD person_records.payload_ciphertext.<row id> and opened only
// here; plain columns are ids, the closed enums, completeness, schema version, timestamps and the revision. Authorisation is proved
// inside each transaction under the household advisory lock: household access, the subject member's household, the real-adult rule,
// the guardian rule for dependants and health context, and a current consent grant for consent-gated types. Every write appends a
// counts-only audit event (ids and field names, never a value) in the same transaction.

const id = prefix => `${prefix}-${randomUUID()}`;
const fail = (code, message, statusCode) => { throw Object.assign(new Error(message), { code, statusCode }); };
const conflict = () => fail('REVISION_CONFLICT', 'This was changed elsewhere. Reload and try again.', 409);
const WRITE_ROLES = ['owner', 'member'];
const LIST_LIMIT = 200;

function checkRevision(existing, ifMatch) {
  if (ifMatch === null || ifMatch === undefined) return;
  if ((existing?.revision ?? 0) !== ifMatch) conflict();
}

export class PersonRecordRepository {
  constructor(database, { clock = () => new Date(), audit, households, ...options } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
    this.crypto = resolveColumnCrypto(options);
  }

  #now() { return this.clock().toISOString(); }

  #dto(row) {
    return {
      type: row.record_type, slot: row.slot, memberId: row.subject_member_id,
      data: this.crypto.openJson('person_records', 'payload_ciphertext', row.id, row.payload_ciphertext),
      source: row.source, state: row.state, completeness: row.completeness, schemaVersion: row.schema_version,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // True when the acting adult holds a current grant (not revoked, not expired) with a profile_field collect scope for the category.
  async #hasConsent(householdId, adultId, category) {
    const row = await this.database.one(`SELECT 1 AS found FROM consent_grants AS grant_record
      JOIN consent_scopes AS scope ON scope.consent_grant_id = grant_record.id
      WHERE grant_record.household_id = ? AND grant_record.subject_adult_id = ? AND grant_record.purpose = 'profile_intake'
        AND grant_record.revoked_at IS NULL AND (grant_record.expires_at IS NULL OR julianday(grant_record.expires_at) > julianday(?))
        AND scope.resource_type = 'profile_field' AND scope.action = 'collect' AND scope.data_category = ? LIMIT 1`,
    [householdId, adultId, this.#now(), category]);
    return Boolean(row);
  }

  // The subject member of a record, or null for a household-level record. Throws coded errors; never reveals another household.
  async #subject(householdId, adultId, role, type, memberId) {
    const meta = RECORD_TYPES[type];
    let member = null;
    if (memberId) {
      member = await this.database.one('SELECT id, adult_user_id, member_kind, guardian_member_id FROM household_members WHERE id = ? AND household_id = ?', [memberId, householdId]);
      if (!member) fail('MEMBER_NOT_FOUND', 'Member not found.', 404);
    } else if (meta.subject === 'member_required') {
      if (type !== 'self_profile') fail('INVALID_REQUEST', 'memberId is required for this record type.', 400);
      member = await this.database.one('SELECT id, adult_user_id, member_kind, guardian_member_id FROM household_members WHERE household_id = ? AND adult_user_id = ?', [householdId, adultId]);
      if (!member) fail('MEMBER_NOT_FOUND', 'Member not found.', 404);
    }
    if (!member) return null;
    // Another real adult manages their own details (same rule as member and place edits).
    if (member.adult_user_id && member.adult_user_id !== adultId) {
      const adult = await this.database.one('SELECT account_status FROM adult_users WHERE id = ?', [member.adult_user_id]);
      if (adult?.account_status !== 'invited') fail('MEMBER_PROTECTED', 'This adult manages their own details; they cannot be changed here.', 403);
    }
    // A dependant's records, and anyone's health context, need the household owner or the member's guardian adult (or the member).
    if (member.member_kind === 'dependent' || type === 'health_context') {
      let allowed = role.role === 'owner' || member.adult_user_id === adultId;
      if (!allowed && member.guardian_member_id) {
        const guardian = await this.database.one('SELECT adult_user_id FROM household_members WHERE id = ? AND household_id = ?', [member.guardian_member_id, householdId]);
        allowed = guardian?.adult_user_id === adultId;
      }
      if (!allowed) fail('GUARDIAN_REQUIRED', 'Only the household owner or the guardian adult can use these records.', 403);
    }
    return member;
  }

  async #authorise({ householdId, adultId, type, memberId, write }) {
    const { role } = await this.households.requireAccess(householdId, adultId, { write });
    if (write && !WRITE_ROLES.includes(role.role)) fail('HOUSEHOLD_WRITE_FORBIDDEN', 'Your role in this household can read but not change it.', 403);
    const member = await this.#subject(householdId, adultId, role, type, memberId);
    const category = RECORD_TYPES[type].consentCategory;
    if (category && !(await this.#hasConsent(householdId, adultId, category))) {
      fail('CONSENT_REQUIRED', 'Active consent is required before this information can be stored or read.', 403);
    }
    return member;
  }

  #where(householdId, subjectId, type, slot) {
    return { sql: `household_id = ? AND COALESCE(subject_member_id, '') = ? AND record_type = ? AND slot = ?`, params: [householdId, subjectId ?? '', type, slot] };
  }

  async get({ householdId, adultId, type, slot, memberId = null }) {
    const member = await this.#authorise({ householdId, adultId, type, memberId, write: false });
    const where = this.#where(householdId, member?.id ?? null, type, slot);
    const row = await this.database.one(`SELECT * FROM person_records WHERE ${where.sql}`, where.params);
    if (!row) fail('RECORD_NOT_FOUND', 'Record not found.', 404);
    return this.#dto(row);
  }

  /**
   * The records the viewer may see. With `memberId` the subject is authorised like a single read (it throws). Without it, records
   * of subjects the viewer may not see are left out, and consent-gated types the viewer has no consent for are named in `withheld`
   * (an explicit `type` of a gated kind without consent throws CONSENT_REQUIRED instead).
   */
  async list({ householdId, adultId, type = null, memberId = null }) {
    const { role } = await this.households.requireAccess(householdId, adultId);
    const types = type ? [type] : RECORD_TYPE_NAMES;
    if (memberId) await this.#subject(householdId, adultId, role, type ?? 'member_note', memberId);
    const allowedTypes = [];
    const withheld = [];
    for (const each of types) {
      const category = RECORD_TYPES[each].consentCategory;
      if (category && !(await this.#hasConsent(householdId, adultId, category))) {
        if (type) fail('CONSENT_REQUIRED', 'Active consent is required before this information can be stored or read.', 403);
        withheld.push(each);
      } else allowedTypes.push(each);
    }
    const rows = await this.database.many(`SELECT person_records.*, member.adult_user_id AS subject_adult_id, member.member_kind AS subject_kind,
        member.guardian_member_id AS subject_guardian_id, guardian.adult_user_id AS guardian_adult_id, adult.account_status AS subject_adult_status
      FROM person_records
      LEFT JOIN household_members AS member ON member.id = person_records.subject_member_id
      LEFT JOIN household_members AS guardian ON guardian.id = member.guardian_member_id
      LEFT JOIN adult_users AS adult ON adult.id = member.adult_user_id
      WHERE person_records.household_id = ? AND person_records.record_type = ANY(CAST(? AS text[]))
        AND (?::text IS NULL OR person_records.subject_member_id = ?)
      ORDER BY person_records.record_type, person_records.subject_member_id, person_records.slot, person_records.id LIMIT ?`,
    [householdId, allowedTypes, memberId, memberId, LIST_LIMIT + 1]);
    const visible = rows.filter(row => {
      if (row.subject_member_id) {
        if (row.subject_adult_id && row.subject_adult_id !== adultId && row.subject_adult_status !== 'invited') return false;
        if (row.subject_kind === 'dependent' || row.record_type === 'health_context') {
          if (!(role.role === 'owner' || row.subject_adult_id === adultId || row.guardian_adult_id === adultId)) return false;
        }
      }
      return true;
    });
    return { records: visible.slice(0, LIST_LIMIT).map(row => this.#dto(row)), withheld, truncated: rows.length > LIST_LIMIT };
  }

  /** Insert or replace one record. `parsed` comes from parseRecordBody. Resolves the stored record. */
  async set({ householdId, adultId, type, slot, memberId = null, parsed, ifMatch = null }) {
    const db = this.database;
    const at = this.#now();
    const meta = RECORD_TYPES[type];
    return db.transaction(async () => {
      const member = await this.#authorise({ householdId, adultId, type, memberId, write: true });
      const subjectId = member?.id ?? null;
      const where = this.#where(householdId, subjectId, type, slot);
      const existing = await db.one(`SELECT * FROM person_records WHERE ${where.sql} FOR UPDATE`, where.params);
      checkRevision(existing, ifMatch);
      if (!existing) {
        const held = Number((await db.one(`SELECT count(*) AS count FROM person_records WHERE household_id = ? AND COALESCE(subject_member_id, '') = ? AND record_type = ?`, [householdId, subjectId ?? '', type])).count);
        if (held >= meta.maxSlots) fail('RECORD_CAPACITY_REACHED', 'There is no room for another record of this type.', 429);
      }
      const rowId = existing?.id ?? id('prec');
      const sealed = this.crypto.sealJson('person_records', 'payload_ciphertext', rowId, parsed.data);
      if (existing) {
        await db.run(`UPDATE person_records SET payload_ciphertext = ?, schema_version = ?, completeness = ?, source = ?, state = ?, updated_at = ?, revision = revision + 1
          WHERE id = ?`, [sealed, parsed.schemaVersion, parsed.completeness, parsed.source, parsed.state, at, rowId]);
      } else {
        await db.run(`INSERT INTO person_records (id, household_id, subject_member_id, record_type, slot, payload_ciphertext, schema_version, completeness, source, state, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [rowId, householdId, subjectId, type, slot, sealed, parsed.schemaVersion, parsed.completeness, parsed.source, parsed.state, at, at]);
      }
      await this.audit?.append({
        householdId, actorType: 'adult_user', actorId: adultId, action: 'record.set', resourceType: 'person_record', resourceId: rowId,
        payload: { recordType: type, slot, memberScoped: Boolean(subjectId), fields: Object.keys(parsed.data), completeness: parsed.completeness, source: parsed.source },
      });
      return this.#dto(await db.one('SELECT * FROM person_records WHERE id = ?', [rowId]));
    }, { locks: [householdLock(householdId)] });
  }

  async delete({ householdId, adultId, type, slot, memberId = null, ifMatch = null }) {
    const db = this.database;
    return db.transaction(async () => {
      const member = await this.#authorise({ householdId, adultId, type, memberId, write: true });
      const where = this.#where(householdId, member?.id ?? null, type, slot);
      const existing = await db.one(`SELECT * FROM person_records WHERE ${where.sql} FOR UPDATE`, where.params);
      if (!existing) fail('RECORD_NOT_FOUND', 'Record not found.', 404);
      checkRevision(existing, ifMatch);
      await db.run('DELETE FROM person_records WHERE id = ?', [existing.id]);
      await this.audit?.append({
        householdId, actorType: 'adult_user', actorId: adultId, action: 'record.delete', resourceType: 'person_record', resourceId: existing.id,
        payload: { recordType: type, slot, memberScoped: Boolean(existing.subject_member_id) },
      });
    }, { locks: [householdLock(householdId)] });
  }
}
