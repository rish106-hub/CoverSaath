import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';

const id = prefix => `${prefix}-${randomUUID()}`;
const fail = (code, message, statusCode) => { throw Object.assign(new Error(message), { code, statusCode }); };

export const MAX_MEMBERS_PER_HOUSEHOLD = 20;
const MAX_POLICIES = 100;

// Members, insurers and policies for the app's Family, Policies and Home screens (app-data plan B-A). Existing tables only.
// Display names are sealed (ADR 0013) and opened at the edge of this class. So are the relationship label, date of birth and the policy number, version and dates (ADR 0013 addendum D2). Every write and its counts-only audit
// event commit in one transaction that holds the household advisory lock.
export class HouseholdAppRepository {
  constructor(database, { clock = () => new Date(), audit, ...options } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.crypto = resolveColumnCrypto(options);
  }

  #member(row) { return this.crypto.openRow('household_members', row, ['display_name', 'relationship_label', 'date_of_birth']); }
  #policy(row) { return this.crypto.openRow('policies', row, ['policy_number_masked', 'policy_version', 'starts_on', 'ends_on']); }
  #adult(row) { return this.crypto.openRow('adult_users', row, ['display_name', 'contact_email', 'contact_phone']); }

  async listMembers(householdId) {
    return (await this.database.many('SELECT * FROM household_members WHERE household_id = ? ORDER BY created_at, id LIMIT ?', [householdId, MAX_MEMBERS_PER_HOUSEHOLD + 5])).map(row => this.#member(row));
  }

  async getMember(householdId, memberId) {
    const row = await this.database.one('SELECT * FROM household_members WHERE id = ? AND household_id = ?', [memberId, householdId]);
    return row ? this.#member(row) : null;
  }

  // An adult member needs an adult_users row (schema CHECK). A not-yet-invited adult is a placeholder with account_status 'invited',
  // no contact details and no role, so it cannot sign in or read anything until an invite flow exists.
  async createMember({ householdId, actorAdultId, displayName, memberKind, relationshipLabel = null, dateOfBirth = null }) {
    const at = this.clock().toISOString();
    const db = this.database;
    const memberId = id('member');
    await db.transaction(async () => {
      const count = Number((await db.one('SELECT count(*) AS count FROM household_members WHERE household_id = ?', [householdId])).count);
      if (count >= MAX_MEMBERS_PER_HOUSEHOLD) fail('MEMBER_CAPACITY_REACHED', 'This household has reached the member limit.', 429);
      let adultId = null;
      if (memberKind === 'adult') {
        adultId = id('adult');
        await db.run(`INSERT INTO adult_users (id, display_name, contact_email, contact_phone, locale, account_status, created_at, updated_at)
          VALUES (?, ?, NULL, NULL, 'en-IN', 'invited', ?, ?)`, [adultId, this.crypto.seal('adult_users', 'display_name', adultId, displayName), at, at]);
      }
      await db.run(`INSERT INTO household_members
        (id, household_id, adult_user_id, display_name, member_kind, relationship_label, date_of_birth, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [memberId, householdId, adultId, this.crypto.seal('household_members', 'display_name', memberId, displayName), memberKind,
        this.crypto.seal('household_members', 'relationship_label', memberId, relationshipLabel), this.crypto.seal('household_members', 'date_of_birth', memberId, dateOfBirth), at, at]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: actorAdultId, action: 'household_member.added', resourceType: 'household_member', resourceId: memberId, payload: { memberKind } });
    }, { locks: [householdLock(householdId)] });
    return this.getMember(householdId, memberId);
  }

  // `changes` holds only the fields to change: displayName, relationshipLabel, dateOfBirth (null clears the last two).
  async updateMember({ householdId, actorAdultId, memberId, changes }) {
    const at = this.clock().toISOString();
    const db = this.database;
    await db.transaction(async () => {
      const row = await db.one('SELECT * FROM household_members WHERE id = ? AND household_id = ?', [memberId, householdId]);
      if (!row) fail('MEMBER_NOT_FOUND', 'Member not found.', 404);
      // A real adult (not an invited placeholder) owns their row: others cannot change it here, matching the consent-gated reads.
      if (row.adult_user_id && row.adult_user_id !== actorAdultId) {
        const adult = await db.one('SELECT account_status FROM adult_users WHERE id = ?', [row.adult_user_id]);
        if (adult?.account_status !== 'invited') fail('MEMBER_PROTECTED', 'This adult manages their own details; they cannot be changed here.', 403);
      }
      const sets = [];
      const params = [];
      const fields = [];
      if ('displayName' in changes) {
        sets.push('display_name = ?'); params.push(this.crypto.seal('household_members', 'display_name', memberId, changes.displayName)); fields.push('displayName');
        if (row.adult_user_id) {
          const adult = await db.one('SELECT account_status FROM adult_users WHERE id = ?', [row.adult_user_id]);
          if (adult?.account_status === 'invited') {
            await db.run('UPDATE adult_users SET display_name = ?, updated_at = ? WHERE id = ?', [this.crypto.seal('adult_users', 'display_name', row.adult_user_id, changes.displayName), at, row.adult_user_id]);
          }
        }
      }
      if ('relationshipLabel' in changes) { sets.push('relationship_label = ?'); params.push(this.crypto.seal('household_members', 'relationship_label', memberId, changes.relationshipLabel)); fields.push('relationshipLabel'); }
      if ('dateOfBirth' in changes) { sets.push('date_of_birth = ?'); params.push(this.crypto.seal('household_members', 'date_of_birth', memberId, changes.dateOfBirth)); fields.push('dateOfBirth'); }
      await db.run(`UPDATE household_members SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND household_id = ?`, [...params, at, memberId, householdId]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: actorAdultId, action: 'household_member.updated', resourceType: 'household_member', resourceId: memberId, payload: { fields } });
    }, { locks: [householdLock(householdId)] });
    return this.getMember(householdId, memberId);
  }

  // Removes a member and what hangs off it. Refused (MEMBER_PROTECTED) for the owner or any member who has an account or a role.
  // Refused (MEMBER_HAS_RECORDS) while a case, evidence fact or parameter record still names the member: those are derived from
  // the member's consented data and are erased by closing the case or revoking its consent, never silently dropped here. Policy
  // links (policy_members) are erased with the member. Audit carries counts only.
  async deleteMember({ householdId, actorAdultId, memberId }) {
    const db = this.database;
    try {
      await db.transaction(async () => {
        const row = await db.one('SELECT * FROM household_members WHERE id = ? AND household_id = ?', [memberId, householdId]);
        if (!row) fail('MEMBER_NOT_FOUND', 'Member not found.', 404);
        const owner = await db.one(`SELECT 1 AS found FROM household_roles WHERE household_id = ? AND adult_user_id = ? AND role = 'owner'`, [householdId, row.adult_user_id]);
        if (row.adult_user_id && owner) fail('MEMBER_PROTECTED', 'The household owner cannot be removed.', 409);
        let placeholderAdultId = null;
        if (row.adult_user_id) {
          const adult = await db.one('SELECT account_status FROM adult_users WHERE id = ?', [row.adult_user_id]);
          if (adult?.account_status !== 'invited' || await this.#adultIsReferenced(row.adult_user_id, memberId)) {
            fail('MEMBER_PROTECTED', 'This member has an account or records in the household and cannot be removed here.', 409);
          }
          placeholderAdultId = row.adult_user_id;
        }
        const references = Number((await db.one(`SELECT
            (SELECT count(*) FROM service_cases WHERE subject_member_id = ?)
          + (SELECT count(*) FROM evidence_facts WHERE subject_member_id = ?)
          + (SELECT count(*) FROM coverage_parameter_records WHERE subject_id = ?) AS count`, [memberId, memberId, memberId])).count);
        if (references > 0) fail('MEMBER_HAS_RECORDS', 'Records still refer to this member. Close those cases or withdraw their permission first.', 409);
        const links = await db.many('DELETE FROM policy_members WHERE household_member_id = ? RETURNING policy_id', [memberId]);
        // The member's addresses and saved places go with the member (ADR 0015); they are erased, not a reason to refuse.
        const places = await db.run('DELETE FROM household_places WHERE member_id = ? AND household_id = ?', [memberId, householdId]);
        await db.run('DELETE FROM household_members WHERE id = ? AND household_id = ?', [memberId, householdId]);
        if (placeholderAdultId) await db.run('DELETE FROM adult_users WHERE id = ?', [placeholderAdultId]);
        await this.audit?.append({ householdId, actorType: 'adult_user', actorId: actorAdultId, action: 'household_member.removed', resourceType: 'household_member', resourceId: memberId, payload: { policyLinksErased: links.length, placeholderAdultErased: Boolean(placeholderAdultId), placesErased: places.changes } });
      }, { locks: [householdLock(householdId)] });
    } catch (error) {
      // Backstop: any foreign key we did not anticipate is a coded conflict, never a raw 500.
      if (error?.code === '23503') fail('MEMBER_PROTECTED', 'Other records still refer to this member and it cannot be removed here.', 409);
      throw error;
    }
  }

  // True when anything other than the member row being deleted points at the adult. The referencing columns are read from the
  // catalog, so a table added later is covered without editing this list (household_roles, auth_identities, api_sessions,
  // profile_answers and consent grants included).
  async #adultIsReferenced(adultId, memberId) {
    const refs = await this.database.many(`SELECT cl.relname AS table_name, att.attname AS column_name
      FROM pg_constraint con
      JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = cl.relnamespace AND ns.nspname = current_schema()
      JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
      WHERE con.contype = 'f' AND con.confrelid = 'adult_users'::regclass AND array_length(con.conkey, 1) = 1`);
    for (const ref of refs) {
      const quoted = name => `"${String(name).replaceAll('"', '""')}"`;
      const sameTable = ref.table_name === 'household_members';
      const found = await this.database.one(`SELECT 1 AS found FROM ${quoted(ref.table_name)} WHERE ${quoted(ref.column_name)} = ?${sameTable ? ' AND id <> ?' : ''} LIMIT 1`, sameTable ? [adultId, memberId] : [adultId]);
      if (found) return true;
    }
    return false;
  }

  async ownerMemberIds(householdId) {
    const rows = await this.database.many(`SELECT household_members.id FROM household_members
      JOIN household_roles ON household_roles.adult_user_id = household_members.adult_user_id AND household_roles.household_id = household_members.household_id
      WHERE household_members.household_id = ? AND household_roles.role = 'owner'`, [householdId]);
    return rows.map(row => row.id);
  }

  async listPolicies(householdId) {
    const policies = await this.database.many(`SELECT policies.*, insurers.legal_name AS insurer_name
      FROM policies LEFT JOIN insurers ON insurers.id = policies.insurer_id
      WHERE policies.household_id = ? ORDER BY policies.created_at, policies.id LIMIT ?`, [householdId, MAX_POLICIES]);
    // The end date is sealed, so the order by end date (nulls last) happens here, after opening.
    const opened = policies.map(row => this.#policy(row)).sort((a, b) => {
      if ((a.ends_on ?? null) === (b.ends_on ?? null)) return a.id < b.id ? -1 : 1;
      if (a.ends_on == null) return 1;
      if (b.ends_on == null) return -1;
      return a.ends_on < b.ends_on ? -1 : 1;
    });
    return this.#withMembers(opened);
  }

  async getPolicy(policyId) {
    const row = await this.database.one(`SELECT policies.*, insurers.legal_name AS insurer_name
      FROM policies LEFT JOIN insurers ON insurers.id = policies.insurer_id WHERE policies.id = ?`, [policyId]);
    return row ? (await this.#withMembers([this.#policy(row)]))[0] : null;
  }

  async #withMembers(policies) {
    if (policies.length === 0) return [];
    const links = await this.database.many(`SELECT policy_members.*, household_members.display_name, household_members.relationship_label, household_members.member_kind
      FROM policy_members JOIN household_members ON household_members.id = policy_members.household_member_id
      WHERE policy_members.policy_id = ANY(CAST(? AS text[])) ORDER BY household_members.created_at, household_members.id`, [policies.map(policy => policy.id)]);
    return policies.map(policy => ({
      ...policy,
      members: links.filter(link => link.policy_id === policy.id).map(link => ({
        memberId: link.household_member_id,
        displayName: this.#member({ id: link.household_member_id, display_name: link.display_name }).display_name,
        relationshipLabel: this.crypto.open('household_members', 'relationship_label', link.household_member_id, link.relationship_label),
        memberKind: link.member_kind,
        membershipState: link.membership_state,
      })),
    }));
  }

  // Service-level only (the demo seed). Policies enter through documents in the product; there is no create route.
  async findOrCreateInsurer({ legalName }) {
    const existing = await this.database.one('SELECT * FROM insurers WHERE legal_name = ?', [legalName]);
    if (existing) return existing;
    const insurerId = id('insurer');
    await this.database.run('INSERT INTO insurers (id, legal_name, created_at) VALUES (?, ?, ?)', [insurerId, legalName, this.clock().toISOString()]);
    return this.database.one('SELECT * FROM insurers WHERE id = ?', [insurerId]);
  }

  async createPolicy({ householdId, actorAdultId = null, insurerId, policyKind, policyNumberMasked = null, startsOn, endsOn, memberIds }) {
    const at = this.clock().toISOString();
    const db = this.database;
    const policyId = id('policy');
    await db.transaction(async () => {
      await db.run(`INSERT INTO policies (id, household_id, insurer_id, policy_kind, policy_number_masked, starts_on, ends_on, verification_state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'unverified', ?, ?)`, [policyId, householdId, insurerId, policyKind,
      this.crypto.seal('policies', 'policy_number_masked', policyId, policyNumberMasked), this.crypto.seal('policies', 'starts_on', policyId, startsOn),
      this.crypto.seal('policies', 'ends_on', policyId, endsOn), at, at]);
      for (const memberId of memberIds) {
        await db.run(`INSERT INTO policy_members (policy_id, household_member_id, membership_state, created_at) VALUES (?, ?, 'stated', ?)`, [policyId, memberId, at]);
      }
      await this.audit?.append({ householdId, actorType: actorAdultId ? 'adult_user' : 'system', actorId: actorAdultId || 'local-backend', action: 'policy.recorded', resourceType: 'policy', resourceId: policyId, payload: { policyKind, members: memberIds.length } });
    }, { locks: [householdLock(householdId)] });
    return this.getPolicy(policyId);
  }

  // Dev-only lookup for the demo seed. Contact e-mail is sealed with a random nonce, so it cannot be searched in SQL; this pages
  // through every adult (offset/limit, stable order) and compares after opening, so it never misses a match. Not a production path.
  async findAdultByContactEmail(email, { pageSize = 500 } = {}) {
    const wanted = String(email).trim().toLowerCase();
    for (let offset = 0; ; offset += pageSize) {
      const rows = await this.database.many('SELECT * FROM adult_users ORDER BY created_at, id LIMIT ? OFFSET ?', [pageSize, offset]);
      for (const row of rows) {
        const adult = this.#adult(row);
        if (String(adult.contact_email ?? '').toLowerCase() === wanted) return adult;
      }
      if (rows.length < pageSize) return null;
    }
  }

  async ownedHouseholdId(adultId) {
    const row = await this.database.one(`SELECT household_id FROM household_roles WHERE adult_user_id = ? AND role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1`, [adultId]);
    return row?.household_id ?? null;
  }
}
