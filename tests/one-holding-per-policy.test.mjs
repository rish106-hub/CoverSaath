import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture, uploadDocument, grantReading, readDocument } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';

// One policy is one holding (P0 milestone): a wording linked to a holding never leaves a second, standalone holding behind, in either
// order and under duplicate delivery; an owner-acted-on standalone holding is never removed; the holdings read carries a deterministic
// `summary`; fact sources name the document kind. Synthetic data only. Needs TEST_DATABASE_URL.

const opts = postgresTestOptions();
const ON = { POLICY_FACTS_ENABLED: 'true', HOLDINGS_ENABLED: 'true' };
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const SCHEDULE = [page(['Acme Health Insurance Company Limited', 'Sum Insured: Rs. 5,00,000/-', 'Premium: Rs. 12,000/-']), page(['Schedule of benefits'])];
const WORDING = [page(['Policy wording']), page(['Cosmetic surgery is excluded from cover under this policy.'])];
const n = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);
const vector = `[${new Array(1024).fill(0).join(',')}]`;

async function world(t, { readWording = true } = {}) {
  fixture.pages = SCHEDULE;
  const app = await startApp(t, { env: ON });
  const s = await scenario(app, { name: 'One' });
  fixture.pages = WORDING;
  const wordingId = await uploadDocument(app, s, { kind: 'policy_wording' });
  if (readWording) await readDocument(app, s, wordingId, await grantReading(app, s, wordingId));
  const services = createBackendServices(app.database, { env: { ...app.env, ...ON } });
  const list = async (token = s.token, householdId = s.householdId) => (await app.call(`/api/v1/households/${householdId}/holdings`, { token })).data;
  const link = (holdingId, documentId, token = s.token) => app.call(`/api/v1/holdings/${holdingId}/documents`, { method: 'POST', token, body: { documentId, kind: 'wording' } });
  return { app, s, wordingId, services, list, link };
}

test('link after the wording own holding exists: one holding, its derived data erased, queued jobs gone', opts, async t => {
  const { app, s, wordingId, list, link } = await world(t);
  const before = (await list()).holdings;
  assert.equal(before.length, 2);
  const schedule = before.find(item => item.documentId === s.documentId);
  const standalone = before.find(item => item.documentId === wordingId);
  // Derived data hanging off the standalone holding must go with it.
  await app.database.run(`INSERT INTO memory_chunks (id, household_id, holding_id, scope, source_ref, chunk_text_enc, content_sha256, embedding, embedding_model, source_document_id, consent_grant_id, created_at)
    VALUES ('chunk-x', ?, ?, 'own_pdf', 'x:1', 'enc2.x', ?, CAST(? AS extensions.vector), 'm', ?, ?, ?)`,
  [s.householdId, standalone.id, 'a'.repeat(64), vector, wordingId, s.processingGrantId, new Date().toISOString()]);
  assert.ok(await n(app, "SELECT count(*) AS n FROM job_queue WHERE document_id = ? AND kind LIKE 'holding.%' AND status = 'queued'", [wordingId]) >= 1);

  const linked = await link(schedule.id, wordingId);
  assert.equal(linked.status, 200, JSON.stringify(linked.data));
  assert.equal(linked.data.linked, true);
  const after = (await list()).holdings;
  assert.deepEqual(after.map(item => item.id), [schedule.id]);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM policy_holdings WHERE id = ?', [standalone.id]), 0);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM memory_chunks WHERE holding_id = ?', [standalone.id]), 0, 'derived data erased');
  assert.equal(await n(app, "SELECT count(*) AS n FROM job_queue WHERE document_id = ? AND kind LIKE 'holding.%' AND status = 'queued'", [wordingId]), 0);
  assert.equal(await n(app, "SELECT count(*) AS n FROM audit_events WHERE action = 'holding.absorbed' AND resource_id = ?", [standalone.id]), 1);
  assert.deepEqual((await app.call(`/api/v1/holdings/${schedule.id}/documents`, { token: s.token })).data.documents, [{ documentId: wordingId, kind: 'wording' }]);

  // Duplicate delivery: idempotent, still one holding.
  const again = await link(schedule.id, wordingId);
  assert.equal(again.status, 200);
  assert.equal(again.data.linked, false);
  assert.equal((await list()).holdings.length, 1);
});

