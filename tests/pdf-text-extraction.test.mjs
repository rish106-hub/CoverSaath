// Byte-derived PDF page text (WP3): text comes from the document's own content streams and font maps, page by page, and
// fails closed per page when a glyph cannot be mapped. Synthetic PDFs only, generated here with pdf-lib.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { extractPdfPageTexts, parseToUnicode, PDF_TEXT_EXTRACTOR_VERSION } from '../src/features/input/pdf-text-extraction.js';
import { TEMPLATES, generateTemplate } from './support/synthetic-policies.mjs';

async function pdfWith(pages, { font = StandardFonts.Helvetica, compress = false } = {}) {
  const pdf = await PDFDocument.create();
  const embedded = await pdf.embedFont(font);
  for (const lines of pages) {
    const page = pdf.addPage([595, 842]);
    lines.forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 18, size: 10, font: embedded }));
  }
  return pdf.save({ useObjectStreams: compress });
}

// A page whose content stream is written by hand, with one font resource.
async function rawPage(content, fontDict) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]);
  const font = pdf.context.obj(fontDict(pdf));
  page.node.setFontDictionary(PDFName.of('F1'), pdf.context.register(font));
  const stream = pdf.context.flateStream(content);
  page.node.set(PDFName.of('Contents'), pdf.context.register(stream));
  return pdf.save();
}

test('text is derived from the bytes, page by page, with exact page numbers', async () => {
  const bytes = await pdfWith([['SYNTHETIC TEST DATA', 'UIN: SYNTHHLIP26002V012526', 'Wording version SW-2026-01'], ['Room rent is limited to Rs 5,000 per day – “single” room.']]);
  const result = await extractPdfPageTexts(bytes);
  assert.equal(result.extractor, PDF_TEXT_EXTRACTOR_VERSION);
  assert.equal(result.status, 'established');
  assert.deepEqual(result.pages.map(p => [p.page, p.status]), [[1, 'established'], [2, 'established']]);
  assert.equal(result.pages[0].text, 'SYNTHETIC TEST DATA\nUIN: SYNTHHLIP26002V012526\nWording version SW-2026-01');
  assert.equal(result.pages[1].text, 'Room rent is limited to Rs 5,000 per day – “single” room.');
  // Object streams change the file layout, not the derived text.
  assert.deepEqual((await extractPdfPageTexts(await pdfWith([['Same text']], { compress: true }))).pages[0].text, 'Same text');
});

test('every synthetic policy template: derived text equals the lines the generator drew, on the same page', async () => {
  const squash = s => s.replace(/\s+/g, ' ').trim();
  for (const name of Object.keys(TEMPLATES)) {
    for (const version of ['1', '2']) {
      const { bytes, pageTexts } = await generateTemplate(name, version);
      const result = await extractPdfPageTexts(bytes);
      assert.equal(result.status, 'established', `${name} v${version}`);
      assert.equal(result.pageCount, pageTexts.length);
      result.pages.forEach((page, i) => assert.equal(squash(page.text), squash(pageTexts[i]), `${name} v${version} page ${i + 1}`));
    }
  }
});

