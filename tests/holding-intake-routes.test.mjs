import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { insert, seedWorld } from './support/postgres-fixtures.mjs';
import { eraseMemoryForConsentGrant, eraseMemoryForHousehold } from '../src/backend/repositories/memory-erasure.js';
import { QUESTION_CATALOGUE_VERSION } from '../src/features/question-planner/index.js';
import { isMinorOn, optionIdsOf, storedValueOf } from '../src/backend/services/intake-questions-service.js';

// Intake questions over HTTP: planner output for a holding, answers stored as sealed user_declaration memory facts under a
// profile_intake grant, ownership, consent, erasure through the existing memory paths. Synthetic data only. Needs PostgreSQL.

const opts = postgresTestOptions();
const BOOT = 'coversaath-test-bootstrap-token-0018';

async function startApp(database, env) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: BOOT, ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

async function world(t, env = { HOLDINGS_ENABLED: 'true' }) {
  const fresh = await freshDatabase(t);
  const { handle, services } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const b = await seedWorld(handle.pool, 'b');
  for (const w of [a, b]) {
    w.profileGrant = `pi-${w.household.split('-')[1]}`;
    await insert(handle.pool, 'consent_grants', { id: w.profileGrant, household_id: w.household, subject_adult_id: w.adult, purpose: 'profile_intake' });
    w.token = (await services.auth.issueSession({ adultUserId: w.adult })).token;
    w.holding = await services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy });
  }
  const app = await startApp(fresh.db, env);
  t.after(() => app.stop());
  const count = async (table, where = '1=1', params = []) => Number((await fresh.db.one(`SELECT count(*) AS c FROM ${table} WHERE ${where}`, params)).c);
  return { ...fresh, app, a, b, count };
}

const qPath = (w, phase = 'before_card') => `/api/v1/holdings/${w.holding.id}/intake-questions?phase=${phase}`;
const aPath = w => `/api/v1/holdings/${w.holding.id}/intake-answers`;
const answer = (w, questionId, optionIds, extra = {}) => ({ questionId, memberId: w.member, optionIds, catalogueVersion: QUESTION_CATALOGUE_VERSION, consentGrantId: w.profileGrant, ...extra });

test('intake helpers: bool keys store booleans, option ids round-trip, minors by birth date', () => {
  assert.equal(storedValueOf({ factKey: 'member_covered', value: 'yes' }), true);
  assert.equal(storedValueOf({ factKey: 'member_covered', value: 'no' }), false);
  assert.deepEqual(storedValueOf({ factKey: 'declared_ped', value: ['diabetes', 'thyroid'] }), ['diabetes', 'thyroid']);
  assert.equal(storedValueOf({ factKey: 'member_relationship', value: 'spouse' }), 'spouse');
  assert.deepEqual(optionIdsOf(true), ['yes']);
  assert.deepEqual(optionIdsOf(false), ['no']);
  assert.deepEqual(optionIdsOf(['a', 'b']), ['a', 'b']);
  assert.deepEqual(optionIdsOf('spouse'), ['spouse']);
  assert.equal(isMinorOn('2015-06-01', '2026-11-14T00:00:00Z'), true);
  assert.equal(isMinorOn('2008-11-14', '2026-11-14T00:00:00Z'), false, 'the 18th birthday is not a minor');
  assert.equal(isMinorOn('2008-11-15', '2026-11-14T00:00:00Z'), true);
  assert.equal(isMinorOn(null, '2026-11-14T00:00:00Z'), false);
});

test('intake routes: off unless HOLDINGS_ENABLED is exactly true, 401 without a token, 404 for another household', opts, async t => {
  const off = await world(t, {});
  assert.equal((await off.app.call(qPath(off.a), { token: off.a.token })).data.error.code, 'HOLDINGS_DISABLED');
  const on = await startApp(off.db, { HOLDINGS_ENABLED: 'true' });
  t.after(() => on.stop());
  assert.equal((await on.call(qPath(off.a))).status, 401);
  const foreign = await on.call(qPath(off.a), { token: off.b.token });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'HOLDING_NOT_FOUND');
  const foreignWrite = await on.call(aPath(off.a), { method: 'POST', token: off.b.token, body: answer(off.b, 'members.confirm', ['yes']) });
  assert.equal(foreignWrite.status, 404);
  assert.equal(await off.count('household_memory_facts'), 0);
});

