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

  getAdult(adultId) { return this.database.prepare('SELECT * FROM adult_users WHERE id = ?').get(adultId) ?? null; }
  getHousehold(householdId) { return this.database.prepare('SELECT * FROM households WHERE id = ?').get(householdId) ?? null; }
  listMembers(householdId) { return this.database.prepare('SELECT * FROM household_members WHERE household_id = ? ORDER BY created_at').all(householdId); }
}

