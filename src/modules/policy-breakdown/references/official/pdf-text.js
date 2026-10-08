// Text-layer extraction for official, born-digital PDFs (policy wordings published by insurers).
// No OCR: if a page has no text layer it comes back empty and the caller decides. Never used for uploads.
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const PDF_TEXT_EXTRACTOR_VERSION = 'pdfjs-text-layer-v1';
const MAX_PAGES = 300;
const MAX_PAGE_CHARACTERS = 40_000;

/** Returns [{ pageNumber, text }] from the PDF text layer, one line per text run that ends a line. */
export async function extractPdfTextPages(bytes, { maxPages = MAX_PAGES } = {}) {
  const data = bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(Buffer.from(bytes));
  const task = getDocument({ data, isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const document = await task.promise;
  try {
    if (document.numPages > maxPages) throw Object.assign(new Error(`PDF has ${document.numPages} pages; the limit is ${maxPages}.`), { code: 'OFFICIAL_PDF_TOO_MANY_PAGES' });
    const pages = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (typeof item.str !== 'string') continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      text = text.split('\n').map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, MAX_PAGE_CHARACTERS);
      pages.push({ pageNumber, text });
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
  }
}
