import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, runMigrations, validateSchema } from '../src/backend/database/index.js';

const at = '2026-09-17T10:00:00.000Z';

function seedIdentity(database) {
  database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-1', 'Synthetic household', at, at);
  database.prepare('INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('adult-1', 'Synthetic adult', 'active', at, at);
  database.prepare('INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('role-1', 'household-1', 'adult-1', 'owner', 'active', at);
  database.prepare('INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('member-1', 'household-1', 'adult-1', 'Synthetic adult', 'adult', at, at);
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('consent-1', 'household-1', 'adult-1', 'coversaath-local', 'document_processing', 'v1', 'fixture', at, at);
  database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('case-1', 'household-1', 'member-1', 'adult-1', 'planned_care', 'created', at, at);
}

test('a fresh local database migrates to the complete v1 schema', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'coversaath-db-'));
  const database = openDatabase({ path: join(directory, 'coversaath.sqlite') });
  const validation = validateSchema(database);
  assert.equal(validation.valid, true);
  assert.equal(validation.integrity, 'ok');
  assert.equal(validation.migrationCount, 2);
  assert.deepEqual(runMigrations(database), []);

  const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all().map(row => row.name);
  assert.equal(tables.some(name => /hrms/i.test(name)), false);
  database.close();
});

test('evidence facts preserve UNKNOWN and require a source citation for claims', () => {
  const database = openDatabase({ path: ':memory:' });
  seedIdentity(database);
  database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, subject_member_id, fact_key, value_json, epistemic_state, evidence_kind,
     provenance_kind, statement_adult_id, asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('fact-unknown', 'household-1', 'case-1', 'member-1', 'cashless_status', null, 'unknown',
      'adult_statement', 'adult_statement', 'adult-1', 'adult-1', at, at);

  assert.throws(() => database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind,
     calculation_method, asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('fact-invented', 'household-1', 'case-1', 'claim_payable', '500000', 'unknown',
      'calculation', 'calculation', 'fixture-arithmetic', 'agent', at, at), /CHECK constraint failed/);

  assert.throws(() => database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind,
     asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('fact-uncited', 'household-1', 'case-1', 'room_limit', '5000', 'known',
      'document', 'document_page', 'agent', at, at), /CHECK constraint failed/);
  database.close();
});

test('revoked consent blocks new provider work and audit events are append only', () => {
  const database = openDatabase({ path: ':memory:' });
  seedIdentity(database);
  database.prepare(`INSERT INTO consent_revocations
    (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run('revoke-1', 'consent-1', 'adult-1', 'Synthetic revocation', at, at);

  assert.throws(() => database.prepare(`INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('outbox-1', 'case-1', 'sarvam', 'ocr.submit', '{}', 'digest', 'consent-1', 'pending', at, at, at), /active consent is required/);

  database.prepare(`INSERT INTO audit_events
    (household_id, case_id, actor_type, actor_id, action, resource_type, resource_id, event_payload_json, event_hash, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('household-1', 'case-1', 'system', 'local-test', 'case.created', 'case', 'case-1', '{}', 'a'.repeat(64), at);
  assert.throws(() => database.exec("UPDATE audit_events SET action = 'changed'"), /append only/);
  assert.throws(() => database.exec('DELETE FROM audit_events'), /append only/);
  database.close();
});

test('external voice, payment and email work cannot bypass human approval gates', () => {
  const database = openDatabase({ path: ':memory:' });
  seedIdentity(database);
  assert.throws(() => database.prepare(`INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('outbox-voice', 'case-1', 'gnani', 'call.create', '{}', 'digest', 'consent-1', 'pending', at, at, at), /CHECK constraint failed/);
  assert.throws(() => database.prepare(`INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, human_approval_id, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('outbox-payment', 'case-1', 'pine_labs', 'payment.create', '{}', 'digest', 'consent-1', 'missing', 'pending', at, at, at), /CHECK constraint failed/);
  database.close();
});
