import { createHash } from 'node:crypto';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function parse(value) {
  return value === null ? null : JSON.parse(value);
}

export function createCoverageAnalysisPort({ database, services }) {
  if (!database || !services?.cases || !services?.consents || !services?.workflows || !services?.audit) {
    throw new TypeError('Database, case, consent, workflow and audit services are required.');
  }
  const getJob = runId => {
    const run = services.workflows.getRun(runId);
    if (!run) return null;
    const tasks = database.prepare('SELECT * FROM workflow_tasks WHERE workflow_run_id = ? ORDER BY created_at, id').all(runId);
    return { ...run, tasks };
  };
  return Object.freeze({
    getCase: caseId => services.cases.get(caseId),
    requireCoverageConsent({ caseRecord, consentGrantId }) {
      return services.consents.requireActive(consentGrantId, {
        subjectAdultId: caseRecord.opened_by_adult_id,
        purpose: 'coverage_reconstruction',
        resourceType: 'case',
        resourceId: caseRecord.id,
        action: 'derive',
        dataCategory: 'insurance_document',
      });
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
    getCoverageSourcePages(caseId) {
      return database.prepare(`SELECT page.id, page.document_upload_id, page.page_number,
          page.source_version, page.extracted_text, document.document_kind
        FROM source_pages page
        JOIN document_uploads document ON document.id = page.document_upload_id
        JOIN ocr_jobs job ON job.id = page.ocr_job_id
        WHERE document.case_id = ?
          AND document.lifecycle_state = 'active'
          AND document.malware_status = 'clean'
          AND document.encryption_status = 'encrypted_local'
          AND job.status = 'succeeded'
          AND page.output_contract_version = 'knowvia.ocr.v1'
          AND page.extraction_status IN ('extracted', 'manual_verified')
          AND page.extracted_text IS NOT NULL
        ORDER BY document.uploaded_at, document.id, page.page_number`).all(caseId);
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
    isConsentActive(grantId, at) {
      const grant = services.consents.get(grantId);
      return Boolean(grant && !grant.revoked_at && (!grant.expires_at || grant.expires_at > at));
    },
    stopForRevocation(runId) {
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
        payload: { reason: 'consent_not_active' },
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
