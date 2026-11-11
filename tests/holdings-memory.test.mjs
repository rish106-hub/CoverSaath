import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import {
  eraseMemoryForConsentGrant, eraseMemoryForDocuments, eraseMemoryForHousehold, eraseMemoryForMember,
} from '../src/backend/repositories/memory-erasure.js';

// Holdings and memory (migrations 048-052, ADR 0032, ADR 0023): ownership at the repository and the route, sealed columns at rest,
// status authority, append-only supersession, conflicts, and an erasure test per table (erasure path: memory-erasure.js,
// eraseMemoryForHousehold and its siblings). Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const MARK = 'Quillberry-marker';

async function world(t) {
  const fresh = await freshDatabase(t);
  const { handle, services } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const w of [a, b]) {
    const key = w.household.split('-')[1];
    w.profileGrant = `pi-${key}`;
    w.coverageGrant = `cr-${key}`;
    await insert(handle.pool, 'consent_grants', { id: w.profileGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'profile_intake' });
    await insert(handle.pool, 'consent_grants', { id: w.coverageGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'coverage_reconstruction' });
  }
  const count = async (table, where = '1=1', params = []) => Number((await fresh.db.one(`SELECT count(*) AS c FROM ${table} WHERE ${where}`, params)).c);
  return { ...fresh, services, a, b, count };
}

const code = expected => error => { assert.equal(error.code, expected, `${error.code}: ${error.message}`); return true; };

async function holdingOf(services, w) {
  return services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy });
}

