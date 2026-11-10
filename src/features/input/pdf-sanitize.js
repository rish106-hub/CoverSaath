import { PDFDocument, PDFName } from 'pdf-lib';

// Content disarm and reconstruction (CDR) for PDFs that carry active content (JavaScript, embedded files,
// AcroForm actions, OpenAction). Nothing here runs JavaScript or renders a page: it copies page content
// (text, fonts, images) into a fresh document, so the catalog, name trees, form fields, document-level actions,
// page actions and annotations (links, widgets, signatures) of the original are never carried over.
// The caller must re-inspect the result and must never fall back to the original bytes.

const DROP_PAGE_KEYS = ['Annots', 'AA', 'Actions'];

export async function sanitizePdf(bytes, { maxPages = 500 } = {}) {
  const source = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: false });
  const count = source.getPageCount();
  if (count < 1 || count > maxPages) throw new RangeError('PDF page count is out of range.');
  // Drop annotations and page actions from the source pages first: copying follows references, and an annotation points
  // back at its page, so deleting after the copy would leave the original pages and their actions as orphan objects.
  for (const page of source.getPages()) {
    for (const key of DROP_PAGE_KEYS) page.node.delete(PDFName.of(key));
  }
  const clean = await PDFDocument.create();
  const pages = await clean.copyPages(source, source.getPageIndices());
  for (const page of pages) clean.addPage(page);
  // Fixed metadata: titles, authors and producer strings of the original are not carried over.
  clean.setTitle('');
  clean.setAuthor('');
  clean.setSubject('');
  clean.setKeywords([]);
  clean.setProducer('CoverSaath sanitizer');
  clean.setCreator('CoverSaath sanitizer');
  // Object streams are off so the output is a plain structure the inspector can walk fully.
  return clean.save({ useObjectStreams: false });
}
