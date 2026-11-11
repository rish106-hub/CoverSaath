import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { LIST_LIMIT, fail, invalid, isDay, requireGrant, requirePerson, str } from './holdings-common.js';

// Member declarations (migration 051, ADR 0032): what a member declared to an insurer or on a proposal form. The label is health data:
// sealed (AAD member_declarations.label_enc.<row id>), opened only here. A declaration about a dependant, and any health declaration,
// needs the household owner, the member's guardian adult or the member (the ADR 0026 rule); another real adult's own details are
// theirs alone. Every read and write is scoped to a household the acting adult can see. Writes append a counts-only audit event
// (ids and kind, never the label) in the same transaction, under the household lock, with a current profile_intake grant of the adult.

export const DECLARATION_KINDS = Object.freeze(['pre_existing_disease', 'prior_condition', 'habit', 'occupation', 'nominee', 'other']);
const HEALTH_KINDS = new Set(['pre_existing_disease', 'prior_condition']);
const TABLE = 'member_declarations';
const notFound = () => fail('DECLARATION_NOT_FOUND', 'Declaration not found.', 404);

export class DeclarationRepository {
  constructor(database, { clock = () => new Date(), audit = null, households, ...options } = {}) {
    if (!database || !households) throw new TypeError('A database and households are required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
    this.crypto = resolveColumnCrypto(options);
  }

  #dto(row) {
    return {
      id: row.id, memberId: row.member_id, holdingId: row.holding_id, kind: row.kind, label: this.crypto.openJson(TABLE, 'label_enc', row.id, row.label_enc),
      declaredOn: row.declared_on, declaredToInsurer: row.declared_to_insurer, documentId: row.document_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // The member the declaration is about, after the guardian rules. Never reveals another household's member.
  async #member(db, { householdId, adultId, role, memberId, kind }) {
    const member = await db.one('SELECT id, adult_user_id, member_kind, guardian_member_id FROM household_members WHERE id = ? AND household_id = ?', [str(memberId, 'memberId'), householdId]);
    if (!member) fail('MEMBER_NOT_FOUND', 'Member not found.', 404);
    if (member.adult_user_id && member.adult_user_id !== adultId) {
      const adult = await db.one('SELECT account_status FROM adult_users WHERE id = ?', [member.adult_user_id]);
      if (adult?.account_status !== 'invited') fail('MEMBER_PROTECTED', 'This adult manages their own details; they cannot be changed here.', 403);
    }
    if (member.member_kind === 'dependent' || HEALTH_KINDS.has(kind)) {
      let allowed = role.role === 'owner' || member.adult_user_id === adultId;
      if (!allowed && member.guardian_member_id) {
        const guardian = await db.one('SELECT adult_user_id FROM household_members WHERE id = ? AND household_id = ?', [member.guardian_member_id, householdId]);
        allowed = guardian?.adult_user_id === adultId;
      }
      if (!allowed) fail('GUARDIAN_REQUIRED', 'Only the household owner or the guardian adult can use these declarations.', 403);
    }
    return member;
  }

  #check({ kind, label, declaredOn, declaredToInsurer }) {
    if (!DECLARATION_KINDS.includes(kind)) invalid('kind is invalid.');
    str(label, 'label', 500);
    if (declaredOn !== null && !isDay(declaredOn)) invalid('declaredOn is invalid.');
    if (declaredToInsurer !== null && typeof declaredToInsurer !== 'boolean') invalid('declaredToInsurer is invalid.');
  }

