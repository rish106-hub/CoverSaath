// S3: SQL proof that erasure leaves nothing behind (household, case, member), that another household is untouched, and that
// audit stays counts-only. Synthetic data only. The seeded world gives every household-scoped store at least one row with a
// canary string; after erasure no table may contain the canary and every remaining row must be content-free.
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { seedErasureWorld } from './support/erasure-world.mjs';
import { plainRows } from './support/sealed.mjs';
import { readFileSync } from 'node:fs';
import { DATA_STORES, ERASED_NAME } from '../src/contracts/data-lifecycle.js';

const opts = postgresTestOptions();
const actorOf = ids => ({ type: 'adult_user', id: ids.adult });

async function tables(db) {
  return (await db.many("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")).map(row => row.name);
}

// Tables whose rows mention the canary prefix anywhere (every column, as text).
async function canaryHits(db, prefix) {
  const hits = {};
  for (const name of await tables(db)) {
    const count = Number((await db.one(`SELECT count(*) AS n FROM "${name}" t WHERE t::text LIKE ?`, [`%${prefix}%`])).n);
    if (count > 0) hits[name] = count;
  }
  return hits;
}

// Rows in the household's scope per scoped table.
async function scopedCounts(db, householdId) {
  const counts = {};
  for (const store of DATA_STORES) {
    if (store.scope) counts[store.table] = Number((await db.one(`SELECT count(*) AS n FROM "${store.table}" WHERE ${store.scope}`, [householdId])).n);
  }
  return counts;
}

// Finish what the document worker does after the transaction: bytes are gone, then tombstones are pruned.
async function finishDocuments(services, db, documentIds) {
  for (const id of documentIds) await services.documents.completeDeletion(id);
  return services.erasure.pruneDeletedDocuments({});
}

test('registry classifies every table of the live catalog, and delete-blocking triggers match the kinds', opts, async t => {
  const { db } = await freshDatabase(t);
  const registered = new Set(DATA_STORES.map(store => store.table));
  const live = await tables(db);
  assert.deepEqual(live.filter(name => !registered.has(name)), [], 'a table has no erasure decision in src/contracts/data-lifecycle.js');
  assert.deepEqual([...registered].filter(name => !live.includes(name)), []);
  // A table the erasure may DELETE from must have no BEFORE DELETE trigger; the others must, or be tombstones/ledger/global.
  const blocked = new Set((await db.many(`SELECT DISTINCT c.relname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    WHERE NOT t.tgisinternal AND c.relnamespace = 'public'::regnamespace AND (t.tgtype & 8) = 8`)).map(row => row.name));
  for (const store of DATA_STORES) {
    if (['delete', 'scrub_prune'].includes(store.erasure)) assert.ok(!blocked.has(store.table), `${store.table} cannot be deleted from`);
    if (store.erasure === 'redact_only') assert.ok(blocked.has(store.table), `${store.table} is not append-only`);
  }
  // The erasure map document names every table.
  const doc = readFileSync(new URL('../docs/architecture/data-lifecycle.md', import.meta.url), 'utf8');
  for (const name of live) assert.ok(doc.includes(`\`${name}\``), `${name} is missing from docs/architecture/data-lifecycle.md`);
  // Every scoped store has an export decision recorded (null is a decision) and a note.
  for (const store of DATA_STORES) assert.ok(store.note.length > 0);
});

