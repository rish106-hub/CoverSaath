import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;

export class ConsentRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
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
    const grant = this.database.prepare(`SELECT * FROM consent_grants
      WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`)
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
        (!recipient || scope.recipient === null || scope.recipient === recipient));
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
      this.database.prepare(`UPDATE ocr_jobs SET
          status = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'cancelled' ELSE status END,
          completed_at = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN ? ELSE completed_at END,
          error_code = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'CONSENT_REVOKED' ELSE error_code END,
          error_message = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'Source processing consent was revoked.' ELSE error_message END,
          result_json = NULL, result_digest = NULL, updated_at = ?
        WHERE document_upload_id IN (
          SELECT id FROM document_uploads WHERE consent_grant_id = ?
        )`).run(at, at, grantId);
      this.database.prepare(`UPDATE source_pages SET extracted_text = NULL, extraction_status = 'failed',
          confidence_basis_points = NULL, page_sha256 = ?, text_sha256 = NULL,
          provider_page_ref = NULL, provenance_json = NULL, source_version = 'revoked:' || id
        WHERE document_upload_id IN (SELECT id FROM document_uploads WHERE consent_grant_id = ?)`)
        .run('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', grantId);
      this.database.prepare(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested'
        WHERE consent_grant_id = ? AND lifecycle_state IN ('active', 'quarantined')`).run(grantId);
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
}
