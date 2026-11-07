import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';

const id = prefix => `${prefix}-${randomUUID()}`;
const MEMBER_SEALED = ['display_name', 'relationship_label', 'date_of_birth'];
const optionalText = value => (value === null || value === undefined ? null : String(value));

// Async PostgreSQL interface (S3.2). Each insert and its audit event commit in one transaction
// that holds the household advisory lock (design section 3).
export class HouseholdRepository {
  constructor(database, { clock = () => new Date(), audit, ...options } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    // Names, e-mail and phone are sealed before they are stored (ADR 0013) and opened at the edge of this class, so callers
    // see the same plain rows as before. An unprefixed stored value is legacy plaintext until the backfill seals it.
    this.crypto = resolveColumnCrypto(options);
  }

  #adult(row) { return this.crypto.openRow('adult_users', row, ['display_name', 'contact_email', 'contact_phone']); }
  #household(row) { return this.crypto.openRow('households', row, ['display_name']); }
  #member(row) { return this.crypto.openRow('household_members', row, MEMBER_SEALED); }

  async createAdult({ id: adultId = id('adult'), displayName, contactEmail = null, contactPhone = null, locale = 'en-IN', accountStatus = 'active' }) {
    if (!String(displayName || '').trim()) throw new Error('Adult display name is required.');
    const at = this.clock().toISOString();
    const db = this.database;
    await db.transaction(async () => {
      await db.run(`INSERT INTO adult_users
        (id, display_name, contact_email, contact_phone, locale, account_status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [adultId, this.crypto.seal('adult_users', 'display_name', adultId, displayName.trim()),
        this.crypto.seal('adult_users', 'contact_email', adultId, optionalText(contactEmail)),
        this.crypto.seal('adult_users', 'contact_phone', adultId, optionalText(contactPhone)), locale, accountStatus, at, at]);
      await this.audit?.append({ actorType: 'adult_user', actorId: adultId, action: 'adult.created', resourceType: 'adult_user', resourceId: adultId });
    }, { locks: [householdLock(null)] });
    return this.getAdult(adultId);
  }

  async createHousehold({ id: householdId = id('household'), displayName, ownerAdultId }) {
    if (!String(displayName || '').trim()) throw new Error('Household display name is required.');
    const at = this.clock().toISOString();
    const db = this.database;
    await db.transaction(async () => {
      await db.run('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [householdId, this.crypto.seal('households', 'display_name', householdId, displayName.trim()), at, at]);
      if (ownerAdultId) {
        await db.run(`INSERT INTO household_roles
          (id, household_id, adult_user_id, role, status, starts_at, created_at)
          VALUES (?, ?, ?, 'owner', 'active', ?, ?)`,
        [id('role'), householdId, ownerAdultId, at, at]);
      }
      await this.audit?.append({ householdId, actorType: ownerAdultId ? 'adult_user' : 'system', actorId: ownerAdultId || 'local-backend', action: 'household.created', resourceType: 'household', resourceId: householdId });
    }, { locks: [householdLock(householdId)] });
    return this.getHousehold(householdId);
  }

  async addMember({ id: memberId = id('member'), householdId, adultUserId = null, displayName, memberKind = adultUserId ? 'adult' : 'dependent', relationshipLabel = null, dateOfBirth = null }) {
    const at = this.clock().toISOString();
    const db = this.database;
    await db.transaction(async () => {
      await db.run(`INSERT INTO household_members
        (id, household_id, adult_user_id, display_name, member_kind, relationship_label, date_of_birth, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [memberId, householdId, adultUserId, this.crypto.seal('household_members', 'display_name', memberId, optionalText(displayName)), memberKind,
        this.crypto.seal('household_members', 'relationship_label', memberId, optionalText(relationshipLabel)),
        this.crypto.seal('household_members', 'date_of_birth', memberId, optionalText(dateOfBirth)), at, at]);
      await this.audit?.append({ householdId, actorType: adultUserId ? 'adult_user' : 'system', actorId: adultUserId || 'local-backend', action: 'household_member.added', resourceType: 'household_member', resourceId: memberId });
    }, { locks: [householdLock(householdId)] });
    return this.#member(await db.one('SELECT * FROM household_members WHERE id = ?', [memberId]));
  }

  async addRole({ id: roleId = id('role'), householdId, adultUserId, role, status = 'active' }) {
    const at = this.clock().toISOString();
    await this.database.run(`INSERT INTO household_roles
      (id, household_id, adult_user_id, role, status, starts_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [roleId, householdId, adultUserId, role, status, status === 'active' ? at : null, at]);
    return this.database.one('SELECT * FROM household_roles WHERE id = ?', [roleId]);
  }

  async getAdult(adultId) { return this.#adult(await this.database.one('SELECT * FROM adult_users WHERE id = ?', [adultId])) ?? null; }
  async getHousehold(householdId) { return this.#household(await this.database.one('SELECT * FROM households WHERE id = ?', [householdId])) ?? null; }
  async listMembers(householdId) { return (await this.database.many('SELECT * FROM household_members WHERE household_id = ? ORDER BY created_at, id', [householdId])).map(row => this.#member(row)); }

  async getActiveRole(householdId, adultUserId) {
    const at = this.clock().toISOString();
    return (await this.database.one(`SELECT * FROM household_roles
      WHERE household_id = ? AND adult_user_id = ? AND status = 'active'
        AND (starts_at IS NULL OR julianday(starts_at) <= julianday(?))
        AND (ends_at IS NULL OR julianday(ends_at) > julianday(?))
      ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'operator' THEN 2 WHEN 'member' THEN 3
        WHEN 'backup_operator' THEN 4 ELSE 5 END LIMIT 1`, [householdId, adultUserId, at, at])) ?? null;
  }

  async listActiveRoles(householdId, adultUserId) {
    const at = this.clock().toISOString();
    return this.database.many(`SELECT * FROM household_roles
      WHERE household_id = ? AND adult_user_id = ? AND status = 'active'
        AND (starts_at IS NULL OR julianday(starts_at) <= julianday(?))
        AND (ends_at IS NULL OR julianday(ends_at) > julianday(?))
      ORDER BY role, id`, [householdId, adultUserId, at, at]);
  }

  // Denies (HOUSEHOLD_NOT_FOUND) unless both reads succeed and allow; a failed read rejects.
  async requireAccess(householdId, adultUserId, { write = false } = {}) {
    const household = await this.getHousehold(householdId);
    const role = household ? await this.getActiveRole(householdId, adultUserId) : null;
    const allowed = Boolean(role) && (!write || ['owner', 'member', 'operator', 'backup_operator'].includes(role.role));
    if (!allowed || household.status !== 'active') {
      const error = new Error('Household not found.');
      error.code = 'HOUSEHOLD_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    return { household, role };
  }
}
