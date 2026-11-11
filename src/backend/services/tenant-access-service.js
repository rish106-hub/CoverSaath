import { createHash, timingSafeEqual } from 'node:crypto';
import { resolveColumnCrypto } from '../security/column-crypto.js';
import { openCaseRecord, openWorkflowRun, openWorkflowTask } from '../security/sealed-records.js';

function fail(code, message, statusCode) {
  throw Object.assign(new Error(message), { code, statusCode });
}

function bearer(authorization) {
  const match = typeof authorization === 'string' && authorization.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/);
  return match?.[1] ?? null;
}

// A JWT access token is three base64url segments. It never matches bearer() (that pattern has no dots), so the two credential
// kinds cannot be confused. The length cap is checked before any parsing.
function jwtBearer(authorization) {
  const match = typeof authorization === 'string' && authorization.length <= 2100
    && authorization.match(/^Bearer ([A-Za-z0-9_-]{8,1000}\.[A-Za-z0-9_-]{8,1000}\.[A-Za-z0-9_-]{8,1000})$/);
  return match?.[1] ?? null;
}

function sameSecret(left, right) {
  if (!left || !right) return false;
  const leftDigest = createHash('sha256').update(left).digest();
  const rightDigest = createHash('sha256').update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export class TenantAccessService {
  constructor(database, { auth, authTokens = null, households, consents, env = {}, ...options }) {
    this.database = database;
    // Case, run and task rows carry sealed columns (ADR 0013 addendum D2); they are opened here so callers see plain values.
    this.crypto = resolveColumnCrypto(options);
    this.auth = auth;
    this.authTokens = authTokens;
    this.households = households;
    this.consents = consents;
    this.bootstrapToken = env.KNOWVIA_BOOTSTRAP_TOKEN ?? null;
    if (this.bootstrapToken && (typeof this.bootstrapToken !== 'string' || this.bootstrapToken.length < 32 || this.bootstrapToken.length > 256)) {
      throw new Error('KNOWVIA_BOOTSTRAP_TOKEN must contain 32 to 256 characters.');
    }
    // The identity-session credential is a separate secret: the bootstrap token must never open that route.
    this.identityToken = env.KNOWVIA_IDENTITY_TOKEN || null;
    if (this.identityToken && (typeof this.identityToken !== 'string' || this.identityToken.length < 32 || this.identityToken.length > 256)) {
      throw new Error('KNOWVIA_IDENTITY_TOKEN must contain 32 to 256 characters.');
    }
    if (this.identityToken && this.identityToken === this.bootstrapToken) {
      throw new Error('KNOWVIA_IDENTITY_TOKEN must differ from KNOWVIA_BOOTSTRAP_TOKEN.');
    }
  }

  get bootstrapConfigured() { return Boolean(this.bootstrapToken); }

  requireBootstrap(authorization) {
    if (!this.bootstrapToken) fail('AUTH_NOT_CONFIGURED', 'Household bootstrap authentication is not configured.', 503);
    if (!sameSecret(bearer(authorization), this.bootstrapToken)) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
    return true;
  }

  requireIdentityService(authorization) {
    if (!this.identityToken) fail('AUTH_NOT_CONFIGURED', 'Identity session authentication is not configured.', 503);
    if (!sameSecret(bearer(authorization), this.identityToken)) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
    return true;
  }

  // Every check below is async and awaited: an un-awaited check would return a
  // pending Promise (truthy) and let the request through. A rejected query
  // rejects the request (fail closed).
  // Two credential kinds: the opaque bearer session (scripts, tests; unchanged) and a JWT access token for a web session
  // (ADR 0027). A JWT principal is bound to one household; a bearer principal has householdId null and is not.
  async authenticate(authorization) {
    const jwt = jwtBearer(authorization);
    if (jwt) {
      if (!this.authTokens) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
      return await this.authTokens.authenticate(jwt);
    }
    const principal = await this.auth.authenticate(bearer(authorization));
    if (!principal) fail('AUTHENTICATION_REQUIRED', 'Valid authentication is required.', 401);
    return { ...principal, sessionKind: 'bearer', householdId: null };
  }

  // A web principal reaching a record by its own id (case, job, task) gets the same 404 as a missing record, so the
  // answer does not say whether another household owns that id. The 403 below is only for ids the caller names as a household.
  #foreign(principal, householdId) { return Boolean(principal.householdId) && principal.householdId !== householdId; }

  async requireHousehold(principal, householdId, options) {
    // Checked before any lookup, so a token for household A learns nothing about household B.
    if (principal.householdId && principal.householdId !== householdId) {
      fail('AUTH_HOUSEHOLD_MISMATCH', 'This session belongs to another household.', 403);
    }
    return await this.households.requireAccess(householdId, principal.adultId, options);
  }

  async requireCase(principal, caseId, options) {
    // options.tolerateUnreadable: erasure routes, which never use the stated estimate, may proceed when it cannot be decrypted.
    // A case erased through the deletion ledger is gone for every reader (S3).
    const row = await this.database.one(`SELECT * FROM service_cases WHERE id = ? AND NOT EXISTS (
      SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = service_cases.id AND deletion_state IN ('deleted', 'verified'))`, [caseId]);
    if (!row || this.#foreign(principal, row.household_id)) fail('CASE_NOT_FOUND', 'Case not found.', 404);
    // The household check comes before anything is decrypted, so a caller outside the household gets not-found whatever the
    // stored amount looks like (no existence oracle through a decryption error).
    await this.requireHousehold(principal, row.household_id, options);
    return openCaseRecord(this.crypto, row, { tolerateUnreadable: options?.tolerateUnreadable === true });
  }

  async requireRun(principal, runId) {
    const record = openWorkflowRun(this.crypto, await this.database.one(`SELECT workflow_runs.*, service_cases.household_id
      FROM workflow_runs JOIN service_cases ON service_cases.id = workflow_runs.case_id
      WHERE workflow_runs.id = ? AND NOT EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = service_cases.id AND deletion_state IN ('deleted', 'verified'))`, [runId]));
    if (!record || this.#foreign(principal, record.household_id)) fail('JOB_NOT_FOUND', 'Job not found.', 404);
    await this.requireHousehold(principal, record.household_id);
    return record;
  }

  async requireTask(principal, taskId) {
    const record = openWorkflowTask(this.crypto, await this.database.one(`SELECT workflow_tasks.*, service_cases.household_id
      FROM workflow_tasks
      JOIN workflow_runs ON workflow_runs.id = workflow_tasks.workflow_run_id
      JOIN service_cases ON service_cases.id = workflow_runs.case_id
      WHERE workflow_tasks.id = ? AND NOT EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = service_cases.id AND deletion_state IN ('deleted', 'verified'))`, [taskId]));
    if (!record || this.#foreign(principal, record.household_id)) fail('TASK_NOT_FOUND', 'Task not found.', 404);
    await this.requireHousehold(principal, record.household_id);
    return record;
  }

  async householdMatrix(principal, householdId) {
    const { household, role } = await this.requireHousehold(principal, householdId);
    const members = [];
    // Sequential: each member's checks are awaited before the next (no Promise
    // inside a .map callback, where a missed await would read as granted).
    for (const member of await this.households.listMembers(householdId)) {
      const canReadBirthDate = Boolean(member.adult_user_id) && (await this.consents.canAccessField({
        householdId,
        subjectAdultId: member.adult_user_id,
        viewerAdultId: principal.adultId,
        fieldKey: 'date_of_birth',
      })) === true;
      let latestCase = (await this.database.one(`SELECT id, status, trigger_type, updated_at
        FROM service_cases WHERE household_id = ? AND subject_member_id = ?
          AND NOT EXISTS (SELECT 1 FROM retention_records WHERE resource_type = 'case' AND resource_id = service_cases.id AND deletion_state IN ('deleted', 'verified'))
        ORDER BY updated_at DESC LIMIT 1`, [householdId, member.id])) ?? null;
      const caseSubjectAdultId = member.adult_user_id ?? (latestCase
        ? (await this.database.one('SELECT opened_by_adult_id FROM service_cases WHERE id = ?', [latestCase.id]))?.opened_by_adult_id
        : null);
      const canReadImmediateIssue = Boolean(latestCase && caseSubjectAdultId) && (await this.consents.canAccessResource({
        householdId,
        subjectAdultId: caseSubjectAdultId,
        viewerAdultId: principal.adultId,
        purpose: 'coverage_reconstruction',
        resourceType: 'case',
        resourceId: latestCase.id,
        action: 'read',
        dataCategory: 'case_summary',
      })) === true;
      const policyCount = (await this.database.one(`SELECT count(*) AS count
        FROM policy_members JOIN policies ON policies.id = policy_members.policy_id
        WHERE household_member_id = ? AND policies.household_id = ?`, [member.id, householdId])).count;
      // An erasure can commit between the reads above and this point: look the case up in the ledger once more before it is
      // put in the response, so an erased case is never returned.
      if (latestCase && await this.database.one(`SELECT 1 AS found FROM retention_records WHERE resource_type = 'case' AND resource_id = ? AND deletion_state IN ('deleted', 'verified')`, [latestCase.id])) latestCase = null;
      members.push({
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
        immediateIssue: canReadImmediateIssue && latestCase
          ? { caseId: latestCase.id, status: latestCase.status, triggerType: latestCase.trigger_type }
          : null,
      });
    }
    return { household, viewerRole: role.role, members };
  }
}