test('holdings: thin link, idempotent per document, forward-only status, owned by its household', opts, async t => {
  const { handle, services, a, b, count } = await world(t);
  const holding = await holdingOf(services, a);
  assert.deepEqual(Object.keys(holding).sort(), ['createdAt', 'documentId', 'householdId', 'id', 'kind', 'policyId', 'policyProfileId', 'status', 'updatedAt']);
  assert.equal(holding.status, 'uploaded');
  assert.equal((await holdingOf(services, a)).id, holding.id, 'a second create for the same document returns the same holding');
  assert.equal(await count('policy_holdings'), 1);
  // Ownership: another household's person gets the same 404 as a missing holding, for read, list and write.
  await assert.rejects(services.policyHoldings.get({ householdId: a.household, adultId: b.adult, holdingId: holding.id }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(services.policyHoldings.get({ householdId: b.household, adultId: b.adult, holdingId: holding.id }), code('HOLDING_NOT_FOUND'));
  await assert.rejects(services.policyHoldings.list({ householdId: a.household, adultId: b.adult }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(services.policyHoldings.setStatus({ householdId: b.household, adultId: b.adult, holdingId: holding.id, status: 'parsed' }), code('HOLDING_NOT_FOUND'));
  await assert.rejects(services.policyHoldings.create({ householdId: b.household, adultId: b.adult, documentId: a.document, kind: 'top_up' }), code('DOCUMENT_NOT_FOUND'));
  await assert.rejects(services.policyHoldings.create({ householdId: b.household, adultId: b.adult, documentId: b.document, kind: 'top_up', policyId: a.policy }), code('HOLDING_NOT_FOUND'));
  assert.equal((await services.policyHoldings.list({ householdId: a.household, adultId: a.adult })).length, 1);
  // Status moves forward only.
  assert.equal((await services.policyHoldings.setStatus({ householdId: a.household, holdingId: holding.id, status: 'parsed' })).status, 'parsed');
  await assert.rejects(services.policyHoldings.setStatus({ householdId: a.household, holdingId: holding.id, status: 'uploaded' }), code('HOLDING_STATUS_INVALID'));
  await assert.rejects(services.policyHoldings.setStatus({ householdId: a.household, holdingId: holding.id, status: 'confirmed' }), code('INVALID_REQUEST'));
  // The database refuses a cross-household link even when the application is bypassed.
  await assert.rejects(insert(handle.pool, 'policy_holdings', { id: 'raw-x', household_id: b.household, document_id: a.document }), /policy holding must match an active document/);
});

test('memory facts: sealed value, status authority per tier, supersession and replay', opts, async t => {
  const { handle, db, services, a, b, count } = await world(t);
  const holding = await holdingOf(services, a);
  const base = { householdId: a.household, holdingId: holding.id, consentGrantId: a.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } };
  const first = await services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status: 'extracted_unverified', value: { amountMinor: 50_000_000, note: MARK } });
  assert.equal(first.written, true);
  const raw = await db.one('SELECT * FROM household_memory_facts WHERE id = ?', [first.fact.id]);
  assert.match(raw.value_enc, /^enc2[.]/);
  assert.equal(JSON.stringify(raw).includes(MARK), false, 'no plaintext of the value in the row');
  assert.deepEqual(first.fact.value, { amountMinor: 50_000_000, note: MARK });
  // A replay writes nothing; a changed value supersedes the current row.
  assert.equal((await services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status: 'extracted_unverified', value: { amountMinor: 50_000_000, note: MARK } })).written, false);
  const second = await services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status: 'extracted_unverified', value: { amountMinor: 60_000_000 } });
  assert.equal(second.written, true);
  assert.equal(second.fact.supersedesId, first.fact.id);
  assert.equal(await count('household_memory_facts', 'superseded_at IS NOT NULL'), 1);
  const current = await services.memoryFacts.listCurrent({ householdId: a.household, adultId: a.adult, holdingId: holding.id });
  assert.deepEqual(current.facts.map(item => item.id), [second.fact.id]);
  // unknown holds no value.
  const unknown = await services.memoryFacts.insertFact({ ...base, factKey: 'waiting_ped', tier: 'own_pdf', status: 'unknown', value: null });
  assert.equal((await db.one('SELECT value_enc FROM household_memory_facts WHERE id = ?', [unknown.fact.id])).value_enc, null);
  // Status authority: a machine tier never writes a user or reference status, and the bare word confirmed does not exist.
  for (const status of ['user_confirmed', 'reviewed_reference', 'confirmed']) {
    await assert.rejects(services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status, value: 1 }), error => ['MEMORY_STATUS_FORBIDDEN', 'INVALID_REQUEST'].includes(error.code));
  }
  await assert.rejects(services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'user_declaration', status: 'extracted_unverified', value: 1, adultId: a.adult, captureMethod: 'typed' }), code('MEMORY_STATUS_FORBIDDEN'));
  // IDA wording is for product terms only; a product term cannot be declared except as a conflict resolution.
  await assert.rejects(services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'ida_wording', status: 'reviewed_reference', value: 1, referenceRef: { k: 1 } }), code('MEMORY_KEY_NOT_DECLARABLE'));
  await assert.rejects(services.memoryFacts.insertFact({ ...base, provenance: {}, factKey: 'waiting_ped', tier: 'user_declaration', status: 'user_confirmed', value: 36, adultId: a.adult, captureMethod: 'typed', consentGrantId: a.profileGrant }), code('MEMORY_KEY_NOT_DECLARABLE'));
  await assert.rejects(services.memoryFacts.insertFact({ ...base, factKey: 'not_a_key', tier: 'own_pdf', status: 'unknown' }), code('INVALID_REQUEST'));
  const ida = await services.memoryFacts.insertFact({ ...base, factKey: 'waiting_ped', tier: 'ida_wording', status: 'reviewed_reference', value: { days: 1095 }, referenceRef: { cacheKey: 'k', marker: MARK } });
  const idaRaw = await db.one('SELECT reference_ref_enc FROM household_memory_facts WHERE id = ?', [ida.fact.id]);
  assert.match(idaRaw.reference_ref_enc, /^enc2[.]/);
  assert.equal(idaRaw.reference_ref_enc.includes(MARK), false);
  await assert.rejects(services.memoryFacts.insertFact({ ...base, factKey: 'declared_ped', tier: 'user_declaration', status: 'user_confirmed', value: 'x', adultId: a.adult, captureMethod: 'typed', consentGrantId: a.profileGrant }), code('INVALID_REQUEST'));
  // A user declaration needs a person and a profile_intake grant of that person.
  await assert.rejects(services.memoryFacts.insertFact({ ...base, provenance: {}, factKey: 'declared_ped', tier: 'user_declaration', status: 'user_confirmed', value: 'x', captureMethod: 'typed', consentGrantId: a.profileGrant }), code('MEMORY_DECLARER_REQUIRED'));
  await assert.rejects(services.memoryFacts.insertFact({ ...base, provenance: {}, factKey: 'declared_ped', tier: 'user_declaration', status: 'user_confirmed', value: 'x', adultId: a.adult, captureMethod: 'typed', consentGrantId: a.coverageGrant }), code('CONSENT_REQUIRED'));
  const declared = await services.memoryFacts.insertFact({ ...base, provenance: {}, factKey: 'declared_ped', tier: 'user_declaration', status: 'user_confirmed', value: 'x', adultId: a.adult, captureMethod: 'typed', consentGrantId: a.profileGrant });
  assert.equal(declared.fact.tier, 'user_declaration');
  // Ownership: a foreign household cannot read, write into, or borrow a grant, holding or document of this one.
  await assert.rejects(services.memoryFacts.listCurrent({ householdId: a.household, adultId: b.adult }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(services.memoryFacts.insertFact({ ...base, householdId: b.household, factKey: 'sum_insured', tier: 'own_pdf', status: 'unknown', value: null }), error => ['CONSENT_REQUIRED', 'HOLDING_NOT_FOUND'].includes(error.code));
  await assert.rejects(services.memoryFacts.insertFact({ householdId: b.household, factKey: 'sum_insured', tier: 'own_pdf', status: 'unknown', consentGrantId: b.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } }), code('MEMORY_NOT_FOUND'));
  assert.equal((await services.memoryFacts.listCurrent({ householdId: b.household, adultId: b.adult })).facts.length, 0);
  // Database guards hold without the application: immutable except superseded_at, no plaintext value, no value-bearing unknown.
  const pool = handle.pool;
  await assert.rejects(pool.query(`UPDATE household_memory_facts SET status = 'conflicting' WHERE id = $1`, [second.fact.id]), /memory facts are immutable/);
  await assert.rejects(insert(pool, 'household_memory_facts', { id: 'raw-plain', household_id: a.household, consent_grant_id: a.coverageGrant, source_document_id: a.document, source_page_id: a.page, fact_key: 'copay_percent', value_enc: '{"v":1}' }), /violates check constraint/);
  await assert.rejects(insert(pool, 'household_memory_facts', { id: 'raw-tier', household_id: a.household, consent_grant_id: a.coverageGrant, source_document_id: a.document, source_page_id: a.page, fact_key: 'copay_percent', status: 'user_confirmed' }), /violates check constraint/);
  await assert.rejects(insert(pool, 'household_memory_facts', { id: 'raw-unk', household_id: a.household, consent_grant_id: a.coverageGrant, source_document_id: a.document, source_page_id: a.page, fact_key: 'copay_percent', status: 'unknown' }), /violates check constraint/);
  await assert.rejects(insert(pool, 'household_memory_facts', { id: 'raw-foreign', household_id: b.household, consent_grant_id: b.coverageGrant, source_document_id: a.document, source_page_id: a.page, fact_key: 'copay_percent' }), /memory fact must match an active document of its household/);
  await assert.rejects(insert(pool, 'household_memory_facts', { id: 'raw-grant', household_id: b.household, consent_grant_id: a.coverageGrant, source_document_id: b.document, source_page_id: b.page, fact_key: 'copay_percent' }), /memory fact must use a consent grant of its household/);
  const columns = (await db.many(`SELECT column_name FROM information_schema.columns WHERE table_name = 'household_memory_facts'`)).map(row => row.column_name);
  assert.equal(columns.some(name => /value_json|value_text|tsv|fts/.test(name)), false, 'no plaintext value or full-text column');
  assert.equal((await db.many(`SELECT 1 FROM pg_indexes WHERE tablename = 'household_memory_facts' AND indexdef ILIKE '%gin%'`)).length, 0);
});

