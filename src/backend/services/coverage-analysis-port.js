import { createHash } from 'node:crypto';
import { jsonParam } from '../database/value-codec.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function parse(value) {
  return value === null ? null : JSON.parse(value);
}

export function createCoverageAnalysisPort({ database, services }) {
  if (!database || !services?.cases || !services?.consents || !services?.workflows || !services?.audit) {
    throw new TypeError('Database, case, consent, workflow and audit services are required.');
  }
  const getJob = async runId => {
    const run = await services.workflows.getRun(runId);
    if (!run) return null;
    const tasks = await database.query('SELECT * FROM workflow_tasks WHERE workflow_run_id = $1 ORDER BY created_at, id', [runId]);
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
    async findIdempotency({ scope, key, at }) {
      await database.query(`DELETE FROM idempotency_keys
        WHERE scope = $1 AND idempotency_key = $2 AND expires_at <= $3`, [scope, key, at]);
      return database.one('SELECT * FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2', [scope, key]);
    },
    /** First writer wins. A concurrent writer with the same key must not fail the request after its run was created. */
    async recordIdempotency({ scope, key, requestDigest, responseStatus, response, expiresAt }) {
      const result = await database.run(`INSERT INTO idempotency_keys
        (scope, idempotency_key, request_digest, response_status, response_json, expires_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (scope, idempotency_key) DO NOTHING`,
      [scope, key, requestDigest, responseStatus, jsonParam(response), expiresAt, new Date().toISOString()]);
      return result.rowCount === 1;
    },
    createRunWithTasks(input) { return services.workflows.createRunWithTasks(input); },
    getCoverageSourcePages(caseId) {
      return database.query(`SELECT page.id, page.document_upload_id, page.page_number,
          page.source_version, page.extracted_text, document.document_kind
        FROM source_pages page
        JOIN document_uploads document ON document.id = page.document_upload_id
        JOIN ocr_jobs job ON job.id = page.ocr_job_id
        WHERE document.case_id = $1
          AND document.lifecycle_state = 'active'
          AND document.malware_status = 'clean'
          AND document.encryption_status = 'encrypted_local'
          AND job.status = 'succeeded'
          AND page.output_contract_version = 'knowvia.ocr.v1'
          AND page.extraction_status IN ('extracted', 'manual_verified')
          AND page.extracted_text IS NOT NULL
        ORDER BY document.uploaded_at, document.id, page.page_number`, [caseId]);
    },
    getJob,
    getTask: taskId => services.workflows.getTask(taskId),
    claimNext: input => services.workflows.claimNext(input),
    async dependencyOutputs(taskId) {
      const rows = await database.query(`SELECT prerequisite.input_json, prerequisite.output_json
        FROM workflow_task_dependencies dependency
        JOIN workflow_tasks prerequisite ON prerequisite.id = dependency.depends_on_task_id
        WHERE dependency.workflow_task_id = $1 ORDER BY prerequisite.created_at, prerequisite.id`, [taskId]);
      return Object.fromEntries(rows.map(row => [parse(row.input_json).key, parse(row.output_json)]));
    },
    completeTask(taskId, input) { return services.workflows.completeTask(taskId, input); },
    failTask(taskId, input) { return services.workflows.failTask(taskId, input); },
    recoverExpiredLeases() { return services.workflows.recoverExpiredLeases(); },
    async isConsentActive(grantId, at) {
      const grant = await services.consents.get(grantId);
      return Boolean(grant && !grant.revoked_at && (!grant.expires_at || grant.expires_at > at));
    },
    async stopForRevocation(runId) {
      const run = await services.workflows.getRun(runId);
      if (!run) return null;
      const at = new Date().toISOString();
      // Lock order: the run row first, then its tasks.
      await database.transaction(async tx => {
        await tx.query('SELECT id FROM workflow_runs WHERE id = $1 FOR UPDATE', [runId]);
        await tx.query(`UPDATE workflow_tasks SET status = 'revoked', finished_at = $1, terminal_reason = 'CONSENT_REVOKED',
          lease_owner = NULL, lease_expires_at = NULL WHERE workflow_run_id = $2 AND status IN ('pending', 'running')`, [at, runId]);
        await tx.query(`UPDATE workflow_runs SET status = 'revoked', finished_at = $1, terminal_reason = 'CONSENT_REVOKED'
          WHERE id = $2`, [at, runId]);
      });
      await services.audit.append({
        householdId: (await services.cases.get(run.case_id))?.household_id ?? null,
        caseId: run.case_id,
        action: 'analysis.revoked',
        resourceType: 'workflow_run',
        resourceId: runId,
        payload: { reason: 'consent_not_active' },
      });
      return getJob(runId);
    },
    async persistTaskArtifact({ run, task, taskKey, output }) {
      await services.audit.append({
        householdId: (await services.cases.get(run.case_id))?.household_id ?? null,
        caseId: run.case_id,
        action: 'analysis.task_completed',
        resourceType: 'workflow_task',
        resourceId: task.id,
        payload: { taskKey, outputDigest: digest(output) },
      });
    },
  });
}
