import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, runMigrations } from '../src/backend/database/index.js';
import { AuditRepository } from '../src/backend/repositories/audit-repository.js';
import { ConsentRepository } from '../src/backend/repositories/consent-repository.js';
import { EvidenceRepository } from '../src/backend/repositories/evidence-repository.js';
import { parameterAt as at, seedParameterWorld } from './support/parameter-fixtures.mjs';

// Evidence facts are append-only except for one redaction update (SQLite migration 009,
// PostgreSQL 005). Consent revocation and the commit-time stop reach it through
// ConsentRepository.eraseDerivedRunData. Synthetic data only.

const later = '2026-10-18T12:00:00.000Z';
const appendOnly = /evidence facts are append only; add a superseding fact/;
const household = 'household-parameters';

function open(t) {
  const database = openDatabase({ path: ':memory:' });
  t.after(() => database.close());
  seedParameterWorld(database);
  // A second grant with its own document, which revoking consent-parameters must not touch.
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
    VALUES ('consent-kept', ?, 'adult-parameters', 'knowvia-local', 'document_processing', 'v1', 'fixture', ?, ?)`)
    .run(household, at, at);
  database.prepare(`INSERT INTO document_uploads
    (id, household_id, case_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename, storage_path,
     content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at, source_version)
    VALUES ('document-kept', ?, 'case-parameters', 'adult-parameters', 'consent-kept', 'policy_schedule', 'fixture.pdf',
      'fixture/document-kept', ?, 'application/pdf', 100, 'clean', 'encrypted_local', 'active', ?, 'version-1')`)
    .run(household, 'd'.repeat(64), at);
  database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, page_number, source_version, page_sha256, extracted_text, extraction_status, created_at)
    VALUES ('page-kept', 'document-kept', 1, 'version-1', ?, 'Synthetic clause', 'extracted', ?)`).run('e'.repeat(64), at);
  const audit = new AuditRepository(database, { clock: () => new Date(later) });
  const evidence = new EvidenceRepository(database, { clock: () => new Date(at) });
  const consents = new ConsentRepository(database, { clock: () => new Date(later), audit });
  return { database, evidence, consents };
}

const documentFact = (evidence, id, sourcePageId = 'page-parameters') => evidence.append({
  id, householdId: household, caseId: 'case-parameters', policyId: 'policy-parameters', subjectMemberId: 'member-parameters',
  factKey: 'room_limit', value: { limitMinor: 500000, currency: 'INR' }, epistemicState: 'known',
  provenanceKind: 'document_page', sourcePageId, sourceLocator: 'page 2, table 1', institutionalSourceRef: 'ref-1',
  calculationMethod: 'none', permittedViewers: ['adult-parameters'], effectiveAt: at, statementAdultId: 'adult-parameters',
  assertedBy: 'extractor',
});

const redaction = {
  epistemic_state: "'unknown'", value_json: 'NULL', source_page_id: 'NULL', source_locator: 'NULL',
  institutional_source_ref: 'NULL', calculation_method: 'NULL', permitted_viewers_json: 'NULL', effective_at: 'NULL',
  redacted_at: `'${later}'`, redaction_reason_code: "'consent_revoked'",
};
// Every value-bearing column the redaction must clear.
const erasedColumns = ['value_json', 'source_page_id', 'source_locator', 'institutional_source_ref', 'calculation_method', 'permitted_viewers_json', 'effective_at'];
const assertErased = (fact, label) => {
  for (const column of erasedColumns) assert.equal(fact[column], null, `${label}: ${column} erased`);
  assert.equal(fact.epistemic_state, 'unknown', `${label}: state UNKNOWN`);
};
const erase = (overrides = {}) => Object.entries({ ...redaction, ...overrides }).map(([column, value]) => `${column} = ${value}`).join(', ');

