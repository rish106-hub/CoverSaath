import test from 'node:test';
import assert from 'node:assert/strict';
import { OCR_BLOCK_TAGS } from '../src/features/input/ocr-blocks.js';
import { SARVAM_LAYOUT_TAGS, sarvamBlockShape, sarvamLayoutTag } from '../src/integrations/sarvam/doc-ai-transport.js';

test('the Sarvam adapter tag list equals the stored-block contract list', () => {
  assert.deepEqual([...SARVAM_LAYOUT_TAGS].sort(), [...OCR_BLOCK_TAGS].sort());
});

test('reference, seen in live Sarvam output, is a known tag', () => {
  assert.equal(sarvamLayoutTag('reference'), 'reference');
});

test('an unknown, empty or non-string tag becomes null and the block text is kept', () => {
  for (const tag of ['bibliography-v9', '', 42, null, undefined, { a: 1 }]) assert.equal(sarvamLayoutTag(tag), null);
  assert.deepEqual(sarvamBlockShape({ text: 'Synthetic clause text.', layout_tag: 'new-future-tag', reading_order: 3 }),
    { text: 'Synthetic clause text.', tag: null, readingOrder: 3 });
});
