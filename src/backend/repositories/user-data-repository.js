import { randomUUID } from 'node:crypto';
import { authIdentityLock, householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { LOCATION_TTL_MS } from '../../contracts/user-data.js';

// Everything the app collects from a person (spec docs/exec-plans/active/user-data-store-spec.md, ADR 0015): device
// permissions, places, Settings, onboarding, per-tool scenarios, and the repeat-safe beta access. Typed values (address,
// coordinates, label, preferences, onboarding choices, calculator inputs, phone) are sealed (ADR 0013) with AAD
// <table>.<column>.<row id> before they are written and opened only here. Plain columns are ids, foreign keys, closed enums,
// timestamps and revision counters. Ownership is checked inside each write's transaction, under the household advisory lock,
// and every write appends a counts-only audit event in that same transaction. Audit payloads never carry a typed value.

const id = prefix => `${prefix}-${randomUUID()}`;
const fail = (code, message, statusCode) => { throw Object.assign(new Error(message), { code, statusCode }); };
const conflict = () => fail('REVISION_CONFLICT', 'This was changed elsewhere. Reload and try again.', 409);
const notFound = () => fail('PLACE_NOT_FOUND', 'Place not found.', 404);

// Throws REVISION_CONFLICT when the caller sent If-Match and it is not the stored revision (0 means "no row yet").
function checkRevision(existing, ifMatch) {
  if (ifMatch === null || ifMatch === undefined) return;
  if ((existing?.revision ?? 0) !== ifMatch) conflict();
}

export class UserDataRepository {
  constructor(database, { clock = () => new Date(), audit, households, auth, ...options } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
    this.auth = auth;
    this.crypto = resolveColumnCrypto(options);
  }

  #now() { return this.clock().toISOString(); }

  async #actor(householdId, adultId, { write = false } = {}) {
    await this.households.requireAccess(householdId, adultId, { write });
  }

  #record(householdId, adultId, action, resourceType, resourceId, payload) {
    return this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action, resourceType, resourceId, payload });
  }

  // ---- Permissions ---------------------------------------------------------------------------------------------------------

  #permission(row) {
    return {
      permission: row.permission, state: row.state, surface: row.surface, wordingVersion: row.wording_version,
      decidedAt: row.decided_at, updatedAt: row.updated_at, revision: row.revision,
    };
  }

  async listPermissions({ householdId, adultId }) {
    const rows = await this.database.many('SELECT * FROM device_permissions WHERE household_id = ? AND adult_user_id = ? ORDER BY permission', [householdId, adultId]);
    return rows.map(row => this.#permission(row));
  }

  async setPermission({ householdId, adultId, permission, state, surface, wordingVersion, ifMatch }) {
    const db = this.database;
    const at = this.#now();
    return db.transaction(async () => {
      await this.#actor(householdId, adultId);
      const existing = await db.one('SELECT * FROM device_permissions WHERE adult_user_id = ? AND permission = ? FOR UPDATE', [adultId, permission]);
      if (existing && existing.household_id !== householdId) fail('USER_DATA_HOUSEHOLD_MISMATCH', 'This belongs to another household.', 409);
      checkRevision(existing, ifMatch);
      let rowId = existing?.id;
      if (existing) {
        await db.run('UPDATE device_permissions SET state = ?, surface = ?, wording_version = ?, decided_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
          [state, surface, wordingVersion, at, at, existing.id]);
      } else {
        rowId = id('perm');
        await db.run(`INSERT INTO device_permissions (id, household_id, adult_user_id, permission, state, surface, wording_version, decided_at, updated_at, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [rowId, householdId, adultId, permission, state, surface, wordingVersion, at, at]);
      }
      // Withdrawing location also withdraws what it produced, in the same transaction.
      let locationErased = 0;
      if (permission === 'location' && (state === 'denied' || state === 'revoked')) {
        locationErased = (await db.run(`DELETE FROM household_places WHERE adult_user_id = ? AND kind = 'current_location'`, [adultId])).changes;
      }
      await this.#record(householdId, adultId, 'permission.set', 'device_permission', rowId, { permission, state, currentLocationErased: locationErased });
      return this.#permission(await db.one('SELECT * FROM device_permissions WHERE id = ?', [rowId]));
    }, { locks: [householdLock(householdId)] });
  }

  // ---- Places --------------------------------------------------------------------------------------------------------------

  #place(row) {
    const payload = this.crypto.openJson('household_places', 'payload_ciphertext', row.id, row.payload_ciphertext);
    const dto = {
      id: row.id, kind: row.kind, memberId: row.member_id, slot: row.slot,
      label: this.crypto.open('household_places', 'label_ciphertext', row.id, row.label_ciphertext),
      precision: row.precision, source: row.source, capturedAt: row.captured_at, expiresAt: row.expires_at, revision: row.revision,
    };
    if (row.kind === 'current_location') dto.location = payload;
    else dto.address = payload;
    return dto;
  }

  // The member a place hangs off. Another real adult manages their own details (same rule as member edits).
  async #placeMember(householdId, adultId, memberId) {
    if (!memberId) return null;
    const member = await this.database.one('SELECT id, adult_user_id FROM household_members WHERE id = ? AND household_id = ?', [memberId, householdId]);
    if (!member) fail('MEMBER_NOT_FOUND', 'Member not found.', 404);
    if (member.adult_user_id && member.adult_user_id !== adultId) {
      const adult = await this.database.one('SELECT account_status FROM adult_users WHERE id = ?', [member.adult_user_id]);
      if (adult?.account_status !== 'invited') fail('MEMBER_PROTECTED', 'This adult manages their own details; they cannot be changed here.', 403);
    }
    return member;
  }

  /** The viewer's places: household and member addresses (not another adult's own), their own unexpired current location. */
  async listPlaces({ householdId, adultId }) {
    const rows = await this.database.many(`SELECT household_places.*, household_members.adult_user_id AS member_adult_id, adult_users.account_status AS member_adult_status
      FROM household_places
      LEFT JOIN household_members ON household_members.id = household_places.member_id
      LEFT JOIN adult_users ON adult_users.id = household_members.adult_user_id
      WHERE household_places.household_id = ?
        AND (household_places.kind <> 'current_location' OR (household_places.adult_user_id = ? AND household_places.expires_at > ?))
        AND (household_places.member_id IS NULL OR household_members.adult_user_id IS NULL
          OR household_members.adult_user_id = ? OR adult_users.account_status = 'invited')
      ORDER BY household_places.kind, household_places.captured_at, household_places.id LIMIT 100`, [householdId, adultId, this.#now(), adultId]);
    return rows.map(row => this.#place(row));
  }

  async setPlace({ householdId, adultId, memberId = null, place, ifMatch }) {
    const db = this.database;
    const at = this.#now();
    const { kind, slot, label, source, precision, payload } = place;
    return db.transaction(async () => {
      await this.#actor(householdId, adultId, { write: kind !== 'current_location' });
      if (kind === 'current_location') {
        const permission = await db.one(`SELECT state FROM device_permissions WHERE adult_user_id = ? AND permission = 'location'`, [adultId]);
        if (permission?.state !== 'granted') fail('LOCATION_PERMISSION_REQUIRED', 'Location permission has not been granted.', 403);
      } else {
        await this.#placeMember(householdId, adultId, memberId);
      }
      const existing = kind === 'current_location'
        ? await db.one(`SELECT * FROM household_places WHERE adult_user_id = ? AND kind = 'current_location' FOR UPDATE`, [adultId])
        : await db.one(`SELECT * FROM household_places WHERE household_id = ? AND kind = ? AND COALESCE(member_id, '') = ? AND slot IS NOT DISTINCT FROM ? FOR UPDATE`, [householdId, kind, memberId ?? '', slot]);
      checkRevision(existing, ifMatch);
      const rowId = existing?.id ?? id('place');
      const sealedPayload = this.crypto.sealJson('household_places', 'payload_ciphertext', rowId, payload);
      const sealedLabel = this.crypto.seal('household_places', 'label_ciphertext', rowId, label);
      const expiresAt = kind === 'current_location' ? new Date(Date.parse(at) + LOCATION_TTL_MS).toISOString() : null;
      if (existing) {
        if (existing.household_id !== householdId) fail('USER_DATA_HOUSEHOLD_MISMATCH', 'This belongs to another household.', 409);
        await db.run(`UPDATE household_places SET label_ciphertext = ?, payload_ciphertext = ?, precision = ?, source = ?, adult_user_id = ?,
          captured_at = ?, expires_at = ?, revision = revision + 1 WHERE id = ?`, [sealedLabel, sealedPayload, precision, source, adultId, at, expiresAt, rowId]);
      } else {
        await db.run(`INSERT INTO household_places (id, household_id, adult_user_id, member_id, kind, slot, label_ciphertext, payload_ciphertext, precision, source, captured_at, expires_at, revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`, [rowId, householdId, adultId, kind === 'current_location' ? null : memberId, kind, slot, sealedLabel, sealedPayload, precision, source, at, expiresAt]);
      }
      await this.#record(householdId, adultId, 'place.set', 'household_place', rowId, { kind, precision, memberScoped: Boolean(memberId) });
      return this.#place(await db.one('SELECT * FROM household_places WHERE id = ?', [rowId]));
    }, { locks: [householdLock(householdId)] });
  }

  async deletePlace({ householdId, adultId, memberId = null, kind, slot = null, ifMatch }) {
    const db = this.database;
    return db.transaction(async () => {
      await this.#actor(householdId, adultId, { write: kind !== 'current_location' });
      if (kind !== 'current_location') await this.#placeMember(householdId, adultId, memberId);
      const existing = kind === 'current_location'
        ? await db.one(`SELECT * FROM household_places WHERE adult_user_id = ? AND kind = 'current_location' AND household_id = ? FOR UPDATE`, [adultId, householdId])
        : await db.one(`SELECT * FROM household_places WHERE household_id = ? AND kind = ? AND COALESCE(member_id, '') = ? AND slot IS NOT DISTINCT FROM ? FOR UPDATE`, [householdId, kind, memberId ?? '', slot]);
      if (!existing) notFound();
      checkRevision(existing, ifMatch);
      await db.run('DELETE FROM household_places WHERE id = ?', [existing.id]);
      await this.#record(householdId, adultId, 'place.delete', 'household_place', existing.id, { kind, memberScoped: Boolean(memberId) });
    }, { locks: [householdLock(householdId)] });
  }

  /** Deletes every current location past its expiry. Counts-only audit per household. Returns the number removed. */
  async purgeExpiredLocations() {
    const db = this.database;
    return db.transaction(async () => {
      const rows = await db.many(`DELETE FROM household_places WHERE kind = 'current_location' AND expires_at <= ? RETURNING household_id`, [this.#now()]);
      const byHousehold = new Map();
      for (const row of rows) byHousehold.set(row.household_id, (byHousehold.get(row.household_id) ?? 0) + 1);
      for (const [householdId, count] of byHousehold) {
        await this.audit?.append({ householdId, actorType: 'system', actorId: 'user-data-repository', action: 'place.expired', resourceType: 'household', resourceId: householdId, payload: { kind: 'current_location', count } });
      }
      return rows.length;
    });
  }

  // ---- One sealed JSON document per adult (preferences, onboarding) and per adult and tool (scenarios) ----------------------

  // Insert or replace one sealed JSON document. `key` is the primary key column; a new scenario gets a random id, the per-adult
  // documents use the adult id (and AAD) as their key. `columns` are the extra plain columns written on insert, `updates` on replace.
  async #document({ table, column, key, where, params, householdId, adultId, value, ifMatch, columns = {}, updates = {}, action, resourceType, payload }) {
    const db = this.database;
    const at = this.#now();
    return db.transaction(async () => {
      await this.#actor(householdId, adultId);
      const existing = await db.one(`SELECT * FROM ${table} WHERE ${where} FOR UPDATE`, params);
      if (existing && existing.household_id !== householdId) fail('USER_DATA_HOUSEHOLD_MISMATCH', 'This belongs to another household.', 409);
      checkRevision(existing, ifMatch);
      const rowId = existing?.[key] ?? (key === 'id' ? id('scenario') : adultId);
      const sealed = this.crypto.sealJson(table, column, rowId, value);
      if (existing) {
        const names = [column, ...Object.keys(updates), 'updated_at'];
        await db.run(`UPDATE ${table} SET ${names.map(name => `${name} = ?`).join(', ')}, revision = revision + 1 WHERE ${key} = ?`, [sealed, ...Object.values(updates), at, rowId]);
      } else {
        const row = { [key]: rowId, household_id: householdId, [column]: sealed, ...columns, updated_at: at, revision: 1 };
        await db.run(`INSERT INTO ${table} (${Object.keys(row).join(', ')}) VALUES (${Object.keys(row).map(() => '?').join(', ')})`, Object.values(row));
      }
      await this.#record(householdId, adultId, action, resourceType, rowId, payload);
      return db.one(`SELECT * FROM ${table} WHERE ${key} = ?`, [rowId]);
    }, { locks: [householdLock(householdId)] });
  }

  async getPreferences({ householdId, adultId }) {
    const row = await this.database.one('SELECT * FROM adult_preferences WHERE adult_user_id = ? AND household_id = ?', [adultId, householdId]);
    if (!row) return { prefs: null, schemaVersion: 1, revision: 0, updatedAt: null };
    return { prefs: this.crypto.openJson('adult_preferences', 'prefs_ciphertext', row.adult_user_id, row.prefs_ciphertext), schemaVersion: row.schema_version, revision: row.revision, updatedAt: row.updated_at };
  }

  async setPreferences({ householdId, adultId, prefs, ifMatch }) {
    const row = await this.#document({
      table: 'adult_preferences', column: 'prefs_ciphertext', key: 'adult_user_id', where: 'adult_user_id = ?', params: [adultId],
      householdId, adultId, value: prefs, ifMatch, columns: { schema_version: 1 }, action: 'preferences.set', resourceType: 'adult_preferences',
      payload: { fields: Object.keys(prefs) },
    });
    return { prefs, schemaVersion: row.schema_version, revision: row.revision, updatedAt: row.updated_at };
  }

  async getOnboarding({ householdId, adultId }) {
    const row = await this.database.one('SELECT * FROM onboarding_progress WHERE adult_user_id = ? AND household_id = ?', [adultId, householdId]);
    if (!row) return { state: null, completedAt: null, revision: 0, updatedAt: null };
    return { state: this.crypto.openJson('onboarding_progress', 'state_ciphertext', row.adult_user_id, row.state_ciphertext), completedAt: row.completed_at, revision: row.revision, updatedAt: row.updated_at };
  }

  async setOnboarding({ householdId, adultId, state, completed, ifMatch }) {
    const completedAt = completed ? this.#now() : null;
    const row = await this.#document({
      table: 'onboarding_progress', column: 'state_ciphertext', key: 'adult_user_id', where: 'adult_user_id = ?', params: [adultId],
      householdId, adultId, value: state, ifMatch, columns: { completed_at: completedAt }, updates: { completed_at: completedAt },
      action: 'onboarding.set', resourceType: 'onboarding_progress', payload: { fields: Object.keys(state), completed },
    });
    return { state, completedAt: row.completed_at, revision: row.revision, updatedAt: row.updated_at };
  }

  #scenario(row) {
    return { tool: row.tool, inputs: this.crypto.openJson('tool_scenarios', 'inputs_ciphertext', row.id, row.inputs_ciphertext), schemaVersion: row.schema_version, revision: row.revision, updatedAt: row.updated_at };
  }

  async listScenarios({ householdId, adultId }) {
    const rows = await this.database.many('SELECT * FROM tool_scenarios WHERE adult_user_id = ? AND household_id = ? ORDER BY tool', [adultId, householdId]);
    return rows.map(row => this.#scenario(row));
  }

  async getScenario({ householdId, adultId, tool }) {
    const row = await this.database.one('SELECT * FROM tool_scenarios WHERE adult_user_id = ? AND household_id = ? AND tool = ?', [adultId, householdId, tool]);
    return row ? this.#scenario(row) : { tool, inputs: null, schemaVersion: 1, revision: 0, updatedAt: null };
  }

  async setScenario({ householdId, adultId, tool, inputs, ifMatch }) {
    const row = await this.#document({
      table: 'tool_scenarios', column: 'inputs_ciphertext', key: 'id', where: 'adult_user_id = ? AND tool = ?', params: [adultId, tool],
      householdId, adultId, value: inputs, ifMatch, columns: { adult_user_id: adultId, tool, schema_version: 1 },
      action: 'scenario.set', resourceType: 'tool_scenario', payload: { tool, fields: Object.keys(inputs) },
    });
    return this.#scenario(row);
  }

  // ---- Erasure -------------------------------------------------------------------------------------------------------------

  /** Deletes every row this repository owns for a household. Counts-only audit. Joins a caller's transaction (savepoint). */
  async eraseForHousehold({ householdId, reasonCode = 'household_erasure', actorId = 'user-data-repository', actorType = 'system' }) {
    const db = this.database;
    return db.transaction(async () => {
      const counts = {};
      for (const table of ['device_permissions', 'household_places', 'adult_preferences', 'onboarding_progress', 'tool_scenarios']) {
        counts[table] = (await db.run(`DELETE FROM ${table} WHERE household_id = ?`, [householdId])).changes;
      }
      await this.audit?.append({ householdId, actorType, actorId, action: 'user_data.erased', resourceType: 'household', resourceId: householdId, payload: { reasonCode, ...counts } });
      return Object.freeze(counts);
    }, { locks: [householdLock(householdId)] });
  }

  // ---- Access: sign-up that is safe to repeat --------------------------------------------------------------------------------

  /**
   * One transaction under an advisory lock on the e-mail's blind index, so two first calls for one e-mail make one adult. A known
   * e-mail gets a fresh session for its oldest owned household (audit access.reused); a new one gets an adult, household, owner
   * member and session (access.created). Resolves { returning, household, adult, ownerMember, session }.
   */
  async access({ displayName, contactEmail, contactPhone = null, householdName = null }) {
    const emailHash = this.crypto.blindIndex('adult_contact_email', contactEmail);
    const db = this.database;
    return db.transaction(async () => {
      const existing = await db.one('SELECT id, account_status FROM adult_users WHERE contact_email_hash = ?', [emailHash]);
      if (existing) {
        if (existing.account_status !== 'active') fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
        const home = await db.one(`SELECT household_id FROM household_roles WHERE adult_user_id = ? AND role = 'owner' AND status = 'active' ORDER BY created_at, id LIMIT 1`, [existing.id]);
        if (!home) fail('HOUSEHOLD_NOT_FOUND', 'Household not found.', 404);
        const member = await db.one('SELECT id FROM household_members WHERE household_id = ? AND adult_user_id = ?', [home.household_id, existing.id]);
        const household = await this.households.getHousehold(home.household_id);
        const session = await this.auth.issueSession({ adultUserId: existing.id });
        await this.#record(home.household_id, existing.id, 'access.reused', 'adult_user', existing.id, {});
        return { returning: true, household, adultId: existing.id, ownerMemberId: member?.id ?? null, session };
      }
      const adult = await this.households.createAdult({ displayName, contactEmail });
      await db.run('UPDATE adult_users SET contact_email_hash = ?, phone_ciphertext = ?, phone_hash = ? WHERE id = ?', [
        emailHash,
        contactPhone ? this.crypto.seal('adult_users', 'phone_ciphertext', adult.id, contactPhone) : null,
        contactPhone ? this.crypto.blindIndex('adult_contact_phone', contactPhone) : null,
        adult.id]);
      const household = await this.households.createHousehold({ displayName: householdName ?? `${displayName} household`, ownerAdultId: adult.id });
      const member = await this.households.addMember({ householdId: household.id, adultUserId: adult.id, displayName: adult.display_name });
      const session = await this.auth.issueSession({ adultUserId: adult.id });
      await this.#record(household.id, adult.id, 'access.created', 'adult_user', adult.id, { phoneStored: Boolean(contactPhone) });
      return { returning: false, household, adultId: adult.id, ownerMemberId: member.id, session };
    }, { locks: [authIdentityLock(`email:${emailHash}`)] });
  }

  /**
   * Computes contact_email_hash for adults that have a sealed e-mail but no hash (rows from before migration 029). An adult
   * whose e-mail another adult already holds is skipped and counted, never merged. Idempotent. Resolves counts only.
   */
  async backfillContactHashes({ pageSize = 200 } = {}) {
    const db = this.database;
    const counts = { hashed: 0, skippedDuplicate: 0, skippedNoEmail: 0 };
    let after = '';
    for (;;) {
      const rows = await db.many('SELECT id, contact_email FROM adult_users WHERE contact_email_hash IS NULL AND id > ? ORDER BY id LIMIT ?', [after, pageSize]);
      if (rows.length === 0) return counts;
      for (const row of rows) {
        after = row.id;
        const email = this.crypto.open('adult_users', 'contact_email', row.id, row.contact_email);
        if (!email) { counts.skippedNoEmail += 1; continue; }
        const hash = this.crypto.blindIndex('adult_contact_email', email.trim().toLowerCase());
        try {
          await db.transaction(async () => { await db.run('UPDATE adult_users SET contact_email_hash = ? WHERE id = ?', [hash, row.id]); });
          counts.hashed += 1;
        } catch (error) {
          if (error?.code !== '23505') throw error;
          counts.skippedDuplicate += 1;
        }
      }
    }
  }
}

