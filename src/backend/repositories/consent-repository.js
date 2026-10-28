import { randomUUID } from 'node:crypto';
import { PolicyStructuringRepository } from './policy-structuring-repository.js';
import { ClauseRepository } from './clause-repository.js';
import { householdLock } from '../database/postgres/locks.js';
import { GEMINI_MODEL_RECIPIENT } from '../../features/ai-analysis/privacy-evidence-gate.js';

const id = prefix => `${prefix}-${randomUUID()}`;

const ERASURE_MARKER = 'consent_revoked';
const GEMINI_RECIPIENT = GEMINI_MODEL_RECIPIENT;
// Erasure reasons recorded on observations, evidence facts and persisted source-page excerpts.
// Anything else is recorded as consent_revoked so an arbitrary caller value cannot become stored state.
const OBSERVATION_ERASURE_REASONS = new Set(['consent_revoked', 'document_erasure', 'source_consent_not_current']);
const RUN_SCAN_BATCH_SIZE = 100;
const MAX_ERASURE_RUNS = 5_000;
const EMPTY_TEXT_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// Derived-store repositories are optional at construction so read-only uses never fail; when one
// cannot be built, the erasure paths that need it throw ERASURE_NOT_CONFIGURED (fail closed).
function optionalRepository(build) {
  try {
    return build();
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

const notConfigured = message => Object.assign(new Error(message), { code: 'ERASURE_NOT_CONFIGURED', statusCode: 503 });

// Transactions on the async PostgreSQL interface (S3.2). Lock order, design section 3:
// household advisory lock -> consent_grants FOR UPDATE -> workflow_runs FOR UPDATE by id ->
// workflow_tasks -> the rest. Every DB-touching method is async; a rejected query (including a
// dropped connection) rejects the method, so every consent check fails closed.
export class ConsentRepository {
  constructor(database, { clock = () => new Date(), audit, coverageParameters = null, policyStructuring = null, clauses = null } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.coverageParameters = coverageParameters;
    // Structuring proposals and runs are derived data: erasure always has a path, so a missing
    // injection never leaves proposals behind (the repository needs only the database to erase).
    this.policyStructuring = policyStructuring
      ?? (database ? optionalRepository(() => new PolicyStructuringRepository(database, { clock, ...(audit ? { audit } : {}), ...(coverageParameters ? { coverageParameters } : {}) })) : null);
    // Clauses and answers are derived stores too (ADR 0008): the same rule, erasure always has a path.
    this.clauses = clauses ?? (database ? optionalRepository(() => new ClauseRepository(database, { clock, ...(audit ? { audit } : {}) })) : null);
  }

  async grant({ id: grantId = id('consent'), householdId, subjectAdultId, grantedToActor = 'knowvia-local', purpose, noticeVersion = 'v1', evidenceMethod = 'typed', expiresAt = null, scopes = [] }) {
    if (!scopes.length) throw new Error('At least one consent scope is required.');
    const db = this.database;
    const at = this.clock().toISOString();
    await db.transaction(async () => {
      // A scope may name only a document of the grant's own household; otherwise revoking the grant would
      // erase under the wrong household. Missing and foreign documents are indistinguishable.
      for (const scope of scopes) {
        if (scope.resourceType !== 'document' || scope.resourceId == null) continue;
        const document = await db.one('SELECT household_id FROM document_uploads WHERE id = ?', [scope.resourceId]);
        if (document?.household_id !== householdId) {
          throw Object.assign(new Error('Document was not found.'), { code: 'DOCUMENT_NOT_FOUND', statusCode: 404 });
        }
      }
      await db.run(`INSERT INTO consent_grants
        (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [grantId, householdId, subjectAdultId, grantedToActor, purpose, noticeVersion, evidenceMethod, at, expiresAt, at]);
      for (const scope of scopes) {
        await db.run(`INSERT INTO consent_scopes
          (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id('scope'), grantId, scope.resourceType, scope.resourceId ?? null, scope.action, scope.dataCategory, scope.recipient ?? null, at]);
      }
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: subjectAdultId, action: 'consent.granted', resourceType: 'consent_grant', resourceId: grantId, payload: { purpose, scopeCount: scopes.length, expiresAt } });
    }, { locks: [householdLock(householdId)] });
    return this.get(grantId);
  }

  async get(grantId) {
    const grant = await this.database.one('SELECT * FROM consent_grants WHERE id = ?', [grantId]);
    if (!grant) return null;
    return { ...grant, scopes: await this.database.many('SELECT * FROM consent_scopes WHERE consent_grant_id = ? ORDER BY created_at, id', [grantId]) };
  }

  async requireActive(grantId, { subjectAdultId, purpose, resourceType, resourceId = null, action, dataCategory, recipient = null, at = this.clock().toISOString() } = {}) {
    // Expiry uses the same julianday comparison as source selection: timestamps
    // in different ISO forms compare by instant, and an unparseable expiry or
    // check time (julianday NULL) counts as expired (fail closed).
    const grant = await this.database.one(`SELECT * FROM consent_grants
      WHERE id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))`, [grantId, at]);
    if (!grant || (subjectAdultId && grant.subject_adult_id !== subjectAdultId) || (purpose && grant.purpose !== purpose)) {
      const error = new Error('Active subject-scoped consent is required.'); error.code = 'CONSENT_REQUIRED'; throw error;
    }
    if (resourceType || action || dataCategory || recipient) {
      const scopes = await this.database.many('SELECT * FROM consent_scopes WHERE consent_grant_id = ?', [grantId]);
      const matches = scopes.some(scope =>
        (!resourceType || scope.resource_type === resourceType) &&
        (!action || scope.action === action) &&
        (!dataCategory || scope.data_category === dataCategory) &&
        (!resourceId || scope.resource_id === null || scope.resource_id === resourceId) &&
        // When a recipient is requested it must be named exactly. A NULL
        // recipient scope never authorises disclosure to a specific recipient.
        (!recipient || scope.recipient === recipient));
      if (!matches) { const error = new Error('Consent does not cover this resource and action.'); error.code = 'CONSENT_SCOPE_REQUIRED'; throw error; }
    }
    return grant;
  }

  // Resolves true only on a matching row. A failed query rejects (never resolves true).
  async canAccessField({ householdId, subjectAdultId, viewerAdultId, fieldKey, action = 'read', at = this.clock().toISOString() }) {
    if (subjectAdultId === viewerAdultId) return true;
    const row = await this.database.one(`SELECT 1 AS allowed
      FROM consent_grants grant_record
      JOIN consent_scopes scope ON scope.consent_grant_id = grant_record.id
      JOIN household_roles viewer_role
        ON viewer_role.household_id = grant_record.household_id
       AND viewer_role.adult_user_id = ?
       AND viewer_role.status = 'active'
      WHERE grant_record.household_id = ?
        AND grant_record.subject_adult_id = ?
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR julianday(grant_record.expires_at) > julianday(?))
        AND scope.resource_type = 'profile_field'
        AND scope.resource_id = ?
        AND scope.action = ?
        AND scope.recipient = ?
      LIMIT 1`, [viewerAdultId, householdId, subjectAdultId, at, fieldKey, action, viewerAdultId]);
    return row !== null && row !== undefined;
  }

  async canAccessResource({
    householdId, subjectAdultId, viewerAdultId, purpose, resourceType, resourceId,
    action = 'read', dataCategory, at = this.clock().toISOString(),
  }) {
    if (!householdId || !subjectAdultId || !viewerAdultId || !purpose || !resourceType || !resourceId || !dataCategory) return false;
    const row = await this.database.one(`SELECT 1 AS allowed
      FROM consent_grants grant_record
      JOIN consent_scopes scope ON scope.consent_grant_id = grant_record.id
      JOIN household_roles viewer_role
        ON viewer_role.household_id = grant_record.household_id
       AND viewer_role.adult_user_id = ?
       AND viewer_role.status = 'active'
      WHERE grant_record.household_id = ?
        AND grant_record.subject_adult_id = ?
        AND grant_record.purpose = ?
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR julianday(grant_record.expires_at) > julianday(?))
        AND scope.resource_type = ?
        AND scope.resource_id = ?
        AND scope.action = ?
        AND scope.data_category = ?
        AND scope.recipient = ?
      LIMIT 1`, [
      viewerAdultId, householdId, subjectAdultId, purpose, at,
      resourceType, resourceId, action, dataCategory, viewerAdultId,
    ]);
    return row !== null && row !== undefined;
  }

  async requireResourceAccess(input) {
    if ((await this.canAccessResource(input)) !== true) {
      const error = new Error('The subject has not granted this viewer access for the requested purpose and field.');
      error.code = 'FIELD_ACCESS_REQUIRED';
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  async requireFieldAccess(input) {
    if ((await this.canAccessField(input)) !== true) {
      const error = new Error('The subject has not granted access to this field for this viewer.');
      error.code = 'FIELD_ACCESS_REQUIRED';
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  /**
   * Revokes a grant and erases everything derived under it, in one transaction. Lock order:
   * household advisory lock, the grant row FOR UPDATE, then the affected runs by id (inside
   * eraseDerivedRunData) before any task row. A grant already revoked (including by a concurrent
   * revoke that committed first) is returned unchanged: a second revoke writes nothing.
   */
  async revoke({ id: revocationId = id('revocation'), grantId, revokedByAdultId, reason = null, downstreamDeletionDueAt = null }) {
    const db = this.database;
    const existing = await db.one('SELECT household_id, subject_adult_id, revoked_at FROM consent_grants WHERE id = ?', [grantId]);
    if (!existing) throw new Error('Consent grant not found.');
    if (existing.subject_adult_id !== revokedByAdultId) throw new Error('Only the subject adult may revoke this consent.');
    if (existing.revoked_at) return this.get(grantId);
    const at = this.clock().toISOString();
    await db.transaction(async () => {
      const grant = await db.one('SELECT * FROM consent_grants WHERE id = ? FOR UPDATE', [grantId]);
      if (!grant) throw new Error('Consent grant not found.');
      // Re-checked under the row lock: a concurrent revoke may have committed meanwhile.
      if (grant.revoked_at) return;
      if (grant.household_id !== existing.household_id) throw new Error('Consent grant household changed.');
      // Runs authorised by this grant are locked by id before any task row is touched.
      await db.many('SELECT id FROM workflow_runs WHERE consent_grant_id = ? ORDER BY id FOR UPDATE', [grantId]);
      await db.run(`INSERT INTO consent_revocations
        (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, downstream_deletion_due_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [revocationId, grantId, revokedByAdultId, reason, at, downstreamDeletionDueAt, at]);
      await db.run(`UPDATE integration_outbox SET status = 'cancelled', updated_at = ?, last_error = 'Consent revoked.'
        WHERE consent_grant_id = ? AND status IN ('pending', 'processing')`, [at, grantId]);
      // Revocation deletes source documents collected under this grant. A document merely named
      // by a later derive/read scope remains owned by its uploader; the consent-authorised runs
      // are still erased below through consentGrantId.
      const collectedDocuments = await db.many(`SELECT id FROM document_uploads
        WHERE consent_grant_id = ? ORDER BY id`, [grantId]);
      const derivedDocuments = await db.many(`SELECT DISTINCT document_upload_id AS id FROM ocr_jobs
        WHERE CAST(authorization_json AS jsonb) ->> 'consentGrantId' = ? ORDER BY 1`, [grantId]);
      const affectedDocuments = [...new Map(
        [...collectedDocuments, ...derivedDocuments].map(document => [document.id, document]),
      ).values()];
      // Documents this grant disclosed to Gemini for policy structuring (a document scope naming the model
      // recipient). Only the structuring output is erased for them (runs, proposals and the observations those
      // runs wrote), under each document's own household; the document, its OCR pages and analysis resting on
      // other grants stay.
      const modelDisclosedDocuments = (await db.many(`SELECT DISTINCT document.id, document.household_id
        FROM consent_scopes scope JOIN document_uploads document ON document.id = scope.resource_id
        WHERE scope.consent_grant_id = ? AND scope.resource_type = 'document' AND scope.recipient = ?
        ORDER BY document.id`, [grantId, GEMINI_RECIPIENT]))
        .filter(document => !affectedDocuments.some(affected => affected.id === document.id));
      const cancelOcrSet = `status = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'cancelled' ELSE status END,
          completed_at = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN CAST(? AS text) ELSE completed_at END,
          error_code = CASE
            WHEN status IN ('submitted', 'processing') OR (status = 'queued' AND started_at IS NOT NULL)
              THEN 'CONSENT_REVOKED'
            WHEN status = 'cancelled' AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED')
              THEN error_code
            ELSE NULL
          END,
          provider_job_ref = CASE
            WHEN status IN ('submitted', 'processing')
              OR (status = 'cancelled' AND error_code IN ('DOCUMENT_DELETED', 'CONSENT_REVOKED'))
              THEN provider_job_ref
            ELSE NULL
          END,
          error_message = NULL, authorization_json = NULL, result_json = NULL, result_digest = NULL, updated_at = ?`;
      for (const { id: documentId } of collectedDocuments) {
        await db.run(`UPDATE ocr_jobs SET ${cancelOcrSet} WHERE document_upload_id = ?`, [at, at, documentId]);
      }
      await db.run(`UPDATE ocr_jobs SET ${cancelOcrSet}
        WHERE CAST(authorization_json AS jsonb) ->> 'consentGrantId' = ?`, [at, at, grantId]);
      // Observation values derived from the revoked documents are erased and the
      // erasure is audited (counts only) before the lifecycle change below, which
      // would otherwise redact them silently through the database safety net.
      // Observation writers (recordModelExtraction) hold the same household lock.
      if (this.coverageParameters) {
        for (const { id: documentId } of affectedDocuments) {
          await this.coverageParameters.redactObservationsForDocument({
            documentId, reasonCode: 'consent_revoked', actorType: 'adult_user', actorId: revokedByAdultId, at,
          });
        }
      }
      // Run data derived from the revoked documents (excerpts stored in run input,
      // task outputs) and from runs authorised by this grant is erased in the same
      // transaction; the runs are locked there before their tasks. Counts only are audited.
      await this.eraseDerivedRunData({
        householdId: grant.household_id,
        documentIds: affectedDocuments.map(document => document.id),
        consentGrantId: grantId,
        reason: ERASURE_MARKER,
        resourceType: 'consent_grant',
        resourceId: grantId,
        actorType: 'adult_user',
        actorId: revokedByAdultId,
        at,
      });
      for (const document of modelDisclosedDocuments) {
        if (!this.policyStructuring) throw notConfigured('Policy structuring erasure is not configured.');
        await this.policyStructuring.eraseDerived({
          householdId: document.household_id, documentIds: [document.id], reasonCode: ERASURE_MARKER,
          resourceType: 'consent_grant', resourceId: grantId, actorType: 'adult_user', actorId: revokedByAdultId, at,
        });
        // Question-time grants (ADR 0008): clauses, their FTS rows and answers citing the document go too.
        if (!this.clauses) throw notConfigured('Policy evidence erasure is not configured.');
        await this.clauses.eraseDerived({
          householdId: document.household_id, documentIds: [document.id], reasonCode: ERASURE_MARKER,
          resourceType: 'consent_grant', resourceId: grantId, actorType: 'adult_user', actorId: revokedByAdultId,
        });
      }
      // Stored OCR blocks are page text in another shape and are erased with it.
      for (const { id: documentId } of affectedDocuments) {
        await db.run(`UPDATE source_pages SET extracted_text = NULL, extraction_status = 'failed',
            confidence_basis_points = NULL, page_sha256 = ?, text_sha256 = NULL,
            provider_page_ref = NULL, provenance_json = NULL, blocks_json = NULL, source_version = 'revoked:' || id
          WHERE document_upload_id = ?`, [EMPTY_TEXT_SHA256, documentId]);
      }
      for (const { id: documentId } of collectedDocuments) {
        await db.run(`UPDATE document_uploads
          SET lifecycle_state = 'deletion_requested', next_scan_at = NULL
          WHERE id = ? AND lifecycle_state IN ('active', 'quarantined')`, [documentId]);
      }
      // Runs (already locked above) before their tasks, then the graph tombstones.
      await db.run(`UPDATE workflow_runs
        SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED'
        WHERE consent_grant_id = ? AND status <> 'revoked'`, [at, grantId]);
      await db.run(`UPDATE workflow_tasks
        SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED',
            output_json = NULL, output_digest = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE status IN ('pending', 'running', 'completed') AND workflow_run_id IN (
          SELECT id FROM workflow_runs WHERE consent_grant_id = ?
        )`, [at, grantId]);
      await db.run(`UPDATE coverage_graph_snapshots SET status = 'superseded'
        WHERE generated_by_run_id IN (SELECT id FROM workflow_runs WHERE consent_grant_id = ?)
          AND status <> 'superseded'`, [grantId]);
      await this.audit?.append({ householdId: grant.household_id, actorType: 'adult_user', actorId: revokedByAdultId, action: 'consent.revoked', resourceType: 'consent_grant', resourceId: grantId, payload: { reason } });
    }, { locks: [householdLock(existing.household_id)] });
    return this.get(grantId);
  }

  // Households whose runs an erasure touches when the caller did not name one, sorted so every
  // caller takes their advisory locks in the same order.
  async #householdsForRuns(runIds, consentGrantId) {
    const households = new Set();
    for (const runId of runIds) {
      const row = await this.database.one(`SELECT service_case.household_id FROM workflow_runs run
        JOIN service_cases service_case ON service_case.id = run.case_id WHERE run.id = ?`, [runId]);
      if (row?.household_id) households.add(row.household_id);
    }
    if (consentGrantId) {
      const row = await this.database.one('SELECT household_id FROM consent_grants WHERE id = ?', [consentGrantId]);
      if (row?.household_id) households.add(row.household_id);
    }
    return [...households].sort();
  }

  /**
   * Erases run data derived from documents whose processing consent is gone. Joins the caller's
   * transaction (as a savepoint) or opens its own. It takes the household advisory lock and locks
   * every affected run FOR UPDATE by id before any task row, so it serialises with
   * recordModelExtraction and cannot deadlock against task completion. A run is affected when its
   * persisted authorisation or sent pages reference one of `documentIds` (household-scoped scan in
   * bounded batches), when its id is in `runIds`, or when it was authorised by `consentGrantId`.
   * For each affected run:
   *   - source page entries of the affected documents (all pages for a targeted run) in the run
   *     input lose their text and keep only ids, version, page and `redacted: 'consent_revoked'`;
   *   - every task output is nulled (all tasks are downstream of model extraction of those pages)
   *     and pending, running and completed tasks become revoked;
   *   - queued, running, completed and blocked runs become revoked; graph payloads, nodes and edges
   *     are erased while a non-sensitive superseded snapshot tombstone remains.
   * Evidence facts sourced from pages of `documentIds` are redacted (value and locators erased).
   * One audit event per store records counts only, inside the transaction. Idempotent. Returns
   * the counts.
   */
  async eraseDerivedRunData({
    householdId = null, documentIds = [], runIds = [], consentGrantId = null, reason = ERASURE_MARKER,
    resourceType, resourceId, caseId = null, actorType = 'system', actorId = 'local-backend',
    at = this.clock().toISOString(),
  }) {
    const db = this.database;
    const lockHouseholds = householdId ? [householdId] : await this.#householdsForRuns(runIds, consentGrantId);
    const locks = lockHouseholds.length > 0 ? lockHouseholds.map(householdLock) : [householdLock(null)];
    return db.transaction(() => this.#eraseDerivedRunData({
      householdId, documentIds, runIds, consentGrantId, reason, resourceType, resourceId, caseId, actorType, actorId, at,
    }), { locks });
  }

  async #eraseDerivedRunData({
    householdId, documentIds, runIds, consentGrantId, reason, resourceType, resourceId, caseId, actorType, actorId, at,
  }) {
    const db = this.database;
    const redactionReason = OBSERVATION_ERASURE_REASONS.has(reason) ? reason : ERASURE_MARKER;
    // Existing consent-stop paths intentionally keep their stable consent_revoked excerpt marker.
    // A direct document erasure is distinct and must not be mislabeled as consent revocation.
    const erasureMarker = redactionReason === 'document_erasure' ? 'document_erasure' : ERASURE_MARKER;
    const terminalReason = redactionReason === 'document_erasure' ? 'DOCUMENT_DELETED' : 'CONSENT_REVOKED';
    const documents = new Set(documentIds);
    const targeted = new Set(runIds);
    const candidateIds = new Set();
    for (const runId of runIds) {
      if (await db.one('SELECT id FROM workflow_runs WHERE id = ?', [runId])) candidateIds.add(runId);
    }
    if (consentGrantId) {
      for (const row of await db.many('SELECT id FROM workflow_runs WHERE consent_grant_id = ? ORDER BY id LIMIT ?', [consentGrantId, MAX_ERASURE_RUNS])) {
        targeted.add(row.id);
        candidateIds.add(row.id);
      }
    }
    if (documents.size > 0 && householdId) {
      let cursor = '';
      for (;;) {
        const batch = await db.many(`SELECT run.id FROM workflow_runs run
          JOIN service_cases service_case ON service_case.id = run.case_id
          WHERE service_case.household_id = ? AND run.id > ? ORDER BY run.id LIMIT ?`, [householdId, cursor, RUN_SCAN_BATCH_SIZE]);
        if (batch.length === 0) break;
        cursor = batch.at(-1).id;
        for (const row of batch) candidateIds.add(row.id);
        if (candidateIds.size > MAX_ERASURE_RUNS) throw new Error('Too many runs to erase in one transaction.');
      }
    }
    // Lock order: every candidate run by id before any task row. The input is re-read under the
    // lock so a concurrent writer that committed first is seen.
    const candidates = candidateIds.size === 0 ? [] : await db.many(`SELECT id, input_json FROM workflow_runs
      WHERE id = ANY(CAST(? AS text[])) ORDER BY id FOR UPDATE`, [[...candidateIds]]);

    let runs = 0;
    const erasedRunIds = [];
    let tasks = 0;
    let pages = 0;
    let graphs = 0;
    let graphNodes = 0;
    let graphEdges = 0;
    let policies = 0;
    let policyMembers = 0;
    for (const row of candidates) {
      let input = null;
      try { input = row.input_json === null ? null : JSON.parse(row.input_json); } catch { input = null; }
      const wholeRun = targeted.has(row.id);
      const referencesDocument = [
        ...(Array.isArray(input?.authorizedSources) ? input.authorizedSources : []),
        ...(Array.isArray(input?.sourcePages) ? input.sourcePages : []),
      ].some(entry => documents.has(entry?.documentId));
      if (!wholeRun && !referencesDocument) continue;
      runs += 1;
      erasedRunIds.push(row.id);
      if (Array.isArray(input?.sourcePages)) {
        let changed = 0;
        const sourcePages = input.sourcePages.map(page => {
          if (!page || typeof page !== 'object' || (!wholeRun && !documents.has(page.documentId))) return page;
          if (page.redacted === erasureMarker && Object.keys(page).every(key => ['sourceId', 'version', 'page', 'documentId', 'redacted'].includes(key))) return page;
          changed += 1;
          return { sourceId: page.sourceId, version: page.version, page: page.page, documentId: page.documentId, redacted: erasureMarker };
        });
        if (changed > 0) {
          await db.run('UPDATE workflow_runs SET input_json = ? WHERE id = ?', [JSON.stringify({ ...input, sourcePages }), row.id]);
          pages += changed;
        }
      }
      // The run row is locked above; its status changes before its tasks are written.
      await db.run(`UPDATE workflow_runs
        SET status = 'revoked', finished_at = ?, terminal_reason = ?
        WHERE id = ? AND status IN ('queued', 'running', 'completed', 'blocked')`, [at, terminalReason, row.id]);
      tasks += (await db.run(`UPDATE workflow_tasks
        SET status = CASE WHEN status IN ('pending', 'running', 'completed') THEN 'revoked' ELSE status END,
            finished_at = CASE WHEN status IN ('pending', 'running', 'completed') THEN CAST(? AS text) ELSE finished_at END,
            terminal_reason = CASE WHEN status IN ('pending', 'running', 'completed') THEN CAST(? AS text) ELSE terminal_reason END,
            output_json = NULL, output_digest = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE workflow_run_id = ?
          AND (status IN ('pending', 'running', 'completed') OR output_json IS NOT NULL OR output_digest IS NOT NULL)`,
      [at, terminalReason, row.id])).changes;
      const snapshots = (await db.many('SELECT id FROM coverage_graph_snapshots WHERE generated_by_run_id = ?', [row.id])).length;
      if (snapshots > 0) {
        graphEdges += (await db.run(`DELETE FROM coverage_graph_edges
          WHERE snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE generated_by_run_id = ?)`, [row.id])).changes;
        graphNodes += (await db.run(`DELETE FROM coverage_graph_nodes
          WHERE snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE generated_by_run_id = ?)`, [row.id])).changes;
        graphs += (await db.run(`UPDATE coverage_graph_snapshots
          SET status = 'superseded', graph_json = '{}'
          WHERE generated_by_run_id = ? AND (status <> 'superseded' OR graph_json <> '{}')`, [row.id])).changes;
      }
      // Parameter observations recorded by the run are derived data too: their values are
      // erased with the run (counts-only audit inside the parameter repository).
      if (this.coverageParameters) {
        await this.coverageParameters.redactObservationsForRun({ workflowRunId: row.id, reasonCode: redactionReason, actorType, actorId, at });
      } else if (await db.one(`SELECT 1 AS present FROM coverage_parameter_observations observation
          JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id
          WHERE parameter.workflow_run_id = ? AND observation.redacted_at IS NULL LIMIT 1`, [row.id])) {
        // Fail closed: values would outlive the consent and no database trigger covers runs.
        throw notConfigured('Parameter observation erasure is not configured.');
      }
    }
    // Structuring output (proposals, structuring runs and the observations they wrote) of the
    // affected documents and runs is erased in the same transaction. Counts-only audit inside.
    let structuring = { proposals: 0, observations: 0, runs: 0 };
    if (documents.size > 0 || erasedRunIds.length > 0) {
      if (!this.policyStructuring) throw notConfigured('Policy structuring erasure is not configured.');
      structuring = await this.policyStructuring.eraseDerived({
        householdId, documentIds: [...documents], workflowRunIds: erasedRunIds, reasonCode: redactionReason,
        caseId, resourceType, resourceId, actorType, actorId, at,
      });
    }
    let evidence = { clauses: 0, answers: 0 };
    if (documents.size > 0) {
      if (!this.clauses) throw notConfigured('Policy evidence erasure is not configured.');
      evidence = await this.clauses.eraseDerived({
        householdId, documentIds: [...documents], reasonCode: redactionReason, caseId, resourceType, resourceId, actorType, actorId,
      });
    }
    if (runs > 0) {
      const graphCounts = graphs || graphNodes || graphEdges ? { graphs, graphNodes, graphEdges } : {};
      await this.audit?.append({
        householdId, caseId, actorType, actorId, action: 'analysis.derived_data_erased', resourceType, resourceId,
        payload: { reason, runs, tasks, pages, ...graphCounts, documents: documents.size },
      });
    }
    if (documents.size > 0) {
      for (const documentId of documents) {
        policyMembers += (await db.run(`DELETE FROM policy_members
          WHERE policy_id IN (SELECT id FROM policies WHERE source_document_id = ?)
            OR source_page_id IN (SELECT id FROM source_pages WHERE document_upload_id = ?)`, [documentId, documentId])).changes;
        policies += (await db.run(`UPDATE policies SET insurer_id = NULL,
            policy_kind = 'unknown', policy_number_masked = NULL, policy_version = NULL,
            starts_on = NULL, ends_on = NULL, verification_state = 'unverified', updated_at = ?
          WHERE source_document_id = ? AND (insurer_id IS NOT NULL OR policy_kind <> 'unknown'
            OR policy_number_masked IS NOT NULL OR policy_version IS NOT NULL OR starts_on IS NOT NULL
            OR ends_on IS NOT NULL OR verification_state <> 'unverified')`, [at, documentId])).changes;
      }
    }
    if (policies > 0 || policyMembers > 0) {
      await this.audit?.append({
        householdId, caseId, actorType, actorId, action: 'policy.derived_data_erased', resourceType, resourceId,
        payload: { reason, policies, policyMembers, documents: documents.size },
      });
    }
    // Evidence facts sourced from the affected documents are derived data too: the one permitted
    // update (migration 009) erases their value and locators and marks them UNKNOWN. Scoped to the
    // household when known. Counts only are audited.
    let facts = 0;
    if (documents.size > 0) {
      for (const documentId of documents) {
        facts += (await db.run(`UPDATE evidence_facts
          SET epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
              institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL,
              effective_at = NULL, redacted_at = ?, redaction_reason_code = ?
          WHERE redacted_at IS NULL
            AND (CAST(? AS text) IS NULL OR household_id = ?)
            AND source_page_id IN (SELECT id FROM source_pages WHERE document_upload_id = ?)`,
        [at, redactionReason, householdId, householdId, documentId])).changes;
      }
    }
    if (facts > 0) {
      await this.audit?.append({
        householdId, caseId, actorType, actorId, action: 'evidence.facts_erased', resourceType, resourceId,
        payload: { reason, facts, documents: documents.size },
      });
    }
    return Object.freeze({
      runs, tasks, pages, facts, graphs, graphNodes, graphEdges, policies, policyMembers,
      structuringProposals: structuring.proposals, structuringRuns: structuring.runs,
      policyClauses: evidence.clauses, policyAnswers: evidence.answers,
    });
  }
}