test('household erasure: nothing left but content-free tombstones; other household untouched; audit counts only', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  const b = await seedErasureWorld(handle.pool, services, 'b');
  // Non-vacuous: every scoped, non-global store has rows before.
  const before = await scopedCounts(db, a.household);
  for (const store of DATA_STORES) {
    if (store.scope && store.erasure !== 'ledger') assert.ok(before[store.table] > 0, `seed has no row in ${store.table}`);
  }
  assert.ok(Object.keys(await canaryHits(db, a.canaryPrefix)).length >= 15, 'canaries are present before erasure');
  const bBefore = await scopedCounts(db, b.household);
  const bCanaries = await canaryHits(db, b.canaryPrefix);

  const adult2Audits = Number((await db.one('SELECT count(*) AS n FROM audit_events WHERE household_id = ? AND actor_id = ?', [a.household, a.adult2])).n);
  assert.ok(adult2Audits > 0);
  const result = await services.erasure.eraseHousehold({ householdId: a.household, actor: actorOf(a), reason: 'data_subject_request' });
  await finishDocuments(services, db, result.documentIds);

  // 1. No canary anywhere in the database.
  assert.deepEqual(await canaryHits(db, a.canaryPrefix), {});
  // 2. Delete-kind stores are empty.
  const after = await scopedCounts(db, a.household);
  for (const store of DATA_STORES) {
    if (store.scope && store.erasure === 'delete') assert.equal(after[store.table], 0, `${store.table} still has rows`);
  }
  const residue = Object.fromEntries(Object.entries(after).filter(([, n]) => n > 0));
  // 3. Exactly the documented residue remains: rows that an audit foreign key or an append-only table still pins.
  assert.deepEqual(residue, {
    households: 1, household_members: 2, consent_grants: 1, service_cases: 1, workflow_runs: 1, document_uploads: 1, ocr_jobs: 1, source_pages: 1,
    policies: 1, evidence_facts: 2, coverage_parameter_records: 1, coverage_parameter_observations: 1, coverage_parameter_registry_pins: 1,
    policy_structuring_runs: 1, policy_structuring_jobs: 1, proposed_parameters: 1, retention_records: 2, audit_events: residue.audit_events,
  });
  // 4. ... and every residual row is content-free.
  const none = async (sql, params = []) => assert.equal(Number((await db.one(`SELECT count(*) AS n FROM ${sql}`, params)).n), 0, sql);
  await none(`households WHERE id = ? AND (display_name <> ? OR status <> 'closed')`, [a.household, ERASED_NAME]);
  await none(`household_members WHERE household_id = ? AND (display_name <> ? OR relationship_label IS NOT NULL OR date_of_birth IS NOT NULL)`, [a.household, ERASED_NAME]);
  await none(`consent_grants WHERE household_id = ? AND revoked_at IS NULL`, [a.household]);
  await none(`service_cases WHERE household_id = ? AND (status <> 'closed' OR subject_member_id IS NOT NULL OR stated_estimate_minor IS NOT NULL OR currency IS NOT NULL OR trigger_type <> 'user_requested_review')`, [a.household]);
  await none(`workflow_runs WHERE case_id = ? AND input_json IS NOT NULL`, [a.case]);
  // The filename is sealed at rest (D2): open it before comparing with the tombstone marker.
  await none(`document_uploads WHERE household_id = ? AND lifecycle_state <> 'deleted'`, [a.household]);
  assert.deepEqual((await plainRows(db, 'document_uploads', 'WHERE household_id = ?', [a.household])).filter(row => row.original_filename !== '[deleted]'), []);
  await none(`ocr_jobs WHERE document_upload_id = ? AND (result_json IS NOT NULL OR authorization_json IS NOT NULL)`, [a.document]);
  await none(`source_pages WHERE document_upload_id = ? AND (extracted_text IS NOT NULL OR blocks_json IS NOT NULL OR provenance_json IS NOT NULL)`, [a.document]);
  await none(`policies WHERE household_id = ? AND (policy_number_masked IS NOT NULL OR starts_on IS NOT NULL OR ends_on IS NOT NULL OR insurer_id IS NOT NULL OR policy_kind <> 'unknown')`, [a.household]);
  await none(`evidence_facts WHERE household_id = ? AND (value_json IS NOT NULL OR redacted_at IS NULL OR epistemic_state <> 'unknown' OR source_locator IS NOT NULL)`, [a.household]);
  await none(`coverage_parameter_observations WHERE parameter_record_id = ? AND (value_json IS NOT NULL OR redacted_at IS NULL)`, [a.parameter]);
  await none(`proposed_parameters WHERE household_id = ? AND (value_json IS NOT NULL OR label IS NOT NULL OR redacted_at IS NULL)`, [a.household]);
  await none(`policy_structuring_runs WHERE household_id = ? AND erased_at IS NULL`, [a.household]);
  await none(`policy_structuring_jobs WHERE household_id = ? AND erased_at IS NULL`, [a.household]);
  await none(`retention_records WHERE household_id = ? AND deletion_state <> 'deleted'`, [a.household]);
  // Document bytes are gone.
  await none(`document_blobs WHERE household_id = ?`, [a.household]);
  // Adults of the household: no credentials, no sessions, no contact data (a closed tombstone or gone).
  const adults = [a.adult, a.adult2, a.placeholderAdult];
  await none(`adult_users WHERE id = ANY(CAST(? AS text[])) AND (display_name <> ? OR account_status <> 'closed' OR contact_email IS NOT NULL OR contact_phone IS NOT NULL OR contact_email_hash IS NOT NULL OR phone_ciphertext IS NOT NULL OR phone_hash IS NOT NULL)`, [adults, ERASED_NAME]);
  await none(`api_sessions WHERE adult_user_id = ANY(CAST(? AS text[]))`, [adults]);
  await none(`auth_identities WHERE adult_user_id = ANY(CAST(? AS text[]))`, [adults]);
  await none(`idempotency_keys WHERE scope LIKE ?`, [`document-upload:${a.adult}:%`]);
  await none(`app_events WHERE household_id = ? OR adult_user_id = ANY(CAST(? AS text[]))`, [a.household, adults]);
  // 5. Audit: codes and counts only; the chain is intact (append-only triggers untouched).
  const safe = value => typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value))
    || (Array.isArray(value) && value.every(safe)) || (value !== null && typeof value === 'object' && Object.values(value).every(safe));
  const events = await db.many('SELECT action, event_payload_json FROM audit_events WHERE household_id = ?', [a.household]);
  for (const event of events) assert.ok(safe(JSON.parse(event.event_payload_json)), `audit payload of ${event.action} is not counts and codes only`);
  assert.ok(events.some(event => event.action === 'household.erased'));
  assert.ok(events.some(event => event.action === 'case.erased'));
  // 6. The other household is untouched, content and counts.
  assert.deepEqual(await scopedCounts(db, b.household), bBefore);
  assert.deepEqual(await canaryHits(db, b.canaryPrefix), bCanaries);
  // 6b. Nested erasure audits name the erasing owner, never another adult whose grant was revoked on their behalf.
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM audit_events WHERE household_id = ? AND actor_id = ?', [a.household, a.adult2])).n), adult2Audits, 'erasure wrote audit events as another adult');
  const revokedByOwner = await db.one(`SELECT actor_id FROM audit_events WHERE household_id = ? AND action = 'consent.revoked' AND resource_id = ?`, [a.household, a.consent3]);
  assert.equal(revokedByOwner.actor_id, a.adult);
  // 7. Repeating the erasure is a clean 404.
  await assert.rejects(services.erasure.eraseHousehold({ householdId: a.household, actor: actorOf(a), reason: 'data_subject_request' }), { code: 'HOUSEHOLD_NOT_FOUND' });
});

