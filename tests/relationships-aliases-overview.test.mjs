import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { insert, seedWorld } from './support/postgres-fixtures.mjs';
import { MEMORY_DOCUMENT_SECTIONS } from '../src/backend/services/memory-document.js';
import { MEMBER_RELATIONSHIPS } from '../src/contracts/member-relationships.js';

// Relationship-first members (closed `relationship` + sealed `aliases`, migration 067), the holdings-based household overview and policies,
// and the JSON variant of the memory document. Synthetic data only. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const BOOT = 'coversaath-test-bootstrap-token-0067';
const ON = { HOLDINGS_ENABLED: 'true', MEMORY_ENABLED: 'true' };
const SEALED = /^enc[12]\./;

async function startApp(database, env) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: BOOT, ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* markdown */ }
    return { status: response.status, headers: response.headers, text, data };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function world(t, env = ON) {
  const fresh = await freshDatabase(t);
  const { handle, services, db } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const w of [a, b]) {
    const key = w.household.split('-')[1];
    w.profileGrant = `pi-${key}`;
    w.coverageGrant = `cr-${key}`;
    await insert(handle.pool, 'consent_grants', { id: w.profileGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'profile_intake' });
    await insert(handle.pool, 'consent_grants', { id: w.coverageGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'coverage_reconstruction' });
    w.token = (await services.auth.issueSession({ adultUserId: w.adult })).token;
  }
  const app = await startApp(db, env);
  t.after(() => app.stop());
  return { ...fresh, services, app, a, b };
}

const membersPath = who => `/api/v1/households/${who.household}/members`;
const addMember = (s, body, who = s.a) => s.app.call(membersPath(who), { method: 'POST', token: who.token, body });

// ---- members: relationship and aliases ----

test('members: relationship and aliases are returned, trimmed, deduplicated, sealed at rest, and patchable', opts, async t => {
  const s = await world(t);
  const mum = await addMember(s, { displayName: 'Asha Synthetic', memberKind: 'dependent', relationship: 'mother', relationshipLabel: 'Mum at home', aliases: ['  Mum ', 'mum', 'Amma', '', 'MUM'], ageBand: '46-60' });
  assert.equal(mum.status, 201, mum.text);
  assert.equal(mum.data.relationship, 'mother');
  assert.equal(mum.data.relationshipLabel, 'Mum at home');
  assert.deepEqual(mum.data.aliases, ['Mum', 'Amma']);
  assert.equal(mum.data.ageYears, null);
  const raw = await s.db.one('SELECT relationship, relationship_label, aliases FROM household_members WHERE id = ?', [mum.data.id]);
  assert.equal(raw.relationship, 'mother');
  assert.match(raw.aliases, SEALED);
  assert.match(raw.relationship_label, SEALED);
  assert.equal(raw.aliases.includes('Amma'), false);
  const listed = await s.app.call(membersPath(s.a), { token: s.a.token });
  assert.deepEqual(listed.data.members.find(m => m.id === mum.data.id).aliases, ['Mum', 'Amma']);
  // A member with neither field answers null and an empty list, never undefined.
  const plain = await addMember(s, { displayName: 'Plain Synthetic', memberKind: 'dependent' });
  assert.equal(plain.data.relationship, null);
  assert.deepEqual(plain.data.aliases, []);
  assert.equal((await s.db.one('SELECT aliases FROM household_members WHERE id = ?', [plain.data.id])).aliases, null);
  // Patch: replace the aliases, change the relationship, then clear both.
  const patched = await s.app.call(`${membersPath(s.a)}/${mum.data.id}`, { method: 'PATCH', token: s.a.token, body: { relationship: 'in_law', aliases: ['Saasu ma'] } });
  assert.equal(patched.status, 200, patched.text);
  assert.equal(patched.data.relationship, 'in_law');
  assert.deepEqual(patched.data.aliases, ['Saasu ma']);
  assert.equal(patched.data.relationshipLabel, 'Mum at home', 'the custom label is untouched');
  const cleared = await s.app.call(`${membersPath(s.a)}/${mum.data.id}`, { method: 'PATCH', token: s.a.token, body: { relationship: null, aliases: [] } });
  assert.equal(cleared.data.relationship, null);
  assert.deepEqual(cleared.data.aliases, []);
  assert.equal((await s.db.one('SELECT aliases FROM household_members WHERE id = ?', [mum.data.id])).aliases, null);
  // Every value of the closed vocabulary is accepted.
  for (const relationship of MEMBER_RELATIONSHIPS) {
    const r = await addMember(s, { displayName: `Rel ${relationship}`, memberKind: 'dependent', relationship });
    assert.equal(r.status, 201, `${relationship}: ${r.text}`);
    assert.equal(r.data.relationship, relationship);
    if (relationship === 'in_law') break;
  }
  // The audit trail holds counts and field names only, never the alias text.
  const audit = JSON.stringify(await s.db.many("SELECT event_payload_json FROM audit_events WHERE action LIKE 'household_member.%'"));
  assert.equal(audit.includes('Amma'), false);
});

