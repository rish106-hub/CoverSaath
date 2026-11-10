import { randomUUID } from 'node:crypto';
import { householdLock } from '../database/postgres/locks.js';
import { ERASED_NAME, ERASURE_REASONS, STORE_BY_TABLE } from '../../contracts/data-lifecycle.js';

// Erasure of a case, a household member or a whole household (S3), and the cleanup that follows the removal of document
// bytes. Table-by-table treatment: src/contracts/data-lifecycle.js and docs/architecture/data-lifecycle.md.
//
// How it works
//   1. Everything runs in ONE transaction under the household advisory lock (lock order: household, grant rows, runs,
//      tasks, the rest). Any failure rolls the whole erasure back; nothing is half erased.
//   2. Documents go through the existing document erasure path (derived data, observations, OCR, pages, blobs), runs
//      through eraseDerivedRunData, clauses and structuring through their own repositories. This class adds what those
//      paths do not reach: case-level stores, facts without a source page, graph, workflow side tables, idempotency
//      responses, telemetry, user-stated data and the identity rows.
//   3. Content is scrubbed first, then rows are pruned only when no other row refers to them (foreign keys are read from
//      the catalog, so a table added later is respected). Append-only tables are redacted through the narrow update their
//      triggers permit and never deleted. Rows that must stay (audit foreign keys, append-only references) are content-free.
//   4. A deletion-ledger row (retention_records) marks the case or household as erased. Reads treat a ledger-erased case
//      as not found.
//   5. Audit events carry codes and counts only. No name, text, value, filename or hash is ever written to audit.
//
// Document bytes in object storage are removed afterwards by the document worker (processDocument); pruneDeletedDocuments
// then deletes the tombstones. Both are idempotent and safe to repeat.

const MAX_PRUNE_PASSES = 16;
const MAX_CASES_PER_ERASURE = 5_000;
const IDENT = /^[a-z][a-z0-9_]*$/;
const quote = name => {
  if (!IDENT.test(name)) throw new Error('Unsafe SQL identifier.');
  return `"${name}"`;
};
const coded = (code, message, statusCode) => Object.assign(new Error(message), { code, statusCode });
// Reads at most MAX_CASES_PER_ERASURE cases. One more than the cap means the erasure would be partial, so it is refused with a
// coded error before anything is changed (never "succeed" on part of the data).
const assertWithinCaseCap = (rows, max) => {
  if (rows.length > max) throw coded('ERASURE_TOO_LARGE', 'Too many cases to erase in one request. Erase some cases first, then repeat.', 409);
  return rows;
};
const reasonCode = reason => {
  if (reason !== ERASURE_REASONS.dataSubjectRequest && reason !== ERASURE_REASONS.retentionExpired) {
    throw coded('ERASURE_REASON_INVALID', 'Erasure reason is not supported.', 400);
  }
  return reason;
};
const FACT_REDACTION = `epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
  institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL, effective_at = NULL,
  redacted_at = ?, redaction_reason_code = ?`;

export class ErasureRepository {
  constructor(database, {
    clock = () => new Date(), audit, consents, documents, profileAnswers, userData, appEvents, policyStructuring = null, clauses = null,
    maxCases = MAX_CASES_PER_ERASURE,
  } = {}) {
    this.maxCases = maxCases;
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.consents = consents;
    this.documents = documents;
    this.profileAnswers = profileAnswers;
    this.userData = userData;
    this.appEvents = appEvents;
    this.policyStructuring = policyStructuring;
    this.clauses = clauses;
    this.foreignKeys = new Map();
  }

