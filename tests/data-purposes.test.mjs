// Purpose registry and itemised notices (S5). Synthetic data only. Notice wording is FOR LEGAL REVIEW and never final.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import {
  CONSENTERS, DATA_REGISTRY, PERSONAL_DATA_CATEGORIES, PURPOSES, RETENTION_CLASSES, noticeSetView, registryFields,
} from '../src/contracts/data-purposes.js';
import { CONSENT_PURPOSES } from '../src/contracts/data-purpose-registry.js';
import { NOTICES, NOTICE_IDS, NOTICE_SET_VERSION, getNotice } from '../src/contracts/notices/index.js';

const pg = postgresTestOptions();

async function schemaColumns(db) {
  const rows = await db.many(`SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
    ORDER BY c.table_name, c.ordinal_position`);
  const tables = new Map();
  for (const { table_name: table, column_name: column } of rows) {
    if (!tables.has(table)) tables.set(table, []);
    tables.get(table).push(column);
  }
  return tables;
}

// Returns every way the registry and the schema disagree. Empty means no drift.
function findDrift(tables, registry = DATA_REGISTRY) {
  const problems = [];
  for (const table of tables.keys()) {
    if (!registry[table]) problems.push(`table ${table} is not in the purpose registry`);
  }
  for (const [table, spec] of Object.entries(registry)) {
    const actual = tables.get(table);
    if (!actual) { problems.push(`registry table ${table} does not exist`); continue; }
    const listed = [...Object.values(spec.personal).flat(), ...spec.system];
    const seen = new Set();
    for (const column of listed) {
      if (seen.has(column)) problems.push(`${table}.${column} is classified twice`);
      seen.add(column);
      if (!actual.includes(column)) problems.push(`registry column ${table}.${column} does not exist`);
    }
    for (const column of actual) {
      if (!seen.has(column)) problems.push(`column ${table}.${column} has no purpose in the registry`);
    }
  }
  return problems;
}

test('every stored column is classified in the purpose registry and nothing stale remains', pg, async t => {
  const { db } = await freshDatabase(t);
  const tables = await schemaColumns(db);
  assert.ok(tables.size > 50, 'the migrated schema was read');
  assert.deepEqual(findDrift(tables), []);
});

test('the drift guard fires for a new column, a new table, a stale entry and a double classification', pg, async t => {
  const { db } = await freshDatabase(t);
  const tables = await schemaColumns(db);
  const withColumn = new Map(tables).set('adult_users', [...tables.get('adult_users'), 'blood_group']);
  assert.deepEqual(findDrift(withColumn), ['column adult_users.blood_group has no purpose in the registry']);
  const withTable = new Map(tables).set('health_diary', ['id', 'entry']);
  assert.deepEqual(findDrift(withTable), ['table health_diary is not in the purpose registry']);
  const stale = { ...DATA_REGISTRY, adult_users: { ...DATA_REGISTRY.adult_users, system: [...DATA_REGISTRY.adult_users.system, 'gone'] } };
  assert.deepEqual(findDrift(tables, stale), ['registry column adult_users.gone does not exist']);
  const twice = { ...DATA_REGISTRY, adult_users: { ...DATA_REGISTRY.adult_users, system: [...DATA_REGISTRY.adult_users.system, 'display_name'] } };
  assert.deepEqual(findDrift(tables, twice), ['adult_users.display_name is classified twice']);
});

test('every registry purpose, category, retention class and consenter is defined', () => {
  for (const [table, spec] of Object.entries(DATA_REGISTRY)) {
    assert.ok(PURPOSES[spec.purpose], `${table} names an unknown purpose`);
    if (spec.consenter) assert.ok(CONSENTERS[spec.consenter], `${table} names an unknown consenter`);
    if (spec.retentionClass) assert.ok(RETENTION_CLASSES[spec.retentionClass], `${table} names an unknown retention class`);
    for (const category of Object.keys(spec.personal)) assert.ok(PERSONAL_DATA_CATEGORIES[category], `${table} uses unknown category ${category}`);
  }
  for (const [id, purpose] of Object.entries(PURPOSES)) {
    assert.ok(RETENTION_CLASSES[purpose.retentionClass], `${id} retention class`);
    assert.ok(CONSENTERS[purpose.consenter], `${id} consenter`);
    assert.equal(purpose.legalBasis.status, 'pending_legal_review', `${id} legal basis is a placeholder`);
  }
  for (const row of registryFields()) {
    assert.ok(row.table && row.column && row.purpose && row.retentionClass && row.consenter && row.legalBasis, `${row.table}.${row.column} is fully described`);
  }
});