test('members: invalid relationship or aliases are coded 400 and change nothing', opts, async t => {
  const s = await world(t);
  const kid = await addMember(s, { displayName: 'Kid Synthetic', memberKind: 'dependent', relationship: 'son', aliases: ['Chhotu'] });
  assert.equal(kid.status, 201);
  const bad = [
    { relationship: 'cousin' }, { relationship: 7 }, { relationship: '' }, { relationship: 'Mother' },
    { aliases: 'Mum' }, { aliases: [1] }, { aliases: [{}] }, { aliases: ['x'.repeat(41)] },
    { aliases: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, { aliases: ['tab\there'] }, { aliases: ['4111 1111 1111 1111'] },
  ];
  for (const body of bad) {
    const created = await addMember(s, { displayName: 'Bad Synthetic', memberKind: 'dependent', ...body });
    assert.equal(created.status, 400, `POST ${JSON.stringify(body)}`);
    assert.ok(['INVALID_REQUEST', 'SENSITIVE_IDENTIFIER_REJECTED'].includes(created.data.error.code), created.data.error.code);
    const patched = await s.app.call(`${membersPath(s.a)}/${kid.data.id}`, { method: 'PATCH', token: s.a.token, body });
    assert.equal(patched.status, 400, `PATCH ${JSON.stringify(body)}`);
  }
  // Exactly 8 distinct aliases is the limit and passes; a duplicate beyond it does not count.
  const eight = await addMember(s, { displayName: 'Eight Synthetic', memberKind: 'dependent', aliases: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'H'] });
  assert.equal(eight.status, 201, eight.text);
  assert.equal(eight.data.aliases.length, 8);
  const unchanged = (await s.app.call(membersPath(s.a), { token: s.a.token })).data.members.find(m => m.id === kid.data.id);
  assert.equal(unchanged.relationship, 'son');
  assert.deepEqual(unchanged.aliases, ['Chhotu']);
  assert.equal((await s.app.call(membersPath(s.a), { token: s.a.token })).data.members.length, 3, 'the refused bodies created no member');
  // The database itself refuses a relationship outside the closed vocabulary.
  await assert.rejects(s.db.run("UPDATE household_members SET relationship = 'cousin' WHERE id = ?", [kid.data.id]));
  await assert.rejects(s.db.run("UPDATE household_members SET aliases = 'plain text' WHERE id = ?", [kid.data.id]));
});

test('members: another household and a viewer cannot read or change relationship and aliases', opts, async t => {
  const s = await world(t);
  const kid = await addMember(s, { displayName: 'Kid Synthetic', memberKind: 'dependent', relationship: 'daughter', aliases: ['Guddi'] });
  const foreign = await s.app.call(`${membersPath(s.a)}/${kid.data.id}`, { method: 'PATCH', token: s.b.token, body: { aliases: ['Hacked'] } });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  assert.equal(foreign.text.includes('Guddi'), false);
  assert.equal((await s.app.call(membersPath(s.a), { token: s.b.token })).status, 404);
  // Another household cannot patch a member id it does not own through its own household path either.
  assert.equal((await s.app.call(`${membersPath(s.b)}/${kid.data.id}`, { method: 'PATCH', token: s.b.token, body: { aliases: ['Hacked'] } })).status, 404);
  const viewer = await s.services.households.createAdult({ displayName: 'Viewer Synthetic' });
  await s.services.households.addRole({ householdId: s.a.household, adultUserId: viewer.id, role: 'viewer' });
  const viewerToken = (await s.services.auth.issueSession({ adultUserId: viewer.id })).token;
  assert.deepEqual((await s.app.call(membersPath(s.a), { token: viewerToken })).data.members.find(m => m.id === kid.data.id).aliases, ['Guddi']);
  const denied = await s.app.call(`${membersPath(s.a)}/${kid.data.id}`, { method: 'PATCH', token: viewerToken, body: { aliases: ['Hacked'] } });
  assert.equal(denied.status, 403);
  assert.equal(denied.data.error.code, 'HOUSEHOLD_WRITE_FORBIDDEN');
  assert.equal((await s.app.call(membersPath(s.a))).status, 401);
  const after = (await s.app.call(membersPath(s.a), { token: s.a.token })).data.members.find(m => m.id === kid.data.id);
  assert.deepEqual(after.aliases, ['Guddi']);
});

