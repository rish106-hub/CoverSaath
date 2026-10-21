import { readBody } from '../http/request.js';
import { isLoopbackRequest, readBinaryBody } from '../../shared/http/index.js';
import { MAX_DOCUMENT_BYTES } from '../../features/input/index.js';
import { toHandoff } from '../../features/decision-catalogue/index.js';
import { documentDto } from '../../backend/services/index.js';
import { validateSchema } from '../../backend/database/index.js';
import { createCoverageAnalysisPort } from '../../backend/services/index.js';
import { COVERAGE_ANALYSIS_WORKFLOW } from '../../features/coverage-analysis/index.js';
import { ANALYSIS_ERROR_CODES } from '../../contracts/error-codes.js';
import { createPersistentCoverageAnalysisService } from '../../features/coverage-analysis/index.js';
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

export function errorResponse(error) {
  const statusByCode = {
    CONSENT_REQUIRED: 403,
    CONSENT_SCOPE_REQUIRED: 403,
    FIELD_ACCESS_REQUIRED: 403,
    STALE_REVISION: 409,
    INVALID_CASE_TRANSITION: 409,
    IDEMPOTENCY_CONFLICT: 409,
    CASE_NOT_READY_FOR_ANALYSIS: 409,
  };
  // Only application codes carry deliberate, client-safe messages: UPPER_SNAKE with at least one
  // underscore, not a Node/driver ERR_* code, and not an operating-system error (ENOENT,
  // ECONNREFUSED, ...), which carries syscall/errno. Uncoded, runtime, driver and system errors
  // are internal: their text, SQL, paths and values never leave the server.
  const deliberate = typeof error.code === 'string'
    && /^[A-Z][A-Z0-9]*_[A-Z0-9_]{1,78}$/.test(error.code)
    && !error.code.startsWith('ERR_')
    && error.syscall === undefined
    && typeof error.errno !== 'number';
  const code = deliberate ? error.code : 'BACKEND_REQUEST_FAILED';
  const status = error.statusCode || (deliberate && error.status) || statusByCode[code]
    || ANALYSIS_ERROR_CODES[code]?.httpStatus || (/constraint/i.test(error.message) ? 409 : 400);
  const message = deliberate ? error.message : 'The request could not be completed.';
  return { status, body: { error: { code, message } } };
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

// Document routes answer a missing case and another household's case identically.
function requireDocumentCase(services, principal, caseId, options) {
  try {
    return services.access.requireCase(principal, caseId, options);
  } catch (error) {
    if (['CASE_NOT_FOUND', 'HOUSEHOLD_NOT_FOUND'].includes(error.code)) {
      throw Object.assign(new Error('Case not found.'), { code: 'CASE_NOT_FOUND', statusCode: 404 });
    }
    throw error;
  }
}

function documentNotFound() {
  const error = new Error('Document not found.');
  error.code = 'DOCUMENT_NOT_FOUND';
  error.statusCode = 404;
  return error;
}

function ocrJobDto(job) {
  return {
    id: job.id,
    documentId: job.documentUploadId,
    provider: job.provider,
    status: job.status,
    errorCode: job.errorCode,
    requestedAt: job.requestedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    pageCount: Array.isArray(job.result?.pages) ? job.result.pages.length : null,
    outputContractVersion: job.contractVersion,
  };
}

function requireOwnedDocument({ services, documentUploads, principal, documentId, write = false }) {
  const record = documentUploads?.getDocument(documentId);
  if (!record?.caseId) throw documentNotFound();
  try {
    const caseRecord = services.access.requireCase(principal, record.caseId, { write });
    if (caseRecord.household_id !== record.householdId) throw documentNotFound();
    return record;
  } catch (error) {
    if (['CASE_NOT_FOUND', 'HOUSEHOLD_NOT_FOUND'].includes(error.code)) throw documentNotFound();
    throw error;
  }
}

export async function handleV1BackendRoute({ req, url, database, services, integrations, config, liveRegistryFactory, documentUploads, getOcrService, getStructuringService, getEvidenceService, getCatalogueService, getHouseholdPreviewService }) {
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
      const body = {
        status: ready ? 'ready' : 'not_ready',
        checks: { database: schema.valid, authentication: services.access.bootstrapConfigured },
      };
      // Schema detail (missing tables, triggers, migration count) is for local operators only.
      if (isLoopbackRequest(req)) Object.assign(body, { database: schema, externalProviderCalls: false });
      return { status: ready ? 200 : 503, body };
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
        grantedToActor: body.grantedToActor === undefined ? 'knowvia-local' : requiredString(body.grantedToActor, 'grantedToActor'),
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
    // Evidence-first questions (ADR 0008): a cited conditional answer, never a coverage verdict. The case is
    // looked up with the document-route rule: a missing and a foreign-household case answer the same 404.
    const questionsMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/questions(?:\/([^/]+))?$/);
    if (questionsMatch) {
      const caseRecord = requireDocumentCase(services, principal, questionsMatch[1], { write: req.method === 'POST' });
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.sourcePack });
      if (req.method === 'POST' && !questionsMatch[2]) {
        const body = await readBody(req);
        const stored = await getEvidenceService().ask({
          caseRecord,
          subjectAdultId: principal.adultId,
          question: requiredString(body.question, 'question', { max: 2000 }),
          consentGrantId: requiredString(body.consentGrantId, 'consentGrantId'),
          idempotencyKey: idempotencyKey(req),
          documentIds: body.documentIds,
        });
        return { status: stored.replayed ? 200 : 201, body: { answerId: stored.answerId, replayed: stored.replayed, answer: stored.answer } };
      }
      if (req.method === 'GET' && questionsMatch[2]) {
        const stored = getEvidenceService().get({ caseRecord, answerId: questionsMatch[2] });
        return { status: 200, body: { answerId: stored.answerId, current: stored.current, answer: stored.answer } };
      }
    }
    // Authenticated review of one catalogue fact (ADR 0009 part 2). Reviewer strength comes from a stored grant, never from
    // the request body. The caller names a fact; the server rebuilds it from live clauses. Idempotent, audited, no model call.
    const reviewMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/decision-catalogue\/reviews$/);
    if (req.method === 'POST' && reviewMatch) {
      // A household confirmer needs the same source-pack field access as the read route; an independent reviewer is
      // gated by the (default off) CATALOGUE_INDEPENDENT_REVIEW_ENABLED switch inside the service.
      const reviewCase = getCatalogueService().confirmerCase(principal, reviewMatch[1]);
      if (reviewCase.kind === 'household_confirmer') responses.requireCaseField({ principal, caseRecord: reviewCase.caseRecord, field: READ_FIELDS.sourcePack });
      const body = await readBody(req);
      const result = getCatalogueService().record({
        principal, caseId: reviewMatch[1],
        answerId: requiredString(body.answerId, 'answerId'), factId: requiredString(body.factId, 'factId', { max: 128 }),
        decision: requiredString(body.decision, 'decision', { max: 20 }), reasonCode: requiredString(body.reasonCode, 'reasonCode', { max: 40 }),
        attestedSourceType: body.attestedSourceType ?? null, attestsPolicyAssociation: body.attestsPolicyAssociation ?? false,
        idempotencyKey: idempotencyKey(req), asOf: body.asOf ?? null, memberId: body.memberId ?? null,
      });
      return { status: result.replayed ? 200 : 201, body: result };
    }
    // The household owner designates a household adult as a confirmer (self confirmation, never `proven`). Independent
    // reviewers are granted by operator tooling only: there is deliberately no route for them.
    const confirmerMatch = url.pathname.match(/^\/api\/v1\/households\/([^/]+)\/catalogue-reviewers$/);
    if (req.method === 'POST' && confirmerMatch) {
      services.access.requireHousehold(principal, confirmerMatch[1], { write: true });
      const body = await readBody(req);
      const grant = services.catalogueReviews.grantHouseholdConfirmer({
        householdId: confirmerMatch[1], adultUserId: requiredString(body.adultUserId, 'adultUserId', { max: 128 }), grantedByAdultId: principal.adultId,
      });
      return { status: 201, body: { grantId: grant.id, kind: grant.kind, status: grant.status } };
    }
    // Curated insurer wording (trusted-source workflow). Read only: the caller is identified by the session and the role comes
    // from a stored, expiring grant re-read on every request. Collection, check, publication and every role change are operator
    // tooling (scripts/curated-source.mjs, ADR 0010): check and publish need an Ed25519 signature by the checker's registered
    // key, which no session can supply, so there is deliberately no approval route.
    const curatedMatch = url.pathname.match(/^\/api\/v1\/curated-products\/([^/]+)$/);
    if (req.method === 'GET' && curatedMatch) return { status: 200, body: services.curatedProducts.get({ adultId: principal.adultId, submissionId: curatedMatch[1] }) };
    // Decision catalogue (Block 3): facts derived on read from one stored answer. No model call and no write.
    // Gated by the source-pack field, same as /questions. Whether that consent purpose is right for coverage facts is pending legal review.
    const catalogueMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/decision-catalogue$/);
    if (req.method === 'GET' && catalogueMatch) {
      // An independent reviewer holds a grant, not a household role: they read the catalogue of the cases they review.
      const independent = getCatalogueService().independentReviewerCase(principal, catalogueMatch[1]);
      let caseRecord = independent?.caseRecord ?? null;
      if (!caseRecord) {
        caseRecord = requireDocumentCase(services, principal, catalogueMatch[1], { write: false });
        responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.sourcePack });
      }
      const built = getCatalogueService().build({
        caseRecord, answerId: url.searchParams.get('answerId'),
        asOf: url.searchParams.get('asOf'), memberId: url.searchParams.get('memberId'), documentsUntil: independent?.documentsUntil ?? null,
      });
      // ?format=handoff returns the flat Block 4 view of the same catalogue (decision-handoff/v1).
      return { status: 200, body: url.searchParams.get('format') === 'handoff' ? toHandoff(built) : built };
    }
    // Household coverage preview (Block 4): read-only computation over authorised Block 3 evidence. POST because the
    // body carries bounded scenario details and several source references. Nothing is stored and no provider is called.
    const previewMatch = url.pathname.match(/^\/api\/v1\/households\/([^/]+)\/coverage-preview$/);
    if (req.method === 'POST' && previewMatch) {
      const body = await readBody(req);
      return {
        status: 200,
        body: getHouseholdPreviewService().preview({
          principal, householdId: previewMatch[1], body,
          authorizeCase: caseRecord => responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.sourcePack }),
        }),
      };
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
    const documentsMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/documents$/);
    const deletionInventoryMatch = url.pathname.match(/^\/api\/v1\/cases\/([^/]+)\/documents\/deletion-inventory$/);
    if (req.method === 'GET' && deletionInventoryMatch) {
      // Erasure discovery is household-authorised but not consent-gated. Otherwise an expired or
      // revoked processing grant could remove the only UI path to delete the stored document.
      const caseRecord = requireDocumentCase(services, principal, deletionInventoryMatch[1]);
      services.access.requireHousehold(principal, caseRecord.household_id);
      const roles = services.households.listActiveRoles(caseRecord.household_id, principal.adultId).map(item => item.role);
      const documents = documentUploads.listForDeletion(caseRecord, {
        actorAdultId: principal.adultId, roles,
      }).documents.map(document => ({
        id: document.id,
        documentKind: document.documentKind,
        byteSize: document.byteSize,
        status: document.status,
        statusLabel: document.statusLabel,
        uploadedAt: document.uploadedAt,
      }));
      return { status: 200, body: { caseId: caseRecord.id, documents } };
    }
    if (req.method === 'POST' && documentsMatch) {
      // Authorise and check configuration before reading a single body byte.
      const caseRecord = requireDocumentCase(services, principal, documentsMatch[1], { write: true });
      if (!documentUploads?.configured) {
        const error = new Error('Document storage is not configured.');
        error.code = 'DOCUMENT_STORAGE_NOT_CONFIGURED';
        error.statusCode = 503;
        throw error;
      }
      const bytes = await readBinaryBody(req, { contentType: 'application/pdf', limitBytes: MAX_DOCUMENT_BYTES });
      return await documentUploads.upload({ principal, caseRecord, headers: req.headers, bytes });
    }
    if (req.method === 'GET' && documentsMatch) {
      const caseRecord = requireDocumentCase(services, principal, documentsMatch[1]);
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.sourcePack });
      return { status: 200, body: documentUploads.listForCase(caseRecord) };
    }
    const documentMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)$/);
    const documentOcrMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)\/ocr-jobs$/);
    if (req.method === 'POST' && documentOcrMatch) {
      const record = requireOwnedDocument({ services, documentUploads, principal, documentId: documentOcrMatch[1], write: true });
      const body = await readBody(req);
      const job = await getOcrService().start({
        documentId: record.id,
        retryFailed: body.retryFailed === true,
        // Explicit, paid blocks upgrade for a knowvia.ocr.v1 document; refused unless acknowledged.
        mode: body.mode ?? 'standard',
        acknowledgeProviderCharge: body.acknowledgeProviderCharge === true,
        authorization: {
          authorized: true,
          consentGrantId: requiredString(body.consentGrantId, 'consentGrantId'),
          requestedByAdultId: principal.adultId,
          purpose: 'document_processing',
          recipient: 'sarvam',
          // Every uploadable kind is a printed insurer document. Measured on a real policy (2026-10-19):
          // `printed` returned Sarvam's tagged blocks and tables; `mixed` returned one untagged block per page.
          settings: { language: body.language ?? 'en-IN', contentType: body.contentType ?? 'printed' },
        },
      });
      return { status: ['succeeded', 'failed', 'cancelled'].includes(job.status) ? 200 : 202, body: { job: ocrJobDto(job) } };
    }
    const ocrRefreshMatch = url.pathname.match(/^\/api\/v1\/ocr-jobs\/([^/]+)\/refresh$/);
    if (req.method === 'POST' && ocrRefreshMatch) {
      const service = getOcrService();
      const existing = await service.getJob(ocrRefreshMatch[1]);
      if (!existing) throw Object.assign(new Error('OCR job not found.'), { code: 'OCR_JOB_NOT_FOUND', statusCode: 404 });
      requireOwnedDocument({ services, documentUploads, principal, documentId: existing.documentUploadId, write: true });
      const body = await readBody(req);
      const job = await service.refresh(existing.id, { authorization: {
        authorized: true,
        consentGrantId: requiredString(body.consentGrantId, 'consentGrantId'),
        requestedByAdultId: principal.adultId,
        purpose: 'document_processing',
        recipient: 'sarvam',
      } });
      return { status: 200, body: { job: ocrJobDto(job) } };
    }
    // Policy structuring (ADR 0006): start for an owned, OCR'd document and one analysis run of its case;
    // read the human-reviewable result. Missing and foreign-household documents are indistinguishable.
    const structuringMatch = url.pathname.match(/^\/api\/v1\/documents\/([^/]+)\/structuring-runs$/);
    if (req.method === 'POST' && structuringMatch) {
      const record = requireOwnedDocument({ services, documentUploads, principal, documentId: structuringMatch[1], write: true });
      const body = await readBody(req);
      const started = getStructuringService().start({
        document: record,
        workflowRunId: requiredString(body.workflowRunId, 'workflowRunId'),
        consentGrantId: requiredString(body.consentGrantId, 'consentGrantId'),
        subjectAdultId: principal.adultId,
        restart: body.restart ?? false,
      });
      return { status: started.status === 'finished' ? 200 : 202, body: { structuring: started } };
    }
    if (req.method === 'GET' && structuringMatch) {
      const record = requireOwnedDocument({ services, documentUploads, principal, documentId: structuringMatch[1] });
      // Readings quote the document, so the same field permission as reading the case's sources applies.
      responses.requireCaseField({ principal, caseRecord: services.access.requireCase(principal, record.caseId), field: READ_FIELDS.sourcePack });
      const workflowRunId = url.searchParams.get('workflowRunId');
      return { status: 200, body: { structuring: getStructuringService().result({ document: record, workflowRunId: requiredString(workflowRunId, 'workflowRunId') }) } };
    }
    if (req.method === 'DELETE' && documentMatch) {
      // Missing and foreign-household ids are deliberately indistinguishable. Deletion does not
      // require current processing consent: a person must still be able to erase stored data.
      const record = documentUploads?.getDocument(documentMatch[1]);
      if (!record?.caseId) throw documentNotFound();
      try {
        services.access.requireHousehold(principal, record.householdId);
      } catch (error) {
        if (error.code === 'HOUSEHOLD_NOT_FOUND') throw documentNotFound();
        throw error;
      }
      const roles = services.households.listActiveRoles(record.householdId, principal.adultId).map(item => item.role);
      const allowedRole = roles.some(role => ['owner', 'operator', 'backup_operator'].includes(role));
      if (record.uploadedByAdultId !== principal.adultId && !allowedRole) {
        throw Object.assign(new Error('You do not have permission to delete this document.'), {
          code: 'DOCUMENT_DELETE_FORBIDDEN', statusCode: 403,
        });
      }
      const result = documentUploads.requestDeletion({ documentId: record.id, actorAdultId: principal.adultId });
      if (!result) throw documentNotFound();
      return { status: result.state === 'deleted' ? 200 : 202, body: { document: documentDto(result.document) } };
    }
    if (req.method === 'GET' && documentMatch) {
      // A missing document and another household's document get the same response.
      const record = documentUploads?.getDocument(documentMatch[1]);
      if (!record?.caseId) throw documentNotFound();
      let caseRecord;
      try {
        caseRecord = services.access.requireCase(principal, record.caseId);
      } catch (error) {
        if (['CASE_NOT_FOUND', 'HOUSEHOLD_NOT_FOUND'].includes(error.code)) throw documentNotFound();
        throw error;
      }
      if (caseRecord.household_id !== record.householdId) throw documentNotFound();
      responses.requireCaseField({ principal, caseRecord, field: READ_FIELDS.sourcePack });
      return { status: 200, body: documentDto(record) };
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
      // Awaited inside the try so asynchronous service errors map through errorResponse.
      return await createAnalysisRun({ req, database, services, caseId: runMatch[1], body: await readBody(req), config, liveRegistryFactory });
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
