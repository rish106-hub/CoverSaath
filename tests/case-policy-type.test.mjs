import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { POLICY_TYPES, DEFAULT_POLICY_TYPE, parsePolicyType } from '../src/contracts/policy-type.js';
import { ANALYSIS_ERROR_CODES } from '../src/contracts/error-codes.js';

// R2: the user tags the policy type when a case is created. Synthetic data only.
const bootstrapToken = 'knowvia-test-bootstrap-token-00001';

test('policy type contract: enum, default, coded error', () => {
  assert.deepEqual([...POLICY_TYPES], ['personal_health', 'group_health', 'term_life', 'other']);
  assert.equal(DEFAULT_POLICY_TYPE, 'other');
  assert.equal(parsePolicyType(undefined), 'other');
  assert.equal(parsePolicyType(null), 'other');
  for (const type of POLICY_TYPES) assert.equal(parsePolicyType(type), type);
  for (const bad of ['', 'Personal_Health', 'health', 7, {}, [], ' term_life']) {
    assert.throws(() => parsePolicyType(bad), error => error.code === 'POLICY_TYPE_INVALID' && error.statusCode === 400);
  }
  assert.deepEqual(ANALYSIS_ERROR_CODES.POLICY_TYPE_INVALID, { httpStatus: 400, category: 'request', retryable: false });
});

async function start(t) {
  const { db: database } = await freshDatabase(t);
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  const household = async name => {
    const identity = await call('/api/v1/households', { method: 'POST', token: bootstrapToken, body: { displayName: name, owner: { displayName: `${name} owner` } } });
    assert.equal(identity.status, 201);
    return { token: identity.data.session.token, householdId: identity.data.household.id, memberId: identity.data.ownerMember.id };
  };
  return { call, household };
}

test('case create stores the policy type, defaults to other and rejects bad values', async t => {
  const app = await start(t);
  const owner = await app.household('Synthetic owner household');
  const create = body => app.call('/api/v1/cases', { method: 'POST', token: owner.token, body: { householdId: owner.householdId, subjectMemberId: owner.memberId, triggerType: 'renewal', ...body } });

  const tagged = await create({ policyType: 'group_health' });
  assert.equal(tagged.status, 201);
  assert.equal(tagged.data.policy_type, 'group_health');

  const defaulted = await create({});
  assert.equal(defaulted.status, 201);
  assert.equal(defaulted.data.policy_type, 'other');

  for (const bad of ['life', '', 12, 'TERM_LIFE']) {
    const rejected = await create({ policyType: bad });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.data.error.code, 'POLICY_TYPE_INVALID');
  }

  const listed = await app.call(`/api/v1/households/${owner.householdId}/cases`, { token: owner.token });
  assert.equal(listed.status, 200);
  const byId = new Map(listed.data.cases.map(row => [row.id, row.policyType]));
  assert.equal(byId.get(tagged.data.id), 'group_health');
  assert.equal(byId.get(defaulted.data.id), 'other');
});

test('policy type cannot be set on another household', async t => {
  const app = await start(t);
  const owner = await app.household('Synthetic owner household');
  const other = await app.household('Synthetic other household');
  const crossed = await app.call('/api/v1/cases', { method: 'POST', token: other.token, body: { householdId: owner.householdId, triggerType: 'renewal', policyType: 'term_life' } });
  assert.ok([403, 404].includes(crossed.status));
});
