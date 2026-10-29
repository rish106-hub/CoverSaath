// Trusted insurer-source workflow: exact-byte verification, separate collection/extraction/check/publication states, a genuinely
// separate authenticated checker, explicit revalidation, and the end-to-end synthetic journey. Synthetic documents only.
// Runs on PostgreSQL (S3.2). The API-level test (no check or publish route) lives in curated-product-api.test.mjs (WP3).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { freshDatabase, postgresTestOptions } from './support/pg.mjs';
import { CuratedProductRepository } from '../src/backend/repositories/curated-product-repository.js';
import { buildDecisionCatalogue, sha256Hex, verifySourceEvidence } from '../src/features/decision-catalogue/index.js';
import { checkerKeyring } from './support/curated-keys.mjs';
import { inProcessPdfText, sourcePdf, textlessPdf } from './support/curated-text.mjs';

const UIN = 'SYNTHHLIP26001V012526';
const PAGES = [
  `Synthetic Health Plan\nUIN: ${UIN}\nWording version v1`,
  'Pre-existing diseases are covered after a waiting period of 36 months of continuous coverage.',
];
// Real synthetic PDFs: page text is derived from these bytes, never taken from PAGES.
const BYTES = await sourcePdf(PAGES);
const OTHER_BYTES = await sourcePdf(PAGES, { title: 'a different file claiming the same wording' });
const FACT = { factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months: 36 }, page: 2, quote: 'waiting period of 36 months of continuous coverage' };
const base = (over = {}) => ({
  uin: UIN, insurer: 'Synthetic Insurer', productName: 'Synthetic Health Plan', wordingVersion: 'v1', sourceUrl: 'https://insurer.example/wording-v1.pdf',
  sourceVersionId: 'rev-1', retrievedOn: '2026-10-15', bytes: BYTES, pageTexts: PAGES, ...over,
});

async function syntheticAdult(db, name) {
  const id = `adult-${randomUUID()}`;
  const at = '2026-10-01T00:00:00.000Z';
  await db.run("INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)", [id, `Synthetic ${name}`, at, at]);
  return id;
}

async function world(t) {
  const { db } = await freshDatabase(t);
  let now = new Date('2026-10-20T10:00:00.000Z');
  const clock = () => now;
  const repo = new CuratedProductRepository(db, { clock, env: { CURATED_SOURCE_HOSTS: 'insurer.example' }, pdfText: inProcessPdfText });
  const adult = name => syntheticAdult(db, name);
  const people = { curator: await adult('curator'), checker: await adult('checker'), second: await adult('second checker'), nobody: await adult('nobody') };
  const expiry = (days = 30) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const keys = checkerKeyring();
  const grantChecker = adultUserId => repo.grantRole({ adultUserId, role: 'checker', operatorId: 'test-operator', expiresAt: expiry(), publicKey: keys.publicKey(adultUserId) });
  const grants = {
    curator: await repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt: expiry() }),
    checker: await grantChecker(people.checker),
    second: await grantChecker(people.second),
  };
  // Signed with the checker's own key on the repository's clock, as the operator CLI would apply it.
  const signed = (action, adultId, fields, options = {}) => keys.sign(action, adultId, fields, { now, ...options });
  return { database: db, repo, adult, people, grants, expiry, keys, grantChecker, signed, now: () => now, tick: ms => { now = new Date(now.getTime() + ms); }, setNow: value => { now = new Date(value); } };
}
const acode = async fn => { try { await fn(); } catch (error) { return error; } return assert.fail('expected an error'); };
const code = acode;
const registered = w => w.repo.register({ curatorId: w.people.curator, ...base() });
const candidate = async w => { const r = await registered(w); await w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: r.submissionId, facts: [FACT] }); return r.submissionId; };
const factsHash = async (w, id) => sha256Hex((await w.database.one('SELECT facts_json FROM curated_product_submissions WHERE id = ?', [id])).facts_json);
const accept = async (w, id, who = w.people.checker, over = {}) => w.repo.check({ signedAction: w.signed('check', who, { submissionId: id, decision: 'accept', reasonCode: 'quote_matches_source', observedSha256: sha256Hex(BYTES), factsSha256: await factsHash(w, id), quotesReviewed: true, ...over }) });
const publish = async (w, id, who = w.people.second, over = {}) => w.repo.publish({ signedAction: w.signed('publish', who, { submissionId: id, observedSha256: sha256Hex(BYTES), factsSha256: await factsHash(w, id), ...over }) });
const count = async (db, sql, params = []) => (await db.one(sql, params)).n;