test('fail closed: an image-only page, an unmapped glyph, a Type0 font without ToUnicode, garbage and encrypted-looking files', async () => {
  const blank = await PDFDocument.create(); blank.addPage(); blank.addPage();
  const noText = await extractPdfPageTexts(await blank.save());
  assert.equal(noText.status, 'unestablished');
  assert.deepEqual(noText.pages.map(p => p.reason), ['no_text', 'no_text']);

  const mixed = await PDFDocument.create();
  const font = await mixed.embedFont(StandardFonts.Helvetica);
  mixed.addPage().drawText('Readable page', { x: 40, y: 700, font, size: 10 });
  mixed.addPage();
  const partial = await extractPdfPageTexts(await mixed.save());
  assert.equal(partial.status, 'unestablished', 'one unestablished page makes the document unestablished');
  assert.deepEqual(partial.pages.map(p => p.status), ['established', 'unestablished']);

  const type0 = await rawPage(Buffer.from('BT /F1 10 Tf 40 700 Td <00410042> Tj ET'), () => ({ Type: 'Font', Subtype: 'Type0', BaseFont: 'Synthetic', Encoding: 'Identity-H' }));
  assert.equal((await extractPdfPageTexts(type0)).pages[0].reason, 'font_without_unicode_map');

  const symbolic = await rawPage(Buffer.from('BT /F1 10 Tf 40 700 Td (abc) Tj ET'), () => ({ Type: 'Font', Subtype: 'TrueType', BaseFont: 'ABCDEF+SyntheticSymbol' }));
  assert.equal((await extractPdfPageTexts(symbolic)).pages[0].reason, 'font_encoding_unknown');

  const diff = await rawPage(Buffer.from('BT /F1 10 Tf 40 700 Td (\\001) Tj ET'), pdf => ({
    Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: pdf.context.obj({ Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [1, 'g123'] }),
  }));
  assert.equal((await extractPdfPageTexts(diff)).pages[0].reason, 'glyph_unmapped');

  const unknownFont = await rawPage(Buffer.from('BT /F9 10 Tf (x) Tj ET'), () => ({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' }));
  assert.equal((await extractPdfPageTexts(unknownFont)).pages[0].reason, 'font_missing');

  for (const junk of [Buffer.from('%PDF-1.7\nnot really a pdf'), Buffer.from('plain text'), new Uint8Array(0)]) {
    const r = await extractPdfPageTexts(junk);
    assert.equal(r.status, 'unestablished');
    assert.deepEqual(r.pages, []);
  }
});

test('ToUnicode maps decide the text of an embedded or composite font; an unmapped code fails the page', async () => {
  const cmap = Buffer.from(`/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
2 beginbfchar <0003> <0020> <0024> <20B9> endbfchar
1 beginbfrange <0010> <0012> <0055> endbfrange
1 beginbfrange <0020> <0021> [<0049> <004E>] endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`);
  const parsed = parseToUnicode(cmap);
  assert.deepEqual(parsed.lengths, [2]);
  assert.equal(parsed.map.get('0011'), 'V');
  const page = (content) => rawPage(Buffer.from(content), pdf => ({
    Type: 'Font', Subtype: 'Type0', BaseFont: 'Synthetic', Encoding: 'Identity-H', ToUnicode: pdf.context.register(pdf.context.flateStream(cmap)),
  }));
  const good = await extractPdfPageTexts(await page('BT /F1 10 Tf 40 700 Td <0010002000210003> Tj [<0024>-400<0011>] TJ ET'));
  assert.equal(good.status, 'established');
  assert.equal(good.pages[0].text, 'UIN ₹ V');
  const bad = await extractPdfPageTexts(await page('BT /F1 10 Tf 40 700 Td <00100099> Tj ET'));
  assert.equal(bad.pages[0].reason, 'glyph_unmapped');
});

test('limits: a page over the stream budget fails closed instead of reading on', async () => {
  const bytes = await pdfWith([['A line of synthetic text that is long enough to exceed a tiny budget']]);
  const result = await extractPdfPageTexts(bytes, { maxStreamBytes: 16 });
  assert.equal(result.pages[0].reason, 'content_too_large');
});

test('sandboxed extractor: the child derives the same text, refuses oversize input and fails closed on garbage', async () => {
  const { createSandboxedPdfTextExtractor } = await import('../src/features/input/index.js');
  const extractor = createSandboxedPdfTextExtractor();
  const bytes = await pdfWith([['UIN: SYNTHHLIP26002V012526'], ['Second page text']]);
  const result = await extractor.extract(bytes);
  assert.deepEqual(result, await extractPdfPageTexts(bytes));
  assert.ok(Object.isFrozen(result.pages));
  assert.equal((await extractor.extract(Buffer.from('%PDF-1.7 junk'))).status, 'unestablished');
  await assert.rejects(extractor.extract('not bytes'), error => error.code === 'INVALID_BYTES');
  await assert.rejects(createSandboxedPdfTextExtractor({ limits: { maxInputBytes: 8 } }).extract(bytes), error => error.code === 'FILE_TOO_LARGE');
  await assert.rejects(createSandboxedPdfTextExtractor({ limits: { timeoutMs: 1 } }).extract(bytes), error => error.code === 'PDF_TEXT_FAILED');
});

test('review fixes: invisible text, optional content and malformed content fail the page instead of feeding the checks', async () => {
  const helvetica = () => ({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' });
  const reason = async content => (await extractPdfPageTexts(await rawPage(Buffer.from(content), helvetica))).pages[0].reason ?? 'established';
  assert.equal(await reason('BT /F1 10 Tf 40 700 Td (Visible line) Tj ET BT /F1 10 Tf 3 Tr 40 680 Td (Hidden OCR layer UIN ABCHLIP99999V019999) Tj ET'), 'invisible_text');
  assert.equal(await reason('BT /F1 10 Tf 7 Tr (clip-only text) Tj ET'), 'invisible_text');
  assert.equal(await reason('q BT /F1 10 Tf 3 Tr ET Q BT /F1 10 Tf (Shown after restore) Tj ET'), 'established', 'q/Q restores the rendering mode');
  assert.equal(await reason('/OC /oc1 BDC BT /F1 10 Tf (Layer text) Tj ET EMC'), 'optional_content');
  assert.equal(await reason('BT /F1 10 Tf (First) Tj ET [ 1 2 BT /F1 10 Tf (Second UIN XYZ) Tj ET'), 'content_malformed');
  assert.equal(await reason('BT /F1 10 Tf (unterminated Tj ET'), 'content_malformed');
  assert.equal(await reason('BT /F1 10 Tf <4142 Tj ET'), 'content_malformed');
  assert.equal(await reason('BT /F1 10 Tf ] (x) Tj ET'), 'content_malformed');
  assert.equal(await reason('BT /F1 10 Tf (\\201\\215) Tj ET'), 'glyph_unmapped', 'undefined WinAnsi bytes are not C1 controls');
  assert.equal(await reason('BT /F1 10 Tf (caf\\351) Tj ET'), 'established');
  const empty = parseToUnicode(Buffer.from('begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <01> <> <02> <0041> endbfchar'));
  assert.equal(empty.map.has('01'), false, 'a code mapped to nothing is unmapped');
  const long = await extractPdfPageTexts(await pdfWith([Array.from({ length: 30 }, () => 'x'.repeat(60))]), { maxPageChars: 1000 });
  assert.equal(long.pages[0].reason, 'page_text_too_large', 'the limit is per page, not per line');
});
