import { readBody } from '../http/request.js';
import { handlePolicyRoute } from './policy-routes.js';
import { validateSchema } from '../../backend/database/index.js';
import { createCoverageAnalysisPort } from '../../backend/services/index.js';
import { COVERAGE_ANALYSIS_WORKFLOW } from '../../modules/coverage-analysis/index.js';
import { createPersistentCoverageAnalysisService } from '../../modules/coverage-analysis/index.js';
import {
  READ_FIELDS, analysisJobDto, analysisTaskDto, auditSummaryDto, caseSummaryDto,
  createReadResponsePolicy, sourcePackDto,
} from '../policies/read-response-policy.js';

const AGENT_NAMES = Object.freeze({
  profile: 'profile-agent',
  group: 'group-health-agent',
  personal: 'personal-health-agent',
  coverage: 'coverage-orchestrator',
  documentIdentity: 'document-identity-worker',
  continuity: 'continuity-worker',
  enrolment: 'enrolment-worker',
  financialRules: 'financial-rules-worker',
  benefits: 'benefits-worker',
  exclusions: 'exclusions-worker',
  hospitalAccess: 'hospital-access-worker',
  claimsProcess: 'claims-process-worker',
  renewalChange: 'renewal-change-worker',
  serviceResearch: 'service-research-worker',
  decision: 'decision-agent',
  householdAction: 'household-action-worker',
  evidence: 'evidence-reviewer',
  privacy: 'privacy-reviewer',
  safety: 'safety-reviewer',
  questions: 'coordination-question-agent',
  primary: 'primary-agent',
  release: 'release-gate',
});

// One workflow definition serves persisted analysis and fixture execution.
// Model eligibility remains separately constrained by responsibility-matrix.js.
const ANALYSIS_DAG = Object.freeze(COVERAGE_ANALYSIS_WORKFLOW.tasks.map(task => Object.freeze({
  key: task.key,
  agentName: AGENT_NAMES[task.key],
  taskKind: task.kind,
  owner: task.owner,
  modelTask: task.modelTask,
  inputSchema: task.inputSchema,
  outputSchema: task.outputSchema,
  dependsOn: [...task.dependsOn],
})));

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
    FIELD_ACCESS_REQUIRED: 403,
    STALE_REVISION: 409,
    INVALID_CASE_TRANSITION: 409,
    IDEMPOTENCY_CONFLICT: 409,
    CASE_NOT_READY_FOR_ANALYSIS: 409,
    ACTIVE_CONSENT_REQUIRED: 403,
    DUPLICATE_DOCUMENT: 409,
    DOCUMENT_VERSION_EXISTS: 409,
    FILE_TOO_LARGE: 413,
    MIME_MISMATCH: 415,
    EXTENSION_MISMATCH: 415,
    ENCRYPTION_KEY_REQUIRED: 503,
  };
  const code = error.code || 'BACKEND_REQUEST_FAILED';
  const status = error.statusCode || statusByCode[code] || (/constraint/i.test(error.message) ? 409 : 400);
  return { status, body: { error: { code, message: error.message } } };
}

function job(database, runId) {
  const run = database.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId);
  if (!run) return null;
  const tasks = database.prepare('SELECT * FROM workflow_tasks WHERE workflow_run_id = ? ORDER BY created_at, id').all(runId);
  return analysisJobDto(run, tasks, ANALYSIS_DAG);
}