test('evidence: a false but well-formed digest, a wrong UIN, several UINs and a missing version all fail closed', () => {
  const record = { uin: UIN, wordingVersion: 'v1', contentSha256: sha256Hex(BYTES) };
  const run = (over = {}) => verifySourceEvidence({ record: { ...record, ...over.record }, bytes: over.bytes ?? BYTES, pageTexts: over.pages ?? PAGES, facts: over.facts ?? [] });
  assert.deepEqual(run().blocking, []);
  assert.deepEqual(run({ record: { contentSha256: 'a'.repeat(64) } }).blocking, ['digest_mismatch']);
  assert.deepEqual(run({ record: { contentSha256: 'xyz' } }).blocking, ['digest_malformed']);
  assert.ok(run({ bytes: Buffer.from('changed pdf') }).blocking.includes('digest_mismatch'), 'a changed PDF no longer matches');
  assert.ok(run({ record: { uin: 'OTHERHLIP26009V000000' } }).blocking.includes('uin_mismatch'));
  assert.ok(run({ pages: [`UIN: ${UIN}\nUIN: OTHERHLIP26009V000000\nWording version v1`] }).blocking.includes('several_uins'));
  assert.ok(run({ pages: ['no identifier here, wording version v1'] }).blocking.includes('uin_not_printed'));
  assert.ok(run({ pages: [`UIN: ${UIN} wording version v2`] }).blocking.includes('wording_version_not_printed'));
  assert.ok(run({ facts: [{ page: 2, quote: 'a quotation the source never prints' }] }).blocking.includes('quote_not_on_page:0'));
  assert.ok(run({ facts: [{ page: 9, quote: 'waiting period of 36 months' }] }).blocking.includes('page_out_of_range:0'));
  assert.ok(run({ facts: [{ page: 1, quote: 'waiting period of 36 months' }] }).blocking.includes('quote_not_on_page:0'), 'right words on the wrong page');
  assert.deepEqual(run({ facts: [{ page: 2, quote: 'WAITING   PERIOD of 36 months' }] }).blocking, [], 'layout whitespace and case are not evidence');
});

test('evidence: with no page text nothing is machine-verified and a human must review', () => {
  const out = verifySourceEvidence({ record: { uin: UIN, wordingVersion: 'v1', contentSha256: sha256Hex(BYTES) }, bytes: BYTES, pageTexts: null, facts: [FACT] });
  assert.deepEqual(out.blocking, []);
  assert.ok(out.humanReview.includes('quotes_not_machine_checked') && out.humanReview.includes('uin_not_machine_checked'));
});

