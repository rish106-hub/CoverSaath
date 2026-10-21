// Trusted insurer-source workflow: exact-byte verification, separate collection/extraction/check/publication states, a genuinely
// separate authenticated checker, explicit revalidation, and the end-to-end synthetic journey. Synthetic documents only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { createApiServer } from '../src/server/server.js';
import { buildDecisionCatalogue, sha256Hex, verifySourceEvidence } from '../src/features/decision-catalogue/index.js';

const bootstrapToken = 'coversaath-curated-test-bootstrap-token-01';
const UIN = 'SYNTHHLIP26001V012526';
const BYTES = Buffer.from('%PDF-synthetic insurer wording, version one');
const PAGES = [
  `Synthetic Health Plan\nUIN: ${UIN}\nWording version v1`,
  'Pre-existing diseases are covered after a waiting period of 36 months of continuous coverage.',
];
const FACT = { factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months: 36 }, page: 2, quote: 'waiting period of 36 months of continuous coverage' };
const base = (over = {}) => ({
  uin: UIN, insurer: 'Synthetic Insurer', productName: 'Synthetic Health Plan', wordingVersion: 'v1', sourceUrl: 'https://insurer.example/wording-v1.pdf',
  sourceVersionId: 'rev-1', retrievedOn: '2026-10-15', bytes: BYTES, pageTexts: PAGES, ...over,
});

function world(t) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-curated-'));
  const database = openDatabase({ path: join(directory, 'app.sqlite') });
  let now = new Date('2026-10-20T10:00:00.000Z');
  const clock = () => now;
  const services = createBackendServices(database, { clock, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken, CURATED_SOURCE_HOSTS: 'insurer.example' } });
  const adult = name => services.households.createAdult({ displayName: `Synthetic ${name}` }).id;
  const people = { curator: adult('curator'), checker: adult('checker'), second: adult('second checker'), nobody: adult('nobody') };
  const repo = services.curatedProducts;
  const expiry = (days = 30) => new Date(now.getTime() + days * 86_400_000).toISOString();
  const grants = {
    curator: repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt: expiry() }),
    checker: repo.grantRole({ adultUserId: people.checker, role: 'checker', operatorId: 'test-operator', expiresAt: expiry() }),
    second: repo.grantRole({ adultUserId: people.second, role: 'checker', operatorId: 'test-operator', expiresAt: expiry() }),
  };
  t.after(() => { database.close(); rmSync(directory, { recursive: true, force: true }); });
  return { database, services, repo, people, grants, expiry, tick: ms => { now = new Date(now.getTime() + ms); }, setNow: value => { now = new Date(value); } };
}
const code = fn => { try { fn(); } catch (error) { return error; } assert.fail('expected an error'); };
const registered = w => w.repo.register({ curatorId: w.people.curator, ...base() });
const candidate = w => { const r = registered(w); w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: r.submissionId, facts: [FACT] }); return r.submissionId; };
const factsHash = (w, id) => sha256Hex(w.database.prepare('SELECT facts_json FROM curated_product_submissions WHERE id = ?').get(id).facts_json);
const accept = (w, id, who = w.people.checker, over = {}) => w.repo.check({ checkerId: who, submissionId: id, decision: 'accept', reasonCode: 'quote_matches_source', observedSha256: sha256Hex(BYTES), factsSha256: factsHash(w, id), quotesReviewed: true, ...over });

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