test('evidence facts allow only the complete redaction update', t => {
  const { database, evidence } = open(t);
  documentFact(evidence, 'fact-redact');
  evidence.append({ id: 'fact-prior', householdId: household, factKey: 'room_limit', epistemicState: 'unknown', provenanceKind: 'fixture', assertedBy: 'fixture' });
  const update = overrides => database.exec(`UPDATE evidence_facts SET ${erase(overrides)} WHERE id = 'fact-redact'`);

  const immutable = {
    id: "'fact-renamed'", household_id: "'household-other'", case_id: 'NULL', policy_id: 'NULL', subject_member_id: 'NULL',
    fact_key: "'other_key'", evidence_kind: "'fixture'", provenance_kind: "'fixture'", statement_adult_id: 'NULL',
    asserted_by: "'someone-else'", observed_at: `'${later}'`, retrieved_at: `'${later}'`, confidence_basis_points: '1',
    review_status: "'reviewed'", subject_confirmation_state: "'confirmed'", expires_at: `'${later}'`,
    supersedes_fact_id: "'fact-prior'", created_at: `'${later}'`,
  };
  for (const [column, value] of Object.entries(immutable)) {
    assert.throws(() => update({ [column]: value }), appendOnly, `redaction must not change ${column}`);
  }
  const retained = {
    value_json: "'5000'", source_page_id: "'page-parameters'", source_locator: "'page 2'", institutional_source_ref: "'ref-1'",
    calculation_method: "'none'", permitted_viewers_json: "'[]'", effective_at: `'${at}'`, epistemic_state: "'conflict'",
    redacted_at: 'NULL', redaction_reason_code: 'NULL',
  };
  for (const [column, value] of Object.entries(retained)) {
    assert.throws(() => update({ [column]: value }), appendOnly, `a redaction that keeps ${column} is partial`);
  }
  assert.throws(() => database.exec("UPDATE evidence_facts SET review_status = 'reviewed' WHERE id = 'fact-redact'"), appendOnly);

  update();
  const redacted = evidence.get('fact-redact');
  assert.equal(redacted.epistemic_state, 'unknown');
  assert.equal(redacted.value, null);
  assert.equal(redacted.source_page_id, null);
  assert.equal(redacted.source_locator, null);
  assert.equal(redacted.permittedViewers, null);
  assert.equal(redacted.redaction_reason_code, 'consent_revoked');
  assert.equal(redacted.fact_key, 'room_limit', 'identity and provenance survive');
  assert.equal(redacted.statement_adult_id, 'adult-parameters');
  assert.equal(JSON.stringify(redacted).includes('500000'), false);
  // A redacted fact is final and still cannot be deleted.
  assert.throws(() => database.exec(`UPDATE evidence_facts SET redacted_at = '${at}' WHERE id = 'fact-redact'`), appendOnly);
  assert.throws(() => database.exec("UPDATE evidence_facts SET redaction_reason_code = 'other' WHERE id = 'fact-redact'"), appendOnly);
  assert.throws(() => database.exec("DELETE FROM evidence_facts WHERE id = 'fact-redact'"), appendOnly);
});

test('evidence facts cannot be inserted redacted and reason codes are constrained', t => {
  const { database } = open(t);
  const insert = (id, redactedAt, reasonCode) => database.prepare(`INSERT INTO evidence_facts
    (id, household_id, fact_key, epistemic_state, evidence_kind, provenance_kind, asserted_by, observed_at, created_at,
     redacted_at, redaction_reason_code)
    VALUES (?, ?, 'room_limit', 'unknown', 'fixture', 'fixture', 'fixture', ?, ?, ?, ?)`)
    .run(id, household, at, at, redactedAt, reasonCode);
  assert.throws(() => insert('fact-born-redacted', at, 'consent_revoked'), /cannot be inserted redacted/);
  assert.throws(() => insert('fact-reason-only', null, 'consent_revoked'), /cannot be inserted redacted|CHECK constraint failed/);
  insert('fact-plain', null, null);
  const fact = database.prepare("SELECT redacted_at FROM evidence_facts WHERE id = 'fact-plain'").get();
  assert.equal(fact.redacted_at, null);
  // The pairing and format CHECK also guards the redaction update itself.
  const erasure = overrides => database.exec(`UPDATE evidence_facts SET ${erase(overrides)} WHERE id = 'fact-plain'`);
  assert.throws(() => erasure({ redaction_reason_code: "'Consent Revoked'" }), /CHECK constraint failed/);
  assert.throws(() => erasure({ redacted_at: "''" }), /CHECK constraint failed|ISO-8601 UTC with milliseconds/);
  for (const value of ["'yesterday'", "'2026-10-18T12:00:00Z'", "'2026-10-18T12:00:00.000Zjunk'", "'2026-13-01T00:00:00.000Z'", "'2026-10-18T25:00:00.000Z'"]) {
    assert.throws(() => erasure({ redacted_at: value }), /CHECK constraint failed|ISO-8601 UTC with milliseconds/, `redacted_at ${value}`);
  }
  erasure();
});

