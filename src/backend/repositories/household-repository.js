import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;

export class HouseholdRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  createAdult({ id: adultId = id('adult'), displayName, contactEmail = null, contactPhone = null, locale = 'en-IN', accountStatus = 'active' }) {
    if (!String(displayName || '').trim()) throw new Error('Adult display name is required.');
    const at = this.clock().toISOString();
    this.database.prepare(`INSERT INTO adult_users
      (id, display_name, contact_email, contact_phone, locale, account_status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(adultId, displayName.trim(), contactEmail, contactPhone, locale, accountStatus, at, at);
    this.audit?.append({ actorType: 'adult_user', actorId: adultId, action: 'adult.created', resourceType: 'adult_user', resourceId: adultId });
    return this.getAdult(adultId);
  }

  createHousehold({ id: householdId = id('household'), displayName, ownerAdultId }) {
    if (!String(displayName || '').trim()) throw new Error('Household display name is required.');
    const at = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(householdId, displayName.trim(), at, at);
      if (ownerAdultId) {
        this.database.prepare(`INSERT INTO household_roles
          (id, household_id, adult_user_id, role, status, starts_at, created_at)
          VALUES (?, ?, ?, 'owner', 'active', ?, ?)`)
          .run(id('role'), householdId, ownerAdultId, at, at);
      }
      this.audit?.append({ householdId, actorType: ownerAdultId ? 'adult_user' : 'system', actorId: ownerAdultId || 'local-backend', action: 'household.created', resourceType: 'household', resourceId: householdId });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.getHousehold(householdId);
  }

  addMember({ id: memberId = id('member'), householdId, adultUserId = null, displayName, memberKind = adultUserId ? 'adult' : 'dependent', relationshipLabel = null, dateOfBirth = null }) {
    const at = this.clock().toISOString();
    this.database.prepare(`INSERT INTO household_members
      (id, household_id, adult_user_id, display_name, member_kind, relationship_label, date_of_birth, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memberId, householdId, adultUserId, displayName, memberKind, relationshipLabel, dateOfBirth, at, at);
    this.audit?.append({ householdId, actorType: adultUserId ? 'adult_user' : 'system', actorId: adultUserId || 'local-backend', action: 'household_member.added', resourceType: 'household_member', resourceId: memberId });
    return this.database.prepare('SELECT * FROM household_members WHERE id = ?').get(memberId);
  }

  addRole({ id: roleId = id('role'), householdId, adultUserId, role, status = 'active' }) {
    const at = this.clock().toISOString();
    this.database.prepare(`INSERT INTO household_roles
      (id, household_id, adult_user_id, role, status, starts_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(roleId, householdId, adultUserId, role, status, status === 'active' ? at : null, at);
    return this.database.prepare('SELECT * FROM household_roles WHERE id = ?').get(roleId);
  }

  setCity({ householdId, city, actorAdultId }) {
    const at = this.clock().toISOString();
    this.database.prepare('UPDATE households SET city = ?, updated_at = ? WHERE id = ?').run(city, at, householdId);
    this.audit?.append({ householdId, actorType: 'adult_user', actorId: actorAdultId, action: 'household.city_set', resourceType: 'household', resourceId: householdId });
    return this.getHousehold(householdId);
  }

  getAdult(adultId) { return this.database.prepare('SELECT * FROM adult_users WHERE id = ?').get(adultId) ?? null; }
  getHousehold(householdId) { return this.database.prepare('SELECT * FROM households WHERE id = ?').get(householdId) ?? null; }
  listMembers(householdId) { return this.database.prepare('SELECT * FROM household_members WHERE household_id = ? ORDER BY created_at').all(householdId); }

  getActiveRole(householdId, adultUserId) {
    return this.database.prepare(`SELECT * FROM household_roles
      WHERE household_id = ? AND adult_user_id = ? AND status = 'active'
        AND (starts_at IS NULL OR julianday(starts_at) <= julianday(?))
        AND (ends_at IS NULL OR julianday(ends_at) > julianday(?))
      ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'operator' THEN 2 WHEN 'member' THEN 3
        WHEN 'backup_operator' THEN 4 ELSE 5 END LIMIT 1`)
      .get(householdId, adultUserId, this.clock().toISOString(), this.clock().toISOString()) ?? null;
  }

  requireAccess(householdId, adultUserId, { write = false } = {}) {
    const household = this.getHousehold(householdId);
    const role = household && this.getActiveRole(householdId, adultUserId);
    const allowed = role && (!write || ['owner', 'member', 'operator', 'backup_operator'].includes(role.role));
    if (!allowed || household.status !== 'active') {
      const error = new Error('Household not found.');
      error.code = 'HOUSEHOLD_NOT_FOUND';
      error.statusCode = 404;
      throw error;
    }
    return { household, role };
  }
}
