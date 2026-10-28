// Operator-signed check and publish (ADR 0010): a caller-supplied checker id is never sufficient, signatures bind the exact
// submission, facts and source digests, and each action applies at most once inside its validity window. Synthetic only.
// Runs on PostgreSQL (S3.2): each test gets a fresh migrated database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { CuratedProductRepository } from '../src/backend/repositories/curated-product-repository.js';
import { generateCheckerKeyPair, readCuratedAction, sha256Hex, signCuratedAction } from '../src/features/decision-catalogue/index.js';
import { checkerKeyring } from './support/curated-keys.mjs';
import { inProcessPdfText, sourcePdf } from './support/curated-text.mjs';

const UIN = 'SYNTHHLIP26003V012526';
const PAGES = [`Synthetic Plan\nUIN: ${UIN}\nWording version v1`, 'Room rent is limited to Rs 4,000 per day for a single private room.'];
const BYTES = await sourcePdf(PAGES);
const FACT = { factType: 'room_rent_limit', topic: 'general', value: { kind: 'amount', amountMinor: 400000, currency: 'INR', basis: 'per_day' }, page: 2, quote: 'Room rent is limited to Rs 4,000 per day' };

async function syntheticAdult(db, name) {
  const id = `adult-${randomUUID()}`;
  const at = '2026-10-01T00:00:00.000Z';
  await db.run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)", [id, `Synthetic ${name}`, at, at]);
  return id;
}

async function world(t) {
  const { db } = await freshDatabase(t);
  let now = new Date('2026-10-20T10:00:00.000Z');
  const repo = new CuratedProductRepository(db, { clock: () => now, env: { CURATED_SOURCE_HOSTS: 'insurer.example' }, pdfText: inProcessPdfText });
  const people = { curator: await syntheticAdult(db, 'curator'), checker: await syntheticAdult(db, 'checker'), other: await syntheticAdult(db, 'other checker') };
  const keys = checkerKeyring();
  const expiresAt = new Date(now.getTime() + 30 * 86_400_000).toISOString();
  const grant = (adultUserId, publicKey = keys.publicKey(adultUserId)) => repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt, publicKey });
  await repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt });
  const grants = { checker: await grant(people.checker), other: await grant(people.other) };
  const id = (await repo.register({
    curatorId: people.curator, uin: UIN, insurer: 'Synthetic Insurer', productName: 'Synthetic Plan', wordingVersion: 'v1',
    sourceUrl: 'https://insurer.example/plan.pdf', sourceVersionId: 'rev-1', retrievedOn: '2026-10-15', bytes: BYTES, pageTexts: PAGES,
  })).submissionId;
  await repo.proposeFacts({ curatorId: people.curator, submissionId: id, facts: [FACT] });
  const factsSha256 = sha256Hex((await db.one('SELECT facts_json FROM curated_product_submissions WHERE id = ?', [id])).facts_json);
  const attest = { submissionId: id, observedSha256: sha256Hex(BYTES), factsSha256 };
  const signCheck = (who = people.checker, over = {}, options = {}) => keys.sign('check', who, { ...attest, decision: 'accept', reasonCode: 'quote_matches_source', quotesReviewed: true, ...over }, { now, ...options });
  const signPublish = (who = people.checker, over = {}, options = {}) => keys.sign('publish', who, { ...attest, ...over }, { now, ...options });
  return {
    database: db, repo, people, keys, grant, grants, id, attest, signCheck, signPublish,
    setNow: value => { now = new Date(value); }, state: async () => (await db.one('SELECT state FROM curated_product_submissions WHERE id = ?', [id])).state,
    refusals: async () => (await db.many("SELECT event_payload_json AS payload_json FROM audit_events WHERE action = 'curated_source.signed_action_refused' ORDER BY id")).map(row => JSON.parse(row.payload_json).reason),
  };
}
const code = async fn => { try { await fn(); } catch (error) { return error.code; } return assert.fail('expected an error'); };

