import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresTestOptions } from './support/pg.mjs';
import { createBackendServices } from '../src/backend/services/index.js';
import { packCacheKey, signatureFor } from '../src/backend/services/reference-data-port.js';
import { HOLDER, fixture, startApp, scenario } from './support/read-back-harness.mjs';

const pgOptions = postgresTestOptions();

// Plan C4: GET /api/v1/cases/{caseId}/passages also returns `insurerPassages` from the pulled FSS pack pages cached for the holding's
// linked version. Separate list, same fail-closed filters, same gates. Synthetic data only.

const VERSION = 'ver_c4_a';
const OTHER_VERSION = 'ver_c4_b';
const SHA_PAGE = 'a'.repeat(64);
const SHA_OTHER = 'b'.repeat(64);
const ROOM = 'Room rent is limited to Rs. 5,000 per day for a single private room.';
const MASKED = 'Call 98765 43210 or write to claims@insurer.example about room rent for the plan.';
const IDENTITY = 'Policyholder name: Synthetic Person, room rent applies as stated.';
const SCHEDULE = 'Policy Schedule shows the room rent and the premium payable.';
const ENV = { HOLDINGS_ENABLED: 'true', REFERENCE_DATA_ENABLED: 'true' };

fixture.pages = [[
  { text: 'Room rent', tag: 'section-title' },
  { text: `Dear ${HOLDER}, the room rent for a private room is limited to Rs 7,000 per day.`, tag: 'paragraph' },
], [{ text: 'Ambulance', tag: 'section-title' }]];

const pack = (versionId, lines, sha = SHA_PAGE) => ({
  packVersion: 'f'.repeat(64), product: { productId: 'prod_c4' }, version: { versionId },
  documents: [{ documentId: `doc_${versionId}`, sha256: 'd'.repeat(64), pages: [{ pageNumber: 7, pageSha256: sha }] }],
  chunks: [{ id: `doc_${versionId}:p7:c0`, documentId: `doc_${versionId}`, pageNumber: 7, text: lines.join('\n') }],
});

async function world(t, { env = {}, link = true, read = true } = {}) {
  const app = await startApp(t, { env: { ...ENV, ...env } });
  const s = await scenario(app, { read });
  const services = createBackendServices(app.database, { env: { ...ENV, ...env } });
  const at = new Date().toISOString();
  const holdingId = `hold-${s.documentId}`.slice(0, 100);
  await app.database.run('DELETE FROM policy_holdings WHERE document_id = ?', [s.documentId]);
  await app.database.run(`INSERT INTO policy_holdings (id, household_id, document_id, kind, status, created_at, updated_at) VALUES (?, ?, ?, 'retail_health', 'insurer_pending', ?, ?)`, [holdingId, s.householdId, s.documentId, at, at]);
  const put = async (versionId, body) => services.referenceCache.put({ key: packCacheKey('pages', versionId), body, signature: signatureFor(body) });
  if (link) await services.fssHandoffs.link({ householdId: s.householdId, holdingId, productId: 'prod_c4', versionId: VERSION, matchedBy: 'uin', confidence: 'high' });
  const get = (query = 'room rent', { token = s.token, caseId = s.caseId } = {}) => app.call(`/api/v1/cases/${caseId}/passages?q=${encodeURIComponent(query)}`, { token });
  return { app, s, services, holdingId, put, get };
}

test('C4: a linked version gives labelled insurer passages with page and page_sha256, in their own list', pgOptions, async t => {
  const w = await world(t);
  await w.put(VERSION, pack(VERSION, [ROOM, 'Ambulance charges are paid up to the stated limit.']));
  const res = await w.get();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.insurerPassages.length, 1);
  const [one] = res.data.insurerPassages;
  assert.deepEqual(Object.keys(one), ['chunkId', 'versionId', 'documentId', 'page', 'pageSha256', 'source', 'label', 'snippet']);
  assert.equal(one.source, 'insurer_wording');
  assert.equal(one.label, "From the insurer's wording, not checked");
  assert.equal(one.page, 7);
  assert.equal(one.pageSha256, SHA_PAGE);
  assert.equal(one.versionId, VERSION);
  assert.ok(one.snippet.length <= 280 && /room rent/i.test(one.snippet));
  assert.ok(res.data.passages.length >= 1 && res.data.passages.every(p => !JSON.stringify(p).includes('insurer_wording')), 'own passages are not mixed');
  assert.ok(res.data.passages.every(p => Object.keys(p).join() === 'clauseId,documentId,page,kind,title,snippet'), 'own passage shape unchanged');
  assert.deepEqual(w.app.modelCalls, []);
});

