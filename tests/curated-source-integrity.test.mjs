// Curated insurer-source integrity: real (synthetic) PDF bytes through the whole workflow, archive tampering after
// publication, and the operator CLI's successful path. Synthetic documents and identities only, in temporary databases.
// Tampering is simulated by dropping the immutability triggers, which an edit made outside the application can do.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { testTempRoot as tmpdir } from './support/temp-root.mjs';
import { openDatabase } from '../src/backend/database/index.js';
import { createBackendServices } from '../src/backend/services/index.js';
import { buildDecisionCatalogue, sha256Hex } from '../src/features/decision-catalogue/index.js';
import { checkerKeyring } from './support/curated-keys.mjs';
import { inProcessPdfText } from './support/curated-text.mjs';

const UIN = 'SYNTHHLIP26002V012526';
const PAGES = [
  ['SYNTHETIC TEST DATA - NOT A REAL POLICY', 'Synthetic Assurance Ltd', `UIN: ${UIN}`, 'Policy wording version SW-2026-01'],
  ['SYNTHETIC TEST DATA - NOT A REAL POLICY', 'Room rent is limited to Rs 5,000 per day for a single private room.'],
];
const PAGE_TEXTS = PAGES.map(lines => lines.join('\n'));
const FACT = { factType: 'room_rent_limit', topic: 'general', value: { kind: 'amount', amountMinor: 500000, currency: 'INR', basis: 'per_day' }, page: 2, quote: 'Room rent is limited to Rs 5,000 per day' };

// A real PDF with fixed metadata, so the digest is the same on every run.
async function syntheticPdf(pages = PAGES) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fixed = new Date('2026-01-01T00:00:00.000Z');
  pdf.setTitle('SYNTHETIC TEST DATA'); pdf.setProducer('coversaath-tests'); pdf.setCreator('coversaath-tests');
  pdf.setCreationDate(fixed); pdf.setModificationDate(fixed);
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 18, size: 10, font }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

function world(t, { hosts = 'wording.synthetic-insurer.test' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'coversaath-curated-integrity-'));
  const path = join(directory, 'app.sqlite');
  const database = openDatabase({ path });
  const services = createBackendServices(database, { env: { CURATED_SOURCE_HOSTS: hosts }, pdfText: inProcessPdfText });
  const adult = name => services.households.createAdult({ displayName: `Synthetic ${name}` }).id;
  const people = { curator: adult('curator'), checker: adult('checker') };
  const repo = services.curatedProducts;
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  repo.grantRole({ adultUserId: people.curator, role: 'curator', operatorId: 'test-operator', expiresAt });
  const keys = checkerKeyring();
  repo.grantRole({ adultUserId: people.checker, role: 'checker', operatorId: 'test-operator', expiresAt, publicKey: keys.publicKey(people.checker) });
  t.after(() => { try { database.close(); } catch { /* already closed */ } rmSync(directory, { recursive: true, force: true }); });
  return { directory, path, database, repo, people, keys };
}

const identity = (over = {}) => ({
  uin: UIN, insurer: 'Synthetic Assurance Ltd', productName: 'Synthetic Health Plan', wordingVersion: 'SW-2026-01',
  sourceUrl: 'https://wording.synthetic-insurer.test/sw-2026-01.pdf', sourceVersionId: 'rev-1', retrievedOn: new Date().toISOString().slice(0, 10), ...over,
});

async function published(w) {
  const bytes = await syntheticPdf();
  const reg = await w.repo.register({ curatorId: w.people.curator, ...identity(), bytes, pageTexts: PAGE_TEXTS, claimedSha256: sha256Hex(bytes) });
  w.repo.proposeFacts({ curatorId: w.people.curator, submissionId: reg.submissionId, facts: [FACT] });
  const factsSha256 = sha256Hex(w.database.prepare('SELECT facts_json FROM curated_product_submissions WHERE id = ?').get(reg.submissionId).facts_json);
  const attest = { submissionId: reg.submissionId, observedSha256: sha256Hex(bytes), factsSha256 };
  w.repo.check({ signedAction: w.keys.sign('check', w.people.checker, { ...attest, decision: 'accept', reasonCode: 'quote_matches_source', quotesReviewed: true }) });
  w.repo.publish({ signedAction: w.keys.sign('publish', w.people.checker, attest) });
  return { id: reg.submissionId, bytes };
}

