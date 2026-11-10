// Page count of a stored document (migration 042). One conditional UPDATE: a count is written when none exists or when it
// comes from a more trusted source, never the other way, so two writers (scan, OCR completion) cannot race to a worse value.
// Trust order, lowest first: source_pages (count of stored OCR page rows), ocr (count the OCR job reported), image_single
// (an uploaded image is one page). Joins the caller's transaction when there is one.

export const PAGE_COUNT_SOURCES = Object.freeze(['source_pages', 'ocr', 'image_single']);
export const MAX_PAGE_COUNT = 5000;

const RANK_SQL = column => `CASE ${column} WHEN 'image_single' THEN 3 WHEN 'ocr' THEN 2 WHEN 'source_pages' THEN 1 ELSE 0 END`;

/** Resolves true when the row changed, false when a count of equal or better trust already exists (or no such document). */
export async function setPageCountOnce(database, documentId, pageCount, source) {
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
    throw Object.assign(new Error('pageCount is invalid.'), { code: 'PAGE_COUNT_INVALID', statusCode: 400 });
  }
  if (!PAGE_COUNT_SOURCES.includes(source)) {
    throw Object.assign(new Error('page count source is invalid.'), { code: 'PAGE_COUNT_INVALID', statusCode: 400 });
  }
  const { changes } = await database.run(`UPDATE document_uploads SET page_count = ?, page_count_source = ?
    WHERE id = ? AND (page_count IS NULL OR ${RANK_SQL('CAST(? AS text)')} > ${RANK_SQL('page_count_source')})`,
  [pageCount, source, documentId, source]);
  return changes === 1;
}