test('memory conflicts: one open per key, user choice is a new declaration, rules never pick a user choice', opts, async t => {
  const { handle, db, services, a, b } = await world(t);
  const holding = await holdingOf(services, a);
  const base = { householdId: a.household, holdingId: holding.id, consentGrantId: a.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } };
  const own = (await services.memoryFacts.insertFact({ ...base, factKey: 'waiting_ped', tier: 'own_pdf', status: 'extracted_unverified', value: { days: 730 } })).fact;
  const ida = (await services.memoryFacts.insertFact({ ...base, factKey: 'waiting_ped', tier: 'ida_wording', status: 'reviewed_reference', value: { days: 1095 }, referenceRef: { k: 1 } })).fact;
  const conflict = await services.memoryFacts.openConflict({ householdId: a.household, holdingId: holding.id, factKey: 'waiting_ped', candidateFactIds: [own.id, ida.id], reason: 'own_vs_insurer' });
  assert.equal(conflict.resolution, 'pending');
  assert.equal((await services.memoryFacts.openConflict({ householdId: a.household, holdingId: holding.id, factKey: 'waiting_ped', candidateFactIds: [own.id, ida.id], reason: 'own_vs_insurer' })).id, conflict.id);
  await assert.rejects(services.memoryFacts.openConflict({ householdId: a.household, holdingId: holding.id, factKey: 'sum_insured', candidateFactIds: [own.id, ida.id], reason: 'two_pages' }), code('MEMORY_NOT_FOUND'));
  await assert.rejects(services.memoryFacts.listConflicts({ householdId: a.household, adultId: b.adult }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(services.memoryFacts.resolveByUser({ householdId: b.household, adultId: b.adult, conflictId: conflict.id, value: { days: 1 }, consentGrantId: b.profileGrant }), code('MEMORY_NOT_FOUND'));
  // The user resolves a product-term conflict (ADR 0032): a new user_declaration row, machine rows stay.
  const resolved = await services.memoryFacts.resolveByUser({ householdId: a.household, adultId: a.adult, conflictId: conflict.id, value: { days: 1095 }, consentGrantId: a.profileGrant });
  assert.equal(resolved.conflict.resolution, 'user_chose');
  assert.equal(resolved.conflict.resolvedBy, 'user');
  assert.equal(resolved.fact.tier, 'user_declaration');
  assert.equal(resolved.fact.captureMethod, 'conflict_resolution');
  assert.deepEqual([...resolved.fact.resolvesFactIds].sort(), [own.id, ida.id].sort());
  assert.equal(resolved.fact.status, 'user_confirmed');
  assert.equal(Number((await db.one(`SELECT count(*) AS c FROM household_memory_facts WHERE source_tier <> 'user_declaration' AND superseded_at IS NULL`)).c), 2, 'machine rows stay');
  await assert.rejects(services.memoryFacts.resolveByUser({ householdId: a.household, adultId: a.adult, conflictId: conflict.id, value: 1, consentGrantId: a.profileGrant }), code('MEMORY_CONFLICT_CLOSED'));
  await assert.rejects(handle.pool.query(`UPDATE memory_conflicts SET resolution = 'dismissed' WHERE id = $1`, [conflict.id]), /resolved once/);
  // A rule closes a conflict, but never as a user choice (database CHECK as well).
  const sum = (await services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status: 'conflicting', value: { alternatives: [1, 2] } })).fact;
  const sum2 = (await services.memoryFacts.insertFact({ ...base, provenance: {}, factKey: 'sum_insured', tier: 'user_declaration', status: 'user_confirmed', value: 1, adultId: a.adult, captureMethod: 'typed', consentGrantId: a.profileGrant })).fact;
  const second = await services.memoryFacts.openConflict({ householdId: a.household, holdingId: holding.id, factKey: 'sum_insured', candidateFactIds: [sum.id, sum2.id], reason: 'own_vs_declaration' });
  await assert.rejects(handle.pool.query(`UPDATE memory_conflicts SET resolution = 'user_chose', resolved_by = 'rule', resolved_at = $2 WHERE id = $1`, [second.id, at]), /violates check constraint/);
  await assert.rejects(services.memoryFacts.closeConflictByRule({ householdId: a.household, conflictId: second.id, resolution: 'user_chose' }), code('INVALID_REQUEST'));
  assert.equal((await services.memoryFacts.closeConflictByRule({ householdId: a.household, conflictId: second.id, resolution: 'own_wins' })).resolvedBy, 'rule');
});

