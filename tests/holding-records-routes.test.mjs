import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { createApiServer } from '../src/server/server.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { at, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { eraseMemoryForHousehold } from '../src/backend/repositories/memory-erasure.js';

// Declarations and premiums over HTTP (migrations 051-052, ADR 0032) and the holding that an OCR completion creates. Synthetic data
// only. Needs PostgreSQL (TEST_DATABASE_URL).

const opts = postgresTestOptions();
const BOOT = 'coversaath-test-bootstrap-token-0018';
const MARK = 'Quillberry-marker';

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

test('records routes: off unless HOLDINGS_ENABLED is exactly true (503 coded), 401 without a token', opts, async t => {
  const off = await world(t, {});
  const w = off.a;
  for (const [method, path, body] of [['GET', 'declarations'], ['POST', 'declarations', {}], ['GET', 'premiums'], ['POST', 'premiums', {}], ['GET', 'premium-dues']]) {
    const r = await off.app.call(`/api/v1/households/${w.household}/${path}`, { method, token: w.token, body });
    assert.equal(r.status, 503, `${method} ${path}`);
    assert.equal(r.data.error.code, 'HOLDINGS_DISABLED');
  }
  const garbage = await startApp(off.db, { HOLDINGS_ENABLED: 'TRUE' });
  t.after(() => garbage.stop());
  assert.equal((await garbage.call(`/api/v1/households/${w.household}/premiums`, { token: w.token })).status, 503);
  const on = await startApp(off.db, { HOLDINGS_ENABLED: 'true' });
  t.after(() => on.stop());
  assert.equal((await on.call(`/api/v1/households/${w.household}/premiums`)).status, 401);
  assert.equal((await on.call(`/api/v1/households/${w.household}/premiums`, { token: w.token })).status, 200);
});

