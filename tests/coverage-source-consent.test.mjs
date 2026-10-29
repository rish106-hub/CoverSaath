import test from 'node:test';
import assert from 'node:assert/strict';
import { createCoverageAnalysisPort } from '../src/backend/services/coverage-analysis-port.js';
import { GEMINI_MODEL_RECIPIENT } from '../src/features/ai-analysis/privacy-evidence-gate.js';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pgOptions = postgresTestOptions();

const at = '2026-10-09T10:00:00.000Z';

async function seedIdentity(database) {
  await database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-consent', 'Synthetic household', at, at);
  for (const adultId of ['adult-subject', 'adult-other']) {
    await database.prepare(`INSERT INTO adult_users
      (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)`)
      .run(adultId, adultId, at, at);
    await database.prepare(`INSERT INTO household_roles
      (id, household_id, adult_user_id, role, status, created_at)
      VALUES (?, 'household-consent', ?, 'owner', 'active', ?)`)
      .run(`role-${adultId}`, adultId, at);
    await database.prepare(`INSERT INTO household_members
      (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at)
      VALUES (?, 'household-consent', ?, ?, 'adult', ?, ?)`)
      .run(`member-${adultId}`, adultId, adultId, at, at);
  }
  await database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ('case-consent', 'household-consent', 'member-adult-subject', 'adult-subject',
      'renewal', 'processing', ?, ?)`).run(at, at);
}

async function seedDocument(database, {
  suffix, subjectAdultId = 'adult-subject', expiresAt = null, revokedAt = null,
  resourceId = 'exact', action = 'derive', dataCategory = 'insurance_document',
  recipient = GEMINI_MODEL_RECIPIENT, purpose = 'document_processing', grantHouseholdId = 'household-consent',
}) {
  const grantId = `consent-${suffix}`;
  const documentId = `document-${suffix}`;
  await database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, 'knowvia-local', ?, 'v1',
      'fixture', ?, NULL, NULL, ?)`).run(grantId, grantHouseholdId, subjectAdultId, purpose, at, at);
  // The schema requires every upload to reference a current same-household
  // document_processing grant. When the derive grant under test is deliberately
  // wrong (purpose or household), the upload uses its own valid grant.
  let uploadGrantId = grantId;
  if (purpose !== 'document_processing' || grantHouseholdId !== 'household-consent') {
    uploadGrantId = `upload-${suffix}`;
    await database.prepare(`INSERT INTO consent_grants
      (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
       evidence_method, granted_at, created_at)
      VALUES (?, 'household-consent', ?, 'knowvia-local', 'document_processing', 'v1', 'fixture', ?, ?)`)
      .run(uploadGrantId, subjectAdultId, at, at);
  }
  await database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind,
     original_filename, storage_path, content_sha256, mime_type, byte_size, malware_status,
     encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES (?, 'household-consent', 'case-consent', ?, ?, 'policy_schedule', ?, ?, ?,
      'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`).run(
    documentId, subjectAdultId, uploadGrantId, `${suffix}.pdf`, `fixture/${suffix}`,
    suffix.padEnd(64, 'a').slice(0, 64), at,
  );
  await database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES (?, ?, 'document', ?, ?, ?, ?, ?)`).run(
    `scope-${suffix}`, grantId, resourceId === 'exact' ? documentId : resourceId, action, dataCategory, recipient, at,
  );
  await database.prepare(`INSERT INTO ocr_jobs
    (id, document_upload_id, provider, status, attempt_count, contract_version, requested_at,
     completed_at, updated_at)
    VALUES (?, ?, 'fixture', 'succeeded', 1, 'knowvia.ocr.v1', ?, ?, ?)`).run(
    `ocr-${suffix}`, documentId, at, at, at,
  );
  await database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, ocr_job_id, page_number, source_version, page_sha256,
     extracted_text, extraction_status, created_at, output_contract_version, text_sha256)
    VALUES (?, ?, ?, 1, 'version-1', ?, ?, 'extracted', ?, 'knowvia.ocr.v1', ?)`)
    .run(`page-${suffix}`, documentId, `ocr-${suffix}`, 'b'.repeat(64), `text-${suffix}`, at, 'c'.repeat(64));
  if (expiresAt || revokedAt) {
    await database.prepare('UPDATE consent_grants SET expires_at = ?, revoked_at = ? WHERE id = ?')
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

test('coverage source selection includes only current exact document consent', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedIdentity(database);
  await seedDocument(database, { suffix: 'allowed' });
  const postUpload = await seedDocument(database, { suffix: 'post-upload', action: 'collect' });
  await database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version,
     evidence_method, granted_at, created_at)
    VALUES ('consent-post-upload-analysis', 'household-consent', 'adult-subject', 'knowvia-local',
      'document_processing', 'v1', 'fixture', ?, ?)`).run(at, at);
  await database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-post-upload-analysis', 'consent-post-upload-analysis', 'document', ?,
      'derive', 'insurance_document', ?, ?)`).run(postUpload.documentId, GEMINI_MODEL_RECIPIENT, at);
  await seedDocument(database, { suffix: 'broad', resourceId: null });
  await seedDocument(database, { suffix: 'wrong-action', action: 'collect' });
  await seedDocument(database, { suffix: 'wrong-category', dataCategory: 'identity' });
  await seedDocument(database, { suffix: 'expired', expiresAt: '2020-01-01T00:00:00.000Z' });
  await seedDocument(database, { suffix: 'revoked', revokedAt: at });
  await seedDocument(database, { suffix: 'wrong-subject', subjectAdultId: 'adult-other' });
  await seedDocument(database, { suffix: 'null-recipient', recipient: null });
  await seedDocument(database, { suffix: 'wrong-recipient', recipient: 'openai-gpt' });
  await seedDocument(database, { suffix: 'viewer-recipient', recipient: 'adult-subject' });
  await seedDocument(database, { suffix: 'recipient-lookalike', recipient: 'Google-Gemini' });
  await seedDocument(database, { suffix: 'wrong-purpose', purpose: 'coverage_reconstruction' });
  // A derive grant that names a different document (same household) does not cover this one.
  await seedDocument(database, { suffix: 'other-resource', resourceId: 'document-allowed' });

  const pages = await createPort(database).getCoverageSourcePages('case-consent');

  assert.deepEqual(pages.map(page => page.id), ['page-allowed', 'page-post-upload']);
  assert.equal(pages[0].extracted_text, 'text-allowed');
});

