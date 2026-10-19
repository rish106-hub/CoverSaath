import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OCR_BLOCK_LIMITS, parseStoredBlocks, serializeStoredBlocks, validateOcrOutput,
} from '../src/features/input/index.js';
import { sectionDocument, sectionStoredDocument } from '../src/features/policy-structuring/sectioner.js';
import { postgresTestOptions, useTestDatabase } from './support/postgres.mjs';
import { assertConstraintRejects, hex, insert, seedWorld } from './support/postgres-fixtures.mjs';
import { BLOCKS_DOCUMENT, IMAGE_DESCRIPTION, inMemoryBlockPages, rawSarvamResult, sarvamTransport } from './support/sarvam-blocks-fixture.mjs';

// Stored blocks on PostgreSQL (ADR 0004 parity): the same serialised blocks survive save and read and
// section exactly like the in-memory Sarvam output.
test('PostgreSQL keeps tables, layout tags, block indices and page references of stored blocks', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const normalized = validateOcrOutput(sarvamTransport().normalizeResult(rawSarvamResult(), BLOCKS_DOCUMENT), BLOCKS_DOCUMENT);
  for (const page of normalized.pages) {
    await insert(pool, 'source_pages', {
      id: `blocks-page-${page.pageNumber}`, document_upload_id: a.document, ocr_job_id: a.ocr, page_number: page.pageNumber,
      source_version: 'version-blocks', page_sha256: page.textSha256, extracted_text: page.text,
      provider_page_ref: page.providerPageRef, blocks_json: serializeStoredBlocks(page.pageNumber, page.blocks),
    });
  }
  const rows = (await pool.query(`SELECT id, page_number, provider_page_ref, blocks_json FROM source_pages
    WHERE document_upload_id = $1 AND source_version = 'version-blocks' ORDER BY page_number`, [a.document])).rows;
  const stored = {
    pages: rows.map(row => ({
      page: Number(row.page_number), sourcePageId: row.id, providerPageRef: row.provider_page_ref,
      status: row.blocks_json == null ? 'blocks_unavailable' : 'stored', blocks: parseStoredBlocks(row.blocks_json, Number(row.page_number)),
    })),
  };
  assert.deepEqual(stored.pages.map(page => [page.page, page.providerPageRef]), [[1, 'blocks-job:page:1'], [2, 'blocks-job:page:2']]);
  assert.deepEqual(stored.pages.map(page => page.blocks), normalized.pages.map(page => page.blocks), 'blocks are byte-for-byte preserved');
  assert.deepEqual(stored.pages[1].blocks[1].rows[2], ['Ambulance', 'Up to 2,000 & actuals']);
  assert.deepEqual(stored.pages[0].blocks.map(block => block.tag), ['header', 'headline', 'paragraph', 'image', 'page-number']);
  assert.deepEqual(sectionStoredDocument(stored), sectionDocument(inMemoryBlockPages()));
  assert.ok(rows.every(row => !row.blocks_json.includes(IMAGE_DESCRIPTION) && !row.blocks_json.includes('coordinates')));
});

test('PostgreSQL blocks CHECK rejects invalid, non-object and oversize JSON', postgresTestOptions(), async t => {
  const { pool } = await useTestDatabase(t);
  const a = await seedWorld(pool, 'a');
  const page = (id, json) => insert(pool, 'source_pages', {
    id, document_upload_id: a.document, ocr_job_id: a.ocr, page_number: 20, source_version: `v-${id}`,
    page_sha256: hex('e'), extracted_text: 'x', blocks_json: json,
  });
  await assertConstraintRejects(page('bad-json', '{not json'), '23514');
  await assertConstraintRejects(page('bad-array', '[]'), '23514');
  await assertConstraintRejects(page('bad-size', JSON.stringify({ pad: 'x'.repeat(OCR_BLOCK_LIMITS.maxStoredCharacters) })), '23514');
});
