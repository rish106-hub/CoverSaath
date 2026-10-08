import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;

export class HouseholdRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  async createAdult({ id: adultId = id('adult'), displayName, contactEmail = null, contactPhone = null, locale = 'en-IN', accountStatus = 'active' }) {
    if (!String(displayName || '').trim()) throw new Error('Adult display name is required.');
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      await tx.query(`INSERT INTO adult_users
        (id, display_name, contact_email, contact_phone, locale, account_status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [adultId, displayName.trim(), contactEmail, contactPhone, locale, accountStatus, at, at]);
      await this.audit?.append({ actorType: 'adult_user', actorId: adultId, action: 'adult.created', resourceType: 'adult_user', resourceId: adultId });
    });
    return this.getAdult(adultId);
  }

  async createHousehold({ id: householdId = id('household'), displayName, ownerAdultId }) {
    if (!String(displayName || '').trim()) throw new Error('Household display name is required.');
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      await tx.query('INSERT INTO households (id, display_name, created_at, updated_at) VALUES ($1, $2, $3, $4)',
        [householdId, displayName.trim(), at, at]);
      if (ownerAdultId) {
        await tx.query(`INSERT INTO household_roles
          (id, household_id, adult_user_id, role, status, starts_at, created_at)
          VALUES ($1, $2, $3, 'owner', 'active', $4, $5)`, [id('role'), householdId, ownerAdultId, at, at]);
      }
      await this.audit?.append({ householdId, actorType: ownerAdultId ? 'adult_user' : 'system', actorId: ownerAdultId || 'local-backend', action: 'household.created', resourceType: 'household', resourceId: householdId });
    });
    return this.getHousehold(householdId);
  }

  async addMember({ id: memberId = id('member'), householdId, adultUserId = null, displayName, memberKind = adultUserId ? 'adult' : 'dependent', relationshipLabel = null, dateOfBirth = null }) {
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      await tx.query(`INSERT INTO household_members
        (id, household_id, adult_user_id, display_name, member_kind, relationship_label, date_of_birth, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [memberId, householdId, adultUserId, displayName, memberKind, relationshipLabel, dateOfBirth, at, at]);
      await this.audit?.append({ householdId, actorType: adultUserId ? 'adult_user' : 'system', actorId: adultUserId || 'local-backend', action: 'household_member.added', resourceType: 'household_member', resourceId: memberId });
    });
    return this.database.one('SELECT * FROM household_members WHERE id = $1', [memberId]);
  }

  async addRole({ id: roleId = id('role'), householdId, adultUserId, role, status = 'active' }) {
    const at = this.clock().toISOString();
    await this.database.query(`INSERT INTO household_roles
      (id, household_id, adult_user_id, role, status, starts_at, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [roleId, householdId, adultUserId, role, status, status === 'active' ? at : null, at]);
    return this.database.one('SELECT * FROM household_roles WHERE id = $1', [roleId]);
  }

  async setCity({ householdId, city, actorAdultId }) {
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      await tx.query('UPDATE households SET city = $1, updated_at = $2 WHERE id = $3', [city, at, householdId]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: actorAdultId, action: 'household.city_set', resourceType: 'household', resourceId: householdId });
    });
    return this.getHousehold(householdId);
  }

  async getAdult(adultId) { return await this.database.one('SELECT * FROM adult_users WHERE id = $1', [adultId]); }
  async getHousehold(householdId) { return await this.database.one('SELECT * FROM households WHERE id = $1', [householdId]); }
  listMembers(householdId) { return this.database.query('SELECT * FROM household_members WHERE household_id = $1 ORDER BY created_at', [householdId]); }

  async getActiveRole(householdId, adultUserId) {
    const at = this.clock().toISOString();
    return await this.database.one(`SELECT * FROM household_roles
      WHERE household_id = $1 AND adult_user_id = $2 AND status = 'active'
        AND (starts_at IS NULL OR starts_at <= $3::timestamptz)
        AND (ends_at IS NULL OR ends_at > $3::timestamptz)
      ORDER BY CASE role WHEN 'owner' THEN 1 WHEN 'operator' THEN 2 WHEN 'member' THEN 3
        WHEN 'backup_operator' THEN 4 ELSE 5 END LIMIT 1`, [householdId, adultUserId, at]);
  }

  async requireAccess(householdId, adultUserId, { write = false } = {}) {
    const household = await this.getHousehold(householdId);
    const role = household && await this.getActiveRole(householdId, adultUserId);
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