test('real PDF bytes: the digest is computed from the stored bytes, deterministic, and a wrong claim is refused', async t => {
  const w = world(t);
  const bytes = await syntheticPdf();
  assert.equal(sha256Hex(await syntheticPdf()), sha256Hex(bytes), 'the synthetic PDF is byte-for-byte reproducible');
  assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-');
  const wrong = await (async () => { try { await w.repo.register({ curatorId: w.people.curator, ...identity(), bytes, pageTexts: PAGE_TEXTS, claimedSha256: 'a'.repeat(64) }); } catch (error) { return error; } })();
  assert.equal(wrong.code, 'SOURCE_EVIDENCE_REJECTED');
  assert.deepEqual(wrong.details, ['digest_mismatch']);
  const reg = await w.repo.register({ curatorId: w.people.curator, ...identity(), bytes, pageTexts: PAGE_TEXTS });
  const archived = w.database.prepare('SELECT content FROM curated_source_archives WHERE sha256 = ?').get(sha256Hex(bytes)).content;
  assert.equal(sha256Hex(archived), sha256Hex(bytes), 'the archive holds exactly the bytes supplied');
  assert.equal((await w.repo.register({ curatorId: w.people.curator, ...identity(), bytes, pageTexts: PAGE_TEXTS })).replayed, true, 'a repeat registration is idempotent');
  assert.equal(w.database.prepare('SELECT count(*) AS n FROM curated_product_submissions').get().n, 1);
  assert.equal(reg.state, 'collected');
});

test('a published product whose archived bytes were altered stops being verified at once', async t => {
  const w = world(t);
  const { id, bytes } = await published(w);
  assert.equal(w.repo.listVerified().length, 1);
  assert.deepEqual(await w.repo.verifyPublishedArchives(), [{ submissionId: id, uin: UIN, ok: true, blocking: [], textOrigin: 'derived_from_bytes', extractor: inProcessPdfText.version }]);

  w.database.exec('DROP TRIGGER curated_source_archives_immutable');
  const damaged = Buffer.from(bytes); damaged[damaged.length - 20] ^= 0xff;
  w.database.prepare('UPDATE curated_source_archives SET content = ? WHERE sha256 = ?').run(damaged, sha256Hex(bytes));

  assert.deepEqual(w.repo.listVerified(), [], 'a corrupted archive produces no trusted facts');
  const [report] = await w.repo.verifyPublishedArchives();
  assert.equal(report.ok, false);
  assert.deepEqual(report.blocking, ['digest_mismatch']);
  const clauseRows = [{ id: 'c1', documentId: 'd1', sourceVersion: 'v1', page: 1, digest: 'x'.repeat(64), text: `Schedule. UIN: ${UIN}` }];
  const comparison = buildDecisionCatalogue({ householdId: 'h1', batches: [], clauseRows, policies: [], curatedProducts: w.repo.listVerified() }).curatedComparison[0];
  assert.equal(comparison.status, 'no_curated_record', 'the household sees unknown, never the damaged terms');
  assert.equal(w.database.prepare('SELECT state FROM curated_product_submissions WHERE id = ?').get(id).state, 'published', 'history is kept; the read refuses it');
  w.database.close();
  const run = () => { try { execFileSync(process.execPath, ['scripts/curated-source.mjs', 'verify-archives'], { env: { ...process.env, DATABASE_PATH: relative(process.cwd(), w.path) }, stdio: 'pipe' }); return 0; } catch (error) { return error.status; } };
  assert.equal(run(), 2, 'the CLI exit status reports a damaged archive');
});

