import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { startApp, scenario, fixture, uploadDocument, grantReading, readDocument } from './support/read-back-harness.mjs';
import { createBackendServices } from '../src/backend/services/index.js';

// A document linked to a holding (its terms and conditions) contributes its facts to that holding through collate: both orders, duplicate
// delivery, disagreement -> conflicting with both sources, a confirmed fact kept, provider off, other household, unlink, revocation.
// Synthetic data only. Needs TEST_DATABASE_URL.

const opts = postgresTestOptions();
const ON = { POLICY_FACTS_ENABLED: 'true', HOLDINGS_ENABLED: 'true' };
const page = lines => lines.map(text => ({ text, tag: 'paragraph' }));
const schedulePages = (copay = '10%') => [page(['Acme Health Insurance Company Limited', 'Sum Insured: Rs. 5,00,000/-', `Co-payment: ${copay}`]), page(['Schedule of benefits'])];
const wordingPages = ({ ped = '36 months', copay = null } = {}) => [page(['Policy wording']), page([`Waiting Period for Pre-existing Diseases: ${ped}`, ...(copay ? [`Co-payment: ${copay}`] : [])])];
const n = async (app, sql, params = []) => Number((await app.database.one(sql, params)).n);
const REFERENCE_COPAY_10 = { async forHolding() { return [{ factKey: 'copay_percent', refId: 'ref-syn-copay', origin: 'reference', value: { bp: 1000 }, quote: 'A co-payment of 10% applies.', cacheKey: 'product:syn', version: 'v1' }]; } };

async function world(t, { copay = '10%', wording = wordingPages(), readWording = true, env = ON, referenceFacts } = {}) {
  fixture.pages = schedulePages(copay);
  const app = await startApp(t, { env });
  const s = await scenario(app, { name: 'One' });
  fixture.pages = wording;
  const wordingId = await uploadDocument(app, s, { kind: 'policy_wording' });
  if (readWording) await readDocument(app, s, wordingId, await grantReading(app, s, wordingId));
  const services = createBackendServices(app.database, { env: { ...app.env, ...env }, ...(referenceFacts ? { referenceFacts } : {}) });
  const schedule = ((await app.call(`/api/v1/households/${s.householdId}/holdings`, { token: s.token })).data.holdings).find(item => item.documentId === s.documentId);
  const link = (documentId = wordingId, token = s.token) => app.call(`/api/v1/holdings/${schedule.id}/documents`, { method: 'POST', token, body: { documentId, kind: 'wording' } });
  const unlink = (documentId = wordingId, token = s.token) => app.call(`/api/v1/holdings/${schedule.id}/documents/${documentId}`, { method: 'DELETE', token });
  const facts = async (token = s.token) => (await app.call(`/api/v1/holdings/${schedule.id}/facts`, { token }));
  const fact = async key => (await facts()).data.facts.find(item => item.factKey === key);
  const holdingId = schedule.id;
  const collate = () => services.holdings.collate({ householdId: s.householdId, holdingId });
  // The owner confirmed the product; the schedule is read and collated (the holding is then parsed).
  const prime = async () => {
    const sourceVersion = (await app.database.one('SELECT source_version FROM document_uploads WHERE id = ?', [s.documentId])).source_version;
    await services.policyProfiles.confirm({ householdId: s.householdId, documentId: s.documentId, adultUserId: s.adultId, idempotencyKey: 'confirm-key-0001',
      statement: Object.freeze({ uin: 'ACMHLIP25001V012526', insurerName: 'Acme Health Insurance Company Limited', policyName: 'Acme Health Shield Plus', expectedVersion: 0 }) });
    const profile = await services.policyProfiles.get({ householdId: s.householdId, documentId: s.documentId, sourceVersion });
    await services.policyHoldings.link({ householdId: s.householdId, adultId: s.adultId, holdingId, policyProfileId: profile.id });
    await services.policyHoldings.setStatus({ householdId: s.householdId, adultId: s.adultId, holdingId, status: 'product_reported' });
    await services.holdings.parseOwnPdf({ householdId: s.householdId, holdingId });
    await collate();
  };
  const queuedCollate = () => n(app, "SELECT count(*) AS n FROM job_queue WHERE kind = 'holding.collate' AND status = 'queued' AND payload_json LIKE ?", [`%${holdingId}%`]);
  return { app, s, wordingId, services, holdingId, link, unlink, facts, fact, collate, prime, queuedCollate };
}