test('declarations: create, list, update, delete; sealed label; ownership; validation; consent', opts, async t => {
  const { app, a, b, db, count } = await world(t);
  const path = `/api/v1/households/${a.household}/declarations`;
  const created = await app.call(path, { method: 'POST', token: a.token, body: { memberId: a.member, kind: 'pre_existing_disease', label: `${MARK} hypertension`, declaredOn: '2024-05-01', declaredToInsurer: true, holdingId: a.holding.id } });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.label, `${MARK} hypertension`);
  assert.equal(created.data.kind, 'pre_existing_disease');
  assert.equal(created.data.holdingId, a.holding.id);
  // The label is sealed at rest and never in an audit payload.
  const raw = JSON.stringify(await db.one('SELECT * FROM member_declarations WHERE id = ?', [created.data.id]));
  assert.equal(raw.includes(MARK), false);
  const audits = JSON.stringify(await db.many('SELECT event_payload_json FROM audit_events'));
  assert.equal(audits.includes(MARK), false);

  const list = await app.call(path, { token: a.token });
  assert.equal(list.status, 200);
  assert.deepEqual(list.data.declarations.map(item => item.id), [created.data.id]);
  assert.equal((await app.call(`${path}?memberId=${a.member}`, { token: a.token })).data.declarations.length, 1);

  // Ownership: another household's adult gets the same 404 on every verb; a foreign member or holding is also 404.
  for (const [method, p, body] of [['GET', path], ['POST', path, { memberId: a.member, kind: 'habit', label: 'x' }], ['PUT', `${path}/${created.data.id}`, { label: 'y' }], ['DELETE', `${path}/${created.data.id}`]]) {
    const r = await app.call(p, { method, token: b.token, body });
    assert.equal(r.status, 404, `${method} foreign household`);
    assert.equal(r.data.error.code, 'HOUSEHOLD_NOT_FOUND');
  }
  const ownPathForeignRow = await app.call(`/api/v1/households/${b.household}/declarations/${created.data.id}`, { method: 'DELETE', token: b.token });
  assert.equal(ownPathForeignRow.status, 404);
  assert.equal(ownPathForeignRow.data.error.code, 'DECLARATION_NOT_FOUND');
  const foreignMember = await app.call(path, { method: 'POST', token: a.token, body: { memberId: b.member, kind: 'habit', label: 'x' } });
  assert.equal(foreignMember.status, 404);
  assert.equal(foreignMember.data.error.code, 'MEMBER_NOT_FOUND');
  const foreignHolding = await app.call(path, { method: 'POST', token: a.token, body: { memberId: a.member, kind: 'habit', label: 'x', holdingId: b.holding.id } });
  assert.equal(foreignHolding.status, 404);
  assert.equal(await count('member_declarations'), 1);

  // Validation at the boundary: coded 400, nothing stored.
  for (const body of [
    { memberId: a.member, kind: 'nope', label: 'x' }, { memberId: a.member, kind: 'habit', label: '' }, { memberId: a.member, kind: 'habit' },
    { kind: 'habit', label: 'x' }, { memberId: a.member, kind: 'habit', label: 'x', extra: 1 }, { memberId: a.member, kind: 'habit', label: 'x', declaredOn: '2024-13-45' },
    { memberId: a.member, kind: 'habit', label: 'x', declaredToInsurer: 'yes' }, { memberId: '../x', kind: 'habit', label: 'x' },
  ]) {
    const r = await app.call(path, { method: 'POST', token: a.token, body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.data.error.code, 'INVALID_REQUEST');
  }
  assert.equal(await count('member_declarations'), 1);
  // No profile_intake grant: coded 403, nothing stored.
  await db.run(`UPDATE consent_grants SET revoked_at = ? WHERE id = ?`, [at, a.profileGrant]);
  const noGrant = await app.call(path, { method: 'POST', token: a.token, body: { memberId: a.member, kind: 'habit', label: 'x' } });
  assert.equal(noGrant.status, 403);
  assert.equal(noGrant.data.error.code, 'CONSENT_REQUIRED');
  await db.run(`UPDATE consent_grants SET revoked_at = NULL WHERE id = ?`, [a.profileGrant]);

  const updated = await app.call(`${path}/${created.data.id}`, { method: 'PUT', token: a.token, body: { label: `${MARK} changed`, ifMatch: 1 } });
  assert.equal(updated.status, 200, updated.text);
  assert.equal(updated.data.revision, 2);
  assert.equal((await app.call(`${path}/${created.data.id}`, { method: 'PUT', token: a.token, body: { label: 'z', ifMatch: 1 } })).data.error.code, 'REVISION_CONFLICT');
  assert.equal((await app.call(`${path}/${created.data.id}`, { method: 'DELETE', token: a.token })).status, 200);
  assert.equal(await count('member_declarations'), 0);
  assert.equal((await app.call(`${path}/${created.data.id}`, { method: 'DELETE', token: a.token })).data.error.code, 'DECLARATION_NOT_FOUND');
});