test('C4: no link gives an empty insurer list, no cache row gives an empty list, and own passages are unchanged', pgOptions, async t => {
  const none = await world(t, { link: false });
  await none.put(VERSION, pack(VERSION, [ROOM]));
  const a = await none.get();
  assert.equal(a.status, 200);
  assert.deepEqual(a.data.insurerPassages, []);
  assert.ok(a.data.passages.length >= 1);
  const noCache = await world(t);
  const b = await noCache.get();
  assert.equal(b.status, 200);
  assert.deepEqual(b.data.insurerPassages, []);
  assert.deepEqual(b.data.passages.map(p => p.snippet), a.data.passages.map(p => p.snippet), 'own passages do not depend on the insurer list');
  assert.ok(b.data.passages.length >= 1);
});

test('C4: another version rows are never returned, and a row whose body names another version or whose signature is wrong is dropped', pgOptions, async t => {
  const w = await world(t);
  await w.put(OTHER_VERSION, pack(OTHER_VERSION, ['Other version wording: room rent is limited to Rs. 1 per day for nobody.'], SHA_OTHER));
  assert.deepEqual((await w.get()).data.insurerPassages, []);
  // A row stored under the linked key but holding another version body is dropped.
  await w.put(VERSION, pack(OTHER_VERSION, [ROOM], SHA_OTHER));
  assert.deepEqual((await w.get()).data.insurerPassages, []);
  // A tampered body (signature mismatch) is dropped.
  const body = pack(VERSION, [ROOM]);
  await w.services.referenceCache.put({ key: packCacheKey('pages', VERSION), body, signature: 'not-the-signature' });
  assert.deepEqual((await w.get()).data.insurerPassages, []);
  await w.put(VERSION, pack(VERSION, [ROOM]));
  const ok = await w.get();
  assert.equal(ok.data.insurerPassages.length, 1);
  assert.ok(!JSON.stringify(ok.data).includes('Other version'));
});

test('C4: masking and the fail-closed filters apply to insurer passages', pgOptions, async t => {
  const w = await world(t);
  await w.put(VERSION, pack(VERSION, [MASKED, IDENTITY, SCHEDULE, ROOM]));
  const res = await w.get();
  const text = res.data.insurerPassages.map(p => p.snippet).join(' | ');
  assert.ok(!text.includes('98765'), text);
  assert.ok(!text.includes('claims@insurer.example'), text);
  assert.ok(!text.includes('Synthetic Person'), 'an identity-labelled line is dropped');
  assert.ok(!/Policy Schedule/i.test(text), 'a schedule line is dropped');
  assert.ok(text.includes('[hidden]'), text);
  assert.ok(res.data.insurerPassages.some(p => p.snippet.includes('Rs. 5,000')), text);
  const long = await world(t);
  await long.put(VERSION, pack(VERSION, [`room rent ${'wording '.repeat(100)}`]));
  const capped = await long.get();
  assert.ok(capped.data.insurerPassages[0].snippet.length <= 280);
});

test('C4: another household gets the same 404 as the existing route, a flag off gives 503, and an unlinked or erased case gives no insurer wording', pgOptions, async t => {
  const w = await world(t);
  await w.put(VERSION, pack(VERSION, [ROOM]));
  const stranger = await scenario(w.app, { name: 'Other', read: false });
  const foreign = await w.get('room rent', { token: stranger.token });
  const missing = await w.get('room rent', { token: stranger.token, caseId: 'case-does-not-exist' });
  assert.equal(foreign.status, missing.status);
  assert.ok([403, 404].includes(foreign.status), String(foreign.status));
  assert.ok(!JSON.stringify(foreign.data).includes('insurer_wording'));
  // Unlinking (what erasure and a 404 re-pull do) empties the list at once; the public cache row may remain.
  await w.services.fssHandoffs.unlink({ householdId: w.s.householdId, holdingId: w.holdingId });
  const after = await w.get();
  assert.equal(after.status, 200);
  assert.deepEqual(after.data.insurerPassages, []);
  assert.ok(after.data.passages.length >= 1);
  assert.ok((await w.services.referenceCache.get(packCacheKey('pages', VERSION))), 'the cache is public and not household data');

  const off = await world(t, { env: { DOCUMENT_READBACK_ENABLED: 'false' } });
  await off.put(VERSION, pack(VERSION, [ROOM]));
  const res = await off.get();
  assert.equal(res.status, 503);
  assert.equal(res.data.error.code, 'READBACK_DISABLED');
  assert.ok(!JSON.stringify(res.data).includes('insurer_wording'));
});

