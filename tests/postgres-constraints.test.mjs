import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';
import {
  assertConstraintRejects as rejectsWith, at, hex, insert, later, one, seedParameter, seedWorld,
} from './support/postgres-fixtures.mjs';

const CHECK_VIOLATION = '23514';
const FOREIGN_KEY_VIOLATION = '23503';
const UNIQUE_VIOLATION = '23505';
const NOT_NULL_VIOLATION = '23502';

// Constraints that SQLite expressed with GLOB, json_valid, julianday, typeof-style flags and rowid keys.
test('GLOB-translated checks accept and reject exactly the same strings as SQLite', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const cases = {
    'registry version': {
      sqlite: "SELECT length(?1) BETWEEN 3 AND 64 AND ?1 GLOB 'policy-parameters/v[0-9]*' AND ?1 NOT GLOB '*[^a-z0-9/.-]*'",
      postgres: "SELECT length($1::text) BETWEEN 3 AND 64 AND $1::text ~ '^policy-parameters/v[0-9]' AND NOT ($1::text ~ '[^a-z0-9/.-]')",
      values: ['policy-parameters/v1', 'policy-parameters/v12.3-rc', 'policy-parameters/v', 'policy-parameters/vx', 'Policy-parameters/v1',
        'policy-parameters/v1 ', 'policy-parameters/v1\n', 'policy-parameters/v1_', 'policy-parameters/v1/é', 'xpolicy-parameters/v1',
        'policy-parameters/v1/' + 'a'.repeat(60), 'other/v1', ''],
    },
    'parameter key tail': {
      sqlite: "SELECT length(?1) BETWEEN 3 AND 128 AND substr(?1, 1, 1) BETWEEN 'a' AND 'k' AND substr(?1, 2, 1) = '.' AND substr(?1, 3) NOT GLOB '*[^a-z0-9_]*'",
      postgres: "SELECT length($1::text) BETWEEN 3 AND 128 AND substr($1::text, 1, 1) BETWEEN 'a' AND 'k' AND substr($1::text, 2, 1) = '.' AND NOT (substr($1::text, 3) ~ '[^a-z0-9_]')",
      values: ['a.policy_type', 'k.x', 'l.x', 'A.x', 'a.', 'a.X', 'a.x-y', 'a.x y', 'a.x\n', 'ab.x', 'a.é', '.x', 'j.room_rent_limit', 'a.' + 'x'.repeat(130)],
    },
    'hex digest': {
      sqlite: "SELECT length(?1) = 64 AND ?1 NOT GLOB '*[^a-f0-9]*'",
      postgres: "SELECT length($1::text) = 64 AND NOT ($1::text ~ '[^a-f0-9]')",
      values: ['a'.repeat(64), '0'.repeat(64), 'f'.repeat(63) + 'g', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(63) + '\n', ''],
    },
    'reason code': {
      sqlite: "SELECT length(?1) BETWEEN 1 AND 64 AND ?1 NOT GLOB '*[^a-z0-9_]*'",
      postgres: "SELECT length($1::text) BETWEEN 1 AND 64 AND NOT ($1::text ~ '[^a-z0-9_]')",
      values: ['document_erasure', 'a', 'A', 'a-b', 'a b', '', 'a'.repeat(64), 'a'.repeat(65), 'é', 'a_1'],
    },
  };
  for (const [name, definition] of Object.entries(cases)) {
    for (const value of definition.values) {
      const expected = Number(Object.values(sqlite.prepare(definition.sqlite).get(value))[0]);
      const actual = Number((await pool.query(definition.postgres, [value])).rows[0]['?column?']);
      assert.equal(actual, expected, `${name}: ${JSON.stringify(value)}`);
    }
  }
});