test('members: DELETE removes the row with its aliases; the export carries relationship and aliases', opts, async t => {
  const s = await world(t);
  const kid = await addMember(s, { displayName: 'Kid Synthetic', memberKind: 'dependent', relationship: 'son', aliases: ['Bunty'] });
  const exported = await s.app.call(`${membersPath(s.a)}/${kid.data.id}/export`, { token: s.a.token });
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.data.member.relationship, 'son');
  assert.deepEqual(exported.data.member.aliases, ['Bunty']);
  const removed = await s.app.call(`${membersPath(s.a)}/${kid.data.id}`, { method: 'DELETE', token: s.a.token });
  assert.equal(removed.status, 200, removed.text);
  assert.equal(await s.db.one('SELECT id FROM household_members WHERE id = ?', [kid.data.id]), null);
});

test('erasure: erasing a member or a household wipes relationship and aliases', opts, async t => {
  const s = await world(t);
  const actor = { type: 'adult_user', id: s.a.adult };
  const one = await addMember(s, { displayName: 'Erase One', memberKind: 'dependent', relationship: 'sibling', aliases: ['Bhai'] });
  const two = await addMember(s, { displayName: 'Erase Two', memberKind: 'dependent', relationship: 'father', aliases: ['Papa'] });
  const before = await s.db.one('SELECT relationship, aliases FROM household_members WHERE id = ?', [one.data.id]);
  assert.equal(before.relationship, 'sibling');
  assert.match(before.aliases, SEALED);
  await s.services.erasure.eraseMember({ householdId: s.a.household, memberId: one.data.id, actor, reason: 'data_subject_request', mayEraseOthersCases: true });
  // The row is pruned or left as a content-free tombstone; either way nothing of it remains.
  const erased = await s.db.one('SELECT display_name, relationship, aliases, relationship_label FROM household_members WHERE id = ?', [one.data.id]);
  if (erased) assert.deepEqual([erased.display_name, erased.relationship, erased.aliases, erased.relationship_label], ['[erased]', null, null, null]);
  assert.ok(!(await s.app.call(membersPath(s.a), { token: s.a.token })).data.members.some(member => member.id === one.data.id));
  // The other member is untouched until the household is erased.
  assert.match((await s.db.one('SELECT aliases FROM household_members WHERE id = ?', [two.data.id])).aliases, SEALED);
  await s.services.erasure.eraseHousehold({ householdId: s.a.household, actor, reason: 'data_subject_request' });
  const rows = await s.db.many('SELECT id, relationship, aliases FROM household_members WHERE household_id = ?', [s.a.household]);
  for (const row of rows) { assert.equal(row.relationship, null, row.id); assert.equal(row.aliases, null, row.id); }
  // The other household is untouched.
  assert.equal(Number((await s.db.one('SELECT count(*) AS n FROM household_members WHERE household_id = ?', [s.b.household])).n), 1);
});

// ---- overview and policies on holdings ----

async function seedHolding(s, w = s.a, kind = 'retail_health') {
  return s.services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind, policyId: w.policy });
}