test('roles: no role, an expired role and a revoked role cannot collect, check or read; an operator cannot self-grant', postgresTestOptions(), async t => {
  const w = await world(t);
  assert.equal((await acode(() => w.repo.register({ curatorId: w.people.nobody, ...base() }))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal((await acode(() => w.repo.register({ curatorId: w.people.checker, ...base() }))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'a checker is not a curator');
  const id = await candidate(w);
  assert.equal((await code(() => accept(w, id, w.people.nobody))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal((await code(() => w.repo.get({ adultId: w.people.nobody, submissionId: id }))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  await w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal((await code(() => accept(w, id))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'revoked');
  w.tick(31 * 86_400_000);
  assert.equal((await code(() => accept(w, id, w.people.second))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'expired');
  assert.equal((await code(() => w.repo.grantRole({ adultUserId: w.people.nobody, role: 'checker', operatorId: w.people.nobody, expiresAt: w.expiry(), publicKey: w.keys.publicKey(w.people.nobody) }))).code, 'CURATED_PRODUCT_INVALID');
  assert.equal((await code(() => w.repo.grantRole({ adultUserId: w.people.nobody, role: 'checker', operatorId: 'op', expiresAt: w.expiry(400), publicKey: w.keys.publicKey(w.people.nobody) }))).code, 'CURATED_PRODUCT_INVALID', 'a grant must be short-lived');
});

test('collection: bad claims, bad identity, stale wording and a competing document are refused', postgresTestOptions(), async t => {
  const w = await world(t);
  const fail = async (over, expected) => assert.equal((await acode(() => w.repo.register({ curatorId: w.people.curator, ...base(over) }))).code, expected);
  await fail({ claimedSha256: 'a'.repeat(64) }, 'SOURCE_EVIDENCE_REJECTED');
  await fail({ pageTexts: [`UIN: OTHERHLIP26009V000000 wording version v1`] }, 'SOURCE_EVIDENCE_REJECTED');
  await fail({ uin: 'short' }, 'CURATED_PRODUCT_INVALID');
  await fail({ sourceUrl: 'http://insurer.example/w.pdf' }, 'CURATED_PRODUCT_INVALID');
  await fail({ sourceUrl: 'https://user:pw@insurer.example/w.pdf' }, 'CURATED_PRODUCT_INVALID');
  await fail({ retrievedOn: '2024-01-01' }, 'SOURCE_NOT_CURRENT');
  await fail({ retrievedOn: '2027-01-01' }, 'CURATED_PRODUCT_INVALID');
  await fail({ bytes: Buffer.alloc(0) }, 'CURATED_PRODUCT_INVALID');
  const first = await registered(w);
  assert.equal(first.state, 'collected');
  assert.equal((await registered(w)).replayed, true, 'the same bytes replay');
  await fail({ bytes: OTHER_BYTES, sourceVersionId: 'rev-x' }, 'SOURCE_VERSION_CONFLICT');
  assert.equal(await count(w.database, 'SELECT count(*) AS n FROM curated_product_submissions'), 1);
});

test('collection: concurrent registrations of the same bytes store one submission and replay the rest', postgresTestOptions(), async t => {
  const w = await world(t);
  const results = await Promise.all(Array.from({ length: 4 }, () => registered(w)));
  assert.equal(new Set(results.map(result => result.submissionId)).size, 1);
  assert.equal(results.filter(result => !result.replayed).length, 1);
  assert.equal(await count(w.database, 'SELECT count(*) AS n FROM curated_product_submissions'), 1);
  assert.equal(await count(w.database, 'SELECT count(*) AS n FROM curated_source_archives'), 1);
  assert.equal(await count(w.database, "SELECT count(*) AS n FROM audit_events WHERE action = 'curated_source.registered'"), 1);
});

test('collection: the host allowlist fails closed, matches exact hosts and refuses address-like entries', postgresTestOptions(), async t => {
  const w = await world(t);
  const open = new CuratedProductRepository(w.database, { clock: () => new Date('2026-10-20T10:00:00.000Z'), env: {}, pdfText: inProcessPdfText });
  assert.equal((await acode(() => open.register({ curatorId: w.people.curator, ...base() }))).code, 'SOURCE_HOSTS_NOT_CONFIGURED', 'unset allowlist permits nothing');
  for (const entry of ['127.0.0.1', 'localhost', 'a.localhost', '169.254.169.254', 'metadata.internal', 'insurer']) {
    assert.throws(() => new CuratedProductRepository(w.database, { env: { CURATED_SOURCE_HOSTS: entry } }), TypeError, entry);
  }
  for (const sourceUrl of ['https://insurer.example.evil.example/w.pdf', 'https://notinsurer.example/w.pdf', 'https://insurer.example:8443/w.pdf']) {
    assert.equal((await acode(() => w.repo.register({ curatorId: w.people.curator, ...base({ sourceUrl }) }))).code, 'CURATED_PRODUCT_INVALID', sourceUrl);
  }
  const strict = new CuratedProductRepository(w.database, { clock: () => new Date('2026-10-20T10:00:00.000Z'), env: { CURATED_SOURCE_HOSTS: 'insurer.example, other.example' }, pdfText: inProcessPdfText });
  assert.equal((await acode(() => strict.register({ curatorId: w.people.curator, ...base({ sourceUrl: 'https://evil.example/w.pdf' }) }))).code, 'CURATED_PRODUCT_INVALID');
  assert.equal((await strict.register({ curatorId: w.people.curator, ...base() })).state, 'collected');
});

test('extraction: facts need a supported type, a real page and a quotation the source prints', postgresTestOptions(), async t => {
  const w = await world(t);
  const { submissionId } = await registered(w);
  const propose = facts => w.repo.proposeFacts({ curatorId: w.people.curator, submissionId, facts });
  assert.equal((await code(() => propose([{ ...FACT, quote: '' }]))).code, 'CURATED_PRODUCT_INVALID', 'missing quotation');
  assert.equal((await code(() => propose([{ ...FACT, factType: 'sum_insured', value: { amountMinor: 1, currency: 'INR' } }]))).code, 'CURATED_PRODUCT_INVALID', 'household-only type');
  const unsupported = await code(() => propose([{ ...FACT, quote: 'coverage is unlimited for every ailment forever' }]));
  assert.equal(unsupported.code, 'SOURCE_EVIDENCE_REJECTED');
  assert.deepEqual(unsupported.details, ['quote_not_on_page:0']);
  assert.equal((await code(() => propose([{ ...FACT, page: 1 }]))).code, 'SOURCE_EVIDENCE_REJECTED');
  assert.equal((await code(() => w.repo.proposeFacts({ curatorId: w.people.second, submissionId, facts: [FACT] }))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal((await w.repo.get({ adultId: w.people.curator, submissionId })).state, 'collected', 'a failed proposal changes nothing');
  assert.equal((await propose([FACT])).state, 'candidate');
});

test('check: the collector cannot approve, the checker must present their own matching digest, and states cannot be skipped', postgresTestOptions(), async t => {
  const w = await world(t);
  const { submissionId } = await registered(w);
  assert.equal((await code(() => accept(w, submissionId))).code, 'SUBMISSION_STATE_CONFLICT', 'no facts yet');
  await w.repo.proposeFacts({ curatorId: w.people.curator, submissionId, facts: [FACT] });
  // The same human holding both roles is still refused: identity, not role.
  await w.grantChecker(w.people.curator);
  assert.equal((await code(() => accept(w, submissionId, w.people.curator))).code, 'SELF_REVIEW_REFUSED');
  assert.equal((await code(() => publish(w, submissionId, w.people.checker))).code, 'SUBMISSION_STATE_CONFLICT', 'cannot publish an unchecked candidate');
  assert.equal((await code(() => accept(w, submissionId, w.people.checker, { quotesReviewed: false }))).code, 'CURATED_PRODUCT_INVALID');
  assert.equal((await code(() => accept(w, submissionId, w.people.checker, { observedSha256: 'b'.repeat(64) }))).code, 'SOURCE_DIGEST_MISMATCH');
  assert.equal((await code(() => accept(w, submissionId, w.people.checker, { observedSha256: 'nope' }))).code, 'SOURCE_ACTION_MALFORMED', 'a malformed digest cannot even be signed');
  assert.equal((await w.repo.get({ adultId: w.people.checker, submissionId })).state, 'candidate');
  assert.equal((await accept(w, submissionId)).state, 'checked');
  assert.equal((await code(() => accept(w, submissionId, w.people.second))).code, 'SUBMISSION_STATE_CONFLICT', 'one decision only');
  assert.deepEqual(await w.repo.listVerified(), [], 'checked is not published');
});

test('review fixes: the digest is withheld, approval binds to the facts read, text comes from the bytes, and reasons fit decisions', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  assert.ok(!('contentSha256' in await w.repo.get({ adultId: w.people.checker, submissionId: id })), 'a checker cannot read the digest back');
  assert.equal((await code(() => accept(w, id, w.people.checker, { factsSha256: 'e'.repeat(64) }))).code, 'FACTS_CHANGED');
  assert.equal((await code(() => accept(w, id, w.people.checker, { reasonCode: 'wrong_product_or_version' }))).code, 'CURATED_PRODUCT_INVALID');
  assert.equal((await code(() => w.repo.check({ signedAction: w.signed('check', w.people.checker, { submissionId: id, decision: 'reject', reasonCode: 'quote_matches_source' }) }))).code, 'CURATED_PRODUCT_INVALID');
  assert.equal((await acode(() => w.repo.register({ curatorId: w.people.curator, ...base({ bytes: Buffer.from('not a pdf at all'), sourceVersionId: 'rev-9', uin: UIN }) }))).code, 'SOURCE_EVIDENCE_REJECTED', 'not a PDF');
  // A mismatch attempt stays on the audit record although the transaction rolled back.
  assert.equal((await code(() => accept(w, id, w.people.checker, { observedSha256: 'b'.repeat(64) }))).code, 'SOURCE_DIGEST_MISMATCH');
  assert.equal(await count(w.database, "SELECT count(*) AS n FROM audit_events WHERE action = 'curated_source.check_digest_mismatch'"), 1);
  // Page text is derived from the bytes: no curator text is needed, and a document with no derivable text is refused outright.
  const bare = await world(t);
  const derived = await bare.repo.register({ curatorId: bare.people.curator, ...base({ pageTexts: null }) });
  assert.equal(derived.pageTextOrigin, 'derived_from_bytes');
  await bare.repo.proposeFacts({ curatorId: bare.people.curator, submissionId: derived.submissionId, facts: [FACT] });
  assert.equal((await accept(bare, derived.submissionId)).state, 'checked', 'UIN, version and quotes were machine-checked against the derived text');
  const textless = await acode(async () => bare.repo.register({ curatorId: bare.people.curator, ...base({ bytes: await textlessPdf(), sourceVersionId: 'rev-img', wordingVersion: 'v-img', pageTexts: null }) }));
  assert.equal(textless.code, 'SOURCE_EVIDENCE_REJECTED');
  assert.deepEqual(textless.details.slice(0, 1), ['page_text_unestablished']);
  const mismatch = await acode(() => bare.repo.register({ curatorId: bare.people.curator, ...base({ wordingVersion: 'v-alt', sourceVersionId: 'rev-alt', bytes: OTHER_BYTES, pageTexts: [PAGES[0], 'Room rent is at actuals.'] }) }));
  assert.deepEqual(mismatch.details, ['supplied_text_differs:2'], 'curator text is a candidate and must agree with the bytes');
});

test('review fixes: only the collector opens a changed-source submission, and states cannot jump', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  await assert.rejects(w.database.run("UPDATE curated_product_submissions SET state = 'published', checked_by = ?, checked_at = ?, published_at = ? WHERE id = ?", [w.people.checker, '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', id]), /illegal curated product state transition/);
  await assert.rejects(w.database.run("UPDATE curated_product_submissions SET effective_from = '2030-01-01' WHERE id = ?", [id]), /immutable/);
  await accept(w, id);
  await publish(w, id, w.people.second);
  const other = await w.adult('other curator');
  await w.repo.grantRole({ adultUserId: other, role: 'curator', operatorId: 'test-operator', expiresAt: w.expiry() });
  const junk = Buffer.from('%PDF-junk from another curator');
  assert.equal((await acode(() => w.repo.revalidate({ actorId: other, submissionId: id, bytes: junk, sourceVersionId: 'rev-junk' }))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal((await w.repo.listVerified()).length, 1, 'the published wording is untouched');
});

test('verification is derived from a stored checker action, never from record fields', postgresTestOptions(), async t => {
  const w = await world(t);
  assert.deepEqual(await w.repo.listVerified(), []);
  const id = await candidate(w);
  assert.deepEqual(await w.repo.listVerified(), []);
  await accept(w, id);
  await publish(w, id, w.people.second);
  const [product] = await w.repo.listVerified();
  assert.equal(product.verified, true);
  assert.equal(product.mayOverrideContract, false);
  assert.equal(product.product.checkedBy, w.people.checker);
  assert.equal(product.verification.submissionId, id);
  // Raw SQL cannot fabricate a self-checked row either.
  await assert.rejects(w.database.run('UPDATE curated_product_submissions SET checked_by = collected_by'), /constraint|immutable/i);
});

test('database: content is immutable, rows and archives are never deleted, and the audit chain cannot be edited', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  await accept(w, id);
  const db = w.database;
  await assert.rejects(db.run("UPDATE curated_product_submissions SET wording_version = 'v9' WHERE id = ?", [id]), /immutable/);
  await assert.rejects(db.run("UPDATE curated_product_submissions SET facts_json = '[]' WHERE id = ?", [id]), /immutable/, 'checked facts are frozen');
  await assert.rejects(db.run('UPDATE curated_product_submissions SET checked_by = ? WHERE id = ?', [w.people.second, id]), /immutable/);
  await assert.rejects(db.run('DELETE FROM curated_product_submissions'), /never deleted/);
  await assert.rejects(db.run('DELETE FROM curated_source_archives'), /never deleted/);
  await assert.rejects(db.run('UPDATE curated_source_archives SET byte_size = 1'), /immutable/);
  await assert.rejects(db.run("UPDATE audit_events SET action = 'x'"), /./);
  await assert.rejects(db.run('DELETE FROM audit_events'), /./);
  const actions = (await db.many("SELECT action FROM audit_events WHERE action LIKE 'curated_source.%' ORDER BY id")).map(row => row.action);
  assert.deepEqual(actions, ['curated_source.registered', 'curated_source.candidate_proposed', 'curated_source.checked']);
  const stored = JSON.stringify(await db.many("SELECT event_payload_json FROM audit_events WHERE action LIKE 'curated_source.%'"));
  assert.ok(!stored.includes('waiting period of 36 months'), 'audit holds ids and digests, never page text');
});

test('maintenance: an unchanged source is recorded, a changed one withdraws the wording and needs a fresh independent check', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  await accept(w, id);
  await publish(w, id, w.people.second);
  const unchanged = await w.repo.revalidate({ actorId: w.people.checker, submissionId: id, bytes: BYTES });
  assert.equal(unchanged.changed, false);
  assert.equal((await w.repo.listVerified()).length, 1);

  const v2 = await sourcePdf(PAGES, { title: 'silently edited' });
  assert.equal((await acode(() => w.repo.revalidate({ actorId: w.people.checker, submissionId: id, bytes: v2, sourceVersionId: 'rev-2' }))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'a checker alone cannot open a new collection');
  assert.equal((await acode(() => w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes: v2 }))).code, 'CURATED_PRODUCT_INVALID', 'a changed source needs a new source version id');
  const changed = await w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes: v2, sourceVersionId: 'rev-2', pageTexts: PAGES, retrievedOn: '2026-10-20' });
  assert.equal(changed.changed, true);
  assert.equal(changed.submission.state, 'needs_revalidation');
  assert.equal(changed.next.state, 'collected');
  assert.equal(changed.next.previousId, id);
  assert.deepEqual(await w.repo.listVerified(), [], 'the old wording stops informing the moment its source changes');
  assert.equal((await code(() => publish(w, changed.next.submissionId, w.people.checker))).code, 'SUBMISSION_STATE_CONFLICT');
  // History is kept: the old row and its bytes are still there.
  assert.equal((await w.database.one('SELECT content_sha256 AS s FROM curated_product_submissions WHERE id = ?', [id])).s, sha256Hex(BYTES));
  assert.equal(await count(w.database, 'SELECT count(*) AS n FROM curated_source_archives'), 2);

  await w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: changed.next.submissionId, facts: [FACT] });
  assert.equal((await code(() => accept(w, changed.next.submissionId, w.people.checker, { observedSha256: sha256Hex(BYTES) }))).code, 'SOURCE_DIGEST_MISMATCH', 'the old bytes do not verify the new document');
  await accept(w, changed.next.submissionId, w.people.checker, { observedSha256: sha256Hex(v2) });
  assert.equal((await code(() => publish(w, changed.next.submissionId, w.people.second))).code, 'SOURCE_DIGEST_MISMATCH', 'the publisher attests the new bytes, not the old');
  await publish(w, changed.next.submissionId, w.people.second, { observedSha256: sha256Hex(v2) });
  assert.equal((await w.repo.get({ adultId: w.people.checker, submissionId: id })).state, 'superseded');
  assert.equal((await w.repo.listVerified())[0].verification.sourceVersionId, 'rev-2');
});

test('maintenance: stale evidence cannot be published and the module has no network path', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  await accept(w, id);
  w.tick(401 * 86_400_000);
  await w.grantChecker(w.people.second);
  assert.equal((await code(() => publish(w, id, w.people.second))).code, 'SOURCE_NOT_CURRENT');
  for (const file of ['src/backend/repositories/curated-product-repository.js', 'src/features/decision-catalogue/source-verification.js', 'src/features/decision-catalogue/curated-products.js']) {
    const source = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(|node:(http|https|net|dns|tls)|\bXMLHttpRequest\b|new URL\([^)]*\)\.(href|toString)/.test(source), `${file} must not reach the network`);
  }
});

test('journey: source to verified fact, household contract authority preserved, source change and revocation withdraw it', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  const clauseRows = [{ id: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'x'.repeat(64), text: `Household schedule. UIN: ${UIN}` }];
  const household = { documentId: 'd1', factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months: 48 } };
  const compare = async () => buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [], curatedProducts: await w.repo.listVerified() }).curatedComparison[0];
  const catalogueWith = products => buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [], curatedProducts: products });

  assert.equal((await compare()).status, 'no_curated_record', 'before publication nothing is claimed');
  assert.equal((await code(() => accept(w, id, w.people.curator))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'self-verification is refused');
  await accept(w, id, w.people.checker);
  assert.equal((await compare()).status, 'no_curated_record', 'checked is not published');
  await publish(w, id, w.people.second);

  const published = await compare();
  assert.equal(published.status, 'compared');
  assert.equal(published.productVersion, 'v1');
  assert.equal(published.comparisons[0].curatedValue.months, 36);
  assert.equal(published.comparisons[0].source.contentSha256, sha256Hex(BYTES));
  assert.deepEqual(catalogueWith(await w.repo.listVerified()).facts, catalogueWith([]).facts, 'the household contract is untouched by public wording');
  assert.equal(household.value.months, 48);

  await w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes: await sourcePdf(PAGES, { title: 'the insurer changed this file' }), sourceVersionId: 'rev-2', pageTexts: PAGES, retrievedOn: '2026-10-20' });
  assert.equal((await compare()).status, 'no_curated_record', 'a changed source needs revalidation before it informs anyone');

  // Revocation: the previously valid checker is refused on the next request.
  const next = (await w.database.one("SELECT id FROM curated_product_submissions WHERE state = 'collected'")).id;
  await w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: next, facts: [FACT] });
  await w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal((await code(() => accept(w, next, w.people.checker, { observedSha256: sha256Hex(Buffer.from('%PDF-the insurer changed this file')) }))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
});

