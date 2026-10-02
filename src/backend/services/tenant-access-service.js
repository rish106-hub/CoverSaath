import { createHash, timingSafeEqual } from 'node:crypto';

function fail(code, message, statusCode) {
  throw Object.assign(new Error(message), { code, statusCode });
}

function bearer(authorization) {
  const match = typeof authorization === 'string' && authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  return match?.[1] ?? null;
}

function sameSecret(left, right) {
  if (!left || !right) return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export class TenantAccessService {
  constructor(database, { auth, households, consents, env = {} }) {
    this.database = database;
    this.auth = auth;
    this.households = households;
    this.consents = consents;
    this.bootstrapToken = env.KNOWVIA_BOOTSTRAP_TOKEN ?? null;
    if (this.bootstrapToken && (typeof this.bootstrapToken !== 'string' || this.bootstrapToken.length < 32 || this.bootstrapToken.length > 256)) {
      throw new Error('KNOWVIA_BOOTSTRAP_TOKEN must contain 32 to 256 characters.');
    }
  }

  get bootstrapConfigured() { return Boolean(this.bootstrapToken); }

  requireBootstrap(authorization) {
    if (!this.bootstrapToken) fail('AUTH_NOT_CONFIGURED', 'Household bootstrap authentication is not configured.', 503);
    if (!sameSecret(bearer(authorization), this.bootstrapToken)) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
    return true;
  }

  authenticate(authorization) {
    const principal = this.auth.authenticate(bearer(authorization));
    if (!principal) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
    return principal;
  }

  requireHousehold(principal, householdId, options) {
    return this.households.requireAccess(householdId, principal.adultId, options);
  }

  requireCase(principal, caseId, options) {
    const caseRecord = this.database.prepare('SELECT * FROM service_cases WHERE id = ?').get(caseId);
    if (!caseRecord) fail('CASE_NOT_FOUND', 'Case not found.', 404);
    this.requireHousehold(principal, caseRecord.household_id, options);
    return caseRecord;
  }

  requireRun(principal, runId) {
    const record = this.database.prepare(`SELECT workflow_runs.*, service_cases.household_id
      FROM workflow_runs JOIN service_cases ON service_cases.id = workflow_runs.case_id
      WHERE workflow_runs.id = ?`).get(runId);
    if (!record) fail('JOB_NOT_FOUND', 'Job not found.', 404);
    this.requireHousehold(principal, record.household_id);
    return record;
  }

  requireTask(principal, taskId) {
    const record = this.database.prepare(`SELECT workflow_tasks.*, service_cases.household_id
      FROM workflow_tasks
      JOIN workflow_runs ON workflow_runs.id = workflow_tasks.workflow_run_id
      JOIN service_cases ON service_cases.id = workflow_runs.case_id
      WHERE workflow_tasks.id = ?`).get(taskId);
    if (!record) fail('TASK_NOT_FOUND', 'Task not found.', 404);
    this.requireHousehold(principal, record.household_id);
    return record;
  }

  householdMatrix(principal, householdId) {
    const { household, role } = this.requireHousehold(principal, householdId);
    const members = this.households.listMembers(householdId).map(member => {
      const canReadBirthDate = member.adult_user_id && this.consents.canAccessField({
        householdId,
        subjectAdultId: member.adult_user_id,
        viewerAdultId: principal.adultId,
        fieldKey: 'date_of_birth',
      });
      const latestCase = this.database.prepare(`SELECT id, status, trigger_type, updated_at
        FROM service_cases WHERE household_id = ? AND subject_member_id = ?
        ORDER BY updated_at DESC LIMIT 1`).get(householdId, member.id) ?? null;
      const caseSubjectAdultId = member.adult_user_id ?? (latestCase
        ? this.database.prepare('SELECT opened_by_adult_id FROM service_cases WHERE id = ?').get(latestCase.id)?.opened_by_adult_id
        : null);
      const canReadImmediateIssue = Boolean(latestCase && caseSubjectAdultId && this.consents.canAccessResource({
        householdId,
        subjectAdultId: caseSubjectAdultId,
        viewerAdultId: principal.adultId,
        purpose: 'coverage_reconstruction',
        resourceType: 'case',
        resourceId: latestCase.id,
        action: 'read',
        dataCategory: 'case_summary',
      }));
      const policyCount = this.database.prepare(`SELECT count(*) AS count
        FROM policy_members JOIN policies ON policies.id = policy_members.policy_id
        WHERE household_member_id = ? AND policies.household_id = ?`).get(member.id, householdId).count;
      return {
        id: member.id,
        displayName: member.display_name,
        memberKind: member.member_kind,
        relationshipLabel: member.relationship_label,
        dateOfBirth: canReadBirthDate ? member.date_of_birth : null,
        fieldAccess: {
          dateOfBirth: canReadBirthDate ? 'granted' : 'withheld',
          immediateIssue: canReadImmediateIssue ? 'granted' : 'withheld',
        },
        policiesFound: policyCount,
        immediateIssue: canReadImmediateIssue
          ? { caseId: latestCase.id, status: latestCase.status, triggerType: latestCase.trigger_type }
          : null,
      };
    });
    return { household, viewerRole: role.role, members };
  }
}
