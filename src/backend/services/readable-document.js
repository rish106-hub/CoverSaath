// The stored OCR pages of a document, only while every succeeded OCR job that holds its pages still has a current exact reading
// grant (the same gate as the read-back routes). Null when the text may not be read now. Shared by the policy profile (ADR 0024)
// and the policy facts (ADR 0025) services so both apply the identical gate. No model and no provider call.
export function createStoredPagesReader({ ocr, clock = () => new Date() }) {
  return async function readStoredPages(document) {
    const latest = await ocr.getLatestJobForDocument(document.id);
    if (latest?.status !== 'succeeded') return null;
    const holders = await ocr.getJobsHoldingPages(document.id);
    if (!holders.length || holders.some(job => job.provider !== 'sarvam')) return null;
    const at = clock().toISOString();
    for (const job of holders) {
      const authorization = job.authorization;
      const ready = authorization?.consentGrantId && authorization.requestedByAdultId
        ? await ocr.getReadyDocument(document.id, at, { consentGrantId: authorization.consentGrantId, requestedByAdultId: authorization.requestedByAdultId, recipient: 'sarvam' })
        : null;
      if (!ready) return null;
    }
    try {
      return await ocr.getDocumentBlockPages({ documentId: document.id, householdId: document.householdId });
    } catch (error) {
      if (['OCR_PAGES_UNAVAILABLE', 'OCR_PAGES_INCOMPLETE', 'DOCUMENT_NOT_FOUND'].includes(String(error?.code))) return null;
      throw error;
    }
  };
}
