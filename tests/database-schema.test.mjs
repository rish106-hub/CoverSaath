// Schema behaviour on PostgreSQL (S3.2). Synthetic data only.
//
// SQLite-only tests removed with the SQLite runtime (design decisions 7 and 10), each with its
// PostgreSQL equivalent:
// - "a fresh local database migrates to the complete v1 schema": postgres-runner "a fresh database
//   migrates, records checksums, validates, and a repeat run is a no-op" and postgres-catalog-parity
//   "PostgreSQL catalog equals the final SQLite catalog ..." (exact table set, so no extra tables).
// - "revoked consent blocks new provider work and audit events are append only": postgres-triggers
//   "audit events are append only; revocation marks the grant; outbox needs active consent".
// - "external voice, payment and email work cannot bypass human approval gates":
//   postgres-constraints "json checks, flags, ranges and identity keys behave as in SQLite"
//   (gnani voice and pine_labs payment outbox rows rejected by CHECK).
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertDbError, freshDatabase, postgresTestOptions } from './support/pg.mjs';

const pg = postgresTestOptions();
const at = '2026-09-17T10:00:00.000Z';

async function seedIdentity(database) {
  await database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('household-1', 'Synthetic household', at, at);
  await database.prepare('INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('adult-1', 'Synthetic adult', 'active', at, at);
  await database.prepare('INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run('role-1', 'household-1', 'adult-1', 'owner', 'active', at);
  await database.prepare('INSERT INTO household_members (id, household_id, adult_user_id, display_name, member_kind, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('member-1', 'household-1', 'adult-1', 'Synthetic adult', 'adult', at, at);
  await database.prepare(`INSERT INTO service_cases
    (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('case-1', 'household-1', 'member-1', 'adult-1', 'planned_care', 'created', at, at);
}

test('evidence facts preserve UNKNOWN and require a source citation for claims', pg, async t => {
  const { db: database } = await freshDatabase(t);
  await seedIdentity(database);
  await database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, subject_member_id, fact_key, value_json, epistemic_state, evidence_kind,
     provenance_kind, statement_adult_id, asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('fact-unknown', 'household-1', 'case-1', 'member-1', 'cashless_status', null, 'unknown',
      'adult_statement', 'adult_statement', 'adult-1', 'adult-1', at, at);

  // UNKNOWN carries no invented value.
  await assertDbError(database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind,
     calculation_method, asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('fact-invented', 'household-1', 'case-1', 'claim_payable', '500000', 'unknown',
      'calculation', 'calculation', 'fixture-arithmetic', 'agent', at, at), { sqlstate: '23514', message: /check constraint/ });

  // A document claim must cite a source page.
  await assertDbError(database.prepare(`INSERT INTO evidence_facts
    (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind,
     asserted_by, observed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('fact-uncited', 'household-1', 'case-1', 'room_limit', '5000', 'known',
      'document', 'document_page', 'agent', at, at), { sqlstate: '23514', message: /check constraint/ });
  await assert.rejects(database.prepare("DELETE FROM evidence_facts WHERE id = 'fact-unknown'").run(), /append only/);
  assert.deepEqual((await database.prepare('SELECT id FROM evidence_facts ORDER BY id').all()).map(row => row.id), ['fact-unknown']);
});
