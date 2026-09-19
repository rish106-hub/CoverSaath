import { randomUUID } from 'node:crypto';

const id = prefix => `${prefix}-${randomUUID()}`;

export class ConsentRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  grant({ id: grantId = id('consent'), householdId, subjectAdultId, grantedToActor = 'coversaath-local', purpose, noticeVersion = 'v1', evidenceMethod = 'typed', expiresAt = null, scopes = [] }) {
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
      this.database.prepare(`UPDATE workflow_tasks SET status = 'revoked', finished_at = ?
        WHERE status = 'pending' AND workflow_run_id IN (
          SELECT wr.id FROM workflow_runs wr JOIN service_cases sc ON sc.id = wr.case_id WHERE sc.household_id = ?
        )`).run(at, grant.household_id);
      this.database.prepare(`UPDATE workflow_runs SET status = 'revoked', finished_at = ?
        WHERE status = 'queued' AND case_id IN (SELECT id FROM service_cases WHERE household_id = ?)`).run(at, grant.household_id);
      this.audit?.append({ householdId: grant.household_id, actorType: 'adult_user', actorId: revokedByAdultId, action: 'consent.revoked', resourceType: 'consent_grant', resourceId: grantId, payload: { reason } });
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return this.get(grantId);
  }
}