test('stored facts edited into a wrong shape are refused on read without an exception', async t => {
  const w = world(t);
  const { id } = await published(w);
  w.database.exec('DROP TRIGGER curated_product_submissions_content_immutable');
  // The CHECK constraint keeps facts_json a JSON array, so the reachable damage is a wrong element shape.
  assert.throws(() => w.database.prepare("UPDATE curated_product_submissions SET facts_json = 'not json' WHERE id = ?").run(id), /CHECK constraint/);
  w.database.prepare("UPDATE curated_product_submissions SET facts_json = '[1]' WHERE id = ?").run(id);
  assert.deepEqual(w.repo.listVerified(), [], 'no exception, and no trusted facts');
  const [report] = await w.repo.verifyPublishedArchives();
  assert.equal(report.ok, false);
});

test('a published product whose archive row is missing is not verified', async t => {
  const w = world(t);
  const { bytes } = await published(w);
  w.database.exec('PRAGMA foreign_keys = OFF; DROP TRIGGER curated_source_archives_no_delete;');
  w.database.prepare('DELETE FROM curated_source_archives WHERE sha256 = ?').run(sha256Hex(bytes));
  assert.deepEqual(w.repo.listVerified(), []);
  assert.deepEqual((await w.repo.verifyPublishedArchives())[0].blocking, ['source_bytes_invalid']);
});

test('page text edited outside the application after publication is caught on the next read', async t => {
  const w = world(t);
  const { id } = await published(w);
  w.database.exec('DROP TRIGGER curated_product_submissions_content_immutable');
  const edited = JSON.stringify([PAGE_TEXTS[0], 'Room rent is at actuals.']);
  w.database.prepare('UPDATE curated_product_submissions SET page_texts_json = ? WHERE id = ?').run(edited, id);
  assert.deepEqual(w.repo.listVerified(), []);
  assert.deepEqual((await w.repo.verifyPublishedArchives())[0].blocking, ['quote_not_on_page:0']);
});

test('stored page text edited so the quotes still match is caught by verify-archives re-deriving it from the bytes', async t => {
  const w = world(t);
  const { id } = await published(w);
  w.database.exec('DROP TRIGGER curated_product_submissions_content_immutable');
  const edited = JSON.stringify([PAGE_TEXTS[0], `${PAGE_TEXTS[1]}\nNo exclusions apply.`]);
  w.database.prepare('UPDATE curated_product_submissions SET page_texts_json = ? WHERE id = ?').run(edited, id);
  assert.deepEqual((await w.repo.verifyPublishedArchives())[0].blocking, ['derived_text_changed']);
});

test('a row whose text was not derived from its bytes never reads as verified', async t => {
  const w = world(t);
  const { id } = await published(w);
  w.database.exec('DROP TRIGGER curated_product_submissions_text_origin_immutable');
  for (const [origin, version] of [['curator_supplied', inProcessPdfText.version], ['derived_from_bytes', 'an-older-extractor/v0'], [null, null]]) {
    w.database.prepare('UPDATE curated_product_submissions SET page_text_origin = ?, text_extractor_version = ? WHERE id = ?').run(origin, version, id);
    assert.deepEqual(w.repo.listVerified(), [], `${origin} / ${version}`);
    assert.deepEqual((await w.repo.verifyPublishedArchives())[0].blocking, ['page_text_not_derived']);
  }
});