test('case erasure: the case and its derived data go, the household and a sibling case stay', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  const sibling = `case-sibling-a`;
  await handle.pool.query(`INSERT INTO service_cases (id, household_id, subject_member_id, opened_by_adult_id, trigger_type, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'renewal', 'collecting', '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z')`, [sibling, a.household, a.member, a.adult]);
  await handle.pool.query(`INSERT INTO evidence_facts (id, household_id, case_id, fact_key, value_json, epistemic_state, evidence_kind, provenance_kind, asserted_by, observed_at, created_at, statement_adult_id)
    VALUES ('fact-sibling-a', $1, $2, 'k', '{"v":"CANARY-a-sibling"}', 'known', 'adult_statement', 'adult_statement', 'adult', '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', $3)`, [a.household, sibling, a.adult]);
  const result = await services.erasure.eraseCase({ householdId: a.household, caseId: a.case, actor: actorOf(a), reason: 'data_subject_request' });
  await finishDocuments(services, db, result.documentIds);

  const hits = await canaryHits(db, a.canaryPrefix);
  // Case-bound canaries are gone; household-level and sibling canaries remain.
  for (const gone of ['workflow_tasks', 'workflow_events', 'reviewer_findings', 'integration_outbox', 'coverage_graph_snapshots', 'coverage_graph_nodes', 'policy_clauses', 'policy_answers',
    'source_pages', 'ocr_jobs', 'document_uploads', 'workflow_runs', 'coverage_parameter_observations', 'proposed_parameters', 'idempotency_keys']) {
    assert.equal(hits[gone], undefined, `${gone} still holds case data`);
  }
  assert.ok(hits.household_members >= 1 && hits.adult_users >= 1 && hits.policies >= 1, 'household data must stay');
  assert.equal(Number((await db.one(`SELECT count(*) AS n FROM evidence_facts WHERE id = 'fact-sibling-a' AND value_json IS NOT NULL`)).n), 1, 'sibling case fact stays');
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM adult_preferences WHERE household_id = ?', [a.household])).n), 1, 'user data stays');
  assert.equal((await db.one('SELECT status FROM households WHERE id = ?', [a.household])).status, 'active');
  await assert.rejects(services.access.requireCase({ adultId: a.adult }, a.case), { code: 'CASE_NOT_FOUND' });
  assert.equal((await services.access.requireCase({ adultId: a.adult }, sibling)).id, sibling);
  // Runs and tasks of the erased case are gone for readers too.
  await assert.rejects(services.access.requireRun({ adultId: a.adult }, a.run), { code: 'JOB_NOT_FOUND' });
  await assert.rejects(services.access.requireTask({ adultId: a.adult }, a.task), { code: 'TASK_NOT_FOUND' });
  assert.equal((await services.cases.listOpenedBy({ householdId: a.household, adultId: a.adult, limit: 10 })).cases.length, 1);
  await assert.rejects(services.erasure.eraseCase({ householdId: a.household, caseId: a.case, actor: actorOf(a), reason: 'data_subject_request' }), { code: 'CASE_NOT_FOUND' });
  // A case of another household cannot be erased through this household's id.
  const b = await seedErasureWorld(handle.pool, services, 'b');
  await assert.rejects(services.erasure.eraseCase({ householdId: a.household, caseId: b.case, actor: actorOf(a), reason: 'data_subject_request' }), { code: 'CASE_NOT_FOUND' });
  assert.equal((await db.one('SELECT status FROM service_cases WHERE id = ?', [b.case])).status, 'processing');
  const events = await db.many("SELECT event_payload_json FROM audit_events WHERE action = 'case.erased'");
  assert.equal(events.length, 1);
  assert.ok(!events[0].event_payload_json.includes('CANARY'));
});

