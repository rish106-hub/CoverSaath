// Curated-source test helpers: real (synthetic) PDFs whose text the extractor derives, and the extractor run in-process.
// The in-process extractor is the same code the sandboxed child runs; it skips only the child process, to keep tests fast.
// One test (curated-source-integrity CLI journey) exercises the default sandboxed extractor end to end.
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PDF_TEXT_EXTRACTOR_VERSION, extractPdfPageTexts } from '../../src/features/input/pdf-text-extraction.js';

export const inProcessPdfText = Object.freeze({ version: PDF_TEXT_EXTRACTOR_VERSION, extract: bytes => extractPdfPageTexts(bytes) });

const FIXED = new Date('2026-01-01T00:00:00.000Z');

/** A deterministic PDF drawing each page's lines (split on newlines). `title` changes the bytes, not the text. */
export async function sourcePdf(pageTexts, { title = 'SYNTHETIC TEST DATA' } = {}) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.setTitle(title); pdf.setProducer('coversaath-tests'); pdf.setCreator('coversaath-tests');
  pdf.setCreationDate(FIXED); pdf.setModificationDate(FIXED);
  for (const text of pageTexts) {
    const page = pdf.addPage([595, 842]);
    text.split('\n').forEach((line, i) => page.drawText(line, { x: 40, y: 800 - i * 16, size: 10, font }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}

/** A PDF with pages but no text at all (image-only stand-in): its text cannot be established. */
export async function textlessPdf(pages = 2) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pages; i += 1) pdf.addPage([595, 842]);
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
