import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
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
  assert.throws(() => erasure({ redacted_at: "''" }), /CHECK constraint failed/);
  assert.throws(() => erasure({ redacted_at: "'yesterday'" }), /CHECK constraint failed/);
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
  assert.equal(evidence.get('fact-kept').redacted_at, null);
  assert.deepEqual(evidence.get('fact-kept').value, { limitMinor: 500000, currency: 'INR' });
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
  assert.equal(evidence.get('fact-stale').value, null);
  assert.equal(database.prepare("SELECT count(*) AS count FROM audit_events WHERE action = 'evidence.facts_erased'").get().count, 1);
});
