import { createHash } from 'node:crypto';
import { GEMINI_MODEL_RECIPIENT } from '../../modules/ai-analysis/privacy-evidence-gate.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_DISPATCH_SOURCES = 500;
const ACTIVE_RUN_STATUSES = new Set(['queued', 'running']);

function parse(value) {
  return value === null ? null : JSON.parse(value);
}

// The analysis subject, defined once: the adult behind the case's subject
// member, or the opener (guardian) when the subject is a dependent without an
// adult account or no subject member is set. A subject member that is missing
// or belongs to another household yields NULL, which matches no consent (fail
// closed). `service_case` must be the alias of the service_cases row.
const ANALYSIS_SUBJECT_SQL = `CASE
    WHEN service_case.subject_member_id IS NULL THEN service_case.opened_by_adult_id
    ELSE (SELECT COALESCE(subject_member.adult_user_id, service_case.opened_by_adult_id)
      FROM household_members subject_member
      WHERE subject_member.id = service_case.subject_member_id
        AND subject_member.household_id = service_case.household_id)
  END`;

// The household member the analysis is about, which is what parameter records
// reference (their subject_id is a household_members FK, not an adult user id):
// the case's subject member when it belongs to the case household, else, only
// when no subject member is set, the opener's own member row. A subject member
// that is set but foreign or missing yields NULL (fail closed).
const ANALYSIS_MEMBER_SQL = `CASE
    WHEN service_case.subject_member_id IS NULL THEN (SELECT opener_member.id FROM household_members opener_member
      WHERE opener_member.household_id = service_case.household_id
        AND opener_member.adult_user_id = service_case.opened_by_adult_id
      ORDER BY opener_member.created_at, opener_member.id LIMIT 1)
    ELSE (SELECT subject_member.id FROM household_members subject_member
      WHERE subject_member.id = service_case.subject_member_id
        AND subject_member.household_id = service_case.household_id)
  END`;

// One eligibility predicate shared by source selection and the pre-dispatch
// re-check, so the two can never drift apart. A page is eligible only while its
// document is active, clean, encrypted, successfully OCR'd, and covered by a
// current (not revoked, not expired) document_processing grant from the case
// subject in the same household whose scope names exactly this document,
// action 'derive', category 'insurance_document' and the intended model
// recipient. `scope.recipient = ?` never matches NULL: a scope without a named
// recipient does not authorise model disclosure (fail closed).
function eligibleSourcePagesSql(pageIdCount = 0) {
  const pageFilter = pageIdCount > 0 ? `AND page.id IN (${Array.from({ length: pageIdCount }, () => '?').join(', ')})` : '';
  return `SELECT page.id, page.document_upload_id, page.page_number,
      page.source_version, page.extracted_text, document.document_kind
    FROM source_pages page
    JOIN document_uploads document ON document.id = page.document_upload_id
    JOIN ocr_jobs job ON job.id = page.ocr_job_id
    JOIN service_cases service_case ON service_case.id = document.case_id
    WHERE service_case.id = ?
      ${pageFilter}
      AND document.household_id = service_case.household_id
      AND document.lifecycle_state = 'active'
      AND document.malware_status = 'clean'
      AND document.encryption_status = 'encrypted_local'
      AND job.status = 'succeeded'
      AND page.output_contract_version = 'knowvia.ocr.v1'
      AND page.extraction_status IN ('extracted', 'manual_verified')
      AND page.extracted_text IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM consent_grants consent
        JOIN consent_scopes scope ON scope.consent_grant_id = consent.id
        WHERE consent.household_id = service_case.household_id
          AND consent.subject_adult_id = (${ANALYSIS_SUBJECT_SQL})
          AND consent.purpose = 'document_processing'
          AND consent.revoked_at IS NULL
          AND (consent.expires_at IS NULL OR julianday(consent.expires_at) > julianday(?))
          AND scope.resource_type = 'document'
          AND scope.resource_id = document.id
          AND scope.action = 'derive'
          AND scope.data_category = 'insurance_document'
          AND scope.recipient = ?
      )
    ORDER BY document.uploaded_at, document.id, page.page_number`;
}

