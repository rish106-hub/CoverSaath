import { createHash, randomUUID } from 'node:crypto';
import { authIdentityLock } from '../database/postgres/locks.js';

// Maps a sign-in identity (issuer, subject) to one adult and starts a session for it (ADR 0012 D3).
// The subject is stored only as sha256(issuer LF subject). Nothing is looked up by e-mail or name, and
// nothing here logs. The caller (the route) has already checked the server credential and the issuer allow-list.

const unauthenticated = () => Object.assign(new Error('Valid authentication is required.'), { code: 'AUTHENTICATION_REQUIRED', statusCode: 401 });
const householdNotFound = () => Object.assign(new Error('Household not found.'), { code: 'HOUSEHOLD_NOT_FOUND', statusCode: 404 });

/** sha256(issuer + "\n" + subject) as lowercase hex. The issuer comes from a fixed allow-list, so the join is unambiguous. */
export function identityHash(issuer, subject) {
  return createHash('sha256').update(`${issuer}\n${subject}`).digest('hex');
}

export class AuthIdentityRepository {
  constructor(database, { clock = () => new Date(), audit, households, auth, authTokens } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
    this.auth = auth;
    this.authTokens = authTokens;
  }

  /**
   * One transaction under an advisory lock on the identity hash, so two first calls for the same identity make one
   * adult. A returning identity gets a new session for its oldest active owner household; a revoked identity or an
   * inactive adult is refused (401). A session-cap refusal (429) rolls everything back, including a new adult.
   * Resolves { returning, household: { id }, adultId, memberId, session }.
   * `web` starts a revocable web session with a refresh token (JWT sign-in, ADR 0016) instead of an opaque bearer session;
   * `amr` is then the recorded authentication method.
   */
  async signIn({ issuer, subject, displayName, contactEmail = null, web = false, amr = 'beta' }) {
    const hash = identityHash(issuer, subject);
    const db = this.database;
    const issue = (adultUserId, householdId, authIdentityId) => (web
      ? this.authTokens.createWebSession({ adultUserId, householdId, amr, authIdentityId })
      : this.auth.issueSession({ adultUserId }));
    return db.transaction(async () => {
      const at = this.clock().toISOString();
      const existing = await db.one('SELECT * FROM auth_identities WHERE issuer = ? AND subject_sha256 = ?', [issuer, hash]);
      if (existing) {
        if (existing.revoked_at) throw unauthenticated();
        const adult = await this.households.getAdult(existing.adult_user_id);
        if (!adult || adult.account_status !== 'active') throw unauthenticated();
        const home = await this.#oldestOwnedHousehold(adult.id, at);
        if (!home) throw householdNotFound();
        const session = await issue(adult.id, home.household_id, existing.id);
        await db.run('UPDATE auth_identities SET last_used_at = ? WHERE id = ?', [at, existing.id]);
        return { returning: true, household: { id: home.household_id }, adultId: adult.id, memberId: home.member_id, session };
      }
      const adult = await this.households.createAdult({ displayName, contactEmail });
      const household = await this.households.createHousehold({ displayName: `${displayName} household`, ownerAdultId: adult.id });
      const member = await this.households.addMember({ householdId: household.id, adultUserId: adult.id, displayName: adult.display_name });
      const identityId = `identity-${randomUUID()}`;
      await db.run(`INSERT INTO auth_identities (id, adult_user_id, issuer, subject_sha256, created_at, last_used_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [identityId, adult.id, issuer, hash, at, at]);
      // Counts only: neither the issuer nor the subject is written to the audit chain.
      await this.audit?.append({ householdId: household.id, actorType: 'system', actorId: 'identity-service', action: 'auth_identity.created', resourceType: 'auth_identity', resourceId: identityId });
      const session = await issue(adult.id, household.id, identityId);
      return { returning: false, household: { id: household.id }, adultId: adult.id, memberId: member.id, session };
    }, { locks: [authIdentityLock(hash)] });
  }

  async #oldestOwnedHousehold(adultId, at) {
    return this.database.one(`SELECT households.id AS household_id,
        (SELECT household_members.id FROM household_members
          WHERE household_members.household_id = households.id AND household_members.adult_user_id = household_roles.adult_user_id
          ORDER BY household_members.created_at, household_members.id LIMIT 1) AS member_id
      FROM household_roles JOIN households ON households.id = household_roles.household_id
      WHERE household_roles.adult_user_id = ? AND household_roles.role = 'owner' AND household_roles.status = 'active'
        AND (household_roles.starts_at IS NULL OR julianday(household_roles.starts_at) <= julianday(?))
        AND (household_roles.ends_at IS NULL OR julianday(household_roles.ends_at) > julianday(?))
        AND households.status = 'active'
        AND EXISTS (SELECT 1 FROM household_members hm WHERE hm.household_id = households.id AND hm.adult_user_id = household_roles.adult_user_id)
      ORDER BY households.created_at, households.id LIMIT 1`, [adultId, at, at]);
  }
}