test('link before the wording own holding is created (late create job, OCR after link): still one holding', opts, async t => {
  const { app, s, wordingId, services, list, link } = await world(t, { readWording: false });
  const [schedule] = (await list()).holdings;
  assert.equal((await list()).holdings.length, 1, 'wording not OCRd yet: no holding of its own');
  assert.equal((await link(schedule.id, wordingId)).status, 200);
  await readDocument(app, s, wordingId, await grantReading(app, s, wordingId));
  assert.equal((await list()).holdings.length, 1, 'OCR of a linked document creates no holding');
  assert.equal(await n(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.detect_insurer' AND document_id = ?", [wordingId]), 0);
  // The F4 retry job (ensureHoldingForDocument) is a no-op for a linked document, however often it is delivered.
  assert.equal(await services.ensureHoldingForDocument({ householdId: s.householdId, documentId: wordingId }), null);
  assert.equal(await services.ensureHoldingForDocument({ householdId: s.householdId, documentId: wordingId }), null);
  const data = await list();
  assert.equal(data.holdings.length, 1);
  assert.deepEqual(data.creation_issues, []);
});

test('an acted-on standalone holding is not removed: coded 409, nothing changes', opts, async t => {
  const { app, s, wordingId, list, link } = await world(t);
  const holdings = (await list()).holdings;
  const schedule = holdings.find(item => item.documentId === s.documentId);
  const standalone = holdings.find(item => item.documentId === wordingId);
  await app.database.run("UPDATE policy_holdings SET status = 'product_reported' WHERE id = ?", [standalone.id]);
  const refused = await link(schedule.id, wordingId);
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error?.code ?? refused.data.code, 'HOLDING_DOCUMENT_HAS_HOLDING', JSON.stringify(refused.data));
  assert.equal((await list()).holdings.length, 2);
  assert.equal(await n(app, 'SELECT count(*) AS n FROM holding_documents'), 0);
});

test('a standalone holding with an owner chat thread is acted on too', opts, async t => {
  const { app, s, wordingId, list, link } = await world(t);
  const holdings = (await list()).holdings;
  const standalone = holdings.find(item => item.documentId === wordingId);
  await app.database.run('INSERT INTO chat_threads (id, household_id, holding_id, created_by_adult_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ['thread-x', s.householdId, standalone.id, s.adultId, new Date().toISOString(), new Date().toISOString()]);
  assert.equal((await link(holdings.find(item => item.documentId === s.documentId).id, wordingId)).status, 409);
  assert.equal((await list()).holdings.length, 2);
});

test('another household cannot link, absorb or see', opts, async t => {
  const { app, s, wordingId, list, link } = await world(t);
  fixture.pages = SCHEDULE;
  const other = await scenario(app, { name: 'Other' });
  const mine = (await list()).holdings;
  const schedule = mine.find(item => item.documentId === s.documentId);
  // Other household's owner against my holding and my document.
  assert.equal((await link(schedule.id, wordingId, other.token)).status, 404);
  const theirs = (await list(other.token, other.householdId)).holdings;
  assert.equal((await link(theirs[0].id, wordingId, other.token)).status, 404, 'a foreign document answers 404');
  assert.equal((await app.call(`/api/v1/households/${s.householdId}/holdings`, { token: other.token })).status, 404);
  assert.equal((await list()).holdings.length, 2, 'nothing was absorbed');
});

test('summary: names null until confirmed, headline facts filled after, no UIN; fact sources name the document kind', opts, async t => {
  const { app, s, wordingId, services, list, link } = await world(t);
  const [first] = (await list()).holdings;
  const schedule = (await list()).holdings.find(item => item.documentId === s.documentId);
  assert.ok(first);
  assert.deepEqual(schedule.summary, { insurerName: null, productName: null, sumInsured: null, policyPeriod: null, premium: null });

  // The owner confirms the product (policy profile in state reported), then the pipeline reads and collates the schedule.
  const UIN = 'ACMHLIP25001V012526';
  await services.policyProfiles.confirm({ householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, idempotencyKey: 'confirm-key-0001',
    statement: Object.freeze({ uin: UIN, insurerName: 'Acme Health Insurance Company Limited', policyName: 'Acme Health Shield Plus', expectedVersion: 0 }) });
  const sourceVersion = (await app.database.one('SELECT source_version FROM document_uploads WHERE id = ?', [s.documentId])).source_version;
  const profile = await services.policyProfiles.get({ householdId: s.householdId, documentId: s.documentId, sourceVersion });
  await services.policyHoldings.link({ householdId: s.householdId, adultId: s.adultId, holdingId: schedule.id, policyProfileId: profile.id });
  await services.policyHoldings.setStatus({ householdId: s.householdId, adultId: s.adultId, holdingId: schedule.id, status: 'product_reported' });
  await services.holdings.parseOwnPdf({ householdId: s.householdId, holdingId: schedule.id });
  await services.holdings.collate({ householdId: s.householdId, holdingId: schedule.id });

  const one = (await app.call(`/api/v1/households/${s.householdId}/holdings/${schedule.id}`, { token: s.token })).data;
  assert.equal(one.summary.insurerName, 'Acme Health Insurance Company Limited');
  assert.equal(one.summary.productName, 'Acme Health Shield Plus');
  assert.equal(one.summary.sumInsured.factKey, 'sum_insured');
  assert.equal(one.summary.sumInsured.status, 'extracted_unverified');
  assert.ok(one.summary.sumInsured.value);
  assert.ok(['extracted_unverified', 'conflicting', 'unknown'].includes(one.summary.sumInsured.status));
  assert.ok(!JSON.stringify(one).includes(UIN), 'the UIN never appears');
  const listed = (await list()).holdings.find(item => item.id === schedule.id);
  assert.deepEqual(listed.summary, one.summary);

  // Fact sources carry the document kind next to the page; the wording is reachable through the one holding after linking.
  assert.equal((await link(schedule.id, wordingId)).status, 200);
  const facts = (await app.call(`/api/v1/holdings/${schedule.id}/facts`, { token: s.token })).data;
  const sources = facts.facts.flatMap(fact => fact.sources).filter(source => source.page);
  assert.ok(sources.length >= 1);
  for (const source of sources) assert.equal(source.page.documentKind, 'policy_schedule');
  assert.deepEqual((await app.call(`/api/v1/holdings/${schedule.id}/documents`, { token: s.token })).data.documents, [{ documentId: wordingId, kind: 'wording' }]);
});

test('revocation erasure still removes holdings and linked wording chunks', opts, async t => {
  const { app, s, wordingId, list, link } = await world(t);
  const schedule = (await list()).holdings.find(item => item.documentId === s.documentId);
  assert.equal((await link(schedule.id, wordingId)).status, 200);
  await app.database.run(`INSERT INTO memory_chunks (id, household_id, holding_id, scope, source_ref, chunk_text_enc, content_sha256, embedding, embedding_model, source_document_id, consent_grant_id, created_at)
    VALUES ('chunk-y', ?, ?, 'own_pdf', 'y:1', 'enc2.y', ?, CAST(? AS extensions.vector), 'm', ?, ?, ?)`,
  [s.householdId, schedule.id, 'b'.repeat(64), vector, wordingId, s.processingGrantId, new Date().toISOString()]);
  const { eraseMemoryForDocuments } = await import('../src/backend/repositories/memory-erasure.js');
  await app.database.transaction(() => eraseMemoryForDocuments(app.database, { householdId: s.householdId, documentIds: [wordingId] }));
  assert.equal(await n(app, 'SELECT count(*) AS n FROM memory_chunks WHERE source_document_id = ?', [wordingId]), 0);
});