  #assertConfigured() {
    if (!this.audit || !this.consents?.eraseDerivedRunData || !this.documents?.requestDeletion || !this.profileAnswers || !this.userData || !this.appEvents) {
      throw coded('ERASURE_NOT_CONFIGURED', 'Erasure is not configured.', 503);
    }
  }

  // ---- Public operations --------------------------------------------------------------------------------------------------

  /** Erases one case of one household. Resolves { counts, documentIds }; documentIds still need their bytes removed. */
  async eraseCase({ householdId, caseId, actor, reason = ERASURE_REASONS.dataSubjectRequest }) {
    this.#assertConfigured();
    reasonCode(reason);
    return this.database.transaction(async () => {
      const at = this.clock().toISOString();
      const ctx = this.#context({ householdId, actor, reason, at });
      const row = await this.database.one('SELECT * FROM service_cases WHERE id = ? AND household_id = ? FOR UPDATE', [caseId, householdId]);
      if (!row || await this.#erased('case', caseId)) throw coded('CASE_NOT_FOUND', 'Case not found.', 404);
      await this.#eraseCaseData(ctx, row);
      await this.#pruneCase(householdId, caseId);
      return this.#result(ctx);
    }, { locks: [householdLock(householdId)] });
  }

  /** Erases the structured records about one member, then the member. Account holders and owners are protected. */
  async eraseMember({ householdId, memberId, actor, reason = ERASURE_REASONS.dataSubjectRequest, mayEraseOthersCases = false }) {
    this.#assertConfigured();
    reasonCode(reason);
    return this.database.transaction(async () => {
      const db = this.database;
      const at = this.clock().toISOString();
      const ctx = this.#context({ householdId, actor, reason, at });
      const member = await db.one('SELECT * FROM household_members WHERE id = ? AND household_id = ? AND display_name <> ? FOR UPDATE', [memberId, householdId, ERASED_NAME]);
      if (!member) throw coded('MEMBER_NOT_FOUND', 'Member not found.', 404);
      let placeholderAdultId = null;
      if (member.adult_user_id) {
        const owner = await db.one(`SELECT 1 AS found FROM household_roles WHERE household_id = ? AND adult_user_id = ? AND role = 'owner'`, [householdId, member.adult_user_id]);
        const adult = await db.one('SELECT account_status FROM adult_users WHERE id = ?', [member.adult_user_id]);
        if (owner || adult?.account_status !== 'invited' || await this.#adultHasAccount(member.adult_user_id, memberId)) {
          throw coded('MEMBER_PROTECTED', 'This member has an account and is erased through the household, not here.', 409);
        }
        placeholderAdultId = member.adult_user_id;
      }
      // Cases about this member are erased whole (the case is the member's record).
      const cases = assertWithinCaseCap(await db.many(`SELECT * FROM service_cases WHERE household_id = ? AND subject_member_id = ? ORDER BY id LIMIT ?`, [householdId, memberId, this.maxCases + 1]), this.maxCases);
      // Same rule as erasing a case: without a manager role the caller may only erase cases they opened. Checked for every case
      // before anything is erased, inside the transaction, so a refusal leaves nothing changed.
      if (!mayEraseOthersCases && cases.some(row => row.opened_by_adult_id !== actor.id)) {
        throw coded('ERASURE_FORBIDDEN', 'A case about this member was opened by someone else. Ask the household owner to erase it.', 403);
      }
      for (const row of cases) {
        if (!(await this.#erased('case', row.id))) { await this.#eraseCaseData(ctx, row); await this.#pruneCase(householdId, row.id); }
      }
      ctx.counts.facts = (ctx.counts.facts ?? 0) + (await db.run(`UPDATE evidence_facts SET ${FACT_REDACTION}
        WHERE household_id = ? AND subject_member_id = ? AND redacted_at IS NULL`, [at, reason, householdId, memberId])).changes;
      await this.#eraseParameterRecords(ctx, 'household_id = ? AND subject_id = ?', [householdId, memberId]);
      await this.#count(ctx, 'factConflicts', `DELETE FROM fact_conflicts WHERE left_fact_id IN (SELECT id FROM evidence_facts WHERE household_id = ? AND subject_member_id = ?)
        OR right_fact_id IN (SELECT id FROM evidence_facts WHERE household_id = ? AND subject_member_id = ?)`, [householdId, memberId, householdId, memberId]);
      await this.#count(ctx, 'policyLinks', 'DELETE FROM policy_members WHERE household_member_id = ?', [memberId]);
      await this.#count(ctx, 'places', 'DELETE FROM household_places WHERE member_id = ? AND household_id = ?', [memberId, householdId]);
      await db.run('UPDATE household_members SET display_name = ?, relationship_label = NULL, date_of_birth = NULL, updated_at = ? WHERE id = ?', [ERASED_NAME, at, memberId]);
      if (placeholderAdultId) await this.#scrubAdults(ctx, [placeholderAdultId]);
      await this.#pruneIds('household_members', [memberId]);
      if (placeholderAdultId) await this.#pruneIds('adult_users', [placeholderAdultId]);
      await this.#auditEvent(ctx, { action: 'household_member.erased', resourceType: 'household_member', resourceId: memberId });
      return this.#result(ctx);
    }, { locks: [householdLock(householdId)] });
  }

  /** Erases a household and everything in it. The household row stays as a content-free tombstone (audit foreign key). */
  async eraseHousehold({ householdId, actor, reason = ERASURE_REASONS.dataSubjectRequest }) {
    this.#assertConfigured();
    reasonCode(reason);
    return this.database.transaction(async () => {
      const db = this.database;
      const at = this.clock().toISOString();
      const ctx = this.#context({ householdId, actor, reason, at });
      const household = await db.one('SELECT * FROM households WHERE id = ? FOR UPDATE', [householdId]);
      if (!household || await this.#erased('household', householdId)) throw coded('HOUSEHOLD_NOT_FOUND', 'Household not found.', 404);

      const adultIds = await this.#adultIds(householdId);
      // Adults who also belong to another household keep their account; everything of theirs in THIS household still goes.
      const soleAdultIds = [];
      for (const adultId of adultIds) if (!(await this.#belongsElsewhere(adultId, householdId))) soleAdultIds.push(adultId);

      // Read the cases first: a household over the cap is refused before any grant is revoked or anything else changes.
      const cases = assertWithinCaseCap(await db.many('SELECT * FROM service_cases WHERE household_id = ? ORDER BY id LIMIT ?', [householdId, this.maxCases + 1]), this.maxCases);

      // 1. Withdraw every permission. Each revocation erases what was derived under it (runs, observations, structuring,
      //    OCR text, activity payloads) and queues the grant's documents for deletion.
      const grants = await db.many('SELECT id, subject_adult_id FROM consent_grants WHERE household_id = ? AND revoked_at IS NULL ORDER BY id', [householdId]);
      for (const grant of grants) {
        await this.consents.revoke({ grantId: grant.id, revokedByAdultId: grant.subject_adult_id, reason: reasonCode(reason), auditActor: actor });
      }
      ctx.counts.grantsRevoked = grants.length;

      // 2. Every case.
      for (const row of cases) {
        if (!(await this.#erased('case', row.id))) await this.#eraseCaseData(ctx, row);
      }

      // 3. Documents that belong to no case, and any still not queued.
      const loose = await db.many(`SELECT id, lifecycle_state FROM document_uploads WHERE household_id = ? AND lifecycle_state NOT IN ('deleted', 'deletion_requested') ORDER BY id`, [householdId]);
      for (const document of loose) await this.documents.requestDeletion(document.id, { actorAdultId: actor.id, actorType: actor.type });
      ctx.counts.documents = (ctx.counts.documents ?? 0) + loose.length;
      for (const document of await db.many(`SELECT id FROM document_uploads WHERE household_id = ? AND lifecycle_state <> 'deleted'`, [householdId])) ctx.documentIds.add(document.id);

      // 4. Household-wide derived data not tied to a case.
      const documentIds = (await db.many('SELECT id FROM document_uploads WHERE household_id = ?', [householdId])).map(item => item.id);
      if (this.policyStructuring && documentIds.length > 0) {
        await this.policyStructuring.eraseDerived({ householdId, documentIds, reasonCode: reason, resourceType: 'household', resourceId: householdId, actorType: actor.type, actorId: actor.id, at });
      }
      if (this.clauses && documentIds.length > 0) {
        await this.clauses.eraseDerived({ householdId, documentIds, reasonCode: reason, resourceType: 'household', resourceId: householdId, actorType: actor.type, actorId: actor.id });
      }
      await this.#count(ctx, 'facts', `UPDATE evidence_facts SET ${FACT_REDACTION} WHERE household_id = ? AND redacted_at IS NULL`, [at, reason, householdId]);
      await this.#count(ctx, 'factConflicts', `DELETE FROM fact_conflicts WHERE left_fact_id IN (SELECT id FROM evidence_facts WHERE household_id = ?)`, [householdId]);
      await this.#eraseParameterRecords(ctx, 'household_id = ?', [householdId]);
      await this.#count(ctx, 'jobs', 'DELETE FROM job_queue WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'policyAnswers', 'DELETE FROM policy_answers WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'policyClauses', 'DELETE FROM policy_clauses WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'policyProfiles', 'DELETE FROM policy_profiles WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'catalogueReviews', 'DELETE FROM catalogue_reviews WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'catalogueReviewerGrants', 'DELETE FROM catalogue_reviewer_grants WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'policyLinks', 'DELETE FROM policy_members WHERE policy_id IN (SELECT id FROM policies WHERE household_id = ?)', [householdId]);
      await this.#count(ctx, 'policies', `UPDATE policies SET insurer_id = NULL, policy_kind = 'unknown', policy_number_masked = NULL, policy_version = NULL,
        starts_on = NULL, ends_on = NULL, verification_state = 'unverified', updated_at = ? WHERE household_id = ?
        AND (insurer_id IS NOT NULL OR policy_kind <> 'unknown' OR policy_number_masked IS NOT NULL OR policy_version IS NOT NULL
          OR starts_on IS NOT NULL OR ends_on IS NOT NULL OR verification_state <> 'unverified')`, [at, householdId]);
      await this.#count(ctx, 'revocationReasons', 'UPDATE consent_revocations SET reason = NULL WHERE reason IS NOT NULL AND consent_grant_id IN (SELECT id FROM consent_grants WHERE household_id = ?)', [householdId]);

      // 5. User-stated and telemetry data.
      const profile = await this.profileAnswers.eraseForHousehold({ householdId, reasonCode: 'household_erasure', actorType: actor.type, actorId: actor.id });
      ctx.counts.profileAnswers = profile.answers;
      const userData = await this.userData.eraseForHousehold({ householdId, reasonCode: 'household_erasure', actorType: actor.type, actorId: actor.id });
      ctx.counts.userData = Object.values(userData).reduce((sum, value) => sum + Number(value), 0);
      ctx.counts.appEvents = await this.appEvents.eraseForHousehold(householdId);
      for (const adultId of soleAdultIds) ctx.counts.appEvents += await this.appEvents.eraseForAdult(adultId);
      await this.#eraseIdempotency(ctx, { adultIds: soleAdultIds, householdId });

      // 6. Identity: sessions and sign-in identities of adults who belong to no other household, then roles and members.
      if (soleAdultIds.length > 0) {
        await this.#count(ctx, 'sessions', 'DELETE FROM api_sessions WHERE adult_user_id = ANY(CAST(? AS text[]))', [soleAdultIds]);
        await this.#count(ctx, 'identities', 'DELETE FROM auth_identities WHERE adult_user_id = ANY(CAST(? AS text[]))', [soleAdultIds]);
      }
      await this.#count(ctx, 'roles', 'DELETE FROM household_roles WHERE household_id = ?', [householdId]);
      await this.#count(ctx, 'members', 'UPDATE household_members SET display_name = ?, relationship_label = NULL, date_of_birth = NULL, updated_at = ? WHERE household_id = ?', [ERASED_NAME, at, householdId]);
      await this.#scrubAdults(ctx, soleAdultIds);

      // 7. The household tombstone, the ledger and the audit event.
      await db.run(`UPDATE households SET display_name = ?, status = 'closed', updated_at = ? WHERE id = ?`, [ERASED_NAME, at, householdId]);
      await this.#ledger(ctx, 'household', householdId);
      await this.#auditEvent(ctx, { action: 'household.erased', resourceType: 'household', resourceId: householdId });

      // 8. Rows nothing refers to any more.
      await this.#pruneHousehold(householdId, soleAdultIds);
      return this.#result(ctx);
    }, { locks: [householdLock(householdId)] });
  }

  /**
   * After the document worker removed the bytes: deletes the document tombstones and what hangs off them when no other row
   * refers to them. `householdId` null prunes every household (the retention sweep). Resolves { pruned } counts.
   */
  async pruneDeletedDocuments({ householdId = null, deletedBefore = null } = {}) {
    const db = this.database;
    // Optional age gate on the tombstone (retention): only documents deleted before this ISO time.
    const gate = deletedBefore ? ' AND deleted_at < CAST(? AS text)' : '';
    const gateParams = deletedBefore ? [deletedBefore] : [];
    const households = householdId
      ? [householdId]
      : (await db.many(`SELECT DISTINCT household_id FROM document_uploads WHERE lifecycle_state = 'deleted'${gate} ORDER BY household_id LIMIT 500`, gateParams)).map(row => row.household_id);
    let pruned = 0;
    for (const id of households) {
      const erasedHousehold = await this.#erased('household', id);
      // Default: only documents of an erased case or household. An ordinary document deletion keeps its tombstone until the
      // explicit retention rule (deletedBefore) says otherwise. Policies are pruned only for an erased case or household: in a
      // live household a scrubbed policy row is still the person's record that a policy exists.
      const caseClause = ` AND case_id IN (SELECT resource_id FROM retention_records WHERE resource_type = 'case' AND household_id = ? AND deletion_state IN ('deleted', 'verified'))`;
      const erasedOnly = erasedHousehold ? '' : caseClause;
      const erasedOnlyParams = erasedHousehold ? [] : [id];
      const documentLimit = deletedBefore || erasedHousehold ? '' : caseClause;
      const documentLimitParams = deletedBefore || erasedHousehold ? [] : [id];
      pruned += await db.transaction(async () => this.#pruneItems([
        ...(erasedHousehold ? this.#householdItems(id) : []),
        { table: 'source_pages', where: `document_upload_id IN (SELECT id FROM document_uploads WHERE household_id = ? AND lifecycle_state = 'deleted'${gate}${documentLimit})`, params: [id, ...gateParams, ...documentLimitParams] },
        { table: 'ocr_jobs', where: `document_upload_id IN (SELECT id FROM document_uploads WHERE household_id = ? AND lifecycle_state = 'deleted'${gate}${documentLimit})`, params: [id, ...gateParams, ...documentLimitParams] },
        { table: 'policies', where: `source_document_id IN (SELECT id FROM document_uploads WHERE household_id = ? AND lifecycle_state = 'deleted'${gate}${erasedOnly})`, params: [id, ...gateParams, ...erasedOnlyParams] },
        { table: 'document_uploads', where: `household_id = ? AND lifecycle_state = 'deleted'${gate}${documentLimit}`, params: [id, ...gateParams, ...documentLimitParams] },
      ]), { locks: [householdLock(id)] });
    }
    pruned += await this.pruneErasedAdults();
    return { pruned };
  }

  /** Deletes scrubbed adult tombstones that nothing refers to any more. Resolves the number deleted. */
  async pruneErasedAdults() {
    const ids = (await this.database.many(`SELECT id FROM adult_users WHERE account_status = 'closed' AND display_name = ? ORDER BY id LIMIT 1000`, [ERASED_NAME])).map(row => row.id);
    return this.#pruneIds('adult_users', ids);
  }

  // ---- One case -----------------------------------------------------------------------------------------------------------

  #context({ householdId, actor, reason, at }) {
    if (!actor || !['adult_user', 'system'].includes(actor.type) || typeof actor.id !== 'string' || actor.id === '') {
      throw coded('ERASURE_ACTOR_INVALID', 'An erasure needs an acting adult or system.', 500);
    }
    return { householdId, actor, reason, at, counts: {}, documentIds: new Set(), erasedCaseIds: [] };
  }

  #result(ctx) {
    return { counts: { ...ctx.counts }, documentIds: [...ctx.documentIds], erasedCaseIds: [...ctx.erasedCaseIds] };
  }

  async #count(ctx, key, sql, params) {
    const { changes } = await this.database.run(sql, params);
    ctx.counts[key] = (ctx.counts[key] ?? 0) + changes;
    return changes;
  }

  async #eraseCaseData(ctx, caseRow) {
    const db = this.database;
    const { householdId, actor, reason, at } = ctx;
    const caseId = caseRow.id;
    const before = { ...ctx.counts };

    const documents = await db.many('SELECT id, lifecycle_state FROM document_uploads WHERE case_id = ? AND household_id = ? ORDER BY id', [caseId, householdId]);
    for (const document of documents) {
      if (document.lifecycle_state !== 'deleted') ctx.documentIds.add(document.id);
      if (!['deleted', 'deletion_requested'].includes(document.lifecycle_state)) {
        await this.documents.requestDeletion(document.id, { actorAdultId: actor.id, actorType: actor.type });
      }
    }
    ctx.counts.documents = (ctx.counts.documents ?? 0) + documents.length;

    const runIds = (await db.many('SELECT id FROM workflow_runs WHERE case_id = ? ORDER BY id', [caseId])).map(row => row.id);
    if (runIds.length > 0) {
      const erased = await this.consents.eraseDerivedRunData({
        householdId, documentIds: documents.map(document => document.id), runIds, reason, resourceType: 'case', resourceId: caseId, caseId,
        actorType: actor.type, actorId: actor.id, at,
      });
      ctx.counts.runs = (ctx.counts.runs ?? 0) + erased.runs;
    }
    const taskIds = runIds.length === 0 ? [] : (await db.many('SELECT id FROM workflow_tasks WHERE workflow_run_id = ANY(CAST(? AS text[]))', [runIds])).map(row => row.id);

    await this.#count(ctx, 'facts', `UPDATE evidence_facts SET ${FACT_REDACTION} WHERE case_id = ? AND redacted_at IS NULL`, [at, reason, caseId]);
    await this.#count(ctx, 'factConflicts', `DELETE FROM fact_conflicts WHERE left_fact_id IN (SELECT id FROM evidence_facts WHERE case_id = ?)
      OR right_fact_id IN (SELECT id FROM evidence_facts WHERE case_id = ?)`, [caseId, caseId]);
    await this.#count(ctx, 'policyAnswers', 'DELETE FROM policy_answers WHERE case_id = ?', [caseId]);
    await this.#count(ctx, 'policyClauses', 'DELETE FROM policy_clauses WHERE case_id = ?', [caseId]);
    await this.#count(ctx, 'policyProfiles', 'DELETE FROM policy_profiles WHERE case_id = ?', [caseId]);
    await this.#count(ctx, 'catalogueReviews', 'DELETE FROM catalogue_reviews WHERE case_id = ?', [caseId]);
    await this.#count(ctx, 'catalogueReviewerGrants', 'DELETE FROM catalogue_reviewer_grants WHERE case_id = ?', [caseId]);
    await this.#eraseParameterRecords(ctx, 'case_id = ?', [caseId]);

    await this.#count(ctx, 'graphEdges', 'DELETE FROM coverage_graph_edges WHERE snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE case_id = ?)', [caseId]);
    await this.#count(ctx, 'graphNodes', 'DELETE FROM coverage_graph_nodes WHERE snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE case_id = ?)', [caseId]);
    await this.#count(ctx, 'graphs', `UPDATE coverage_graph_snapshots SET status = 'superseded', graph_json = '{}' WHERE case_id = ? AND (status <> 'superseded' OR graph_json <> '{}')`, [caseId]);

    await this.#count(ctx, 'outbox', 'DELETE FROM integration_outbox WHERE case_id = ?', [caseId]);
    await this.#count(ctx, 'humanApprovals', 'DELETE FROM human_approvals WHERE case_id = ?', [caseId]);
    await this.#count(ctx, 'humanReviews', 'DELETE FROM human_reviews WHERE case_id = ?', [caseId]);
    if (runIds.length > 0) {
      await this.#count(ctx, 'findings', 'DELETE FROM reviewer_findings WHERE workflow_run_id = ANY(CAST(? AS text[]))', [runIds]);
      await this.#count(ctx, 'gates', 'DELETE FROM release_gates WHERE workflow_run_id = ANY(CAST(? AS text[]))', [runIds]);
      await this.#count(ctx, 'events', 'DELETE FROM workflow_events WHERE workflow_run_id = ANY(CAST(? AS text[]))', [runIds]);
      await this.#count(ctx, 'taskDependencies', 'DELETE FROM workflow_task_dependencies WHERE workflow_task_id = ANY(CAST(? AS text[])) OR depends_on_task_id = ANY(CAST(? AS text[]))', [taskIds, taskIds]);
      await this.#count(ctx, 'tasks', `UPDATE workflow_tasks SET input_json = NULL, output_json = NULL, output_digest = NULL, last_error_message = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE workflow_run_id = ANY(CAST(? AS text[])) AND (input_json IS NOT NULL OR output_json IS NOT NULL OR output_digest IS NOT NULL OR last_error_message IS NOT NULL OR lease_owner IS NOT NULL)`, [runIds]);
      await this.#count(ctx, 'runInputs', `UPDATE workflow_runs SET input_json = NULL,
          status = CASE WHEN status IN ('queued', 'running', 'completed', 'blocked') THEN 'revoked' ELSE status END,
          finished_at = COALESCE(finished_at, CAST(? AS text)), terminal_reason = COALESCE(terminal_reason, 'DATA_ERASED')
        WHERE case_id = ?`, [at, caseId]);
    }
    await this.#count(ctx, 'caseParticipants', 'DELETE FROM case_participants WHERE case_id = ?', [caseId]);
    const profile = await this.profileAnswers.eraseForCase({ householdId, caseId, reasonCode: reason, actorType: actor.type, actorId: actor.id });
    ctx.counts.profileAnswers = (ctx.counts.profileAnswers ?? 0) + profile.answers;
    ctx.counts.appEvents = (ctx.counts.appEvents ?? 0) + await this.appEvents.eraseForCase(caseId);
    await this.#eraseIdempotency(ctx, { caseId, documentIds: documents.map(document => document.id), runIds, taskIds });

    await db.run(`UPDATE service_cases SET subject_member_id = NULL, trigger_type = 'user_requested_review', policy_type = 'other', status = 'closed', emergency_mode = 0,
        stated_estimate_minor = NULL, currency = NULL, updated_at = ?, closed_at = COALESCE(closed_at, CAST(? AS text)) WHERE id = ?`, [at, at, caseId]);
    await this.#ledger(ctx, 'case', caseId);
    ctx.erasedCaseIds.push(caseId);
    const delta = {};
    for (const [key, value] of Object.entries(ctx.counts)) if (value !== (before[key] ?? 0)) delta[key] = value - (before[key] ?? 0);
    await this.audit.append({
      householdId, caseId, actorType: actor.type, actorId: actor.id, action: 'case.erased', resourceType: 'case', resourceId: caseId,
      payload: { reasonCode: reason, ...delta },
    });
  }

  // Redacts the observations of the matching parameter records and deletes their resolutions and acquisitions (resolved values
  // are derived data). The records and observations stay: both are immutable or append-only.
  async #eraseParameterRecords(ctx, where, params) {
    const records = `(SELECT id FROM coverage_parameter_records WHERE ${where})`;
    await this.#count(ctx, 'observations', `UPDATE coverage_parameter_observations SET value_json = NULL, redacted_at = ?, redaction_reason_code = ?
      WHERE redacted_at IS NULL AND parameter_record_id IN ${records}`, [ctx.at, ctx.reason, ...params]);
    await this.#count(ctx, 'resolutions', `DELETE FROM coverage_parameter_resolutions WHERE parameter_record_id IN ${records}`, params);
    await this.#count(ctx, 'acquisitions', `DELETE FROM coverage_parameter_acquisitions WHERE parameter_record_id IN ${records}`, params);
  }

  // Idempotency responses can carry document names, job content and task inputs. They are keyed by client text, so they are
  // found by their scope columns (migration 040: household_id, case_id, set by every writer), never by guessing the key.
  // The response is sealed, so the scope columns are the only reliable path for rows written since 040.
  // LEGACY (remove one 24 h TTL after 040 is deployed everywhere): rows written before 040 have no scope columns, so the
  // plaintext-needle query (matches only pre-030 plaintext rows) and the document-upload scope patterns below stay for them.
  async #eraseIdempotency(ctx, { householdId, caseId = null, adultIds = [], documentIds = [], runIds = [], taskIds = [] }) {
    let changes = 0;
    if (householdId) changes += (await this.database.run('DELETE FROM idempotency_keys WHERE household_id = ?', [householdId])).changes;
    if (caseId) changes += (await this.database.run('DELETE FROM idempotency_keys WHERE case_id = ?', [caseId])).changes;
    const needles = [...new Set([householdId, caseId, ...documentIds, ...runIds, ...taskIds].filter(Boolean))];
    if (needles.length > 0) {
      changes += (await this.database.run(`DELETE FROM idempotency_keys WHERE response_json IS NOT NULL AND EXISTS (
          SELECT 1 FROM unnest(CAST(? AS text[])) AS needle(value) WHERE position(needle.value IN idempotency_keys.response_json) > 0)`, [needles])).changes;
    }
    if (caseId) changes += (await this.database.run(`DELETE FROM idempotency_keys WHERE scope LIKE 'document-upload:%:' || CAST(? AS text)`, [caseId])).changes;
    for (const adultId of adultIds) changes += (await this.database.run(`DELETE FROM idempotency_keys WHERE scope LIKE 'document-upload:' || CAST(? AS text) || ':%'`, [adultId])).changes;
    ctx.counts.idempotency = (ctx.counts.idempotency ?? 0) + changes;
  }

  // ---- Identity -----------------------------------------------------------------------------------------------------------

  async #adultIds(householdId) {
    const rows = await this.database.many(`SELECT adult_user_id AS id FROM household_roles WHERE household_id = ?
      UNION SELECT adult_user_id FROM household_members WHERE household_id = ? AND adult_user_id IS NOT NULL
      UNION SELECT subject_adult_id FROM consent_grants WHERE household_id = ? ORDER BY 1`, [householdId, householdId, householdId]);
    return rows.map(row => row.id);
  }

  async #belongsElsewhere(adultId, householdId) {
    return Boolean(await this.database.one(`SELECT 1 AS found FROM (
        SELECT household_id FROM household_roles WHERE adult_user_id = ? UNION ALL SELECT household_id FROM household_members WHERE adult_user_id = ?
      ) membership JOIN households ON households.id = membership.household_id WHERE membership.household_id <> ? AND households.status <> 'closed' LIMIT 1`, [adultId, adultId, householdId]));
  }

  // True when a row other than the member's own points at the adult (role, session, identity, grant, case, ...). The referencing
  // columns come from the catalog, so a table added later is covered without editing a list.
  async #adultHasAccount(adultId, memberId) {
    for (const ref of await this.#references('adult_users')) {
      const sameTable = ref.child === 'household_members';
      const found = await this.database.one(
        `SELECT 1 AS found FROM ${quote(ref.child)} WHERE ${quote(ref.childColumns[0])} = ?${sameTable ? ' AND id <> ?' : ''} LIMIT 1`,
        sameTable ? [adultId, memberId] : [adultId]);
      if (found) return true;
    }
    return false;
  }

  async #scrubAdults(ctx, adultIds) {
    if (adultIds.length === 0) return;
    await this.#count(ctx, 'adults', `UPDATE adult_users SET display_name = ?, contact_email = NULL, contact_phone = NULL, phone_ciphertext = NULL, phone_hash = NULL,
        contact_email_hash = NULL, locale = NULL, account_status = 'closed', updated_at = ? WHERE id = ANY(CAST(? AS text[]))`, [ERASED_NAME, ctx.at, adultIds]);
  }

  // ---- Ledger and audit ---------------------------------------------------------------------------------------------------

  async #erased(resourceType, resourceId) {
    return Boolean(await this.database.one(`SELECT 1 AS found FROM retention_records WHERE resource_type = ? AND resource_id = ? AND deletion_state IN ('deleted', 'verified')`, [resourceType, resourceId]));
  }

  async #ledger(ctx, resourceType, resourceId) {
    await this.database.run(`INSERT INTO retention_records
        (id, household_id, resource_type, resource_id, retention_basis, retain_until, deletion_state, requested_by_adult_id, requested_at, deleted_at, verified_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, 'deleted', NULL, ?, ?, NULL, ?, ?)
      ON CONFLICT (resource_type, resource_id) DO UPDATE SET deletion_state = 'deleted', deleted_at = excluded.deleted_at, retention_basis = excluded.retention_basis, updated_at = excluded.updated_at`,
    [`retention-${randomUUID()}`, ctx.householdId, resourceType, resourceId, ctx.reason, ctx.at, ctx.at, ctx.at, ctx.at]);
  }

  async #auditEvent(ctx, { action, resourceType, resourceId }) {
    await this.audit.append({
      householdId: ctx.householdId, actorType: ctx.actor.type, actorId: ctx.actor.id, action, resourceType, resourceId,
      payload: { reasonCode: ctx.reason, ...ctx.counts },
    });
  }

  // ---- Pruning ------------------------------------------------------------------------------------------------------------

  // Foreign keys that point at `table`, read from the catalog once: [{ child, childColumns, parentColumns }].
  async #references(table) {
    if (this.foreignKeys.has(table)) return this.foreignKeys.get(table);
    const rows = await this.database.many(`SELECT cl.relname::text AS child,
        ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS child_columns,
        ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord) JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum ORDER BY k.ord) AS parent_columns
      FROM pg_constraint con JOIN pg_class cl ON cl.oid = con.conrelid
      JOIN pg_class parent ON parent.oid = con.confrelid
      WHERE con.contype = 'f' AND parent.relname = ? AND parent.relnamespace = current_schema()::regnamespace`, [table]);
    const references = rows.map(row => ({ child: row.child, childColumns: row.child_columns, parentColumns: row.parent_columns }));
    this.foreignKeys.set(table, references);
    return references;
  }

  // DELETE ... WHERE <scope> AND NOT EXISTS (a row referring to it), repeated until a pass deletes nothing. Order between
  // tables therefore does not matter. A table with a delete-blocking trigger is never listed here (the registry test checks).
  async #pruneItems(items) {
    let total = 0;
    for (let pass = 0; pass < MAX_PRUNE_PASSES; pass += 1) {
      let changed = 0;
      for (const item of items) changed += await this.#pruneOne(item.table, item.where, item.params);
      total += changed;
      if (changed === 0) break;
    }
    return total;
  }

  async #pruneOne(table, where, params) {
    if (!STORE_BY_TABLE[table] || !['scrub_prune', 'delete'].includes(STORE_BY_TABLE[table].erasure)) throw new Error('Table is not prunable.');
    const refs = await this.#references(table);
    const checks = refs.map((ref, index) => {
      const join = ref.childColumns.map((column, position) => `c${index}.${quote(column)} = t.${quote(ref.parentColumns[position])}`).join(' AND ');
      return ` AND NOT EXISTS (SELECT 1 FROM ${quote(ref.child)} c${index} WHERE ${join})`;
    }).join('');
    return (await this.database.run(`DELETE FROM ${quote(table)} t WHERE (${where})${checks}`, params)).changes;
  }

  async #pruneIds(table, ids) {
    if (ids.length === 0) return 0;
    return this.#pruneItems([{ table, where: 'id = ANY(CAST(? AS text[]))', params: [ids] }]);
  }

  // Case and run level rows that nothing refers to any more. Documents wait for their bytes (pruneDeletedDocuments).
  async #pruneCase(householdId, caseId) {
    return this.#pruneItems([
      { table: 'workflow_tasks', where: 'workflow_run_id IN (SELECT id FROM workflow_runs WHERE case_id = ?)', params: [caseId] },
      { table: 'workflow_runs', where: 'case_id = ?', params: [caseId] },
      { table: 'coverage_graph_snapshots', where: 'case_id = ?', params: [caseId] },
      { table: 'coverage_parameter_records', where: 'case_id = ?', params: [caseId] },
    ]);
  }

  #householdItems(householdId) {
    return ['workflow_tasks', 'workflow_runs', 'coverage_graph_snapshots', 'coverage_parameter_records', 'policies', 'consent_scopes', 'consent_revocations', 'consent_grants', 'household_members']
      .map(table => ({ table, where: STORE_BY_TABLE[table].scope, params: [householdId] }));
  }

  async #pruneHousehold(householdId, adultIds) {
    // Documents, pages and OCR jobs are pruned once their bytes are gone (pruneDeletedDocuments).
    let total = await this.#pruneItems(this.#householdItems(householdId));
    total += await this.#pruneIds('adult_users', adultIds);
    return total;
  }
}
