import { DocumentIntakeError } from './contracts.js';

// Upload-time PDF pipeline (ADR 0035), used as the intake `inspectFile` hook:
//   1. inspect; active content is sanitised (never rejected) and the output must re-inspect clean
//   2. insurance gate on the bytes that will be stored; a text layer that is clearly not insurance is rejected
// Returns { pageCount, objectStreamCount, pdfVersion, bytes?, sanitised?, removed? }. `bytes` is set only when the
// stored bytes differ from the upload: the original of a sanitised file is never stored.
export function createPdfUploadChecks({ inspector, sanitiser, gate }) {
  for (const [dependency, method] of [[inspector, 'inspect'], [sanitiser, 'sanitise'], [gate, 'assess']]) {
    if (typeof dependency?.[method] !== 'function') throw new TypeError(`PDF upload checks need a ${method}() dependency.`);
  }
  return async function inspectPdfUpload(validated) {
    let bytes = validated.bytes;
    let inspection;
    let sanitised = null;
    try {
      inspection = await inspector.inspect(bytes);
    } catch (error) {
      if (error?.code !== 'PDF_ACTIVE_CONTENT') throw error;
      sanitised = await sanitiser.sanitise(bytes);
      bytes = sanitised.bytes;
      try {
        inspection = await inspector.inspect(bytes);
      } catch (reinspection) {
        // The rebuilt file must be clean; anything else is not accepted, and the original is not stored.
        if (reinspection?.code === 'PDF_ACTIVE_CONTENT') throw new DocumentIntakeError('PDF_ACTIVE_CONTENT', 'The PDF contains active or embedded content that could not be removed.');
        throw reinspection;
      }
    }
    if (await gate.assess(bytes) === 'not_insurance') {
      throw new DocumentIntakeError('NOT_INSURANCE_DOCUMENT', 'This PDF does not look like an insurance policy document.');
    }
    return sanitised ? { ...inspection, bytes, sanitised: true, removed: sanitised.removed } : inspection;
  };
}
