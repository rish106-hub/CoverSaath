import { randomUUID } from 'node:crypto';
import { fromMicroUsd, jsonParam, parseJson as parse, toMicroUsd } from '../database/value-codec.js';

// Persistence for policy records, breakdown jobs, parameters, reviews and model-call telemetry.

function mapRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    householdId: row.household_id,
    createdByAdultId: row.created_by_adult_id,
    consentGrantId: row.consent_grant_id,
    status: row.status,
    contractVersion: row.contract_version,
    displayTitle: row.display_title,
    insurerName: row.insurer_name,
    productName: row.product_name,
    policyNumberMasked: row.policy_number_masked,
    summary: parse(row.summary_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    readyAt: row.ready_at,
  };
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    policyRecordId: row.policy_record_id,
    householdId: row.household_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    executionMode: row.execution_mode,
    status: row.status,
    currentStep: row.current_step,
    steps: parse(row.steps_json),
    budgetUsd: fromMicroUsd(row.budget_micro_usd),
    spentUsd: fromMicroUsd(row.spent_micro_usd),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}

export class PolicyRecordRepository {
  constructor(database, { clock = () => new Date(), audit } = {}) {
    this.database = database;
    this.clock = clock;
    this.audit = audit;
  }

  now() { return this.clock().toISOString(); }

  transaction(work) { return this.database.transaction(work); }

  async findJobByIdempotency(householdId, idempotencyKey) {
    return mapJob(await this.database.one('SELECT * FROM breakdown_jobs WHERE household_id = $1 AND idempotency_key = $2', [householdId, idempotencyKey]));
  }