test('structure then link: the wording facts join the holding, still extracted_unverified, source names the document kind', opts, async t => {
  const w = await world(t);
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  assert.equal(await w.fact('waiting_ped'), undefined, 'not linked yet: schedule facts only');
  assert.equal((await w.link()).status, 200);
  assert.ok(await w.queuedCollate() >= 1, 'the link queued a collate');
  await w.collate();
  const ped = await w.fact('waiting_ped');
  assert.equal(ped.status, 'extracted_unverified');
  assert.equal(ped.sources[0].page.documentKind, 'policy_wording');
  assert.ok(Number.isInteger(ped.sources[0].page.blockIndex) || ped.sources[0].page.blockIndex === null);
  assert.equal((await w.fact('sum_insured')).sources[0].page.documentKind, 'policy_schedule');
  const row = await w.app.database.one("SELECT source_document_id FROM household_memory_facts WHERE holding_id = ? AND fact_key = 'waiting_ped' AND superseded_at IS NULL", [w.holdingId]);
  assert.equal(row.source_document_id, w.wordingId);
  assert.deepEqual((await w.app.call(`/api/v1/holdings/${w.holdingId}/documents`, { token: w.s.token })).data.documents, [{ documentId: w.wordingId, kind: 'wording', factsState: 'included' }]);
});

