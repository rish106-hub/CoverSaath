import test from 'node:test';
import assert from 'node:assert/strict';
import { degrees, PDFDocument } from 'pdf-lib';
import { createSandboxedPdfSegmenter } from '../src/features/input/index.js';

async function syntheticPdf(pageCount) {
  const document = await PDFDocument.create();
  for (let page = 1; page <= pageCount; page += 1) {
    document.addPage([300 + page, 400 + page]);
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

for (const pageCount of [1, 10, 11, 47, 100]) {
  test(`sandboxed PDF segmentation preserves all ${pageCount} pages in ordered ten-page batches`, async () => {
    const result = await createSandboxedPdfSegmenter().segment(await syntheticPdf(pageCount));
    assert.equal(result.pageCount, pageCount);
    assert.deepEqual(result.segments.map(segment => segment.originalPages.length),
      Array.from({ length: Math.ceil(pageCount / 10) }, (_, index) => Math.min(10, pageCount - index * 10)));
    assert.deepEqual(result.segments.flatMap(segment => segment.originalPages),
      Array.from({ length: pageCount }, (_, index) => index + 1));
    for (const segment of result.segments) {
      const parsed = await PDFDocument.load(segment.bytes);
      assert.equal(parsed.getPageCount(), segment.originalPages.length);
      assert.match(segment.contentSha256, /^[a-f0-9]{64}$/);
    }
  });
}

test('sandboxed PDF segmentation rejects malformed bytes without returning partial output', async () => {
  await assert.rejects(
    createSandboxedPdfSegmenter().segment(Buffer.from('%PDF- malformed synthetic input')),
    error => error.code === 'OCR_SEGMENTATION_FAILED',
  );
});

test('sandboxed PDF segmentation preserves rotated page geometry across a batch boundary', async () => {
  const document = await PDFDocument.create();
  for (let index = 0; index < 11; index += 1) {
    const page = document.addPage([300 + index, 400 + index]);
    if (index === 9 || index === 10) page.setRotation(degrees(index === 9 ? 90 : 270));
  }
  const result = await createSandboxedPdfSegmenter().segment(Buffer.from(await document.save({ useObjectStreams: false })));
  const first = await PDFDocument.load(result.segments[0].bytes);
  const second = await PDFDocument.load(result.segments[1].bytes);
  assert.deepEqual({
    width: first.getPage(9).getWidth(), height: first.getPage(9).getHeight(), rotation: first.getPage(9).getRotation().angle,
  }, { width: 309, height: 409, rotation: 90 });
  assert.deepEqual({
    width: second.getPage(0).getWidth(), height: second.getPage(0).getHeight(), rotation: second.getPage(0).getRotation().angle,
  }, { width: 310, height: 410, rotation: 270 });
});