test('NULL-recipient derive grants are never broadened to a model recipient', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedIdentity(database);
  await seedDocument(database, { suffix: 'legacy-null', recipient: null });
  const port = createPort(database);
  assert.deepEqual(await port.getCoverageSourcePages('case-consent'), []);
  // Adding an exact recipient-named derive scope is what admits the document.
  await database.prepare(`INSERT INTO consent_scopes
    (id, consent_grant_id, resource_type, resource_id, action, data_category, recipient, created_at)
    VALUES ('scope-legacy-named', 'consent-legacy-null', 'document', 'document-legacy-null',
      'derive', 'insurance_document', ?, ?)`).run(GEMINI_MODEL_RECIPIENT, at);
  assert.deepEqual((await port.getCoverageSourcePages('case-consent')).map(page => page.id), ['page-legacy-null']);
  // A port configured for another recipient does not see Gemini-only grants.
  const otherRecipientPort = createCoverageAnalysisPort({ database, services: { cases: {}, consents: {}, workflows: {}, audit: {} }, modelRecipient: 'openai-gpt' });
  assert.deepEqual(await otherRecipientPort.getCoverageSourcePages('case-consent'), []);
  assert.throws(() => createCoverageAnalysisPort({ database, services: { cases: {}, consents: {}, workflows: {}, audit: {} }, modelRecipient: '' }), TypeError);
});

test('a grant from another household never admits the document, even if the household trigger is bypassed', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedIdentity(database);
  await database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-other', 'Other synthetic household', at, at);
  await database.prepare(`INSERT INTO household_roles
    (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-subject-other', 'household-other', 'adult-subject', 'owner', 'active', ?)`).run(at);
  // The schema already refuses cross-household document scopes.
  await assert.rejects(() => seedDocument(database, { suffix: 'cross-household', grantHouseholdId: 'household-other' }), /grant household/);
  // Defence in depth: with the trigger removed, the selection predicate still excludes it.
  await database.run('DROP TRIGGER consent_scopes_household_resource_insert ON consent_scopes');
  await seedDocument(database, { suffix: 'cross-household-2', grantHouseholdId: 'household-other' });
  assert.deepEqual(await createPort(database).getCoverageSourcePages('case-consent'), []);
});

test('revocation after OCR removes the page on the next source selection', pgOptions, async t => {
  const { db: database } = await freshDatabase(t);
  await seedIdentity(database);
  const { grantId } = await seedDocument(database, { suffix: 'race' });
  const port = createPort(database);

  assert.deepEqual((await port.getCoverageSourcePages('case-consent')).map(page => page.id), ['page-race']);
  await database.prepare('UPDATE consent_grants SET revoked_at = ? WHERE id = ?').run(at, grantId);
  assert.deepEqual(await port.getCoverageSourcePages('case-consent'), []);
});
