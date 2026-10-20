// Synthetic fixtures for coverage parameter persistence tests. No real data.
import { isDatabaseInterface } from '../../src/backend/database/postgres/db.js';

export const parameterAt = '2026-10-09T10:00:00.000Z';

export const parameterIds = Object.freeze({
  householdId: 'household-parameters',
  caseId: 'case-parameters',
  subjectId: 'member-parameters',
  policyId: 'policy-parameters',
  runId: 'run-parameters',
  documentId: 'document-parameters',
  pageId: 'page-parameters',
  otherDocumentId: 'document-other',
  otherPageId: 'page-other',
});

function parameterWorldStatements(at) {
  const statements = [];
  const add = (sql, ...params) => statements.push([sql, params]);
  add('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', 'household-parameters', 'Synthetic household', at, at);
  add(`INSERT INTO adult_users
    (id, display_name, account_status, created_at, updated_at) VALUES ('adult-parameters', 'Adult', 'active', ?, ?)`, at, at);
  add(`INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-parameters', 'household-parameters', 'adult-parameters', 'owner', 'active', ?)`, at);
  add(`INSERT INTO household_members
    (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
    VALUES ('member-parameters', 'household-parameters', 'adult-parameters', 'Adult', 'adult', ?, ?)`, at, at);
  add(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, created_at)
    VALUES ('consent-parameters', 'household-parameters', 'adult-parameters', 'knowvia-local',
      'document_processing', 'v1', 'fixture', ?, ?)`, at, at);
  add(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('case-parameters', 'household-parameters', 'member-parameters', 'adult-parameters',
      'renewal', 'processing', ?, ?)`, at, at);
  add(`INSERT INTO policies
    (id, household_id, policy_kind, verification_state, created_at, updated_at)
    VALUES ('policy-parameters', 'household-parameters', 'personal', 'unverified', ?, ?)`, at, at);
  for (const [documentId, pageId, jobId, digestSeed] of [
    ['document-parameters', 'page-parameters', 'ocr-parameters', 'a'],
    ['document-other', 'page-other', 'ocr-other', '1'],
  ]) {
    add(`INSERT INTO document_uploads
      (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
       original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
       encryption_status, lifecycle_state, uploaded_at, source_version)
      VALUES (?, 'household-parameters', 'case-parameters', 'adult-parameters',
        'consent-parameters', 'policy_schedule', 'fixture.pdf', ?, ?,
        'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`, documentId, `fixture/${documentId}`, digestSeed.repeat(64), at);
    add(`INSERT INTO ocr_jobs
      (id, document_upload_id, provider, status, attempt_count, requested_at, completed_at, updated_at)
      VALUES (?, ?, 'fixture', 'succeeded', 1, ?, ?, ?)`, jobId, documentId, at, at, at);
    add(`INSERT INTO source_pages
      (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
       extracted_text, extraction_status, created_at, text_sha256)
      VALUES (?, ?, ?, 2, 'version-1', ?, 'Synthetic clause', 'extracted', ?, ?)`, pageId, documentId, jobId, 'b'.repeat(64), at, 'c'.repeat(64));
  }
  add(`INSERT INTO workflow_runs
    (id, case_id, workflow_name, workflow_version, execution_mode, status, input_digest,
     input_json, created_at)
    VALUES ('run-parameters', 'case-parameters', 'coverage-reconstruction', 'v2', 'fixture',
      'queued', ?, '{}', ?)`, 'd'.repeat(64), at);
  // A review in progress, so human_review observations can be recorded by its reviewer.
  add(`INSERT INTO human_reviews
    (id, case_id, workflow_run_id, reviewer_adult_id, review_kind, status, started_at, created_at)
    VALUES ('review-parameters', 'case-parameters', 'run-parameters', 'adult-parameters',
      'ambiguity', 'in_progress', ?, ?)`, at, at);
  return statements;
}

// Seeds the synthetic world. On node:sqlite it runs synchronously; on the S3.2 PostgreSQL interface
// it returns a Promise and inserts in one transaction.
export function seedParameterWorld(database, at = parameterAt) {
  const statements = parameterWorldStatements(at);
  if (isDatabaseInterface(database)) {
    return database.transaction(async () => {
      for (const [sql, params] of statements) await database.run(sql, params);
    });
  }
  for (const [sql, params] of statements) database.prepare(sql).run(...params);
  return undefined;
}

// The adult assigned to the seeded review; human_review observations must name them.
export const parameterReviewerId = 'adult-parameters';

export function parameterScope(overrides = {}) {
  return {
    workflowRunId: 'run-parameters',
    householdId: 'household-parameters',
    caseId: 'case-parameters',
    subjectId: 'member-parameters',
    policyId: 'policy-parameters',
    ...overrides,
  };
}

export function observationInput(overrides = {}) {
  return {
    sourceId: 'page-parameters',
    documentId: 'document-parameters',
    version: 'version-1',
    page: 2,
    extractionMethod: 'document_extraction',
    value: { amountMinor: 500000 },
    sourceDigest: 'e'.repeat(64),
    recordedBy: 'fixture-recorder',
    ...overrides,
  };
}