test('every registry notice id exists, and every notice belongs to a purpose that uses it', () => {
  for (const [id, purpose] of Object.entries(PURPOSES)) {
    if (purpose.noticeId === null) continue;
    assert.ok(getNotice(purpose.noticeId), `${id} points at missing notice ${purpose.noticeId}`);
    assert.equal(getNotice(purpose.noticeId).purposeId, id);
  }
  for (const notice of NOTICES) {
    assert.equal(PURPOSES[notice.purposeId]?.noticeId, notice.id, `${notice.id} is not the notice of ${notice.purposeId}`);
    assert.ok(Object.values(DATA_REGISTRY).some(spec => spec.purpose === notice.purposeId), `${notice.id} covers no table`);
  }
  assert.equal(new Set(NOTICE_IDS).size, NOTICE_IDS.length);
});

test('a table that holds personal data never uses a purpose without a notice', () => {
  for (const [table, spec] of Object.entries(DATA_REGISTRY)) {
    if (Object.keys(spec.personal).length === 0) continue;
    assert.notEqual(PURPOSES[spec.purpose].noticeId, null, `${table} holds personal data but its purpose has no notice`);
    assert.notEqual(spec.purpose, 'reference_data');
  }
  for (const [table, spec] of Object.entries(DATA_REGISTRY)) {
    if (spec.purpose === 'reference_data') assert.deepEqual(spec.personal, {}, `${table} is reference data and must hold no personal column`);
  }
});

test('each notice itemises exactly the personal-data categories its purpose stores', () => {
  for (const notice of NOTICES) {
    const stored = new Set();
    for (const spec of Object.values(DATA_REGISTRY)) {
      if (spec.purpose === notice.purposeId) for (const category of Object.keys(spec.personal)) stored.add(category);
    }
    const noticed = new Set(notice.items.flatMap(item => item.categories));
    assert.deepEqual([...noticed].sort(), [...stored].sort(), `${notice.id} items must match stored categories`);
    for (const item of notice.items) {
      assert.ok(item.data.length > 0 && item.use.length > 0, `${notice.id} items state what and why`);
      for (const category of item.categories) assert.ok(PERSONAL_DATA_CATEGORIES[category]);
    }
    assert.ok(notice.recipients.length > 0 && notice.retention && notice.withdrawal && notice.title && notice.summary);
  }
});

test('data about a household member can be consented to by a guardian', () => {
  const memberLinked = /(^|_)member_id$/;
  for (const [table, spec] of Object.entries(DATA_REGISTRY)) {
    const columns = [...Object.values(spec.personal).flat(), ...spec.system];
    const holdsPersonal = Object.keys(spec.personal).length > 0;
    if (table === 'household_members' || (holdsPersonal && columns.some(column => memberLinked.test(column)))) {
      const consenter = spec.consenter ?? PURPOSES[spec.purpose].consenter;
      assert.equal(consenter, 'self_or_guardian', `${table} concerns a member who may be a child`);
    }
  }
  for (const notice of NOTICES.filter(item => PURPOSES[item.purposeId].consenter === 'self_or_guardian')) {
    assert.ok(notice.guardianNote, `${notice.id} must say a guardian can act`);
  }
});

test('every consent purpose the code already uses is a registered purpose', () => {
  for (const purpose of ['document_processing', 'coverage_reconstruction', 'profile_intake', 'affordability_planning', 'human_review']) {
    assert.ok(PURPOSES[purpose], purpose);
  }
});

