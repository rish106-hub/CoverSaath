import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario } from './support/read-back-harness.mjs';
import { parseProfileAnswers } from '../src/contracts/profile-answers.js';

const pgOptions = postgresTestOptions();

// E1a (ADR 0013): GET/PUT/DELETE /api/v1/cases/{caseId}/profile-answers. User-stated answers, sealed before storage, owned by
// the case, erased by DELETE. Synthetic values only. Not evidence: no evidence state, no confirmation.

const path = caseId => `/api/v1/cases/${caseId}/profile-answers`;
const put = (app, s, answers, { token = s.token, caseId = s.caseId } = {}) => app.call(path(caseId), { method: 'PUT', token, body: { answers } });
const get = (app, s, { token = s.token, caseId = s.caseId } = {}) => app.call(path(caseId), { token });
const rawRows = app => app.database.many('SELECT * FROM profile_answers ORDER BY field_key');

test('E1a: an empty case lists no answers and says they are user stated, not evidence', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  const res = await get(app, s);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.label, 'user_stated');
  assert.equal(res.data.source, 'user_stated');
  assert.deepEqual(res.data.answers, []);
  assert.deepEqual(res.data.fields, ['covered_people', 'city', 'state', 'renewal_month', 'has_employer_cover', 'has_personal_policy', 'has_top_up_policy']);
  assert.match(res.data.notice, /not read from your documents/);
  assert.ok(!JSON.stringify(res.data).match(/verified|confirmed|score/i));
});

test('E1a: PUT stores answers, GET returns them, a repeat is idempotent and null removes one', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  const first = await put(app, s, { covered_people: 'self_partner', city: 'Pune', renewal_month: 7, has_employer_cover: true, has_top_up_policy: false });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const byKey = Object.fromEntries(first.data.answers.map(answer => [answer.fieldKey, answer.value]));
  assert.deepEqual(byKey, { covered_people: 'self_partner', city: 'Pune', renewal_month: 7, has_employer_cover: true, has_top_up_policy: false });
  assert.deepEqual(Object.keys(first.data.answers[0]).sort(), ['fieldKey', 'updatedAt', 'value']);

  const idsBefore = (await rawRows(app)).map(row => `${row.id}:${row.value_ciphertext}`);
  const again = await put(app, s, { covered_people: 'self_partner', city: 'Pune' });
  assert.equal(again.status, 200);
  assert.deepEqual((await rawRows(app)).map(row => `${row.id}:${row.value_ciphertext}`), idsBefore, 'an identical PUT rewrites nothing');
  assert.equal((await get(app, s)).data.answers.length, 5);

  const changed = await put(app, s, { city: 'Mumbai', renewal_month: null });
  assert.equal(changed.status, 200);
  const after = Object.fromEntries(changed.data.answers.map(answer => [answer.fieldKey, answer.value]));
  assert.equal(after.city, 'Mumbai');
  assert.ok(!('renewal_month' in after));
  assert.equal((await rawRows(app)).length, 4);
  const audit = await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'profile_answers.updated' ORDER BY id");
  assert.equal(audit.length, 2, 'the no-change PUT writes no audit event');
  assert.ok(!audit.map(row => row.event_payload_json).join('').includes('Mumbai'), 'values never reach the audit chain');
});

test('E1a: the stored value is ciphertext at rest', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  await put(app, s, { city: 'Nashik', state: 'Maharashtra', has_personal_policy: true });
  const rows = await rawRows(app);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.match(row.value_ciphertext, /^enc2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.ok(!row.value_ciphertext.includes('Nashik') && !row.value_ciphertext.includes('Maharashtra'));
    assert.equal(row.source, 'user_stated');
  }
  // The ciphertext is bound to its row: moving it to another row's column fails to open.
  const [a, b] = rows;
  await app.database.run('UPDATE profile_answers SET value_ciphertext = ? WHERE id = ?', [a.value_ciphertext, b.id]);
  const res = await get(app, s);
  assert.equal(res.status, 500);
  assert.equal(res.data.error.code, 'COLUMN_DECRYPTION_FAILED');
  assert.ok(!JSON.stringify(res.data).includes('Nashik'));
});

