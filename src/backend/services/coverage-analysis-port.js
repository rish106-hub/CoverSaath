import { createHash } from 'node:crypto';
import { GEMINI_MODEL_RECIPIENT, opaqueSourceId } from '../../features/ai-analysis/privacy-evidence-gate.js';
import { modelObservationCandidates } from '../../features/coverage-analysis/model-observations.js';
import { householdLock, idempotencyLock } from '../database/postgres/locks.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textDigest = value => createHash('sha256').update(value, 'utf8').digest('hex');
const MODEL_OBSERVATION_RECORDER = 'coverage-analysis-runtime';
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

// One eligibility predicate shared by source selection, the pre-dispatch
// re-check and the in-transaction re-check at run creation, so they can never
// drift apart. A page is eligible only while its document is active, clean,
// encrypted, successfully OCR'd, and covered by a current (not revoked, not
// expired) document_processing grant from the case subject in the same
// household whose scope names exactly this document, action 'derive', category
// 'insurance_document' and the intended model recipient. `scope.recipient = ?`
// never matches NULL: a scope without a named recipient does not authorise
// model disclosure (fail closed).
// Parameters: caseId, [page ids as one text[] when filtered], at, recipient.
function eligibleSourcePagesSql({ filterByPageIds = false } = {}) {
  const pageFilter = filterByPageIds ? 'AND page.id = ANY(CAST(? AS text[]))' : '';
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

const DELETE_EXPIRED_IDEMPOTENCY_SQL = `DELETE FROM idempotency_keys
  WHERE scope = ? AND idempotency_key = ? AND julianday(expires_at) <= julianday(?)`;
const SELECT_IDEMPOTENCY_SQL = 'SELECT * FROM idempotency_keys WHERE scope = ? AND idempotency_key = ?';
const INSERT_IDEMPOTENCY_SQL = `INSERT INTO idempotency_keys
  (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`;

function boundedId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

// Known-identifier limits mirror the privacy gate contract: at most 200 entries,
// each value 1-200 characters. A household that would exceed the bound fails
// closed rather than being truncated (a dropped identifier would go unredacted).
const MAX_KNOWN_IDENTIFIERS = 200;
const MAX_KNOWN_IDENTIFIER_CHARS = 200;
const KNOWN_IDENTIFIER_SQL_LIMIT = MAX_KNOWN_IDENTIFIERS + 1;

function knownIdentifiersUnavailable(message) {
  return Object.assign(new Error(message), { code: 'KNOWN_IDENTIFIERS_UNAVAILABLE', statusCode: 503 });
}

function validIdempotency(idempotency) {
  return idempotency !== null && typeof idempotency === 'object' && typeof idempotency.scope === 'string'
    && typeof idempotency.key === 'string' && typeof idempotency.requestDigest === 'string'
    && typeof idempotency.expiresAt === 'string' && Number.isInteger(idempotency.responseStatus)
    && idempotency.response !== null && typeof idempotency.response === 'object';
}

// `database` is the async PostgreSQL interface (src/backend/database/postgres/db.js).
// Every database and repository call is awaited: a check that is not awaited sees
// a pending Promise (truthy, no rows, no throw) and fails open.
export function createCoverageAnalysisPort({ database, services, modelRecipient = GEMINI_MODEL_RECIPIENT, clock = () => new Date() }) {
  if (!database || !services?.cases || !services?.consents || !services?.workflows || !services?.audit) {
    throw new TypeError('Database, case, consent, workflow and audit services are required.');
  }
  if (typeof modelRecipient !== 'string' || modelRecipient.trim() === '') {
    throw new TypeError('A named model recipient is required for model-bound source selection.');
  }
  const loadCaseRecord = async caseId => (await database.one(`SELECT service_case.id, service_case.household_id,
      service_case.opened_by_adult_id, (${ANALYSIS_SUBJECT_SQL}) AS analysis_subject_adult_id,
      (${ANALYSIS_MEMBER_SQL}) AS analysis_subject_member_id
    FROM service_cases service_case WHERE service_case.id = ?`, [caseId])) ?? null;
  // The household of a case, for the audit chain and the household lock. A missing
  // case gives null (the global chain), never a Promise.
  const householdOfCase = async caseId => (await services.cases.get(caseId))?.household_id ?? null;
  // Pages among `sourceIds` that are eligible at `at`, as page id -> document id.
  const eligibleDocumentsBySource = async (caseId, sourceIds, at) => new Map(
    (await database.many(eligibleSourcePagesSql({ filterByPageIds: true }), [caseId, sourceIds, at, modelRecipient]))
      .map(row => [row.id, row.document_upload_id]),
  );
  // Coverage-reconstruction consent must be granted by the analysis subject.
  // A missing subject never reaches requireActive, which would skip the subject
  // comparison for a falsy subject.
  const requireSubjectCoverageConsent = async (consentGrantId, caseRecord, at) => {
    if (!caseRecord?.analysis_subject_adult_id) {
      throw Object.assign(new Error('Active subject-scoped consent is required.'), { code: 'CONSENT_REQUIRED' });
    }
    return await services.consents.requireActive(consentGrantId, {
      subjectAdultId: caseRecord.analysis_subject_adult_id,
      purpose: 'coverage_reconstruction',
      resourceType: 'case',
      resourceId: caseRecord.id,
      action: 'derive',
      dataCategory: 'insurance_document',
      ...(at ? { at } : {}),
    });
  };
  async function evaluateModelDispatch(request) {
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

    const run = await database.one(`SELECT id, case_id, execution_mode, status, consent_grant_id, input_json
      FROM workflow_runs WHERE id = ?`, [runId]);
    if (!run || run.case_id !== caseId || run.execution_mode !== 'live' || !ACTIVE_RUN_STATUSES.has(run.status)) {
      return { decision: deny('RUN_NOT_DISPATCHABLE') };
    }
    const caseRecord = await loadCaseRecord(caseId);
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
      await requireSubjectCoverageConsent(run.consent_grant_id, caseRecord, at);
    } catch {
      return { decision: deny('COVERAGE_CONSENT_NOT_CURRENT'), caseRecord };
    }

    const eligible = await eligibleDocumentsBySource(caseId, sourceIds, at);
    if (sourceIds.some(id => eligible.get(id) !== documentBySource.get(id))) {
      return { decision: deny('SOURCE_CONSENT_NOT_CURRENT'), caseRecord };
    }
    return { decision: Object.freeze({ allowed: true, reasonCode: null }), caseRecord };
  }
  // One audited dispatch decision; the caller holds the household lock. The evaluation
  // runs in a savepoint so a failed query denies without aborting the audit insert.
  async function auditedDispatchDecision(request, safeRead) {
    let decision;
    let caseRecord = null;
    try {
      ({ decision, caseRecord } = await database.transaction(() => evaluateModelDispatch(request)));
    } catch {
      decision = deny('DISPATCH_VALIDATION_ERROR');
    }
    const sourceIds = safeRead(() => request.authorizedSourceIds);
    const task = safeRead(() => request.task);
    const runId = safeRead(() => request.runId);
    try {
      await services.audit.append({
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
  }
  // Documents of a run whose persisted sources are no longer eligible under
  // current consent. Used to scope derived-data erasure; an empty result means
  // the cause could not be attributed to documents and the whole run is erased.
  async function staleDocumentsOfRun(run, at) {
    const persisted = (() => { try { return parse(run.input_json); } catch { return null; } })();
    const pairs = Array.isArray(persisted?.authorizedSources) ? persisted.authorizedSources : [];
    const sourceIds = pairs.map(pair => pair?.sourceId).filter(id => boundedId(id));
    if (sourceIds.length === 0 || sourceIds.length > MAX_DISPATCH_SOURCES) return [];
    const eligible = await eligibleDocumentsBySource(run.case_id, sourceIds, at);
    return [...new Set(pairs
      .filter(pair => boundedId(pair?.sourceId) && boundedId(pair?.documentId) && eligible.get(pair.sourceId) !== pair.documentId)
      .map(pair => pair.documentId))];
  }
  // Decision 4: inside createRunWithParameters' transaction, under the household
  // lock that revocation also takes, every source a live run was built from must
  // still be eligible with the same source -> document mapping. A revocation that
  // committed after source selection therefore creates no run.
  async function requireRunSourcesEligible(runInput, at) {
    if (runInput.executionMode !== 'live') return;
    const pairs = runInput.input?.authorizedSources;
    const notCurrent = () => Object.assign(new Error('A selected source is no longer covered by current consent.'), {
      code: 'CONSENT_SCOPE_REQUIRED', statusCode: 403,
    });
    if (!Array.isArray(pairs) || pairs.length === 0 || pairs.length > MAX_DISPATCH_SOURCES
      || pairs.some(pair => !boundedId(pair?.sourceId) || !boundedId(pair?.documentId))) {
      throw notCurrent();
    }
    const sourceIds = pairs.map(pair => pair.sourceId);
    if (new Set(sourceIds).size !== sourceIds.length) throw notCurrent();
    const eligible = await eligibleDocumentsBySource(runInput.caseId, sourceIds, at);
    if (pairs.some(pair => eligible.get(pair.sourceId) !== pair.documentId)) throw notCurrent();
  }
  const getJob = async runId => {
    const run = await services.workflows.getRun(runId);
    if (!run) return null;
    const tasks = await database.many('SELECT * FROM workflow_tasks WHERE workflow_run_id = ? ORDER BY created_at, id', [runId]);
    return { ...run, tasks };
  };
  return Object.freeze({
    // The case record carries `analysis_subject_adult_id`, the single analysis
    // subject used for consent, source selection and dispatch validation.
    async getCase(caseId) {
      const record = await services.cases.get(caseId);
      if (!record) return null;
      const subject = await loadCaseRecord(caseId);
      return {
        ...record,
        analysis_subject_adult_id: subject?.analysis_subject_adult_id ?? null,
        analysis_subject_member_id: subject?.analysis_subject_member_id ?? null,
      };
    },
    // The household's own identifiers for a case, for the privacy gate's
    // known-value redaction: member names and dates of birth, and the names,
    // emails and phone numbers of the household's adults. Household-scoped,
    // parameterised and bounded. Never persisted by callers. Fails closed:
    // an unknown case, a read error or an over-limit household throws, so no
    // model request can be built without the redaction list.
    async loadKnownIdentifiers(caseId) {
      try {
        const id = boundedId(caseId);
        const record = id ? await loadCaseRecord(id) : null;
        if (!record?.household_id) throw knownIdentifiersUnavailable('The case household could not be resolved.');
        const members = await database.many(`SELECT display_name, date_of_birth FROM household_members
          WHERE household_id = ? ORDER BY created_at, id LIMIT ?`, [record.household_id, KNOWN_IDENTIFIER_SQL_LIMIT]);
        const adults = await database.many(`SELECT adult.display_name, adult.contact_email, adult.contact_phone FROM adult_users adult
          WHERE adult.id IN (
            SELECT adult_user_id FROM household_members WHERE household_id = ? AND adult_user_id IS NOT NULL
            UNION
            SELECT adult_user_id FROM household_roles WHERE household_id = ?)
          ORDER BY adult.created_at, adult.id LIMIT ?`, [record.household_id, record.household_id, KNOWN_IDENTIFIER_SQL_LIMIT]);
        if (members.length > MAX_KNOWN_IDENTIFIERS || adults.length > MAX_KNOWN_IDENTIFIERS) {
          throw knownIdentifiersUnavailable('The household has more identifiers than the privacy gate accepts.');
        }
        const seen = new Set();
        const identifiers = [];
        const add = (kind, value) => {
          if (typeof value !== 'string') return;
          // Control and format characters would make the gate reject the whole list.
          const trimmed = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, MAX_KNOWN_IDENTIFIER_CHARS).trim();
          if (trimmed === '') return;
          const key = `${kind}\u0000${trimmed.normalize('NFKC').toLowerCase()}`;
          if (seen.has(key)) return;
          seen.add(key);
          identifiers.push({ kind, value: trimmed });
        };
        for (const member of members) { add('NAME', member.display_name); add('DOB', member.date_of_birth); }
        for (const adult of adults) { add('NAME', adult.display_name); add('EMAIL', adult.contact_email); add('PHONE', adult.contact_phone); }
        if (identifiers.length > MAX_KNOWN_IDENTIFIERS) {
          throw knownIdentifiersUnavailable('The household has more identifiers than the privacy gate accepts.');
        }
        return identifiers;
      } catch (error) {
        throw error?.code === 'KNOWN_IDENTIFIERS_UNAVAILABLE' ? error : knownIdentifiersUnavailable('Household identifiers could not be loaded.');
      }
    },
    // The subject is re-derived from the database, never taken from the caller.
    async requireCoverageConsent({ caseRecord, consentGrantId }) {
      return requireSubjectCoverageConsent(consentGrantId, await loadCaseRecord(caseRecord?.id));
    },
    async findIdempotency({ scope, key, at }) {
      await database.run(DELETE_EXPIRED_IDEMPOTENCY_SQL, [scope, key, at]);
      return (await database.one(SELECT_IDEMPOTENCY_SQL, [scope, key])) ?? null;
    },
    // For ports without in-transaction idempotency. The persistent service calls it
    // only when createRunWithParameters did not record the key itself.
    async recordIdempotency({ scope, key, requestDigest, responseStatus, response, expiresAt }) {
      await database.run(INSERT_IDEMPOTENCY_SQL, [scope, key, requestDigest, responseStatus, JSON.stringify(response), expiresAt, new Date().toISOString()]);
    },
    async createRunWithTasks(input) { return services.workflows.createRunWithTasks(input); },
    // Creates a run, its tasks, its registry pin and one explicit parameter
    // record per registry key in ONE transaction, so a run never exists without
    // pinned parameter records. Any failure (unknown registry version, scope
    // mismatch, audit failure) rolls the whole creation back. `parameters`:
    // { registryVersion, householdId, caseId, subjectId, policyId,
    //   requestedKeys, receivedKeys } where subjectId is a household member id.
    //
    // Locks (design section 3): the household advisory lock, then the idempotency
    // lock. With `idempotency` (decision 1: { scope, key, requestDigest,
    // responseStatus, response, expiresAt }) the key is re-read inside the
    // transaction: a live key returns { existing } and creates nothing; otherwise
    // the run and the key commit together, so concurrent requests with one key
    // create one run. A live run re-checks its sources first (decision 4).
    async createRunWithParameters({ tasks = [], parameters, idempotency = null, ...runInput }) {
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
      if (idempotency !== null && !validIdempotency(idempotency)) {
        throw new TypeError('Idempotency needs scope, key, requestDigest, responseStatus, response and expiresAt.');
      }
      const { householdId, caseId, subjectId, policyId, registryVersion } = parameters;
      const locks = [householdLock(householdId ?? null)];
      if (idempotency) locks.push(idempotencyLock(idempotency.scope, idempotency.key));
      return database.transaction(async () => {
        const at = clock().toISOString();
        if (idempotency) {
          await database.run(DELETE_EXPIRED_IDEMPOTENCY_SQL, [idempotency.scope, idempotency.key, at]);
          const existing = await database.one(SELECT_IDEMPOTENCY_SQL, [idempotency.scope, idempotency.key]);
          if (existing) return { existing };
        }
        await requireRunSourcesEligible(runInput, at);
        const run = await services.workflows.createRun(runInput);
        const tasksByKey = new Map();
        for (const definition of tasks) {
          const dependencyTaskIds = (definition.dependsOn ?? []).map(key => {
            const task = tasksByKey.get(key);
            if (!task) throw new Error(`Workflow dependency is not defined before use: ${key}`);
            return task.id;
          });
          tasksByKey.set(definition.key, await services.workflows.insertTask({
            ...definition, runId: run.id, dependencyTaskIds, at: clock().toISOString(),
          }));
        }
        if (typeof policyId === 'string' && UNCLASSIFIED_POLICY_ID.test(policyId)) {
          const createdAt = clock().toISOString();
          await database.run(`INSERT INTO policies
            (id, household_id, policy_kind, verification_state, created_at, updated_at)
            VALUES (?, ?, 'unknown', 'unverified', ?, ?)
            ON CONFLICT (id) DO NOTHING`, [policyId, householdId, createdAt, createdAt]);
        }
        const initialized = await repository.initializeRunParameters({
          workflowRunId: run.id, registryVersion, householdId, caseId, subjectId, policyId, updatedBy: PARAMETER_UPDATED_BY,
        });
        if (requestedKeys.length > 0) {
          await repository.setAcquisitionStateForRun({ workflowRunId: run.id, parameterKeys: requestedKeys, state: 'requested', updatedBy: PARAMETER_UPDATED_BY });
        }
        if (receivedKeys.length > 0) {
          await repository.setAcquisitionStateForRun({ workflowRunId: run.id, parameterKeys: receivedKeys, state: 'received', updatedBy: PARAMETER_UPDATED_BY });
        }
        // Counts and registry version only; no values, keys or text.
        await services.audit.append({
          householdId,
          caseId,
          action: 'analysis.parameters_initialized',
          resourceType: 'workflow_run',
          resourceId: run.id,
          payload: { registryVersion, parameterCount: initialized.total, requested: requestedKeys.length, received: receivedKeys.length },
        });
        if (idempotency) {
          await database.run(INSERT_IDEMPOTENCY_SQL, [
            idempotency.scope, idempotency.key, idempotency.requestDigest, idempotency.responseStatus,
            JSON.stringify(idempotency.response), idempotency.expiresAt, at,
          ]);
        }
        const created = await services.workflows.getRun(run.id);
        return { ...created, tasks: [...tasksByKey.values()], ...(idempotency ? { idempotencyRecorded: true } : {}) };
      }, { locks });
    },
    // Commit-time re-check for a live run: every source the server selected for
    // the run must still be eligible under current consent. Uses the same
    // evaluation as the pre-dispatch validator (one eligibility rule) but is not
    // a dispatch, so it is not audited as one. Any denial, error or rejection denies.
    async verifyRunSourcesCurrent(runId) {
      let decision;
      try {
        const run = await database.one('SELECT id, case_id, input_json FROM workflow_runs WHERE id = ?', [runId]);
        const persisted = run ? parse(run.input_json) : null;
        const caseRecord = run ? await loadCaseRecord(run.case_id) : null;
        decision = (await evaluateModelDispatch({
          task: 'commit_recheck',
          runId,
          caseId: run?.case_id,
          subjectId: caseRecord?.analysis_subject_adult_id,
          modelRecipient,
          authorizedSourceIds: persisted?.authorizedSourceIds,
          authorizedSources: persisted?.authorizedSources,
        })).decision;
      } catch {
        decision = deny('COMMIT_RECHECK_ERROR');
      }
      return decision;
    },
    // Source selection for live (model-bound) analysis. Only documents whose
    // derive scope names the configured model recipient are admitted.
    async getCoverageSourcePages(caseId) {
      const at = clock().toISOString();
      return database.many(eligibleSourcePagesSql(), [caseId, at, modelRecipient]);
    },
    // Production pre-dispatch validator. Called immediately before every
    // provider call with the authorization registered for that exact request.
    // Returns { allowed: true } only when every authorized source is still
    // eligible under current consent; any mismatch, missing data, internal
    // error or rejected query denies. Each decision is audited with id-free
    // metadata only.
    async authorizeModelDispatch(request) {
      // Audit metadata is read defensively: a hostile or malformed request must
      // not turn a denial into an exception, and no request content is echoed.
      const safeRead = read => { try { return read(); } catch { return undefined; } };
      // Decision and audit run under the household lock that revocation takes, so a
      // check never reads consent that a concurrent revocation is about to commit
      // and an allowed decision is always audited before that revocation.
      let householdId = null;
      try {
        const caseId = boundedId(safeRead(() => request.caseId));
        householdId = caseId ? await householdOfCase(caseId) : null;
      } catch {
        return deny('DISPATCH_VALIDATION_ERROR');
      }
      try {
        return await database.transaction(() => auditedDispatchDecision(request, safeRead), { locks: [householdLock(householdId)] });
      } catch {
        return deny('DISPATCH_AUDIT_FAILED');
      }
    },
    getJob,
    async getTask(taskId) { return services.workflows.getTask(taskId); },
    async claimNext(input) { return services.workflows.claimNext(input); },
    async dependencyOutputs(taskId) {
      const rows = await database.many(`SELECT prerequisite.input_json, prerequisite.output_json
        FROM workflow_task_dependencies dependency
        JOIN workflow_tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
        WHERE dependency.workflow_task_id = ? ORDER BY prerequisite.created_at, prerequisite.id`, [taskId]);
      return Object.fromEntries(rows.map(row => [parse(row.input_json).key, parse(row.output_json)]));
    },
    async completeTask(taskId, input) { return services.workflows.completeTask(taskId, input); },
    async failTask(taskId, input) { return services.workflows.failTask(taskId, input); },
    async recoverExpiredLeases() { return services.workflows.recoverExpiredLeases(); },
    // Same julianday semantics as source selection: an unparseable expiry or
    // check time is treated as expired (fail closed). The row is awaited and
    // compared explicitly; a failed query rejects, so the caller cannot proceed.
    async isConsentActive(grantId, at) {
      const row = await database.one(`SELECT 1 AS active FROM consent_grants
        WHERE id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR julianday(expires_at) > julianday(?))`, [grantId, at]);
      return row !== null && row !== undefined;
    },
    // `reason` is the id-free audit reason; the terminal reason stays CONSENT_REVOKED.
    // One transaction under the household lock (the lock revocation takes):
    // erasure, the stop and its audit event commit together. Lock order: the run
    // row, then its tasks.
    async stopForRevocation(runId, { reason = 'consent_not_active', reasonCode = null } = {}) {
      const run = await services.workflows.getRun(runId);
      if (!run) return null;
      const householdId = await householdOfCase(run.case_id);
      const at = clock().toISOString();
      await database.transaction(async () => {
        if (reason === 'source_consent_not_current') {
          // A source this run was built from is no longer covered by current
          // consent: its excerpts in run input and everything derived from it are
          // erased in the same transaction as the stop. Fails closed (rolls the
          // stop back) if erasure cannot run.
          if (typeof services.consents?.eraseDerivedRunData !== 'function') {
            throw Object.assign(new Error('Derived run data erasure is not configured.'), { code: 'ERASURE_NOT_CONFIGURED', statusCode: 503 });
          }
          const stale = await staleDocumentsOfRun(run, at);
          await services.consents.eraseDerivedRunData({
            householdId,
            documentIds: stale,
            // Unattributable cause: erase the whole run rather than guess.
            runIds: stale.length === 0 ? [runId] : [],
            caseId: run.case_id,
            reason: 'source_consent_not_current',
            resourceType: 'workflow_run',
            resourceId: runId,
            at,
          });
        }
        await database.one('SELECT id FROM workflow_runs WHERE id = ? FOR UPDATE', [runId]);
        await database.run(`UPDATE workflow_tasks SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED',
          lease_owner = NULL, lease_expires_at = NULL WHERE workflow_run_id = ? AND status IN ('pending', 'running')`, [at, runId]);
        await database.run(`UPDATE workflow_runs SET status = 'revoked', finished_at = ?, terminal_reason = 'CONSENT_REVOKED'
          WHERE id = ?`, [at, runId]);
        await services.audit.append({
          householdId,
          caseId: run.case_id,
          action: 'analysis.revoked',
          resourceType: 'workflow_run',
          resourceId: runId,
          payload: { reason, ...(reasonCode ? { reasonCode } : {}) },
        });
      }, { locks: [householdLock(householdId)] });
      return getJob(runId);
    },
    // Commit-time only (after the consent re-check): the model-extracted values of a completed
    // extraction task become unverified parameter observations. Each cited opaque id is mapped
    // back to the sent page it names; a citation that maps to no sent, unredacted page is
    // dropped. Values stay extracted_unverified (or conflicting) until a reviewer resolves them.
    // Bound to the task lease; observations, lease check and counts-only audit commit together,
    // under the household lock, so a revocation that erases the run's excerpts either commits
    // first (the re-read input no longer has them) or waits. Any failure throws so the task is
    // not completed.
    async recordModelObservations({ runId, taskKey, payload, taskId, workerId }) {
      const candidates = modelObservationCandidates(taskKey, payload);
      const empty = Object.freeze({ observations: 0, parameters: 0, conflicting: 0, skipped: 0 });
      if (candidates.length === 0) return empty;
      const repository = services.coverageParameters;
      if (typeof repository?.recordModelExtraction !== 'function') {
        throw Object.assign(new Error('Coverage parameter persistence is not configured.'), { code: 'PARAMETER_RECORDS_NOT_CONFIGURED', statusCode: 503 });
      }
      const located = await database.one('SELECT case_id FROM workflow_runs WHERE id = ?', [runId]);
      if (!located) throw Object.assign(new Error('The run was not found.'), { code: 'RUN_NOT_FOUND' });
      const householdId = await householdOfCase(located.case_id);
      return database.transaction(async () => {
        const run = await database.one('SELECT id, case_id, input_json FROM workflow_runs WHERE id = ?', [runId]);
        if (!run) throw Object.assign(new Error('The run was not found.'), { code: 'RUN_NOT_FOUND' });
        const input = parse(run.input_json);
        const pages = new Map();
        for (const page of Array.isArray(input?.sourcePages) ? input.sourcePages : []) {
          if (typeof page?.text !== 'string' || page.redacted !== undefined || !boundedId(page.sourceId)) continue;
          pages.set(opaqueSourceId(page.sourceId), page);
        }
        // A citation counts only for a page whose excerpt was selected for that parameter.
        const entries = candidates.flatMap(({ parameterKey, value, sourceIds }) => sourceIds
          .map(id => pages.get(id))
          .filter(page => page && Array.isArray(page.parameterKeys) && page.parameterKeys.includes(parameterKey))
          .map(page => ({
            parameterKey, value, sourceId: page.sourceId, documentId: page.documentId,
            version: page.version, page: page.page, sourceDigest: textDigest(page.text),
          })));
        if (entries.length === 0) return empty;
        return await repository.recordModelExtraction({
          workflowRunId: runId, entries, recordedBy: MODEL_OBSERVATION_RECORDER, taskKey,
          lease: { taskId, workerId }, at: clock().toISOString(),
        });
      }, { locks: [householdLock(householdId)] });
    },
    async persistTaskArtifact({ run, task, taskKey, output }) {
      await services.audit.append({
        householdId: await householdOfCase(run.case_id),
        caseId: run.case_id,
        action: 'analysis.task_completed',
        resourceType: 'workflow_task',
        resourceId: task.id,
        payload: { taskKey, outputDigest: digest(output) },
      });
    },
  });
}
