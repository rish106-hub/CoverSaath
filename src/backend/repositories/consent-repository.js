import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;

const ERASURE_MARKER = 'consent_revoked';
// Erasure reasons recorded on observations, evidence facts and persisted source-page excerpts.
// Anything else is recorded as consent_revoked so an arbitrary caller value cannot become stored state.
const OBSERVATION_ERASURE_REASONS = new Set(['consent_revoked', 'document_erasure', 'source_consent_not_current']);
const RUN_SCAN_BATCH_SIZE = 100;
const MAX_ERASURE_RUNS = 5_000;

export class ConsentRepository {
  constructor(database, { clock = () => new Date(), audit, coverageParameters = null } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
    this.coverageParameters = coverageParameters;
  }

  grant({ id: grantId = id('consent'), householdId, subjectAdultId, grantedToActor = 'knowvia-local', purpose, noticeVersion = 'v1', evidenceMethod = 'typed', expiresAt = null, scopes = [] }) {
    if (!scopes.length) throw new Error('At least one consent scope is required.');
    const at = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO consent_grants
        (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(grantId, householdId, subjectAdultId, grantedToActor, purpose, noticeVersion, evidenceMethod, at, expiresAt, at);
      const insert = this.database.prepare(`INSERT INTO consent_scopes
        (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const scope of scopes) insert.run(id('scope'), grantId, scope.resourceType, scope.resourceId ?? null, scope.action, scope.dataCategory, scope.recipient ?? null, at);
      this.audit?.append({ householdId, actorType: 'adult_user', actorId: subjectAdultId, action: 'consent.granted', resourceType: 'consent_grant', resourceId: grantId, payload: { purpose, scopeCount: scopes.length, expiresAt } });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(grantId);
  }

  get(grantId) {
    const grant = this.database.prepare('SELECT * FROM consent_grants WHERE id = ?').get(grantId);
    if (!grant) return null;
    return { ...grant, scopes: this.database.prepare('SELECT * FROM consent_scopes WHERE consent_grant_id = ? ORDER BY created_at').all(grantId) };
  }

  requireActive(grantId, { subjectAdultId, purpose, resourceType, resourceId = null, action, dataCategory, recipient = null, at = this.clock().toISOString() } = {}) {
    // Expiry uses the same julianday comparison as source selection: timestamps
    // in different ISO forms compare by instant, and an unparseable expiry or
    // check time (julianday NULL) counts as expired (fail closed).
    const grant = this.database.prepare(`SELECT * FROM consent_grants
      WHERE id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))`)
      .get(grantId, at);
    if (!grant || (subjectAdultId && grant.subject_adult_id !== subjectAdultId) || (purpose && grant.purpose !== purpose)) {
      const error = new Error('Active subject-scoped consent is required.'); error.code = 'CONSENT_REQUIRED'; throw error;
    }
    if (resourceType || action || dataCategory || recipient) {
      const scopes = this.database.prepare('SELECT * FROM consent_scopes WHERE consent_grant_id = ?').all(grantId);
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

  canAccessField({ householdId, subjectAdultId, viewerAdultId, fieldKey, action = 'read', at = this.clock().toISOString() }) {
    if (subjectAdultId === viewerAdultId) return true;
    return Boolean(this.database.prepare(`SELECT 1
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
      LIMIT 1`).get(viewerAdultId, householdId, subjectAdultId, at, fieldKey, action, viewerAdultId));
  }

  canAccessResource({
    householdId, subjectAdultId, viewerAdultId, purpose, resourceType, resourceId,
    action = 'read', dataCategory, at = this.clock().toISOString(),
  }) {
    if (!householdId || !subjectAdultId || !viewerAdultId || !purpose || !resourceType || !resourceId || !dataCategory) return false;
    return Boolean(this.database.prepare(`SELECT 1
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
      LIMIT 1`).get(
      viewerAdultId, householdId, subjectAdultId, purpose, at,
      resourceType, resourceId, action, dataCategory, viewerAdultId,
    ));
  }

  requireResourceAccess(input) {
    if (!this.canAccessResource(input)) {
      const error = new Error('The subject has not granted this viewer access for the requested purpose and field.');
      error.code = 'FIELD_ACCESS_REQUIRED';
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  requireFieldAccess(input) {
    if (!this.canAccessField(input)) {
      const error = new Error('The subject has not granted access to this field for this viewer.');
      error.code = 'FIELD_ACCESS_REQUIRED';
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  revoke({ id: revocationId = id('revocation'), grantId, revokedByAdultId, reason = null, downstreamDeletionDueAt = null }) {
    const grant = this.get(grantId);
    if (!grant) throw new Error('Consent grant not found.');
    if (grant.subject_adult_id !== revokedByAdultId) throw new Error('Only the subject adult may revoke this consent.');
    if (grant.revoked_at) return grant;
    const at = this.clock().toISOString();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`INSERT INTO consent_revocations
        (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, downstream_deletion_due_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(revocationId, grantId, revokedByAdultId, reason, at, downstreamDeletionDueAt, at);
      this.database.prepare(`UPDATE integration_outbox SET status = 'cancelled', updated_at = ?, last_error = 'Consent revoked.'
        WHERE consent_grant_id = ? AND status IN ('pending', 'processing')`).run(at, grantId);
      // Revocation deletes source documents collected under this grant. A document merely named
      // by a later derive/read scope remains owned by its uploader; the consent-authorised runs
      // are still erased below through consentGrantId.
      const collectedDocuments = this.database.prepare(`SELECT id FROM document_uploads
        WHERE consent_grant_id = ? ORDER BY id`).all(grantId);
      const derivedDocuments = this.database.prepare(`SELECT DISTINCT document_upload_id AS id FROM ocr_jobs
        WHERE json_extract(authorization_json, '$.consentGrantId') = ? ORDER BY document_upload_id`).all(grantId);
      const affectedDocuments = [...new Map(
        [...collectedDocuments, ...derivedDocuments].map(document => [document.id, document]),
      ).values()];
      const cancelOcrSet = `status = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'cancelled' ELSE status END,
          completed_at = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN ? ELSE completed_at END,
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
      const cancelOcrByDocument = this.database.prepare(`UPDATE ocr_jobs SET
          ${cancelOcrSet}
        WHERE document_upload_id = ?`);
      const cancelOcrByAuthorization = this.database.prepare(`UPDATE ocr_jobs SET
          ${cancelOcrSet}
        WHERE json_extract(authorization_json, '$.consentGrantId') = ?`);
      for (const { id: documentId } of collectedDocuments) cancelOcrByDocument.run(at, at, documentId);
      cancelOcrByAuthorization.run(at, at, grantId);
      // Observation values derived from the revoked documents are erased and the
      // erasure is audited (counts only) before the lifecycle change below, which
      // would otherwise redact them silently through the database safety net.
      if (this.coverageParameters) {
        for (const { id: documentId } of affectedDocuments) {
          this.coverageParameters.redactObservationsForDocument({
            documentId, reasonCode: 'consent_revoked', actorType: 'adult_user', actorId: revokedByAdultId, at,
          });
        }
      }
      // Run data derived from the revoked documents (excerpts stored in run input,
      // task outputs) and from runs authorised by this grant is erased in the same
      // transaction. Counts only are audited.
      this.eraseDerivedRunData({
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
      const redactPages = this.database.prepare(`UPDATE source_pages SET extracted_text = NULL, extraction_status = 'failed',
          confidence_basis_points = NULL, page_sha256 = ?, text_sha256 = NULL,
          provider_page_ref = NULL, provenance_json = NULL, source_version = 'revoked:' || id
        WHERE document_upload_id = ?`);
      const requestDocumentDeletion = this.database.prepare(`UPDATE document_uploads
        SET lifecycle_state = 'deletion_requested', next_scan_at = NULL
        WHERE id = ? AND lifecycle_state IN ('active', 'quarantined')`);
      for (const { id: documentId } of affectedDocuments) {
        redactPages.run('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', documentId);
      }
      for (const { id: documentId } of collectedDocuments) {
        requestDocumentDeletion.run(documentId);
      }
      this.database.prepare(`UPDATE workflow_tasks
        SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED',
            output_json = NULL, output_digest = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE status IN ('pending', 'running', 'completed') AND workflow_run_id IN (
          SELECT id FROM workflow_runs WHERE consent_grant_id = ?
        )`).run(at, grantId);
      this.database.prepare(`UPDATE coverage_graph_snapshots SET status = 'superseded'
        WHERE generated_by_run_id IN (SELECT id FROM workflow_runs WHERE consent_grant_id = ?)
          AND status <> 'superseded'`).run(grantId);
      this.database.prepare(`UPDATE workflow_runs
        SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED'
        WHERE consent_grant_id = ? AND status <> 'revoked'`).run(at, grantId);
      this.audit?.append({ householdId: grant.household_id, actorType: 'adult_user', actorId: revokedByAdultId, action: 'consent.revoked', resourceType: 'consent_grant', resourceId: grantId, payload: { reason } });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(grantId);
  }

  /**
   * Erases run data derived from documents whose processing consent is gone. Must run inside
   * the caller's transaction. A run is affected when its persisted authorisation or sent pages
   * reference one of `documentIds` (household-scoped scan in bounded batches), when its id is in
   * `runIds`, or when it was authorised by `consentGrantId`. For each affected run:
   *   - source page entries of the affected documents (all pages for a targeted run) in the run
   *     input lose their text and keep only ids, version, page and `redacted: 'consent_revoked'`;
   *   - every task output is nulled (all tasks are downstream of model extraction of those pages)
   *     and pending, running and completed tasks become revoked;
   *   - queued, running, completed and blocked runs become revoked; graph payloads, nodes and edges
   *     are erased while a non-sensitive superseded snapshot tombstone remains.
   * Evidence facts sourced from pages of `documentIds` are redacted (value and locators erased).
   * One audit event per store records counts only. Idempotent. Returns the counts.
   */
  eraseDerivedRunData({
    householdId = null, documentIds = [], runIds = [], consentGrantId = null, reason = ERASURE_MARKER,
    resourceType, resourceId, caseId = null, actorType = 'system', actorId = 'local-backend',
    at = this.clock().toISOString(),
  }) {
    const redactionReason = OBSERVATION_ERASURE_REASONS.has(reason) ? reason : ERASURE_MARKER;
    // Existing consent-stop paths intentionally keep their stable consent_revoked excerpt marker.
    // A direct document erasure is distinct and must not be mislabeled as consent revocation.
    const erasureMarker = redactionReason === 'document_erasure' ? 'document_erasure' : ERASURE_MARKER;
    const terminalReason = redactionReason === 'document_erasure' ? 'DOCUMENT_DELETED' : 'CONSENT_REVOKED';
    const documents = new Set(documentIds);
    const targeted = new Set(runIds);
    const candidates = new Map();
    const remember = row => { if (row && !candidates.has(row.id)) candidates.set(row.id, row); };
    const byId = this.database.prepare('SELECT id, input_json FROM workflow_runs WHERE id = ?');
    for (const runId of runIds) remember(byId.get(runId));
    if (consentGrantId) {
      for (const row of this.database.prepare('SELECT id, input_json FROM workflow_runs WHERE consent_grant_id = ? ORDER BY id LIMIT ?')
        .all(consentGrantId, MAX_ERASURE_RUNS)) {
        targeted.add(row.id);
        remember(row);
      }
    }
    if (documents.size > 0 && householdId) {
      const scan = this.database.prepare(`SELECT run.id, run.input_json FROM workflow_runs run
        JOIN service_cases service_case ON service_case.id = run.case_id
        WHERE service_case.household_id = ? AND run.id > ? ORDER BY run.id LIMIT ?`);
      let cursor = '';
      for (;;) {
        const batch = scan.all(householdId, cursor, RUN_SCAN_BATCH_SIZE);
        if (batch.length === 0) break;
        cursor = batch.at(-1).id;
        batch.forEach(remember);
        if (candidates.size > MAX_ERASURE_RUNS) throw new Error('Too many runs to erase in one transaction.');
      }
    }

    let runs = 0;
    let tasks = 0;
    let pages = 0;
    let graphs = 0;
    let graphNodes = 0;
    let graphEdges = 0;
    let policies = 0;
    let policyMembers = 0;
    const setInput = this.database.prepare('UPDATE workflow_runs SET input_json = ? WHERE id = ?');
    const nullOutputs = this.database.prepare(`UPDATE workflow_tasks
      SET status = CASE WHEN status IN ('pending', 'running', 'completed') THEN 'revoked' ELSE status END,
          finished_at = CASE WHEN status IN ('pending', 'running', 'completed') THEN ? ELSE finished_at END,
          terminal_reason = CASE WHEN status IN ('pending', 'running', 'completed') THEN ? ELSE terminal_reason END,
          output_json = NULL, output_digest = NULL, lease_owner = NULL, lease_expires_at = NULL
      WHERE workflow_run_id = ?
        AND (status IN ('pending', 'running', 'completed') OR output_json IS NOT NULL OR output_digest IS NOT NULL)`);
    const revokeRun = this.database.prepare(`UPDATE workflow_runs
      SET status = 'revoked', finished_at = ?, terminal_reason = ?
      WHERE id = ? AND status IN ('queued', 'running', 'completed', 'blocked')`);
    const graphIds = this.database.prepare('SELECT id FROM coverage_graph_snapshots WHERE generated_by_run_id = ?');
    const eraseGraphEdges = this.database.prepare(`DELETE FROM coverage_graph_edges
      WHERE snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE generated_by_run_id = ?)`);
    const eraseGraphNodes = this.database.prepare(`DELETE FROM coverage_graph_nodes
      WHERE snapshot_id IN (SELECT id FROM coverage_graph_snapshots WHERE generated_by_run_id = ?)`);
    const eraseGraphs = this.database.prepare(`UPDATE coverage_graph_snapshots
      SET status = 'superseded', graph_json = '{}'
      WHERE generated_by_run_id = ? AND (status <> 'superseded' OR graph_json <> '{}')`);
    for (const row of candidates.values()) {
      let input = null;
      try { input = row.input_json === null ? null : JSON.parse(row.input_json); } catch { input = null; }
      const wholeRun = targeted.has(row.id);
      const referencesDocument = [
        ...(Array.isArray(input?.authorizedSources) ? input.authorizedSources : []),
        ...(Array.isArray(input?.sourcePages) ? input.sourcePages : []),
      ].some(entry => documents.has(entry?.documentId));
      if (!wholeRun && !referencesDocument) continue;
      runs += 1;
      if (Array.isArray(input?.sourcePages)) {
        let changed = 0;
        const sourcePages = input.sourcePages.map(page => {
          if (!page || typeof page !== 'object' || (!wholeRun && !documents.has(page.documentId))) return page;
          if (page.redacted === erasureMarker && Object.keys(page).every(key => ['sourceId', 'version', 'page', 'documentId', 'redacted'].includes(key))) return page;
          changed += 1;
          return { sourceId: page.sourceId, version: page.version, page: page.page, documentId: page.documentId, redacted: erasureMarker };
        });
        if (changed > 0) {
          setInput.run(JSON.stringify({ ...input, sourcePages }), row.id);
          pages += changed;
        }
      }
      tasks += Number(nullOutputs.run(at, terminalReason, row.id).changes);
      revokeRun.run(at, terminalReason, row.id);
      const snapshots = graphIds.all(row.id).length;
      if (snapshots > 0) {
        graphEdges += Number(eraseGraphEdges.run(row.id).changes);
        graphNodes += Number(eraseGraphNodes.run(row.id).changes);
        graphs += Number(eraseGraphs.run(row.id).changes);
      }
      // Parameter observations recorded by the run are derived data too: their values are
      // erased with the run (counts-only audit inside the parameter repository).
      if (this.coverageParameters) {
        this.coverageParameters.redactObservationsForRun({ workflowRunId: row.id, reasonCode: redactionReason, actorType, actorId, at });
      } else if (this.database.prepare(`SELECT 1 FROM coverage_parameter_observations observation
          JOIN coverage_parameter_records parameter ON parameter.id = observation.parameter_record_id
          WHERE parameter.workflow_run_id = ? AND observation.redacted_at IS NULL LIMIT 1`).get(row.id)) {
        // Fail closed: values would outlive the consent and no database trigger covers runs.
        throw Object.assign(new Error('Parameter observation erasure is not configured.'), { code: 'ERASURE_NOT_CONFIGURED', statusCode: 503 });
      }
    }
    if (runs > 0) {
      const graphCounts = graphs || graphNodes || graphEdges ? { graphs, graphNodes, graphEdges } : {};
      this.audit?.append({
        householdId, caseId, actorType, actorId, action: 'analysis.derived_data_erased', resourceType, resourceId,
        payload: { reason, runs, tasks, pages, ...graphCounts, documents: documents.size },
      });
    }
    if (documents.size > 0) {
      const erasePolicyMembers = this.database.prepare(`DELETE FROM policy_members
        WHERE policy_id IN (SELECT id FROM policies WHERE source_document_id = ?)
          OR source_page_id IN (SELECT id FROM source_pages WHERE document_upload_id = ?)`);
      const erasePolicies = this.database.prepare(`UPDATE policies SET insurer_id = NULL,
          policy_kind = 'unknown', policy_number_masked = NULL, policy_version = NULL,
          starts_on = NULL, ends_on = NULL, verification_state = 'unverified', updated_at = ?
        WHERE source_document_id = ? AND (insurer_id IS NOT NULL OR policy_kind <> 'unknown'
          OR policy_number_masked IS NOT NULL OR policy_version IS NOT NULL OR starts_on IS NOT NULL
          OR ends_on IS NOT NULL OR verification_state <> 'unverified')`);
      for (const documentId of documents) {
        policyMembers += Number(erasePolicyMembers.run(documentId, documentId).changes);
        policies += Number(erasePolicies.run(at, documentId).changes);
      }
    }
    if (policies > 0 || policyMembers > 0) {
      this.audit?.append({
        householdId, caseId, actorType, actorId, action: 'policy.derived_data_erased', resourceType, resourceId,
        payload: { reason, policies, policyMembers, documents: documents.size },
      });
    }
    // Evidence facts sourced from the affected documents are derived data too: the one permitted
    // update (migration 009) erases their value and locators and marks them UNKNOWN. Scoped to the
    // household when known. Counts only are audited.
    let facts = 0;
    if (documents.size > 0) {
      const redactFacts = this.database.prepare(`UPDATE evidence_facts
        SET epistemic_state = 'unknown', value_json = NULL, source_page_id = NULL, source_locator = NULL,
            institutional_source_ref = NULL, calculation_method = NULL, permitted_viewers_json = NULL,
            effective_at = NULL, redacted_at = ?, redaction_reason_code = ?
        WHERE redacted_at IS NULL
          AND (? IS NULL OR household_id = ?)
          AND source_page_id IN (SELECT id FROM source_pages WHERE document_upload_id = ?)`);
      const reasonCode = redactionReason;
      for (const documentId of documents) {
        facts += Number(redactFacts.run(at, reasonCode, householdId, householdId, documentId).changes);
      }
    }
    if (facts > 0) {
      this.audit?.append({
        householdId, caseId, actorType, actorId, action: 'evidence.facts_erased', resourceType, resourceId,
        payload: { reason, facts, documents: documents.size },
      });
    }
    return Object.freeze({ runs, tasks, pages, facts, graphs, graphNodes, graphEdges, policies, policyMembers });
  }
}
