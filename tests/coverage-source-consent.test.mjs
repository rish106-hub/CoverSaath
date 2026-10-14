import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import { createCoverageAnalysisPort } from '../src/backend/services/coverage-analysis-port.js';

const at = '2026-10-09T10:00:00.000Z';

function seedIdentity(database) {
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-consent', 'Synthetic household', at, at);
  for (const adultId of ['adult-subject', 'adult-other']) {
    database.prepare(`INSERT INTO adult_users
      (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(adultId, adultId, at, at);
    database.prepare(`INSERT INTO household_roles
      (id, household_id, adult_user_id, role, status, created_at)
      VALUES (?, 'household-consent', ?, 'owner', 'active', ?)`)
      .run(`role-${adultId}`, adultId, at);
    database.prepare(`INSERT INTO household_members
      (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
      VALUES (?, 'household-consent', ?, ?, 'adult', ?, ?)`)
      .run(`member-${adultId}`, adultId, adultId, at, at);
  }
  database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('case-consent', 'household-consent', 'member-adult-subject', 'adult-subject',
      'renewal', 'processing', ?, ?)`).run(at, at);
}

function seedDocument(database, {
  suffix, subjectAdultId = 'adult-subject', expiresAt = null, revokedAt = null,
  resourceId = 'exact', action = 'derive', dataCategory = 'insurance_document',
}) {
  const grantId = `consent-${suffix}`;
  const documentId = `document-${suffix}`;
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, expires_at, revoked_at, created_at)
    VALUES (?, 'household-consent', ?, 'knowvia-local', 'document_processing', 'v1',
      'fixture', ?, NULL, NULL, ?)`).run(grantId, subjectAdultId, at, at);
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES (?, 'household-consent', 'case-consent', ?, ?, 'policy_schedule', ?, ?, ?,
      'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`).run(
    documentId, subjectAdultId, grantId, `${suffix}.pdf`, `fixture/${suffix}`,
    suffix.padEnd(64, 'a').slice(0, 64), at,
  );
  database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, resource_id, action, data_category, created_at)
    VALUES (?, ?, 'document', ?, ?, ?, ?)`).run(
    `scope-${suffix}`, grantId, resourceId === 'exact' ? documentId : null, action, dataCategory, at,
  );
  database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, status, attempt_count, contract_version, requested_at,
     completed_at, updated_at)
    VALUES (?, ?, 'fixture', 'succeeded', 1, 'knowvia.ocr.v1', ?, ?, ?)`).run(
    `ocr-${suffix}`, documentId, at, at, at,
  );
  database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, created_at, output_contract_version, text_sha256)
    VALUES (?, ?, ?, 1, 'version-1', ?, ?, 'extracted', ?, 'knowvia.ocr.v1', ?)`)
    .run(`page-${suffix}`, documentId, `ocr-${suffix}`, 'b'.repeat(64), `text-${suffix}`, at, 'c'.repeat(64));
  if (expiresAt || revokedAt) {
    database.prepare('UPDATE consent_grants SET expires_at = ?, revoked_at = ? WHERE id = ?')
      .run(expiresAt, revokedAt, grantId);
  }
  return { documentId, grantId };
}

function createPort(database) {
  return createCoverageAnalysisPort({
    database,
    services: { cases: {}, consents: {}, workflows: {}, audit: {} },
  });
}

test('coverage source selection includes only current exact document consent', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedIdentity(database);
  seedDocument(database, { suffix: 'allowed' });
  const postUpload = seedDocument(database, { suffix: 'post-upload', action: 'collect' });
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, created_at)
    VALUES ('consent-post-upload-analysis', 'household-consent', 'adult-subject', 'knowvia-local',
      'document_processing', 'v1', 'fixture', ?, ?)`).run(at, at);
  database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, resource_id, action, data_category, created_at)
    VALUES ('scope-post-upload-analysis', 'consent-post-upload-analysis', 'document', ?,
      'derive', 'insurance_document', ?)`).run(postUpload.documentId, at);
  seedDocument(database, { suffix: 'broad', resourceId: null });
  seedDocument(database, { suffix: 'wrong-action', action: 'collect' });
  seedDocument(database, { suffix: 'wrong-category', dataCategory: 'identity' });
  seedDocument(database, { suffix: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' });
  seedDocument(database, { suffix: 'revoked', revokedAt: at });
  seedDocument(database, { suffix: 'wrong-subject', subjectAdultId: 'adult-other' });

  const pages = createPort(database).getCoverageSourcePages('case-consent');

  assert.deepEqual(pages.map(page => page.id), ['page-allowed', 'page-post-upload']);
  assert.equal(pages[0].extracted_text, 'text-allowed');
});

test('revocation after OCR removes the page on the next source selection', t => {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedIdentity(database);
  const { grantId } = seedDocument(database, { suffix: 'race' });
  const port = createPort(database);

  assert.deepEqual(port.getCoverageSourcePages('case-consent').map(page => page.id), ['page-race']);
  database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(at, grantId);
  assert.deepEqual(port.getCoverageSourcePages('case-consent'), []);
});
