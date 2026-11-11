import { createHash, randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { CAPTURE_METHODS, DECLARATION_KEY_SCHEMA, MEMBER_SCOPES, POLICY_FACT_REGISTRY_VERSION, SOURCE_TIERS, getPolicyFactKey, isTierStatus } from '../../contracts/policy-facts.js';
import { LIST_LIMIT, fail, invalid, requireGrant, requirePerson, str } from './holdings-common.js';

// Household memory facts and memory conflicts (migrations 049 and 050, ADR 0023, ADR 0032).
//
//   * One row = one value of one registry key from one tier. The value is sealed (AES-256-GCM, AAD
//     household_memory_facts.value_enc.<row id>); the row is append-only: a changed value supersedes the current row of its slot and
//     tier (the old row is stamped superseded_at, the new one names it in supersedes_id); an identical write is a no-op.
//   * Machine tiers hold machine statuses only (own_pdf: extracted_unverified | conflicting | unknown; ida_wording:
//     reviewed_reference | conflicting | unknown). Only a household adult writes the user tier (user_confirmed). The database CHECKs
//     repeat every pairing; this code refuses first with a coded error.
//   * Every read and write is scoped to a household the acting adult can see; a person is required for user-tier writes and for
//     reads. A system caller (a job: adultId null) may write machine tiers and open or close conflicts by rule; it never reads.
//   * Writes commit with a counts-only audit event under the household lock. The audit never carries a value or a declaration key.
//   * The reads here return OPENED values for internal consumers (the resolver, chat). A route must not forward a machine-tier value
//     without the response policy of ADR 0025 (sealed values are shown only after the owner reports them).

const FACTS = 'household_memory_facts';
const MACHINE_TIERS = new Set(['own_pdf', 'ida_wording']);
const RULE_RESOLUTIONS = new Set(['insurer_wins', 'own_wins', 'dismissed']);
const CONFLICT_REASONS = new Set(['own_vs_insurer', 'two_pages', 'model_disagree', 'own_vs_declaration']);
const PROVENANCE = Object.freeze(['sourceDocumentId', 'sourcePageId', 'policyFactId', 'parameterRecordId', 'proposedParameterId', 'policyClauseId']);
const MAX_VALUE_CHARS = 8192;
const notFound = () => fail('MEMORY_NOT_FOUND', 'Not found.', 404);

export const memoryKeyOf = factKey => {
  const entry = getPolicyFactKey(factKey);
  if (!entry) invalid('factKey is not in the registry.');
  return entry;
};

const canonical = value => JSON.stringify(value ?? null, (_, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
  ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))) : inner));
export const valueDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

export class MemoryFactRepository {
  constructor(database, { clock = () => new Date(), audit = null, households, ...options } = {}) {
    if (!database || !households) throw new TypeError('A database and households are required.');
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.households = households;
    this.crypto = resolveColumnCrypto(options);
  }

  #now() { return this.clock().toISOString(); }

