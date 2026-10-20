import { createHash, randomUUID } from 'node:crypto';
import { AuditRepository } from './audit-repository.js';

// Reviewed facts and reviewer grants for the decision catalogue (ADR 0009 part 2, SQLite 017, PostgreSQL 013).
// Reviews are immutable; a later review of the same fact supersedes an earlier one when read. Erasure deletes them
// (ClauseRepository.eraseDerived and a document trigger). Audit payloads carry ids, decision and counts, never fact values.

export const REVIEW_DECISIONS = Object.freeze(['accepted', 'rejected', 'disputed']);
export const REVIEW_REASON_CODES = Object.freeze(['matches_clause', 'does_not_match_clause', 'clause_ambiguous', 'other_source_conflicts', 'wrong_policy_or_person']);

function coded(code, message, statusCode) { return Object.assign(new Error(message), { code, statusCode }); }
const invalid = message => coded('CATALOGUE_REVIEW_INVALID', message, 400);
const notAuthorised = () => coded('REVIEWER_NOT_AUTHORISED', 'The caller is not an active reviewer for this household.', 403);
const str = (value, name, max = 256) => {
  if (typeof value !== 'string' || !value || value.length > max) throw invalid(`${name} is invalid.`);
  return value;
};

export class CatalogueReviewRepository {
  constructor(database, { clock = () => new Date(), audit = null } = {}) {
    if (!database?.prepare) throw new TypeError('A database is required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit ?? new AuditRepository(database, { clock });
  }

  #atomic(work) {
    const savepoint = `catalogue_review_${randomUUID().replaceAll('-', '')}`;
    let nested;
    if (typeof this.database.isTransaction === 'boolean') {
      nested = this.database.isTransaction;
      if (!nested) this.database.exec('BEGIN IMMEDIATE');
    } else {
      try { this.database.exec('BEGIN IMMEDIATE'); nested = false; } catch (error) {
        if (!/within a transaction/i.test(String(error?.message))) throw error;
        nested = true;
      }
    }
    if (nested) this.database.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = work();
      this.database.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.database.exec(nested ? `ROLLBACK TO ${savepoint}` : 'ROLLBACK');
      if (nested) this.database.exec(`RELEASE ${savepoint}`);
      throw error;
    }
  }

  #grant(householdId, adultUserId, kind, grantedBy, actorType) {
    return this.#atomic(() => {
      const at = this.clock().toISOString();
      const existing = this.database.prepare('SELECT * FROM catalogue_reviewer_grants WHERE household_id = ? AND adult_user_id = ? AND kind = ?').get(householdId, adultUserId, kind);
      if (existing?.status === 'active') return existing;
      let id = existing?.id;
      if (existing) {
        this.database.prepare("UPDATE catalogue_reviewer_grants SET status = 'active', revoked_at = NULL, granted_by = ? WHERE id = ?").run(grantedBy, id);
      } else {
        id = `crg-${randomUUID()}`;
        this.database.prepare(`INSERT INTO catalogue_reviewer_grants (id, household_id, adult_user_id, kind, status, granted_by, created_at)
          VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(id, householdId, adultUserId, kind, grantedBy, at);
      }
      this.audit.append({ householdId, actorType, actorId: grantedBy, action: existing ? 'catalogue_reviewer.regranted' : 'catalogue_reviewer.granted', resourceType: 'catalogue_reviewer_grant', resourceId: id, payload: { kind } });
      return this.database.prepare('SELECT * FROM catalogue_reviewer_grants WHERE id = ?').get(id);
    });
  }

  /** The household owner designates a household adult. Self confirmation: its reviews never reach `proven`. */
  grantHouseholdConfirmer({ householdId, adultUserId, grantedByAdultId }) {
    str(householdId, 'householdId'); str(adultUserId, 'adultUserId'); str(grantedByAdultId, 'grantedByAdultId');
    const owner = this.database.prepare("SELECT 1 FROM household_roles WHERE household_id = ? AND adult_user_id = ? AND role = 'owner' AND status = 'active'").get(householdId, grantedByAdultId);
    if (!owner) throw notAuthorised();
    const target = this.database.prepare("SELECT 1 FROM household_roles WHERE household_id = ? AND adult_user_id = ? AND status = 'active'").get(householdId, adultUserId);
    if (!target) throw invalid('adultUserId holds no active role in this household.');
    return this.#grant(householdId, adultUserId, 'household_confirmer', grantedByAdultId, 'adult_user');
  }

  /** Operator tooling only: no route calls this. An independent reviewer is a person outside the household's own data. */
  grantIndependentReviewer({ householdId, adultUserId, operatorId }) {
    str(householdId, 'householdId'); str(adultUserId, 'adultUserId'); str(operatorId, 'operatorId', 128);
    // Independent means outside the household's own data: an adult with any role in this household is refused.
    if (this.database.prepare('SELECT 1 FROM household_roles WHERE household_id = ? AND adult_user_id = ?').get(householdId, adultUserId)) {
      throw invalid('A person with a role in this household cannot be its independent reviewer.');
    }
    return this.#grant(householdId, adultUserId, 'independent_reviewer', `operator:${operatorId}`.slice(0, 128), 'system');
  }

  revokeGrant({ householdId, grantId, revokedBy = 'operator' }) {
    const at = this.clock().toISOString();
    const done = this.database.prepare("UPDATE catalogue_reviewer_grants SET status = 'revoked', revoked_at = ? WHERE id = ? AND household_id = ? AND status = 'active'").run(at, grantId, householdId);
    if (Number(done.changes) > 0) this.audit.append({ householdId, actorType: 'system', actorId: String(revokedBy).slice(0, 128), action: 'catalogue_reviewer.revoked', resourceType: 'catalogue_reviewer_grant', resourceId: grantId });
    return Number(done.changes) > 0;
  }

  /** The strongest active grant wins. Authority comes from this row, never from the request. */
  activeGrant(householdId, adultUserId) {
    const rows = this.database.prepare("SELECT * FROM catalogue_reviewer_grants WHERE household_id = ? AND adult_user_id = ? AND status = 'active'").all(householdId, adultUserId);
    return rows.find(row => row.kind === 'independent_reviewer') ?? rows[0] ?? null;
  }

  /**
   * @param review { householdId, caseId, reviewerAdultId, idempotencyKey, decision, reasonCode, documentId, sourceVersion,
   *                 clauseIds, sourceDigests, factKey, fact }
   * @returns the stored review plus `replayed`.
   */
  record(review) {
    const householdId = str(review.householdId, 'householdId');
    const caseId = str(review.caseId, 'caseId');
    const key = str(review.idempotencyKey, 'idempotencyKey', 128);
    if (key.length < 8) throw invalid('idempotencyKey is invalid.');
    if (!REVIEW_DECISIONS.includes(review.decision)) throw invalid('decision is not supported.');
    if (!REVIEW_REASON_CODES.includes(review.reasonCode)) throw invalid('reasonCode is not supported.');
    const grant = this.activeGrant(householdId, str(review.reviewerAdultId, 'reviewerAdultId'));
    if (!grant) throw notAuthorised();
    const authority = grant.kind === 'independent_reviewer' ? 'independent' : 'household';
    const factJson = JSON.stringify(review.fact ?? null);
    if (factJson.length > 16000) throw invalid('The reviewed fact is too large to store.');
    const requestDigest = createHash('sha256').update(JSON.stringify([review.factKey, review.decision, review.reasonCode, review.sourceVersion, review.clauseIds, factJson, authority])).digest('hex');
    return this.#atomic(() => {
    const prior = this.database.prepare('SELECT * FROM catalogue_reviews WHERE household_id = ? AND case_id = ? AND idempotency_key = ?').get(householdId, caseId, key);
    if (prior) {
      if (prior.request_digest !== requestDigest || prior.reviewer_adult_id !== review.reviewerAdultId) throw coded('IDEMPOTENCY_CONFLICT', 'The idempotency key was used for a different review.', 409);
      return { ...this.#dto(prior), replayed: true };
    }
    const id = `crv-${randomUUID()}`;
    const at = this.clock().toISOString();
    this.database.prepare(`INSERT INTO catalogue_reviews
      (id, household_id, case_id, grant_id, reviewer_adult_id, authority, decision, reason_code, idempotency_key, request_digest,
       document_id, source_version, clause_ids_json, source_digests_json, fact_key, fact_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, householdId, caseId, grant.id, review.reviewerAdultId, authority, review.decision, review.reasonCode, key, requestDigest,
        str(review.documentId, 'documentId'), str(review.sourceVersion, 'sourceVersion', 128), JSON.stringify(review.clauseIds ?? []),
        JSON.stringify(review.sourceDigests ?? []), str(review.factKey, 'factKey', 64), factJson, at);
    this.audit.append({
      householdId, caseId, actorType: authority === 'independent' ? 'human_reviewer' : 'adult_user', actorId: review.reviewerAdultId, action: 'catalogue_review.recorded',
      resourceType: 'catalogue_review', resourceId: id, payload: { decision: review.decision, reasonCode: review.reasonCode, authority },
    });
    return { ...this.#dto(this.database.prepare('SELECT * FROM catalogue_reviews WHERE id = ?').get(id)), replayed: false };
    });
  }

  #dto(row) {
    return {
      reviewId: row.id, householdId: row.household_id, caseId: row.case_id, reviewerAdultId: row.reviewer_adult_id, authority: row.authority,
      decision: row.decision, reasonCode: row.reason_code, documentId: row.document_id, sourceVersion: row.source_version,
      clauseIds: JSON.parse(row.clause_ids_json), sourceDigests: JSON.parse(row.source_digests_json), factKey: row.fact_key,
      fact: JSON.parse(row.fact_json), createdAt: row.created_at,
    };
  }

  /**
   * Per fact key one review is current: the strongest authority among reviews whose grant is still active, then the
   * latest. A household confirmation never supersedes an independent review. Reviews whose grant was revoked are
   * returned with `reviewerActive: false` and count for nothing.
   */
  list({ householdId, caseId }) {
    const rows = this.database.prepare(`SELECT review.*, reviewer_grant.status AS grant_status FROM catalogue_reviews review
      JOIN catalogue_reviewer_grants reviewer_grant ON reviewer_grant.id = review.grant_id
      WHERE review.household_id = ? AND review.case_id = ? ORDER BY review.created_at, review.rowid`).all(str(householdId, 'householdId'), str(caseId, 'caseId'));
    const rank = row => (row.authority === 'independent' ? 2 : 1);
    const winner = new Map();
    for (const row of rows) {
      if (row.grant_status !== 'active') continue;
      const held = winner.get(row.fact_key);
      if (!held || rank(row) >= rank(held)) winner.set(row.fact_key, row);
    }
    return rows.map(row => ({ ...this.#dto(row), reviewerActive: row.grant_status === 'active', superseded: row.grant_status === 'active' && winner.get(row.fact_key)?.id !== row.id }));
  }
}