// Placeholder policy that parameter records reference until a run's evidence is
// classified to a real policy. Created on demand as an unverified, unknown-kind
// policy; any other policy id must already exist (fail closed).
const UNCLASSIFIED_POLICY_ID = /^UNCLASSIFIED:[a-f0-9]{24}$/;
const PARAMETER_UPDATED_BY = 'coverage-analysis-run-creation';

const deny = reasonCode => Object.freeze({ allowed: false, reasonCode });

function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

export function createCoverageAnalysisPort({ database, services, modelRecipient = GEMINI_MODEL_RECIPIENT, clock = () => new Date() }) {
  if (!database || !services?.cases || !services?.consents || !services?.workflows || !services?.audit) {
    throw new TypeError('Database, case, consent, workflow and audit services are required.');
  }
  if (typeof modelRecipient !== 'string' || modelRecipient.trim() === '') {
    throw new TypeError('A named model recipient is required for model-bound source selection.');
  }
  const loadCaseRecord = caseId => database.prepare(`SELECT service_case.id, service_case.household_id,
      service_case.opened_by_adult_id, (${ANALYSIS_SUBJECT_SQL}) AS analysis_subject_adult_id,
      (${ANALYSIS_MEMBER_SQL}) AS analysis_subject_member_id
    FROM service_cases service_case WHERE service_case.id = ?`).get(caseId) ?? null;
  // Coverage-reconstruction consent must be granted by the analysis subject.
  // A missing subject never reaches requireActive, which would skip the subject
  // comparison for a falsy subject.
  const requireSubjectCoverageConsent = (consentGrantId, caseRecord, at) => {
    if (!caseRecord?.analysis_subject_adult_id) {
      throw Object.assign(new Error('Active subject-scoped consent is required.'), { code: 'CONSENT_REQUIRED' });
    }
    return services.consents.requireActive(consentGrantId, {
      subjectAdultId: caseRecord.analysis_subject_adult_id,
      purpose: 'coverage_reconstruction',
      resourceType: 'case',
      resourceId: caseRecord.id,
      action: 'derive',
      dataCategory: 'insurance_document',
      ...(at ? { at } : {}),
    });
  };
  function evaluateModelDispatch(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return { decision: deny('DISPATCH_REQUEST_INVALID') };
    const runId = boundedId(request.runId);
    const caseId = boundedId(request.caseId);
    const subjectId = boundedId(request.subjectId);
    if (!runId || !caseId || !subjectId || typeof request.task !== 'string') return { decision: deny('DISPATCH_REQUEST_INVALID') };
    if (request.modelRecipient !== modelRecipient) return { decision: deny('MODEL_RECIPIENT_MISMATCH') };

    const sourceIds = request.authorizedSourceIds;
    if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > MAX_DISPATCH_SOURCES
      || sourceIds.some(id => !boundedId(id)) || new Set(sourceIds).size !== sourceIds.length) {
      return { decision: deny('AUTHORIZED_SOURCES_INVALID') };
    }
    const pairs = request.authorizedSources;
    if (!Array.isArray(pairs) || pairs.length !== sourceIds.length) return { decision: deny('AUTHORIZED_SOURCES_INVALID') };
    const documentBySource = new Map();
    for (const pair of pairs) {
      if (!boundedId(pair?.sourceId) || !boundedId(pair?.documentId) || documentBySource.has(pair.sourceId)) return { decision: deny('AUTHORIZED_SOURCES_INVALID') };
      documentBySource.set(pair.sourceId, pair.documentId);
    }
    if (sourceIds.some(id => !documentBySource.has(id))) return { decision: deny('AUTHORIZED_SOURCES_INVALID') };

    const run = database.prepare(`SELECT id, case_id, execution_mode, status, consent_grant_id, input_json
      FROM workflow_runs WHERE id = ?`).get(runId);
    if (!run || run.case_id !== caseId || run.execution_mode !== 'live' || !ACTIVE_RUN_STATUSES.has(run.status)) {
      return { decision: deny('RUN_NOT_DISPATCHABLE') };
    }
    const caseRecord = loadCaseRecord(caseId);
    if (!caseRecord) return { decision: deny('RUN_NOT_DISPATCHABLE') };
    if (!caseRecord.analysis_subject_adult_id || caseRecord.analysis_subject_adult_id !== subjectId) {
      return { decision: deny('SUBJECT_MISMATCH'), caseRecord };
    }

    // The dispatch may only use sources the server persisted for this run at
    // selection time, with the same source -> document mapping.
    const persisted = parse(run.input_json);
    const persistedSourceIds = new Set(Array.isArray(persisted?.authorizedSourceIds) ? persisted.authorizedSourceIds : []);
    const persistedDocuments = new Map((Array.isArray(persisted?.authorizedSources) ? persisted.authorizedSources : [])
      .map(pair => [pair?.sourceId, pair?.documentId]));
    if (sourceIds.some(id => !persistedSourceIds.has(id) || persistedDocuments.get(id) !== documentBySource.get(id))) {
      return { decision: deny('SOURCE_NOT_SELECTED_FOR_RUN'), caseRecord };
    }

    const at = clock().toISOString();
    try {
      requireSubjectCoverageConsent(run.consent_grant_id, caseRecord, at);
    } catch {
      return { decision: deny('COVERAGE_CONSENT_NOT_CURRENT'), caseRecord };
    }

    const eligible = new Map(database.prepare(eligibleSourcePagesSql(sourceIds.length))
      .all(caseId, ...sourceIds, at, modelRecipient)
      .map(row => [row.id, row.document_upload_id]));
    if (sourceIds.some(id => eligible.get(id) !== documentBySource.get(id))) {
      return { decision: deny('SOURCE_CONSENT_NOT_CURRENT'), caseRecord };
    }
    return { decision: Object.freeze({ allowed: true, reasonCode: null }), caseRecord };
  }
  const getJob = runId => {
    const run = services.workflows.getRun(runId);
    if (!run) return null;
    const tasks = database.prepare('SELECT * FROM workflow_tasks WHERE workflow_run_id = ? ORDER BY created_at, id').all(runId);
    return { ...run, tasks };
  };
  return Object.freeze({
    // The case record carries `analysis_subject_adult_id`, the single analysis
    // subject used for consent, source selection and dispatch validation.
    getCase(caseId) {
      const record = services.cases.get(caseId);
      if (!record) return null;
      const subject = loadCaseRecord(caseId);
      return {
        ...record,
        analysis_subject_adult_id: subject?.analysis_subject_adult_id ?? null,
        analysis_subject_member_id: subject?.analysis_subject_member_id ?? null,
      };
    },
    // The subject is re-derived from the database, never taken from the caller.
    requireCoverageConsent({ caseRecord, consentGrantId }) {
      return requireSubjectCoverageConsent(consentGrantId, loadCaseRecord(caseRecord?.id));
    },
    findIdempotency({ scope, key, at }) {
      database.prepare(`DELETE FROM idempotency_keys
        WHERE scope = ? AND idempotency_key = ? AND julianday(expires_at) <= julianday(?)`).run(scope, key, at);
      return database.prepare('SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?').get(scope, key) ?? null;
    },
    recordIdempotency({ scope, key, requestDigest, responseStatus, response, expiresAt }) {
      database.prepare(`INSERT INTO idempotency_keys
        (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(scope, key, requestDigest, responseStatus, JSON.stringify(response), expiresAt, new Date().toISOString());
    },
    createRunWithTasks(input) { return services.workflows.createRunWithTasks(input); },
    // Creates a run, its tasks, its registry pin and one explicit parameter
    // record per registry key in ONE transaction, so a run never exists without
    // pinned parameter records. Any failure (unknown registry version, scope
    // mismatch, audit failure) rolls the whole creation back. `parameters`:
    // { registryVersion, householdId, caseId, subjectId, policyId,
    //   requestedKeys, receivedKeys } where subjectId is a household member id.
    createRunWithParameters({ tasks = [], parameters, ...runInput }) {
      const repository = services.coverageParameters;
      if (typeof repository?.initializeRunParameters !== 'function' || typeof repository?.setAcquisitionStateForRun !== 'function'
        || typeof services.workflows.createRun !== 'function' || typeof services.workflows.insertTask !== 'function') {
        throw Object.assign(new Error('Coverage parameter persistence is not configured.'), { code: 'PARAMETER_RECORDS_NOT_CONFIGURED', statusCode: 503 });
      }
      if (!parameters || typeof parameters !== 'object') throw new TypeError('Parameter record scope is required to create a run.');
      const requestedKeys = parameters.requestedKeys ?? [];
      const receivedKeys = parameters.receivedKeys ?? [];
      if (!Array.isArray(requestedKeys) || !Array.isArray(receivedKeys)
        || receivedKeys.some(key => !requestedKeys.includes(key))) {
        throw new TypeError('Received parameters must also be requested parameters.');
      }
      database.exec('BEGIN IMMEDIATE');
      try {
        const run = services.workflows.createRun(runInput);
        const tasksByKey = new Map();
        for (const definition of tasks) {
          const dependencyTaskIds = (definition.dependsOn ?? []).map(key => {
            const task = tasksByKey.get(key);
            if (!task) throw new Error(`Workflow dependency is not defined before use: ${key}`);
            return task.id;
          });
          tasksByKey.set(definition.key, services.workflows.insertTask({
            ...definition, runId: run.id, dependencyTaskIds, at: clock().toISOString(),
          }));
        }
        const { householdId, caseId, subjectId, policyId, registryVersion } = parameters;
        if (typeof policyId === 'string' && UNCLASSIFIED_POLICY_ID.test(policyId)) {
          const at = clock().toISOString();
          database.prepare(`INSERT OR IGNORE INTO policies
            (id, household_id, policy_kind, verification_state, created_at, updated_at)
            VALUES (?, ?, 'unknown', 'unverified', ?, ?)`).run(policyId, householdId, at, at);
        }
        const initialized = repository.initializeRunParameters({
          workflowRunId: run.id, registryVersion, householdId, caseId, subjectId, policyId, updatedBy: PARAMETER_UPDATED_BY,
        });
        if (requestedKeys.length > 0) {
          repository.setAcquisitionStateForRun({ workflowRunId: run.id, parameterKeys: requestedKeys, state: 'requested', updatedBy: PARAMETER_UPDATED_BY });
        }
        if (receivedKeys.length > 0) {
          repository.setAcquisitionStateForRun({ workflowRunId: run.id, parameterKeys: receivedKeys, state: 'received', updatedBy: PARAMETER_UPDATED_BY });
        }
        // Counts and registry version only; no values, keys or text.
        services.audit.append({
          householdId,
          caseId,
          action: 'analysis.parameters_initialized',
          resourceType: 'workflow_run',
          resourceId: run.id,
          payload: { registryVersion, parameterCount: initialized.total, requested: requestedKeys.length, received: receivedKeys.length },
        });
        database.exec('COMMIT');
        return { ...services.workflows.getRun(run.id), tasks: [...tasksByKey.values()] };
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    // Commit-time re-check for a live run: every source the server selected for
    // the run must still be eligible under current consent. Uses the same
    // evaluation as the pre-dispatch validator (one eligibility rule) but is not
    // a dispatch, so it is not audited as one. Any denial or error denies.
    verifyRunSourcesCurrent(runId) {
      let decision;
      try {
        const run = database.prepare('SELECT id, case_id, input_json FROM workflow_runs WHERE id = ?').get(runId);
        const persisted = run ? parse(run.input_json) : null;
        const caseRecord = run ? loadCaseRecord(run.case_id) : null;
        decision = evaluateModelDispatch({
          task: 'commit_recheck',
          runId,
          caseId: run?.case_id,
          subjectId: caseRecord?.analysis_subject_adult_id,
          modelRecipient,
          authorizedSourceIds: persisted?.authorizedSourceIds,
          authorizedSources: persisted?.authorizedSources,
        }).decision;
      } catch {
        decision = deny('COMMIT_RECHECK_ERROR');
      }
      return decision;
    },
    // Source selection for live (model-bound) analysis. Only documents whose
    // derive scope names the configured model recipient are admitted.
    getCoverageSourcePages(caseId) {
      const at = clock().toISOString();
      return database.prepare(eligibleSourcePagesSql()).all(caseId, at, modelRecipient);
    },
    // Production pre-dispatch validator. Called immediately before every
    // provider call with the authorization registered for that exact request.
    // Returns { allowed: true } only when every authorized source is still
    // eligible under current consent; any mismatch, missing data or internal
    // error denies. Each decision is audited with id-free metadata only.
    authorizeModelDispatch(request) {
      let decision;
      let caseRecord = null;
      try {
        ({ decision, caseRecord } = evaluateModelDispatch(request));
      } catch {
        decision = deny('DISPATCH_VALIDATION_ERROR');
      }
      // Audit metadata is read defensively: a hostile or malformed request must
      // not turn a denial into an exception, and no request content is echoed.
      const safeRead = read => { try { return read(); } catch { return undefined; } };
      const sourceIds = safeRead(() => request.authorizedSourceIds);
      const task = safeRead(() => request.task);
      const runId = safeRead(() => request.runId);
      try {
        services.audit.append({
          householdId: caseRecord?.household_id ?? null,
          caseId: caseRecord?.id ?? null,
          action: decision.allowed ? 'analysis.model_dispatch_authorized' : 'analysis.model_dispatch_denied',
          resourceType: 'workflow_run',
          resourceId: (decision.allowed || caseRecord ? boundedId(runId) : null) ?? 'unresolved-run',
          payload: {
            task: typeof task === 'string' && /^[a-z_]{1,80}$/.test(task) ? task : 'invalid',
            modelRecipient,
            sourceCount: Array.isArray(sourceIds) ? Math.min(sourceIds.length, MAX_DISPATCH_SOURCES + 1) : 0,
            reasonCode: decision.allowed ? null : decision.reasonCode,
          },
        });
      } catch {
        // A decision that cannot be audited is not allowed.
        return deny('DISPATCH_AUDIT_FAILED');
      }
      return decision;
    },
    getJob,
    getTask: taskId => services.workflows.getTask(taskId),
    claimNext: input => services.workflows.claimNext(input),
    dependencyOutputs(taskId) {
      const rows = database.prepare(`SELECT prerequisite.input_json, prerequisite.output_json
        FROM workflow_task_dependencies dependency
        JOIN workflow_tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
        WHERE dependency.workflow_task_id = ? ORDER BY prerequisite.created_at, prerequisite.id`).all(taskId);
      return Object.fromEntries(rows.map(row => [parse(row.input_json).key, parse(row.output_json)]));
    },
    completeTask(taskId, input) { return services.workflows.completeTask(taskId, input); },
    failTask(taskId, input) { return services.workflows.failTask(taskId, input); },
    recoverExpiredLeases() { return services.workflows.recoverExpiredLeases(); },
    // Same julianday semantics as source selection: an unparseable expiry or
    // check time is treated as expired (fail closed).
    isConsentActive(grantId, at) {
      return Boolean(database.prepare(`SELECT 1 FROM consent_grants
        WHERE id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))`).get(grantId, at));
    },
    // `reason` is the id-free audit reason; the terminal reason stays CONSENT_REVOKED.
    stopForRevocation(runId, { reason = 'consent_not_active', reasonCode = null } = {}) {
      const run = services.workflows.getRun(runId);
      if (!run) return null;
      const at = new Date().toISOString();
      database.exec('BEGIN IMMEDIATE');
      try {
        database.prepare(`UPDATE workflow_tasks SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED',
          lease_owner = NULL, lease_expires_at = NULL WHERE workflow_run_id = ? AND status IN ('pending', 'running')`).run(at, runId);
        database.prepare(`UPDATE workflow_runs SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED'
          WHERE id = ?`).run(at, runId);
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      services.audit.append({
        householdId: services.cases.get(run.case_id)?.household_id ?? null,
        caseId: run.case_id,
        action: 'analysis.revoked',
        resourceType: 'workflow_run',
        resourceId: runId,
        payload: { reason, ...(reasonCode ? { reasonCode } : {}) },
      });
      return getJob(runId);
    },
    persistTaskArtifact({ run, task, taskKey, output }) {
      services.audit.append({
        householdId: services.cases.get(run.case_id)?.household_id ?? null,
        caseId: run.case_id,
        action: 'analysis.task_completed',
        resourceType: 'workflow_task',
        resourceId: task.id,
        payload: { taskKey, outputDigest: digest(output) },
      });
    },
  });
}