test('link then structure: the stored extraction of a linked document queues the holding collate (once, however often delivered)', opts, async t => {
  const w = await world(t, { readWording: false });
  await w.prime();
  assert.equal((await w.link()).status, 200);
  assert.equal(await w.fact('waiting_ped'), undefined);
  assert.equal((await w.app.call(`/api/v1/holdings/${w.holdingId}/documents`, { token: w.s.token })).data.documents[0].factsState, 'none');
  await w.app.database.run("DELETE FROM job_queue WHERE kind = 'holding.collate'");
  // The wording is read later; its extraction finishes after the link.
  await readDocument(w.app, w.s, w.wordingId, await grantReading(w.app, w.s, w.wordingId));
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  assert.equal(await w.queuedCollate(), 1);
  // Duplicate delivery of the extraction job: no second collate job, no second row.
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  assert.equal(await w.queuedCollate(), 1);
  await w.collate();
  const before = await n(w.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE holding_id = ?', [w.holdingId]);
  await w.collate();
  assert.equal(await n(w.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE holding_id = ?', [w.holdingId]), before, 'a repeat collate writes nothing');
  assert.equal((await w.fact('waiting_ped')).status, 'extracted_unverified');
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM household_memory_facts WHERE holding_id = ? AND fact_key = 'waiting_ped' AND superseded_at IS NULL", [w.holdingId]), 1);
});

test('duplicate link delivery queues one collate job', opts, async t => {
  const w = await world(t);
  await w.prime();
  await w.app.database.run("DELETE FROM job_queue WHERE kind = 'holding.collate'");
  await w.link(); await w.link();
  assert.equal(await w.queuedCollate(), 1);
});

test('schedule and wording disagree: conflicting with both values and both sources (document kind and page); nothing silently overwritten', opts, async t => {
  const w = await world(t, { copay: '20%', wording: wordingPages({ copay: '10%' }) });
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  assert.equal((await w.fact('copay_percent')).status, 'extracted_unverified');
  await w.link();
  await w.collate();
  const copay = await w.fact('copay_percent');
  assert.equal(copay.status, 'conflicting');
  assert.equal(copay.value, null);
  assert.deepEqual(copay.alternatives.map(item => item.bp).sort(), [1000, 2000]);
  const kinds = copay.sources.filter(source => source.page).map(source => source.page.documentKind).sort();
  assert.ok(kinds.includes('policy_schedule') && kinds.includes('policy_wording'), JSON.stringify(kinds));
  for (const source of copay.sources.filter(source => source.page)) assert.ok(source.page.pageId);
  assert.ok(copay.sources.some(source => source.value?.bp === 2000) && copay.sources.some(source => source.value?.bp === 1000));
  // The waiting period only the wording states is unaffected.
  assert.equal((await w.fact('waiting_ped')).status, 'extracted_unverified');
});

test('a confirmed fact is never overwritten: the owner chose the schedule value, then a wording that agrees leaves it user_confirmed', opts, async t => {
  const w = await world(t, { copay: '20%', wording: wordingPages({ copay: '20%' }), referenceFacts: REFERENCE_COPAY_10 });
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  const conflict = await w.app.database.one("SELECT * FROM memory_conflicts WHERE holding_id = ? AND fact_key = 'copay_percent'", [w.holdingId]);
  assert.ok(conflict);
  const holding = await w.services.holdingPipelineRepository.getHolding({ householdId: w.s.householdId, holdingId: w.holdingId });
  const own = await w.app.database.one("SELECT id FROM household_memory_facts WHERE holding_id = ? AND fact_key = 'copay_percent' AND source_tier = 'own_pdf' AND superseded_at IS NULL", [w.holdingId]);
  await w.services.holdingPipelineRepository.resolveConflict({ holding, conflictId: conflict.id, chosenFactId: own.id, alternativeIndex: 0, adultId: w.s.adultId });
  assert.equal((await w.fact('copay_percent')).status, 'user_confirmed');
  await w.link();
  await w.collate();
  const after = await w.fact('copay_percent');
  assert.equal(after.status, 'user_confirmed');
  assert.deepEqual(after.value, { bp: 2000 });
  assert.equal((await w.app.database.one('SELECT resolution FROM memory_conflicts WHERE id = ?', [conflict.id])).resolution, 'user_chose');
});

test('a wording that differs from a confirmed fact: the confirmed row and the resolved conflict stay as they are; the slot reads conflicting again (existing collate rule)', opts, async t => {
  const w = await world(t, { copay: '20%', wording: wordingPages({ copay: '30%' }), referenceFacts: REFERENCE_COPAY_10 });
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  const conflict = await w.app.database.one("SELECT * FROM memory_conflicts WHERE holding_id = ? AND fact_key = 'copay_percent'", [w.holdingId]);
  const holding = await w.services.holdingPipelineRepository.getHolding({ householdId: w.s.householdId, holdingId: w.holdingId });
  const own = await w.app.database.one("SELECT id FROM household_memory_facts WHERE holding_id = ? AND fact_key = 'copay_percent' AND source_tier = 'own_pdf' AND superseded_at IS NULL", [w.holdingId]);
  const { resolvingFactId } = await w.services.holdingPipelineRepository.resolveConflict({ holding, conflictId: conflict.id, chosenFactId: own.id, alternativeIndex: 0, adultId: w.s.adultId });
  await w.link();
  await w.collate();
  const declaration = await w.app.database.one('SELECT status, superseded_at FROM household_memory_facts WHERE id = ?', [resolvingFactId]);
  assert.equal(declaration.status, 'user_confirmed');
  assert.equal(declaration.superseded_at, null);
  assert.equal((await w.app.database.one('SELECT resolution FROM memory_conflicts WHERE id = ?', [conflict.id])).resolution, 'user_chose');
  assert.equal((await w.fact('copay_percent')).status, 'conflicting');
});

test('policy facts off: a linked document adds no facts, no error, and its state says so', opts, async t => {
  const w = await world(t, { env: { POLICY_FACTS_ENABLED: 'false', HOLDINGS_ENABLED: 'true' } });
  await w.prime();
  assert.equal((await w.link()).status, 200);
  const result = await w.collate();
  assert.ok(result.status);
  assert.equal((await w.app.call(`/api/v1/holdings/${w.holdingId}/documents`, { token: w.s.token })).data.documents[0].factsState, 'off');
  assert.equal((await w.facts()).status, 200);
  assert.equal(await w.fact('waiting_ped'), undefined, 'no wording fact while fact reading is off');
  assert.equal((await w.unlink()).status, 200);
});

test('another household cannot link a document into a holding, read its facts or unlink', opts, async t => {
  const w = await world(t);
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  const other = await scenario(w.app, { name: 'Other', read: false });
  assert.equal((await w.link(w.wordingId, other.token)).status, 404);
  assert.equal((await w.facts(other.token)).status, 404);
  await w.link();
  assert.equal((await w.unlink(w.wordingId, other.token)).status, 404);
  // A foreign document id cannot be linked by the owner either.
  assert.equal((await w.link(other.documentId)).status, 404);
  await w.collate();
  assert.equal((await w.fact('waiting_ped')).status, 'extracted_unverified');
  assert.equal(await n(w.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ?', [other.householdId]), 0);
});

test('unlink removes the facts read only from that document, keeps the rest, and the schedule-cited value returns', opts, async t => {
  const w = await world(t, { copay: '20%', wording: wordingPages({ copay: '10%' }) });
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  await w.link();
  await w.collate();
  assert.equal((await w.fact('waiting_ped')).status, 'extracted_unverified');
  assert.equal((await w.fact('copay_percent')).status, 'conflicting');
  const unlinked = await w.unlink();
  assert.equal(unlinked.status, 200, JSON.stringify(unlinked.data));
  assert.equal(unlinked.data.unlinked, true);
  assert.equal(await w.fact('waiting_ped'), undefined, 'wording-only fact gone');
  const copay = await w.fact('copay_percent');
  assert.equal(copay.status, 'extracted_unverified');
  assert.deepEqual(copay.value, { bp: 2000 });
  assert.equal((await w.fact('sum_insured')).status, 'extracted_unverified');
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM household_memory_facts WHERE holding_id = ? AND source_document_id = ? AND superseded_at IS NULL", [w.holdingId, w.wordingId]), 0);
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM memory_conflicts WHERE holding_id = ? AND resolution = 'pending'", [w.holdingId]), 0);
});

test('revocation erases the facts derived from a linked document too', opts, async t => {
  const w = await world(t, { copay: '20%', wording: wordingPages({ copay: '10%' }) });
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  await w.link();
  await w.collate();
  assert.ok(await n(w.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE holding_id = ?', [w.holdingId]) > 0);
  await w.services.consents.revoke({ grantId: w.s.processingGrantId, revokedByAdultId: w.s.adultId, reason: 'test' });
  assert.equal(await n(w.app, 'SELECT count(*) AS n FROM household_memory_facts WHERE household_id = ?', [w.s.householdId]), 0);
  assert.equal(await n(w.app, 'SELECT count(*) AS n FROM memory_conflicts WHERE household_id = ?', [w.s.householdId]), 0);
});

test('erasing only the linked document removes the own-PDF rows that carry its value', opts, async t => {
  const w = await world(t, { copay: '20%', wording: wordingPages({ copay: '10%' }) });
  await w.services.policyFacts.extract({ householdId: w.s.householdId, documentId: w.wordingId });
  await w.prime();
  await w.link();
  await w.collate();
  const { eraseMemoryForDocuments } = await import('../src/backend/repositories/memory-erasure.js');
  await w.app.database.transaction(() => eraseMemoryForDocuments(w.app.database, { householdId: w.s.householdId, documentIds: [w.wordingId] }));
  assert.equal(await n(w.app, "SELECT count(*) AS n FROM household_memory_facts WHERE holding_id = ? AND source_tier = 'own_pdf'", [w.holdingId]), 0);
});
