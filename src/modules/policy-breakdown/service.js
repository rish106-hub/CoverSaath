import { createHash } from 'node:crypto';
import { BREAKDOWN_CONTRACT_VERSION, normaliseValue } from './contracts.js';
import { EXTRACTION_SECTIONS, PARAMETER_INDEX, sectionByNumber, SECTIONS } from './sections/index.js';
import { assembleSectionFromStep, failedSectionResults, runAnalysisSections, runExtractionSection } from './pipeline/run-sections.js';
import { runCrossChecks } from './assembly/cross-checks.js';
import { createJobBudget } from './agents/model-runner.js';
import { verifyQuote } from './verification/citations.js';
import { evaluateReadiness } from './consumers/readiness.js';
import { buildEmergencyCard } from './consumers/emergency-card.js';
import { estimatePlannedProcedure, validateEstimateInput } from './consumers/estimate.js';
import { checkPlannedProcedure } from './consumers/procedure-check.js';
import { assertScenarioConsistency, mergeScenarioChecks, validateScenarioReporting } from './consumers/scenario-reporting.js';
import { buildPolicyStatus } from './consumers/policy-status.js';
import { resolveForMember } from './consumers/record-values.js';
import { EMPTY_REFERENCES } from './references/reference-store.js';
import { withTerminalOutcome } from './references/official/parameter-terminal-outcomes.js';
import { structuralPdfCheck } from './ocr/pdf-tools.js';
import { createDocumentIntakeService } from '../document-intake/document-intake-service.js';
import { OCR_OUTPUT_VERSION, validateOcrOutput } from '../document-intake/ocr-contracts.js';
import { PolicyRecordRepository } from '../../backend/repositories/policy-record-repository.js';
import { DocumentRepository } from '../../backend/repositories/document-repository.js';

export const POLICY_DOCUMENT_KINDS = Object.freeze(['policy_wording', 'policy_schedule', 'endorsement', 'member_card', 'other']);

export class PolicyServiceError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'PolicyServiceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode) => { throw new PolicyServiceError(code, message, statusCode); };
/** Request bodies must be JSON objects; anything else is a 400, never a crash. */
const objectBody = body => (body && typeof body === 'object' && !Array.isArray(body) ? body : fail('INVALID_REQUEST', 'The request body must be a JSON object.'));
// Analysis values computed from members' dates of birth. Shown only to viewers who may read every birth date used.
const BIRTH_DATE_DERIVED = new Set(['eldest_member_age_years', 'members_attracting_age_copay', 'next_cover_change_date', 'next_cover_change_reason', 'floater_concentration_risk']);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Key-order-insensitive JSON: values read back from jsonb are key-reordered. */
const stableJson = value => JSON.stringify(value, (_key, item) => (item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item));
const maskPolicyNumber = value => (typeof value === 'string' && value.length > 4 ? `${'•'.repeat(Math.min(value.length - 4, 12))}${value.slice(-4)}` : value ?? null);
const stepId = section => `extract:${section.id}`;

/** Allowlist view of a protected parameter for anyone but its owner. Nothing derived from the value survives. */
function maskProtected(result) {
  return {
    key: result.key, section: result.section, label: result.label, valueType: result.valueType,
    critical: result.critical, visibility: result.visibility, value: null, evidenceState: 'NotPermitted',
    stateReason: 'withheld_by_permission', citations: [], conditions: [], exceptions: [],
    review: { state: result.review?.state ?? 'unreviewed' },
  };
}

function publicParameter(result) {
  const definition = PARAMETER_INDEX.get(result.key);
  return definition ? withTerminalOutcome(result, definition) : result;
}

function initialSteps() {
  return [
    { id: 'ocr', label: 'Read every page of the uploaded documents', status: 'pending' },
    ...EXTRACTION_SECTIONS.map(section => ({ id: stepId(section), label: `Section ${section.number}: ${section.title}`, section: section.number, status: 'pending' })),
    { id: 'assemble', label: 'Verify citations, analyse sections 10–12 and assemble the record', status: 'pending' },
  ];
}