test('concurrent check and revocation: whichever lands first decides, and a late revocation leaves a recorded check that no longer publishes', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  await w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal((await code(() => accept(w, id))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'revocation first: no check');
  const other = await world(t);
  const checked = await candidate(other);
  await accept(other, checked);
  await other.repo.revokeRole({ grantId: other.grants.second.id });
  assert.equal((await code(() => publish(other, checked, other.people.second))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'revoked before publishing');
  assert.equal((await other.repo.get({ adultId: other.people.checker, submissionId: checked })).state, 'checked');
});

test('grant expiry ends future authority only: a published review stays valid, invalidation is a separate recorded act', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  await accept(w, id, w.people.checker);
  await publish(w, id, w.people.second);
  w.setNow('2026-11-25T10:00:00.000Z');
  assert.equal(await w.repo.activeRole(w.people.checker, 'checker'), null, 'the grant has expired');
  const kept = await w.repo.listVerified({ today: '2026-11-25' });
  assert.equal(kept.length, 1, 'the completed review is still historically valid');
  assert.equal(kept[0].verified, true);
  assert.equal((await code(() => accept(w, id, w.people.checker))).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'no new reviews');
  const before = await w.database.one('SELECT checked_by, checked_at FROM curated_product_submissions WHERE id = ?', [id]);
  assert.equal((await code(() => w.repo.invalidate({ submissionId: id, operatorId: 'op', reasonCode: 'nonsense' }))).code, 'CURATED_PRODUCT_INVALID');
  assert.equal((await w.repo.invalidate({ submissionId: id, operatorId: 'op', reasonCode: 'checker_compromised' })).state, 'needs_revalidation');
  assert.deepEqual(await w.database.one('SELECT checked_by, checked_at FROM curated_product_submissions WHERE id = ?', [id]), before, 'review record is not rewritten');
  assert.equal((await w.repo.listVerified({ today: '2026-11-25' })).length, 0, 'invalidated product informs nobody');
  assert.equal((await code(() => w.repo.invalidate({ submissionId: id, operatorId: 'op', reasonCode: 'checker_compromised' }))).code, 'SUBMISSION_STATE_CONFLICT');
});

test('silent-failure sites: role checks fail closed when the role read rejects', postgresTestOptions(), async t => {
  const w = await world(t);
  const id = await candidate(w);
  // A dropped role read must deny, never pass: get() and revalidate() combine two role reads (Boolean(await ...)).
  const failing = new CuratedProductRepository(w.database, { clock: w.now, env: { CURATED_SOURCE_HOSTS: 'insurer.example' }, pdfText: inProcessPdfText });
  failing.activeRole = async () => { throw Object.assign(new Error('connection lost'), { code: '08006' }); };
  assert.equal((await acode(() => failing.get({ adultId: w.people.checker, submissionId: id }))).code, '08006');
  assert.equal((await acode(() => failing.revalidate({ actorId: w.people.curator, submissionId: id, bytes: BYTES }))).code, '08006');
  // A role read resolving to null (revoked between calls) denies too.
  failing.activeRole = async () => null;
  assert.equal((await acode(() => failing.get({ adultId: w.people.checker, submissionId: id }))).code, 'SOURCE_ROLE_NOT_AUTHORISED');
});