function createAnalysisRun({ req, database, services, caseId, body, config, liveRegistryFactory }) {
  const activeRuns = database.prepare(`SELECT count(*) AS count FROM workflow_runs
    WHERE case_id = ? AND status IN ('queued', 'running')`).get(caseId).count;
  if (activeRuns >= config.maxRunsPerCase) {
    const error = new Error('Active analysis capacity reached for this case.');
    error.code = 'ANALYSIS_CAPACITY_REACHED';
    error.statusCode = 429;
    throw error;
  }
  const key = idempotencyKey(req);
  const executionMode = body.executionMode ?? 'fixture';
  if (executionMode === 'live' && body.modelPermission !== true) {
    const error = new Error('Live analysis requires explicit modelPermission=true.');
    error.code = 'MODEL_PERMISSION_REQUIRED';
    error.statusCode = 403;
    throw error;
  }
  const analysis = createPersistentCoverageAnalysisService({
    port: createCoverageAnalysisPort({ database, services }),
    ...(executionMode === 'live' ? { liveRegistry: liveRegistryFactory?.() } : {}),
  });
  const result = analysis.createAnalysisRun({
    caseId,
    consentGrantId: requiredString(body.consentGrantId, 'consentGrantId'),
    executionMode,
    modelPermission: body.modelPermission === true,
    idempotencyKey: key,
    fixtureVariant: body.fixtureVariant ?? 'standard',
  });
  return Promise.resolve(result).then(async ({ created, notFound, job: run }) => {
    if (notFound) return { status: 404, body: { error: { code: 'CASE_NOT_FOUND', message: 'Case not found.' } } };
    const settled = created ? await analysis.runUntilSettled(run.id) : run;
    return {
      status: created ? 202 : 200,
      body: {
        ...job(database, settled.id),
        dispatchStatus: created ? `${executionMode}_completed` : 'idempotent_existing_run',
        externalProviderCalls: executionMode === 'live' && created,
      },
    };
  });
}