test('the real constraints enforce the translated checks', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  await seedParameter(pool, a, 'one');

  await rejectsWith(pool.query("INSERT INTO coverage_parameter_registry_versions VALUES ('other/v1', $1)", [at]), CHECK_VIOLATION);
  await rejectsWith(pool.query("INSERT INTO coverage_parameter_registry_versions VALUES ('policy-parameters/vX', $1)", [at]), CHECK_VIOLATION);
  await rejectsWith(pool.query("INSERT INTO coverage_parameter_registry_versions VALUES ('policy-parameters/v1 ', $1)", [at]), CHECK_VIOLATION);
  const record = key => insert(pool, 'coverage_parameter_records', {
    id: `record-${key}`, workflow_run_id: a.run, household_id: a.household, case_id: a.case, subject_id: a.member,
    policy_id: a.policy, parameter_key: key,
  });
  await record('k.good_key_1');
  for (const bad of ['l.x', 'A.x', 'a.X', 'a.x-y', 'a.', 'zz']) await rejectsWith(record(bad), CHECK_VIOLATION);

  const observation = extra => insert(pool, 'coverage_parameter_observations', {
    id: `o-${Math.random()}`, parameter_record_id: 'parameter-one', source_id: a.page, document_id: a.document, ...extra,
  });
  await observation({});
  await rejectsWith(observation({ source_digest: 'A'.repeat(64) }), CHECK_VIOLATION);
  await rejectsWith(observation({ source_digest: 'a'.repeat(63) }), CHECK_VIOLATION);
  await rejectsWith(observation({ value_json: null }), CHECK_VIOLATION);
  await rejectsWith(observation({ redacted_at: later, redaction_reason_code: 'ok_code' }), CHECK_VIOLATION);
  await rejectsWith(observation({ value_json: null, redacted_at: later, redaction_reason_code: 'Bad-Code' }), CHECK_VIOLATION);
});

