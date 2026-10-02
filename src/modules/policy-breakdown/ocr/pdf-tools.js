import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib';

export const STRUCTURAL_CHECK_VERSION = 'structural-pdf-check-v1';
export const MAX_POLICY_PAGES = 500;

// Names that let a PDF execute code, launch programs or carry hidden files.
const ACTIVE_CONTENT_NAMES = Object.freeze(['JavaScript', 'JS', 'Launch', 'EmbeddedFile', 'EmbeddedFiles', 'RichMedia', 'XFA', 'SubmitForm', 'ImportData', 'GoToE']);

export class PdfToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PdfToolError';
    this.code = code;
  }
}

async function loadPdf(bytes) {
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
    document.getPageCount(); // pdf-lib defers page-tree parsing; force it so broken files fail here.
    return document;
  } catch (error) {
    if (/encrypt/i.test(error?.message ?? '')) throw new PdfToolError('PDF_ENCRYPTED', 'The PDF is encrypted or password-protected. Upload an unprotected copy.');
    throw new PdfToolError('PDF_UNREADABLE', 'The PDF could not be parsed.');
  }
}

/**
 * Deterministic structural check. It is NOT antivirus: it rejects PDFs that declare active content.
 * Returns { status: 'clean' | 'blocked', reference, findings }.
 */
export async function structuralPdfCheck(bytes) {
  const document = await loadPdf(bytes);
  const pageCount = document.getPageCount();
  if (pageCount < 1) throw new PdfToolError('PDF_EMPTY', 'The PDF has no pages.');
  if (pageCount > MAX_POLICY_PAGES) throw new PdfToolError('PDF_TOO_MANY_PAGES', `The PDF exceeds ${MAX_POLICY_PAGES} pages.`);
  const findings = new Set();
  // Walk every dictionary, including dictionaries nested inline inside other objects and arrays.
  const visit = (object, depth) => {
    if (!object || depth > 32) return;
    if (object instanceof PDFArray) { for (let index = 0; index < object.size(); index += 1) visit(object.get(index), depth + 1); return; }
    const dict = object instanceof PDFDict ? object : (object instanceof PDFRawStream || object instanceof PDFStream) ? object.dict : null;
    if (!dict) return;
    for (const [key, value] of dict.entries()) {
      const keyName = key.asString().slice(1);
      if (ACTIVE_CONTENT_NAMES.includes(keyName)) findings.add(keyName);
      if (keyName === 'S' && value instanceof PDFName) {
        const action = value.asString().slice(1);
        if (ACTIVE_CONTENT_NAMES.includes(action)) findings.add(action);
      }
      if (value instanceof PDFDict || value instanceof PDFArray) visit(value, depth + 1);
    }
  };
  for (const [, object] of document.context.enumerateIndirectObjects()) visit(object, 0);
  visit(document.catalog, 0);
  return Object.freeze({
    status: findings.size ? 'blocked' : 'clean',
    reference: STRUCTURAL_CHECK_VERSION,
    pageCount,
    findings: Object.freeze([...findings].sort()),
  });
}

export async function pdfPageCount(bytes) {
  return (await loadPdf(bytes)).getPageCount();
}

/**
 * Splits a PDF into chunks of at most `maxPages` pages, preserving order.
 * Returns [{ index, firstPage, lastPage, bytes }] with 1-based page numbers of the original.
 */
export async function chunkPdf(bytes, { maxPages = 10 } = {}) {
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new TypeError('maxPages must be a positive integer.');
  const source = await loadPdf(bytes);
  const total = source.getPageCount();
  if (total > MAX_POLICY_PAGES) throw new PdfToolError('PDF_TOO_MANY_PAGES', `The PDF exceeds ${MAX_POLICY_PAGES} pages.`);
  const chunks = [];
  for (let start = 0; start < total; start += maxPages) {
    const end = Math.min(start + maxPages, total);
    const target = await PDFDocument.create();
    const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
    const pages = await target.copyPages(source, indices);
    for (const page of pages) target.addPage(page);
    chunks.push(Object.freeze({
      index: chunks.length,
      firstPage: start + 1,
      lastPage: end,
      bytes: Buffer.from(await target.save({ useObjectStreams: false })),
    }));
  }
  return Object.freeze(chunks);
}