  #fact(row) {
    return {
      id: row.id, householdId: row.household_id, holdingId: row.holding_id, policyId: row.policy_id, memberId: row.subject_member_id,
      memberScope: row.member_scope, factKey: row.fact_key, scopeKey: row.scope_key, factClass: row.fact_class, tier: row.source_tier, status: row.status,
      value: row.value_enc === null ? null : this.crypto.openJson(FACTS, 'value_enc', row.id, row.value_enc),
      sourceDocumentId: row.source_document_id, sourcePageId: row.source_page_id, blockIndex: row.block_index, policyFactId: row.policy_fact_id,
      captureMethod: row.capture_method, resolvesFactIds: row.resolves_fact_ids, supersedesId: row.supersedes_id, supersededAt: row.superseded_at, createdAt: row.created_at,
    };
  }

  #conflict(row) {
    return {
      id: row.id, householdId: row.household_id, holdingId: row.holding_id, factKey: row.fact_key, candidateFactIds: row.candidate_fact_ids, reason: row.reason,
      resolution: row.resolution, resolvingFactId: row.resolving_fact_id, resolvedBy: row.resolved_by, resolvedAt: row.resolved_at, createdAt: row.created_at,
    };
  }

  async #holding(db, householdId, holdingId) {
    const holding = await db.one('SELECT id FROM policy_holdings WHERE id = ? AND household_id = ?', [holdingId, householdId]);
    if (!holding) fail('HOLDING_NOT_FOUND', 'Holding not found.', 404);
  }

  /**
   * Writes one fact. `value` is any JSON of at most 8 KB, or null for status unknown. `provenance` names the sources (ids of this
   * household): own_pdf needs sourceDocumentId and sourcePageId, ida_wording needs sourceDocumentId and `referenceRef` (an object, sealed),
   * user_declaration needs `adultId` and `captureMethod`. Resolves { fact, written } where written is false for an identical replay.
   */
  async insertFact({
    householdId, adultId = null, holdingId = null, policyId = null, memberId = null, memberScope = 'policy', factKey, scopeKey = '', tier, status, value = null,
    consentGrantId, provenance = {}, blockIndex = null, referenceRef = null, captureMethod = null, resolvesFactIds = [], derivationVersion = null,
  }) {
    str(householdId, 'householdId');
    const entry = memoryKeyOf(factKey);
    if (!SOURCE_TIERS.includes(tier)) invalid('tier is invalid.');
    if (!isTierStatus(tier, status)) fail('MEMORY_STATUS_FORBIDDEN', 'That status is not allowed for that tier.', 400);
    if (!MEMBER_SCOPES.includes(memberScope)) invalid('memberScope is invalid.');
    if (!/^[a-z0-9_.:-]{0,64}$/.test(scopeKey)) invalid('scopeKey is invalid.');
    if (tier === 'ida_wording' && entry.factClass !== 'product_term') fail('MEMORY_KEY_NOT_DECLARABLE', 'Insurer wording only covers product terms.', 400);
    if (tier === 'user_declaration') {
      if (!adultId) fail('MEMORY_DECLARER_REQUIRED', 'A household adult must state this.', 403);
      if (!CAPTURE_METHODS.includes(captureMethod)) invalid('captureMethod is invalid.');
      if (entry.factClass === 'product_term' && captureMethod !== 'conflict_resolution') fail('MEMORY_KEY_NOT_DECLARABLE', 'A product term cannot be declared; it can only resolve a conflict.', 400);
    } else if (captureMethod !== null) invalid('captureMethod belongs to declarations.');
    if ((status === 'unknown') !== (value === null)) invalid('value must be null exactly when the status is unknown.');
    if (value !== null && canonical(value).length > MAX_VALUE_CHARS) invalid('value is too large.');
    if (!Array.isArray(resolvesFactIds) || resolvesFactIds.length > 10) invalid('resolvesFactIds is invalid.');
    const sources = Object.fromEntries(PROVENANCE.map(name => [name, provenance[name] ?? null]));
    if (tier === 'user_declaration' && ['sourcePageId', 'policyFactId', 'parameterRecordId', 'proposedParameterId', 'policyClauseId'].some(name => sources[name] !== null)) {
      invalid('A declaration carries no page or machine provenance.');
    }
    const db = this.database;
    const at = this.#now();
    return db.transaction(async () => {
      if (adultId) await requirePerson(this.households, householdId, adultId, { write: true });
      else if (tier === 'user_declaration') fail('MEMORY_DECLARER_REQUIRED', 'A household adult must state this.', 403);
      else await this.households.getHousehold?.(householdId);
      await requireGrant(db, {
        householdId, grantId: consentGrantId, now: at, purpose: tier === 'user_declaration' ? 'profile_intake' : 'coverage_reconstruction',
        subjectAdultId: tier === 'user_declaration' ? adultId : null,
      });
      if (holdingId) await this.#holding(db, householdId, holdingId);
      const slotSql = `household_id = ? AND COALESCE(holding_id, '') = ? AND COALESCE(policy_id, '') = ? AND COALESCE(subject_member_id, '') = ?
        AND fact_key = ? AND scope_key = ? AND source_tier = ? AND superseded_at IS NULL`;
      const slot = [householdId, holdingId ?? '', policyId ?? '', memberId ?? '', factKey, scopeKey, tier];
      const current = await db.one(`SELECT * FROM ${FACTS} WHERE ${slotSql} FOR UPDATE`, slot);
      if (current && current.status === status && canonical(current.value_enc === null ? null : this.crypto.openJson(FACTS, 'value_enc', current.id, current.value_enc)) === canonical(value)
        && (current.source_document_id ?? null) === sources.sourceDocumentId && (current.source_page_id ?? null) === sources.sourcePageId) {
        return { fact: this.#fact(current), written: false };
      }
      const factId = `mfact-${randomUUID()}`;
      if (current) await db.run(`UPDATE ${FACTS} SET superseded_at = ? WHERE id = ?`, [at, current.id]);
      try {
        await db.run(`INSERT INTO ${FACTS} (id, household_id, holding_id, policy_id, subject_member_id, member_scope, fact_key, scope_key, key_schema, fact_class,
            source_tier, status, value_enc, consent_grant_id, source_document_id, source_page_id, block_index, policy_fact_id, parameter_record_id,
            proposed_parameter_id, policy_clause_id, reference_ref_enc, declared_by_adult_id, capture_method, resolves_fact_ids, derivation_version, supersedes_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS text[]), ?, ?, ?)`, [
          factId, householdId, holdingId, policyId, memberId, memberScope, factKey, scopeKey,
          entry.factClass === 'household_declaration' && tier === 'user_declaration' ? DECLARATION_KEY_SCHEMA : POLICY_FACT_REGISTRY_VERSION, entry.factClass,
          tier, status, this.crypto.sealJson(FACTS, 'value_enc', factId, value), consentGrantId, sources.sourceDocumentId, sources.sourcePageId, blockIndex,
          sources.policyFactId, sources.parameterRecordId, sources.proposedParameterId, sources.policyClauseId,
          this.crypto.sealJson(FACTS, 'reference_ref_enc', factId, referenceRef), tier === 'user_declaration' ? adultId : null, captureMethod, resolvesFactIds,
          derivationVersion, current?.id ?? null, at]);
      } catch (error) {
        if (/memory fact (must|page|declarer)|a superseded memory fact/.test(String(error?.message))) notFound();
        throw error;
      }
      await this.audit?.append({
        householdId, actorType: adultId ? 'adult_user' : 'system', actorId: adultId ?? 'memory-fact-repository', action: 'memory.fact_written',
        resourceType: 'memory_fact', resourceId: factId, payload: { tier, status, factClass: entry.factClass, superseded: Boolean(current) },
      });
      return { fact: this.#fact(await db.one(`SELECT * FROM ${FACTS} WHERE id = ?`, [factId])), written: true };
    }, { locks: [householdLock(householdId)] });
  }

  /** The current (not superseded) facts of a household, optionally narrowed. Opened values: internal consumers only. */
  async listCurrent({ householdId, adultId, holdingId = null, factClass = null, factKeys = null, tier = null }) {
    await requirePerson(this.households, householdId, adultId);
    if (factKeys !== null && (!Array.isArray(factKeys) || factKeys.length > 50)) invalid('factKeys is invalid.');
    const rows = await this.database.many(`SELECT * FROM ${FACTS} WHERE household_id = ? AND superseded_at IS NULL
        AND (?::text IS NULL OR holding_id = ?) AND (?::text IS NULL OR fact_class = ?) AND (?::text[] IS NULL OR fact_key = ANY(?::text[]))
        AND (?::text IS NULL OR source_tier = ?) ORDER BY fact_key, scope_key, source_tier, id LIMIT ?`,
    [householdId, holdingId, holdingId, factClass, factClass, factKeys, factKeys, tier, tier, LIST_LIMIT + 1]);
    return { facts: rows.slice(0, LIST_LIMIT).map(row => this.#fact(row)), truncated: rows.length > LIST_LIMIT };
  }

  /** Opens a conflict among current facts of one key of one holding (a job). A second call for the same key returns the open one. */
  async openConflict({ householdId, holdingId, factKey, candidateFactIds, reason }) {
    str(householdId, 'householdId'); str(holdingId, 'holdingId'); memoryKeyOf(factKey);
    if (!CONFLICT_REASONS.has(reason)) invalid('reason is invalid.');
    if (!Array.isArray(candidateFactIds) || candidateFactIds.length < 2 || candidateFactIds.length > 10) invalid('candidateFactIds needs 2 to 10 ids.');
    const db = this.database;
    const at = this.#now();
    return db.transaction(async () => {
      await this.#holding(db, householdId, holdingId);
      const open = await db.one(`SELECT * FROM memory_conflicts WHERE household_id = ? AND holding_id = ? AND fact_key = ? AND resolution = 'pending'`, [householdId, holdingId, factKey]);
      if (open) return this.#conflict(open);
      const conflictId = `mconf-${randomUUID()}`;
      try {
        await db.run(`INSERT INTO memory_conflicts (id, household_id, holding_id, fact_key, candidate_fact_ids, reason, resolution, created_at)
          VALUES (?, ?, ?, ?, CAST(? AS text[]), ?, 'pending', ?)`, [conflictId, householdId, holdingId, factKey, candidateFactIds, reason, at]);
      } catch (error) {
        if (/memory conflict/.test(String(error?.message))) notFound();
        throw error;
      }
      await this.audit?.append({ householdId, actorType: 'system', actorId: 'memory-fact-repository', action: 'memory.conflict_opened', resourceType: 'memory_conflict', resourceId: conflictId, payload: { reason, candidates: candidateFactIds.length } });
      return this.#conflict(await db.one('SELECT * FROM memory_conflicts WHERE id = ?', [conflictId]));
    }, { locks: [householdLock(householdId)] });
  }

  async listConflicts({ householdId, adultId, holdingId = null, resolution = null }) {
    await requirePerson(this.households, householdId, adultId);
    const rows = await this.database.many(`SELECT * FROM memory_conflicts WHERE household_id = ? AND (?::text IS NULL OR holding_id = ?) AND (?::text IS NULL OR resolution = ?)
      ORDER BY created_at, id LIMIT ?`, [householdId, holdingId, holdingId, resolution, resolution, LIST_LIMIT]);
    return rows.map(row => this.#conflict(row));
  }

  /** Deterministic code closes a conflict by rule (insurer_wins, own_wins, dismissed). A rule never records a user choice. */
  async closeConflictByRule({ householdId, conflictId, resolution }) {
    if (!RULE_RESOLUTIONS.has(resolution)) invalid('resolution is invalid.');
    const db = this.database;
    return db.transaction(async () => {
      const row = await db.one(`SELECT * FROM memory_conflicts WHERE id = ? AND household_id = ? FOR UPDATE`, [str(conflictId, 'conflictId'), str(householdId, 'householdId')]);
      if (!row) notFound();
      if (row.resolution !== 'pending') return this.#conflict(row);
      await db.run(`UPDATE memory_conflicts SET resolution = ?, resolved_by = 'rule', resolved_at = ? WHERE id = ?`, [resolution, this.#now(), conflictId]);
      await this.audit?.append({ householdId, actorType: 'system', actorId: 'memory-fact-repository', action: 'memory.conflict_resolved', resourceType: 'memory_conflict', resourceId: conflictId, payload: { resolution, by: 'rule' } });
      return this.#conflict(await db.one('SELECT * FROM memory_conflicts WHERE id = ?', [conflictId]));
    }, { locks: [householdLock(householdId)] });
  }

  /**
   * A household adult resolves a conflict. The choice is stored as a NEW user_declaration fact (capture_method conflict_resolution,
   * resolves_fact_ids = the candidates); the machine rows stay. Any conflict may be resolved by the user (ADR 0032, FOR LEGAL REVIEW).
   * `value` is the value the person states. Resolves { conflict, fact }.
   */
  async resolveByUser({ householdId, adultId, conflictId, value, consentGrantId, dismiss = false }) {
    str(adultId, 'adultId');
    const db = this.database;
    const at = this.#now();
    return db.transaction(async () => {
      await requirePerson(this.households, householdId, adultId, { write: true });
      const row = await db.one(`SELECT * FROM memory_conflicts WHERE id = ? AND household_id = ? FOR UPDATE`, [str(conflictId, 'conflictId'), householdId]);
      if (!row) notFound();
      if (row.resolution !== 'pending') fail('MEMORY_CONFLICT_CLOSED', 'This was already resolved.', 409);
      if (dismiss) {
        await db.run(`UPDATE memory_conflicts SET resolution = 'dismissed', resolved_by = 'user', resolved_by_adult_id = ?, resolved_at = ? WHERE id = ?`, [adultId, at, conflictId]);
        return { conflict: this.#conflict(await db.one('SELECT * FROM memory_conflicts WHERE id = ?', [conflictId])), fact: null };
      }
      if (value === null || value === undefined) invalid('value is required.');
      const holding = await db.one('SELECT id FROM policy_holdings WHERE id = ? AND household_id = ?', [row.holding_id, householdId]);
      if (!holding) notFound();
      // The resolving fact is written by the same repository in the same transaction (nested calls join it).
      const { fact } = await this.insertFact({
        householdId, adultId, holdingId: row.holding_id, memberScope: 'policy', factKey: row.fact_key, tier: 'user_declaration', status: 'user_confirmed', value,
        consentGrantId, captureMethod: 'conflict_resolution', resolvesFactIds: row.candidate_fact_ids,
      });
      await db.run(`UPDATE memory_conflicts SET resolution = 'user_chose', resolving_fact_id = ?, resolved_by = 'user', resolved_by_adult_id = ?, resolved_at = ? WHERE id = ?`, [fact.id, adultId, at, conflictId]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: adultId, action: 'memory.conflict_resolved', resourceType: 'memory_conflict', resourceId: conflictId, payload: { resolution: 'user_chose', by: 'user' } });
      return { conflict: this.#conflict(await db.one('SELECT * FROM memory_conflicts WHERE id = ?', [conflictId])), fact };
    }, { locks: [householdLock(householdId)] });
  }
}
