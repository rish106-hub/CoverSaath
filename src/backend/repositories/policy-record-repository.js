import { randomUUID } from 'node:crypto';

// Persistence for policy records, breakdown jobs, parameters, reviews and model-call telemetry.

const parse = value => (value == null ? null : JSON.parse(value));

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
    budgetUsd: row.budget_usd,
    spentUsd: row.spent_usd,
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

  transaction(work) {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  findJobByIdempotency(householdId, idempotencyKey) {
    return mapJob(this.database.prepare('SELECT * FROM breakdown_jobs WHERE household_id = ? AND idempotency_key = ?').get(householdId, idempotencyKey));
  }

  createRecordWithJob({ householdId, createdByAdultId, consentGrantId, contractVersion, documentIds, idempotencyKey, requestDigest, executionMode, budgetUsd, steps }) {
    const at = this.now();
    const recordId = `policy-record-${randomUUID()}`;
    const jobId = `breakdown-job-${randomUUID()}`;
    this.transaction(() => {
      this.database.prepare(`INSERT INTO policy_records
        (id, household_id, created_by_adult_id, consent_grant_id, status, contract_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)`).run(recordId, householdId, createdByAdultId, consentGrantId, contractVersion, at, at);
      const link = this.database.prepare('INSERT INTO policy_record_documents (policy_record_id, document_upload_id, position) VALUES (?, ?, ?)');
      documentIds.forEach((documentId, position) => link.run(recordId, documentId, position));
      this.database.prepare(`INSERT INTO breakdown_jobs
        (id, policy_record_id, household_id, idempotency_key, request_digest, execution_mode, status, current_step,
         steps_json, budget_usd, spent_usd, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?, 0, ?, ?)`).run(jobId, recordId, householdId, idempotencyKey, requestDigest, executionMode, JSON.stringify(steps), budgetUsd, at, at);
      this.audit?.append({ householdId, actorType: 'adult_user', actorId: createdByAdultId, action: 'policy_record.created', resourceType: 'household', resourceId: householdId, payload: { recordId, jobId, documentCount: documentIds.length, executionMode } });
    });
    return { record: this.getRecord(recordId), job: this.getJob(jobId) };
  }

  getRecord(id) { return mapRecord(this.database.prepare('SELECT * FROM policy_records WHERE id = ?').get(id)); }

  listRecords(householdId) {
    return this.database.prepare('SELECT * FROM policy_records WHERE household_id = ? ORDER BY created_at DESC LIMIT 100').all(householdId).map(mapRecord);
  }

  recordDocuments(recordId) {
    return this.database.prepare(`SELECT document.* FROM policy_record_documents link
      JOIN document_uploads document ON document.id = link.document_upload_id
      WHERE link.policy_record_id = ? ORDER BY link.position`).all(recordId);
  }

  updateRecord(id, changes) {
    const current = this.getRecord(id);
    const next = { ...current, ...changes };
    this.database.prepare(`UPDATE policy_records SET status = ?, display_title = ?, insurer_name = ?, product_name = ?,
      policy_number_masked = ?, summary_json = ?, updated_at = ?, ready_at = ? WHERE id = ?`).run(
      next.status, next.displayTitle, next.insurerName, next.productName, next.policyNumberMasked,
      next.summary == null ? null : JSON.stringify(next.summary), this.now(), next.readyAt, id,
    );
    return this.getRecord(id);
  }

  getJob(id) { return mapJob(this.database.prepare('SELECT * FROM breakdown_jobs WHERE id = ?').get(id)); }

  latestJobForRecord(recordId) {
    return mapJob(this.database.prepare('SELECT * FROM breakdown_jobs WHERE policy_record_id = ? ORDER BY created_at DESC LIMIT 1').get(recordId));
  }

  updateJob(id, changes) {
    const current = this.getJob(id);
    const next = { ...current, ...changes };
    this.database.prepare(`UPDATE breakdown_jobs SET status = ?, current_step = ?, steps_json = ?, spent_usd = ?, budget_usd = ?,
      error_code = ?, error_message = ?, started_at = ?, completed_at = ?, updated_at = ? WHERE id = ?`).run(
      next.status, next.currentStep, JSON.stringify(next.steps), next.spentUsd, next.budgetUsd, next.errorCode, next.errorMessage,
      next.startedAt, next.completedAt, this.now(), id,
    );
    return this.getJob(id);
  }

  markInterrupted() {
    return this.database.prepare(`UPDATE breakdown_jobs SET status = 'interrupted', updated_at = ?,
      error_code = 'PROCESS_RESTARTED', error_message = 'The server stopped while this job was running. Resume it.'
      WHERE status IN ('queued', 'running')`).run(this.now()).changes;
  }

  recordModelCall(jobId, call) {
    this.database.prepare(`INSERT INTO breakdown_model_calls
      (id, breakdown_job_id, agent, prompt_version, provider, model, status, input_tokens, output_tokens, cost_usd, latency_ms, error_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      `model-call-${randomUUID()}`, jobId, call.agent, call.promptVersion ?? 'unknown', call.provider ?? 'unknown', call.model ?? 'unknown',
      call.status, call.inputTokens ?? null, call.outputTokens ?? null, call.costUsd ?? null,
      call.latencyMs == null ? null : Math.round(call.latencyMs), call.errorCode ?? null, this.now(),
    );
  }

  modelCalls(jobId) {
    return this.database.prepare('SELECT agent, provider, model, status, input_tokens, output_tokens, cost_usd, latency_ms, error_code, created_at FROM breakdown_model_calls WHERE breakdown_job_id = ? ORDER BY created_at').all(jobId);
  }

  replaceParameters(recordId, results) {
    const at = this.now();
    this.transaction(() => {
      this.database.prepare('DELETE FROM policy_parameters WHERE policy_record_id = ?').run(recordId);
      const insert = this.database.prepare(`INSERT INTO policy_parameters
        (id, policy_record_id, section_number, parameter_key, evidence_state, critical, visibility, review_state, result_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const result of Object.values(results)) {
        insert.run(`parameter-${randomUUID()}`, recordId, result.section, result.key, result.evidenceState, result.critical ? 1 : 0, result.visibility, result.review?.state ?? 'unreviewed', JSON.stringify(result), at);
      }
    });
  }

  parameters(recordId, { sectionNumber = null } = {}) {
    const rows = sectionNumber == null
      ? this.database.prepare('SELECT result_json FROM policy_parameters WHERE policy_record_id = ? ORDER BY section_number, parameter_key').all(recordId)
      : this.database.prepare('SELECT result_json FROM policy_parameters WHERE policy_record_id = ? AND section_number = ? ORDER BY parameter_key').all(recordId, sectionNumber);
    return Object.fromEntries(rows.map(row => { const result = JSON.parse(row.result_json); return [result.key, result]; }));
  }

  applyReview({ recordId, key, action, previous, next, reviewerAdultId, note, householdId }) {
    const at = this.now();
    this.transaction(() => {
      const updated = this.database.prepare(`UPDATE policy_parameters SET evidence_state = ?, review_state = ?, result_json = ?, updated_at = ?
        WHERE policy_record_id = ? AND parameter_key = ?`).run(next.evidenceState, next.review.state, JSON.stringify(next), at, recordId, key);
      if (updated.changes !== 1) throw Object.assign(new Error('Parameter not found.'), { code: 'PARAMETER_NOT_FOUND', statusCode: 404 });
      this.database.prepare(`INSERT INTO policy_parameter_reviews
        (id, policy_record_id, parameter_key, action, previous_json, next_json, reviewed_by_adult_id, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(`review-${randomUUID()}`, recordId, key, action, JSON.stringify(previous), JSON.stringify(next), reviewerAdultId, note, at);
      this.audit?.append({ householdId, actorType: 'adult_user', actorId: reviewerAdultId, action: `policy_parameter.${action}`, resourceType: 'household', resourceId: householdId, payload: { recordId, key, from: previous.evidenceState, to: next.evidenceState } });
    });
  }
}
