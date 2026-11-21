import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { LIST_LIMIT, fail, invalid, requirePerson, str } from './holdings-common.js';
import { HOLDING_CREATE_FAILED, HOLDING_CREATE_JOB_KIND, HOLDING_JOB_KIND_LIST, HOLDING_STATUSES } from '../../contracts/holdings.js';
import { ERASED_NAME } from '../../contracts/data-lifecycle.js';

// Policy holdings (migration 048, ADR 0032): the thin link of a household's policy to its upload and policy profile. It stores no
// insurer, plan, UIN or number. Every read and write is scoped to a household the acting adult can see (a foreign household, or a
// holding of another household, is the same 404). A write and its counts-only audit event commit together under the household lock.
// Status moves forward along STATUS_FLOW only. Callers with no person behind them (jobs) pass adultId null: the household scope still
// applies, the role check does not.

export const HOLDING_KINDS = Object.freeze(['retail_health', 'group_health', 'top_up', 'critical_illness', 'other']);
const STATUS_FLOW = Object.freeze({
  uploaded: ['insurer_pending', 'product_reported', 'parsed'],
  insurer_pending: ['product_reported', 'parsed'],
  product_reported: ['parsed'],
  parsed: ['conflicts', 'ready'],
  conflicts: ['ready', 'parsed'],
  ready: ['conflicts', 'parsed'],
});
const notFound = () => fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);

