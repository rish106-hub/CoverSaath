import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { inspectPdf } from '../src/features/input/pdf-inspection.js';
import { sanitizePdf } from '../src/features/input/pdf-sanitize.js';
import { extractPdfPageTexts } from '../src/features/input/pdf-text-extraction.js';

// Synthetic PDF: two pages of text, an OpenAction and a document JavaScript, a link annotation with a URI action,
// and an embedded-files name tree. Nothing here is real data.
async function activePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const line of ['Synthetic policy page one', 'Synthetic policy page two']) {
    const page = doc.addPage([300, 200]);
    page.drawText(line, { x: 20, y: 100, size: 12, font });
  }
  const ctx = doc.context;
  const js = ctx.obj({ S: 'JavaScript', JS: PDFString.of('app.alert(1)') });
  doc.catalog.set(PDFName.of('OpenAction'), ctx.register(js));
  doc.catalog.set(PDFName.of('Names'), ctx.obj({
    JavaScript: ctx.obj({ Names: [PDFString.of('x'), ctx.register(js)] }),
    EmbeddedFiles: ctx.obj({ Names: [] }),
  }));
  const link = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Link', Rect: [0, 0, 50, 50],
    A: ctx.obj({ S: 'URI', URI: PDFString.of('https://example.invalid/') }),
  }));
  doc.getPage(0).node.set(PDFName.of('Annots'), ctx.obj([link]));
  return doc.save({ useObjectStreams: false });
}

test('inspector rejects the active-content PDF', async () => {
  const bytes = await activePdf();
  assert.throws(() => inspectPdf(bytes), error => error.code === 'PDF_ACTIVE_CONTENT');
});

test('sanitizer rebuilds it clean: inspector accepts, text unchanged, no actions or links remain', async () => {
  const original = await activePdf();
  const clean = Buffer.from(await sanitizePdf(original));
  const result = inspectPdf(clean);
  assert.equal(result.pageCount, 2);
  const text = await extractPdfPageTexts(clean);
  assert.equal(text.status, 'established');
  assert.deepEqual(text.pages.map(page => page.text.trim()), ['Synthetic policy page one', 'Synthetic policy page two']);
  const raw = clean.toString('latin1');
  for (const marker of ['JavaScript', 'JS', 'OpenAction', 'URI', 'Annots', 'Names', 'EmbeddedFiles', 'AcroForm', 'Link']) {
    assert.equal(new RegExp(`/${marker}(?![A-Za-z])`).test(raw), false, `${marker} survived`);
  }
});

test('sanitizer rejects non-PDF bytes instead of passing them through', async () => {
  await assert.rejects(() => sanitizePdf(Buffer.from('not a pdf at all')));
});
