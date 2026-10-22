// Operator-signed check and publish (ADR 0010): a caller-supplied checker id is never sufficient, signatures bind the exact
// submission, facts and source digests, and each action applies at most once inside its validity window. Synthetic only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { generateCheckerKeyPair, readCuratedAction, sha256Hex, signCuratedAction } from '../src/features/decision-catalogue/index.js';
import { checkerKeyring } from './support/curated-keys.mjs';
import { inProcessPdfText, sourcePdf } from './support/curated-text.mjs';

const UIN = 'SYNTHHLIP26003V012526';
const PAGES = [`Synthetic Plan\nUIN: ${UIN}\nWording version v1`, 'Room rent is limited to Rs 4,000 per day for a single private room.'];
const BYTES = await sourcePdf(PAGES);
const FACT = { factType: 'room_rent_limit', topic: 'general', value: { kind: 'amount', amountMinor: 400000, currency: 'INR', basis: 'per_day' }, page: 2, quote: 'Room rent is limited to Rs 4,000 per day' };

async function world(t) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-signed-'));
  const database = openDatabase({ path: join(directory, 'app.sqlite') });
  let now = new Date('2026-10-20T10:00:00.000Z');
  const services = createBackendServices(database, { clock: () => now, env: { CURATED_SOURCE_HOSTS: 'insurer.example' }, pdfText: inProcessPdfText });
  const adult = name => services.households.createAdult({ displayName: `Synthetic ${name}` }).id;
  const people = { curator: adult('curator'), checker: adult('checker'), other: adult('other checker') };
  const repo = services.curatedProducts;
  const keys = checkerKeyring();
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const grant = (adultUserId, publicKey = keys.publicKey(adultUserId)) => repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt, publicKey });
  repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt });
  const grants = { checker: grant(people.checker), other: grant(people.other) };
  const id = (await repo.register({
    curatorId: people.curator, uin: UIN, insurer: 'Synthetic Insurer', productName: 'Synthetic Plan', wordingVersion: 'v1',
    sourceUrl: 'https://insurer.example/plan.pdf', sourceVersionId: 'rev-1', retrievedOn: '2026-10-15', bytes: BYTES, pageTexts: PAGES,
  })).submissionId;
  repo.proposeFacts({ curatorId: people.curator, submissionId: id, facts: [FACT] });
  const factsSha256 = sha256Hex(database.prepare('SELECT facts_json FROM curated_product_submissions WHERE id = ?').get(id).facts_json);
  const attest = { submissionId: id, observedSha256: sha256Hex(BYTES), factsSha256 };
  const signCheck = (who = people.checker, over = {}, options = {}) => keys.sign('check', who, { ...attest, decision: 'accept', reasonCode: 'quote_matches_source', quotesReviewed: true, ...over }, { now, ...options });
  const signPublish = (who = people.checker, over = {}, options = {}) => keys.sign('publish', who, { ...attest, ...over }, { now, ...options });
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    database, repo, people, keys, grant, grants, id, attest, signCheck, signPublish,
    setNow: value => { now = new Date(value); }, state: () => database.prepare('SELECT state FROM curated_product_submissions WHERE id = ?').get(id).state,
    refusals: () => database.prepare("SELECT event_payload_json AS payload_json FROM audit_events WHERE action = 'curated_source.signed_action_refused' ORDER BY rowid").all().map(row => JSON.parse(row.payload_json).reason),
  };
}
const code = fn => { try { fn(); } catch (error) { return error.code; } return assert.fail('expected an error'); };

