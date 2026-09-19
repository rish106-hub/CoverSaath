import { createHash } from 'node:crypto';
import { readBody } from '../http/request.js';
import { validateSchema } from '../../backend/database/index.js';

const ANALYSIS_DAG = Object.freeze([
  { key: 'profile', agentName: 'profile-agent', taskKind: 'profile_intake', dependsOn: [] },
  { key: 'group', agentName: 'group-health-agent', taskKind: 'group_cover_analysis', dependsOn: [] },
  { key: 'personal', agentName: 'personal-health-agent', taskKind: 'personal_cover_analysis', dependsOn: [] },
  { key: 'coverage', agentName: 'coverage-orchestrator', taskKind: 'coverage_graph', dependsOn: ['profile', 'group', 'personal'] },
  { key: 'decision', agentName: 'decision-agent', taskKind: 'deterministic_classification', dependsOn: ['coverage'] },
  { key: 'evidence', agentName: 'evidence-reviewer', taskKind: 'evidence_review', dependsOn: ['decision'] },
  { key: 'privacy', agentName: 'privacy-reviewer', taskKind: 'privacy_review', dependsOn: ['decision'] },
  { key: 'safety', agentName: 'safety-reviewer', taskKind: 'safety_review', dependsOn: ['decision'] },
  { key: 'primary', agentName: 'primary-agent', taskKind: 'bounded_synthesis', dependsOn: ['evidence', 'privacy', 'safety'] },
  { key: 'release', agentName: 'release-gate', taskKind: 'deterministic_release_gate', dependsOn: ['primary'] },
]);

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function badRequest(message, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  throw error;
}

function requiredString(value, field, { max = 200 } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) badRequest(`${field} is required.`);
  return value.trim();
}

function idempotencyKey(req) {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 200) {
    badRequest('A stable Idempotency-Key header between 8 and 200 characters is required.', 'IDEMPOTENCY_KEY_REQUIRED');
  }
  return key;
}

function errorResponse(error) {
  const statusByCode = {
    CONSENT_REQUIRED: 403,
    CONSENT_SCOPE_REQUIRED: 403,
    STALE_REVISION: 409,
    INVALID_CASE_TRANSITION: 409,
    IDEMPOTENCY_CONFLICT: 409,
    CASE_NOT_READY_FOR_ANALYSIS: 409,
  };
  const code = error.code || 'BACKEND_REQUEST_FAILED';
  const status = error.statusCode || statusByCode[code] || (/constraint/i.test(error.message) ? 409 : 400);
  return { status, body: { error: { code, message: error.message } } };
}

function job(database, runId) {
  const run = database.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const tasks = database.prepare('SELECT * FROM workflow_tasks WHERE workflow_run_id = ? ORDER BY created_at, id').all(runId);
  return { ...run, tasks, dag: ANALYSIS_DAG };
}

function createAnalysisRun({ req, database, services, caseId, body }) {
  const key = idempotencyKey(req);
  const record = services.cases.get(caseId);
  if (!record) return { status: 404, body: { error: { code: 'CASE_NOT_FOUND', message: 'Case not found.' } } };
  if (record.status !== 'processing') {
    const error = new Error('Case must move through collecting to processing before analysis is queued.');
    error.code = 'CASE_NOT_READY_FOR_ANALYSIS';
    throw error;
  }
  const consentGrantId = requiredString(body.consentGrantId, 'consentGrantId');
  services.consents.requireActive(consentGrantId, {
    subjectAdultId: record.opened_by_adult_id,
    purpose: 'coverage_reconstruction',
    resourceType: 'case',
    resourceId: caseId,
    action: 'derive',
    dataCategory: 'insurance_document',
  });
  const executionMode = body.executionMode ?? 'fixture';
  if (!['fixture', 'live'].includes(executionMode)) badRequest('executionMode must be fixture or live.');

  const request = { caseId, caseRevision: record.revision, consentGrantId, executionMode, workflowVersion: 'v1' };
  const requestDigest = digest(request);
  const existing = database.prepare(`SELECT request_digest, response_json FROM idempotency_keys
    WHERE scope = 'analysis_run' AND idempotency_key = ?`).get(key);
  if (existing) {
    if (existing.request_digest !== requestDigest) {
      const error = new Error('Idempotency key was reused with a different request.');
      error.code = 'IDEMPOTENCY_CONFLICT';
      throw error;
    }
    return { status: 200, body: JSON.parse(existing.response_json) };
  }

  const run = services.workflows.createRun({
    caseId,
    workflowName: 'coverage-reconstruction',
    workflowVersion: 'v1',
    executionMode,
    input: request,
  });
  const tasksByKey = {};
  for (const definition of ANALYSIS_DAG) {
    const parentKey = definition.dependsOn.length === 1 ? definition.dependsOn[0] : null;
    tasksByKey[definition.key] = services.workflows.enqueueTask({
      runId: run.id,
      agentName: definition.agentName,
      taskKind: definition.taskKind,
      input: { caseId, caseRevision: record.revision, consentGrantId, dependsOn: definition.dependsOn },
      parentTaskId: parentKey ? tasksByKey[parentKey].id : null,
      idempotencyKey: `${key}:${definition.key}`,
    });
  }
  const response = {
    ...job(database, run.id),
    dispatchStatus: 'queued_not_dispatched',
    externalProviderCalls: false,
  };
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  database.prepare(`INSERT INTO idempotency_keys
    (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
    VALUES ('analysis_run', ?, ?, 201, ?, ?, ?)`)
    .run(key, requestDigest, JSON.stringify(response), expiresAt, now);
  services.audit.append({
    householdId: record.household_id,
    caseId,
    actorType: 'system',
    actorId: 'local-backend',
    action: 'analysis.queued',
    resourceType: 'workflow_run',
    resourceId: run.id,
    payload: { taskCount: ANALYSIS_DAG.length, externalProviderCalls: false },
  });
  return { status: 201, body: response };
}