test('E1a: bad input is a coded 400 and writes nothing', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  const bad = [
    {}, null, [], 'x', { unknown_field: 'x' }, { city: '' }, { city: 'Pune 411001' }, { city: 'x'.repeat(61) }, { city: 5 },
    { renewal_month: 0 }, { renewal_month: 13 }, { renewal_month: '7' }, { renewal_month: 1.5 },
    { has_employer_cover: 'yes' }, { covered_people: 'everyone' }, { __proto__x: 1, constructor: 'x' },
  ];
  for (const answers of bad) {
    const res = await put(app, s, answers);
    assert.equal(res.status, 400, JSON.stringify(answers));
    assert.equal(res.data.error.code, 'PROFILE_ANSWER_INVALID');
  }
  const noBody = await app.call(path(s.caseId), { method: 'PUT', token: s.token, body: {} });
  assert.equal(noBody.status, 400);
  assert.equal((await rawRows(app)).length, 0);
  assert.throws(() => parseProfileAnswers({ city: 'Pune', diagnosis: 'x' }), { code: 'PROFILE_ANSWER_INVALID' });
});

test('E1a: a foreign household, a missing case and a missing token are refused alike; nothing leaks', pgOptions, async t => {
  const app = await startApp(t);
  const mine = await scenario(app, { name: 'Mine', read: false });
  const other = await scenario(app, { name: 'Other', read: false });
  await put(app, mine, { city: 'Pune' });
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const foreign = await app.call(path(mine.caseId), { method, token: other.token, ...(method === 'PUT' ? { body: { answers: { city: 'Delhi' } } } : {}) });
    const missing = await app.call(path('case-does-not-exist'), { method, token: other.token, ...(method === 'PUT' ? { body: { answers: { city: 'Delhi' } } } : {}) });
    assert.equal(foreign.status, 404, method);
    assert.deepEqual(foreign.data, missing.data, `${method}: foreign and missing look the same`);
    assert.equal((await app.call(path(mine.caseId), { method, ...(method === 'PUT' ? { body: { answers: { city: 'Delhi' } } } : {}) })).status, 401);
  }
  assert.deepEqual((await get(app, mine)).data.answers.map(answer => answer.value), ['Pune']);
  assert.deepEqual((await get(app, other)).data.answers, []);
});