test('declarations: label sealed, owned by its household, guardian rule on a dependant', opts, async t => {
  const { handle, db, services, a, b } = await world(t);
  const dependent = 'dep-a';
  await insert(handle.pool, 'household_members', { id: dependent, household_id: a.household, adult_user_id: null, member_kind: 'dependent' });
  const created = await services.declarations.create({ householdId: a.household, adultId: a.adult, memberId: a.member, kind: 'pre_existing_disease', label: `diabetes ${MARK}`, declaredOn: '2026-01-02', declaredToInsurer: true, consentGrantId: a.profileGrant });
  assert.equal(created.label, `diabetes ${MARK}`);
  const raw = await db.one('SELECT * FROM member_declarations WHERE id = ?', [created.id]);
  assert.match(raw.label_enc, /^enc2[.]/);
  assert.equal(JSON.stringify(raw).includes(MARK), false);
  await assert.rejects(services.declarations.create({ householdId: a.household, adultId: a.adult, memberId: a.member, kind: 'habit', label: 'x', consentGrantId: a.coverageGrant }), code('CONSENT_REQUIRED'));
  await assert.rejects(services.declarations.create({ householdId: a.household, adultId: a.adult, memberId: a.member, kind: 'bad', label: 'x', consentGrantId: a.profileGrant }), code('INVALID_REQUEST'));
  // Ownership: a foreign person, a foreign member and a foreign grant all fail the same way.
  await assert.rejects(services.declarations.list({ householdId: a.household, adultId: b.adult }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(services.declarations.create({ householdId: b.household, adultId: b.adult, memberId: a.member, kind: 'habit', label: 'x', consentGrantId: b.profileGrant }), code('MEMBER_NOT_FOUND'));
  await assert.rejects(services.declarations.update({ householdId: b.household, adultId: b.adult, declarationId: created.id, label: 'y' }), code('DECLARATION_NOT_FOUND'));
  await assert.rejects(services.declarations.delete({ householdId: b.household, adultId: b.adult, declarationId: created.id }), code('DECLARATION_NOT_FOUND'));
  const updated = await services.declarations.update({ householdId: a.household, adultId: a.adult, declarationId: created.id, label: 'asthma', ifMatch: 1, consentGrantId: a.profileGrant });
  assert.equal(updated.revision, 2);
  await assert.rejects(services.declarations.update({ householdId: a.household, adultId: a.adult, declarationId: created.id, label: 'z', ifMatch: 1, consentGrantId: a.profileGrant }), code('REVISION_CONFLICT'));
  // A second household member (role member, not owner, not guardian) cannot touch a dependant's declaration.
  const other = { adult: 'adult-m', role: 'role-m' };
  await insert(handle.pool, 'adult_users', { id: other.adult });
  await insert(handle.pool, 'household_roles', { id: other.role, household_id: a.household, adult_user_id: other.adult, role: 'member' });
  await insert(handle.pool, 'consent_grants', { id: 'pi-m', household_id: a.household, subject_adult_id: other.adult, purpose: 'profile_intake' });
  await assert.rejects(services.declarations.create({ householdId: a.household, adultId: other.adult, memberId: dependent, kind: 'habit', label: 'x', consentGrantId: 'pi-m' }), code('GUARDIAN_REQUIRED'));
  const forDependent = await services.declarations.create({ householdId: a.household, adultId: a.adult, memberId: dependent, kind: 'habit', label: 'runs', consentGrantId: a.profileGrant });
  assert.equal((await services.declarations.list({ householdId: a.household, adultId: other.adult })).declarations.some(item => item.id === forDependent.id), false, 'the dependant record is hidden from a non-guardian');
  assert.equal((await services.declarations.list({ householdId: a.household, adultId: a.adult })).declarations.length, 2);
  await services.declarations.delete({ householdId: a.household, adultId: a.adult, declarationId: created.id });
  await assert.rejects(handle.pool.query(`INSERT INTO member_declarations (id, household_id, member_id, kind, label_enc, consent_grant_id, declared_by_adult_id, created_at, updated_at) VALUES ('raw-p', $1, $2, 'habit', 'plain text', $3, $4, $5, $5)`, [a.household, a.member, a.profileGrant, a.adult, at]), /violates check constraint/);
});

test('premiums: amounts and agent sealed, band plain, agent only via agent, dues settle with a same-holding payment', opts, async t => {
  const { handle, db, services, a, b } = await world(t);
  const holding = await holdingOf(services, a);
  const bHolding = await holdingOf(services, b);
  const pay = { householdId: a.household, adultId: a.adult, holdingId: holding.id, amountPaise: 1_234_500, paidOn: '2026-01-15', channel: 'upi', consentGrantId: a.profileGrant };
  const payment = await services.premiums.recordPayment({ ...pay, paidVia: 'agent', agentName: `Agent ${MARK}`, agentCode: `CODE-${MARK}` });
  assert.equal(payment.amountPaise, 1_234_500);
  assert.equal(payment.amountBand, '10k_50k');
  const raw = await db.one('SELECT * FROM premium_payments WHERE id = ?', [payment.id]);
  assert.equal(JSON.stringify(raw).includes(MARK), false);
  for (const column of ['amount_enc', 'agent_name_enc', 'agent_code_enc']) assert.match(raw[column], /^enc2[.]/);
  assert.equal(Object.keys(raw).some(name => name === 'amount_paise'), false, 'no plaintext amount column');
  await assert.rejects(services.premiums.recordPayment({ ...pay, agentName: 'x' }), code('INVALID_REQUEST'));
  await assert.rejects(services.premiums.recordPayment({ ...pay, amountPaise: 12.5 }), code('INVALID_REQUEST'));
  await assert.rejects(services.premiums.recordPayment({ ...pay, consentGrantId: a.coverageGrant }), code('CONSENT_REQUIRED'));
  // Ownership.
  await assert.rejects(services.premiums.listPayments({ householdId: a.household, adultId: b.adult }), code('HOUSEHOLD_NOT_FOUND'));
  await assert.rejects(services.premiums.recordPayment({ ...pay, householdId: b.household, adultId: b.adult, consentGrantId: b.profileGrant }), code('HOLDING_NOT_FOUND'));
  await assert.rejects(services.premiums.deletePayment({ householdId: b.household, adultId: b.adult, paymentId: payment.id }), code('PREMIUM_NOT_FOUND'));
  await assert.rejects(services.premiums.addDue({ householdId: b.household, adultId: b.adult, holdingId: holding.id, dueOn: '2026-02-15', amountPaise: 100, consentGrantId: b.profileGrant }), code('HOLDING_NOT_FOUND'));
  const due = await services.premiums.addDue({ householdId: a.household, adultId: a.adult, holdingId: holding.id, dueOn: '2026-02-15', amountPaise: 1_234_500, consentGrantId: a.profileGrant });
  assert.equal((await services.premiums.addDue({ householdId: a.household, adultId: a.adult, holdingId: holding.id, dueOn: '2026-02-15', amountPaise: 1_234_500, consentGrantId: a.profileGrant })).id, due.id);
  const bPayment = await services.premiums.recordPayment({ ...pay, householdId: b.household, adultId: b.adult, holdingId: bHolding.id, consentGrantId: b.profileGrant });
  await assert.rejects(services.premiums.markDuePaid({ householdId: a.household, adultId: a.adult, dueId: due.id, paymentId: bPayment.id, consentGrantId: a.profileGrant }), code('PREMIUM_NOT_FOUND'));
  assert.equal((await services.premiums.markDuePaid({ householdId: a.household, adultId: a.adult, dueId: due.id, paymentId: payment.id, consentGrantId: a.profileGrant })).state, 'paid');
  assert.equal((await services.premiums.listDues({ householdId: a.household, adultId: a.adult, state: 'paid' })).length, 1);
  assert.equal(JSON.stringify(await db.one('SELECT * FROM premium_dues WHERE id = ?', [due.id])).includes('1234500'), false);
  await assert.rejects(handle.pool.query(`UPDATE premium_payments SET agent_name_enc = 'plain' WHERE id = $1`, [payment.id]), /violates check constraint/);
});

test('erasure: every new table is emptied by household erasure, consent revocation, document erasure and member removal', opts, async t => {
  const { handle, db, services, a, b, count } = await world(t);
  const pool = handle.pool;
  const seed = async (w, key) => {
    const holding = await holdingOf(services, w);
    const fact = (await services.memoryFacts.insertFact({ householdId: w.household, holdingId: holding.id, factKey: 'sum_insured', tier: 'own_pdf', status: 'extracted_unverified', value: 1, consentGrantId: w.coverageGrant, provenance: { sourceDocumentId: w.document, sourcePageId: w.page } })).fact;
    const user = (await services.memoryFacts.insertFact({ householdId: w.household, holdingId: holding.id, factKey: 'sum_insured', tier: 'user_declaration', status: 'user_confirmed', value: 2, adultId: w.adult, captureMethod: 'typed', consentGrantId: w.profileGrant })).fact;
    await services.memoryFacts.openConflict({ householdId: w.household, holdingId: holding.id, factKey: 'sum_insured', candidateFactIds: [fact.id, user.id], reason: 'own_vs_declaration' });
    await services.declarations.create({ householdId: w.household, adultId: w.adult, memberId: w.member, kind: 'habit', label: `x-${key}`, consentGrantId: w.profileGrant });
    const payment = await services.premiums.recordPayment({ householdId: w.household, adultId: w.adult, holdingId: holding.id, amountPaise: 5000, paidOn: '2026-01-15', consentGrantId: w.profileGrant });
    await services.premiums.addDue({ householdId: w.household, adultId: w.adult, holdingId: holding.id, dueOn: '2026-03-01', amountPaise: 5000, consentGrantId: w.profileGrant });
    return { holding, payment };
  };
  const tables = ['policy_holdings', 'household_memory_facts', 'memory_conflicts', 'member_declarations', 'premium_payments', 'premium_dues'];
  const counts = async w => Object.fromEntries(await Promise.all(tables.map(async table => [table, await count(table, 'household_id = ?', [w.household])])));
  for (const [w, key] of [[a, 'a'], [b, 'b']]) await seed(w, key);
  const bBefore = await counts(b);
  for (const table of tables) assert.ok(bBefore[table] > 0, `seed has a row in ${table}`);

  // 1. Consent revocation (profile_intake grant): what was written under it goes, the rest stays.
  const beforeRevoke = await counts(a);
  const result = await eraseMemoryForConsentGrant(db, { householdId: a.household, consentGrantId: a.profileGrant });
  const afterRevoke = await counts(a);
  assert.equal(afterRevoke.member_declarations, 0);
  assert.equal(afterRevoke.premium_payments, 0);
  assert.equal(afterRevoke.premium_dues, 0);
  assert.equal(afterRevoke.memory_conflicts, 0, 'a conflict never outlives its facts');
  assert.equal(afterRevoke.household_memory_facts, 1, 'the machine fact written under another grant stays');
  assert.ok(result.facts >= 1 && beforeRevoke.household_memory_facts === 2);

  // 2. Document erasure: the trigger deletes the holding and what hangs on it.
  await pool.query(`UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = $1`, [a.document]);
  assert.deepEqual(await counts(a), { policy_holdings: 0, household_memory_facts: 0, memory_conflicts: 0, member_declarations: 0, premium_payments: 0, premium_dues: 0 });
  assert.deepEqual(await counts(b), bBefore, 'another household is untouched');

  // 3. Household erasure helper and the document helper empty what is left of B, and only B.
  const bDocs = await eraseMemoryForDocuments(db, { householdId: a.household, documentIds: [b.document] });
  assert.equal(bDocs.holdings, 0, 'a foreign household id never matches another household documents');
  assert.deepEqual(await counts(b), bBefore);
  await eraseMemoryForHousehold(db, { householdId: b.household });
  assert.deepEqual(await counts(b), { policy_holdings: 0, household_memory_facts: 0, memory_conflicts: 0, member_declarations: 0, premium_payments: 0, premium_dues: 0 });
});

test('erasure: member removal erases the member declarations and facts; revoke through the consent service erases memory', opts, async t => {
  const { handle, db, services, a, count } = await world(t);
  const holding = await holdingOf(services, a);
  await insert(handle.pool, 'household_members', { id: 'dep-e', household_id: a.household, adult_user_id: null, member_kind: 'dependent' });
  await services.declarations.create({ householdId: a.household, adultId: a.adult, memberId: 'dep-e', kind: 'habit', label: 'x', consentGrantId: a.profileGrant });
  const fact = (await services.memoryFacts.insertFact({ householdId: a.household, holdingId: holding.id, memberId: 'dep-e', memberScope: 'dependent', factKey: 'member_age', tier: 'own_pdf', status: 'extracted_unverified', value: 7, consentGrantId: a.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } })).fact;
  const other = (await services.memoryFacts.insertFact({ householdId: a.household, holdingId: holding.id, factKey: 'member_age', tier: 'own_pdf', status: 'extracted_unverified', value: 40, consentGrantId: a.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } })).fact;
  await services.memoryFacts.openConflict({ householdId: a.household, holdingId: holding.id, factKey: 'member_age', candidateFactIds: [fact.id, other.id], reason: 'two_pages' });
  const removed = await eraseMemoryForMember(db, { householdId: a.household, memberId: 'dep-e' });
  assert.equal(removed.declarations, 1);
  assert.equal(removed.facts, 1);
  assert.equal(await count('memory_conflicts'), 0);
  assert.equal(await count('household_memory_facts'), 1);
  // Revoking the grant through the service erases what was written under it.
  await services.consents.revoke({ grantId: a.coverageGrant, revokedByAdultId: a.adult, reason: 'test' });
  assert.equal(await count('household_memory_facts'), 0);
});