test('member erasure: records about the member go; owner, account holders and others stay', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  const actor = actorOf(a);
  await assert.rejects(services.erasure.eraseMember({ householdId: a.household, memberId: a.member, actor, reason: 'data_subject_request' }), { code: 'MEMBER_PROTECTED' });
  await assert.rejects(services.erasure.eraseMember({ householdId: a.household, memberId: a.member2, actor, reason: 'data_subject_request' }), { code: 'MEMBER_PROTECTED' });
  await assert.rejects(services.erasure.eraseMember({ householdId: 'household-other', memberId: a.dependent, actor, reason: 'data_subject_request' }), { code: 'MEMBER_NOT_FOUND' });
  await services.erasure.eraseMember({ householdId: a.household, memberId: a.dependent, actor, reason: 'data_subject_request' });
  await services.erasure.eraseMember({ householdId: a.household, memberId: a.placeholder, actor, reason: 'data_subject_request' });
  const hits = await canaryHits(db, a.canaryPrefix);
  for (const text of ['dependent-name', 'dep-label', 'fact-value', 'place-label', 'invited-name', 'invited-member']) {
    for (const table of await tables(db)) {
      const n = Number((await db.one(`SELECT count(*) AS n FROM "${table}" t WHERE t::text LIKE ?`, [`%${a.canaryPrefix}${text}%`])).n);
      assert.equal(n, 0, `${text} still in ${table}`);
    }
  }
  assert.ok(hits.household_members >= 1 && hits.adult_users >= 1);
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM policy_members WHERE household_member_id = ?', [a.dependent])).n), 0);
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM household_places WHERE member_id = ?', [a.dependent])).n), 0);
  const names = (await services.households.listMembers(a.household)).map(member => member.id).sort();
  assert.deepEqual(names, [a.member, a.member2].sort());
  assert.equal(await services.householdApp.getMember(a.household, a.dependent), null);
  // The scrubbed tombstone is gone for the old delete route too: 404, not a 409 about records.
  await assert.rejects(services.householdApp.deleteMember({ householdId: a.household, actorAdultId: a.adult, memberId: a.dependent }), { code: 'MEMBER_NOT_FOUND', statusCode: 404 });
});