export async function handleV1BackendRoute({ req, url, database, services, integrations, config, liveRegistryFactory, policy = null }) {
  if (!url.pathname.startsWith('/api/v1/')) return null;
  try {
    if (req.method === 'GET' && ['/api/v1/health', '/api/v1/live'].includes(url.pathname)) {
      return {
        status: 200,
        body: { status: 'ok', service: 'knowvia-api' },
      };
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/ready') {
      const schema = validateSchema(database);
      const ready = schema.valid && services.access.bootstrapConfigured;
      return { status: ready ? 200 : 503, body: {
        status: ready ? 'ready' : 'not_ready',
        checks: { database: schema.valid, authentication: services.access.bootstrapConfigured },
        database: schema,
        externalProviderCalls: false,
      } };
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/households') {
      services.access.requireBootstrap(req.headers.authorization);
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
      const session = services.auth.issueSession({ adultUserId: adult.id });
      return { status: 201, body: { household, owner: adult, ownerMember, session } };
    }

    const principal = services.access.authenticate(req.headers.authorization);
    const policyResponse = await handlePolicyRoute({ req, url, policy, principal });
    if (policyResponse) return policyResponse;
    const responses = createReadResponsePolicy({ database, consents: services.consents });

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
    if (req.method === 'POST' && url.pathname === '/api/v1/sessions/current/revoke') {
      services.auth.revokeSession({ sessionId: principal.sessionId, adultUserId: principal.adultId });
      return { status: 200, body: { status: 'revoked' } };
    }
    const householdMatch = url.pathname.match(/^\/api\/v1\/households\/([^/]+)$/);
    if (req.method === 'GET' && householdMatch) {
      return { status: 200, body: services.access.householdMatrix(principal, householdMatch[1]) };
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/consents') {
      const body = await readBody(req);
      const householdId = requiredString(body.householdId, 'householdId');
      const subjectAdultId = requiredString(body.subjectAdultId, 'subjectAdultId');
      services.access.requireHousehold(principal, householdId, { write: true });
      if (subjectAdultId !== principal.adultId) {
        const error = new Error('Only the subject adult may grant field and processing access.');
        error.code = 'CONSENT_SUBJECT_REQUIRED';
        error.statusCode = 403;
        throw error;
      }
      const grant = services.consents.grant({
        householdId,
        subjectAdultId,
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
      const existing = services.consents.get(revokeMatch[1]);
      if (!existing || existing.subject_adult_id !== principal.adultId) {
        return { status: 404, body: { error: { code: 'CONSENT_NOT_FOUND', message: 'Consent grant not found.' } } };
      }
      services.access.requireHousehold(principal, existing.household_id, { write: true });
      return { status: 200, body: services.consents.revoke({
        grantId: revokeMatch[1],
        revokedByAdultId: principal.adultId,
        reason: body.reason ?? null,
      }) };
    }
    const permissionMatch = url.pathname.match(/^\/api\/v1\/households\/([^/]+)\/members\/([^/]+)\/fields\/([^/]+)\/access$/);
    if (req.method === 'GET' && permissionMatch) {
      services.access.requireHousehold(principal, permissionMatch[1]);
      const allowed = services.consents.canAccessField({
        householdId: permissionMatch[1],
        subjectAdultId: permissionMatch[2],
        viewerAdultId: principal.adultId,
        fieldKey: decodeURIComponent(permissionMatch[3]),
      });
      return { status: 200, body: { allowed } };
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/cases') {
      const body = await readBody(req);
      const householdId = requiredString(body.householdId, 'householdId');
      services.access.requireHousehold(principal, householdId, { write: true });
      const activeCases = database.prepare(`SELECT count(*) AS count FROM service_cases
        WHERE status NOT IN ('closed', 'revoked')`).get().count;
      if (activeCases >= config.maxCases) {
        const error = new Error('Active case capacity reached.');
        error.code = 'CASE_CAPACITY_REACHED';
        error.statusCode = 429;
        throw error;
      }
      const record = services.cases.create({
        householdId,
        subjectMemberId: body.subjectMemberId ?? null,
        openedByAdultId: principal.adultId,
        triggerType: requiredString(body.triggerType, 'triggerType'),
        statedEstimateMinor: body.statedEstimateMinor ?? null,
        currency: body.currency ?? null,
      });
      return { status: 201, body: record };
    }
    const caseMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)$/);
    if (req.method === 'GET' && caseMatch) {
      const caseRecord = services.access.requireCase(principal, caseMatch[1]);
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.caseSummary });
      return { status: 200, body: caseSummaryDto(caseRecord) };
    }
    const sourcePackMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/source-pack$/);
    if (req.method === 'GET' && sourcePackMatch) {
      const caseRecord = services.access.requireCase(principal, sourcePackMatch[1]);
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.sourcePack });
      const sources = database.prepare(`SELECT id, document_kind,
          mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at
        FROM document_uploads WHERE case_id = ? AND household_id = ? AND lifecycle_state <> 'deleted'
        ORDER BY uploaded_at, id`).all(caseRecord.id, caseRecord.household_id);
      const workflows = database.prepare(`SELECT id, workflow_name, workflow_version, execution_mode,
          status, terminal_reason, created_at, finished_at
        FROM workflow_runs WHERE case_id = ? ORDER BY created_at, id`).all(caseRecord.id);
      return { status: 200, body: sourcePackDto(caseRecord.id, sources, workflows) };
    }
    const transitionMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/transitions$/);
    if (req.method === 'POST' && transitionMatch) {
      const body = await readBody(req);
      services.access.requireCase(principal, transitionMatch[1], { write: true });
      return { status: 200, body: services.cases.transition(
        transitionMatch[1],
        requiredString(body.toStatus, 'toStatus'),
        {
          expectedRevision: requiredString(body.expectedRevision, 'expectedRevision'),
          actorType: 'adult_user',
          actorId: principal.adultId,
          payload: body.payload ?? {},
        },
      ) };
    }
    const runMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/analysis-runs$/);
    if (req.method === 'POST' && runMatch) {
      services.access.requireCase(principal, runMatch[1], { write: true });
      return createAnalysisRun({ req, database, services, caseId: runMatch[1], body: await readBody(req), config, liveRegistryFactory });
    }
    const auditMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/audit-events$/);
    if (req.method === 'GET' && auditMatch) {
      const caseRecord = services.access.requireCase(principal, auditMatch[1]);
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.auditSummary });
      return { status: 200, body: auditSummaryDto(services.audit.listForCase(auditMatch[1])) };
    }
    const jobMatch = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      const run = services.access.requireRun(principal, jobMatch[1]);
      const caseRecord = services.access.requireCase(principal, run.case_id);
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.analysisSummary });
      return { status: 200, body: job(database, jobMatch[1]) };
    }
    const taskMatch = url.pathname.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (req.method === 'GET' && taskMatch) {
      const task = services.access.requireTask(principal, taskMatch[1]);
      const run = services.access.requireRun(principal, task.workflow_run_id);
      const caseRecord = services.access.requireCase(principal, run.case_id);
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.analysisSummary });
      return { status: 200, body: analysisTaskDto(task) };
    }
    return { status: 404, body: { error: { code: 'ROUTE_NOT_FOUND', message: 'Versioned backend route not found.' } } };
  } catch (error) {
    return errorResponse(error);
  }
}

export { ANALYSIS_DAG };