test('document erasure redacts facts sourced from that document and only those', t => {
  const { database, evidence } = open(t);
  documentFact(evidence, 'fact-erased');
  documentFact(evidence, 'fact-kept', 'page-kept');
  database.exec("UPDATE document_uploads SET lifecycle_state = 'quarantined' WHERE id = 'document-parameters'");
  assert.equal(evidence.get('fact-erased').redacted_at, null, 'quarantine is not erasure');
  database.exec("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-parameters'");
  const erased = evidence.get('fact-erased');
  assert.equal(erased.value, null);
  assert.equal(erased.source_page_id, null);
  assert.equal(erased.epistemic_state, 'unknown');
  assert.equal(erased.redaction_reason_code, 'document_erasure');
  assert.match(erased.redacted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assertErased(erased, 'deletion_requested');
  assert.equal(evidence.get('fact-kept').redacted_at, null);
  assert.deepEqual(evidence.get('fact-kept').value, { limitMinor: 500000, currency: 'INR' });

  // A direct move to deleted is erasure too.
  database.exec("UPDATE document_uploads SET lifecycle_state = 'deleted' WHERE id = 'document-kept'");
  assertErased(evidence.get('fact-kept'), 'deleted');
  assert.equal(evidence.get('fact-kept').redaction_reason_code, 'document_erasure');
});

test('a fact cannot cite a page of a document whose erasure has started', t => {
  const { database, evidence } = open(t);
  documentFact(evidence, 'fact-before');
  database.exec("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-parameters'");
  assert.throws(() => documentFact(evidence, 'fact-after-request'), /evidence facts cannot cite an erased document/);
  database.exec("UPDATE document_uploads SET lifecycle_state = 'deleted' WHERE id = 'document-kept'");
  assert.throws(() => documentFact(evidence, 'fact-after-delete', 'page-kept'), /evidence facts cannot cite an erased document/);
  documentFact(evidence, 'fact-live', 'page-other');
  assert.equal(evidence.get('fact-live').redacted_at, null);
});

test('migration 010 redacts facts of documents whose erasure started before 009', t => {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-010-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL('../src/backend/database/migrations', import.meta.url));
  for (const name of readdirSync(source).filter(file => /^00[1-8]_.*\.sql$/.test(file))) copyFileSync(join(source, name), join(directory, name));
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  database.exec('PRAGMA foreign_keys = ON');
  runMigrations(database, { directory });
  seedParameterWorld(database);
  const evidence = new EvidenceRepository(database, { clock: () => new Date(at) });
  documentFact(evidence, 'fact-erased-document');
  documentFact(evidence, 'fact-live-document', 'page-other');
  database.exec("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-parameters'");

  // 009 and 010 are applied after the erasure began; 010 carries the backfill (009 is immutable).
  for (const name of ['009_evidence_fact_redaction.sql', '010_evidence_fact_redaction_hardening.sql']) copyFileSync(join(source, name), join(directory, name));
  assert.deepEqual(runMigrations(database, { directory }), ['009_evidence_fact_redaction.sql', '010_evidence_fact_redaction_hardening.sql']);
  const erased = database.prepare("SELECT * FROM evidence_facts WHERE id = 'fact-erased-document'").get();
  assertErased(erased, 'backfill');
  assert.equal(erased.redaction_reason_code, 'document_erasure');
  assert.match(erased.redacted_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(database.prepare("SELECT redacted_at FROM evidence_facts WHERE id = 'fact-live-document'").get().redacted_at, null);
});

test('consent revocation redacts facts derived from the revoked documents with a counts-only audit event', t => {
  const { database, evidence, consents } = open(t);
  documentFact(evidence, 'fact-page-1');
  documentFact(evidence, 'fact-page-2', 'page-other');
  documentFact(evidence, 'fact-other-grant', 'page-kept');
  evidence.append({
    id: 'fact-statement', householdId: household, factKey: 'preferred_hospital', value: 'Synthetic hospital',
    epistemicState: 'known', provenanceKind: 'adult_statement', statementAdultId: 'adult-parameters', assertedBy: 'adult-parameters',
  });

  consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters', reason: 'fixture' });

  for (const id of ['fact-page-1', 'fact-page-2']) {
    const fact = evidence.get(id);
    assertErased(fact, id);
    assert.equal(fact.value, null, `${id} value erased`);
    assert.equal(fact.source_page_id, null);
    assert.equal(fact.redacted_at, later);
    // The repository path ran (and was audited) before the document lifecycle safety net.
    assert.equal(fact.redaction_reason_code, 'consent_revoked');
  }
  assert.deepEqual(evidence.get('fact-other-grant').value, { limitMinor: 500000, currency: 'INR' });
  assert.equal(evidence.get('fact-statement').value, 'Synthetic hospital', 'statements are not derived from the revoked documents');

  const events = database.prepare("SELECT * FROM audit_events WHERE action = 'evidence.facts_erased'").all();
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0].event_payload_json), { reason: 'consent_revoked', facts: 2, documents: 2 });
  assert.equal(events[0].household_id, household);
  assert.equal(events[0].resource_type, 'consent_grant');
  assert.equal(events[0].resource_id, 'consent-parameters');
  assert.equal(JSON.stringify(events).includes('500000'), false, 'the audit event holds counts only');

  // Idempotent: a second erasure finds nothing and writes no event.
  const again = consents.eraseDerivedRunData({
    householdId: household, documentIds: ['document-parameters', 'document-other'], reason: 'consent_revoked',
    resourceType: 'consent_grant', resourceId: 'consent-parameters',
  });
  assert.equal(again.facts, 0);
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'evidence.facts_erased'").get().count, 1);
});

