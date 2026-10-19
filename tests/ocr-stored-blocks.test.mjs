import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/backend/database/index.js';
import {
  AuditRepository, ConsentRepository, CoverageParameterRepository, DocumentRepository, OcrRepository,
} from '../src/backend/repositories/index.js';
import {
  OCR_BLOCKS_VERSION, OCR_BLOCK_LIMITS, OCR_MODEL_DESCRIPTION_TAGS, buildStoredBlocks, createFixtureOcrProvider,
  createOcrService, parseStoredBlocks, serializeStoredBlocks, validateOcrOutput,
} from '../src/modules/document-intake/index.js';
import { STRUCTURING_DROPPED_TAGS, sectionDocument, sectionStoredDocument } from '../src/modules/policy-structuring/sectioner.js';
import {
  BLOCKS_DOCUMENT, IMAGE_DESCRIPTION, inMemoryBlockPages, rawSarvamResult, sarvamShapedFixtureProvider, sarvamTransport,
} from './support/sarvam-blocks-fixture.mjs';

const AT = '2026-09-18T12:00:00.000Z';
const authorization = Object.freeze({
  authorized: true, consentGrantId: 'consent-ocr', requestedByAdultId: 'adult-ocr', purpose: 'document_processing',
});

function harness() {
  const database = openDatabase({ path: ':memory:' });
  for (const household of ['household-ocr', 'household-other']) {
    database.prepare('INSERT INTO households (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(household, 'Synthetic household', AT, AT);
  }
  database.prepare('INSERT INTO adult_users (id, display_name, account_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run('adult-ocr', 'Synthetic adult', 'active', AT, AT);
  database.prepare(`INSERT INTO household_roles (id, household_id, adult_user_id, role, status, created_at)
    VALUES ('role-ocr', 'household-ocr', 'adult-ocr', 'owner', 'active', ?)`).run(AT);
  database.prepare(`INSERT INTO consent_grants
    (id, household_id, subject_adult_id, granted_to_actor, purpose, notice_version, evidence_method, granted_at, created_at)
    VALUES ('consent-ocr', 'household-ocr', 'adult-ocr', 'knowvia', 'document_processing', 'v1', 'fixture', ?, ?)`).run(AT, AT);
  database.prepare(`INSERT INTO consent_scopes (id, consent_grant_id, resource_type, action, data_category, created_at)
    VALUES ('scope-ocr', 'consent-ocr', 'document', 'collect', 'insurance_document', ?)`).run(AT);
  const insertDocument = database.prepare(`INSERT INTO document_uploads
    (id, household_id, uploaded_by_adult_id, consent_grant_id, document_kind, original_filename, storage_path,
     content_sha256, mime_type, byte_size, malware_status, encryption_status, lifecycle_state, uploaded_at,
     logical_document_id, source_version)
    VALUES (?, 'household-ocr', 'adult-ocr', 'consent-ocr', 'policy_schedule', 'synthetic.pdf', ?, ?, 'application/pdf', 128,
      'not_scanned_fixture', 'fixture_only', 'quarantined', ?, ?, '3')`);
  insertDocument.run('document-ocr', 'fixture/document-ocr', BLOCKS_DOCUMENT.contentSha256, AT, 'policy-synthetic');
  insertDocument.run('document-v1', 'fixture/document-v1', 'c'.repeat(64), AT, 'policy-synthetic-v1');
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'active'").run();
  const repository = new OcrRepository(database);
  return { database, repository };
}

async function persistSarvamShaped(context, provider = sarvamShapedFixtureProvider()) {
  const service = createOcrService({ repository: context.repository, provider, mode: 'fixture', now: () => new Date(AT) });
  const job = await service.start({ documentId: 'document-ocr', authorization });
  assert.equal(job.status, 'succeeded');
  return job;
}

const blocksJson = (database, documentId = 'document-ocr') => database.prepare(
  'SELECT page_number, blocks_json FROM source_pages WHERE document_upload_id = ? ORDER BY page_number',
).all(documentId);

test('round trip: synthetic Sarvam blocks persist, read back and section exactly like the in-memory output', async t => {
  const context = harness();
  t.after(() => context.database.close());
  await persistSarvamShaped(context);

  const stored = context.repository.getDocumentBlockPages({ documentId: 'document-ocr', householdId: 'household-ocr' });
  assert.equal(stored.complete, true);
  assert.equal(stored.sourceVersion, '3');
  assert.deepEqual(stored.pages.map(page => [page.page, page.status, page.providerPageRef]),
    [[1, 'stored', 'blocks-job:page:1'], [2, 'stored', 'blocks-job:page:2']]);
  assert.ok(stored.pages.every(page => page.sourcePageId.startsWith('page-')));

  // Tags, block indices and reading order survive in provider reading order.
  assert.deepEqual(stored.pages[0].blocks.map(block => [block.index, block.tag, block.readingOrder]),
    [[0, 'header', 1], [1, 'headline', 2], [2, 'paragraph', 3], [3, 'image', 4], [4, 'page-number', 5]]);
  assert.deepEqual(stored.pages[1].blocks.map(block => [block.index, block.tag]),
    [[0, 'section-title'], [1, 'table'], [2, null], [3, 'image-caption'], [4, 'footer']]);
  // Table rows and cells survive (entities decoded, as the sectioner reads them).
  assert.deepEqual(stored.pages[1].blocks[1].rows,
    [['Benefit', 'Limit'], ['Room rent', '1% of sum insured'], ['Ambulance', 'Up to 2,000 & actuals']]);

  // The sectioner reads stored blocks and produces exactly what the in-memory blocks produce.
  const expected = sectionDocument(inMemoryBlockPages());
  assert.deepEqual(sectionStoredDocument(stored), expected);
  assert.ok(expected.chunks.some(chunk => chunk.kind === 'table'), 'the fixture exercises a table chunk');
  assert.ok(expected.dropped.some(item => item.reason === 'model_description'), 'the fixture exercises an image block');

  // No provider payload, coordinates or model-written image text is stored in the blocks.
  for (const { blocks_json: json } of blocksJson(context.database)) {
    for (const forbidden of [IMAGE_DESCRIPTION, 'Synthetic model caption', 'coordinates', 'bbox', 'block_id', 'confidence', 'p1-b']) {
      assert.equal(json.includes(forbidden), false, `blocks_json must not contain ${forbidden}`);
    }
    assert.equal(JSON.parse(json).version, OCR_BLOCKS_VERSION);
  }
  const page = context.database.prepare('SELECT output_contract_version FROM source_pages WHERE page_number = 1').get();
  assert.equal(page.output_contract_version, 'knowvia.ocr.v1', 'the page text contract is unchanged');
});

test('the default fixture OCR path stores blocks too', async t => {
  const context = harness();
  t.after(() => context.database.close());
  await persistSarvamShaped(context, createFixtureOcrProvider({ pages: [{ pageNumber: 1, text: 'Synthetic fixture page.' }] }));
  const stored = context.repository.getDocumentBlockPages({ documentId: 'document-ocr', householdId: 'household-ocr' });
  assert.equal(stored.complete, true);
  assert.deepEqual(stored.pages[0].blocks, [{ index: 0, tag: 'paragraph', readingOrder: 1, text: 'Synthetic fixture page.' }]);
});

test('a v1 page without blocks reads as blocks_unavailable and is never sectioned as complete', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const v1Provider = {
    ...sarvamShapedFixtureProvider(),
    async createJob({ document }) {
      return { status: 'succeeded', jobRef: 'v1-job', result: {
        schemaVersion: 'knowvia.ocr.v1',
        document: { id: document.documentId, sourceVersion: document.sourceVersion, contentSha256: document.contentSha256 },
        provider: { name: 'fixture', jobRef: 'v1-job' },
        pages: [{ pageNumber: 1, text: 'Synthetic v1 page text.' }],
      } };
    },
    normalizeResult: (result, expected) => validateOcrOutput(result, expected),
  };
  await persistSarvamShaped(context, v1Provider);
  assert.deepEqual(blocksJson(context.database).map(row => [row.page_number, row.blocks_json]), [[1, null]]);
  const stored = context.repository.getDocumentBlockPages({ documentId: 'document-ocr', householdId: 'household-ocr' });
  assert.equal(stored.complete, false);
  assert.deepEqual(stored.pages.map(page => [page.page, page.status, page.blocks]), [[1, 'blocks_unavailable', null]]);
  assert.throws(() => sectionStoredDocument(stored), error => error.code === 'STRUCTURING_BLOCKS_UNAVAILABLE'
    && error.pages.length === 1 && error.pages[0] === 1);
  assert.throws(() => sectionDocument(stored.pages), error => error.code === 'STRUCTURING_INPUT_INVALID');
  // v1 output cannot smuggle blocks past the v2 validator.
  assert.throws(() => validateOcrOutput({
    schemaVersion: 'knowvia.ocr.v1', document: { id: 'document-ocr', sourceVersion: '3', contentSha256: 'a'.repeat(64) },
    provider: { name: 'fixture' }, pages: [{ pageNumber: 1, text: 'x', blocks: [{ text: 'x', tag: null, readingOrder: 1 }] }],
  }), error => error.code === 'OCR_SCHEMA_INVALID');
});

test('a cross-household or erased-document read fails without revealing the document', async t => {
  const context = harness();
  t.after(() => context.database.close());
  await persistSarvamShaped(context);
  for (const householdId of ['household-other', 'household-missing', undefined]) {
    assert.throws(() => context.repository.getDocumentBlockPages({ documentId: 'document-ocr', householdId }),
      error => error.code === 'DOCUMENT_NOT_FOUND' && error.statusCode === 404);
  }
  assert.throws(() => context.repository.getDocumentBlockPages({ documentId: 'document-v1', householdId: 'household-ocr' }),
    error => error.code === 'OCR_PAGES_UNAVAILABLE');
});

test('revocation erases stored blocks through the repository step, without the trigger safety net', async t => {
  const context = harness();
  t.after(() => context.database.close());
  await persistSarvamShaped(context);
  assert.ok(blocksJson(context.database).every(row => row.blocks_json !== null));
  // Prove the repository erasure step on its own.
  context.database.exec('DROP TRIGGER source_pages_blocks_erase_with_text');
  context.database.exec('DROP TRIGGER source_pages_blocks_erase_on_document_erasure');
  new ConsentRepository(context.database, { clock: () => new Date(AT) })
    .revoke({ grantId: 'consent-ocr', revokedByAdultId: 'adult-ocr' });
  assert.deepEqual(blocksJson(context.database).map(row => row.blocks_json), [null, null]);
  assert.throws(() => context.repository.getDocumentBlockPages({ documentId: 'document-ocr', householdId: 'household-ocr' }),
    error => error.code === 'DOCUMENT_NOT_FOUND');
});

test('document erasure through the document repository erases stored blocks', async t => {
  const context = harness();
  t.after(() => context.database.close());
  await persistSarvamShaped(context);
  const clock = () => new Date(AT);
  const audit = new AuditRepository(context.database, { clock });
  const documents = new DocumentRepository(context.database, {
    clock, audit,
    coverageParameters: new CoverageParameterRepository(context.database, { clock, audit }),
    consents: new ConsentRepository(context.database, { clock, audit }),
  });
  documents.requestDeletion('document-ocr', { actorAdultId: 'adult-ocr' });
  assert.deepEqual(blocksJson(context.database).map(row => row.blocks_json), [null, null]);
  assert.equal(context.database.prepare("SELECT count(*) AS count FROM source_pages WHERE blocks_json IS NOT NULL").get().count, 0);
});

test('trigger safety nets erase blocks with page text and on document erasure; blocks are otherwise immutable', async t => {
  const context = harness();
  t.after(() => context.database.close());
  await persistSarvamShaped(context);
  const { database } = context;
  const [first, second] = database.prepare("SELECT id, blocks_json FROM source_pages WHERE document_upload_id = 'document-ocr' ORDER BY page_number").all();

  // Immutable: blocks cannot be replaced or re-added, only cleared.
  assert.throws(() => database.prepare('UPDATE source_pages SET blocks_json = ? WHERE id = ?').run(second.blocks_json, first.id),
    /source page blocks are immutable/);
  database.prepare('UPDATE source_pages SET blocks_json = blocks_json WHERE id = ?').run(first.id);

  // Redacting page text clears the blocks in the same statement.
  database.prepare('UPDATE source_pages SET extracted_text = NULL WHERE id = ?').run(first.id);
  assert.equal(database.prepare('SELECT blocks_json FROM source_pages WHERE id = ?').get(first.id).blocks_json, null);
  assert.throws(() => database.prepare('UPDATE source_pages SET blocks_json = ? WHERE id = ?').run(first.blocks_json, first.id),
    /source page blocks are immutable/);
  assert.notEqual(database.prepare('SELECT blocks_json FROM source_pages WHERE id = ?').get(second.id).blocks_json, null);

  // A document erasure request clears every remaining block of that document.
  database.prepare("UPDATE document_uploads SET lifecycle_state = 'deletion_requested' WHERE id = 'document-ocr'").run();
  assert.equal(database.prepare('SELECT blocks_json FROM source_pages WHERE id = ?').get(second.id).blocks_json, null);

  // Blocks cannot be inserted for an erased document or without page text.
  const insert = (id, documentId, text) => database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, page_number, source_version, page_sha256, extracted_text, extraction_status, created_at, blocks_json)
    VALUES (?, ?, 9, ?, ?, ?, 'extracted', ?, ?)`).run(id, documentId, `v-${id}`, 'd'.repeat(64), text, AT,
    serializeStoredBlocks(9, buildStoredBlocks([{ text: 'x', tag: null, readingOrder: 1 }], 'x')));
  assert.throws(() => insert('page-erased', 'document-ocr', 'x'), /require page text and a live document/);
  assert.throws(() => insert('page-no-text', 'document-v1', null), /require page text and a live document/);
  insert('page-live', 'document-v1', 'x');
});

test('the database CHECK rejects invalid, non-object and oversize blocks', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const insert = (id, json) => context.database.prepare(`INSERT INTO source_pages
    (id, document_upload_id, page_number, source_version, page_sha256, extracted_text, extraction_status, created_at, blocks_json)
    VALUES (?, 'document-v1', 1, ?, ?, 'x', 'extracted', ?, ?)`).run(id, `v-${id}`, 'd'.repeat(64), AT, json);
  assert.throws(() => insert('bad-json', '{not json'));
  assert.throws(() => insert('bad-array', '[]'), /CHECK constraint failed/);
  assert.throws(() => insert('bad-size', JSON.stringify({ pad: 'x'.repeat(OCR_BLOCK_LIMITS.maxStoredCharacters) })), /CHECK constraint failed/);
});

test('the block validator fails closed on missing, duplicate, reordered, unknown, oversize and tampered blocks', () => {
  const ok = [{ text: 'a', tag: 'paragraph', readingOrder: 1 }, { text: 'b', tag: 'table', readingOrder: 2 }];
  assert.equal(buildStoredBlocks(ok, 'a\nb').length, 2);
  const rejects = (fn, label) => assert.throws(fn, error => error.code === 'OCR_BLOCKS_INVALID', label);
  rejects(() => buildStoredBlocks(ok.slice(0, 1), 'a\nb'), 'missing block');
  rejects(() => buildStoredBlocks([...ok, ok[1]], 'a\nb'), 'duplicate block');
  rejects(() => buildStoredBlocks([ok[1], ok[0]], 'b\na'), 'reordered block');
  rejects(() => buildStoredBlocks([{ ...ok[0], tag: 'marquee' }, ok[1]], 'a\nb'), 'unknown tag');
  rejects(() => buildStoredBlocks([{ ...ok[0], tag: 7 }, ok[1]], 'a\nb'), 'non-string tag');
  rejects(() => buildStoredBlocks([{ ...ok[0], readingOrder: Number.NaN }, ok[1]], 'a\nb'), 'invalid reading order');
  const long = 'x'.repeat(OCR_BLOCK_LIMITS.maxBlockTextCharacters + 1);
  rejects(() => buildStoredBlocks([{ text: long, tag: null, readingOrder: 1 }], long), 'oversize block');
  rejects(() => buildStoredBlocks(Array.from({ length: OCR_BLOCK_LIMITS.maxBlocksPerPage + 1 }, () => ({ text: '', tag: null, readingOrder: 1 })), ''), 'too many blocks');
  rejects(() => buildStoredBlocks('not blocks', ''), 'not an array');

  // Stored form: index must equal position; tampered rows, kept image text and extra fields fail.
  const stored = buildStoredBlocks([...ok, { text: 'model text', tag: 'image', readingOrder: 3 }], 'a\nb\nmodel text');
  assert.deepEqual(stored[2], { index: 2, tag: 'image', readingOrder: 3, text: '', textOmitted: 'model_description' });
  const json = serializeStoredBlocks(4, stored);
  assert.deepEqual(parseStoredBlocks(json, 4), stored);
  const envelope = () => JSON.parse(json);
  const tamper = (change, label) => {
    const value = envelope();
    change(value);
    rejects(() => parseStoredBlocks(JSON.stringify(value), 4), label);
  };
  tamper(value => { value.blocks[1].index = 0; }, 'duplicate index');
  tamper(value => { value.blocks.splice(0, 1); }, 'missing index');
  tamper(value => { value.blocks.reverse(); }, 'reordered');
  tamper(value => { value.blocks[0].tag = 'marquee'; }, 'unknown tag');
  tamper(value => { value.blocks[1].rows = [['forged']]; }, 'forged table rows');
  tamper(value => { value.blocks[2].text = 'model text'; }, 'image text kept');
  tamper(value => { value.blocks[0].coordinates = [0, 0, 1, 1]; }, 'extra provider field');
  tamper(value => { value.blocks[0].textOmitted = 'model_description'; }, 'text omitted on a document block');
  tamper(value => { value.version = 'knowvia.ocr.v1'; }, 'wrong version');
  tamper(value => { value.page = 5; }, 'wrong page');
  rejects(() => parseStoredBlocks('{not json', 4), 'malformed JSON');
  rejects(() => serializeStoredBlocks(4, stored.map((block, index) => (index === 0 ? { ...block, index: 1 } : block))), 'serialize validates');
});

test('the repository refuses to persist a page whose blocks fail validation', async t => {
  const context = harness();
  t.after(() => context.database.close());
  const job = context.repository.createJob({
    id: 'ocr-invalid-blocks', documentUploadId: 'document-ocr', provider: 'fixture', status: 'processing',
    contractVersion: 'knowvia.ocr.v1', authorization, requestedAt: AT, updatedAt: AT,
  });
  const normalized = validateOcrOutput(sarvamTransport().normalizeResult(rawSarvamResult(), BLOCKS_DOCUMENT), BLOCKS_DOCUMENT);
  const pages = normalized.pages.map(page => ({
    ...page, documentUploadId: 'document-ocr', sourceVersion: '3', outputContractVersion: 'knowvia.ocr.v1', createdAt: AT,
  }));
  const forged = pages.map((page, index) => (index === 1 ? { ...page, blocks: [...page.blocks].reverse() } : page));
  assert.throws(() => context.repository.completeJob(job.id, forged, { status: 'succeeded', completedAt: AT, updatedAt: AT }),
    error => error.code === 'OCR_BLOCKS_INVALID');
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages').get().count, 0, 'nothing partial is stored');
  context.repository.completeJob(job.id, pages, { status: 'succeeded', completedAt: AT, updatedAt: AT });
  assert.equal(context.database.prepare('SELECT count(*) AS count FROM source_pages WHERE blocks_json IS NOT NULL').get().count, 2);
});

test('stored blocks drop exactly the tags the sectioner treats as model descriptions', () => {
  assert.deepEqual([...OCR_MODEL_DESCRIPTION_TAGS].sort(),
    Object.entries(STRUCTURING_DROPPED_TAGS).filter(([, reason]) => reason === 'model_description').map(([tag]) => tag).sort());
});