export class PolicyHoldingRepository {
  constructor(database, { clock = () => new Date(), audit = null, households } = {}) {
    if (!database || !households) throw new TypeError('A database and households are required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
  }

  #dto(row) {
    return {
      id: row.id, householdId: row.household_id, policyId: row.policy_id, documentId: row.document_id, policyProfileId: row.policy_profile_id,
      kind: row.kind, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  async #access(householdId, adultId, write) {
    str(householdId, 'householdId');
    if (adultId !== null) await requirePerson(this.households, householdId, adultId, { write });
  }

  /**
   * Creates the holding of an upload, or returns the one that exists (one per document). With `unlessLinked` (the OCR pipeline), a document
   * that is already linked to another holding (its policy's holding, migration 065) gets no holding of its own: resolves null. The check runs
   * inside the same household-locked transaction as linkDocument, so link-then-create and create-then-link both end with one holding.
   */
  async create({ householdId, adultId, documentId, kind, policyId = null, policyProfileId = null, unlessLinked = false }) {
    str(documentId, 'documentId');
    if (!HOLDING_KINDS.includes(kind)) invalid('kind is invalid.');
    const db = this.database;
    const at = this.clock().toISOString();
    return db.transaction(async () => {
      await this.#access(householdId, adultId, true);
      const document = await db.one(`SELECT id FROM document_uploads WHERE id = ? AND household_id = ? AND lifecycle_state = 'active'`, [documentId, householdId]);
      if (!document) fail('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
      const existing = await db.one('SELECT * FROM policy_holdings WHERE household_id = ? AND document_id = ?', [householdId, documentId]);
      if (existing) return this.#dto(existing);
      if (unlessLinked && await db.one('SELECT 1 AS linked FROM holding_documents WHERE household_id = ? AND document_id = ? LIMIT 1', [householdId, documentId])) return null;
      const holdingId = `hold-${randomUUID()}`;
      try {
        await db.run(`INSERT INTO policy_holdings (id, household_id, policy_id, document_id, policy_profile_id, kind, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'uploaded', ?, ?)`, [holdingId, householdId, policyId, documentId, policyProfileId, kind, at, at]);
      } catch (error) {
        if (/policy holding must match/.test(String(error?.message))) notFound();
        throw error;
      }
      await this.audit?.append({
        householdId, actorType: adultId ? 'adult_user' : 'system', actorId: adultId ?? 'policy-holding-repository', action: 'holding.created',
        resourceType: 'policy_holding', resourceId: holdingId, payload: { kind },
      });
      return this.#dto(await db.one('SELECT * FROM policy_holdings WHERE id = ?', [holdingId]));
    }, { locks: [householdLock(householdId)] });
  }

  async get({ householdId, adultId, holdingId }) {
    await this.#access(householdId, adultId, false);
    const row = await this.database.one('SELECT * FROM policy_holdings WHERE id = ? AND household_id = ?', [str(holdingId, 'holdingId'), householdId]);
    if (!row) notFound();
    return this.#dto(row);
  }

  async list({ householdId, adultId, status = null }) {
    await this.#access(householdId, adultId, false);
    if (status !== null && !HOLDING_STATUSES.includes(status)) invalid('status is invalid.');
    const rows = await this.database.many(`SELECT * FROM policy_holdings WHERE household_id = ? AND (?::text IS NULL OR status = ?)
      ORDER BY created_at, id LIMIT ?`, [householdId, status, status, LIST_LIMIT]);
    return rows.map(row => this.#dto(row));
  }

  /**
   * Documents whose holding could not be created after OCR and still has none: `retrying` while the holding.create job is queued or running,
   * `failed` (code HOLDING_CREATE_FAILED) once its attempts are spent. Read from job_queue (no new store; erased with the document or grant).
   */
  async creationIssues({ householdId, adultId }) {
    await this.#access(householdId, adultId, false);
    const rows = await this.database.many(`SELECT job.document_id, job.status FROM job_queue job
      JOIN document_uploads doc ON doc.id = job.document_id AND doc.household_id = job.household_id AND doc.lifecycle_state = 'active'
      WHERE job.household_id = ? AND job.kind = ? AND job.status IN ('queued', 'running', 'dead') AND job.document_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM policy_holdings holding WHERE holding.household_id = job.household_id AND holding.document_id = job.document_id)
        AND NOT EXISTS (SELECT 1 FROM holding_documents link WHERE link.household_id = job.household_id AND link.document_id = job.document_id)
      ORDER BY job.created_at, job.id LIMIT ?`, [householdId, HOLDING_CREATE_JOB_KIND, LIST_LIMIT]);
    return rows.map(row => row.status === 'dead'
      ? { document_id: row.document_id, state: 'failed', code: HOLDING_CREATE_FAILED }
      : { document_id: row.document_id, state: 'retrying', code: null });
  }

  /**
   * Holdings (of the household) that a pipeline job gave up on: a dead holding.* job whose payload names the holding. Identifiers only, read
   * from job_queue (no new store). Used by the overview to say `failed` for a holding that never reached a settled status.
   */
  async failedHoldingIds({ householdId, adultId }) {
    await this.#access(householdId, adultId, false);
    const rows = await this.database.many(`SELECT payload_json FROM job_queue WHERE household_id = ? AND kind = ANY(CAST(? AS text[])) AND status = 'dead' ORDER BY created_at, id LIMIT ?`,
      [householdId, HOLDING_JOB_KIND_LIST, LIST_LIMIT]);
    const ids = new Set();
    for (const row of rows) {
      try { const id = JSON.parse(row.payload_json)?.holdingId; if (typeof id === 'string') ids.add(id); } catch { /* a malformed payload names no holding */ }
    }
    return ids;
  }

  /**
   * Members the holding's policy lists as covered (policy_members of the holding's policy), as a Map holding id -> member id[]. A holding with no
   * policy link, or no listed member, is absent from the map (unknown, never "everyone"). Erased members are left out.
   */
  async coveredMemberIds({ householdId, adultId, holdings }) {
    await this.#access(householdId, adultId, false);
    const policyIds = [...new Set(holdings.map(item => item.policyId).filter(Boolean))];
    const out = new Map();
    if (policyIds.length === 0) return out;
    const rows = await this.database.many(`SELECT link.policy_id, link.household_member_id FROM policy_members link
      JOIN policies policy ON policy.id = link.policy_id
      JOIN household_members member ON member.id = link.household_member_id AND member.household_id = policy.household_id
      WHERE policy.household_id = ? AND link.policy_id = ANY(CAST(? AS text[])) AND member.display_name <> ?
      ORDER BY member.created_at, member.id`, [householdId, policyIds, ERASED_NAME]);
    for (const item of holdings) {
      const ids = item.policyId ? rows.filter(row => row.policy_id === item.policyId).map(row => row.household_member_id) : [];
      if (ids.length > 0) out.set(item.id, ids);
    }
    return out;
  }

  /** Links the policy and the policy profile once they are known. */
  async link({ householdId, adultId, holdingId, policyId = undefined, policyProfileId = undefined }) {
    const db = this.database;
    return db.transaction(async () => {
      await this.#access(householdId, adultId, true);
      const row = await db.one('SELECT * FROM policy_holdings WHERE id = ? AND household_id = ? FOR UPDATE', [str(holdingId, 'holdingId'), householdId]);
      if (!row) notFound();
      try {
        await db.run('UPDATE policy_holdings SET policy_id = ?, policy_profile_id = ?, updated_at = ? WHERE id = ?',
          [policyId === undefined ? row.policy_id : policyId, policyProfileId === undefined ? row.policy_profile_id : policyProfileId, this.clock().toISOString(), holdingId]);
      } catch (error) {
        if (/policy holding must match/.test(String(error?.message))) notFound();
        throw error;
      }
      return this.#dto(await db.one('SELECT * FROM policy_holdings WHERE id = ?', [holdingId]));
    }, { locks: [householdLock(householdId)] });
  }

  /** Moves the status forward (STATUS_FLOW). Setting the current status again is a no-op. Throws HOLDING_STATUS_INVALID (409). */
  async setStatus({ householdId, adultId = null, holdingId, status }) {
    if (!HOLDING_STATUSES.includes(status)) invalid('status is invalid.');
    const db = this.database;
    return db.transaction(async () => {
      await this.#access(householdId, adultId, true);
      const row = await db.one('SELECT * FROM policy_holdings WHERE id = ? AND household_id = ? FOR UPDATE', [str(holdingId, 'holdingId'), householdId]);
      if (!row) notFound();
      if (row.status === status) return this.#dto(row);
      if (!STATUS_FLOW[row.status].includes(status)) fail('HOLDING_STATUS_INVALID', 'That status change is not allowed.', 409);
      await db.run('UPDATE policy_holdings SET status = ?, updated_at = ? WHERE id = ?', [status, this.clock().toISOString(), holdingId]);
      await this.audit?.append({
        householdId, actorType: adultId ? 'adult_user' : 'system', actorId: adultId ?? 'policy-holding-repository', action: 'holding.status_changed',
        resourceType: 'policy_holding', resourceId: holdingId, payload: { from: row.status, to: status },
      });
      return this.#dto(await db.one('SELECT * FROM policy_holdings WHERE id = ?', [holdingId]));
    }, { locks: [householdLock(householdId)] });
  }

  /** Removes a holding. Its facts, conflicts, payments and dues go with it (foreign key cascade). */
  async delete({ householdId, adultId, holdingId }) {
    const db = this.database;
    return db.transaction(async () => {
      await this.#access(householdId, adultId, true);
      const removed = await db.run('DELETE FROM policy_holdings WHERE id = ? AND household_id = ?', [str(holdingId, 'holdingId'), householdId]);
      if (removed.changes === 0) notFound();
      await this.audit?.append({ householdId, actorType: adultId ? 'adult_user' : 'system', actorId: adultId ?? 'policy-holding-repository', action: 'holding.deleted', resourceType: 'policy_holding', resourceId: holdingId, payload: {} });
    }, { locks: [householdLock(householdId)] });
  }
}