test('notices are versioned, marked for legal review, and carry no stored data', () => {
  assert.ok(Number.isInteger(NOTICE_SET_VERSION) && NOTICE_SET_VERSION >= 1);
  for (const notice of NOTICES) {
    assert.equal(notice.legalReview, 'pending', `${notice.id} must stay pending until counsel approves it`);
    assert.equal(notice.version, NOTICE_SET_VERSION);
    assert.ok(Object.isFrozen(notice) && Object.isFrozen(notice.items));
  }
  for (const file of ['../src/contracts/notices/notices-v1.js', '../src/contracts/data-purposes.js']) {
    assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /FOR LEGAL REVIEW/);
  }
  const text = JSON.stringify(noticeSetView());
  assert.ok(!/@|\b\d{10}\b|household_[a-z0-9]{8}|Bearer /i.test(text), 'the notice text holds no contact, id or token');
});

test('GET /api/v1/notices is public, read-only and returns the notice set', pg, async t => {
  const { db } = await freshDatabase(t);
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: 'knowvia-test-bootstrap-token-00001' } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/v1/notices`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, JSON.parse(JSON.stringify(noticeSetView())));
  assert.equal(body.version, NOTICE_SET_VERSION);
  assert.equal(body.legalReview, 'pending');
  assert.equal(body.notices.length, NOTICES.length);
  assert.ok(body.notices.every(notice => notice.legalReview === 'pending' && notice.items.length > 0));
  // Read-only: no write method reaches it.
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const refused = await fetch(`${base}/api/v1/notices`, { method });
    assert.ok(refused.status >= 400, `${method} must not succeed`);
  }
  // The host guard still applies.
  const foreign = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/v1/notices', headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(foreign, 403);
});

test('GET /api/v1/notices/:id is public, coded on a miss, and identical for every household', pg, async t => {
  const { db } = await freshDatabase(t);
  const token = 'coversaath-test-bootstrap-token-0005';
  const server = createApiServer({ database: db, env: { KNOWVIA_BOOTSTRAP_TOKEN: token } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const create = async name => {
    const r = await fetch(`${base}/api/v1/households`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ displayName: `${name} household`, owner: { displayName: `${name} owner`, contactEmail: `${name.toLowerCase()}@example.test` } }) });
    assert.equal(r.status, 201);
    return (await r.json()).session.token;
  };
  const [a, b] = [await create('Alpha'), await create('Beta')];
  const id = NOTICE_IDS[0];
  const anon = await fetch(`${base}/api/v1/notices/${id}`);
  assert.equal(anon.status, 200);
  const anonBody = await anon.json();
  assert.equal(anonBody.id, id);
  assert.equal(anonBody.legalReview, 'pending');
  // Household ownership: a notice is the same static text for every session, a bad token changes nothing, and it holds no household data.
  for (const session of [a, b, 'not-a-real-token']) {
    const r = await fetch(`${base}/api/v1/notices/${id}`, { headers: { Authorization: `Bearer ${session}` } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), anonBody);
  }
  // Coded errors: unknown id is 404 NOTICE_NOT_FOUND; a malformed id never reaches a lookup; writes are refused.
  const miss = await fetch(`${base}/api/v1/notices/notice_nope`);
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).error.code, 'NOTICE_NOT_FOUND');
  const bad = await fetch(`${base}/api/v1/notices/..%2F..%2Fx`);
  assert.ok(bad.status >= 400 && bad.status < 500);
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const refused = await fetch(`${base}/api/v1/notices/${id}`, { method });
    assert.ok(refused.status >= 400, `${method} must not succeed`);
  }
});

test('every consent purpose in the data-purpose registry either has a notice purpose or is listed as not yet storing data', () => {
  // These four consent purposes exist in the consent_grants CHECK list but no table stores data for them yet (S5 follow-up when they do).
  const noDataYet = new Set(['voice_intake', 'institutional_clarification', 'purchase_review', 'payment']);
  for (const purpose of CONSENT_PURPOSES) {
    if (noDataYet.has(purpose)) assert.equal(PURPOSES[purpose], undefined, `${purpose} now has a notice purpose; drop it from the list`);
    else assert.ok(PURPOSES[purpose], `consent purpose ${purpose} has no notice purpose`);
  }
});