test('recovery: text from an older extractor, or an invalidated review, is re-opened from the same bytes and verified again', async t => {
  const w = world(t);
  const { id, bytes } = await published(w);
  const factsSha256 = () => sha256Hex(w.database.prepare("SELECT facts_json FROM curated_product_submissions WHERE state = 'candidate'").get().facts_json);
  const republish = async submissionId => {
    w.repo.proposeFacts({ curatorId: w.people.curator, submissionId, facts: [FACT] });
    const attest = { submissionId, observedSha256: sha256Hex(bytes), factsSha256: factsSha256() };
    w.repo.check({ signedAction: w.keys.sign('check', w.people.checker, { ...attest, decision: 'accept', reasonCode: 'quote_matches_source', quotesReviewed: true }) });
    return w.repo.publish({ signedAction: w.keys.sign('publish', w.people.checker, attest) });
  };
  // Simulate rows written by an older extractor (an extractor version bump).
  w.database.exec('DROP TRIGGER curated_product_submissions_text_origin_immutable');
  w.database.prepare("UPDATE curated_product_submissions SET text_extractor_version = 'pdf-content-text/v0' WHERE id = ?").run(id);
  assert.deepEqual(w.repo.listVerified(), []);
  const replay = await (async () => { try { await w.repo.register({ curatorId: w.people.curator, ...identity(), bytes }); } catch (e) { return e; } })();
  assert.equal(replay.code, 'SOURCE_REVALIDATION_REQUIRED', 're-registering the same file is not a silent replay of a stale row');
  const byChecker = await (async () => { try { await w.repo.revalidate({ actorId: w.people.checker, submissionId: id, bytes }); } catch (e) { return e; } })();
  assert.equal(byChecker.code, 'SOURCE_ROLE_NOT_AUTHORISED', 'only the collector re-opens');
  const reopened = await w.repo.revalidate({ actorId: w.people.curator, submissionId: id, bytes });
  assert.equal(reopened.reason, 'text_rederived');
  assert.equal(reopened.submission.state, 'needs_revalidation');
  assert.equal(reopened.next.textExtractorVersion, inProcessPdfText.version);
  assert.equal(reopened.next.sourceVersionId, 'rev-1', 'same bytes keep the source version');
  assert.equal((await republish(reopened.next.submissionId)).state, 'published');
  assert.equal(w.repo.listVerified().length, 1);
  assert.equal(w.database.prepare('SELECT state FROM curated_product_submissions WHERE id = ?').get(id).state, 'superseded');

  // An invalidated review is re-opened the same way.
  const current = reopened.next.submissionId;
  w.repo.invalidate({ submissionId: current, operatorId: 'test-operator', reasonCode: 'checker_compromised' });
  const again = await w.repo.revalidate({ actorId: w.people.curator, submissionId: current, bytes });
  assert.equal(again.reason, 'review_invalidated');
  assert.equal(again.submission.state, 'superseded');
  assert.equal((await republish(again.next.submissionId)).state, 'published');
  assert.equal(w.repo.listVerified().length, 1);
  // A usable row with the same bytes is still only recorded.
  const unchanged = await w.repo.revalidate({ actorId: w.people.curator, submissionId: again.next.submissionId, bytes });
  assert.equal(unchanged.changed, false);
});

test('conflicting registrations: a second document for the same UIN and version is refused, the first is kept', async t => {
  const w = world(t);
  const first = await syntheticPdf();
  const second = await syntheticPdf([...PAGES, ['SYNTHETIC TEST DATA - NOT A REAL POLICY', 'An extra page.']]);
  await w.repo.register({ curatorId: w.people.curator, ...identity(), bytes: first, pageTexts: PAGE_TEXTS });
  const error = await (async () => { try { await w.repo.register({ curatorId: w.people.curator, ...identity({ sourceVersionId: 'rev-2' }), bytes: second, pageTexts: null }); } catch (e) { return e; } })();
  assert.equal(error.code, 'SOURCE_VERSION_CONFLICT');
  assert.equal(w.database.prepare('SELECT count(*) AS n FROM curated_product_submissions').get().n, 1);
  assert.equal(w.database.prepare('SELECT content_sha256 AS sha FROM curated_product_submissions').get().sha, sha256Hex(first));
});