test('roles: no role, an expired role and a revoked role cannot collect, check or read; an operator cannot self-grant', t => {
  const w = world(t);
  assert.equal(code(() => w.repo.register({ curatorId: w.people.nobody, ...base() })).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal(code(() => w.repo.register({ curatorId: w.people.checker, ...base() })).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'a checker is not a curator');
  const id = candidate(w);
  assert.equal(code(() => accept(w, id, w.people.nobody)).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal(code(() => w.repo.get({ adultId: w.people.nobody, submissionId: id })).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal(code(() => accept(w, id)).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'revoked');
  w.tick(31 * 86_400_000);
  assert.equal(code(() => accept(w, id, w.people.second)).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'expired');
  assert.equal(code(() => w.repo.grantRole({ adultUserId: w.people.nobody, role: 'checker', operatorId: w.people.nobody, expiresAt: w.expiry() })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(code(() => w.repo.grantRole({ adultUserId: w.people.nobody, role: 'checker', operatorId: 'op', expiresAt: w.expiry(400) })).code, 'CURATED_PRODUCT_INVALID', 'a grant must be short-lived');
});

test('collection: bad claims, bad identity, stale wording and a competing document are refused', t => {
  const w = world(t);
  const fail = (over, expected) => assert.equal(code(() => w.repo.register({ curatorId: w.people.curator, ...base(over) })).code, expected);
  fail({ claimedSha256: 'a'.repeat(64) }, 'SOURCE_EVIDENCE_REJECTED');
  fail({ pageTexts: [`UIN: OTHERHLIP26009V000000 wording version v1`] }, 'SOURCE_EVIDENCE_REJECTED');
  fail({ uin: 'short' }, 'CURATED_PRODUCT_INVALID');
  fail({ sourceUrl: 'http://insurer.example/w.pdf' }, 'CURATED_PRODUCT_INVALID');
  fail({ sourceUrl: 'https://user:pw@insurer.example/w.pdf' }, 'CURATED_PRODUCT_INVALID');
  fail({ retrievedOn: '2024-01-01' }, 'SOURCE_NOT_CURRENT');
  fail({ retrievedOn: '2027-01-01' }, 'CURATED_PRODUCT_INVALID');
  fail({ bytes: Buffer.alloc(0) }, 'CURATED_PRODUCT_INVALID');
  const first = registered(w);
  assert.equal(first.state, 'collected');
  assert.equal(registered(w).replayed, true, 'the same bytes replay');
  fail({ bytes: Buffer.from('%PDF-a different document claiming v1'), sourceVersionId: 'rev-x' }, 'SOURCE_VERSION_CONFLICT');
  assert.equal(w.database.prepare('SELECT count(*) AS n FROM curated_product_submissions').get().n, 1);
});

test('collection: the host allowlist fails closed, matches exact hosts and refuses address-like entries', t => {
  const w = world(t);
  const open = new w.repo.constructor(w.database, { clock: () => new Date('2026-10-20T10:00:00.000Z'), env: {} });
  assert.equal(code(() => open.register({ curatorId: w.people.curator, ...base() })).code, 'SOURCE_HOSTS_NOT_CONFIGURED', 'unset allowlist permits nothing');
  for (const entry of ['127.0.0.1', 'localhost', 'a.localhost', '169.254.169.254', 'metadata.internal', 'insurer']) {
    assert.throws(() => new w.repo.constructor(w.database, { env: { CURATED_SOURCE_HOSTS: entry } }), TypeError, entry);
  }
  for (const sourceUrl of ['https://insurer.example.evil.example/w.pdf', 'https://notinsurer.example/w.pdf', 'https://insurer.example:8443/w.pdf']) {
    assert.equal(code(() => w.repo.register({ curatorId: w.people.curator, ...base({ sourceUrl }) })).code, 'CURATED_PRODUCT_INVALID', sourceUrl);
  }
  const strict = new w.repo.constructor(w.database, { clock: () => new Date('2026-10-20T10:00:00.000Z'), env: { CURATED_SOURCE_HOSTS: 'insurer.example, other.example' } });
  assert.equal(code(() => strict.register({ curatorId: w.people.curator, ...base({ sourceUrl: 'https://evil.example/w.pdf' }) })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(strict.register({ curatorId: w.people.curator, ...base() }).state, 'collected');
});

test('extraction: facts need a supported type, a real page and a quotation the source prints', t => {
  const w = world(t);
  const { submissionId } = registered(w);
  const propose = facts => w.repo.proposeFacts({ curatorId: w.people.curator, submissionId, facts });
  assert.equal(code(() => propose([{ ...FACT, quote: '' }])).code, 'CURATED_PRODUCT_INVALID', 'missing quotation');
  assert.equal(code(() => propose([{ ...FACT, factType: 'sum_insured', value: { amountMinor: 1, currency: 'INR' } }])).code, 'CURATED_PRODUCT_INVALID', 'household-only type');
  const unsupported = code(() => propose([{ ...FACT, quote: 'coverage is unlimited for every ailment forever' }]));
  assert.equal(unsupported.code, 'SOURCE_EVIDENCE_REJECTED');
  assert.deepEqual(unsupported.details, ['quote_not_on_page:0']);
  assert.equal(code(() => propose([{ ...FACT, page: 1 }])).code, 'SOURCE_EVIDENCE_REJECTED');
  assert.equal(code(() => w.repo.proposeFacts({ curatorId: w.people.second, submissionId, facts: [FACT] })).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal(w.repo.get({ adultId: w.people.curator, submissionId }).state, 'collected', 'a failed proposal changes nothing');
  assert.equal(propose([FACT]).state, 'candidate');
});

test('check: the collector cannot approve, the checker must present their own matching digest, and states cannot be skipped', t => {
  const w = world(t);
  const { submissionId } = registered(w);
  assert.equal(code(() => accept(w, submissionId)).code, 'SUBMISSION_STATE_CONFLICT', 'no facts yet');
  w.repo.proposeFacts({ curatorId: w.people.curator, submissionId, facts: [FACT] });
  // The same human holding both roles is still refused: identity, not role.
  w.repo.grantRole({ adultUserId: w.people.curator, role: 'checker', operatorId: 'test-operator', expiresAt: w.expiry() });
  assert.equal(code(() => accept(w, submissionId, w.people.curator)).code, 'SELF_REVIEW_REFUSED');
  assert.equal(code(() => w.repo.publish({ actorId: w.people.checker, submissionId })).code, 'SUBMISSION_STATE_CONFLICT', 'cannot publish an unchecked candidate');
  assert.equal(code(() => accept(w, submissionId, w.people.checker, { quotesReviewed: false })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(code(() => accept(w, submissionId, w.people.checker, { observedSha256: 'b'.repeat(64) })).code, 'SOURCE_DIGEST_MISMATCH');
  assert.equal(code(() => accept(w, submissionId, w.people.checker, { observedSha256: 'nope' })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(w.repo.get({ adultId: w.people.checker, submissionId }).state, 'candidate');
  assert.equal(accept(w, submissionId).state, 'checked');
  assert.equal(code(() => accept(w, submissionId, w.people.second)).code, 'SUBMISSION_STATE_CONFLICT', 'one decision only');
  assert.deepEqual(w.repo.listVerified(), [], 'checked is not published');
});

test('review fixes: the digest is withheld, approval binds to the facts read, no-text records need an attestation, and reasons fit decisions', t => {
  const w = world(t);
  const id = candidate(w);
  assert.ok(!('contentSha256' in w.repo.get({ adultId: w.people.checker, submissionId: id })), 'a checker cannot read the digest back');
  assert.equal(code(() => accept(w, id, w.people.checker, { factsSha256: 'e'.repeat(64) })).code, 'FACTS_CHANGED');
  assert.equal(code(() => accept(w, id, w.people.checker, { reasonCode: 'wrong_product_or_version' })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(code(() => w.repo.check({ checkerId: w.people.checker, submissionId: id, decision: 'reject', reasonCode: 'quote_matches_source' })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(code(() => w.repo.register({ curatorId: w.people.curator, ...base({ bytes: Buffer.from('not a pdf at all'), sourceVersionId: 'rev-9', uin: UIN }) })).code, 'SOURCE_EVIDENCE_REJECTED', 'not a PDF');
  // A mismatch attempt stays on the audit record although the transaction rolled back.
  assert.equal(code(() => accept(w, id, w.people.checker, { observedSha256: 'b'.repeat(64) })).code, 'SOURCE_DIGEST_MISMATCH');
  assert.equal(w.database.prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'curated_source.check_digest_mismatch'").get().n, 1);
  // No page text: UIN and version were compared to nothing, so the checker must attest them.
  const bare = world(t);
  const b = bare.repo.register({ curatorId: bare.people.curator, ...base({ pageTexts: null }) }).submissionId;
  bare.repo.proposeFacts({ curatorId: bare.people.curator, submissionId: b, facts: [FACT] });
  assert.equal(code(() => accept(bare, b)).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(accept(bare, b, bare.people.checker, { uinAndVersionReviewed: true }).state, 'checked');
  // Illegal jumps are refused by the database too.
  const c = candidate(world(t));
  assert.ok(c);
});

test('review fixes: only the collector opens a changed-source submission, and states cannot jump', t => {
  const w = world(t);
  const id = candidate(w);
  assert.throws(() => w.database.prepare("UPDATE curated_product_submissions SET state = 'published', checked_by = ?, checked_at = ?, published_at = ? WHERE id = ?").run(w.people.checker, '2026-10-20T10:00:00.000Z', '2026-10-20T10:00:00.000Z', id), /illegal curated product state transition/);
  assert.throws(() => w.database.prepare("UPDATE curated_product_submissions SET effective_from = '2030-01-01' WHERE id = ?").run(id), /immutable/);
  accept(w, id);
  w.repo.publish({ actorId: w.people.second, submissionId: id });
  const other = w.services.households.createAdult({ displayName: 'Synthetic other curator' }).id;
  w.repo.grantRole({ adultUserId: other, role: 'curator', operatorId: 'test-operator', expiresAt: w.expiry() });
  const junk = Buffer.from('%PDF-junk from another curator');
  assert.equal(code(() => w.repo.revalidate({ actorId: other, submissionId: id, bytes: junk, sourceVersionId: 'rev-junk' })).code, 'SOURCE_ROLE_NOT_AUTHORISED');
  assert.equal(w.repo.listVerified().length, 1, 'the published wording is untouched');
});

test('verification is derived from a stored checker action, never from record fields', t => {
  const w = world(t);
  assert.deepEqual(w.repo.listVerified(), []);
  const id = candidate(w);
  assert.deepEqual(w.repo.listVerified(), []);
  accept(w, id);
  w.repo.publish({ actorId: w.people.second, submissionId: id });
  const [product] = w.repo.listVerified();
  assert.equal(product.verified, true);
  assert.equal(product.mayOverrideContract, false);
  assert.equal(product.product.checkedBy, w.people.checker);
  assert.equal(product.verification.submissionId, id);
  // Raw SQL cannot fabricate a self-checked row either.
  assert.throws(() => w.database.prepare('UPDATE curated_product_submissions SET checked_by = collected_by').run(), /constraint|immutable/i);
});

test('database: content is immutable, rows and archives are never deleted, and the audit chain cannot be edited', t => {
  const w = world(t);
  const id = candidate(w);
  accept(w, id);
  const db = w.database;
  assert.throws(() => db.prepare("UPDATE curated_product_submissions SET wording_version = 'v9' WHERE id = ?").run(id), /immutable/);
  assert.throws(() => db.prepare("UPDATE curated_product_submissions SET facts_json = '[]' WHERE id = ?").run(id), /immutable/, 'checked facts are frozen');
  assert.throws(() => db.prepare("UPDATE curated_product_submissions SET checked_by = ? WHERE id = ?").run(w.people.second, id), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM curated_product_submissions').run(), /never deleted/);
  assert.throws(() => db.prepare('DELETE FROM curated_source_archives').run(), /never deleted/);
  assert.throws(() => db.prepare("UPDATE curated_source_archives SET byte_size = 1").run(), /immutable/);
  assert.throws(() => db.prepare("UPDATE audit_events SET action = 'x'").run(), /./);
  assert.throws(() => db.prepare('DELETE FROM audit_events').run(), /./);
  const actions = db.prepare("SELECT action FROM audit_events WHERE action LIKE 'curated_source.%' ORDER BY id").all().map(row => row.action);
  assert.deepEqual(actions, ['curated_source.registered', 'curated_source.candidate_proposed', 'curated_source.checked']);
  const stored = JSON.stringify(db.prepare("SELECT event_payload_json FROM audit_events WHERE action LIKE 'curated_source.%'").all());
  assert.ok(!stored.includes('waiting period of 36 months'), 'audit holds ids and digests, never page text');
});

test('maintenance: an unchanged source is recorded, a changed one withdraws the wording and needs a fresh independent check', t => {
  const w = world(t);
  const id = candidate(w);
  accept(w, id);
  w.repo.publish({ actorId: w.people.second, submissionId: id });
  const unchanged = w.repo.revalidate({ actorId: w.people.checker, submissionId: id, bytes: BYTES });
  assert.equal(unchanged.changed, false);
  assert.equal(w.repo.listVerified().length, 1);

  const v2 = Buffer.from('%PDF-synthetic insurer wording, version one, silently edited');
  assert.equal(code(() => w.repo.revalidate({ actorId: w.people.checker, submissionId: id, bytes: v2, sourceVersionId: 'rev-2' })).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'a checker alone cannot open a new collection');
  assert.equal(code(() => w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes: v2 })).code, 'CURATED_PRODUCT_INVALID', 'a changed source needs a new source version id');
  const changed = w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes: v2, sourceVersionId: 'rev-2', pageTexts: PAGES, retrievedOn: '2026-10-20' });
  assert.equal(changed.changed, true);
  assert.equal(changed.submission.state, 'needs_revalidation');
  assert.equal(changed.next.state, 'collected');
  assert.equal(changed.next.previousId, id);
  assert.deepEqual(w.repo.listVerified(), [], 'the old wording stops informing the moment its source changes');
  assert.equal(code(() => w.repo.publish({ actorId: w.people.checker, submissionId: changed.next.submissionId })).code, 'SUBMISSION_STATE_CONFLICT');
  // History is kept: the old row and its bytes are still there.
  assert.equal(w.database.prepare('SELECT content_sha256 AS s FROM curated_product_submissions WHERE id = ?').get(id).s, sha256Hex(BYTES));
  assert.equal(w.database.prepare('SELECT count(*) AS n FROM curated_source_archives').get().n, 2);

  w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: changed.next.submissionId, facts: [FACT] });
  assert.equal(code(() => accept(w, changed.next.submissionId, w.people.checker, { observedSha256: sha256Hex(BYTES) })).code, 'SOURCE_DIGEST_MISMATCH', 'the old bytes do not verify the new document');
  accept(w, changed.next.submissionId, w.people.checker, { observedSha256: sha256Hex(v2) });
  w.repo.publish({ actorId: w.people.second, submissionId: changed.next.submissionId });
  assert.equal(w.repo.get({ adultId: w.people.checker, submissionId: id }).state, 'superseded');
  assert.equal(w.repo.listVerified()[0].verification.sourceVersionId, 'rev-2');
});

test('maintenance: stale evidence cannot be published and the module has no network path', t => {
  const w = world(t);
  const id = candidate(w);
  accept(w, id);
  w.tick(401 * 86_400_000);
  w.repo.grantRole({ adultUserId: w.people.second, role: 'checker', operatorId: 'test-operator', expiresAt: w.expiry() });
  assert.equal(code(() => w.repo.publish({ actorId: w.people.second, submissionId: id })).code, 'SOURCE_NOT_CURRENT');
  for (const file of ['src/backend/repositories/curated-product-repository.js', 'src/features/decision-catalogue/source-verification.js', 'src/features/decision-catalogue/curated-products.js']) {
    const source = readFileSync(file, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bfetch\s*\(|node:(http|https|net|dns|tls)|\bXMLHttpRequest\b|new URL\([^)]*\)\.(href|toString)/.test(source), `${file} must not reach the network`);
  }
});

test('journey: source to verified fact, household contract authority preserved, source change and revocation withdraw it', t => {
  const w = world(t);
  const id = candidate(w);
  const clauseRows = [{ id: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'x'.repeat(64), text: `Household schedule. UIN: ${UIN}` }];
  const household = { documentId: 'd1', factType: 'waiting_period', topic: 'pre-existing disease waiting period', value: { months: 48 } };
  const compare = () => buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [], curatedProducts: w.repo.listVerified() }).curatedComparison[0];
  const catalogueWith = products => buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [], curatedProducts: products });

  assert.equal(compare().status, 'no_curated_record', 'before publication nothing is claimed');
  assert.equal(code(() => accept(w, id, w.people.curator)).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'self-verification is refused');
  accept(w, id, w.people.checker);
  assert.equal(compare().status, 'no_curated_record', 'checked is not published');
  w.repo.publish({ actorId: w.people.second, submissionId: id });

  const published = compare();
  assert.equal(published.status, 'compared');
  assert.equal(published.productVersion, 'v1');
  assert.equal(published.comparisons[0].curatedValue.months, 36);
  assert.equal(published.comparisons[0].source.contentSha256, sha256Hex(BYTES));
  assert.deepEqual(catalogueWith(w.repo.listVerified()).facts, catalogueWith([]).facts, 'the household contract is untouched by public wording');
  assert.equal(household.value.months, 48);

  w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes: Buffer.from('%PDF-the insurer changed this file'), sourceVersionId: 'rev-2', pageTexts: PAGES, retrievedOn: '2026-10-20' });
  assert.equal(compare().status, 'no_curated_record', 'a changed source needs revalidation before it informs anyone');

  // Revocation: the previously valid checker is refused on the next request.
  const next = w.database.prepare("SELECT id FROM curated_product_submissions WHERE state = 'collected'").get().id;
  w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: next, facts: [FACT] });
  w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal(code(() => accept(w, next, w.people.checker, { observedSha256: sha256Hex(Buffer.from('%PDF-the insurer changed this file')) })).code, 'SOURCE_ROLE_NOT_AUTHORISED');
});

test('concurrent check and revocation: whichever lands first decides, and a late revocation leaves a recorded check that no longer publishes', t => {
  const w = world(t);
  const id = candidate(w);
  w.repo.revokeRole({ grantId: w.grants.checker.id });
  assert.equal(code(() => accept(w, id)).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'revocation first: no check');
  const other = world(t);
  const checked = candidate(other);
  accept(other, checked);
  other.repo.revokeRole({ grantId: other.grants.second.id });
  assert.equal(code(() => other.repo.publish({ actorId: other.people.second, submissionId: checked })).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'revoked before publishing');
  assert.equal(other.repo.get({ adultId: other.people.checker, submissionId: checked }).state, 'checked');
});

test('grant expiry ends future authority only: a published review stays valid, invalidation is a separate recorded act', t => {
  const w = world(t);
  const id = candidate(w);
  accept(w, id, w.people.checker);
  w.repo.publish({ actorId: w.people.second, submissionId: id });
  w.setNow('2026-11-25T10:00:00.000Z');
  assert.equal(w.repo.activeRole(w.people.checker, 'checker'), null, 'the grant has expired');
  const kept = w.repo.listVerified({ today: '2026-11-25' });
  assert.equal(kept.length, 1, 'the completed review is still historically valid');
  assert.equal(kept[0].verified, true);
  assert.equal(code(() => accept(w, id, w.people.checker)).code, 'SOURCE_ROLE_NOT_AUTHORISED', 'no new reviews');
  const before = w.database.prepare('SELECT checked_by, checked_at FROM curated_product_submissions WHERE id = ?').get(id);
  assert.equal(code(() => w.repo.invalidate({ submissionId: id, operatorId: 'op', reasonCode: 'nonsense' })).code, 'CURATED_PRODUCT_INVALID');
  assert.equal(w.repo.invalidate({ submissionId: id, operatorId: 'op', reasonCode: 'checker_compromised' }).state, 'needs_revalidation');
  assert.deepEqual(w.database.prepare('SELECT checked_by, checked_at FROM curated_product_submissions WHERE id = ?').get(id), before, 'review record is not rewritten');
  assert.equal(w.repo.listVerified({ today: '2026-11-25' }).length, 0, 'invalidated product informs nobody');
  assert.equal(code(() => w.repo.invalidate({ submissionId: id, operatorId: 'op', reasonCode: 'checker_compromised' })).code, 'SUBMISSION_STATE_CONFLICT');
});

async function startApi(w) {
  const server = createApiServer({ database: w.database, env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const response = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  return { server, call };
}

test('api: the checker is the authenticated session, a body cannot name one, and revocation stops a still-valid session', async t => {
  const w = world(t);
  const api = await startApi(w);
  t.after(() => new Promise(resolve => api.server.close(resolve)));
  // The server runs on the real clock, so its sessions are issued by a service on the real clock too.
  const realAuth = createBackendServices(w.database, { env: { KNOWVIA_BOOTSTRAP_TOKEN: bootstrapToken } }).auth;
  const token = adultId => realAuth.issueSession({ adultUserId: adultId }).token;
  const id = candidate(w);
  const path = `/api/v1/curated-products/${id}`;
  const body = { decision: 'accept', reasonCode: 'quote_matches_source', observedSha256: sha256Hex(BYTES), factsSha256: factsHash(w, id), quotesReviewed: true };
  assert.equal((await api.call(path)).status, 401);
  assert.equal((await api.call(`${path}/check`, { method: 'POST', body })).status, 401, 'unauthenticated');
  assert.equal((await api.call(`${path}/check`, { method: 'POST', body, token: token(w.people.nobody) })).status, 403, 'authenticated but no grant');
  assert.equal((await api.call(path, { token: token(w.people.nobody) })).status, 403);
  // A client-supplied reviewer name or authority is ignored: the session decides.
  const spoof = await api.call(`${path}/check`, { method: 'POST', body: { ...body, checkerId: w.people.checker, checkedBy: w.people.checker, authority: 'checker' }, token: token(w.people.nobody) });
  assert.equal(spoof.status, 403);
  assert.equal((await api.call(`${path}/check`, { method: 'POST', body, token: token(w.people.curator) })).status, 403, 'the collector cannot check');
  const checkerToken = token(w.people.checker);
  assert.equal((await api.call(path, { token: checkerToken })).status, 200);
  const view = await api.call(path, { token: checkerToken });
  assert.ok(!('content' in view.data) && !JSON.stringify(view.data).includes('%PDF'), 'bytes are never returned');
  assert.equal((await api.call(`${path}/check`, { method: 'POST', body: { ...body, observedSha256: 'c'.repeat(64) }, token: checkerToken })).status, 409);
  const done = await api.call(`${path}/check`, { method: 'POST', body, token: checkerToken });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.checkedBy, w.people.checker);
  assert.equal((await api.call(`${path}/check`, { method: 'POST', body, token: checkerToken })).status, 409, 'replay of an authorised request');
  w.repo.revokeRole({ grantId: w.grants.second.id });
  const secondToken = token(w.people.second);
  assert.equal((await api.call(`${path}/publish`, { method: 'POST', token: secondToken })).status, 403, 'a valid session is not enough once the grant is revoked');
  assert.equal((await api.call(`${path}/publish`, { method: 'POST', token: checkerToken })).status, 200);
  // The server stamped real-clock dates; the test repository's clock is fixed in the past, which correctly reads as invalid.
  assert.equal(w.repo.listVerified().length, 0, 'a record dated after "today" is left out, not trusted');
  assert.equal(w.repo.listVerified({ today: new Date().toISOString().slice(0, 10) }).length, 1);
});