export async function handleV1BackendRoute({ req, url, database, services, integrations }) {
  if (!url.pathname.startsWith('/api/v1/')) return null;
  try {
    if (req.method === 'GET' && url.pathname === '/api/v1/health') {
      return {
        status: 200,
        body: {
          status: 'ok',
          database: validateSchema(database),
          storage: 'sqlite',
          documentIntake: 'manual_upload_only',
          hrms: { available: false, status: 'on_hold' },
          externalProviderCalls: false,
        },
      };
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/integrations') {
      return {
        status: 200,
        body: {
          providers: Object.fromEntries(Object.entries(integrations).map(([name, provider]) => [name, provider.health()])),
          hrms: { status: 'on_hold', intake: 'manual_upload_only' },
          note: 'Configuration status only. This endpoint makes no provider request.',
        },
      };
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/households') {
      const body = await readBody(req);
      const adult = services.households.createAdult({
        displayName: requiredString(body.owner?.displayName, 'owner.displayName'),
        contactEmail: body.owner?.contactEmail ?? null,
        contactPhone: body.owner?.contactPhone ?? null,
        locale: body.owner?.locale ?? 'en-IN',
      });
      const household = services.households.createHousehold({
        displayName: requiredString(body.displayName, 'displayName'),
        ownerAdultId: adult.id,
      });
      const ownerMember = services.households.addMember({
        householdId: household.id,
        adultUserId: adult.id,
        displayName: adult.display_name,
      });
      return { status: 201, body: { household, owner: adult, ownerMember } };
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/consents') {
      const body = await readBody(req);
      const grant = services.consents.grant({
        householdId: requiredString(body.householdId, 'householdId'),
        subjectAdultId: requiredString(body.subjectAdultId, 'subjectAdultId'),
        purpose: requiredString(body.purpose, 'purpose'),
        noticeVersion: body.noticeVersion ?? 'v1',
        evidenceMethod: body.evidenceMethod ?? 'typed',
        expiresAt: body.expiresAt ?? null,
        scopes: Array.isArray(body.scopes) ? body.scopes : [],
      });
      return { status: 201, body: grant };
    }
    const revokeMatch = url.pathname.match(/^\/api\/v1\/consents\/([^/]+)\/revoke$/);
    if (req.method === 'POST' && revokeMatch) {
      const body = await readBody(req);
      return { status: 200, body: services.consents.revoke({
        grantId: revokeMatch[1],
        revokedByAdultId: requiredString(body.revokedByAdultId, 'revokedByAdultId'),
        reason: body.reason ?? null,
      }) };
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/cases') {
      const body = await readBody(req);
      const record = services.cases.create({
        householdId: requiredString(body.householdId, 'householdId'),
        subjectMemberId: body.subjectMemberId ?? null,
        openedByAdultId: requiredString(body.openedByAdultId, 'openedByAdultId'),
        triggerType: requiredString(body.triggerType, 'triggerType'),
        statedEstimateMinor: body.statedEstimateMinor ?? null,
        currency: body.currency ?? null,
      });
      return { status: 201, body: record };
    }
    const caseMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)$/);
    if (req.method === 'GET' && caseMatch) {
      const record = services.cases.get(caseMatch[1]);
      return record
        ? { status: 200, body: record }
        : { status: 404, body: { error: { code: 'CASE_NOT_FOUND', message: 'Case not found.' } } };
    }
    const transitionMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/transitions$/);
    if (req.method === 'POST' && transitionMatch) {
      const body = await readBody(req);
      return { status: 200, body: services.cases.transition(
        transitionMatch[1],
        requiredString(body.toStatus, 'toStatus'),
        {
          expectedRevision: requiredString(body.expectedRevision, 'expectedRevision'),
          actorType: body.actorType ?? 'adult_user',
          actorId: body.actorId ?? 'local-user',
          payload: body.payload ?? {},
        },
      ) };
    }
    const runMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/analysis-runs$/);
    if (req.method === 'POST' && runMatch) {
      return createAnalysisRun({ req, database, services, caseId: runMatch[1], body: await readBody(req) });
    }
    const auditMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/audit-events$/);
    if (req.method === 'GET' && auditMatch) {
      if (!services.cases.get(auditMatch[1])) return { status: 404, body: { error: { code: 'CASE_NOT_FOUND', message: 'Case not found.' } } };
      return { status: 200, body: { events: services.audit.listForCase(auditMatch[1]) } };
    }
    const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const record = job(database, jobMatch[1]);
      return record
        ? { status: 200, body: record }
        : { status: 404, body: { error: { code: 'JOB_NOT_FOUND', message: 'Job not found.' } } };
    }
    const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = database.prepare('SELECT * FROM workflow_tasks WHERE id = ?').get(taskMatch[1]);
      return task
        ? { status: 200, body: task }
        : { status: 404, body: { error: { code: 'TASK_NOT_FOUND', message: 'Task not found.' } } };
    }
    return { status: 404, body: { error: { code: 'ROUTE_NOT_FOUND', message: 'Versioned backend route not found.' } } };
  } catch (error) {
    return errorResponse(error);
  }
}

export { ANALYSIS_DAG };