async function startApp(database, env) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: 'coversaath-test-bootstrap-token-0018', ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

test('route stub: off unless HOLDINGS_ENABLED is exactly true; a foreign household is the same 404', opts, async t => {
  const fresh = await freshDatabase(t);
  const owners = {};
  const boot = await startApp(fresh.db, {});
  t.after(() => boot.stop());
  for (const name of ['one', 'two']) {
    const r = await boot.call('/api/v1/households', { method: 'POST', token: 'coversaath-test-bootstrap-token-0018', body: { displayName: `${name} household`, owner: { displayName: `${name} owner`, contactEmail: `${name}.synthetic@example.test` } } });
    assert.equal(r.status, 201);
    owners[name] = { token: r.data.session.token, householdId: r.data.household.id, adultId: r.data.owner.id };
  }
  const off = await boot.call(`/api/v1/households/${owners.one.householdId}/holdings`, { token: owners.one.token });
  assert.equal(off.status, 404, 'flag off: the route does not exist');
  const garbage = await startApp(fresh.db, { HOLDINGS_ENABLED: 'TRUE' });
  t.after(() => garbage.stop());
  assert.equal((await garbage.call(`/api/v1/households/${owners.one.householdId}/holdings`, { token: owners.one.token })).status, 404, 'only the exact string true turns it on');
  const on = await startApp(fresh.db, { HOLDINGS_ENABLED: 'true' });
  t.after(() => on.stop());
  const own = await on.call(`/api/v1/households/${owners.one.householdId}/holdings`, { token: owners.one.token });
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.holdings, []);
  const foreign = await on.call(`/api/v1/households/${owners.one.householdId}/holdings`, { token: owners.two.token });
  assert.equal(foreign.status, 404);
  const missing = await on.call(`/api/v1/households/${owners.one.householdId}/holdings/hold-none`, { token: owners.one.token });
  assert.equal(missing.status, 404);
  assert.equal((await on.call(`/api/v1/households/${owners.one.householdId}/holdings`)).status, 401);
});