function publicJob(job, modelCalls = []) {
  if (!job) return null;
  return {
    id: job.id,
    policyRecordId: job.policyRecordId,
    executionMode: job.executionMode,
    status: job.status,
    currentStep: job.currentStep,
    steps: job.steps.map(({ output, ...step }) => step),
    budgetUsd: job.budgetUsd,
    spentUsd: Number(job.spentUsd.toFixed(6)),
    error: job.errorCode ? { code: job.errorCode, message: job.errorMessage } : null,
    modelCalls: modelCalls.length,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * @param deps.database            async Postgres adapter (src/backend/database)
 * @param deps.services            createBackendServices() result (access, consents, ocr, households, audit)
 * @param deps.storage             byte storage (encrypted live or fixture)
 * @param deps.pageTextProvider    (mode) => provider with extractPages()
 * @param deps.modelRunner         (mode) => runner with run()
 * @param deps.references          () => dated reference data for sections 10–12 (see references/reference-store.js)
 */
export function createPolicyBreakdownService({ database, services, storage, pageTextProvider, modelRunner, clock = () => new Date(), schedule = task => setImmediate(task), maxUploadBytes, scanMode = 'antivirus_required', references = () => EMPTY_REFERENCES } = {}) {
  if (!['antivirus_required', 'structural_only'].includes(scanMode)) throw new TypeError('scanMode must be antivirus_required or structural_only.');
  if (!database || !services) throw new TypeError('database and services are required.');
  const records = new PolicyRecordRepository(database, { clock, audit: services.audit });
  const documents = new DocumentRepository(database);
  const running = new Map();
  const now = () => clock().toISOString();

  const intake = () => {
    if (!storage) fail('DOCUMENT_STORAGE_NOT_CONFIGURED', 'Protected document storage is not configured. Set DOCUMENT_ENCRYPTION_KEY_BASE64.', 503);
    return createDocumentIntakeService({ repository: documents, storage, mode: storage.mode === 'live' ? 'live' : 'fixture', now: clock, maxBytes: maxUploadBytes });
  };

  async function requireRecord(principal, recordId, { write = false } = {}) {
    const record = await records.getRecord(recordId);
    if (!record) fail('POLICY_RECORD_NOT_FOUND', 'Policy record not found.', 404);
    await services.access.requireHousehold(principal, record.householdId, { write });
    const consent = await database.one('SELECT revoked_at, expires_at FROM consent_grants WHERE id = $1', [record.consentGrantId]);
    const lapsed = !consent || consent.revoked_at || (consent.expires_at && Date.parse(consent.expires_at) <= clock().getTime());
    if (lapsed) {
      if (record.status !== 'revoked') await records.updateRecord(record.id, { status: 'revoked', readyAt: null });
      fail('CONSENT_REVOKED', 'Consent for this policy record is no longer active.', 403);
    }
    return record;
  }

  /** Active grant for this adult, purpose and household (repository check ignores household). */
  async function requireGrant(principal, householdId, consentGrantId, scope) {
    const grant = await services.consents.requireActive(consentGrantId, { subjectAdultId: principal.adultId, purpose: 'coverage_reconstruction', ...scope });
    if (grant.household_id !== householdId) fail('CONSENT_SCOPE_REQUIRED', 'The consent belongs to a different household.', 403);
    return grant;
  }

  /** Re-checked before every paid or outbound step of a running job. */
  async function assertJobConsent(job) {
    const record = await records.getRecord(job.policyRecordId);
    const grant = await database.one('SELECT revoked_at, expires_at FROM consent_grants WHERE id = $1', [record.consentGrantId]);
    if (!grant || grant.revoked_at || (grant.expires_at && Date.parse(grant.expires_at) <= clock().getTime())) {
      if (record.status !== 'revoked') await records.updateRecord(record.id, { status: 'revoked', readyAt: null });
      fail('CONSENT_REVOKED', 'Consent was revoked while the breakdown was running; no further data was sent.', 403);
    }
  }

  async function householdMembers(principal, householdId) {
    const rows = await database.query('SELECT * FROM household_members WHERE household_id = $1 ORDER BY created_at', [householdId]);
    return Promise.all(rows.map(async member => {
      const canReadBirthDate = !member.adult_user_id || member.adult_user_id === principal.adultId || await services.consents.canAccessField({
        householdId, subjectAdultId: member.adult_user_id, viewerAdultId: principal.adultId, fieldKey: 'date_of_birth',
      });
      return { id: member.id, displayName: member.display_name, relationship: member.relationship_label, dateOfBirth: canReadBirthDate ? member.date_of_birth : null };
    }));
  }

  /** Protected parameters are visible only to the adult who created the record. Others see NotPermitted. */
  async function visibleParameters(principal, record, parameters) {
    if (principal.adultId === record.createdByAdultId) return parameters;
    // Birth-date-derived analysis was computed with the creator's access; withhold it from a viewer who cannot
    // read every birth date the creator could.
    const creatorView = await householdMembers({ adultId: record.createdByAdultId }, record.householdId);
    const viewerView = new Map((await householdMembers(principal, record.householdId)).map(member => [member.id, member.dateOfBirth]));
    const birthDatesHidden = creatorView.some(member => member.dateOfBirth && !viewerView.get(member.id));
    return Object.fromEntries(Object.entries(parameters).map(([key, result]) => [key, result.visibility === 'protected' || (birthDatesHidden && BIRTH_DATE_DERIVED.has(key)) ? maskProtected(result) : result]));
  }

  async function loadPages(recordId) {
    const docs = await records.recordDocuments(recordId);
    const pages = [];
    for (const document of docs) {
      const rows = await database.query(`SELECT page_number, extracted_text, extraction_status FROM source_pages
        WHERE document_upload_id = $1 AND source_version = $2 ORDER BY page_number`, [document.id, document.source_version]);
      for (const row of rows) {
        pages.push({ pageNumber: pages.length + 1, localPageNumber: row.page_number, documentId: document.id, documentLabel: `${document.document_kind}:${document.original_filename}`, text: row.extracted_text ?? '', extractionStatus: row.extraction_status });
      }
    }
    return pages;
  }

  async function runOcrStep(job) {
    const record = await records.getRecord(job.policyRecordId);
    const provider = pageTextProvider(job.executionMode);
    const warnings = [];
    for (const document of await records.recordDocuments(record.id)) {
      const { count: existing } = await database.one(`SELECT count(*) AS count FROM source_pages WHERE document_upload_id = $1 AND source_version = $2`, [document.id, document.source_version]);
      if (existing > 0) continue;
      await assertJobConsent(job);
      const ready = await services.ocr.getReadyDocument(document.id, now());
      if (!ready) fail('DOCUMENT_NOT_OCR_READY', `Document ${document.original_filename} is not active, clean and consented for processing.`, 409);
      const bytes = await intake().readProtectedBytes(document.id);
      const extracted = await provider.extractPages({ bytes, mimeType: document.mime_type, filename: document.original_filename });
      warnings.push(...(extracted.warnings ?? []));
      const output = validateOcrOutput({
        schemaVersion: OCR_OUTPUT_VERSION,
        document: { id: document.id, sourceVersion: document.source_version, contentSha256: document.content_sha256 },
        provider: { name: provider.name, jobRef: (extracted.jobRefs ?? []).join(',').slice(0, 200) || null },
        pages: extracted.pages,
        warnings: (extracted.warnings ?? []).slice(0, 100),
      }, { documentId: document.id, sourceVersion: document.source_version, contentSha256: document.content_sha256 });
      const at = now();
      const ocrJob = await services.ocr.createJob({
        id: `ocr-${job.id.slice(-12)}-${document.id.slice(-12)}-${Date.now().toString(36)}`,
        documentUploadId: document.id,
        provider: provider.name,
        status: 'processing',
        contractVersion: OCR_OUTPUT_VERSION,
        authorization: { authorized: true, consentGrantId: document.consent_grant_id, requestedByAdultId: document.uploaded_by_adult_id, purpose: 'document_processing' },
        requestedAt: at,
        updatedAt: at,
      });
      await services.ocr.completeJob(ocrJob.id, output.pages.map(page => ({ ...page, documentUploadId: document.id, sourceVersion: document.source_version, outputContractVersion: OCR_OUTPUT_VERSION, createdAt: at })), {
        status: 'succeeded', providerJobRef: output.provider.jobRef, result: { schemaVersion: output.schemaVersion, provider: output.provider, pageCount: output.pages.length, warnings: output.warnings, assessment: output.assessment },
        resultDigest: digest(output.pages.map(page => page.textSha256)), completedAt: at, updatedAt: at, errorCode: null, errorMessage: null,
      });
    }
    const pages = await loadPages(record.id);
    if (pages.length === 0) fail('NO_PAGE_TEXT', 'No page text was extracted from the documents.', 422);
    const failedPages = pages.filter(page => page.extractionStatus !== 'extracted').map(page => page.pageNumber);
    return { pageCount: pages.length, failedPages, warnings };
  }

  /** Re-checks consent immediately before every model call, so a revocation stops calls that have not started. */
  function consentGuarded(runner, job) {
    return { ...runner, run: async input => { await assertJobConsent(job); return runner.run(input); } };
  }

  /** Atomic per-step update: sections run in parallel, so each change merges under a row lock. */
  function updateStep(job, id, changes, jobChanges = {}) {
    return records.patchStep(job.id, id, changes, jobChanges);
  }

  /** True while the record's consent grant is neither revoked nor expired. */
  async function consentActive(record) {
    const grant = await database.one('SELECT revoked_at, expires_at FROM consent_grants WHERE id = $1', [record.consentGrantId]);
    return Boolean(grant && !grant.revoked_at && !(grant.expires_at && Date.parse(grant.expires_at) <= clock().getTime()));
  }

  async function otherRecordParameters(record) {
    const result = [];
    for (const other of await records.listRecords(record.householdId)) {
      if (other.id !== record.id && ['needs_review', 'ready'].includes(other.status) && await consentActive(other)) result.push(await records.parameters(other.id));
    }
    return result;
  }

  /** Re-runs the deterministic sections 10–12 from current stored values, keeping human reviews. */
  async function analyse(record, parameters) {
    const creator = { adultId: record.createdByAdultId };
    const city = (await database.one('SELECT city FROM households WHERE id = $1', [record.householdId]))?.city ?? null;
    const analysis = runAnalysisSections({ parameters, household: { members: await householdMembers(creator, record.householdId), city }, otherRecords: await otherRecordParameters(record), references: references() ?? EMPTY_REFERENCES, asOf: now().slice(0, 10) });
    for (const [key, result] of Object.entries(analysis)) {
      const previous = parameters[key];
      parameters[key] = previous?.review?.state && previous.review.state !== 'unreviewed' && previous.evidenceState === result.evidenceState && stableJson(previous.value) === stableJson(result.value)
        ? previous
        : result;
    }
    return parameters;
  }

  async function refreshAnalysis(recordId) {
    const record = await records.getRecord(recordId);
    const parameters = await analyse(record, await records.parameters(recordId));
    await records.replaceParameters(recordId, parameters);
    const summary = record.summary ? { ...record.summary, consistencyIssues: runCrossChecks(parameters) } : record.summary;
    await records.updateRecord(recordId, { summary });
  }

  async function assembleRecord(job, { runner }) {
    const record = await records.getRecord(job.policyRecordId);
    const pages = await loadPages(record.id);
    const parameters = {};
    const failedSections = [];
    for (const section of EXTRACTION_SECTIONS) {
      const step = job.steps.find(item => item.id === stepId(section));
      if (step?.status === 'succeeded' && step.output) Object.assign(parameters, assembleSectionFromStep({ section, stepOutput: step.output, pages, runner }));
      else { failedSections.push(section.number); Object.assign(parameters, failedSectionResults(section, 'section_agent_failed')); }
    }
    // Human review decisions survive a re-assembly.
    const previous = await records.parameters(record.id);
    for (const [key, result] of Object.entries(previous)) if (result.review?.state && result.review.state !== 'unreviewed' && parameters[key]) parameters[key] = result;
    await analyse(record, parameters);
    const consistencyIssues = runCrossChecks(parameters);
    await records.replaceParameters(record.id, parameters);
    const bySection = {};
    for (const result of Object.values(parameters)) {
      bySection[result.section] ??= {};
      bySection[result.section][result.evidenceState] = (bySection[result.section][result.evidenceState] ?? 0) + 1;
    }
    const text = key => (['Proven', 'Reported'].includes(parameters[key]?.evidenceState) ? parameters[key]?.value?.text ?? null : null);
    const ocrStep = job.steps.find(step => step.id === 'ocr');
    await records.updateRecord(record.id, {
      status: 'needs_review',
      readyAt: null,
      insurerName: text('insurer_name'),
      productName: text('product_name'),
      policyNumberMasked: maskPolicyNumber(text('policy_number')),
      displayTitle: [text('product_name'), text('insurer_name')].filter(Boolean).join(' — ') || null,
      summary: {
        contractVersion: BREAKDOWN_CONTRACT_VERSION,
        parameterCount: Object.keys(parameters).length,
        bySection,
        criticalOpen: Object.values(parameters).filter(result => result.critical && (result.review?.state ?? 'unreviewed') === 'unreviewed').length,
        consistencyIssues,
        failedSections,
        pageCount: pages.length,
        failedPages: ocrStep?.metrics?.failedPages ?? [],
        warnings: ocrStep?.metrics?.warnings ?? [],
      },
    });
    return { failedSections };
  }

  async function runJob(jobId) {
    if (running.has(jobId)) return running.get(jobId);
    const promise = (async () => {
      let job = await records.getJob(jobId);
      if (!job || !['queued', 'interrupted', 'failed'].includes(job.status)) return job;
      job = await records.updateJob(job.id, { status: 'running', startedAt: job.startedAt ?? now(), errorCode: null, errorMessage: null });
      let runner;
      try {
        runner = modelRunner(job.executionMode);
      } catch (error) {
        return records.updateJob(job.id, { status: 'failed', errorCode: error.code ?? 'MODEL_NOT_CONFIGURED', errorMessage: error.message, completedAt: now() });
      }
      const budget = job.executionMode === 'live' ? createJobBudget(job.budgetUsd, { spentUsd: job.spentUsd }) : createJobBudget(Number.MAX_SAFE_INTEGER);
      try {
        // Step 1: OCR (skipped when already succeeded).
        if (job.steps.find(step => step.id === 'ocr').status !== 'succeeded') {
          job = await updateStep(job, 'ocr', { status: 'running', startedAt: now(), errorCode: null, errorMessage: null });
          try {
            const metrics = await runOcrStep(job);
            job = await updateStep(job, 'ocr', { status: 'succeeded', completedAt: now(), metrics });
          } catch (error) {
            job = await updateStep(job, 'ocr', { status: 'failed', completedAt: now(), errorCode: error.code ?? 'OCR_FAILED', errorMessage: String(error.message).slice(0, 300) });
            await records.updateRecord(job.policyRecordId, { status: 'failed', readyAt: null });
            return records.updateJob(job.id, { status: 'failed', errorCode: error.code ?? 'OCR_FAILED', errorMessage: String(error.message).slice(0, 300), completedAt: now() });
          }
        }
        // Step 2: nine extraction sections in parallel; each persists as it finishes. Step updates are atomic.
        const pages = await loadPages(job.policyRecordId);
        const pending = EXTRACTION_SECTIONS.filter(section => job.steps.find(step => step.id === stepId(section)).status !== 'succeeded');
        await Promise.allSettled(pending.map(async section => {
          await updateStep(job, stepId(section), { status: 'running', startedAt: now(), errorCode: null, errorMessage: null });
          try {
            await assertJobConsent(job);
            const output = await runExtractionSection({ section, pages, runner: consentGuarded(runner, job), budget });
            for (const call of output.calls) await records.recordModelCall(job.id, call);
            await updateStep(job, stepId(section), {
              status: 'succeeded', completedAt: now(),
              output: { extracted: output.extracted, verified: output.verified, model: runner.model },
              metrics: { calls: output.calls.length, costUsd: output.calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0) },
            }, { spentUsd: budget.snapshot().spentUsd });
          } catch (error) {
            await records.recordModelCall(job.id, { agent: `${section.id}:extractor`, status: 'failed', provider: runner.provider, model: runner.model, errorCode: error.code ?? 'MODEL_CALL_FAILED' });
            await updateStep(job, stepId(section), { status: 'failed', completedAt: now(), errorCode: error.code ?? 'SECTION_FAILED', errorMessage: String(error.message).slice(0, 300) });
          }
        }));
        job = await records.getJob(job.id);
        await assertJobConsent(job);
        // Step 3: deterministic assembly (always runs so partial results are reviewable).
        job = await updateStep(job, 'assemble', { status: 'running', startedAt: now() });
        const { failedSections } = await assembleRecord(job, { runner });
        job = await updateStep(job, 'assemble', { status: 'succeeded', completedAt: now(), metrics: { failedSections } });
        if (failedSections.length) {
          return await records.updateJob(job.id, { status: 'failed', currentStep: null, spentUsd: budget.snapshot().spentUsd, errorCode: 'SECTIONS_FAILED', errorMessage: `Sections ${failedSections.join(', ')} failed. Resume the job to retry them.`, completedAt: now() });
        }
        return await records.updateJob(job.id, { status: 'succeeded', currentStep: null, spentUsd: budget.snapshot().spentUsd, completedAt: now() });
      } catch (error) {
        return records.updateJob(job.id, { status: 'failed', spentUsd: budget.snapshot().spentUsd, errorCode: error.code ?? 'BREAKDOWN_FAILED', errorMessage: String(error.message).slice(0, 300), completedAt: now() });
      }
    })().finally(() => running.delete(jobId));
    running.set(jobId, promise);
    return promise;
  }

  return Object.freeze({
    records,
    documents,
    runJob,
    recoverInterruptedJobs: () => records.markInterrupted(),

    async uploadDocument(principal, householdId, body) {
      body = objectBody(body);
      await services.access.requireHousehold(principal, householdId, { write: true });
      if (!POLICY_DOCUMENT_KINDS.includes(body.documentKind)) fail('UNSUPPORTED_DOCUMENT_KIND', `documentKind must be one of ${POLICY_DOCUMENT_KINDS.join(', ')}.`);
      if (typeof body.contentBase64 !== 'string' || !body.contentBase64) fail('INVALID_REQUEST', 'contentBase64 is required.');
      const bytes = Buffer.from(body.contentBase64, 'base64');
      const service = intake();
      const logicalDocumentId = typeof body.logicalDocumentId === 'string' && body.logicalDocumentId.trim() ? body.logicalDocumentId.trim().slice(0, 120) : `doc-${createHash('sha256').update(bytes).digest('hex').slice(0, 24)}`;
      const uploaded = await service.intake({
        householdId, caseId: null, uploadedByAdultId: principal.adultId, consentGrantId: body.consentGrantId,
        logicalDocumentId, version: Number.isInteger(body.version) ? body.version : 1, documentKind: body.documentKind,
        filename: body.filename, mimeType: body.mimeType, bytes,
      });
      let scan = { status: 'clean', reference: 'image-signature-check-v1', findings: [] };
      if (uploaded.mimeType === 'application/pdf') {
        try { scan = await structuralPdfCheck(bytes); } catch (error) { scan = { status: 'blocked', reference: 'structural-pdf-check-v1', findings: [error.code ?? 'PDF_UNREADABLE'], error }; }
      }
      let result;
      if (storage.mode === 'live' && scanMode !== 'structural_only') {
        await services.audit.append({ householdId, actorType: 'adult_user', actorId: principal.adultId, action: 'document.uploaded', resourceType: 'document', resourceId: uploaded.id, payload: { kind: uploaded.documentKind, bytes: uploaded.byteSize, scan: 'not_run', reason: 'antivirus_not_configured' } });
        return { document: uploaded, accepted: false, reason: 'No antivirus scanner is configured, so the document stays quarantined. For local development only, set DOCUMENT_SCAN_MODE=structural_only.', scan: { status: 'not_run', reference: null, findings: [] } };
      }
      if (storage.mode === 'live') result = await service.recordMalwareScan({ documentId: uploaded.id, status: scan.status, scannerReference: scan.reference });
      else result = scan.status === 'clean' ? await service.activateFixture(uploaded.id) : uploaded;
      await services.audit.append({ householdId, actorType: 'adult_user', actorId: principal.adultId, action: 'document.uploaded', resourceType: 'document', resourceId: uploaded.id, payload: { kind: uploaded.documentKind, bytes: uploaded.byteSize, scan: scan.status, scanReference: scan.reference, findings: scan.findings } });
      if (scan.status !== 'clean') {
        const reason = scan.error?.code === 'PDF_ENCRYPTED' ? 'The PDF is password-protected. Upload an unprotected copy.' : 'The document contains active content or could not be parsed and was quarantined.';
        return { document: result, accepted: false, reason, scan: { status: scan.status, reference: scan.reference, findings: scan.findings } };
      }
      return { document: result, accepted: true, scan: { status: scan.status, reference: scan.reference, findings: scan.findings, note: 'Structural safety check only; this is not antivirus scanning.' } };
    },

    async listDocuments(principal, householdId) {
      await services.access.requireHousehold(principal, householdId);
      return (await documents.listForHousehold(householdId)).map(({ storageKey, ...document }) => document);
    },

    async addMember(principal, householdId, body) {
      body = objectBody(body);
      await services.access.requireHousehold(principal, householdId, { write: true });
      const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (!displayName || displayName.length > 120) fail('INVALID_REQUEST', 'displayName is required (max 120 characters).');
      const dateOfBirth = body.dateOfBirth ?? null;
      if (dateOfBirth !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth) || Number.isNaN(Date.parse(dateOfBirth)))) fail('INVALID_REQUEST', 'dateOfBirth must be yyyy-mm-dd.');
      const relationshipLabel = typeof body.relationship === 'string' ? body.relationship.trim().slice(0, 60) : null;
      const member = await services.households.addMember({ householdId, displayName, memberKind: 'dependent', relationshipLabel, dateOfBirth });
      return { id: member.id, displayName: member.display_name, relationship: member.relationship_label, dateOfBirth: member.date_of_birth, memberKind: member.member_kind };
    },

    /** Sets the household city used by city-specific analysis, then re-runs sections 10–12 on every record. */
    async setHouseholdCity(principal, householdId, body) {
      body = objectBody(body);
      await services.access.requireHousehold(principal, householdId, { write: true });
      const city = body.city === null ? null : typeof body.city === 'string' ? body.city.trim() : undefined;
      if (city === undefined || (city !== null && (city.length < 1 || city.length > 80 || /[<>]/.test(city)))) fail('INVALID_REQUEST', 'city must be text of 1–80 characters, or null.');
      await services.households.setCity({ householdId, city, actorAdultId: principal.adultId });
      for (const record of await records.listRecords(householdId)) if (['needs_review', 'ready'].includes(record.status) && await consentActive(record)) await refreshAnalysis(record.id);
      return { householdId, city };
    },

    async createPolicyRecord(principal, householdId, body, idempotencyKey) {
      body = objectBody(body);
      await services.access.requireHousehold(principal, householdId, { write: true });
      const documentIds = Array.isArray(body.documentIds) ? [...new Set(body.documentIds.filter(id => typeof id === 'string'))] : [];
      if (documentIds.length < 1 || documentIds.length > 10) fail('INVALID_REQUEST', 'documentIds must list 1 to 10 uploaded documents.');
      const executionMode = body.executionMode ?? 'live';
      if (!['live', 'fixture'].includes(executionMode)) fail('INVALID_REQUEST', 'executionMode must be live or fixture.');
      const consentGrantId = typeof body.consentGrantId === 'string' ? body.consentGrantId : null;
      if (!consentGrantId) fail('INVALID_REQUEST', 'consentGrantId is required.');
      await requireGrant(principal, householdId, consentGrantId, { resourceType: 'policy', action: 'derive', dataCategory: 'insurance_document' });
      if (executionMode === 'live') {
        if (body.modelPermission !== true) fail('MODEL_PERMISSION_REQUIRED', 'Live breakdown sends page images to Sarvam and page text to Gemini. Set modelPermission=true after the person agrees.', 403);
        for (const documentId of documentIds) await requireGrant(principal, householdId, consentGrantId, { resourceType: 'document', resourceId: documentId, action: 'share', dataCategory: 'insurance_document' });
      }
      const requestDigest = digest({ documentIds, consentGrantId, executionMode });
      const existing = await records.findJobByIdempotency(householdId, idempotencyKey);
      if (existing) {
        if (existing.requestDigest !== requestDigest) fail('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request.', 409);
        return { created: false, record: await records.getRecord(existing.policyRecordId), job: publicJob(existing) };
      }
      for (const documentId of documentIds) {
        const document = await database.one('SELECT household_id, lifecycle_state, document_kind FROM document_uploads WHERE id = $1', [documentId]);
        if (!document || document.household_id !== householdId) fail('DOCUMENT_NOT_FOUND', `Document ${documentId} was not found in this household.`, 404);
        if (document.lifecycle_state !== 'active') fail('DOCUMENT_NOT_ACTIVE', `Document ${documentId} is not active (it may be quarantined or deleted).`, 409);
      }
      let budgetUsd = 0;
      if (executionMode === 'live') {
        const runner = modelRunner('live');
        budgetUsd = runner.config.jobBudgetUsd;
        pageTextProvider('live');
      } else {
        modelRunner('fixture');
        pageTextProvider('fixture');
      }
      let created;
      try {
        created = await records.createRecordWithJob({
          householdId, createdByAdultId: principal.adultId, consentGrantId, contractVersion: BREAKDOWN_CONTRACT_VERSION,
          documentIds, idempotencyKey, requestDigest, executionMode, budgetUsd, steps: initialSteps(),
        });
      } catch (error) {
        const raced = await records.findJobByIdempotency(householdId, idempotencyKey);
        if (!raced) throw error;
        if (raced.requestDigest !== requestDigest) fail('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request.', 409);
        return { created: false, record: await records.getRecord(raced.policyRecordId), job: publicJob(raced) };
      }
      const { record, job } = created;
      schedule(() => { runJob(job.id).catch(() => {}); });
      return { created: true, record, job: publicJob(job) };
    },

    async listRecords(principal, householdId) {
      await services.access.requireHousehold(principal, householdId);
      return records.listRecords(householdId);
    },

    async getRecord(principal, recordId) {
      const record = await requireRecord(principal, recordId);
      const job = await records.latestJobForRecord(recordId);
      return { record, job: publicJob(job), sections: SECTIONS.map(section => ({ number: section.number, title: section.title, kind: section.kind, counts: record.summary?.bySection?.[section.number] ?? null })) };
    },

    async getSections(principal, recordId, { sectionNumber = null } = {}) {
      const record = await requireRecord(principal, recordId);
      if (sectionNumber != null && !sectionByNumber(sectionNumber)) fail('SECTION_NOT_FOUND', 'Section must be 1–12.', 404);
      const parameters = await visibleParameters(principal, record, await records.parameters(recordId));
      const sections = SECTIONS.filter(section => sectionNumber == null || section.number === Number(sectionNumber)).map(section => ({
        number: section.number,
        id: section.id,
        title: section.title,
        question: section.question,
        kind: section.kind,
        reviewGuidance: section.reviewGuidance || null,
        parameters: section.parameters.map(definition => parameters[definition.key] ?? null).filter(Boolean).map(publicParameter),
      }));
      return { recordId, recordStatus: record.status, consistencyIssues: record.summary?.consistencyIssues ?? [], sections };
    },

    async getJob(principal, jobId) {
      const job = await records.getJob(jobId);
      if (!job) fail('JOB_NOT_FOUND', 'Breakdown job not found.', 404);
      await services.access.requireHousehold(principal, job.householdId);
      return publicJob(job, await records.modelCalls(jobId));
    },

    async resumeJob(principal, jobId) {
      const job = await records.getJob(jobId);
      if (!job) fail('JOB_NOT_FOUND', 'Breakdown job not found.', 404);
      await services.access.requireHousehold(principal, job.householdId, { write: true });
      await requireRecord(principal, job.policyRecordId, { write: true });
      if (!['interrupted', 'failed'].includes(job.status)) fail('JOB_NOT_RESUMABLE', `A ${job.status} job cannot be resumed.`, 409);
      let budgetUsd = job.budgetUsd;
      if (job.executionMode === 'live') budgetUsd = Math.max(job.budgetUsd, modelRunner('live').config.jobBudgetUsd);
      const updated = await records.updateJob(job.id, { status: 'queued', completedAt: null, budgetUsd });
      schedule(() => { runJob(job.id).catch(() => {}); });
      return publicJob(updated);
    },

    async reviewParameter(principal, recordId, key, body) {
      body = objectBody(body);
      const record = await requireRecord(principal, recordId, { write: true });
      const definition = PARAMETER_INDEX.get(key);
      if (!definition) fail('PARAMETER_NOT_FOUND', 'Unknown parameter.', 404);
      const previous = (await records.parameters(recordId))[key];
      if (!previous) fail('PARAMETER_NOT_FOUND', 'The record has no value for this parameter yet.', 404);
      if (definition.visibility === 'protected' && principal.adultId !== record.createdByAdultId) fail('FIELD_ACCESS_REQUIRED', 'Only the person this protected information belongs to can review it.', 403);
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
      const review = state => ({ state, by: principal.adultId, at: now(), note });
      let next;
      if (body.action === 'confirm') {
        const memberOnly = previous.stateReason === 'member_specific_values_only' && previous.memberVariants?.length && previous.memberVariants.every(variant => variant.evidenceState === 'Proven');
        if (!memberOnly && (!previous.value || !['Proven', 'Calculated', 'Dynamic', 'Reported'].includes(previous.evidenceState))) fail('NOTHING_TO_CONFIRM', 'Only an established value can be confirmed. Correct it or mark it absent instead.', 409);
        next = { ...previous, review: review('confirmed') };
      } else if (body.action === 'correct') {
        const normalised = normaliseValue(definition, body.value ?? {});
        if (!normalised.ok) fail('INVALID_VALUE', `The corrected value is invalid: ${normalised.reason}.`);
        let citations = [];
        let evidenceState = 'Reported';
        if (body.citation) {
          const pages = await loadPages(recordId);
          const page = pages.find(item => item.documentId === body.citation.documentId && item.localPageNumber === body.citation.pageNumber);
          const check = page ? verifyQuote({ quote: body.citation.quote, pageNumber: page.pageNumber }, new Map(pages.map(item => [item.pageNumber, item]))) : { matched: false };
          if (!check.matched) fail('CITATION_NOT_FOUND', 'The quote was not found on that page. Correct without a citation to record it as Reported.', 422);
          citations = [{ documentId: page.documentId, pageNumber: page.localPageNumber, packPage: page.pageNumber, quote: body.citation.quote, matched: true, matchMethod: check.method }];
          evidenceState = 'Proven';
        }
        next = { ...previous, value: normalised.value, proposedValue: null, evidenceState, stateReason: evidenceState === 'Proven' ? 'person_corrected_with_verified_citation' : 'person_reported_without_document_citation', citations, review: review('corrected') };
      } else if (body.action === 'mark_absent') {
        if (previous.evidenceState !== 'Unknown' || previous.memberVariants?.length) fail('CANNOT_MARK_ABSENT', `This parameter is ${previous.evidenceState}. Correct it with the right value instead of marking it absent.`, 409);
        next = { ...previous, value: null, evidenceState: 'Unknown', stateReason: 'person_confirmed_not_stated_in_pack', review: review('confirmed_absent') };
      } else {
        fail('INVALID_REQUEST', 'action must be confirm, correct or mark_absent.');
      }
      await records.applyReview({ recordId, key, action: body.action, previous, next, reviewerAdultId: principal.adultId, note, householdId: record.householdId });
      if (definition.section <= 9) await refreshAnalysis(recordId);
      if (record.status === 'ready') await records.updateRecord(recordId, { status: 'needs_review', readyAt: null });
      return publicParameter((await visibleParameters(principal, record, { [key]: next }))[key]);
    },

    async checkReadiness(principal, recordId) {
      const record = await requireRecord(principal, recordId, { write: true });
      const job = await records.latestJobForRecord(recordId);
      const parameters = await records.parameters(recordId);
      const consistencyIssues = runCrossChecks(parameters);
      const result = evaluateReadiness({ record, parameters, consistencyIssues, jobStatus: job?.status });
      if (result.ready && record.status !== 'ready') await records.updateRecord(recordId, { status: 'ready', readyAt: now() });
      if (!result.ready && record.status === 'ready') await records.updateRecord(recordId, { status: 'needs_review', readyAt: null });
      return { ...result, recordStatus: (await records.getRecord(recordId)).status };
    },

    async emergencyCard(principal, recordId) {
      const record = await requireRecord(principal, recordId);
      const parameters = await visibleParameters(principal, record, await records.parameters(recordId));
      return buildEmergencyCard({ record, parameters, members: await householdMembers(principal, record.householdId), asOf: now().slice(0, 10) });
    },

    /** Eligibility checklist and steps for a planned treatment, without a bill. */
    async procedureCheck(principal, recordId, body) {
      body = objectBody(body);
      const record = await requireRecord(principal, recordId);
      const member = body.memberId ? (await householdMembers(principal, record.householdId)).find(item => item.id === body.memberId) ?? null : null;
      if (body.memberId && !member) fail('MEMBER_NOT_FOUND', 'memberId is not a member of this household.', 404);
      const parameters = resolveForMember(await visibleParameters(principal, record, await records.parameters(recordId)), member);
      const request = validateEstimateInput(body, { requireBill: false });
      const reportedScenario = validateScenarioReporting(body.scenarioReporting);
      assertScenarioConsistency(reportedScenario, request);
      const result = mergeScenarioChecks(checkPlannedProcedure({ parameters, request, member, asOf: now().slice(0, 10) }), reportedScenario);
      return { recordId, recordStatus: record.status, confirmedByPerson: record.status === 'ready', ...result };
    },

    async policyStatus(principal, recordId) {
      const record = await requireRecord(principal, recordId);
      const parameters = await visibleParameters(principal, record, await records.parameters(recordId));
      return { recordId, recordStatus: record.status, confirmedByPerson: record.status === 'ready', ...buildPolicyStatus({ parameters, asOf: now().slice(0, 10) }) };
    },

    async estimate(principal, recordId, body) {
      body = objectBody(body);
      const record = await requireRecord(principal, recordId);
      const parameters = await visibleParameters(principal, record, await records.parameters(recordId));
      const member = body.memberId ? (await householdMembers(principal, record.householdId)).find(item => item.id === body.memberId) ?? null : null;
      if (body.memberId && !member) fail('MEMBER_NOT_FOUND', 'memberId is not a member of this household.', 404);
      const reportedScenario = validateScenarioReporting(body.scenarioReporting);
      assertScenarioConsistency(reportedScenario, validateEstimateInput(body));
      const estimate = estimatePlannedProcedure({ parameters, input: body, member, asOf: now().slice(0, 10) });
      return { recordId, recordStatus: record.status, confirmedByPerson: record.status === 'ready', ...estimate, eligibility: mergeScenarioChecks(estimate.eligibility, reportedScenario), reportedScenario };
    },
  });
}
