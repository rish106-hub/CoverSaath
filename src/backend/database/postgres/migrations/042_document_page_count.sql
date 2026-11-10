-- Policy facts slice 1 (ADR 0024). Expand-only and safe to run more than once: two nullable columns on document_uploads.
-- page_count is the number of pages of the stored file, set at most to a better source than before:
--   source_pages  count of stored OCR page rows (lowest trust)
--   ocr           page count the OCR provider reported when its job completed
--   image_single  an uploaded image is one page by definition (highest trust)
-- NULL means unknown. A page count is a number, not personal data, and is not part of any erasure. The metadata-only ADD COLUMN
-- keeps the table readable; no backfill (a document gets its count at its next scan or OCR completion).
-- Rollback: old code ignores the columns; revert the code and keep or drop the columns.
ALTER TABLE public.document_uploads
  ADD COLUMN IF NOT EXISTS page_count integer CHECK (page_count IS NULL OR page_count BETWEEN 1 AND 5000);
ALTER TABLE public.document_uploads
  ADD COLUMN IF NOT EXISTS page_count_source text CHECK (page_count_source IS NULL OR page_count_source IN ('image_single', 'ocr', 'source_pages'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.document_uploads'::regclass AND conname = 'document_uploads_page_count_pair_check'
  ) THEN
    ALTER TABLE public.document_uploads
      ADD CONSTRAINT document_uploads_page_count_pair_check
      CHECK ((page_count IS NULL) = (page_count_source IS NULL));
  END IF;
END
$$;