test('a checker id alone, or signed by any other key, never checks or publishes', async t => {
  const w = await world(t);
  const forged = signCuratedAction({ privateKeyPem: generateCheckerKeyPair().privateKeyPem, action: 'check', checkerId: w.people.checker, ...w.attest, decision: 'accept', reasonCode: 'quote_matches_source', quotesReviewed: true, now: new Date('2026-10-20T10:00:00.000Z') });
  assert.equal(code(() => w.repo.check({ signedAction: forged })), 'SOURCE_ACTION_SIGNATURE_INVALID', 'a fresh key claiming the checker id');
  // The other checker's real key, claiming to be the first checker.
  const borrowed = w.signCheck(w.people.checker, {}, { privateKeyPem: w.keys.key(w.people.other).privateKeyPem });
  assert.equal(code(() => w.repo.check({ signedAction: borrowed })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  for (const bare of [undefined, null, {}, { checkerId: w.people.checker, ...w.attest }, { payload: '{}', signature: '' }]) {
    assert.equal(code(() => w.repo.check({ signedAction: bare })), 'SOURCE_ACTION_MALFORMED');
    assert.equal(code(() => w.repo.publish({ signedAction: bare })), 'SOURCE_ACTION_MALFORMED');
  }
  // A curator, or an adult with no role, cannot act even with a valid signature of their own.
  assert.equal(code(() => w.repo.check({ signedAction: w.signCheck(w.people.curator) })), 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal(w.state(), 'candidate');
  assert.deepEqual(w.refusals(), ['SOURCE_ACTION_SIGNATURE_INVALID', 'SOURCE_ACTION_SIGNATURE_INVALID', 'SOURCE_ROLE_NOT_AUTHORISED'], 'refused signed actions are audited after rollback');
});

test('the signature covers every field: an edited payload, a reordered payload or a swapped action fails', async t => {
  const w = await world(t);
  const good = w.signCheck();
  const edit = (mutate) => { const payload = JSON.parse(good.payload); mutate(payload); return { payload: JSON.stringify(payload), signature: good.signature }; };
  assert.equal(code(() => w.repo.check({ signedAction: edit(p => { p.decision = 'reject'; p.reasonCode = 'other'; }) })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  assert.equal(code(() => w.repo.check({ signedAction: edit(p => { p.factsSha256 = 'f'.repeat(64); }) })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  assert.equal(code(() => w.repo.check({ signedAction: edit(p => { p.expiresAt = '2026-10-20T10:09:00.000Z'; }) })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  const reordered = JSON.parse(good.payload);
  const { v, ...rest } = reordered;
  assert.equal(code(() => w.repo.check({ signedAction: { payload: JSON.stringify({ ...rest, v }), signature: good.signature } })), 'SOURCE_ACTION_MALFORMED');
  assert.equal(code(() => w.repo.check({ signedAction: { payload: `${good.payload} `, signature: good.signature } })), 'SOURCE_ACTION_MALFORMED', 'whitespace is not canonical');
  assert.equal(code(() => w.repo.publish({ signedAction: good })), 'SOURCE_ACTION_MALFORMED', 'a signed check is not a publish');
  assert.throws(() => w.signCheck(w.people.checker, {}, { validityMs: 11 * 60_000 }), /validity window/);
  assert.equal(w.repo.check({ signedAction: good }).state, 'checked');
});

test('replay: an applied action, or a new signature reusing its nonce, is refused; a refused action does not burn its nonce', async t => {
  const w = await world(t);
  const mismatch = w.signCheck(w.people.checker, { observedSha256: 'b'.repeat(64) }, { nonce: 'a'.repeat(32) });
  assert.equal(code(() => w.repo.check({ signedAction: mismatch })), 'SOURCE_DIGEST_MISMATCH');
  const sameNonce = w.signCheck(w.people.checker, {}, { nonce: 'a'.repeat(32) });
  assert.equal(w.repo.check({ signedAction: sameNonce }).state, 'checked', 'the nonce of a refused action is still free');
  assert.equal(code(() => w.repo.check({ signedAction: sameNonce })), 'SOURCE_ACTION_REPLAYED');
  const publish = w.signPublish(w.people.other, {}, { nonce: 'a'.repeat(32) });
  assert.equal(code(() => w.repo.publish({ signedAction: publish })), 'SOURCE_ACTION_REPLAYED', 'nonces are global, across actions and signers');
  const good = w.signPublish(w.people.other);
  assert.equal(w.repo.publish({ signedAction: good }).state, 'published');
  assert.equal(code(() => w.repo.publish({ signedAction: good })), 'SOURCE_ACTION_REPLAYED');
  const nonces = w.database.prepare('SELECT action, grant_id FROM curated_action_nonces ORDER BY used_at, action').all();
  assert.deepEqual(nonces.map(row => row.action).sort(), ['check', 'publish']);
  assert.throws(() => w.database.prepare('DELETE FROM curated_action_nonces').run(), /never deleted/);
  assert.throws(() => w.database.prepare("UPDATE curated_action_nonces SET action = 'check'").run(), /immutable/);
});

test('expiry: an action past its window, or dated in the future beyond the skew allowance, is refused', async t => {
  const w = await world(t);
  const signed = w.signCheck();
  w.setNow('2026-10-20T10:05:00.001Z');
  assert.equal(code(() => w.repo.check({ signedAction: signed })), 'SOURCE_ACTION_EXPIRED');
  const future = w.signCheck(w.people.checker, {}, { now: new Date('2026-10-20T10:07:00.000Z') });
  w.setNow('2026-10-20T10:05:30.000Z');
  assert.equal(code(() => w.repo.check({ signedAction: future })), 'SOURCE_ACTION_EXPIRED', 'issued 90 s ahead of the verifier clock');
  const nearFuture = w.signCheck(w.people.checker, {}, { now: new Date('2026-10-20T10:06:00.000Z') });
  assert.equal(w.repo.check({ signedAction: nearFuture }).state, 'checked', 'within the 60 s skew allowance');
});

test('revocation, grant expiry and key rotation stop an action that was signed while the grant was live', async t => {
  const w = await world(t);
  const signed = w.signCheck();
  w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal(code(() => w.repo.check({ signedAction: signed })), 'SOURCE_ROLE_NOT_AUTHORISED');
  w.keys.rotate(w.people.checker);
  w.grant(w.people.checker);
  assert.equal(code(() => w.repo.check({ signedAction: signed })), 'SOURCE_ACTION_SIGNATURE_INVALID', 'a regrant with a new key retires the old one');
  assert.equal(w.repo.check({ signedAction: w.signCheck() }).state, 'checked');
  const publish = w.signPublish(w.people.other);
  w.setNow('2026-11-20T10:00:00.000Z');
  assert.equal(code(() => w.repo.publish({ signedAction: publish })), 'SOURCE_ROLE_NOT_AUTHORISED', 'expired grant');
  assert.equal(w.state(), 'checked');
});

test('publication attests the exact facts and source, keeps collector and checker apart, and invalidation withdraws it', async t => {
  const w = await world(t);
  w.repo.check({ signedAction: w.signCheck() });
  assert.equal(code(() => w.repo.publish({ signedAction: w.signPublish(w.people.other, { factsSha256: 'e'.repeat(64) }) })), 'FACTS_CHANGED');
  assert.equal(code(() => w.repo.publish({ signedAction: w.signPublish(w.people.other, { observedSha256: 'c'.repeat(64) }) })), 'SOURCE_DIGEST_MISMATCH');
  w.grant(w.people.curator);
  assert.equal(code(() => w.repo.publish({ signedAction: w.signPublish(w.people.curator) })), 'SELF_REVIEW_REFUSED');
  assert.equal(w.repo.listVerified().length, 0);
  const published = w.repo.publish({ signedAction: w.signPublish(w.people.other) });
  assert.equal(published.state, 'published');
  assert.equal(published.checkedBy, w.people.checker, 'the checker of record is the signer of the check');
  assert.equal(w.repo.listVerified().length, 1);
  const audit = w.database.prepare("SELECT event_payload_json AS payload_json FROM audit_events WHERE action = 'curated_source.published'").get();
  assert.match(JSON.parse(audit.payload_json).keyFingerprint, /^[0-9a-f]{16}$/);
  assert.equal(w.repo.invalidate({ submissionId: w.id, operatorId: 'test-operator', reasonCode: 'checker_compromised' }).state, 'needs_revalidation');
  assert.equal(w.repo.listVerified().length, 0);
});

test('a checker grant needs a valid Ed25519 key, in the repository and in the database', async t => {
  const w = await world(t);
  const fresh = w.database.prepare("SELECT id FROM adult_users WHERE id NOT IN (SELECT adult_user_id FROM source_curator_grants) LIMIT 1").get();
  const adultUserId = fresh?.id ?? w.people.other;
  const expiresAt = '2026-10-30T00:00:00.000Z';
  for (const publicKey of [null, '', 'not-base64!!', Buffer.from('x'.repeat(44)).toString('base64'), generateCheckerKeyPair().publicKey.replace(/.$/, 'A')]) {
    assert.equal(code(() => w.repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt, publicKey })), 'CURATED_PRODUCT_INVALID');
  }
  assert.throws(() => w.database.prepare("UPDATE source_curator_grants SET public_key = NULL WHERE id = ?").run(w.grants.checker.id), /needs a public key/);
  assert.throws(() => w.database.prepare("INSERT INTO source_curator_grants (id, adult_user_id, role, status, granted_by, created_at, expires_at) VALUES ('scg-raw', ?, 'checker', 'active', 'operator:raw', ?, ?)").run(w.people.curator, expiresAt, expiresAt), /needs a public key/);
  // A legacy checker row without a key (written before migration 019) can be revoked but cannot be reactivated or act.
  w.database.exec('DROP TRIGGER source_curator_grants_checker_key_update');
  w.database.prepare('UPDATE source_curator_grants SET public_key = NULL WHERE id = ?').run(w.grants.checker.id);
  assert.equal(code(() => w.repo.check({ signedAction: w.signCheck() })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  assert.ok(readCuratedAction(w.signCheck()), 'the envelope itself is well formed');
});

test('read-only product records: only the signed, published product carries values; the contract holds no adult or household field', async t => {
  const { assertVerifiedProductRecordsContract } = await import('../src/features/decision-catalogue/index.js');
  const w = await world(t);
  const before = w.repo.productRecords({ today: '2026-10-20' });
  assertVerifiedProductRecordsContract(before);
  assert.equal(before.records[0].state, 'unverified');
  assert.equal(before.records[0].facts[0].value, null);
  w.repo.check({ signedAction: w.signCheck() });
  w.repo.publish({ signedAction: w.signPublish(w.people.other) });
  const after = w.repo.productRecords({ today: '2026-10-20' });
  assertVerifiedProductRecordsContract(after);
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].state, 'verified');
  assert.deepEqual(after.records[0].facts[0].value, FACT.value);
  assert.equal(after.records[0].facts[0].citation.quote, FACT.quote);
  assert.equal(after.records[0].facts[0].citation.page, 2);
  const text = JSON.stringify(after);
  for (const id of Object.values(w.people)) assert.ok(!text.includes(id), 'no adult id leaves the repository');
  assert.equal(w.repo.productRecords({ today: '2027-12-01' }).records[0].state, 'stale', 'a stale source keeps its citation but loses its value');
  w.repo.invalidate({ submissionId: w.id, operatorId: 'test-operator', reasonCode: 'review_found_wrong' });
  assert.equal(w.repo.productRecords({ today: '2026-10-20' }).records[0].state, 'stale', 'needs_revalidation reads as stale, never verified');
});