test('E1a: DELETE erases every stored answer of the case and leaves other cases alone', pgOptions, async t => {
  const app = await startApp(t);
  const mine = await scenario(app, { name: 'Mine', read: false });
  const other = await scenario(app, { name: 'Other', read: false });
  await put(app, mine, { city: 'Pune', has_employer_cover: true });
  await put(app, other, { city: 'Goa' });
  const res = await app.call(path(mine.caseId), { method: 'DELETE', token: mine.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.data.answers, []);
  assert.deepEqual((await rawRows(app)).map(row => row.case_id), [other.caseId]);
  const repeat = await app.call(path(mine.caseId), { method: 'DELETE', token: mine.token });
  assert.equal(repeat.status, 200, 'DELETE is idempotent');
  const audit = await app.database.many("SELECT event_payload_json FROM audit_events WHERE action = 'profile_answers.erased'");
  assert.equal(audit.length, 1);
  assert.deepEqual(JSON.parse(audit[0].event_payload_json), { answers: 2, reasonCode: 'user_request' });
});

test('E1a: the repository erases by case and by household (the paths a future case or household deletion uses)', pgOptions, async t => {
  const app = await startApp(t);
  const a = await scenario(app, { name: 'A', read: false });
  const b = await scenario(app, { name: 'B', read: false });
  await put(app, a, { city: 'Pune' });
  await put(app, b, { city: 'Goa', state: 'Goa' });
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const services = createBackendServices(app.database);
  assert.deepEqual({ ...await services.profileAnswers.eraseForCase({ householdId: a.householdId, caseId: a.caseId, reasonCode: 'case_erasure' }) }, { answers: 1 });
  assert.equal((await rawRows(app)).length, 2);
  assert.deepEqual({ ...await services.profileAnswers.eraseForHousehold({ householdId: b.householdId }) }, { answers: 2 });
  assert.equal((await rawRows(app)).length, 0);
  await assert.rejects(services.profileAnswers.eraseForCase({ householdId: a.householdId, caseId: a.caseId, reasonCode: 'nope' }), { code: 'PROFILE_ANSWER_INVALID' });
});

test('E1a: the database refuses an answer whose case belongs to another household', pgOptions, async t => {
  const app = await startApp(t);
  const a = await scenario(app, { name: 'A', read: false });
  const b = await scenario(app, { name: 'B', read: false });
  await assert.rejects(app.database.run(`INSERT INTO profile_answers (id, household_id, case_id, adult_user_id, field_key, value_ciphertext, created_at, updated_at)
    VALUES ('x1', ?, ?, ?, 'city', 'enc1.k.a.b.c', 't', 't')`, [a.householdId, b.caseId, a.adultId]), /./);
  await assert.rejects(app.database.run(`INSERT INTO profile_answers (id, household_id, case_id, adult_user_id, field_key, value_ciphertext, created_at, updated_at)
    VALUES ('x2', ?, ?, ?, 'free_text', 'enc1.k.a.b.c', 't', 't')`, [a.householdId, a.caseId, a.adultId]), /./);
});

test('review: the stored length of an answer does not depend on the field or the value (all seven fields, short and longest values)', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  const longest = '𠀀'.repeat(60); // the longest allowed place name, four bytes a character
  const variants = [
    { covered_people: 'self', city: 'Pune', state: 'Goa', renewal_month: 1, has_employer_cover: true, has_personal_policy: false, has_top_up_policy: true },
    { covered_people: 'self_partner_children_parents', city: longest, state: longest, renewal_month: 12, has_employer_cover: false, has_personal_policy: true, has_top_up_policy: false },
  ];
  const lengths = new Set();
  for (const answers of variants) {
    assert.equal((await put(app, s, answers)).status, 200);
    const rows = await rawRows(app);
    assert.equal(rows.length, 7);
    for (const row of rows) lengths.add(row.value_ciphertext.length);
  }
  assert.equal(lengths.size, 1, `all fields and values store the same length (saw ${[...lengths].join(', ')})`);
  assert.deepEqual((await get(app, s)).data.answers.find(answer => answer.fieldKey === 'city').value, longest);
});

test('review: a second adult of the same household gets the same 404 as a stranger on every profile route', pgOptions, async t => {
  const app = await startApp(t);
  const s = await scenario(app, { read: false });
  await put(app, s, { city: 'Pune' });
  const { createBackendServices } = await import('../src/backend/services/index.js');
  const services = createBackendServices(app.database);
  const second = await services.households.createAdult({ displayName: 'Second Synthetic' });
  await services.households.addRole({ householdId: s.householdId, adultUserId: second.id, role: 'member' });
  const session = await services.auth.issueSession({ adultUserId: second.id });
  const token = session.token;
  // The second adult really is a member of the household (the case-level gate alone would let them in).
  assert.equal((await app.call(`/api/v1/households/${s.householdId}`, { token })).status, 200);
  const missing = await app.call(path('case-does-not-exist'), { token });
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await app.call(path(s.caseId), { method, token, ...(method === 'PUT' ? { body: { answers: { city: 'Delhi' } } } : {}) });
    assert.equal(res.status, 404, method);
    assert.deepEqual(res.data, missing.data);
  }
  assert.deepEqual((await get(app, s)).data.answers.map(answer => answer.value), ['Pune'], 'nothing was changed or erased');
});