  async create({ householdId, adultId, memberId, kind, label, declaredOn = null, declaredToInsurer = null, holdingId = null, documentId = null, consentGrantId }) {
    this.#check({ kind, label, declaredOn, declaredToInsurer });
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      const role = await requirePerson(this.households, householdId, adultId, { write: true });
      await this.#member(db, { householdId, adultId, role, memberId, kind });
      await requireGrant(db, { householdId, grantId: consentGrantId, purpose: 'profile_intake', subjectAdultId: adultId, now: at });
      const rowId = `decl-${randomUUID()}`;
      try {
        await db.run(`INSERT INTO ${TABLE} (id, household_id, member_id, holding_id, kind, label_enc, declared_on, declared_to_insurer, document_id, consent_grant_id, declared_by_adult_id, revision, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, [rowId, householdId, memberId, holdingId, kind, this.crypto.sealJson(TABLE, 'label_enc', rowId, label), declaredOn, declaredToInsurer, documentId, consentGrantId, adultId, at, at]);
      } catch (error) {
        if (/declaration must match/.test(String(error?.message))) notFound();
        throw error;
      }
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'declaration.created', resourceType: 'member_declaration', resourceId: rowId, payload: { kind } });
      return this.#dto(await db.one(`SELECT * FROM ${TABLE} WHERE id = ?`, [rowId]));
    }, { locks: [householdLock(householdId)] });
  }

  async update({ householdId, adultId, declarationId, label, declaredOn = null, declaredToInsurer = null, ifMatch = null, consentGrantId }) {
    str(label, 'label', 500);
    if (declaredOn !== null && !isDay(declaredOn)) invalid('declaredOn is invalid.');
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      const role = await requirePerson(this.households, householdId, adultId, { write: true });
      const row = await db.one(`SELECT * FROM ${TABLE} WHERE id = ? AND household_id = ? FOR UPDATE`, [str(declarationId, 'declarationId'), householdId]);
      if (!row) notFound();
      await this.#member(db, { householdId, adultId, role, memberId: row.member_id, kind: row.kind });
      await requireGrant(db, { householdId, grantId: consentGrantId, purpose: 'profile_intake', subjectAdultId: adultId, now: at });
      if (ifMatch !== null && ifMatch !== row.revision) fail('REVISION_CONFLICT', 'This was changed elsewhere. Reload and try again.', 409);
      await db.run(`UPDATE ${TABLE} SET label_enc = ?, declared_on = ?, declared_to_insurer = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        [this.crypto.sealJson(TABLE, 'label_enc', row.id, label), declaredOn, declaredToInsurer, this.clock().toISOString(), row.id]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'declaration.updated', resourceType: 'member_declaration', resourceId: row.id, payload: { kind: row.kind } });
      return this.#dto(await db.one(`SELECT * FROM ${TABLE} WHERE id = ?`, [row.id]));
    }, { locks: [householdLock(householdId)] });
  }

  /** The declarations the viewer may see (a member's, when `memberId` is given: that member is authorised like a write). */
  async list({ householdId, adultId, memberId = null }) {
    const role = await requirePerson(this.households, householdId, adultId);
    if (memberId) await this.#member(this.database, { householdId, adultId, role, memberId, kind: 'other' });
    const rows = await this.database.many(`SELECT declaration.*, member.adult_user_id AS subject_adult_id, member.member_kind AS subject_kind,
        guardian.adult_user_id AS guardian_adult_id, adult.account_status AS subject_status
      FROM ${TABLE} AS declaration JOIN household_members AS member ON member.id = declaration.member_id
      LEFT JOIN household_members AS guardian ON guardian.id = member.guardian_member_id
      LEFT JOIN adult_users AS adult ON adult.id = member.adult_user_id
      WHERE declaration.household_id = ? AND (?::text IS NULL OR declaration.member_id = ?) ORDER BY declaration.created_at, declaration.id LIMIT ?`,
    [householdId, memberId, memberId, LIST_LIMIT + 1]);
    const visible = rows.filter(row => {
      if (row.subject_adult_id && row.subject_adult_id !== adultId && row.subject_status !== 'invited') return false;
      if (row.subject_kind === 'dependent' || HEALTH_KINDS.has(row.kind)) return role.role === 'owner' || row.subject_adult_id === adultId || row.guardian_adult_id === adultId;
      return true;
    });
    return { declarations: visible.slice(0, LIST_LIMIT).map(row => this.#dto(row)), truncated: rows.length > LIST_LIMIT };
  }

  async delete({ householdId, adultId, declarationId }) {
    const db = this.database;
    return db.transaction(async () => {
      const role = await requirePerson(this.households, householdId, adultId, { write: true });
      const row = await db.one(`SELECT id, member_id, kind FROM ${TABLE} WHERE id = ? AND household_id = ? FOR UPDATE`, [str(declarationId, 'declarationId'), householdId]);
      if (!row) notFound();
      await this.#member(db, { householdId, adultId, role, memberId: row.member_id, kind: row.kind });
      await db.run(`DELETE FROM ${TABLE} WHERE id = ?`, [row.id]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'declaration.deleted', resourceType: 'member_declaration', resourceId: row.id, payload: { kind: row.kind } });
    }, { locks: [householdLock(householdId)] });
  }
}
