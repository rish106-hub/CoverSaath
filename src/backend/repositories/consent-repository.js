import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class ConsentRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  async grant({ id: grantId = id('consent'), householdId, subjectAdultId, grantedToActor = 'knowvia-local', purpose, noticeVersion = 'v1', evidenceMethod = 'typed', expiresAt = null, scopes = [] }) {
    if (!scopes.length) throw new Error('At least one consent scope is required.');
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      await tx.query(`INSERT INTO consent_grants
        (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [grantId, householdId, subjectAdultId, grantedToActor, purpose, noticeVersion, evidenceMethod, at, expiresAt, at]);
      for (const scope of scopes) {
        await tx.query(`INSERT INTO consent_scopes
          (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id('scope'), grantId, scope.resourceType, scope.resourceId ?? null, scope.action, scope.dataCategory, scope.recipient ?? null, at]);
      }
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: subjectAdultId, action: 'consent.granted', resourceType: 'consent_grant', resourceId: grantId, payload: { purpose, scopeCount: scopes.length, expiresAt } });
    });
    return this.get(grantId);
  }

  async get(grantId) {
    const grant = await this.database.one('SELECT * FROM consent_grants WHERE id = $1', [grantId]);
    if (!grant) return null;
    return { ...grant, scopes: await this.database.query('SELECT * FROM consent_scopes WHERE consent_grant_id = $1 ORDER BY created_at', [grantId]) };
  }

  async requireActive(grantId, { subjectAdultId, purpose, resourceType, resourceId = null, action, dataCategory, recipient = null, at = this.clock().toISOString() } = {}) {
    const grant = await this.database.one(`SELECT * FROM consent_grants
      WHERE id = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`, [grantId, at]);
    if (!grant || (subjectAdultId && grant.subject_adult_id !== subjectAdultId) || (purpose && grant.purpose !== purpose)) {
      const error = new Error('Active subject-scoped consent is required.'); error.code = 'CONSENT_REQUIRED'; throw error;
    }
    if (resourceType || action || dataCategory || recipient) {
      const scopes = await this.database.query('SELECT * FROM consent_scopes WHERE consent_grant_id = $1', [grantId]);
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

  async canAccessField({ householdId, subjectAdultId, viewerAdultId, fieldKey, action = 'read', at = this.clock().toISOString() }) {
    if (subjectAdultId === viewerAdultId) return true;
    return Boolean(await this.database.one(`SELECT 1 AS allowed
      FROM consent_grants grant_record
      JOIN consent_scopes scope ON scope.consent_grant_id = grant_record.id
      JOIN household_roles viewer_role
        ON viewer_role.household_id = grant_record.household_id
       AND viewer_role.adult_user_id = $1
       AND viewer_role.status = 'active'
      WHERE grant_record.household_id = $2
        AND grant_record.subject_adult_id = $3
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR grant_record.expires_at > $4)
        AND scope.resource_type = 'profile_field'
        AND scope.resource_id = $5
        AND scope.action = $6
        AND scope.recipient = $1
      LIMIT 1`, [viewerAdultId, householdId, subjectAdultId, at, fieldKey, action]));
  }

  async canAccessResource({
    householdId, subjectAdultId, viewerAdultId, purpose, resourceType, resourceId,
    action = 'read', dataCategory, at = this.clock().toISOString(),
  }) {
    if (!householdId || !subjectAdultId || !viewerAdultId || !purpose || !resourceType || !resourceId || !dataCategory) return false;
    return Boolean(await this.database.one(`SELECT 1 AS allowed
      FROM consent_grants grant_record
      JOIN consent_scopes scope ON scope.consent_grant_id = grant_record.id
      JOIN household_roles viewer_role
        ON viewer_role.household_id = grant_record.household_id
       AND viewer_role.adult_user_id = $1
       AND viewer_role.status = 'active'
      WHERE grant_record.household_id = $2
        AND grant_record.subject_adult_id = $3
        AND grant_record.purpose = $4
        AND grant_record.revoked_at IS NULL
        AND (grant_record.expires_at IS NULL OR grant_record.expires_at > $5)
        AND scope.resource_type = $6
        AND scope.resource_id = $7
        AND scope.action = $8
        AND scope.data_category = $9
        AND scope.recipient = $1
      LIMIT 1`, [viewerAdultId, householdId, subjectAdultId, purpose, at, resourceType, resourceId, action, dataCategory]));
  }

  async requireResourceAccess(input) {
    if (!(await this.canAccessResource(input))) {
      const error = new Error('The subject has not granted this viewer access for the requested purpose and field.');
      error.code = 'FIELD_ACCESS_REQUIRED';
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  async requireFieldAccess(input) {
    if (!(await this.canAccessField(input))) {
      const error = new Error('The subject has not granted access to this field for this viewer.');
      error.code = 'FIELD_ACCESS_REQUIRED';
      error.statusCode = 403;
      throw error;
    }
    return true;
  }

  async revoke({ id: revocationId = id('revocation'), grantId, revokedByAdultId, reason = null, downstreamDeletionDueAt = null }) {
    const preview = await this.get(grantId);
    if (!preview) throw new Error('Consent grant not found.');
    if (preview.subject_adult_id !== revokedByAdultId) throw new Error('Only the subject adult may revoke this consent.');
    if (preview.revoked_at) return preview;
    const at = this.clock().toISOString();
    await this.database.transaction(async tx => {
      const grant = await tx.one('SELECT * FROM consent_grants WHERE id = $1 FOR UPDATE', [grantId]);
      if (grant.revoked_at) return;
      // Lock order: workflow runs first (ascending id), then everything that hangs off them. Workers use the same order.
      await tx.query('SELECT id FROM workflow_runs WHERE consent_grant_id = $1 ORDER BY id FOR UPDATE', [grantId]);
      await tx.query(`INSERT INTO consent_revocations
        (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, downstream_deletion_due_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [revocationId, grantId, revokedByAdultId, reason, at, downstreamDeletionDueAt, at]);
      await tx.query(`UPDATE integration_outbox SET status = 'cancelled', updated_at = $1, last_error = 'Consent revoked.'
        WHERE consent_grant_id = $2 AND status IN ('pending', 'processing')`, [at, grantId]);
      await tx.query(`UPDATE ocr_jobs SET
          status = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'cancelled' ELSE status END,
          completed_at = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN $1::timestamptz ELSE completed_at END,
          error_code = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'CONSENT_REVOKED' ELSE error_code END,
          error_message = CASE WHEN status IN ('queued', 'submitted', 'processing') THEN 'Source processing consent was revoked.' ELSE error_message END,
          result_json = NULL, result_digest = NULL, updated_at = $1::timestamptz
        WHERE document_upload_id IN (
          SELECT id FROM document_uploads WHERE consent_grant_id = $2
        )`, [at, grantId]);
      await tx.query(`UPDATE source_pages SET extracted_text = NULL, extraction_status = 'failed',
          confidence_basis_points = NULL, page_sha256 = $1, text_sha256 = NULL,
          provider_page_ref = NULL, provenance_json = NULL, source_version = 'revoked:' || id
        WHERE document_upload_id IN (SELECT id FROM document_uploads WHERE consent_grant_id = $2)`, [EMPTY_SHA256, grantId]);
      await tx.query(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested'
        WHERE consent_grant_id = $1 AND lifecycle_state IN ('active', 'quarantined')`, [grantId]);
      await tx.query(`UPDATE workflow_tasks
        SET status = 'revoked', finished_at = $1, terminal_reason = 'CONSENT_REVOKED',
            output_json = NULL, output_digest = NULL, lease_owner = NULL, lease_expires_at = NULL
        WHERE status IN ('pending', 'running', 'completed') AND workflow_run_id IN (
          SELECT id FROM workflow_runs WHERE consent_grant_id = $2
        )`, [at, grantId]);
      await tx.query(`UPDATE coverage_graph_snapshots SET status = 'superseded'
        WHERE generated_by_run_id IN (SELECT id FROM workflow_runs WHERE consent_grant_id = $1)
          AND status <> 'superseded'`, [grantId]);
      await tx.query(`UPDATE workflow_runs
        SET status = 'revoked', finished_at = $1, terminal_reason = 'CONSENT_REVOKED'
        WHERE consent_grant_id = $2 AND status <> 'revoked'`, [at, grantId]);
      await this.audit?.append({ householdId: grant.household_id, actorType: 'adult_user', actorId: revokedByAdultId, action: 'consent.revoked', resourceType: 'consent_grant', resourceId: grantId, payload: { reason } });
    });
    return this.get(grantId);
  }
}