async function seedOverviewFacts(s, holding) {
  const { a } = s;
  const base = { householdId: a.household, holdingId: holding.id, policyId: a.policy, consentGrantId: a.coverageGrant, provenance: { sourceDocumentId: a.document, sourcePageId: a.page } };
  const own = (factKey, value) => s.services.memoryFacts.insertFact({ ...base, factKey, tier: 'own_pdf', status: 'extracted_unverified', value: { value, alternatives: [] } });
  await own('sum_insured', { amountMinor: 50_000_000 });
  await own('premium_total', { amountMinor: 1_234_550 });
  await own('renewal_date', { iso: '2027-04-01' });
  await s.services.premiums.addDue({ householdId: a.household, adultId: a.adult, holdingId: holding.id, dueOn: '2027-04-01', amountPaise: 1_234_550, consentGrantId: a.profileGrant });
  await s.services.premiums.addDue({ householdId: a.household, adultId: a.adult, holdingId: holding.id, dueOn: '2026-04-01', amountPaise: 1_000_000, consentGrantId: a.profileGrant });
}

const overviewPath = who => `/api/v1/households/${who.household}/overview`;
const policiesPath = who => `/api/v1/households/${who.household}/policies`;

test('overview and policies: a holding with nothing extracted shows nulls and needs_product, never invented values', opts, async t => {
  const s = await world(t);
  const holding = await seedHolding(s);
  const ov = await s.app.call(overviewPath(s.a), { token: s.a.token });
  assert.equal(ov.status, 200, ov.text);
  assert.deepEqual(Object.keys(ov.data).sort(), ['counts', 'derived', 'holdings', 'household', 'members', 'nextDue', 'viewerRole']);
  assert.equal(ov.data.viewerRole, 'owner');
  assert.deepEqual(ov.data.holdings, [{
    holdingId: holding.id, insurer: null, productName: null, sumInsuredRs: null, premiumRs: null, nextDueOn: null, renewsOn: null, coveredMemberIds: null, state: 'needs_product',
  }]);
  assert.equal(ov.data.counts.holdings, 1);
  assert.equal(ov.data.counts.holdingsByState.needs_product, 1);
  assert.equal(ov.data.counts.holdingsByState.ready, 0);
  assert.equal(ov.data.nextDue, null);
  assert.equal(ov.data.members.length, 1);
  const pol = await s.app.call(policiesPath(s.a), { token: s.a.token });
  assert.equal(pol.status, 200, pol.text);
  assert.deepEqual(pol.data, { householdId: s.a.household, holdings: ov.data.holdings });
  // No holdings at all is an empty list, not an error.
  const empty = await s.app.call(policiesPath(s.b), { token: s.b.token });
  assert.deepEqual(empty.data, { householdId: s.b.household, holdings: [] });
});

test('overview: extracted facts, premium dues and listed members fill the fields; states follow the holding status', opts, async t => {
  const s = await world(t);
  const holding = await seedHolding(s);
  await seedOverviewFacts(s, holding);
  await s.services.householdApp.createPolicy({ householdId: s.a.household, insurerId: (await s.services.householdApp.findOrCreateInsurer({ legalName: 'Northstar Synthetic' })).id, policyKind: 'group', policyNumberMasked: 'XXXX-0001', startsOn: '2026-04-01', endsOn: '2099-03-31', memberIds: [] });
  // Mark the due of 2026-04-01 paid: the next due is the unpaid 2027 one.
  const payment = await s.services.premiums.recordPayment({ householdId: s.a.household, adultId: s.a.adult, holdingId: holding.id, amountPaise: 1_000_000, paidOn: '2026-03-30', channel: 'upi', consentGrantId: s.a.profileGrant });
  const dues = await s.services.premiums.listDues({ householdId: s.a.household, adultId: s.a.adult });
  await s.services.premiums.markDuePaid({ householdId: s.a.household, adultId: s.a.adult, dueId: dues.find(due => due.dueOn === '2026-04-01').id, paymentId: payment.id, consentGrantId: s.a.profileGrant });
  await s.db.run('INSERT INTO policy_members (policy_id, household_member_id, membership_state, created_at) VALUES (?, ?, ?, ?)', [s.a.policy, s.a.member, 'stated', '2026-01-01T00:00:00.000Z']);
  const setStatus = status => s.services.policyHoldings.setStatus({ householdId: s.a.household, holdingId: holding.id, status });
  await setStatus('parsed');
  let item = (await s.app.call(overviewPath(s.a), { token: s.a.token })).data.holdings[0];
  assert.equal(item.state, 'reading');
  assert.equal(item.sumInsuredRs, 500000);
  assert.equal(item.premiumRs, 12345.5);
  assert.equal(item.renewsOn, '2027-04-01');
  assert.equal(item.nextDueOn, '2027-04-01');
  assert.deepEqual(item.coveredMemberIds, [s.a.member]);
  assert.equal(item.insurer, null, 'an unconfirmed insurer is never shown');
  await setStatus('ready');
  const ov = await s.app.call(overviewPath(s.a), { token: s.a.token });
  assert.equal(ov.data.holdings[0].state, 'ready');
  assert.deepEqual(ov.data.nextDue, { holdingId: holding.id, dueOn: '2027-04-01' });
  assert.equal(ov.data.counts.holdingsByState.ready, 1);
  await setStatus('conflicts');
  item = (await s.app.call(policiesPath(s.a), { token: s.a.token })).data.holdings[0];
  assert.equal(item.state, 'conflicting');
});