test('json checks, flags, ranges and identity keys behave as in SQLite', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const outbox = extra => insert(pool, 'integration_outbox', { id: `ob-${Math.random()}`, consent_grant_id: a.consent, ...extra });
  await outbox({ payload_json: '{"a":[1,{"b":null}]}' });
  await outbox({ payload_json: '[1,2]' });
  await outbox({ payload_json: '"scalar"' });
  for (const bad of ['', '{', "{'a':1}", '[1,]', 'undefined', '01', '{a:1}']) await rejectsWith(outbox({ payload_json: bad }), CHECK_VIOLATION);
  await insert(pool, 'evidence_facts', { id: 'f-null-json', household_id: a.household, value_json: null });
  await rejectsWith(insert(pool, 'evidence_facts', { id: 'f-bad-json', household_id: a.household, value_json: '{', epistemic_state: 'known' }), CHECK_VIOLATION);

  await rejectsWith(insert(pool, 'service_cases', {
    id: 'c-flag', household_id: a.household, opened_by_adult_id: a.adult, emergency_mode: 2,
  }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'service_cases', {
    id: 'c-negative', household_id: a.household, opened_by_adult_id: a.adult, stated_estimate_minor: -1,
  }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'service_cases', {
    id: 'c-currency', household_id: a.household, opened_by_adult_id: a.adult, currency: 'INRR',
  }), CHECK_VIOLATION);
  const flagged = await insert(pool, 'service_cases', {
    id: 'c-ok', household_id: a.household, opened_by_adult_id: a.adult, stated_estimate_minor: 9_000_000_000, currency: 'INR',
  });
  assert.equal(flagged.emergency_mode, '0', 'flags are bigint, returned as strings by the driver');
  assert.equal(flagged.stated_estimate_minor, '9000000000', 'values above 2^31 survive');

  await rejectsWith(insert(pool, 'source_pages', { id: 'sp-0', document_upload_id: a.document, page_number: 0, source_version: 'x' }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'source_pages', {
    id: 'sp-conf', document_upload_id: a.document, page_number: 9, source_version: 'x', confidence_basis_points: 10001,
  }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'ocr_jobs', { id: 'j-attempts', document_upload_id: a.document, attempt_count: 6 }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'document_uploads', {
    id: 'd-size', household_id: a.household, uploaded_by_adult_id: a.adult, consent_grant_id: a.consent, byte_size: 0,
  }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'document_uploads', {
    id: 'd-hash', household_id: a.household, uploaded_by_adult_id: a.adult, consent_grant_id: a.consent, content_sha256: 'abc',
  }), CHECK_VIOLATION);
  await rejectsWith(pool.query("INSERT INTO household_members (id, household_id, display_name, member_kind, created_at, updated_at) VALUES ('m-adult', $1, 'x', 'adult', 'a', 'b')", [a.household]), CHECK_VIOLATION);
  await rejectsWith(pool.query('INSERT INTO households (id, display_name, status, created_at, updated_at) VALUES ($1, $2, $3, $4, $4)', ['h-status', 'x', 'archived', at]), CHECK_VIOLATION);

  await rejectsWith(insert(pool, 'integration_outbox', { id: 'ob-voice', provider: 'gnani', consent_grant_id: a.consent }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'integration_outbox', {
    id: 'ob-payment', provider: 'pine_labs', consent_grant_id: a.consent, human_approval_id: null,
  }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'release_gates', { id: 'g', workflow_run_id: a.run, status: 'passed', blocker_count: 1 }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'consent_grants', {
    id: 'c-revoked-early', household_id: a.household, subject_adult_id: a.adult, revoked_at: '2026-10-16T09:00:00.000Z',
  }), CHECK_VIOLATION);
  await rejectsWith(insert(pool, 'fact_conflicts', { id: 'x-self', left_fact_id: a.fact, right_fact_id: a.fact }), CHECK_VIOLATION);

  const first = await insert(pool, 'audit_events', { event_hash: hex('1') });
  const second = await insert(pool, 'audit_events', { event_hash: hex('2') });
  assert.equal(BigInt(second.id), BigInt(first.id) + 1n, 'identity keys increase');
  const explicit = await insert(pool, 'audit_events', { id: 900, event_hash: hex('3') });
  assert.equal(explicit.id, '900', 'BY DEFAULT permits an explicit id, as an INTEGER PRIMARY KEY did');
  await rejectsWith(insert(pool, 'audit_events', { event_hash: hex('1') }), UNIQUE_VIOLATION);
  await rejectsWith(insert(pool, 'audit_events', { event_hash: 'short' }), CHECK_VIOLATION);
  const event = await insert(pool, 'workflow_events', { workflow_run_id: a.run, event_type: 'created', event_payload_json: '{}', occurred_at: at });
  assert.ok(BigInt(event.id) > 0n);
});

test('api session checks use julianday and fail open on unparseable timestamps like SQLite', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const session = (id, extra) => insert(pool, 'api_sessions', { id, adult_user_id: a.adult, token_sha256: hex(id.slice(-1)), ...extra });
  await session('s-1', {});
  await session('s-offset', { issued_at: '2026-10-16T10:00:00+05:30', expires_at: '2026-10-16T05:00:00Z' });
  await rejectsWith(session('s-2', { expires_at: at }), CHECK_VIOLATION);
  await rejectsWith(session('s-3', { expires_at: '2026-10-16T09:59:59Z' }), CHECK_VIOLATION);
  await rejectsWith(session('s-4', { revoked_at: '2026-10-16T09:00:00Z' }), CHECK_VIOLATION);
  await session('s-5', { revoked_at: at });
  await session('s-6', { expires_at: 'not-a-date' });
  await rejectsWith(session('s-7', { token_sha256: 'short' }), CHECK_VIOLATION);
  await rejectsWith(session('s-8', { token_sha256: hex('1') }), UNIQUE_VIOLATION);
});