test('premiums and dues: record, list, settle, delete; sealed amounts; ownership; validation; erasure removes the rows', opts, async t => {
  const { app, a, b, db, count } = await world(t);
  const path = `/api/v1/households/${a.household}/premiums`;
  const pay = { holdingId: a.holding.id, amountPaise: 1_234_567, paidOn: '2026-01-15', channel: 'upi', paidVia: 'agent', agentName: `${MARK} agent`, agentCode: 'AG-7' };
  const created = await app.call(path, { method: 'POST', token: a.token, body: pay });
  assert.equal(created.status, 201, created.text);
  assert.equal(created.data.amountPaise, 1_234_567);
  assert.equal(created.data.agentName, `${MARK} agent`);
  const raw = JSON.stringify(await db.one('SELECT * FROM premium_payments WHERE id = ?', [created.data.id]));
  assert.equal(raw.includes('1234567'), false);
  assert.equal(raw.includes(MARK), false);
  assert.equal(JSON.stringify(await db.many('SELECT event_payload_json FROM audit_events')).includes(MARK), false);
  // Defaults match the BFF contract: channel unknown, paidVia self.
  const minimal = await app.call(path, { method: 'POST', token: a.token, body: { holdingId: a.holding.id, amountPaise: 5000, paidOn: '2026-02-15' } });
  assert.equal(minimal.status, 201);
  assert.equal(minimal.data.channel, 'unknown');
  assert.equal(minimal.data.paidVia, 'self');
  assert.equal(minimal.data.agentName, null);
  assert.equal((await app.call(path, { token: a.token })).data.premiums.length, 2);
  assert.equal((await app.call(`${path}?holdingId=${a.holding.id}`, { token: a.token })).data.premiums.length, 2);

  // Ownership.
  assert.equal((await app.call(path, { token: b.token })).status, 404);
  assert.equal((await app.call(path, { method: 'POST', token: b.token, body: pay })).data.error.code, 'HOUSEHOLD_NOT_FOUND');
  const foreignHolding = await app.call(path, { method: 'POST', token: a.token, body: { ...pay, holdingId: b.holding.id } });
  assert.equal(foreignHolding.status, 404);
  assert.equal(foreignHolding.data.error.code, 'HOLDING_NOT_FOUND');
  assert.equal((await app.call(`/api/v1/households/${b.household}/premiums/${created.data.id}`, { method: 'DELETE', token: b.token })).data.error.code, 'PREMIUM_NOT_FOUND');

  // Validation: coded 400, nothing stored.
  for (const body of [
    { ...pay, amountPaise: 0 }, { ...pay, amountPaise: 12.5 }, { ...pay, amountPaise: '100' }, { ...pay, paidOn: '15/01/2026' }, { ...pay, channel: 'barter' },
    { ...pay, paidVia: 'self' }, { ...pay, extra: true }, { ...pay, holdingId: undefined }, { ...pay, agentName: 'x'.repeat(121) },
  ]) {
    const r = await app.call(path, { method: 'POST', token: a.token, body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(r.data.error.code, 'INVALID_REQUEST');
  }
  assert.equal(await count('premium_payments'), 2);

  // Dues.
  const dues = `/api/v1/households/${a.household}/premium-dues`;
  const due = await app.call(dues, { method: 'POST', token: a.token, body: { holdingId: a.holding.id, dueOn: '2026-03-01', amountPaise: 90_000 } });
  assert.equal(due.status, 201, due.text);
  assert.equal(due.data.state, 'expected');
  assert.equal((await app.call(dues, { method: 'POST', token: a.token, body: { holdingId: a.holding.id, dueOn: '2026-03-01', amountPaise: 90_000 } })).data.id, due.data.id, 'one due per holding and day');
  assert.equal((await app.call(`${dues}?state=bogus`, { token: a.token })).status, 400);
  const settled = await app.call(`${dues}/${due.data.id}/pay`, { method: 'POST', token: a.token, body: { paymentId: created.data.id } });
  assert.equal(settled.status, 200, settled.text);
  assert.equal(settled.data.state, 'paid');
  assert.equal((await app.call(`${dues}?state=paid`, { token: a.token })).data.dues.length, 1);
  assert.equal((await app.call(`${dues}/${due.data.id}/pay`, { method: 'POST', token: b.token, body: { paymentId: created.data.id } })).status, 404);

  assert.equal((await app.call(`${path}/${minimal.data.id}`, { method: 'DELETE', token: a.token })).status, 200);
  assert.equal(await count('premium_payments'), 1);

  // Erasure still removes what the routes wrote, and only for that household.
  const bPay = await app.call(`/api/v1/households/${b.household}/premiums`, { method: 'POST', token: b.token, body: { holdingId: b.holding.id, amountPaise: 700, paidOn: '2026-01-01' } });
  assert.equal(bPay.status, 201);
  await app.call(`/api/v1/households/${a.household}/declarations`, { method: 'POST', token: a.token, body: { memberId: a.member, kind: 'habit', label: 'x' } });
  await eraseMemoryForHousehold(db, { householdId: a.household });
  assert.equal(await count('premium_payments', 'household_id = ?', [a.household]), 0);
  assert.equal(await count('premium_dues', 'household_id = ?', [a.household]), 0);
  assert.equal(await count('member_declarations', 'household_id = ?', [a.household]), 0);
  assert.equal(await count('premium_payments', 'household_id = ?', [b.household]), 1);
});

// ---- Holding creation when OCR completes (complete.md 3.2 step 1) -------------------------------------------------------------

const sha = character => character.repeat(64);
async function addDocument(pool, w, id, kind = 'policy_wording') {
  await insert(pool, 'document_uploads', { id, household_id: w.household, case_id: w.case, uploaded_by_adult_id: w.adult, consent_grant_id: w.consent, document_kind: kind, content_sha256: createHash('sha256').update(id).digest('hex') });
}
const jobFor = (documentId, id, grant) => ({
  id, documentUploadId: documentId, provider: 'fixture', status: 'processing', contractVersion: 'knowvia.ocr.v1',
  authorization: { authorized: true, consentGrantId: grant, purpose: 'document_processing' }, requestedAt: at, updatedAt: at,
});
const pagesFor = documentId => [{
  documentUploadId: documentId, pageNumber: 1, sourceVersion: 'v1', textSha256: sha('c'), text: 'Synthetic page text', extractionStatus: 'extracted',
  confidenceBasisPoints: 9000, createdAt: at, outputContractVersion: 'knowvia.ocr.v1', providerPageRef: 'ref:1', provenance: { fixture: true }, blocks: null,
}];
const done = { status: 'succeeded', resultDigest: sha('d'), completedAt: at, updatedAt: at };

async function completeOcr(services, documentId, jobId, grant) {
  await services.ocr.createOrGetJob(jobFor(documentId, jobId, grant));
  return services.ocr.completeJob(jobId, pagesFor(documentId), done);
}

test('OCR completion: policy document gets one holding and one detect job; retry adds nothing; flag off adds nothing', opts, async t => {
  const fresh = await freshDatabase(t);
  const { handle, db } = fresh;
  const a = await seedWorld(handle.pool, 'a');
  const on = createBackendServices(db, { env: { HOLDINGS_ENABLED: 'true' } });
  const off = createBackendServices(db, { env: {} });
  const counts = async () => ({
    holdings: Number((await db.one('SELECT count(*) AS c FROM policy_holdings')).c),
    jobs: Number((await db.one("SELECT count(*) AS c FROM job_queue WHERE kind = 'holding.detect_insurer'")).c),
  });

  // Flag off: the OCR result is stored and nothing else happens.
  await addDocument(handle.pool, a, 'doc-off');
  assert.equal((await completeOcr(off, 'doc-off', 'ocr-off', a.consent)).status, 'succeeded');
  assert.deepEqual(await counts(), { holdings: 0, jobs: 0 });

  // Flag on: one holding (uploaded) for the document and one identifiers-only detect job.
  await addDocument(handle.pool, a, 'doc-on');
  assert.equal((await completeOcr(on, 'doc-on', 'ocr-on', a.consent)).status, 'succeeded');
  assert.deepEqual(await counts(), { holdings: 1, jobs: 1 });
  const holding = await db.one('SELECT * FROM policy_holdings WHERE document_id = ?', ['doc-on']);
  assert.equal(holding.status, 'uploaded');
  assert.equal(holding.household_id, a.household);
  const job = await db.one("SELECT * FROM job_queue WHERE kind = 'holding.detect_insurer'");
  assert.equal(job.household_id, a.household);
  assert.equal(job.document_id, 'doc-on');
  assert.deepEqual(JSON.parse(job.payload_json), { holdingId: holding.id });
  assert.match(job.dedupe_key, /^[0-9a-f]{64}$/);

  // Retry of the same completion (replay) and a second OCR job over the same document: still one holding, one job.
  assert.equal((await on.ocr.completeJob('ocr-on', pagesFor('doc-on'), done)).status, 'succeeded');
  await on.ocr.createOrGetJob(jobFor('doc-on', 'ocr-on-2', a.consent));
  assert.deepEqual(await counts(), { holdings: 1, jobs: 1 });
  // The owner-side create for the same document returns the same holding.
  assert.equal((await on.policyHoldings.create({ householdId: a.household, adultId: a.adult, documentId: 'doc-on', kind: 'retail_health' })).id, holding.id);

  // A document that is not a policy document starts nothing.
  await addDocument(handle.pool, a, 'doc-med', 'medical_record');
  assert.equal((await completeOcr(on, 'doc-med', 'ocr-med', a.consent)).status, 'succeeded');
  assert.deepEqual(await counts(), { holdings: 1, jobs: 1 });
});