test('overview: a conflicting sum insured is null, and a given-up pipeline step shows failed', opts, async t => {
  const s = await world(t);
  const holding = await seedHolding(s);
  const base = { householdId: s.a.household, holdingId: holding.id, policyId: s.a.policy, consentGrantId: s.a.coverageGrant, provenance: { sourceDocumentId: s.a.document, sourcePageId: s.a.page } };
  await s.services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status: 'conflicting', value: { value: null, alternatives: [{ amountMinor: 100 }, { amountMinor: 200 }] } });
  await s.handle.pool.query(`INSERT INTO job_queue (id, kind, household_id, document_id, payload_json, status, attempts, max_attempts, finished_at)
    VALUES ('job-dead-1', 'holding.parse_own_pdf', $1, $2, $3, 'dead', 3, 3, now())`, [s.a.household, s.a.document, JSON.stringify({ holdingId: holding.id })]);
  const item = (await s.app.call(overviewPath(s.a), { token: s.a.token })).data.holdings[0];
  assert.equal(item.sumInsuredRs, null);
  assert.equal(item.state, 'failed');
  // A dead job of another household's holding never marks this one.
  const other = await seedHolding(s, s.b);
  await s.handle.pool.query(`INSERT INTO job_queue (id, kind, household_id, document_id, payload_json, status, attempts, max_attempts, finished_at)
    VALUES ('job-dead-2', 'holding.parse_own_pdf', $1, $2, $3, 'dead', 3, 3, now())`, [s.b.household, s.b.document, JSON.stringify({ holdingId: holding.id })]);
  assert.equal((await s.app.call(overviewPath(s.b), { token: s.b.token })).data.holdings.find(h => h.holdingId === other.id).state, 'needs_product');
});

test('overview and policies: owner only (non-owner and foreign are the same 404), 401 without a token, 503 when holdings are off', opts, async t => {
  const s = await world(t);
  await seedHolding(s);
  for (const path of [overviewPath(s.a), policiesPath(s.a)]) {
    assert.equal((await s.app.call(path)).status, 401, path);
    const foreign = await s.app.call(path, { token: s.b.token });
    assert.equal(foreign.status, 404, path);
    assert.equal(foreign.data.error.code, 'HOUSEHOLD_NOT_FOUND');
    for (const role of ['member', 'viewer']) {
      const adult = await s.services.households.createAdult({ displayName: `${role} Synthetic` });
      await s.services.households.addRole({ householdId: s.a.household, adultUserId: adult.id, role });
      const token = (await s.services.auth.issueSession({ adultUserId: adult.id })).token;
      const r = await s.app.call(path, { token });
      assert.equal(r.status, 404, `${role} ${path}`);
      assert.equal(r.data.error.code, 'HOUSEHOLD_NOT_FOUND');
    }
  }
  const off = await world(t, {});
  await seedHolding(off);
  const closed = await off.app.call(overviewPath(off.a), { token: off.a.token });
  assert.equal(closed.status, 503);
  assert.equal(closed.data.error.code, 'HOLDINGS_DISABLED');
  assert.equal((await off.app.call(policiesPath(off.a), { token: off.a.token })).data.error.code, 'HOLDINGS_DISABLED');
});

