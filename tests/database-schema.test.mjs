import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, runMigrations, validateSchema } from '../src/backend/database/index.js';
import { createTestDatabase, sql } from './helpers/test-database.js';

const at = '2026-09-17T10:00:00.000Z';

async function seedIdentity(database) {
  await sql.run(database, 'INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    'household-1', 'Synthetic household', at, at);
  await sql.run(database, 'INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    'adult-1', 'Synthetic adult', 'active', at, at);
  await sql.run(database, 'INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    'role-1', 'household-1', 'adult-1', 'owner', 'active', at);
  await sql.run(database, 'INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    'member-1', 'household-1', 'adult-1', 'Synthetic adult', 'adult', at, at);
  await sql.run(database, `INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'consent-1', 'household-1', 'adult-1', 'knowvia-local', 'document_processing', 'v1', 'fixture', at, at);
  await sql.run(database, `INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  'case-1', 'household-1', 'member-1', 'adult-1', 'planned_care', 'created', at, at);
}

test('a fresh database migrates to the complete schema and migrations are idempotent', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  const validation = await validateSchema(database);
  assert.equal(validation.valid, true);
  assert.equal(validation.integrity, 'ok');
  assert.equal(validation.migrationCount, 1);
  assert.deepEqual(await runMigrations(database), []);
  const tables = (await database.query("SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema()")).map(row => row.name);
  assert.equal(tables.some(name => /hrms/i.test(name)), false);
});

test('an applied migration may never change, and a new migration applies exactly once', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowvia-migrations-'));
  const database = await createDatabase({ pglite: true });
  t.after(async () => { await database.close(); rmSync(directory, { recursive: true, force: true }); });
  mkdirSync(directory, { recursive: true });
  copyFileSync(new URL('../src/backend/database/migrations-pg/001_baseline.sql', import.meta.url), join(directory, '001_baseline.sql'));
  assert.deepEqual(await runMigrations(database, { directory }), ['001_baseline.sql']);
  writeFileSync(join(directory, '002_extra.sql'), 'CREATE TABLE migration_probe (id text PRIMARY KEY);');
  assert.deepEqual(await runMigrations(database, { directory }), ['002_extra.sql']);
  assert.deepEqual(await runMigrations(database, { directory }), []);
  writeFileSync(join(directory, '001_baseline.sql'), `${readFileSync(join(directory, '001_baseline.sql'), 'utf8')}\n-- edited`);
  await assert.rejects(runMigrations(database, { directory }), /Applied migration changed: 001_baseline.sql/);
});

test('evidence facts preserve UNKNOWN and require a source citation for claims', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await seedIdentity(database);
  await sql.run(database, `INSERT INTO evidence_facts
    (id, household_id, case_id, subject_member_id, fact_key, value_json, epistemic_state, evidence_kind,
     provenance_kind, statement_adult_id, asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'fact-unknown', 'household-1', 'case-1', 'member-1', 'cashless_status', null, 'unknown',
  'adult_statement', 'adult_statement', 'adult-1', 'adult-1', at, at);

  await assert.rejects(sql.run(database, `INSERT INTO evidence_facts
    (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind,
     calculation_method, asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'fact-invented', 'household-1', 'case-1', 'claim_payable', '500000', 'unknown',
  'calculation', 'calculation', 'fixture-arithmetic', 'agent', at, at), /violates check constraint/);

  await assert.rejects(sql.run(database, `INSERT INTO evidence_facts
    (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind,
     asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'fact-uncited', 'household-1', 'case-1', 'room_limit', '5000', 'known',
  'document', 'document_page', 'agent', at, at), /violates check constraint/);
});

test('revoked consent blocks new provider work and audit events are append only', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await seedIdentity(database);
  await sql.run(database, `INSERT INTO consent_revocations
    (id, consent_grant_id, revoked_by_adult_id, reason, revoked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`,
  'revoke-1', 'consent-1', 'adult-1', 'Synthetic revocation', at, at);

  await assert.rejects(sql.run(database, `INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'outbox-1', 'case-1', 'sarvam', 'ocr.submit', '{}', 'digest', 'consent-1', 'pending', at, at, at), /active consent is required/);

  await sql.run(database, `INSERT INTO audit_events
    (household_id, case_id, actor_type, actor_id, action, resource_type, resource_id, event_payload_json, event_hash, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'household-1', 'case-1', 'system', 'local-test', 'case.created', 'case', 'case-1', '{}', 'a'.repeat(64), at);
  await assert.rejects(database.exec("UPDATE audit_events SET action = 'changed'"), /append only/);
  await assert.rejects(database.exec('DELETE FROM audit_events'), /append only/);
});

test('external voice, payment and email work cannot bypass human approval gates', async t => {
  const database = await createTestDatabase();
  t.after(() => database.close());
  await seedIdentity(database);
  await assert.rejects(sql.run(database, `INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'outbox-voice', 'case-1', 'gnani', 'call.create', '{}', 'digest', 'consent-1', 'pending', at, at, at), /violates check constraint/);
  await assert.rejects(sql.run(database, `INSERT INTO integration_outbox
    (id, case_id, provider, operation, payload_json, payload_digest, consent_grant_id, human_approval_id, status, available_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  'outbox-payment', 'case-1', 'pine_labs', 'payment.create', '{}', 'digest', 'consent-1', 'missing', 'pending', at, at, at), /violates (check|foreign key) constraint/);
});