  async createRecordWithJob({ householdId, createdByAdultId, consentGrantId, contractVersion, documentIds, idempotencyKey, requestDigest, executionMode, budgetUsd, steps }) {
    const at = this.now();
    const recordId = `policy-record-${randomUUID()}`;
    const jobId = `breakdown-job-${randomUUID()}`;
    await this.transaction(async tx => {
      await tx.query(`INSERT INTO policy_records
        (id, household_id, created_by_adult_id, consent_grant_id, status, contract_version, created_at, updated_at)
        VALUES ($1, $2, $3, $4, 'processing', $5, $6, $7)`, [recordId, householdId, createdByAdultId, consentGrantId, contractVersion, at, at]);
      for (const [position, documentId] of documentIds.entries()) {
        await tx.query('INSERT INTO policy_record_documents (policy_record_id, document_upload_id, position) VALUES ($1, $2, $3)', [recordId, documentId, position]);
      }
      await tx.query(`INSERT INTO breakdown_jobs
        (id, policy_record_id, household_id, idempotency_key, request_digest, execution_mode, status, current_step,
         steps_json, budget_micro_usd, spent_micro_usd, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'queued', NULL, $7, $8, 0, $9, $10)`,
      [jobId, recordId, householdId, idempotencyKey, requestDigest, executionMode, jsonParam(steps), toMicroUsd(budgetUsd), at, at]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: createdByAdultId, action: 'policy_record.created', resourceType: 'household', resourceId: householdId, payload: { recordId, jobId, documentCount: documentIds.length, executionMode } });
    });
    return { record: await this.getRecord(recordId), job: await this.getJob(jobId) };
  }

  async getRecord(id) { return mapRecord(await this.database.one('SELECT * FROM policy_records WHERE id = $1', [id])); }

  async listRecords(householdId) {
    return (await this.database.query('SELECT * FROM policy_records WHERE household_id = $1 ORDER BY created_at DESC LIMIT 100', [householdId])).map(mapRecord);
  }

  recordDocuments(recordId) {
    return this.database.query(`SELECT document.* FROM policy_record_documents link
      JOIN document_uploads document ON document.id = link.document_upload_id
      WHERE link.policy_record_id = $1 ORDER BY link.position`, [recordId]);
  }

  async updateRecord(id, changes) {
    await this.database.transaction(async tx => {
      const current = mapRecord(await tx.one('SELECT * FROM policy_records WHERE id = $1 FOR UPDATE', [id]));
      const next = { ...current, ...changes };
      await tx.query(`UPDATE policy_records SET status = $1, display_title = $2, insurer_name = $3, product_name = $4,
        policy_number_masked = $5, summary_json = $6, updated_at = $7, ready_at = $8 WHERE id = $9`, [
        next.status, next.displayTitle, next.insurerName, next.productName, next.policyNumberMasked,
        jsonParam(next.summary), this.now(), next.readyAt, id,
      ]);
    });
    return this.getRecord(id);
  }

  async getJob(id) { return mapJob(await this.database.one('SELECT * FROM breakdown_jobs WHERE id = $1', [id])); }

  async latestJobForRecord(recordId) {
    return mapJob(await this.database.one('SELECT * FROM breakdown_jobs WHERE policy_record_id = $1 ORDER BY created_at DESC LIMIT 1', [recordId]));
  }

  /**
   * Read-modify-write under a row lock, so parallel section agents never overwrite each other's steps.
   * Spend is monotonic: a stale snapshot can never lower it.
   * `mutate(job)` may return extra changes; they are merged after `changes`.
   */
  async updateJob(id, changes = {}, mutate = null) {
    await this.database.transaction(async tx => {
      const current = mapJob(await tx.one('SELECT * FROM breakdown_jobs WHERE id = $1 FOR UPDATE', [id]));
      const next = { ...current, ...changes, ...(mutate ? mutate(current) : {}) };
      const spentUsd = Math.max(current.spentUsd ?? 0, next.spentUsd ?? 0);
      await tx.query(`UPDATE breakdown_jobs SET status = $1, current_step = $2, steps_json = $3, spent_micro_usd = $4, budget_micro_usd = $5,
        error_code = $6, error_message = $7, started_at = $8, completed_at = $9, updated_at = $10 WHERE id = $11`, [
        next.status, next.currentStep, jsonParam(next.steps), toMicroUsd(spentUsd), toMicroUsd(next.budgetUsd), next.errorCode, next.errorMessage,
        next.startedAt, next.completedAt, this.now(), id,
      ]);
    });
    return this.getJob(id);
  }

  /** Atomically merges `stepChanges` into one step; `jobChanges` apply in the same transaction. */
  patchStep(jobId, stepId, stepChanges, jobChanges = {}) {
    return this.updateJob(jobId, jobChanges, current => ({
      steps: current.steps.map(step => (step.id === stepId ? { ...step, ...stepChanges } : step)),
      currentStep: stepChanges.status === 'running' ? stepId : current.currentStep,
      ...jobChanges,
    }));
  }

  async markInterrupted() {
    return (await this.database.run(`UPDATE breakdown_jobs SET status = 'interrupted', updated_at = $1,
      error_code = 'PROCESS_RESTARTED', error_message = 'The server stopped while this job was running. Resume it.'
      WHERE status IN ('queued', 'running')`, [this.now()])).rowCount;
  }

  async recordModelCall(jobId, call) {
    await this.database.query(`INSERT INTO breakdown_model_calls
      (id, breakdown_job_id, agent, prompt_version, provider, model, status, input_tokens, output_tokens, cost_micro_usd, latency_ms, error_code, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`, [
      `model-call-${randomUUID()}`, jobId, call.agent, call.promptVersion ?? 'unknown', call.provider ?? 'unknown', call.model ?? 'unknown',
      call.status, call.inputTokens ?? null, call.outputTokens ?? null, toMicroUsd(call.costUsd ?? null),
      call.latencyMs == null ? null : Math.round(call.latencyMs), call.errorCode ?? null, this.now(),
    ]);
  }

  async modelCalls(jobId) {
    const rows = await this.database.query('SELECT agent, provider, model, status, input_tokens, output_tokens, cost_micro_usd, latency_ms, error_code, created_at FROM breakdown_model_calls WHERE breakdown_job_id = $1 ORDER BY created_at', [jobId]);
    return rows.map(({ cost_micro_usd: cost, ...row }) => ({ ...row, cost_usd: fromMicroUsd(cost) }));
  }

  async replaceParameters(recordId, results) {
    const at = this.now();
    await this.transaction(async tx => {
      await tx.query('DELETE FROM policy_parameters WHERE policy_record_id = $1', [recordId]);
      for (const result of Object.values(results)) {
        await tx.query(`INSERT INTO policy_parameters
          (id, policy_record_id, section_number, parameter_key, evidence_state, critical, visibility, review_state, result_json, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [`parameter-${randomUUID()}`, recordId, result.section, result.key, result.evidenceState, result.critical ? 1 : 0, result.visibility, result.review?.state ?? 'unreviewed', jsonParam(result), at]);
      }
    });
  }

  async parameters(recordId, { sectionNumber = null } = {}) {
    const rows = sectionNumber == null
      ? await this.database.query('SELECT result_json FROM policy_parameters WHERE policy_record_id = $1 ORDER BY section_number, parameter_key', [recordId])
      : await this.database.query('SELECT result_json FROM policy_parameters WHERE policy_record_id = $1 AND section_number = $2 ORDER BY parameter_key', [recordId, sectionNumber]);
    return Object.fromEntries(rows.map(row => { const result = JSON.parse(row.result_json); return [result.key, result]; }));
  }

  async applyReview({ recordId, key, action, previous, next, reviewerAdultId, note, householdId }) {
    const at = this.now();
    await this.transaction(async tx => {
      const updated = await tx.run(`UPDATE policy_parameters SET evidence_state = $1, review_state = $2, result_json = $3, updated_at = $4
        WHERE policy_record_id = $5 AND parameter_key = $6`, [next.evidenceState, next.review.state, jsonParam(next), at, recordId, key]);
      if (updated.rowCount !== 1) throw Object.assign(new Error('Parameter not found.'), { code: 'PARAMETER_NOT_FOUND', statusCode: 404 });
      await tx.query(`INSERT INTO policy_parameter_reviews
        (id, policy_record_id, parameter_key, action, previous_json, next_json, reviewed_by_adult_id, note, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [`review-${randomUUID()}`, recordId, key, action, jsonParam(previous), jsonParam(next), reviewerAdultId, note, at]);
      await this.audit?.append({ householdId, actorType: 'adult_user', actorId: reviewerAdultId, action: `policy_parameter.${action}`, resourceType: 'household', resourceId: householdId, payload: { recordId, key, from: previous.evidenceState, to: next.evidenceState } });
    });
  }
}