// The NULL-household audit chain: every event's previous hash is the hash of the event before it, with no fork.
async function assertLinearChain(db) {
  const events = await db.many('SELECT previous_event_hash, event_hash FROM audit_events WHERE household_id IS NULL ORDER BY id');
  assert.ok(events.length > 0);
  assert.equal(events[0].previous_event_hash, null);
  for (let i = 1; i < events.length; i += 1) assert.equal(events[i].previous_event_hash, events[i - 1].event_hash, `audit event ${i} links to its predecessor`);
  assert.equal(new Set(events.map(event => event.previous_event_hash)).size, events.length, 'no two events share a predecessor');
}

test('a checker id alone, or signed by any other key, never checks or publishes', postgresTestOptions(), async t => {
  const w = await world(t);
  const forged = signCuratedAction({ privateKeyPem: generateCheckerKeyPair().privateKeyPem, action: 'check', checkerId: w.people.checker, ...w.attest, decision: 'accept', reasonCode: 'quote_matches_source', quotesReviewed: true, now: new Date('2026-10-20T10:00:00.000Z') });
  assert.equal(await code(() => w.repo.check({ signedAction: forged })), 'SOURCE_ACTION_SIGNATURE_INVALID', 'a fresh key claiming the checker id');
  // The other checker's real key, claiming to be the first checker.
  const borrowed = w.signCheck(w.people.checker, {}, { privateKeyPem: w.keys.key(w.people.other).privateKeyPem });
  assert.equal(await code(() => w.repo.check({ signedAction: borrowed })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  for (const bare of [undefined, null, {}, { checkerId: w.people.checker, ...w.attest }, { payload: '{}', signature: '' }]) {
    assert.equal(await code(() => w.repo.check({ signedAction: bare })), 'SOURCE_ACTION_MALFORMED');
    assert.equal(await code(() => w.repo.publish({ signedAction: bare })), 'SOURCE_ACTION_MALFORMED');
  }
  // A curator, or an adult with no role, cannot act even with a valid signature of their own.
  assert.equal(await code(() => w.repo.check({ signedAction: w.signCheck(w.people.curator) })), 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal(await w.state(), 'candidate');
  assert.deepEqual(await w.refusals(), ['SOURCE_ACTION_SIGNATURE_INVALID', 'SOURCE_ACTION_SIGNATURE_INVALID', 'SOURCE_ROLE_NOT_AUTHORISED'], 'refused signed actions are audited after rollback');
});

test('the signature covers every field: an edited payload, a reordered payload or a swapped action fails', postgresTestOptions(), async t => {
  const w = await world(t);
  const good = w.signCheck();
  const edit = (mutate) => { const payload = JSON.parse(good.payload); mutate(payload); return { payload: JSON.stringify(payload), signature: good.signature }; };
  assert.equal(await code(() => w.repo.check({ signedAction: edit(p => { p.decision = 'reject'; p.reasonCode = 'other'; }) })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  assert.equal(await code(() => w.repo.check({ signedAction: edit(p => { p.factsSha256 = 'f'.repeat(64); }) })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  assert.equal(await code(() => w.repo.check({ signedAction: edit(p => { p.expiresAt = '2026-10-20T10:09:00.000Z'; }) })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  const reordered = JSON.parse(good.payload);
  const { v, ...rest } = reordered;
  assert.equal(await code(() => w.repo.check({ signedAction: { payload: JSON.stringify({ ...rest, v }), signature: good.signature } })), 'SOURCE_ACTION_MALFORMED');
  assert.equal(await code(() => w.repo.check({ signedAction: { payload: `${good.payload} `, signature: good.signature } })), 'SOURCE_ACTION_MALFORMED', 'whitespace is not canonical');
  assert.equal(await code(() => w.repo.publish({ signedAction: good })), 'SOURCE_ACTION_MALFORMED', 'a signed check is not a publish');
  assert.throws(() => w.signCheck(w.people.checker, {}, { validityMs: 11 * 60_000 }), /validity window/);
  assert.equal((await w.repo.check({ signedAction: good })).state, 'checked');
});

test('replay: an applied action, or a new signature reusing its nonce, is refused; a refused action does not burn its nonce', postgresTestOptions(), async t => {
  const w = await world(t);
  const mismatch = w.signCheck(w.people.checker, { observedSha256: 'b'.repeat(64) }, { nonce: 'a'.repeat(32) });
  assert.equal(await code(() => w.repo.check({ signedAction: mismatch })), 'SOURCE_DIGEST_MISMATCH');
  const sameNonce = w.signCheck(w.people.checker, {}, { nonce: 'a'.repeat(32) });
  assert.equal((await w.repo.check({ signedAction: sameNonce })).state, 'checked', 'the nonce of a refused action is still free');
  assert.equal(await code(() => w.repo.check({ signedAction: sameNonce })), 'SOURCE_ACTION_REPLAYED');
  const publish = w.signPublish(w.people.other, {}, { nonce: 'a'.repeat(32) });
  assert.equal(await code(() => w.repo.publish({ signedAction: publish })), 'SOURCE_ACTION_REPLAYED', 'nonces are global, across actions and signers');
  const good = w.signPublish(w.people.other);
  assert.equal((await w.repo.publish({ signedAction: good })).state, 'published');
  assert.equal(await code(() => w.repo.publish({ signedAction: good })), 'SOURCE_ACTION_REPLAYED');
  const nonces = await w.database.many('SELECT action, grant_id FROM curated_action_nonces ORDER BY used_at, action');
  assert.deepEqual(nonces.map(row => row.action).sort(), ['check', 'publish']);
  await assert.rejects(w.database.run('DELETE FROM curated_action_nonces'), /never deleted/);
  await assert.rejects(w.database.run("UPDATE curated_action_nonces SET action = 'check'"), /immutable/);
});

test('expiry: an action past its window, or dated in the future beyond the skew allowance, is refused', postgresTestOptions(), async t => {
  const w = await world(t);
  const signed = w.signCheck();
  w.setNow('2026-10-20T10:05:00.001Z');
  assert.equal(await code(() => w.repo.check({ signedAction: signed })), 'SOURCE_ACTION_EXPIRED');
  const future = w.signCheck(w.people.checker, {}, { now: new Date('2026-10-20T10:07:00.000Z') });
  w.setNow('2026-10-20T10:05:30.000Z');
  assert.equal(await code(() => w.repo.check({ signedAction: future })), 'SOURCE_ACTION_EXPIRED', 'issued 90 s ahead of the verifier clock');
  const nearFuture = w.signCheck(w.people.checker, {}, { now: new Date('2026-10-20T10:06:00.000Z') });
  assert.equal((await w.repo.check({ signedAction: nearFuture })).state, 'checked', 'within the 60 s skew allowance');
});

test('revocation, grant expiry and key rotation stop an action that was signed while the grant was live', postgresTestOptions(), async t => {
  const w = await world(t);
  const signed = w.signCheck();
  assert.equal(await w.repo.revokeRole({ grantId: w.grants.checker.id }), true);
  assert.equal(await w.repo.revokeRole({ grantId: w.grants.checker.id }), false, 'a second revocation changes nothing');
  assert.equal(await code(() => w.repo.check({ signedAction: signed })), 'SOURCE_ROLE_NOT_AUTHORISED');
  w.keys.rotate(w.people.checker);
  await w.grant(w.people.checker);
  assert.equal(await code(() => w.repo.check({ signedAction: signed })), 'SOURCE_ACTION_SIGNATURE_INVALID', 'a regrant with a new key retires the old one');
  assert.equal((await w.repo.check({ signedAction: w.signCheck() })).state, 'checked');
  const publish = w.signPublish(w.people.other);
  w.setNow('2026-11-20T10:00:00.000Z');
  assert.equal(await code(() => w.repo.publish({ signedAction: publish })), 'SOURCE_ROLE_NOT_AUTHORISED', 'expired grant');
  assert.equal(await w.state(), 'checked');
});

test('publication attests the exact facts and source, keeps collector and checker apart, and invalidation withdraws it', postgresTestOptions(), async t => {
  const w = await world(t);
  await w.repo.check({ signedAction: w.signCheck() });
  assert.equal(await code(() => w.repo.publish({ signedAction: w.signPublish(w.people.other, { factsSha256: 'e'.repeat(64) }) })), 'FACTS_CHANGED');
  assert.equal(await code(() => w.repo.publish({ signedAction: w.signPublish(w.people.other, { observedSha256: 'c'.repeat(64) }) })), 'SOURCE_DIGEST_MISMATCH');
  await w.grant(w.people.curator);
  assert.equal(await code(() => w.repo.publish({ signedAction: w.signPublish(w.people.curator) })), 'SELF_REVIEW_REFUSED');
  assert.equal((await w.repo.listVerified()).length, 0);
  const published = await w.repo.publish({ signedAction: w.signPublish(w.people.other) });
  assert.equal(published.state, 'published');
  assert.equal(published.checkedBy, w.people.checker, 'the checker of record is the signer of the check');
  assert.equal((await w.repo.listVerified()).length, 1);
  const audit = await w.database.one("SELECT event_payload_json AS payload_json FROM audit_events WHERE action = 'curated_source.published'");
  assert.match(JSON.parse(audit.payload_json).keyFingerprint, /^[0-9a-f]{16}$/);
  assert.equal((await w.repo.invalidate({ submissionId: w.id, operatorId: 'test-operator', reasonCode: 'checker_compromised' })).state, 'needs_revalidation');
  assert.equal((await w.repo.listVerified()).length, 0);
});

test('a checker grant needs a valid Ed25519 key, in the repository and in the database', postgresTestOptions(), async t => {
  const w = await world(t);
  const fresh = await w.database.one('SELECT id FROM adult_users WHERE id NOT IN (SELECT adult_user_id FROM source_curator_grants) LIMIT 1');
  const adultUserId = fresh?.id ?? w.people.other;
  const expiresAt = '2026-10-30T00:00:00.000Z';
  for (const publicKey of [null, '', 'not-base64!!', Buffer.from('x'.repeat(44)).toString('base64'), generateCheckerKeyPair().publicKey.replace(/.$/, 'A')]) {
    assert.equal(await code(() => w.repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt, publicKey })), 'CURATED_PRODUCT_INVALID');
  }
  await assert.rejects(w.database.run('UPDATE source_curator_grants SET public_key = NULL WHERE id = ?', [w.grants.checker.id]), /needs a public key/);
  await assert.rejects(w.database.run("INSERT INTO source_curator_grants (id, adult_user_id, role, status, granted_by, created_at, expires_at) VALUES ('scg-raw', ?, 'checker', 'active', 'operator:raw', ?, ?)", [w.people.curator, expiresAt, expiresAt]), /needs a public key/);
  // A legacy checker row without a key (written before the key migration) can be revoked but cannot be reactivated or act.
  await w.database.run('DROP TRIGGER source_curator_grants_checker_key_update ON source_curator_grants');
  await w.database.run('UPDATE source_curator_grants SET public_key = NULL WHERE id = ?', [w.grants.checker.id]);
  assert.equal(await code(() => w.repo.check({ signedAction: w.signCheck() })), 'SOURCE_ACTION_SIGNATURE_INVALID');
  assert.ok(readCuratedAction(w.signCheck()), 'the envelope itself is well formed');
});

test('read-only product records: only the signed, published product carries values; the contract holds no adult or household field', postgresTestOptions(), async t => {
  const { assertVerifiedProductRecordsContract } = await import('../src/features/decision-catalogue/index.js');
  const w = await world(t);
  const before = await w.repo.productRecords({ today: '2026-10-20' });
  assertVerifiedProductRecordsContract(before);
  assert.equal(before.records[0].state, 'unverified');
  assert.equal(before.records[0].facts[0].value, null);
  await w.repo.check({ signedAction: w.signCheck() });
  await w.repo.publish({ signedAction: w.signPublish(w.people.other) });
  const after = await w.repo.productRecords({ today: '2026-10-20' });
  assertVerifiedProductRecordsContract(after);
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].state, 'verified');
  assert.deepEqual(after.records[0].facts[0].value, FACT.value);
  assert.equal(after.records[0].facts[0].citation.quote, FACT.quote);
  assert.equal(after.records[0].facts[0].citation.page, 2);
  const text = JSON.stringify(after);
  for (const id of Object.values(w.people)) assert.ok(!text.includes(id), 'no adult id leaves the repository');
  assert.equal((await w.repo.productRecords({ today: '2027-12-01' })).records[0].state, 'stale', 'a stale source keeps its citation but loses its value');
  await w.repo.invalidate({ submissionId: w.id, operatorId: 'test-operator', reasonCode: 'review_found_wrong' });
  assert.equal((await w.repo.productRecords({ today: '2026-10-20' })).records[0].state, 'stale', 'needs_revalidation reads as stale, never verified');
});

// ---- PostgreSQL concurrency (S3.2 design, section 3) ----------------------------------------------------------------------

test('concurrent checks of one candidate by two checkers: exactly one applies and the audit chain stays linear', postgresTestOptions(), async t => {
  const w = await world(t);
  const results = await Promise.allSettled([
    w.repo.check({ signedAction: w.signCheck(w.people.checker) }),
    w.repo.check({ signedAction: w.signCheck(w.people.other) }),
  ]);
  const applied = results.filter(result => result.status === 'fulfilled');
  assert.equal(applied.length, 1, 'one check wins');
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'SUBMISSION_STATE_CONFLICT');
  assert.equal(await w.state(), 'checked');
  assert.equal((await w.database.one('SELECT count(*) AS n FROM curated_action_nonces')).n, 1, 'only the winner spent a nonce');
  assert.equal((await w.database.one("SELECT count(*) AS n FROM audit_events WHERE action = 'curated_source.checked'")).n, 1);
  await assertLinearChain(w.database);
});

test('concurrent publications of one product: exactly one publishes, the other is refused, the chain stays linear', postgresTestOptions(), async t => {
  const w = await world(t);
  await w.repo.check({ signedAction: w.signCheck(w.people.checker) });
  const third = await syntheticAdult(w.database, 'third checker');
  await w.grant(third);
  const results = await Promise.allSettled([
    w.repo.publish({ signedAction: w.signPublish(w.people.other) }),
    w.repo.publish({ signedAction: w.signPublish(third) }),
    w.repo.publish({ signedAction: w.signPublish(w.people.other) }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1, 'one publication wins');
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'SUBMISSION_STATE_CONFLICT');
  assert.equal(await w.state(), 'published');
  assert.equal((await w.database.one("SELECT count(*) AS n FROM audit_events WHERE action = 'curated_source.published'")).n, 1);
  assert.equal((await w.database.one("SELECT count(*) AS n FROM curated_action_nonces WHERE action = 'publish'")).n, 1);
  assert.equal((await w.repo.listVerified()).length, 1);
  await assertLinearChain(w.database);
});

test('one signed action submitted concurrently applies once; every copy after the first is a replay', postgresTestOptions(), async t => {
  const w = await world(t);
  const signed = w.signCheck();
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => w.repo.check({ signedAction: signed })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(r => r.status === 'rejected')) assert.equal(result.reason.code, 'SOURCE_ACTION_REPLAYED');
  assert.equal((await w.database.one('SELECT count(*) AS n FROM curated_action_nonces')).n, 1);
  assert.equal((await w.refusals()).length, 4, 'each replay is audited as refused');
  await assertLinearChain(w.database);
});

test('a revocation racing a signed check lands wholly before or wholly after it', postgresTestOptions(), async t => {
  for (let round = 0; round < 3; round += 1) {
    const w = await world(t);
    const [checked, revoked] = await Promise.allSettled([
      w.repo.check({ signedAction: w.signCheck() }),
      w.repo.revokeRole({ grantId: w.grants.checker.id }),
    ]);
    assert.equal(revoked.status, 'fulfilled');
    assert.equal(revoked.value, true);
    if (checked.status === 'fulfilled') {
      // The check committed first; the review stays on record and the revocation follows it in the audit chain.
      const order = (await w.database.many("SELECT action FROM audit_events WHERE action IN ('curated_source.checked', 'curated_source_role.revoked') ORDER BY id")).map(row => row.action);
      assert.deepEqual(order, ['curated_source.checked', 'curated_source_role.revoked']);
    } else {
      assert.equal(checked.reason.code, 'SOURCE_ROLE_NOT_AUTHORISED');
      assert.equal(await w.state(), 'candidate');
      assert.equal((await w.database.one('SELECT count(*) AS n FROM curated_action_nonces')).n, 0);
    }
    await assertLinearChain(w.database);
  }
});