test('operator CLI: keygen, keyed grant, register, propose, signed check and publish, replay refused, verify-archives', async t => {
  const w = world(t);
  const bytes = await syntheticPdf();
  const files = {
    meta: join(w.directory, 'metadata.json'), pdf: join(w.directory, 'wording.pdf'), pages: join(w.directory, 'pages.json'), facts: join(w.directory, 'facts.json'),
    key: join(w.directory, 'checker-2.pem'), checkAction: join(w.directory, 'check.json'), publishAction: join(w.directory, 'publish.json'),
  };
  writeFileSync(files.meta, JSON.stringify(identity())); writeFileSync(files.pdf, bytes); writeFileSync(files.pages, JSON.stringify(PAGE_TEXTS)); writeFileSync(files.facts, JSON.stringify([FACT]));
  const second = createBackendServices(w.database).households.createAdult({ displayName: 'Synthetic CLI checker' }).id;
  w.database.close();
  const env = { ...process.env, DATABASE_PATH: relative(process.cwd(), w.path), CURATED_SOURCE_HOSTS: 'wording.synthetic-insurer.test', CURATED_KEY_PASSPHRASE: 'synthetic-test-passphrase' };
  const run = (...args) => execFileSync(process.execPath, ['scripts/curated-source.mjs', ...args], { env, encoding: 'utf8', stdio: 'pipe' });
  const cli = (...args) => JSON.parse(run(...args));
  const refused = (...args) => { try { run(...args); } catch (error) { return { status: error.status, stderr: String(error.stderr) }; } return assert.fail('expected the CLI to fail'); };

  const key = cli('keygen', files.key);
  assert.equal(key.encrypted, true);
  assert.match(readFileSync(files.key, 'utf8'), /BEGIN ENCRYPTED PRIVATE KEY/);
  assert.equal(statSync(files.key).mode & 0o077, 0, 'the private key is readable by its owner only');
  assert.equal(refused('keygen', files.key).status, 1, 'an existing key file is never overwritten');
  assert.match(refused('grant-role', second, 'checker', 'test-operator', new Date(Date.now() + 86_400_000).toISOString()).stderr, /publicKey/, 'a checker grant needs a key');
  cli('grant-role', second, 'checker', 'test-operator', new Date(Date.now() + 86_400_000).toISOString(), key.publicKey);

  const reg = cli('register', w.people.curator, files.meta, files.pdf, files.pages);
  assert.equal(reg.state, 'collected');
  assert.equal(reg.contentSha256, sha256Hex(bytes));
  assert.equal(reg.pageTexts, undefined, 'page text is not echoed');
  assert.equal(cli('propose', w.people.curator, reg.submissionId, files.facts).state, 'candidate');
  const shownText = run('show', second, reg.submissionId);
  const shown = JSON.parse(shownText);
  assert.equal(shown.contentSha256, undefined, 'the digest is withheld; the checker hashes their own copy');
  const reviewed = join(w.directory, 'reviewed.json');
  writeFileSync(reviewed, shownText);
  // The facts digest is computed from the facts the checker reviewed, so a file differing from the submission is refused.
  const other = join(w.directory, 'other-facts.json');
  writeFileSync(other, JSON.stringify([{ ...FACT, value: { ...FACT.value, amountMinor: 900000 } }]));
  writeFileSync(files.checkAction, run('sign-check', files.key, second, reg.submissionId, 'accept', 'quote_matches_source', files.pdf, other, '--quotes-reviewed'));
  assert.match(refused('check', files.checkAction).stderr, /FACTS_CHANGED/);

  // An operator naming the checker without a signature gets nothing: check and publish take only a signed action file.
  writeFileSync(files.checkAction, JSON.stringify({ checkerId: second, submissionId: reg.submissionId, decision: 'accept' }));
  assert.match(refused('check', files.checkAction).stderr, /SOURCE_ACTION_MALFORMED/);
  writeFileSync(files.checkAction, run('sign-check', files.key, second, reg.submissionId, 'accept', 'quote_matches_source', files.pdf, reviewed, '--quotes-reviewed'));
  assert.equal(cli('check', files.checkAction).state, 'checked');
  assert.match(refused('check', files.checkAction).stderr, /SOURCE_ACTION_REPLAYED/, 'a signed check is applied once');
  writeFileSync(files.publishAction, run('sign-publish', files.key, second, reg.submissionId, files.pdf, reviewed));
  assert.equal(cli('publish', files.publishAction).state, 'published');
  assert.match(refused('publish', files.publishAction).stderr, /SOURCE_ACTION_REPLAYED/);
  assert.deepEqual(cli('verify-archives').map(row => row.ok), [true]);
});
