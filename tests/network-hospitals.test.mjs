import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createInsuranceDataClient } from '../src/integrations/index.js';
import { seedWorld } from './support/postgres-fixtures.mjs';
import { seedDemo } from '../scripts/seed-demo.mjs';
import { buildJobHandlers } from '../src/server/worker.js';

// Network hospitals (migration 055): sync from the reference export, the owner route, and the demo seed. Synthetic data only.
// Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const BOOT = 'coversaath-test-bootstrap-token-0018';

async function startApp(database, env) {
  const server = createApiServer({ database, env: { KNOWVIA_BOOTSTRAP_TOKEN: BOOT, ...env } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, token) => {
    const response = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    const text = await response.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, text };
  };
  return { call, stop: () => new Promise(resolve => server.close(resolve)) };
}

const hospital = (id, pincode, cashless, extra = {}) => ({ id, insurerId: null, tpaId: null, name: `Fictional Hospital ${id}`, address: '1 Fictional Road', city: 'Fictional City', pincode, lat: null, lng: null, cashless, sourceRef: 'synthetic_test', validFrom: null, validTo: null, ...extra });

async function world(t, env = { HOLDINGS_ENABLED: 'true' }) {
  const fresh = await freshDatabase(t);
  const a = await seedWorld(fresh.handle.pool, 'a');
  const b = await seedWorld(fresh.handle.pool, 'b');
  for (const w of [a, b]) {
    w.token = (await fresh.services.auth.issueSession({ adultUserId: w.adult })).token;
    w.holding = await fresh.services.policyHoldings.create({ householdId: w.household, adultId: w.adult, documentId: w.document, kind: 'retail_health', policyId: w.policy });
  }
  const { NetworkHospitalRepository } = await import('../src/backend/repositories/network-hospital-repository.js');
  await new NetworkHospitalRepository(fresh.db).upsertMany([
    hospital('h1', '990001', true), hospital('h2', '990001', false), hospital('h3', '990002', true),
    hospital('h-expired', '990001', true, { validTo: '2000-01-01' }),
  ]);
  const app = await startApp(fresh.db, env);
  t.after(() => app.stop());
  return { ...fresh, app, a, b };
}

test('hospitals route: seeded pincode returns cashless hospitals in the exact shape, never a UIN', opts, async t => {
  const w = await world(t);
  const r = await w.app.call(`/api/v1/holdings/${w.a.holding.id}/hospitals?pincode=990001`, w.a.token);
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.data), ['hospitals']);
  assert.deepEqual(r.data.hospitals.map(item => item.id), ['h1', 'h2'], 'cashless first, expired row hidden');
  assert.ok(r.data.hospitals.filter(item => item.cashless).length >= 1);
  assert.deepEqual(Object.keys(r.data.hospitals[0]).sort(), ['address', 'cashless', 'city', 'id', 'name', 'pincode']);
  assert.doesNotMatch(r.text, /uin/i);
  assert.deepEqual((await w.app.call(`/api/v1/holdings/${w.a.holding.id}/hospitals?pincode=999999`, w.a.token)).data, { hospitals: [] });
});

