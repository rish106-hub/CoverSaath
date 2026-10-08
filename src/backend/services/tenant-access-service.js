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

  async authenticate(authorization) {
    const principal = await this.auth.authenticate(bearer(authorization));
    if (!principal) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
    return principal;
  }

  async requireHousehold(principal, householdId, options) {
    return this.households.requireAccess(householdId, principal.adultId, options);
  }

  async requireCase(principal, caseId, options) {
    const caseRecord = await this.database.one('SELECT * FROM service_cases WHERE id = $1', [caseId]);
    if (!caseRecord) fail('CASE_NOT_FOUND', 'Case not found.', 404);
    await this.requireHousehold(principal, caseRecord.household_id, options);
    return caseRecord;
  }

  async requireRun(principal, runId) {
    const record = await this.database.one(`SELECT workflow_runs.*, service_cases.household_id
      FROM workflow_runs JOIN service_cases ON service_cases.id = workflow_runs.case_id
      WHERE workflow_runs.id = $1`, [runId]);
    if (!record) fail('JOB_NOT_FOUND', 'Job not found.', 404);
    await this.requireHousehold(principal, record.household_id);
    return record;
  }

  async requireTask(principal, taskId) {
    const record = await this.database.one(`SELECT workflow_tasks.*, service_cases.household_id
      FROM workflow_tasks
      JOIN workflow_runs ON workflow_runs.id = workflow_tasks.workflow_run_id
      JOIN service_cases ON service_cases.id = workflow_runs.case_id
      WHERE workflow_tasks.id = $1`, [taskId]);
    if (!record) fail('TASK_NOT_FOUND', 'Task not found.', 404);
    await this.requireHousehold(principal, record.household_id);
    return record;
  }

  async householdMatrix(principal, householdId) {
    const { household, role } = await this.requireHousehold(principal, householdId);
    const rows = await this.households.listMembers(householdId);
    const members = await Promise.all(rows.map(async member => {
      const canReadBirthDate = member.adult_user_id && await this.consents.canAccessField({
        householdId,
        subjectAdultId: member.adult_user_id,
        viewerAdultId: principal.adultId,
        fieldKey: 'date_of_birth',
      });
      const latestCase = await this.database.one(`SELECT id, status, trigger_type, updated_at, opened_by_adult_id
        FROM service_cases WHERE household_id = $1 AND subject_member_id = $2
        ORDER BY updated_at DESC LIMIT 1`, [householdId, member.id]);
      const caseSubjectAdultId = member.adult_user_id ?? latestCase?.opened_by_adult_id ?? null;
      const canReadImmediateIssue = Boolean(latestCase && caseSubjectAdultId && await this.consents.canAccessResource({
        householdId,
        subjectAdultId: caseSubjectAdultId,
        viewerAdultId: principal.adultId,
        purpose: 'coverage_reconstruction',
        resourceType: 'case',
        resourceId: latestCase.id,
        action: 'read',
        dataCategory: 'case_summary',
      }));
      const { count: policyCount } = await this.database.one(`SELECT count(*) AS count
        FROM policy_members JOIN policies ON policies.id = policy_members.policy_id
        WHERE household_member_id = $1 AND policies.household_id = $2`, [member.id, householdId]);
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
    }));
    return { household, viewerRole: role.role, members };
  }
}
