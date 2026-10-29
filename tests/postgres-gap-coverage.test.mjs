import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadPostgresMigrations, runPostgresMigrations, validatePostgresSchema,
} from '../src/backend/database/postgres/index.js';
import { migrationDirectory, postgresTestOptions, useTestDatabase } from './support/postgres.mjs';
import {
  assertConstraintRejects, assertTriggerRejects, insert, one, seedWorld,
} from './support/postgres-fixtures.mjs';

// Behaviour the retired SQLite suites covered (tests/database-schema.test.mjs and
// tests/database-integrity-v2.test.mjs at 4e20271) that the PostgreSQL suites did not yet pin down.
// Every test runs against a database cloned from the migrated template; nothing here touches a hosted
// database. Data is synthetic.

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';

async function worldWithPayments(t) {
  const { pool } = await useTestDatabase(t);
  const world = await seedWorld(pool, 'a');
  return { pool, world };
}

// 1. External payment work cannot bypass human approval, even with a made-up approval id.
test('pine_labs outbox rows need a real human approval, not only a non-null one', postgresTestOptions(), async t => {
  const { pool, world } = await worldWithPayments(t);
  // pine_labs additionally needs a release gate (CHECK); give it a valid one so that only the approval varies.
  await insert(pool, 'release_gates', { id: 'gate-a', workflow_run_id: world.run });
  const payment = extra => insert(pool, 'integration_outbox', {
    id: extra.id, case_id: world.case, provider: 'pine_labs', operation: 'payment.create',
    consent_grant_id: world.consent, release_gate_id: 'gate-a', ...extra,
  });

  await assertConstraintRejects(payment({ id: 'outbox-no-approval' }), CHECK_VIOLATION);
  await assertConstraintRejects(payment({ id: 'outbox-dangling', human_approval_id: 'approval-missing' }), FOREIGN_KEY_VIOLATION);
  // The same dangling id without a release gate is refused too (PostgreSQL evaluates CHECKs before FK triggers).
  await assertConstraintRejects(insert(pool, 'integration_outbox', {
    id: 'outbox-dangling-no-gate', case_id: world.case, provider: 'pine_labs', operation: 'payment.create',
    consent_grant_id: world.consent, human_approval_id: 'approval-missing',
  }), CHECK_VIOLATION);
  // A voice call has no release-gate rule but still needs an approval.
  await assertConstraintRejects(insert(pool, 'integration_outbox', {
    id: 'outbox-voice', case_id: world.case, provider: 'gnani', operation: 'call.create', consent_grant_id: world.consent,
  }), CHECK_VIOLATION);
  assert.equal((await one(pool, 'SELECT count(*)::int AS n FROM integration_outbox')).n, 0, 'nothing was stored');

  await insert(pool, 'human_approvals', {
    id: 'approval-a', case_id: world.case, adult_user_id: world.adult, consent_grant_id: world.consent,
    approval_kind: 'payment', target_id: 'payment-1',
  });
  const stored = await payment({ id: 'outbox-approved', human_approval_id: 'approval-a' });
  assert.equal(stored.human_approval_id, 'approval-a', 'a real approval and gate are accepted');
});

// 2. Covering indexes. enable_seqscan = off is used because a freshly seeded table holds a handful of rows,
// for which the planner rightly prefers a sequential scan whatever indexes exist. Turning sequential scans
// off (SET LOCAL, so it dies with the transaction) makes the plan a pure function of "is a usable index
// there?", without depending on table statistics or having to seed thousands of rows. If the index is
// dropped the plan falls back to a Seq Scan and the assertions fail.
function planNodes(plan, nodes = []) {
  nodes.push(plan);
  for (const child of plan.Plans ?? []) planNodes(child, nodes);
  return nodes;
}

async function explain(pool, sql) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL enable_seqscan = off');
    const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
    await client.query('ROLLBACK');
    const root = (typeof rows[0]['QUERY PLAN'] === 'string' ? JSON.parse(rows[0]['QUERY PLAN']) : rows[0]['QUERY PLAN'])[0].Plan;
    const nodes = planNodes(root);
    return {
      indexes: nodes.map(node => node['Index Name']).filter(Boolean),
      types: nodes.map(node => node['Node Type']),
    };
  } finally {
    client.release();
  }
}