test('commit-time erasure redacts facts with its reason and stays inside the household', t => {
  const { database, evidence, consents } = open(t);
  documentFact(evidence, 'fact-stale');
  const wrongHousehold = consents.eraseDerivedRunData({
    householdId: 'household-other', documentIds: ['document-parameters'], reason: 'source_consent_not_current',
    resourceType: 'workflow_run', resourceId: 'run-parameters',
  });
  assert.equal(wrongHousehold.facts, 0, 'another household cannot erase these facts');
  assert.equal(evidence.get('fact-stale').redacted_at, null);

  const result = consents.eraseDerivedRunData({
    householdId: household, documentIds: ['document-parameters'], reason: 'source_consent_not_current',
    resourceType: 'workflow_run', resourceId: 'run-parameters',
  });
  assert.equal(result.facts, 1);
  assert.equal(evidence.get('fact-stale').redaction_reason_code, 'source_consent_not_current');
  assertErased(evidence.get('fact-stale'), 'commit-time');
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'evidence.facts_erased'").get().count, 1);
});

test('consent revocation erases policy fields and membership links derived from its document', t => {
  const { database, consents } = open(t);
  database.prepare(`INSERT INTO policies
    (id, household_id, policy_kind, policy_number_masked, policy_version, starts_on, ends_on,
     source_document_id, verification_state, created_at, updated_at)
    VALUES ('policy-revoked-document', ?, 'personal', '****9999', 'secret-version',
      '2026-01-01', '2026-12-31', 'document-parameters', 'document_backed', ?, ?)`)
    .run(household, at, at);
  database.prepare(`INSERT INTO policy_members
    (policy_id, household_member_id, membership_state, member_reference_masked, source_page_id, created_at)
    VALUES ('policy-revoked-document', 'member-parameters', 'document_backed',
      'sensitive-member-reference', 'page-parameters', ?)`)
    .run(at);

  consents.revoke({ grantId: 'consent-parameters', revokedByAdultId: 'adult-parameters', reason: 'fixture' });

  const policy = database.prepare(`SELECT policy_kind, policy_number_masked, policy_version,
    starts_on, ends_on, verification_state FROM policies WHERE id = 'policy-revoked-document'`).get();
  assert.deepEqual({ ...policy }, {
    policy_kind: 'unknown', policy_number_masked: null, policy_version: null,
    starts_on: null, ends_on: null, verification_state: 'unverified',
  });
  assert.equal(database.prepare("SELECT count(*) AS count FROM policy_members WHERE policy_id = 'policy-revoked-document'").get().count, 0);
});