test('C4: chat v0 cites insurer wording as its own tier, after the household sources, and says it is not checked', pgOptions, async t => {
  const w = await world(t, { env: { CHAT_ENABLED: 'true', APP_EVENTS_ENABLED: 'false' } });
  await w.put(VERSION, pack(VERSION, [ROOM]));
  const ask = () => w.app.call(`/api/v1/households/${w.s.householdId}/chat`, { method: 'POST', token: w.s.token, body: { message: 'What is the room rent limit?' } });
  const res = await ask();
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const tiers = res.data.sources.map(source => source.tier);
  assert.ok(tiers.includes('household_evidence') && tiers.includes('insurer_wording'), JSON.stringify(tiers));
  assert.ok(tiers.lastIndexOf('household_evidence') < tiers.indexOf('insurer_wording'), 'own sources come first, never interleaved');
  const insurer = res.data.sources.find(source => source.tier === 'insurer_wording');
  assert.equal(insurer.label, "From the insurer's wording, not checked");
  assert.equal(insurer.page, 7);
  assert.equal(insurer.pageSha256, SHA_PAGE);
  assert.ok(res.data.reply.includes("From the insurer's wording, not checked"));
  await w.services.fssHandoffs.unlink({ householdId: w.s.householdId, holdingId: w.holdingId });
  assert.ok(!(await ask()).data.sources.some(source => source.tier === 'insurer_wording'));
});

test('C4: revoking the reading grant erases the holding and its link, so the insurer list and chat insurer sources are empty', pgOptions, async t => {
  const w = await world(t, { env: { CHAT_ENABLED: 'true', APP_EVENTS_ENABLED: 'false' } });
  await w.put(VERSION, pack(VERSION, [ROOM]));
  assert.equal((await w.get()).data.insurerPassages.length, 1);
  const revoked = await w.app.call(`/api/v1/consents/${w.s.readingGrantId}/revoke`, { method: 'POST', token: w.s.token, body: { reason: 'test' } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  assert.equal(await w.services.fssHandoffs.linkFor(w.holdingId), null, 'the link goes with the holding');
  const after = await w.get();
  assert.equal(after.status, 200);
  assert.deepEqual(after.data.insurerPassages, []);
  const chat = await w.app.call(`/api/v1/households/${w.s.householdId}/chat`, { method: 'POST', token: w.s.token, body: { message: 'What is the room rent limit?' } });
  assert.ok(!chat.data.sources.some(source => source.tier === 'insurer_wording'), JSON.stringify(chat.data.sources));
});

test('C4: chat v0 with only insurer wording never calls it wording from your documents and gives no pageRef', pgOptions, async t => {
  // The own document is not read yet (no reading grant), so only the linked plan's public wording can match.
  const w = await world(t, { env: { CHAT_ENABLED: 'true', APP_EVENTS_ENABLED: 'false' }, read: false });
  await w.put(VERSION, pack(VERSION, [ROOM]));
  const res = await w.app.call(`/api/v1/households/${w.s.householdId}/chat`, { method: 'POST', token: w.s.token, body: { message: 'What is the room rent limit?' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.answerStatus, 'evidence_found');
  assert.deepEqual(res.data.sources.map(source => source.tier), ['insurer_wording']);
  assert.ok(res.data.reply.startsWith('This was not found in your documents.'), res.data.reply);
  assert.ok(!res.data.reply.includes('wording read from your documents'), res.data.reply);
  assert.ok(res.data.reply.includes('not read from your documents'), res.data.reply);
  assert.equal(res.data.pageRef, undefined);
});
