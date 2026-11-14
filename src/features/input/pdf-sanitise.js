import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

// Rebuilds an untrusted PDF without active content (ADR 0035). Runs only inside the permission-restricted child
// (pdf-sanitise-child.mjs). The output is a fresh document whose pages are copied from the source, so nothing
// that is not reachable from a page survives: no catalog actions, name trees, form tree or orphaned objects.
// Throws Error with `.code` PDF_PASSWORD_REQUIRED or PDF_STRUCTURE_INVALID; the caller re-inspects the output.
// Outlines, document metadata and named destinations are not carried over.

const name = value => PDFName.of(value);
const DROP_ANNOTATION_SUBTYPES = new Set(['FileAttachment', 'Sound', 'Movie', 'Screen', 'RichMedia', '3D']);
const STRIP_ANNOTATION_KEYS = ['A', 'AA', 'Dest'];

const sanitiseError = (code, message) => Object.assign(new Error(message), { code });

function describeSource(doc) {
  const removed = new Set();
  const catalog = doc.catalog;
  if (catalog.has(name('OpenAction'))) removed.add('open_action');
  if (catalog.has(name('AA'))) removed.add('document_actions');
  if (catalog.has(name('Perms'))) removed.add('permissions');
  if (catalog.has(name('AcroForm'))) removed.add('acroform');
  if (catalog.lookupMaybe(name('AcroForm'), PDFDict)?.has(name('XFA'))) removed.add('xfa');
  const names = catalog.lookupMaybe(name('Names'), PDFDict);
  if (names?.has(name('JavaScript'))) removed.add('javascript');
  if (names?.has(name('EmbeddedFiles')) || catalog.has(name('AF'))) removed.add('embedded_files');
  return removed;
}

function cleanPage(page, removed) {
  const node = page.node;
  for (const [key, label] of [['AA', 'page_actions'], ['AF', 'embedded_files'], ['Metadata', null], ['PieceInfo', null]]) {
    if (node.has(name(key))) { node.delete(name(key)); if (label) removed.add(label); }
  }
  const annots = node.Annots();
  if (!annots) return;
  const kept = [];
  for (let i = 0; i < annots.size(); i += 1) {
    const annotation = annots.lookupMaybe(i, PDFDict);
    if (!annotation) { removed.add('annotations_dropped'); continue; }
    const subtype = annotation.lookupMaybe(name('Subtype'), PDFName)?.decodeText();
    if (DROP_ANNOTATION_SUBTYPES.has(subtype)) { removed.add('annotations_dropped'); continue; }
    for (const key of STRIP_ANNOTATION_KEYS) {
      if (annotation.has(name(key))) { annotation.delete(name(key)); removed.add('annotation_actions'); }
    }
    kept.push(annots.get(i));
  }
  if (kept.length === 0) node.delete(name('Annots'));
  else node.set(name('Annots'), page.doc.context.obj(kept));
}

/** @returns {Promise<{ bytes: Uint8Array, removed: string[] }>} */
export async function sanitisePdf(bytes) {
  let source;
  try {
    source = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false, throwOnInvalidObject: true });
  } catch (error) {
    if (/encrypt/i.test(String(error?.message))) throw sanitiseError('PDF_PASSWORD_REQUIRED', 'The PDF is password protected.');
    throw sanitiseError('PDF_STRUCTURE_INVALID', 'The PDF could not be read.');
  }
  try {
    const removed = describeSource(source);
    const output = await PDFDocument.create({ updateMetadata: false });
    const pages = await output.copyPages(source, source.getPageIndices());
    for (const page of pages) {
      cleanPage(page, removed);
      output.addPage(page);
    }
    return { bytes: await output.save({ useObjectStreams: false }), removed: [...removed].sort() };
  } catch {
    throw sanitiseError('PDF_STRUCTURE_INVALID', 'The PDF could not be rebuilt.');
  }
}