test('task claiming and household audit lookup use their covering indexes', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  for (let index = 0; index < 20; index += 1) {
    await insert(pool, 'workflow_tasks', {
      id: `task-${index}`, workflow_run_id: a.run, created_at: `2026-10-16T10:00:${String(index).padStart(2, '0')}.000Z`,
    });
    await insert(pool, 'audit_events', { household_id: a.household, case_id: a.case, event_hash: String(index).padStart(2, '0').repeat(32) });
  }
  await pool.query('ANALYZE workflow_tasks');
  await pool.query('ANALYZE audit_events');

  const task = await explain(pool, `SELECT * FROM workflow_tasks
    WHERE status = 'pending' AND (retry_available_at IS NULL OR julianday(retry_available_at) <= julianday('2026-10-16T12:00:00.000Z'))
    ORDER BY created_at, id LIMIT 1`);
  assert.ok(task.indexes.includes('workflow_tasks_claim_idx'), `claim query plan used ${JSON.stringify(task.indexes)}`);
  assert.ok(!task.types.includes('Sort'), 'the index order serves ORDER BY created_at, id; no sort step');
  assert.ok(!task.types.includes('Seq Scan'));

  const audit = await explain(pool, `SELECT event_hash FROM audit_events WHERE household_id = '${a.household}' ORDER BY id DESC LIMIT 1`);
  assert.ok(audit.indexes.includes('audit_events_household_chain_idx'), `audit lookup plan used ${JSON.stringify(audit.indexes)}`);
  assert.ok(!audit.types.includes('Sort'));
  assert.ok(!audit.types.includes('Seq Scan'));
});

// 3. UNKNOWN is a first-class stored state; claims need a citation.
test('evidence facts preserve UNKNOWN and require a source citation for claims', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const fact = (id, extra) => insert(pool, 'evidence_facts', {
    id, household_id: a.household, case_id: a.case, subject_member_id: a.member, statement_adult_id: a.adult, ...extra,
  });

  const unknown = await fact('fact-unknown', { fact_key: 'cashless_status' });
  assert.equal(unknown.epistemic_state, 'unknown');
  assert.equal(unknown.value_json, null, 'UNKNOWN keeps no value');
  assert.equal((await one(pool, "SELECT value_json FROM evidence_facts WHERE id = 'fact-unknown'")).value_json, null);

  // An UNKNOWN fact cannot carry an invented value, and a known fact cannot be empty.
  await assertConstraintRejects(fact('fact-invented', {
    fact_key: 'claim_payable', value_json: '500000', epistemic_state: 'unknown', evidence_kind: 'calculation',
    provenance_kind: 'calculation', calculation_method: 'fixture-arithmetic', asserted_by: 'agent',
  }), CHECK_VIOLATION);
  await assertConstraintRejects(fact('fact-known-empty', { fact_key: 'room_limit', epistemic_state: 'known', value_json: null }), CHECK_VIOLATION);

  // A document claim without a source page is refused; with one it is stored.
  const uncited = {
    fact_key: 'room_limit', value_json: '5000', epistemic_state: 'known', evidence_kind: 'document',
    provenance_kind: 'document_page', asserted_by: 'agent',
  };
  await assertConstraintRejects(fact('fact-uncited', uncited), CHECK_VIOLATION);
  const cited = await fact('fact-cited', { ...uncited, source_page_id: a.page });
  assert.equal(cited.source_page_id, a.page);

  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM evidence_facts WHERE id IN ('fact-invented', 'fact-known-empty', 'fact-uncited')")).n, 0);
  await assertTriggerRejects(pool.query("DELETE FROM evidence_facts WHERE id = 'fact-unknown'"), 'evidence facts are append only; add a superseding fact');
});

// 4. Explicit provenance: statements, institutional replies and calculations need no document page.
test('explicit provenance stores statements, replies and calculations without fake document pages', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const base = { household_id: a.household, case_id: a.case, epistemic_state: 'known' };

  const statement = await insert(pool, 'evidence_facts', {
    ...base, id: 'fact-statement', subject_member_id: a.member, fact_key: 'preferred_operator', value_json: '"Adult evidence"',
    provenance_kind: 'adult_statement', evidence_kind: 'adult_statement', statement_adult_id: a.adult, asserted_by: a.adult,
  });
  const reply = await insert(pool, 'evidence_facts', {
    ...base, id: 'fact-reply', fact_key: 'enrolment_status', value_json: '"confirmed"', provenance_kind: 'institutional_reply',
    evidence_kind: 'institutional_reply', institutional_source_ref: 'reply-fixture-1', asserted_by: 'institution-fixture',
  });
  const calculation = await insert(pool, 'evidence_facts', {
    ...base, id: 'fact-calculation', fact_key: 'premium_total_minor', value_json: '120000', provenance_kind: 'calculation',
    evidence_kind: 'calculation', calculation_method: 'sum-confirmed-premiums-v1', asserted_by: 'rules-engine',
  });
  assert.equal(statement.source_page_id, null);
  assert.equal(statement.statement_adult_id, a.adult);
  assert.equal(reply.institutional_source_ref, 'reply-fixture-1');
  assert.equal(reply.source_page_id, null);
  assert.equal(calculation.calculation_method, 'sum-confirmed-premiums-v1');
  assert.equal(JSON.parse(calculation.value_json), 120000);
  assert.equal(calculation.source_page_id, null);

  // Each kind refuses to be stored without its own provenance field.
  const bare = { ...base, asserted_by: 'extractor', value_json: '1' };
  await assertConstraintRejects(insert(pool, 'evidence_facts', {
    ...bare, id: 'bad-statement', fact_key: 'k1', provenance_kind: 'adult_statement', evidence_kind: 'adult_statement',
  }), CHECK_VIOLATION);
  await assertConstraintRejects(insert(pool, 'evidence_facts', {
    ...bare, id: 'bad-reply', fact_key: 'k2', provenance_kind: 'institutional_reply', evidence_kind: 'institutional_reply',
  }), CHECK_VIOLATION);
  await assertConstraintRejects(insert(pool, 'evidence_facts', {
    ...bare, id: 'bad-calculation', fact_key: 'k3', provenance_kind: 'calculation', evidence_kind: 'calculation',
  }), CHECK_VIOLATION);
  await assertConstraintRejects(insert(pool, 'evidence_facts', {
    ...bare, id: 'bad-document', fact_key: 'room_limit', provenance_kind: 'document_page', evidence_kind: 'document',
  }), CHECK_VIOLATION);
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM evidence_facts WHERE id LIKE 'bad-%'")).n, 0);
});