test('hospitals route: another household and a missing holding answer the same 404; no token is 401', opts, async t => {
  const w = await world(t);
  const cross = await w.app.call(`/api/v1/holdings/${w.a.holding.id}/hospitals?pincode=990001`, w.b.token);
  const missing = await w.app.call('/api/v1/holdings/hold-missing/hospitals?pincode=990001', w.a.token);
  assert.equal(cross.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(cross.data, missing.data);
  assert.equal(cross.data.error.code, 'HOLDING_NOT_FOUND');
  assert.equal((await w.app.call(`/api/v1/holdings/${w.a.holding.id}/hospitals?pincode=990001`)).status, 401);
});

test('hospitals route: pincode must be exactly 6 digits (coded 400)', opts, async t => {
  const w = await world(t);
  for (const q of ['', '?pincode=', '?pincode=99001', '?pincode=9900011', '?pincode=99000a', '?pincode=%20990001']) {
    const r = await w.app.call(`/api/v1/holdings/${w.a.holding.id}/hospitals${q}`, w.a.token);
    assert.equal(r.status, 400, q);
    assert.equal(r.data.error.code, 'HOSPITAL_PINCODE_INVALID');
  }
});

test('hospitals route: off unless HOLDINGS_ENABLED is exactly true (503 coded)', opts, async t => {
  const w = await world(t, {});
  const r = await w.app.call(`/api/v1/holdings/${w.a.holding.id}/hospitals?pincode=990001`, w.a.token);
  assert.equal(r.status, 503);
  assert.equal(r.data.error.code, 'HOLDINGS_DISABLED');
  const upper = await startApp(w.db, { HOLDINGS_ENABLED: 'TRUE' });
  t.after(() => upper.stop());
  assert.equal((await upper.call(`/api/v1/holdings/${w.a.holding.id}/hospitals?pincode=990001`, w.a.token)).status, 503);
});

test('network_hospitals holds no household column (public reference data)', opts, async t => {
  const { db } = await freshDatabase(t);
  const columns = (await db.many("SELECT column_name FROM information_schema.columns WHERE table_name = 'network_hospitals'")).map(row => row.column_name);
  assert.ok(columns.includes('pincode'));
  assert.equal(columns.filter(name => /household|member|adult|consent|case/.test(name)).length, 0);
  assert.equal((await db.one("SELECT count(*) AS n FROM pg_indexes WHERE indexname = 'network_hospitals_insurer_pincode_idx'")).n, 1);
});

test('sync job: pages the export through the client into the table; a second run changes nothing; disabled reference data is coded', opts, async t => {
  const fresh = await freshDatabase(t);
  const pages = [
    { hospitals: [hospital('s1', '990003', true), hospital('s2', '990003', false)], nextCursor: 'c1' },
    { hospitals: [hospital('s3', '990004', true)], nextCursor: null },
  ];
  const seen = [];
  const client = { read: async (endpoint, params) => { seen.push([endpoint, params]); return { data: pages[params.cursor === 'c1' ? 1 : 0], etag: null }; } };
  const env = { HOLDINGS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true' };
  const services = createBackendServices(fresh.db, { env, referenceClient: client });
  assert.deepEqual(await services.networkHospitals.importHospitals(), { written: 3 });
  assert.deepEqual(seen, [['hospitals.export', {}], ['hospitals.export', { cursor: 'c1' }]]);
  const n = async () => Number((await fresh.db.one('SELECT count(*) AS n FROM network_hospitals')).n);
  assert.equal(await n(), 3);
  await services.networkHospitals.importHospitals();
  assert.equal(await n(), 3, 'idempotent');
  const off = createBackendServices(fresh.db, { env: { HOLDINGS_ENABLED: 'true' }, referenceClient: client });
  await assert.rejects(off.networkHospitals.importHospitals(), { code: 'REFERENCE_DATA_DISABLED' });
  // Registered in the existing worker under reference.import (scope hospitals).
  const handlers = buildJobHandlers(services, env);
  await handlers['reference.import']({ job: { kind: 'reference.import', householdId: 'h', payload: { scope: 'hospitals' } } });
  assert.equal(await n(), 3);
});

test('client: hospitals.export validates the page and rejects a bad pincode and unknown cursor shapes', async () => {
  const body = { data: [{ id: 'x1', name: 'Fictional Hospital', city: 'Fictional City', pincode: '990001', cashless: true, source_ref: 'synthetic_test', address: '', insurer_id: null }], next_cursor: null };
  const urls = [];
  const make = payload => createInsuranceDataClient({
    env: { REFERENCE_DATA_ENABLED: 'true', REFERENCE_DATA_API_KEY: 'k'.repeat(16), REFERENCE_DATA_BASE_URL: 'http://127.0.0.1:1' },
    fetchImpl: async url => { urls.push(String(url)); return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }); },
  });
  const ok = await make(body).read('hospitals.export', {});
  assert.equal(ok.data.hospitals[0].pincode, '990001');
  assert.match(urls[0], /\/v1\/network-hospitals\/export\?limit=100$/);
  await assert.rejects(make({ data: [{ ...body.data[0], pincode: '9900' }] }).read('hospitals.export', {}), { code: 'REFERENCE_DATA_RESPONSE_INVALID' });
  await assert.rejects(make(body).read('hospitals.export', { cursor: 'bad cursor!' }), { code: 'REFERENCE_DATA_REQUEST_INVALID' });
});

test('seed:demo loads the 30 invented hospitals once; each demo pincode has a cashless hospital', opts, async t => {
  const { db } = await freshDatabase(t);
  const env = { DATA_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64'), DOCUMENT_ENCRYPTION_KEY_BASE64: randomBytes(32).toString('base64') };
  const first = await seedDemo(db, { env });
  assert.equal(first.hospitalCount, 30);
  const total = async () => Number((await db.one('SELECT count(*) AS n FROM network_hospitals')).n);
  assert.equal(await total(), 30);
  await seedDemo(db, { env });
  assert.equal(await total(), 30);
  for (const pincode of ['990001', '990002', '990003']) {
    assert.ok(Number((await db.one('SELECT count(*) AS n FROM network_hospitals WHERE pincode = ? AND cashless', [pincode])).n) >= 1, pincode);
  }
});