test('intake: plan, answer, followup, sealed store, consent, validation, erasure', opts, async t => {
  const { app, a, b, db, count } = await world(t);
  const first = await app.call(qPath(a), { token: a.token });
  assert.equal(first.status, 200, first.text);
  assert.equal(first.data.catalogueVersion, QUESTION_CATALOGUE_VERSION);
  assert.ok(first.data.questions.length <= 2, 'at most 2 before the card');
  assert.deepEqual(first.data.questions.map(q => q.questionId), ['members.confirm', 'ped.has_any']);
  assert.ok(first.data.questions.every(q => q.memberId === a.member));
  assert.deepEqual(Object.keys(first.data.catalogue).sort(), ['members.confirm', 'ped.has_any'], 'catalogue entries only for the returned ids');
  assert.equal(first.data.catalogue['members.confirm'].prompt.en, 'Is this person covered under this policy?');
  assert.equal(first.data.catalogue['members.confirm'].legalReview, 'pending');
  assert.equal('valueOfInformation' in first.data.catalogue['ped.has_any'] || 'slot' in first.data.catalogue['ped.has_any'], false, 'no planner internals');

  // Bad input: phase, catalogue version, option, member of another household, missing consent grant.
  assert.equal((await app.call(qPath(a, 'later'), { token: a.token })).data.error.code, 'INTAKE_REQUEST_INVALID');
  for (const [body, codeWanted] of [
    [answer(a, 'members.confirm', ['yes'], { catalogueVersion: 'question-catalogue/v0' }), 'QUESTION_ANSWER_INVALID'],
    [answer(a, 'members.confirm', ['maybe']), 'QUESTION_ANSWER_INVALID'],
    [answer(a, 'members.confirm', ['yes'], { memberId: b.member }), 'MEMBER_NOT_FOUND'],
    [answer(a, 'members.confirm', ['yes'], { consentGrantId: undefined }), 'INTAKE_REQUEST_INVALID'],
    [answer(a, 'members.confirm', ['yes'], { consentGrantId: b.profileGrant }), 'CONSENT_REQUIRED'],
    [answer(a, 'members.confirm', ['yes'], { consentGrantId: a.consent }), 'CONSENT_REQUIRED'],
  ]) {
    const r = await app.call(aPath(a), { method: 'POST', token: a.token, body });
    assert.equal(r.data.error?.code, codeWanted, r.text);
  }
  assert.equal(await count('household_memory_facts'), 0, 'nothing stored by a refused answer');

  // "Not sure" stores nothing.
  const unsure = await app.call(aPath(a), { method: 'POST', token: a.token, body: answer(a, 'members.confirm', ['not_sure']) });
  assert.equal(unsure.status, 200, unsure.text);
  assert.deepEqual([unsure.data.stored, unsure.data.status], [false, 'unknown']);
  assert.equal(await count('household_memory_facts'), 0);

  // A real answer is a sealed user_declaration row; replay writes nothing.
  const yes = await app.call(aPath(a), { method: 'POST', token: a.token, body: answer(a, 'members.confirm', ['yes']) });
  assert.deepEqual([yes.status, yes.data.stored, yes.data.status], [200, true, 'user_confirmed']);
  assert.equal((await app.call(aPath(a), { method: 'POST', token: a.token, body: answer(a, 'members.confirm', ['yes']) })).data.stored, false);
  const row = await db.one(`SELECT * FROM household_memory_facts WHERE household_id = ?`, [a.household]);
  assert.deepEqual([row.source_tier, row.status, row.capture_method, row.fact_key, row.subject_member_id, row.holding_id],
    ['user_declaration', 'user_confirmed', 'box_confirm', 'member_covered', a.member, a.holding.id]);
  assert.match(row.value_enc, /^enc2[.]/);

  // The answered question leaves the plan; a "yes" to ped.has_any activates its followup next.
  const ped = await app.call(aPath(a), { method: 'POST', token: a.token, body: answer(a, 'ped.has_any', ['yes']) });
  assert.deepEqual(ped.data.followupsActivated, ['ped.which_conditions']);
  const next = await app.call(qPath(a), { token: a.token });
  assert.equal(next.data.questions[0].questionId, 'ped.which_conditions', 'an activated followup comes first');
  assert.equal(next.data.questions.some(q => ['members.confirm', 'ped.has_any'].includes(q.questionId)), false, 'answered questions leave the plan');
  assert.equal(next.data.questions[0].reason, 'followup');
  const chips = await app.call(aPath(a), { method: 'POST', token: a.token, body: answer(a, 'ped.which_conditions', ['thyroid', 'diabetes']) });
  assert.equal(chips.data.stored, true);
  const health = await db.one(`SELECT value_enc FROM household_memory_facts WHERE household_id = ? AND scope_key = 'conditions'`, [a.household]);
  assert.equal(/thyroid|diabetes/.test(health.value_enc), false, 'health answer is not readable at rest');

  // Household b sees none of it.
  assert.equal(await count('household_memory_facts', 'household_id = ?', [b.household]), 0);

  // Erasure: withdrawing the profile_intake grant erases the answers (existing memory erasure path); the household path too.
  await db.transaction(() => eraseMemoryForConsentGrant(db, { householdId: a.household, consentGrantId: a.profileGrant }));
  assert.equal(await count('household_memory_facts', 'household_id = ?', [a.household]), 0);
  await app.call(aPath(a), { method: 'POST', token: a.token, body: answer(a, 'members.confirm', ['no']) });
  await db.transaction(() => eraseMemoryForHousehold(db, { householdId: a.household }));
  assert.equal(await count('household_memory_facts', 'household_id = ?', [a.household]), 0);
});