test('foreign keys use NO ACTION, uniques allow repeated NULLs, primary keys reject NULL', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  await rejectsWith(pool.query('DELETE FROM households WHERE id = $1', [a.household]), FOREIGN_KEY_VIOLATION);
  await rejectsWith(pool.query("UPDATE households SET id = 'renamed' WHERE id = $1", [a.household]), FOREIGN_KEY_VIOLATION);
  await rejectsWith(insert(pool, 'household_roles', { id: 'r-orphan', household_id: 'nope', adult_user_id: a.adult }), FOREIGN_KEY_VIOLATION);
  await rejectsWith(insert(pool, 'ocr_jobs', { id: 'j-orphan', document_upload_id: 'nope' }), 'P0001');
  await rejectsWith(pool.query('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (NULL, $1, $2, $2)', ['x', at]), NOT_NULL_VIOLATION);
  await rejectsWith(pool.query('INSERT INTO households (id, created_at, updated_at) VALUES ($1, $2, $2)', ['h-no-name', at]), NOT_NULL_VIOLATION);

  // UNIQUE (consent_grant_id, resource_type, resource_id, action, data_category, recipient) with NULL resource and recipient.
  const scope = id => insert(pool, 'consent_scopes', {
    id, consent_grant_id: a.consent, resource_type: 'case', resource_id: null, action: 'read', data_category: 'same', recipient: null,
  });
  await scope('scope-1');
  await scope('scope-2');
  assert.equal((await one(pool, "SELECT count(*)::int AS n FROM consent_scopes WHERE data_category = 'same'")).n, 2);
  await rejectsWith(insert(pool, 'household_roles', {
    id: 'r-dup', household_id: a.household, adult_user_id: a.adult,
  }), UNIQUE_VIOLATION);
  await insert(pool, 'ocr_jobs', { id: 'j-null-ref-1', document_upload_id: a.document, provider_job_ref: null });
  await insert(pool, 'ocr_jobs', { id: 'j-null-ref-2', document_upload_id: a.document, provider_job_ref: null });
  await insert(pool, 'ocr_jobs', { id: 'j-ref-1', document_upload_id: a.document, provider_job_ref: 'ref' });
  await rejectsWith(insert(pool, 'ocr_jobs', { id: 'j-ref-2', document_upload_id: a.document, provider_job_ref: 'ref' }), UNIQUE_VIOLATION);
});

test('active_consent_grants hides revoked and expired grants and parses offsets; ordering is bytewise', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const grant = (id, extra) => insert(pool, 'consent_grants', { id, household_id: a.household, subject_adult_id: a.adult, ...extra });
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 3_600_000).toISOString();
  await grant('g-open', {});
  await grant('g-future', { expires_at: future });
  await grant('g-future-offset', { expires_at: new Date(Date.now() + 3_600_000 + 19_800_000).toISOString().replace('Z', '+05:30') });
  await grant('g-past', { expires_at: past });
  await grant('g-past-date-only', { expires_at: '2020-01-01' });
  await grant('g-garbage', { expires_at: 'garbage' });
  await grant('g-revoked', { revoked_at: later });
  const active = (await pool.query('SELECT id FROM active_consent_grants ORDER BY id')).rows.map(row => row.id);
  assert.deepEqual(active.filter(id => id.startsWith('g-')), ['g-future', 'g-future-offset', 'g-open']);

  const collation = (await one(pool, 'SELECT datcollate FROM pg_database WHERE datname = current_database()')).datcollate;
  assert.equal(collation, 'C');
  const ordered = (await pool.query("SELECT v FROM unnest(ARRAY['b', 'B', 'a', 'é', 'Z', '_']) AS t(v) ORDER BY v")).rows.map(row => row.v);
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const expected = sqlite.prepare("SELECT v FROM (SELECT 'b' AS v UNION ALL SELECT 'B' UNION ALL SELECT 'a' UNION ALL SELECT 'é' UNION ALL SELECT 'Z' UNION ALL SELECT '_') ORDER BY v").all().map(row => row.v);
  assert.deepEqual(ordered, expected, 'ORDER BY matches SQLite BINARY');
  assert.equal((await one(pool, "SELECT ('a' < 'B') AS lt")).lt, false);
});