// ---- memory document: JSON variant ----

const mdPath = (holding, query = '') => `/api/v1/holdings/${holding.id}/memory-document${query}`;

test('memory document: ?format=json returns the same sections as the markdown text; the default stays markdown', opts, async t => {
  const s = await world(t);
  const holding = await seedHolding(s);
  const base = { householdId: s.a.household, holdingId: holding.id, policyId: s.a.policy, consentGrantId: s.a.coverageGrant, provenance: { sourceDocumentId: s.a.document, sourcePageId: s.a.page } };
  await s.services.memoryFacts.insertFact({ ...base, factKey: 'sum_insured', tier: 'own_pdf', status: 'extracted_unverified', value: { value: { amountMinor: 50_000_000 }, alternatives: [] } });
  await s.services.declarations.create({ householdId: s.a.household, adultId: s.a.adult, memberId: s.a.member, kind: 'pre_existing_disease', label: 'Synthetic condition', declaredOn: '2024-05-01', declaredToInsurer: true, holdingId: holding.id, consentGrantId: s.a.profileGrant });
  const text = await s.app.call(mdPath(holding), { token: s.a.token });
  assert.equal(text.status, 200, text.text);
  assert.equal(text.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const explicit = await s.app.call(mdPath(holding, '?format=markdown'), { token: s.a.token });
  assert.equal(explicit.text, text.text);
  const json = await s.app.call(mdPath(holding, '?format=json'), { token: s.a.token });
  assert.equal(json.status, 200, json.text);
  assert.match(json.headers.get('content-type'), /application\/json/);
  assert.deepEqual(Object.keys(json.data), ['sections']);
  assert.deepEqual(json.data.sections.map(section => section.title), [...MEMORY_DOCUMENT_SECTIONS]);
  assert.deepEqual(json.data.sections.map(section => section.key), ['policy', 'people_covered', 'cover_and_limits', 'waiting_periods', 'exclusions', 'insurer_terms_your_document_doesn_t_state', 'declared_conditions', 'premiums_and_dues', 'conflicts_to_resolve', 'open_questions']);
  for (const section of json.data.sections) {
    assert.deepEqual(Object.keys(section), ['key', 'title', 'markdown']);
    assert.ok(section.markdown.length > 0);
    assert.equal(section.markdown.includes('## '), false, 'no heading inside a section');
    assert.ok(text.text.includes(`## ${section.title}\n\n${section.markdown}\n`), `${section.title} matches the text form`);
  }
  assert.match(json.data.sections.find(section => section.key === 'cover_and_limits').markdown, /INR 5,00,000/);
  assert.match(json.data.sections.find(section => section.key === 'declared_conditions').markdown, /Synthetic condition/);
});

test('memory document: bad format is 400; non-owner, foreign and missing holdings are 404; flags off is 503; no token is 401', opts, async t => {
  const s = await world(t);
  const holding = await seedHolding(s);
  const bad = await s.app.call(mdPath(holding, '?format=xml'), { token: s.a.token });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error.code, 'INVALID_REQUEST');
  assert.equal((await s.app.call(mdPath(holding, '?format=json'))).status, 401);
  const foreign = await s.app.call(mdPath(holding, '?format=json'), { token: s.b.token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'HOLDING_NOT_FOUND');
  const member = await s.services.households.createAdult({ displayName: 'Member Synthetic' });
  await s.services.households.addRole({ householdId: s.a.household, adultUserId: member.id, role: 'member' });
  const memberToken = (await s.services.auth.issueSession({ adultUserId: member.id })).token;
  const asMember = await s.app.call(mdPath(holding, '?format=json'), { token: memberToken });
  assert.equal(asMember.status, 404);
  assert.equal(asMember.data.error.code, 'HOLDING_NOT_FOUND');
  assert.equal((await s.app.call('/api/v1/holdings/no-such-holding/memory-document?format=json', { token: s.a.token })).status, 404);
  const off = await world(t, { HOLDINGS_ENABLED: 'true' });
  const offHolding = await seedHolding(off);
  const disabled = await off.app.call(mdPath(offHolding, '?format=json'), { token: off.a.token });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.data.error.code, 'MEMORY_DISABLED');
});