// 5. Data-preserving migration check. PostgreSQL has a squashed baseline (001_baseline_schema.sql is the
// whole v1+v2 SQLite schema), so no v1 -> v2 upgrade path exists to exercise; the SQLite test that upgraded
// v1 rows through migrations 002..019 has no equivalent. What can still regress is a re-run of the runner
// against a database that holds data: it must be a no-op that leaves rows, the ledger and every foreign key
// untouched. The rows below are seeded into the full current schema (all migrations applied).
const SEEDED_TABLES = [
  'households', 'adult_users', 'household_roles', 'household_members', 'consent_grants', 'service_cases',
  'policies', 'document_uploads', 'ocr_jobs', 'source_pages', 'evidence_facts', 'workflow_runs', 'human_reviews',
];

async function snapshot(pool, tables) {
  const result = {};
  for (const table of tables) {
    const { rows } = await pool.query(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text), '[]'::jsonb) AS rows FROM ${table} t`,
    );
    result[table] = rows[0].rows;
  }
  return result;
}

test('re-running migrations keeps seeded evidence, consent, document and page rows and every foreign key valid', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  await insert(pool, 'evidence_facts', {
    id: 'fact-known', household_id: a.household, case_id: a.case, subject_member_id: a.member, statement_adult_id: a.adult,
    fact_key: 'room_limit', value_json: '5000', epistemic_state: 'known', evidence_kind: 'document',
    provenance_kind: 'document_page', source_page_id: a.page, asserted_by: 'extractor', supersedes_fact_id: a.fact,
  });

  const before = await snapshot(pool, SEEDED_TABLES);
  for (const table of ['evidence_facts', 'consent_grants', 'document_uploads', 'source_pages']) {
    assert.ok(before[table].length >= 1, `${table} is seeded`);
  }
  assert.equal(before.evidence_facts.length, 2);
  const ledgerBefore = (await pool.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows;
  const directory = migrationDirectory();
  assert.equal(ledgerBefore.length, loadPostgresMigrations(directory).length, 'every migration file is recorded');

  assert.deepEqual(await runPostgresMigrations(pool, { directory }), [], 'a second run applies nothing');

  assert.deepEqual(await snapshot(pool, SEEDED_TABLES), before, 'rows are byte-for-byte unchanged');
  assert.deepEqual((await pool.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version')).rows, ledgerBefore);

  const foreignKeys = (await pool.query(`
    SELECT conrelid::regclass::text AS child, conname, convalidated FROM pg_constraint
    WHERE contype = 'f' AND connamespace = current_schema()::regnamespace`)).rows;
  assert.ok(foreignKeys.length > 50, `foreign keys exist (${foreignKeys.length})`);
  assert.deepEqual(foreignKeys.filter(fk => !fk.convalidated), [], 'no foreign key is NOT VALID');

  const validation = await validatePostgresSchema(pool);
  assert.deepEqual(validation.foreignKeyErrors, [], 'no orphaned rows');
  assert.equal(validation.valid, true);
  // The seeded fact still resolves through every reference it holds.
  const joined = await one(pool, `
    SELECT f.id FROM evidence_facts f
    JOIN source_pages p ON p.id = f.source_page_id
    JOIN document_uploads d ON d.id = p.document_upload_id
    JOIN consent_grants c ON c.id = d.consent_grant_id
    JOIN households h ON h.id = f.household_id
    WHERE f.id = 'fact-known' AND c.household_id = h.id`);
  assert.equal(joined.id, 'fact-known');
});