test('revocation still erases derived data after the S3 changes', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  await services.consents.revoke({ grantId: a.consent, revokedByAdultId: a.adult, reason: 'user_request' });
  assert.equal((await db.one('SELECT status FROM workflow_runs WHERE id = ?', [a.run])).status, 'revoked');
  assert.equal((await db.one('SELECT value_json FROM coverage_parameter_observations WHERE id = ?', [a.observation])).value_json, null);
  assert.equal((await db.one('SELECT extracted_text FROM source_pages WHERE id = ?', [a.page])).extracted_text, null);
  assert.equal((await db.one('SELECT lifecycle_state FROM document_uploads WHERE id = ?', [a.document])).lifecycle_state, 'deletion_requested');
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM document_blobs WHERE document_id = ?', [a.document])).n), 0);
});

test('a failure inside household erasure rolls everything back', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  const before = await scopedCounts(db, a.household);
  const original = services.erasure.appEvents.eraseForHousehold;
  services.erasure.appEvents.eraseForHousehold = async () => { throw new Error('boom'); };
  await assert.rejects(services.erasure.eraseHousehold({ householdId: a.household, actor: actorOf(a), reason: 'data_subject_request' }), /boom/);
  services.erasure.appEvents.eraseForHousehold = original;
  assert.deepEqual(await scopedCounts(db, a.household), before);
  assert.equal((await db.one('SELECT status FROM households WHERE id = ?', [a.household])).status, 'active');
});

test('pruning after an ordinary document deletion keeps the tombstone and the policy of a live household', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  await handle.pool.query(`INSERT INTO policies (id, household_id, policy_kind, verification_state, source_document_id, created_at, updated_at)
    VALUES ('policy-from-doc-a', $1, 'unknown', 'unverified', $2, '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z')`, [a.household, a.document]);
  await services.documents.requestDeletion(a.document, { actorAdultId: a.adult });
  await services.documents.completeDeletion(a.document);
  await services.erasure.pruneDeletedDocuments({});
  assert.equal(Number((await db.one(`SELECT count(*) AS n FROM policies WHERE id = 'policy-from-doc-a'`)).n), 1, 'policy of a live household was pruned');
  assert.equal(Number((await db.one('SELECT count(*) AS n FROM document_uploads WHERE id = ?', [a.document])).n), 1, 'tombstone of an ordinary deletion was pruned');
  // Erasing the case that owns the document does prune its tombstone and policy.
  const result = await services.erasure.eraseCase({ householdId: a.household, caseId: a.case, actor: actorOf(a), reason: 'data_subject_request' });
  await finishDocuments(services, db, result.documentIds);
  assert.equal(Number((await db.one(`SELECT count(*) AS n FROM policies WHERE id = 'policy-from-doc-a'`)).n), 0);
});

test('revocation reasons are codes: free text is stored as other, never in the row or the audit trail', opts, async t => {
  const { db, handle, services } = await freshDatabase(t);
  const a = await seedErasureWorld(handle.pool, services, 'a');
  assert.deepEqual(await canaryHits(db, 'CANARY-a-revocation-reason'), {});
  const rows = await plainRows(db, 'consent_revocations', 'WHERE consent_grant_id = ?', [a.consent2]);
  assert.deepEqual(rows.map(row => row.reason), ['other']);
  const audit = await db.many(`SELECT event_payload_json FROM audit_events WHERE action = 'consent.revoked' AND resource_id = ?`, [a.consent2]);
  assert.deepEqual(audit.map(row => JSON.parse(row.event_payload_json)), [{ reason: 'other' }]);
  await services.consents.revoke({ grantId: a.consent3, revokedByAdultId: a.adult2, reason: 'user_request' });
  assert.equal((await plainRows(db, 'consent_revocations', 'WHERE consent_grant_id = ?', [a.consent3]))[0].reason, 'user_request');
});
